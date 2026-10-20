import { describe, it, expect, vi } from 'vitest';
import { ProjectRuntime } from '../project-runtime';
function fixture() {
	const rows = new Map<string, unknown>();
	const records = {
		read: async <T>(id: string) => structuredClone(rows.get(id) ?? null) as T | null,
		write: async (id: string, value: unknown) => {
			rows.set(id, structuredClone(value));
		},
		claim: async (id: string, value: unknown) => {
			if (rows.has(id)) return false;
			rows.set(id, structuredClone(value));
			return true;
		},
	};
	const launch = vi.fn(async (input: { childId: string }) => ({ executionId: input.childId })),
		wake = vi.fn(async () => {}),
		cancel = vi.fn(async () => {});
	const runtime = new ProjectRuntime(records, async () => {}, wake, 'http://127.0.0.1:5679', {
		launch,
		cancel,
	});
	const child = {
		id: 'prepare',
		nodes: [
			{ id: 's', name: 'Start', type: 'start', parameters: {} },
			{ id: 'f', name: 'Finish', type: 'finish', parameters: {} },
		],
		connections: { Start: { main: [[{ node: 'Finish' }]] } },
	};
	const snapshot = {
		projectId: 'p',
		flowId: 'scan',
		contentHash: 'hash',
		config: { repo: '/tmp/repo', baseRef: 'main', roles: { owner: ['human'] } },
		params: { target: 'settings' },
		flows: { prepare: child },
		flow: {
			id: 'scan',
			nodes: [
				{ id: 's', name: 'Start', type: 'start', parameters: {} },
				{
					id: 'p',
					name: 'Prepare',
					type: 'subflow',
					parameters: { flowRef: 'prepare', concurrency: 1 },
				},
				{ id: 'n', name: 'Next', type: 'command', parameters: { commandRef: 'check' } },
			],
			connections: {
				Start: { main: [[{ node: 'Prepare' }]] },
				Prepare: { main: [[{ node: 'Next' }]] },
			},
		},
	};
	return {
		runtime,
		records,
		rows,
		launch,
		wake,
		cancel,
		snapshot,
		node: () =>
			runtime.executeNode({ executionId: 'root', nodeId: 'p', projectId: 'p', flowId: 'scan' }),
	};
}
describe('durable child flow joins', () => {
	it('waits for the exact declared child and transfers prepared resources only after success', async () => {
		const s = fixture();
		await s.runtime.start('root', s.snapshot as never);
		expect((await s.node()).status).toBe('running');
		const child = s.launch.mock.calls[0]![0];
		await s.node();
		expect(s.launch).toHaveBeenCalledTimes(1);
		await expect(
			s.runtime.childCompleted('root', 'p', 'unknown', { status: 'passed', context: {} }),
		).rejects.toThrow();
		await s.runtime.childCompleted('root', 'p', child.childId, {
			status: 'passed',
			context: {
				workspace: '/tmp/owned',
				workspaceOwnerRunId: child.childId,
				serviceUrl: 'http://127.0.0.1:3000',
			},
		});
		expect((await s.node()).status).toBe('passed');
		expect((await s.node()).context).toMatchObject({
			workspace: '/tmp/owned',
			serviceUrl: 'http://127.0.0.1:3000',
		});
	});
	it('does not treat a failed child or an empty required list as success', async () => {
		const s = fixture();
		await s.runtime.start('root', s.snapshot as never);
		await s.node();
		const child = s.launch.mock.calls[0]![0];
		await s.runtime.childCompleted('root', 'p', child.childId, {
			status: 'failed',
			context: {},
			error: 'service not ready',
		});
		expect((await s.node()).status).toBe('failed');
		const t = fixture();
		t.snapshot.flow.nodes[1]!.parameters = {
			flowRef: 'prepare',
			itemsRef: 'missing',
			concurrency: 1,
		} as never;
		await t.runtime.start('root', t.snapshot as never);
		await expect(t.node()).rejects.toThrow(/items|list/i);
	});
	it('propagates cancellation to registered children and does not wake a canceled parent', async () => {
		const s = fixture();
		await s.runtime.start('root', s.snapshot as never);
		await s.node();
		const child = s.launch.mock.calls[0]![0];
		await s.runtime.cancel('root');
		expect(s.cancel).toHaveBeenCalledWith(child.childId);
		await s.runtime.childCompleted('root', 'p', child.childId, { status: 'passed', context: {} });
		expect((await s.node()).status).toBe('canceled');
		expect(s.wake).not.toHaveBeenCalled();
	});
});
it('joins any only after a child passes, tolerating a different child failure', async () => {
	const s = fixture();
	s.snapshot.flow.nodes[1]!.parameters = {
		flowRef: 'prepare',
		itemsRef: 'items',
		join: 'any',
		concurrency: 2,
	} as never;
	await s.runtime.start('root', s.snapshot as never, { context: { items: [{}, {}] } });
	await s.node();
	const [first, second] = s.launch.mock.calls.map((call) => call[0]);
	await s.runtime.childCompleted('root', 'p', first!.childId, {
		status: 'failed',
		context: {},
		error: 'first failed',
	});
	expect((await s.node()).status).toBe('running');
	await s.runtime.childCompleted('root', 'p', second!.childId, { status: 'passed', context: {} });
	expect((await s.node()).status).toBe('passed');
});
it('refuses an integration target until an isolated integration branch exists', async () => {
	const s = fixture();
	s.snapshot.flow.nodes[1]!.parameters = { flowRef: 'prepare', target: 'integration' } as never;
	await s.runtime.start('root', s.snapshot as never);
	await expect(s.node()).rejects.toThrow(/integration/i);
	expect(s.launch).not.toHaveBeenCalled();
});
it('binds each parallel integration child to an owned staging branch and never main', async () => {
	const s = fixture();
	s.snapshot.flow.nodes[1]!.parameters = {
		flowRef: 'prepare',
		itemsRef: 'items',
		target: 'integration',
		concurrency: 2,
		join: 'all',
	} as never;
	const integration = {
		branch: 'codex/p-integration-root',
		ownerRunId: 'root-integration',
		baseSha: 'a'.repeat(40),
		workspace: '/owned',
		projectId: 'p',
	};
	await s.runtime.start('root', s.snapshot as never, { context: { integration, items: [{}, {}] } });
	await s.node();
	expect(s.launch).toHaveBeenCalledTimes(2);
	for (const call of s.launch.mock.calls)
		expect(call[0]).toMatchObject({
			context: {
				integrationTarget: integration,
				targetRef: expect.stringMatching(/^codex\/p-integration-root-child-/),
			},
		});
	expect((await s.runtime.inspect('root')).context.targetRef).toBeUndefined();
});

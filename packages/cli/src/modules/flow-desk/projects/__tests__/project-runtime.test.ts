import { describe, it, expect, vi } from 'vitest';
import { ProjectRuntime } from '../project-runtime';
function setup() {
	const rows = new Map<string, unknown>();
	const records = {
		read: async <T>(key: string) => structuredClone(rows.get(key) ?? null) as T | null,
		write: async (key: string, value: unknown) => {
			rows.set(key, structuredClone(value));
		},
		claim: async (key: string, value: unknown) => {
			if (rows.has(key)) return false;
			rows.set(key, structuredClone(value));
			return true;
		},
	};
	const snapshot = {
		projectId: 'p',
		flowId: 'scan',
		contentHash: 'hash',
		config: {
			repo: '/tmp/repo',
			baseRef: 'main',
			roles: { owner: ['human'] },
			commands: { test: { command: 'true' } },
		},
		params: { target: 'module' },
		prompts: {},
		schemas: {},
		skills: {},
		flow: {
			id: 'scan',
			nodes: [
				{ id: 's', name: 'Start', type: 'start', parameters: {} },
				{ id: 'w', name: 'Workspace', type: 'workspace', parameters: {} },
				{ id: 'c', name: 'Command', type: 'command', parameters: { commandRef: 'test' } },
				{ id: 'a', name: 'Approval', type: 'approval', parameters: { role: 'owner' } },
			],
			connections: {
				Start: { main: [[{ node: 'Workspace' }]] },
				Workspace: { main: [[{ node: 'Command' }]] },
				Command: { main: [[{ node: 'Approval' }]] },
			},
		},
	};
	const dispatch = vi.fn(async (_task: Record<string, unknown>) => {}),
		wake = vi.fn(async (_executionId: string) => {});
	const runtime = new ProjectRuntime(records, dispatch, wake, 'http://127.0.0.1:5679');
	const start = () => runtime.start('e', snapshot as never);
	const node = (nodeId: string) =>
		runtime.executeNode({ executionId: 'e', nodeId, projectId: 'p', flowId: 'scan' });
	return { rows, runtime, records, dispatch, wake, start, node, snapshot };
}
describe('persisted project execution', () => {
	it('does not let an unrelated passing check clear an earlier verification failure', async () => {
		const s = setup();
		Object.assign(s.snapshot.config, {
			verification: {
				first: { commandRef: 'test', report: { format: 'exit-code' } },
				second: { commandRef: 'test', report: { format: 'exit-code' } },
			},
		});
		s.snapshot.flow.nodes[1] = {
			id: 'w',
			name: 'Workspace',
			type: 'verify',
			parameters: { suites: ['first'] },
		} as never;
		s.snapshot.flow.nodes[2] = {
			id: 'c',
			name: 'Command',
			type: 'verify',
			parameters: { suites: ['second'] },
		} as never;
		s.snapshot.flow.nodes[3] = {
			id: 'a',
			name: 'Approval',
			type: 'finish',
			parameters: { outcome: 'completed' },
		} as never;
		s.snapshot.flow.connections.Workspace.main = [[], [{ node: 'Command' }]];
		await s.start();
		const run = await s.runtime.inspect('e');
		run.context.candidateSha = 'sha';
		await s.records.write('run:e', run);
		await s.node('w');
		let task = s.dispatch.mock.calls.at(-1)![0];
		await s.runtime.complete(String(task.taskId), { ...task, status: 'failed', result: {} });
		await s.node('c');
		task = s.dispatch.mock.calls.at(-1)![0];
		await s.runtime.complete(String(task.taskId), {
			...task,
			status: 'passed',
			result: {
				evidence: [
					{
						name: 'second',
						round: 0,
						status: 'passed',
						candidateSha: 'sha',
						configHash: 'hash',
						artifactHash: 'report',
					},
				],
			},
		});
		expect((await s.runtime.inspect('e')).failures).toMatchObject({ w: 'verify' });
		await expect(s.node('a')).rejects.toThrow(/Unresolved/);
	});
	it('persists the configuration repository scope for subsequent nodes', async () => {
		const s = setup();
		s.snapshot.flow.nodes[1]!.parameters = { repoRef: 'project-config' } as never;
		await s.start();
		await s.node('w');
		const task = s.dispatch.mock.calls[0]![0];
		expect(task.repoRef).toBe('project-config');
		await s.runtime.complete(String(task.taskId), {
			...task,
			status: 'passed',
			result: {
				workspace: '/config-worktree',
				workspaceOwnerRunId: 'owner-config',
				repoRef: 'project-config',
				targetRef: 'config-main',
				candidateSha: 'sha',
			},
		});
		await s.node('c');
		expect(s.dispatch.mock.calls.at(-1)![0]).toMatchObject({
			repoRef: 'project-config',
			workspace: '/config-worktree',
			baseRef: 'config-main',
		});
	});
	it('preserves validation failure and acknowledges an identical runner callback without repeating side effects', async () => {
		const s = setup();
		Object.assign(s.snapshot.config, {
			verification: { test: { commandRef: 'test', report: { format: 'exit-code' } } },
		});
		s.snapshot.flow.nodes[1] = {
			id: 'w',
			name: 'Workspace',
			type: 'verify',
			parameters: { suites: ['test'] },
		} as never;
		await s.start();
		const run = await s.runtime.inspect('e');
		run.context.repoRef = 'project-config';
		run.context.candidateSha = 'sha';
		await s.records.write('run:e', run);
		const validator = vi.fn(async () => {
			throw new Error('Invalid candidate');
		});
		(
			s.runtime as unknown as { ports: { configurationCandidate: typeof validator } }
		).ports.configurationCandidate = validator;
		await s.node('w');
		const task = s.dispatch.mock.calls[0]![0];
		const event = {
			...task,
			status: 'passed',
			result: {
				candidateSha: 'sha',
				evidence: [
					{
						name: 'test',
						round: 0,
						status: 'passed',
						candidateSha: 'sha',
						configHash: 'hash',
						artifactHash: 'report',
					},
				],
			},
		};
		expect((await s.runtime.complete(String(task.taskId), event)).status).toBe('failed');
		expect((await s.runtime.complete(String(task.taskId), event)).status).toBe('failed');
		expect(validator).toHaveBeenCalledTimes(1);
	});
	it('dispatches only a declared successor and rejects a forged context', async () => {
		const s = setup();
		await s.start();
		await expect(s.node('c')).rejects.toThrow(/predecessor/i);
		const first = await s.node('w');
		expect(first.status).toBe('running');
		expect(s.dispatch).toHaveBeenCalledTimes(1);
		await s.node('w');
		expect(s.dispatch).toHaveBeenCalledTimes(1);
		const task = s.dispatch.mock.calls[0]![0];
		await expect(
			s.runtime.complete(String(task.taskId), {
				...task,
				configHash: 'wrong',
				status: 'passed',
				result: {},
			}),
		).rejects.toThrow(/identity/i);
		await s.runtime.complete(String(task.taskId), {
			...task,
			status: 'failed',
			result: {},
			error: 'not ready',
		});
		await expect(s.node('c')).rejects.toThrow(/predecessor/i);
		expect((await s.node('w')).status).toBe('failed');
	});
	it('persists callback before waking and safely retries a failed wake', async () => {
		const s = setup();
		await s.start();
		await s.node('w');
		const task = s.dispatch.mock.calls[0]![0];
		s.wake.mockRejectedValueOnce(new Error('not parked'));
		const callback = {
			...task,
			status: 'passed',
			result: { workspace: '/tmp/work', candidateSha: 'sha' },
		};
		await expect(s.runtime.complete(String(task.taskId), callback)).rejects.toThrow('not parked');
		const restarted = new ProjectRuntime(s.records, s.dispatch, s.wake, 'http://127.0.0.1:5679');
		await restarted.complete(String(task.taskId), callback);
		expect(
			(
				await restarted.executeNode({
					executionId: 'e',
					nodeId: 'w',
					projectId: 'p',
					flowId: 'scan',
				})
			).status,
		).toBe('passed');
		await restarted.executeNode({ executionId: 'e', nodeId: 'c', projectId: 'p', flowId: 'scan' });
		expect(s.dispatch.mock.calls[1]![0]).toMatchObject({
			workspace: '/tmp/work',
			candidateSha: 'sha',
			command: 'true',
			callbackBase: 'http://127.0.0.1:5679',
		});
		await expect(
			restarted.complete(String(task.taskId), { ...callback, status: 'failed' }),
		).rejects.toThrow(/terminal|conflict/i);
	});
	it('requires human approval of the exact immutable subject', async () => {
		const s = setup();
		await s.start();
		await s.node('w');
		let task = s.dispatch.mock.calls[0]![0];
		await s.runtime.complete(String(task.taskId), {
			...task,
			status: 'passed',
			result: { workspace: '/tmp/w', candidateSha: 'sha' },
		});
		await s.node('c');
		task = s.dispatch.mock.calls[1]![0];
		await s.runtime.complete(String(task.taskId), { ...task, status: 'passed', result: {} });
		const waiting = await s.node('a');
		expect(waiting.status).toBe('waiting-approval');
		const digest = String(waiting.result?.digest);
		await expect(
			s.runtime.decide('e', 'a', { actor: 'agent-bot', digest, decision: 'approve' }),
		).rejects.toThrow();
		await expect(
			s.runtime.decide('e', 'a', { actor: 'human', digest: 'stale', decision: 'approve' }),
		).rejects.toThrow();
		await s.runtime.decide('e', 'a', { actor: 'human', digest, decision: 'approve' });
		expect((await s.node('a')).status).toBe('passed');
	});
});

it('does not let a repeated old callback roll back the current candidate', async () => {
	const s = setup();
	await s.start();
	await s.node('w');
	const task = s.dispatch.mock.calls[0]![0];
	const callback = {
		...task,
		status: 'passed',
		result: { workspace: '/tmp/work', candidateSha: 'old' },
	};
	await s.runtime.complete(String(task.taskId), callback);
	const run = await s.records.read<Record<string, unknown>>('run:e');
	(run!.context as Record<string, unknown>).candidateSha = 'new';
	await s.records.write('run:e', run);
	await s.runtime.complete(String(task.taskId), callback);
	expect((await s.node('w')).context?.candidateSha).toBe('new');
});
it('retries approval wake without discarding a recorded human decision', async () => {
	const s = setup();
	await s.start();
	await s.node('w');
	let task = s.dispatch.mock.calls[0]![0];
	await s.runtime.complete(String(task.taskId), {
		...task,
		status: 'passed',
		result: { workspace: '/tmp/w', candidateSha: 'sha' },
	});
	await s.node('c');
	task = s.dispatch.mock.calls[1]![0];
	await s.runtime.complete(String(task.taskId), { ...task, status: 'passed', result: {} });
	const waiting = await s.node('a'),
		input = { actor: 'human', digest: String(waiting.result.digest), decision: 'approve' as const };
	s.wake.mockRejectedValueOnce(new Error('not parked'));
	await expect(s.runtime.decide('e', 'a', input)).rejects.toThrow();
	await expect(s.runtime.decide('e', 'a', input)).resolves.toMatchObject({ status: 'passed' });
});

it('recovers initialization if the process stopped between the run record and start node', async () => {
	const s = setup();
	await s.start();
	s.rows.delete('node:e:s');
	await s.start();
	expect((await s.node('s')).status).toBe('passed');
});

it('never routes a failed verification through a normal edge even when client input claims success', async () => {
	const s = setup();
	await s.start();
	await s.node('w');
	const task = s.dispatch.mock.calls[0]![0];
	await s.runtime.complete(String(task.taskId), {
		...task,
		status: 'failed',
		result: {},
		error: 'actual failure',
	});
	await expect(
		s.runtime.executeNode({
			executionId: 'e',
			nodeId: 'c',
			projectId: 'p',
			flowId: 'scan',
			input: { results: { w: { status: 'passed' } } },
		} as never),
	).rejects.toThrow(/predecessor/);
});

it('does not promote reserved execution fields from an Agent result', async () => {
	const s = setup();
	const node = s.snapshot.flow.nodes[2]!;
	node.type = 'agent';
	node.parameters = { promptRef: 'p', schemaRef: 's' } as never;
	Object.assign(s.snapshot.prompts, { p: 'Read the project' });
	Object.assign(s.snapshot.schemas, { s: { type: 'object' } });
	await s.start();
	await s.node('w');
	let task = s.dispatch.mock.calls[0]![0];
	await s.runtime.complete(String(task.taskId), {
		...task,
		status: 'passed',
		result: { workspace: '/owned', targetSha: 'base', candidateSha: 'base' },
	});
	await s.node('c');
	task = s.dispatch.mock.calls[1]![0];
	await s.runtime.complete(String(task.taskId), {
		...task,
		status: 'passed',
		result: {
			candidateSha: 'actual',
			diffHash: 'diff',
			workspace: '/forged',
			targetSha: 'forged',
			mergedSha: 'forged',
		},
	});
	const run = await s.runtime.inspect('e');
	expect(run.context.workspace).toBe('/owned');
	expect(run.context.targetSha).toBe('base');
	expect(run.context.mergedSha).toBeUndefined();
	expect(run.context.candidateSha).toBe('actual');
});

it('does not overwrite a terminal run when a late cancellation arrives', async () => {
	const s = setup();
	await s.start();
	const run = await s.runtime.inspect('e');
	run.status = 'passed';
	await s.records.write('run:e', run);
	await s.runtime.cancel('e');
	expect((await s.runtime.inspect('e')).status).toBe('passed');
});

it('dispatches a scan MCP and progressive skill context without injecting whole skill bodies', async () => {
	const s = setup();
	const config = s.snapshot.config as Record<string, unknown>;
	config.actionDriverMcp = {
		command: 'node',
		args: ['/mcp.js', '--mode', 'attach', '--data-root', '/data'],
	};
	s.snapshot.prompts = { scan: 'Scan current instance' } as never;
	s.snapshot.schemas = { scan: { type: 'object' } } as never;
	s.snapshot.skills = {
		'action-driver-mcp': { 'SKILL.md': 'SECRET_SKILL_BODY' },
		'flow-desk-mcp': { 'SKILL.md': 'FLOW_DESK_GUIDE_BODY' },
	} as never;
	s.snapshot.flow.nodes[2] = {
		id: 'c',
		name: 'Command',
		type: 'agent',
		parameters: { promptRef: 'scan', schemaRef: 'scan', writes: false },
	} as never;
	await s.start();
	await s.node('w');
	const workspace = s.dispatch.mock.calls[0]![0];
	await s.runtime.complete(String(workspace.taskId), {
		...workspace,
		status: 'passed',
		result: { workspace: '/tmp/w', candidateSha: 'sha' },
	});
	await s.node('c');
	const task = s.dispatch.mock.calls.at(-1)![0];
	expect(task.actionDriverMcp).toEqual(config.actionDriverMcp);
	expect(task.instructions).not.toContain('SECRET_SKILL_BODY');
	expect(task.instructions).not.toContain('FLOW_DESK_GUIDE_BODY');
	expect(task.taskContext).toMatchObject({
		skills: {
			'action-driver-mcp': { 'SKILL.md': 'SECRET_SKILL_BODY' },
			'flow-desk-mcp': { 'SKILL.md': 'FLOW_DESK_GUIDE_BODY' },
		},
	});
});
it('refreshes stale browser evidence before verifying a different candidate and gates it as required', async () => {
	const s = setup();
	(s.snapshot.config as any).verification = {
		test: { commandRef: 'test', report: { format: 'exit-code' } },
	};
	s.snapshot.flow.nodes[2] = {
		id: 'c',
		name: 'Command',
		type: 'verify',
		parameters: { suites: ['test'] },
	} as never;
	await s.runtime.start('e', s.snapshot as never, {
		context: {
			serviceUrl: 'http://127.0.0.1:3000',
			browserObservation: {
				spaceId: 16,
				pages: [{ path: '/', evidence: [{ candidateSha: 'old' }] }],
			},
		},
	});
	await s.node('w');
	const workspace = s.dispatch.mock.calls[0]![0];
	await s.runtime.complete(String(workspace.taskId), {
		...workspace,
		status: 'passed',
		result: { workspace: '/tmp/work', candidateSha: 'new' },
	});
	await s.node('c');
	const verify = s.dispatch.mock.calls[1]![0];
	expect(verify.browser).toEqual({ paths: ['/'], spaceId: 16 });
	await expect(
		s.runtime.complete(String(verify.taskId), {
			...verify,
			status: 'passed',
			result: {
				evidence: [
					{
						name: 'test',
						round: 0,
						status: 'passed',
						candidateSha: 'new',
						configHash: 'hash',
						artifactHash: 'report',
					},
				],
			},
		}),
	).rejects.toThrow(/browser/i);
});

describe('typed condition gates', () => {
	it.each([
		[[], 1],
		[[{ id: 'finding' }], 0],
	] as const)('routes the verified list to exactly one branch', async (items, outputIndex) => {
		const s = setup();
		s.snapshot.flow.nodes[1] = {
			id: 'w',
			name: 'Workspace',
			type: 'if',
			parameters: { valueRef: 'items', operator: 'not-empty' },
		} as never;
		s.snapshot.flow.connections.Workspace = {
			main: [[{ node: 'Command' }], [{ node: 'Approval' }]],
		} as never;
		await s.runtime.start('e', s.snapshot as never, { context: { items } });
		expect(await s.node('w')).toMatchObject({ status: 'passed', outputIndex });
		expect(s.dispatch).not.toHaveBeenCalled();
		const run = await s.runtime.inspect('e');
		expect(run.tokens.filter((t) => !t.consumed).map((t) => t.to)).toEqual([
			outputIndex === 0 ? 'c' : 'a',
		]);
	});
	it.each([undefined, {}, 'not a list'])(
		'rejects missing or wrongly typed list evidence',
		async (value) => {
			const s = setup();
			s.snapshot.flow.nodes[1] = {
				id: 'w',
				name: 'Workspace',
				type: 'if',
				parameters: { valueRef: 'items', operator: 'not-empty' },
			} as never;
			await s.runtime.start('e', s.snapshot as never, {
				context: value === undefined ? {} : { items: value },
			});
			await expect(s.node('w')).rejects.toThrow(/condition|list|reference/i);
			expect(
				(await s.runtime.inspect('e')).tokens.filter((t) => !t.consumed).map((t) => t.to),
			).toEqual(['w']);
		},
	);
});
it('uses the declared node repeat count for flaky verification instead of one execution', async () => {
	const s = setup();
	Object.assign(s.snapshot.config, {
		verification: {
			flaky: { commandRef: 'test', repeat: 2, report: { format: 'junit', path: 'report.xml' } },
		},
	});
	s.snapshot.flow.nodes[1] = {
		id: 'w',
		name: 'Workspace',
		type: 'verify',
		parameters: { suites: ['flaky'], repeat: 100 },
	} as never;
	await s.start();
	await s.node('w');
	expect(s.dispatch.mock.calls[0]?.[0].suites).toEqual([
		expect.objectContaining({ name: 'flaky', repeat: 100 }),
	]);
});
it('keeps flaky baseline measurements separate from delivery verification', async () => {
	const s = setup();
	Object.assign(s.snapshot.config, {
		verification: { flaky: { commandRef: 'test', report: { format: 'junit', path: 'junit.xml' } } },
	});
	s.snapshot.flow.nodes[1] = {
		id: 'w',
		name: 'Workspace',
		type: 'verify',
		parameters: { suites: ['flaky'], repeat: 20, mode: 'measure' },
	} as never;
	await s.start();
	await s.node('w');
	expect(s.dispatch.mock.calls[0]?.[0].suites).toEqual([
		expect.objectContaining({ mode: 'measure', repeat: 20 }),
	]);
});
it('dispatches inline commands with parameter references in argv rather than shell source', async () => {
	const s = setup();
	s.snapshot.params.target = 'users; $(exit 19)';
	s.snapshot.flow.nodes[1] = {
		id: 'w',
		name: 'Workspace',
		type: 'command',
		parameters: {
			command: 'printf "%s" "$1"',
			cwd: '.',
			argv: [{ ref: 'params.target' }],
			timeoutMs: 1000,
		},
	} as never;
	await s.start();
	await s.node('w');
	expect(s.dispatch.mock.calls[0]?.[0]).toMatchObject({
		command: 'printf "%s" "$1"',
		argv: ['users; $(exit 19)'],
		cwd: '.',
		timeoutMs: 1000,
	});
});

it('binds MCP creation to a live task and its parent, rejects forged or late calls', async () => {
	const s = setup();
	s.snapshot.prompts = { scan: 'Scan' } as never;
	s.snapshot.schemas = { scan: { type: 'object' } } as never;
	s.snapshot.flow.nodes[2] = {
		id: 'c',
		name: 'Command',
		type: 'agent',
		parameters: { promptRef: 'scan', schemaRef: 'scan', writes: false },
	} as never;
	await s.start();
	await s.node('w');
	const w = s.dispatch.mock.calls[0]![0];
	await s.runtime.complete(String(w.taskId), {
		...w,
		status: 'passed',
		result: { workspace: '/w', candidateSha: 'sha' },
	});
	const run = await s.runtime.inspect('e');
	run.context.parentIssueId = 'parent';
	await s.records.write('run:e', run);
	await s.node('c');
	const task = s.dispatch.mock.calls.at(-1)![0];
	const port = vi.fn(async () => ({ items: [{ id: 'child', created: true }] }));
	(s.runtime as unknown as { ports: { workItem: typeof port } }).ports.workItem = port;
	const finding = {
		kind: 'code',
		title: 'Bug',
		reproduction: 'Read f.ts',
		suggestion: 'Fix',
		labels: ['bug'],
		files: ['f.ts'],
		evidence: [{ kind: 'code', name: 'source', url: 'artifact:source' }],
	};
	await expect(
		s.runtime.createAgentTask(String(task.taskId), { ...task, configHash: 'forged' }, finding),
	).rejects.toThrow();
	const receipt = await s.runtime.createAgentTask(String(task.taskId), task, finding);
	expect(receipt).toMatchObject({ id: 'child', parentId: 'parent' });
	expect(await s.runtime.createAgentTask(String(task.taskId), task, finding)).toMatchObject({
		id: 'child',
	});
	expect(port).toHaveBeenCalledTimes(1);
	await s.runtime.complete(String(task.taskId), { ...task, status: 'failed', result: {} });
	await expect(
		s.runtime.createAgentTask(String(task.taskId), task, { ...finding, title: 'Another' }),
	).rejects.toThrow();
});

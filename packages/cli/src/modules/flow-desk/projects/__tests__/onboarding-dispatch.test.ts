import { it, expect, vi } from 'vitest';
vi.mock('@/workflows/workflow-creation.service', () => ({ WorkflowCreationService: class {} }));
vi.mock('@/workflow-runner', () => ({ WorkflowRunner: class {} }));
vi.mock('@/executions/execution-persistence', () => ({ ExecutionPersistence: class {} }));
vi.mock('@/wait-tracker', () => ({ WaitTracker: class {} }));
vi.mock('../database/project-record.repository', () => ({ ProjectRecordRepository: class {} }));
import { ProjectRuntimeService } from '../project-runtime.service';
it('acknowledges onboarding before calling back into the Plane worker serving the request', async () => {
	const rows = new Map<string, unknown>(),
		records = {
			read: async (key: string) => rows.get(key) ?? null,
			write: async (key: string, value: unknown) => {
				rows.set(key, value);
			},
			claim: async () => true,
		};
	const service = new ProjectRuntimeService(records as never);
	const plane = vi
		.spyOn(service as unknown as { plane: () => Promise<unknown> }, 'plane')
		.mockImplementation(async () => await new Promise(() => {}));
	const result = await service.humanOperation('human', 'onboard', {
		projectId: 'p',
		repo: '/tmp/repo',
	});
	expect(result).toMatchObject({ status: 'running' });
	expect(plane).not.toHaveBeenCalled();
	await new Promise((resolve) => setImmediate(resolve));
	expect(plane).toHaveBeenCalledTimes(1);
});
it('allows only the onboarding human to view actual trial evidence before a workflow exists', async () => {
	const records = {
		read: async (key: string) =>
			key === 'onboard:job' ? { actor: 'human', projectId: 'p', jobId: 'job' } : null,
	};
	const service = new ProjectRuntimeService(records as never);
	const runner = vi
		.spyOn(service as unknown as { runner: (route: string) => Promise<Response> }, 'runner')
		.mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
		);
	const result = await service.humanOperation('human', 'artifact', {
		runId: 'job',
		artifactId: 'image',
	});
	expect(result).toEqual({ mimeType: 'image/png', base64: 'AQID' });
	expect(runner).toHaveBeenCalledWith('/project-artifacts/p/job/image');
	await expect(
		service.humanOperation('other', 'artifact', { runId: 'job', artifactId: 'image' }),
	).rejects.toThrow(/owner|human/i);
});
it('marks native executions that ended without verified Finish as failed, never successful', async () => {
	const { Container } = await import('@n8n/di');
	const records = {
		list: async (prefix: string) =>
			prefix === 'cancel-request:'
				? []
				: [
						{
							executionId: 'ended',
							status: 'running',
							startedAt: Date.now(),
							snapshot: { flow: {} },
						},
					],
		write: vi.fn(async () => {}),
	};
	const service = new ProjectRuntimeService(records as never);
	const terminate = vi.spyOn(service.runtime, 'terminate').mockResolvedValue(undefined as never);
	const get = vi
		.spyOn(Container, 'get')
		.mockReturnValue({ findSingleExecution: async () => ({ status: 'success' }) } as never);
	try {
		await (service as unknown as { reconcile(): Promise<void> }).reconcile();
		expect(terminate).toHaveBeenCalledWith(
			'ended',
			'failed',
			'Native execution ended without a verified Finish',
		);
	} finally {
		get.mockRestore();
	}
});
it('persists and defers child cancellation so a parent lock never waits on a child callback lock', async () => {
	const rows = new Map<string, unknown>([['run:child', {}]]);
	const records = {
		read: async (key: string) => rows.get(key) ?? null,
		write: async (key: string, value: unknown) => {
			rows.set(key, value);
		},
	};
	const service = new ProjectRuntimeService(records as never);
	const cancel = vi.spyOn(service.runtime, 'cancel').mockResolvedValue(undefined as never);
	const get = vi
		.spyOn((await import('@n8n/di')).Container, 'get')
		.mockReturnValue({ findSingleExecution: async () => null } as never);
	try {
		await (
			service.runtime as unknown as { ports: { cancel: (id: string) => Promise<void> } }
		).ports.cancel('child');
		expect(cancel).not.toHaveBeenCalled();
		expect(rows.has('cancel-request:child')).toBe(true);
		await new Promise((resolve) => setImmediate(resolve));
		expect(cancel).toHaveBeenCalledWith('child', false);
		expect(rows.get('cancel-request:child')).toMatchObject({ status: 'passed' });
	} finally {
		get.mockRestore();
	}
});
it('names only existing node records when inspecting a partially started workflow', async () => {
	const service = new ProjectRuntimeService({} as never);
	vi.spyOn(service.runtime, 'inspect').mockResolvedValue({
		status: 'running',
		snapshot: {
			config: { roles: { owner: ['human'] } },
			flow: { nodes: [{ id: 'scan', name: '扫描本轮界面' }] },
		},
	} as never);
	vi.spyOn(service.runtime, 'nodes').mockResolvedValue([
		null,
		{ nodeId: 'scan', status: 'running' },
	] as never);
	const result = (await service.humanOperation('human', 'inspect', { runId: 'run' })) as {
		nodes: unknown[];
	};
	expect(result.nodes).toEqual([{ nodeId: 'scan', name: '扫描本轮界面', status: 'running' }]);
});

it('routes an authenticated legacy scan artifact through the existing desktop artifact operation', async () => {
	const service = new ProjectRuntimeService({ read: async () => null } as never);
	const runId = 'scan_' + 'a'.repeat(32),
		id = '12345678-1234-1234-1234-123456789abc';
	const runner = vi
		.spyOn(service as unknown as { runner: (route: string) => Promise<Response> }, 'runner')
		.mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
	expect(await service.humanOperation('human', 'artifact', { runId, artifactId: id })).toEqual({
		mimeType: 'application/json',
		base64: 'e30=',
	});
	expect(runner).toHaveBeenCalledWith(`/scan-artifacts/${runId}/${id}`);
});
it('loads the real owner role when launching a child workflow', async () => {
	const service = new ProjectRuntimeService({ read: async () => ({ userId: 'owner' }) } as never);
	const findOne = vi.fn(async () => ({ id: 'owner', role: { slug: 'global:owner' } }));
	const get = vi
		.spyOn((await import('@n8n/di')).Container, 'get')
		.mockReturnValue({ findOne } as never);
	const launch = vi
		.spyOn(
			service as unknown as { launchSnapshot: (...args: unknown[]) => Promise<unknown> },
			'launchSnapshot',
		)
		.mockResolvedValue({ executionId: 'child' });
	try {
		await (
			service.runtime as unknown as { ports: { launch: (input: unknown) => Promise<unknown> } }
		).ports.launch({
			parent: { executionId: 'root' },
			snapshot: {},
			childId: 'child',
			rootRunId: 'root',
			context: {},
			depth: 1,
		});
		expect(findOne).toHaveBeenCalledWith({ where: { id: 'owner' }, relations: ['role'] });
		expect(launch).toHaveBeenCalledTimes(1);
	} finally {
		get.mockRestore();
	}
});
it.each(['failed', 'canceled'])(
	'retries a %s run with the same approved snapshot and browser space without reviving its status',
	async (status) => {
		const snapshot = {
			projectId: 'p',
			contentHash: 'hash',
			flows: { scan: { id: 'scan', parameters: { type: 'object', properties: {} } } },
		};
		const service = new ProjectRuntimeService({} as never);
		vi.spyOn(service.configuration, 'active').mockResolvedValue({
			snapshot,
			contentHash: 'hash',
		} as never);
		const prior = {
			projectId: 'p',
			flowId: 'scan',
			configHash: 'hash',
			status,
			context: { browserSpaceId: 15 },
		};
		vi.spyOn(service.runtime, 'inspect').mockResolvedValue(prior as never);
		const launch = vi
			.spyOn(
				service as unknown as { launchSnapshot: (...args: unknown[]) => Promise<unknown> },
				'launchSnapshot',
			)
			.mockResolvedValue({ runId: 'new' });
		await service.launch({ id: 'human' } as never, {
			projectId: 'p',
			flowId: 'scan',
			retryOf: 'old',
		});
		expect(launch.mock.calls[0]?.[3]).toEqual({ context: { retryOf: 'old', browserSpaceId: 15 } });
		expect(prior.status).toBe(status);
		prior.status = 'running';
		await expect(
			service.launch({ id: 'human' } as never, { projectId: 'p', flowId: 'scan', retryOf: 'old' }),
		).rejects.toThrow(/retry/i);
	},
);
it('releases an unused onboarding browser reservation if native launch fails', async () => {
	const remove = vi.fn(async () => {}),
		service = new ProjectRuntimeService({ delete: remove } as never),
		snapshot = {
			projectId: 'p',
			contentHash: 'hash',
			config: { defaults: { onboardingJobId: 'job' } },
			flows: { scan: { id: 'scan' } },
		};
	vi.spyOn(service.configuration, 'active').mockResolvedValue({
		snapshot,
		contentHash: 'hash',
	} as never);
	vi.spyOn(
		service as unknown as { onboardingBrowser: () => Promise<unknown> },
		'onboardingBrowser',
	).mockResolvedValue({ context: { browserSpaceId: 15 } });
	vi.spyOn(
		service as unknown as { launchSnapshot: () => Promise<unknown> },
		'launchSnapshot',
	).mockRejectedValue(new Error('Node registration failed'));
	await expect(
		service.launch({ id: 'human' } as never, { projectId: 'p', flowId: 'scan' }),
	).rejects.toThrow('Node registration failed');
	expect(remove).toHaveBeenCalledWith('onboard-browser:job');
});
it('finishes cancellation for a child rejected before it was ever launched', async () => {
	const rows = new Map<string, unknown>(),
		service = new ProjectRuntimeService({
			read: async (key: string) => rows.get(key) ?? null,
			write: async (key: string, value: unknown) => {
				rows.set(key, value);
			},
		} as never);
	const cancel = vi.spyOn(service.runtime, 'cancel');
	await (
		service as unknown as { processCancellation: (id: string) => Promise<void> }
	).processCancellation('never-launched');
	expect(cancel).not.toHaveBeenCalled();
	expect(rows.get('cancel-request:never-launched')).toMatchObject({ status: 'passed' });
});
it('keeps cancellation pending while a durable launch is still awaiting its native owner', async () => {
	const rows = new Map<string, unknown>([['launch:launching', { snapshot: {} }]]),
		service = new ProjectRuntimeService({
			read: async (key: string) => rows.get(key) ?? null,
			write: async (key: string, value: unknown) => {
				rows.set(key, value);
			},
		} as never);
	const cancel = vi.spyOn(service.runtime, 'cancel');
	await (
		service as unknown as { processCancellation: (id: string) => Promise<void> }
	).processCancellation('launching');
	expect(cancel).not.toHaveBeenCalled();
	expect(rows.get('cancel-request:launching')).toMatchObject({ status: 'failed' });
});

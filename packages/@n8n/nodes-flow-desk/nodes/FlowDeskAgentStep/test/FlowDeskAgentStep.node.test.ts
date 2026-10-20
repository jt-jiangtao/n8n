import { describe, expect, it, vi } from 'vitest';

import { FlowDeskAgentStep } from '../FlowDeskAgentStep.node';

describe('Flow Desk Agent Step (N3)', () => {
	it('N3: registers, dispatches, waits; success/failure pick the matching branch', async () => {
		const register = vi.fn(async () => ({ attempt: 1, taskId: 'task-1' }));
		const dispatch = vi.fn(async () => undefined);
		const putExecutionToWait = vi.fn(async () => undefined);

		const node = new FlowDeskAgentStep();
		const context = {
			getNodeParameter: (name: string) => {
				if (name === 'title') return 'Implement';
				if (name === 'step') return 'implement';
				if (name === 'instructions') return 'Fix the bug';
				if (name === 'requiredFields') return ['summary', 'changes'];
				return undefined;
			},
			getNode: () => ({ id: 'agent-1', name: 'Agent', type: 'flowDeskAgentStep' }),
			getExecutionId: () => 'exec-1',
			getWorkflow: () => ({ id: 'wf-1' }),
			getInputData: () => [
				{
					json: {
						workItem: 'WEB-1',
						flowRunId: 'run-1',
						area: 'web',
						repo: '/tmp/repo',
						baseRef: 'main',
					},
				},
			],
			flowDesk: { steps: { register }, tasks: { dispatch } },
			putExecutionToWait,
			getMode: () => 'trigger',
		};

		const first = await node.execute.call(context as never);
		expect(register).toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalled();
		expect(putExecutionToWait).toHaveBeenCalled();
		expect(first?.[0]?.[0]?.json).toMatchObject({ workItem: 'WEB-1' });

		const successCtx = {
			...context,
			flowDeskResume: { branch: 'success', data: { status: 'ok' } },
			putExecutionToWait: vi.fn(),
		};
		const success = await node.execute.call(successCtx as never);
		expect(success![0][0].json).toMatchObject({ branch: 'success' });

		const failCtx = {
			...context,
			flowDeskResume: { branch: 'failure', data: { status: 'failed' } },
			putExecutionToWait: vi.fn(),
		};
		const failure = await node.execute.call(failCtx as never);
		expect(failure![1][0].json).toMatchObject({ branch: 'failure' });
	});

	it('registers through the module HTTP API when the node has no injected flowDesk client', async () => {
		const fetchMock = vi.fn(async (_url: string, init: { body: string }) => ({
			ok: true,
			status: 200,
			json: async () => ({ attempt: 1, taskId: 'task-http' }),
			text: async () => '',
		}));
		vi.stubGlobal('fetch', fetchMock);
		const node = new FlowDeskAgentStep();
		await node.execute.call({
			getNodeParameter: (name: string) => {
				if (name === 'title') return 'Codex 扫描界面';
				if (name === 'step') return 'ui-scan';
				if (name === 'instructions') return '只读扫描';
				if (name === 'requiredFields') return [];
				return undefined;
			},
			getNode: () => ({ id: 'scan', name: 'Codex 扫描界面', type: 'flowDeskAgentStep' }),
			getExecutionId: () => 'exec-http',
			getInputData: () => [
				{
					json: {
						workItem: 'ACTIONDRIV-6',
						flowRunId: 'run-http',
						area: 'actiondriv',
						repo: '/tmp/action-driver',
						baseRef: 'main',
					},
				},
			],
			putExecutionToWait: vi.fn(async () => undefined),
		} as never);

		expect(fetchMock).toHaveBeenCalled();
		const registerCall = fetchMock.mock.calls.find((call) => call[1]?.body);
		const body = JSON.parse(String(registerCall?.[1].body));
		expect(body).toMatchObject({ kind: 'agent', step: 'ui-scan', workItem: 'ACTIONDRIV-6' });
	});

	it('continues from a saved result instead of dispatching the model again', async () => {
		const register = vi.fn(async () => ({ attempt: 1, taskId: 'again' }));
		const savedResult = vi.fn(async () => ({ branch: 'failure', data: { status: 'failed', summary: 'failed' } }));
		const node = new FlowDeskAgentStep();
		const output = await node.execute.call({
			getNodeParameter: () => '',
			getNode: () => ({ id: 'scan', name: '扫描界面', type: 'flowDeskAgentStep' }),
			getExecutionId: () => 'exec-10',
			getInputData: () => [{ json: { workItem: 'ACTIONDRIV-6' } }],
			flowDesk: { steps: { register, savedResult }, tasks: { dispatch: vi.fn() } },
			putExecutionToWait: vi.fn(),
		} as never);
		expect(savedResult).toHaveBeenCalledWith('exec-10', 'scan');
		expect(register).not.toHaveBeenCalled();
		expect(output![1][0].json).toMatchObject({ branch: 'failure', summary: 'failed' });
	});

	it('shows a runner startup error on the node instead of waiting', async () => {
		const node = new FlowDeskAgentStep();
		const run = node.execute.call({
			getNodeParameter: (name: string) => (name === 'endMarker' ? '<promise>COMPLETE</promise>' : ''),
			getNode: () => ({ id: 'scan', name: '扫描界面', type: 'flowDeskAgentStep' }),
			getExecutionId: () => '22',
			getInputData: () => [{ json: { workItem: 'ACTION-DRIVER-8' } }],
			flowDesk: {
				steps: {
					register: vi.fn(),
					savedResult: vi.fn(async () => ({
						branch: 'failure',
						data: { status: 'failed', error: 'Cursor API key not set（密钥未设置）' },
					})),
				},
				tasks: { dispatch: vi.fn() },
			},
			putExecutionToWait: vi.fn(),
		} as never);
		await expect(run).rejects.toThrow('密钥未设置');
	});

	it('offers Codex and explicit Cursor selection', () => {
		const node = new FlowDeskAgentStep();
		const adapter = node.description.properties.find((property) => property.name === 'adapter') as {
			options: Array<{ value: string }>;
		};
		const model = node.description.properties.find((property) => property.name === 'model') as {
			type: string;
			default: string;
		};
		expect(adapter.options.map((option) => option.value)).toEqual(['', 'codex', 'cursor']);
		expect(model).toMatchObject({ type: 'string', default: 'auto' });
	});

	it('uses the model from flow start, and a node choice overrides it', async () => {
		const register = vi.fn(async () => ({ attempt: 1, taskId: 'task-model' }));
		const node = new FlowDeskAgentStep();
		const base = {
			getNodeParameter: (name: string) => {
				if (name === 'title') return '扫描界面';
				if (name === 'step') return 'ui-scan';
				if (name === 'instructions') return '只读扫描';
				if (name === 'requiredFields') return [];
				return undefined;
			},
			getExecutionId: () => 'exec-model',
			getInputData: () => [
				{
					json: {
						workItem: 'ACTIONDRIV-6',
						flowRunId: 'run-model',
						area: 'actiondriv',
						repo: '/tmp/action-driver',
						baseRef: 'main',
						model: 'cursor',
					},
				},
			],
			flowDesk: { steps: { register }, tasks: { dispatch: vi.fn(async () => undefined) } },
			putExecutionToWait: vi.fn(async () => undefined),
		};

		await node.execute.call({
			...base,
			getNode: () => ({ id: 'scan', name: '扫描界面', type: 'flowDeskAgentStep', parameters: {} }),
		} as never);
		expect(register).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'cursor', model: 'auto' }));

		register.mockClear();
		await node.execute.call({
			...base,
			getNodeParameter: (name: string) => {
				if (name === 'model') return 'composer-2.5';
				if (name === 'title') return '扫描界面';
				if (name === 'step') return 'ui-scan';
				if (name === 'instructions') return '只读扫描';
				if (name === 'requiredFields') return [];
				return undefined;
			},
			getNode: () => ({
				id: 'scan',
				name: '扫描界面',
				type: 'flowDeskAgentStep',
				parameters: { adapter: 'cursor', model: 'composer-2.5' },
			}),
		} as never);
		expect(register).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'cursor', model: 'composer-2.5' }));
	});

	it('runs another round until the end marker, then stops at the cap', async () => {
		const register = vi.fn(async () => ({ attempt: 2, taskId: 'task-2' }));
		const dispatch = vi.fn(async () => undefined);
		const node = new FlowDeskAgentStep();
		const marker = '<promise>COMPLETE</promise>';
		const base = {
			getNodeParameter: (name: string) => {
				if (name === 'title') return '扫描界面';
				if (name === 'step') return 'ui-scan';
				if (name === 'instructions') return '只读扫描';
				if (name === 'endMarker') return marker;
				if (name === 'maxAttempts') return 2;
				if (name === 'requiredFields') return [];
				return undefined;
			},
			getNode: () => ({ id: 'scan', name: '扫描界面', type: 'flowDeskAgentStep' }),
			getExecutionId: () => 'exec-ralph',
			getInputData: () => [{ json: { workItem: 'WEB-1', area: 'web' } }],
			flowDesk: { steps: { register }, tasks: { dispatch } },
			putExecutionToWait: vi.fn(async () => undefined),
		};

		const returned = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'success', data: { attempt: 1, summary: '还在看第一类' } },
		} as never);
		expect(dispatch).not.toHaveBeenCalled();
		expect(returned?.[0]?.[0]?.json).toMatchObject({ summary: '还在看第一类', newIssues: [] });

		const ended = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'success', data: { attempt: 2, summary: marker } },
		} as never);
		expect(ended?.[0]?.[0]?.json).toMatchObject({ branch: 'success', summary: marker });
		expect(dispatch).not.toHaveBeenCalled();

		const next = await node.execute.call({
			...base,
			getInputData: () => [{ json: { workItem: 'WEB-1', area: 'web', attempt: 1, summary: '还在看第一类' } }],
		} as never);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ resume: true, sessionId: 'WEB-1', instructions: expect.stringContaining('第 2/2 轮') }));
		expect(next?.[0]?.[0]?.json).toMatchObject({ workItem: 'WEB-1' });
		dispatch.mockClear();

		await expect(node.execute.call({
			...base,
			getInputData: () => [{ json: { workItem: 'WEB-1', area: 'web', attempt: 2 } }],
		} as never)).rejects.toThrow(/上限/);
		expect(dispatch).not.toHaveBeenCalled();
	});
});

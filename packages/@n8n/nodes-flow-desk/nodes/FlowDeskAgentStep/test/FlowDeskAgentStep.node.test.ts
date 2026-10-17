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
		expect(first).toBeUndefined();

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
});

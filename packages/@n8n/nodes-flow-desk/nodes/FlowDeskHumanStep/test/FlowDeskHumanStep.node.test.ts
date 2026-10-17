import { describe, expect, it, vi } from 'vitest';

import { FlowDeskHumanStep } from '../FlowDeskHumanStep.node';

describe('Flow Desk Human Step (N2)', () => {
	it('N2: registers with the module then waits; resume selects the chosen branch', async () => {
		const register = vi.fn(async () => ({ attempt: 1 }));
		const putExecutionToWait = vi.fn(async () => undefined);
		const getWorkflowStaticData = vi.fn(() => ({}));

		const node = new FlowDeskHumanStep();
		const context = {
			getNodeParameter: (name: string) => {
				if (name === 'title') return 'Approve plan';
				if (name === 'assigneeRole') return 'area.planApprover';
				if (name === 'options') return [{ name: 'approve', label: '通过' }];
				return undefined;
			},
			getNode: () => ({ id: 'human-1', name: 'Human', type: 'flowDeskHumanStep' }),
			getExecutionId: () => 'exec-1',
			getWorkflow: () => ({ id: 'wf-1' }),
			getInputData: () => [{ json: { workItem: 'WEB-1', flowRunId: 'run-1' } }],
			helpers: {},
			flowDesk: { steps: { register } },
			putExecutionToWait,
			getWorkflowStaticData,
			getMode: () => 'trigger',
		};

		// First invocation: register + wait
		const first = await node.execute.call(context as never);
		expect(register).toHaveBeenCalled();
		expect(putExecutionToWait).toHaveBeenCalled();
		expect(first).toBeUndefined();

		// Resume invocation: module injects branch
		const resumeContext = {
			...context,
			getInputData: () => [{ json: { workItem: 'WEB-1', flowRunId: 'run-1' } }],
			getExecutionData: () => ({
				resultData: {
					runData: {},
				},
			}),
			flowDeskResume: { branch: 'approve', data: { decidedBy: 'user-1' } },
			putExecutionToWait: vi.fn(),
		};
		const second = await node.execute.call(resumeContext as never);
		expect(second).toHaveLength(1);
		expect(second![0][0].json).toMatchObject({ branch: 'approve' });
	});
});

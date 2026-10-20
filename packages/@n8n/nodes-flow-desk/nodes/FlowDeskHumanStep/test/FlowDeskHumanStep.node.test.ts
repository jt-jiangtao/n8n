import { describe, expect, it, vi } from 'vitest';

import { FlowDeskHumanStep } from '../FlowDeskHumanStep.node';

describe('Flow Desk Human Step', () => {
	it('returns output data when it starts waiting', async () => {
		const node = new FlowDeskHumanStep();
		const output = await node.execute.call({
			getNodeParameter: (name: string) => (name === 'title' ? '确认' : 'area.planApprover'),
			getNode: () => ({ id: 'human', name: '逐条处理发现' }),
			getExecutionId: () => 'exec-1',
			getInputData: () => [{ json: { workItem: 'ACTIONDRIV-6', flowRunId: 'run-1' } }],
			flowDesk: { steps: { register: vi.fn(async () => ({ attempt: 1 })) } },
			putExecutionToWait: vi.fn(async () => undefined),
		} as never);
		expect(Array.isArray(output)).toBe(true);
		expect(output![0][0].json).toMatchObject({ workItem: 'ACTIONDRIV-6' });
	});
});

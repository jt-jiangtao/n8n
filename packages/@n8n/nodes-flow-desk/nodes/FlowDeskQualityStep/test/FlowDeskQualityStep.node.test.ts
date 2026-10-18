import { describe, expect, it, vi } from 'vitest';

import { FlowDeskQualityStep } from '../FlowDeskQualityStep.node';

describe('Flow Desk Quality Step (N26, M149)', () => {
	it('N26: routes four branches', async () => {
		const node = new FlowDeskQualityStep();
		const base = {
			getNodeParameter: () => 'changed',
			getNode: () => ({ id: 'q1', name: 'Q', type: 'flowDeskQualityStep' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: {} }],
			putExecutionToWait: vi.fn(),
		};
		expect(
			(await node.execute.call({ ...base, flowDeskResume: { branch: 'pass' } } as never))?.[0],
		).toHaveLength(1);
		expect(
			(await node.execute.call({ ...base, flowDeskResume: { branch: 'new-errors' } } as never))?.[1],
		).toHaveLength(1);
		expect(
			(await node.execute.call({ ...base, flowDeskResume: { branch: 'cannot-run' } } as never))?.[2],
		).toHaveLength(1);
		expect(
			(await node.execute.call({ ...base, flowDeskResume: { branch: 'maxAttempts' } } as never))?.[3],
		).toHaveLength(1);
	});

	it('M149: registers quality step for mirroring', async () => {
		const node = new FlowDeskQualityStep();
		const register = vi.fn(async () => ({ attempt: 1, taskId: 't1' }));
		const dispatch = vi.fn(async () => undefined);
		await node.execute.call({
			getNodeParameter: (n: string) => (n === 'scope' ? 'all' : 'Quality'),
			getNode: () => ({ id: 'q1', name: 'Q', type: 'flowDeskQualityStep' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: { workItem: 'W1', area: 'web', flowRunId: 'r1' } }],
			putExecutionToWait: vi.fn(),
			flowDesk: { steps: { register }, tasks: { dispatch } },
		} as never);
		expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quality' }));
		expect(dispatch).toHaveBeenCalled();
	});
});

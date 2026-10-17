/** N4–N9, N15 — CI / attempt / timeout node behaviors */
import { describe, expect, it, vi } from 'vitest';

import { FlowDeskCiStep } from '../FlowDeskCiStep.node';

describe('Flow Desk CI Step (N4–N9, N15)', () => {
	it('N4: CI step registers, dispatches kind=ci, waits', async () => {
		const register = vi.fn(async () => ({ attempt: 1, taskId: 't1' }));
		const dispatch = vi.fn(async () => undefined);
		const putExecutionToWait = vi.fn(async () => undefined);
		const node = new FlowDeskCiStep();
		const first = await node.execute.call({
			getNodeParameter: (n: string) => (n === 'suite' ? 'targeted' : n === 'title' ? 'CI' : undefined),
			getNode: () => ({ id: 'ci-1', name: 'CI', type: 'flowDeskCiStep' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: { workItem: 'W-1', flowRunId: 'r1', area: 'web' } }],
			flowDesk: { steps: { register }, tasks: { dispatch } },
			putExecutionToWait,
		} as never);
		expect(register).toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci' }));
		expect(putExecutionToWait).toHaveBeenCalled();
		expect(first).toBeUndefined();
	});

	it('N5–N7: resume success/failure/ceiling pick branches', async () => {
		const node = new FlowDeskCiStep();
		const base = {
			getNodeParameter: () => undefined,
			getNode: () => ({ id: 'ci-1', name: 'CI', type: 'flowDeskCiStep' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: {} }],
			putExecutionToWait: vi.fn(),
		};
		const ok = await node.execute.call({ ...base, flowDeskResume: { branch: 'pass' } } as never);
		expect(ok![0][0].json.branch).toBe('pass');
		const fail = await node.execute.call({ ...base, flowDeskResume: { branch: 'failure' } } as never);
		expect(fail![1][0].json.branch).toBe('failure');
		const ceiling = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'maxAttempts' },
		} as never);
		expect(ceiling![2][0].json.branch).toBe('maxAttempts');
	});
});

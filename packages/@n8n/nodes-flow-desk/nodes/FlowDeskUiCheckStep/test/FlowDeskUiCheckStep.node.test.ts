import { describe, expect, it, vi } from 'vitest';

import { FlowDeskUiCheckStep } from '../FlowDeskUiCheckStep.node';

describe('Flow Desk UI Check Step (N24/N25/M119/M148)', () => {
	it('N24: routes pass / new-errors / cannot-run / maxAttempts', async () => {
		const node = new FlowDeskUiCheckStep();
		const base = {
			getNodeParameter: () => 'changed',
			getNode: () => ({ id: 'u1', name: 'UI', type: 'flowDeskUiCheckStep' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: {} }],
			putExecutionToWait: vi.fn(),
		};
		const pass = await node.execute.call({ ...base, flowDeskResume: { branch: 'pass' } } as never);
		expect(pass?.[0]).toHaveLength(1);
		const err = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'new-errors' },
		} as never);
		expect(err?.[1]).toHaveLength(1);
		const cannot = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'cannot-run' },
		} as never);
		expect(cannot?.[2]).toHaveLength(1);
		const max = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'maxAttempts' },
		} as never);
		expect(max?.[3]).toHaveLength(1);
	});

	it('M119/M148: registers ui-check and respects kill switch', async () => {
		const node = new FlowDeskUiCheckStep();
		const register = vi.fn(async () => ({ attempt: 1, taskId: 't1' }));
		const dispatch = vi.fn(async () => undefined);
		await node.execute.call({
			getNodeParameter: (n: string) => (n === 'scope' ? 'changed' : 'UI'),
			getNode: () => ({ id: 'u1', name: 'UI', type: 'flowDeskUiCheckStep' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: { workItem: 'W1', area: 'web', flowRunId: 'r1' } }],
			putExecutionToWait: vi.fn(),
			flowDesk: { steps: { register }, tasks: { dispatch }, getKillSwitch: () => false },
		} as never);
		expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ui-check' }));
		expect(dispatch).toHaveBeenCalled();

		await expect(
			node.execute.call({
				getNodeParameter: () => 'x',
				getNode: () => ({ id: 'u1', name: 'UI', type: 'flowDeskUiCheckStep' }),
				getExecutionId: () => 'e1',
				getInputData: () => [{ json: {} }],
				putExecutionToWait: vi.fn(),
				flowDesk: {
					steps: { register },
					tasks: { dispatch },
					getKillSwitch: () => true,
				},
			} as never),
		).rejects.toThrow(/kill switch/i);
	});
});

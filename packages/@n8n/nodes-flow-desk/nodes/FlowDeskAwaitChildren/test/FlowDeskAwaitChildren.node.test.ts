import { describe, expect, it, vi } from 'vitest';

import { FlowDeskAwaitChildren } from '../FlowDeskAwaitChildren.node';

describe('Flow Desk Await Children node', () => {
	it('routes all-done vs has-failure on resume', async () => {
		const node = new FlowDeskAwaitChildren();
		const base = {
			getNodeParameter: () => '跟进',
			getNode: () => ({ id: 'a1', name: 'Await', type: 'flowDeskAwaitChildren' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: { workItem: 'c1' } }],
			putExecutionToWait: vi.fn(),
		};

		const done = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'all-done' },
		} as never);
		expect(done?.[0]).toHaveLength(1);
		expect(done?.[1]).toHaveLength(0);

		const fail = await node.execute.call({
			...base,
			flowDeskResume: { branch: 'has-failure' },
		} as never);
		expect(fail?.[0]).toHaveLength(0);
		expect(fail?.[1]).toHaveLength(1);
	});

	it('waits when evaluate returns waiting', async () => {
		const node = new FlowDeskAwaitChildren();
		const putExecutionToWait = vi.fn();
		const evaluate = vi.fn(async () => ({ branch: 'waiting' }));
		const listCreated = vi.fn(async () => [{ id: 'f1', state: '进行中' }]);

		const out = await node.execute.call({
			getNodeParameter: (n: string) => (n === 'relationType' ? '跟进' : 't'),
			getNode: () => ({ id: 'a1', name: 'Await', type: 'flowDeskAwaitChildren' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: { workItem: 'c1' } }],
			putExecutionToWait,
			flowDesk: {
				awaitChildren: { evaluate, registerWait: vi.fn() },
				related: { listCreated },
			},
		} as never);

		expect(out).toBeUndefined();
		expect(putExecutionToWait).toHaveBeenCalled();
	});
});

import { describe, expect, it, vi } from 'vitest';

import { FlowDeskSwitchFlow } from '../FlowDeskSwitchFlow.node';

describe('Flow Desk Switch Flow node', () => {
	it('routes converted vs failure', async () => {
		const node = new FlowDeskSwitchFlow();
		const switchFn = vi.fn(async () => ({ ok: true }));
		const ctx = {
			getNodeParameter: (n: string) => (n === 'targetFlowType' ? 'feature-large' : 'reason'),
			getNode: () => ({ id: 'sw1', name: 'Switch', type: 'flowDeskSwitchFlow' }),
			getExecutionId: () => 'e1',
			getInputData: () => [{ json: { parentIssueId: 'p1', workItem: 'p1', childIssueId: 'c1' } }],
			flowDesk: { switchFlow: { switch: switchFn } },
		};

		const ok = await node.execute.call(ctx as never);
		expect(ok?.[0]).toHaveLength(1);
		expect(switchFn).toHaveBeenCalled();

		switchFn.mockResolvedValueOnce({ ok: false, error: 'missing-flow-type' });
		const bad = await node.execute.call(ctx as never);
		expect(bad?.[0]).toHaveLength(0);
		expect(bad?.[1]).toHaveLength(1);
	});
});

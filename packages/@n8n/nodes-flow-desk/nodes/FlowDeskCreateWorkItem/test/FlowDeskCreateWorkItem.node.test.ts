import { describe, expect, it, vi } from 'vitest';

import { FlowDeskCreateWorkItem } from '../FlowDeskCreateWorkItem.node';

describe('Flow Desk Create Work Item (N8–N9)', () => {
	it('N8: creates related work item via module and continues', async () => {
		const create = vi.fn(async () => ({ id: 'new-1' }));
		const node = new FlowDeskCreateWorkItem();
		const out = await node.execute.call({
			getNodeParameter: (n: string) => {
				if (n === 'title') return 'Follow-up';
				if (n === 'flowType') return 'bug-standard';
				if (n === 'relation') return 'follow_up';
				return undefined;
			},
			getNode: () => ({ id: 'cwi', name: 'Create', type: 'flowDeskCreateWorkItem' }),
			getInputData: () => [{ json: { workItem: 'P-1', area: 'web' } }],
			flowDesk: { related: { create } },
		} as never);
		expect(create).toHaveBeenCalled();
		expect(out![0][0].json.createdIssueId).toBe('new-1');
	});
});

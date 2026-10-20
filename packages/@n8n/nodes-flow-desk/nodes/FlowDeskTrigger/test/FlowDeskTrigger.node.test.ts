import { describe, expect, it, vi } from 'vitest';

import { FlowDeskTrigger } from '../FlowDeskTrigger.node';

describe('Flow Desk Trigger', () => {
	it('fills the project path when a canvas run has only the flow type', async () => {
		const manualStart = vi.fn(async () => ({
			area: 'actiondriv',
			repo: '/Users/jiangtao/coding/action-driver',
			baseRef: 'main',
			model: 'codex',
			workItem: 'actiondriv-ui-audit',
			flowRunId: 'actiondriv-ui-audit',
		}));
		const node = new FlowDeskTrigger();
		const output = await node.execute.call({
			getNodeParameter: () => 'ui-audit',
			getInputData: () => [{ json: {} }],
			flowDesk: { steps: { manualStart } },
		} as never);
		expect(manualStart).toHaveBeenCalledWith('ui-audit');
		expect(output![0][0].json).toMatchObject({
			flowType: 'ui-audit',
			repo: '/Users/jiangtao/coding/action-driver',
			model: 'codex',
			workItem: 'actiondriv-ui-audit',
		});
	});

	it('keeps a start payload that already names the repository', async () => {
		const manualStart = vi.fn();
		const node = new FlowDeskTrigger();
		const output = await node.execute.call({
			getNodeParameter: () => 'ui-audit',
			getInputData: () => [{ json: { repo: '/already/set', workItem: 'ACTIONDRIV-6', model: 'cursor' } }],
			flowDesk: { steps: { manualStart } },
		} as never);
		expect(manualStart).not.toHaveBeenCalled();
		expect(output![0][0].json).toMatchObject({ repo: '/already/set', model: 'cursor', flowType: 'ui-audit' });
	});
});

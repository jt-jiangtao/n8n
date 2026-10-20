import { describe, expect, it, vi } from 'vitest';

import { FlowDeskCreateWorkItem } from '../FlowDeskCreateWorkItem.node.js';
import { FlowDeskNotify } from '../../FlowDeskNotify/FlowDeskNotify.node.js';
import { FlowDeskEndCheck } from '../../FlowDeskEndCheck/FlowDeskEndCheck.node.js';

const finding = {
	title: '对比度可能不足',
	page: '/settings',
	reproduction: '打开设置页',
	suggestion: '不能确定，交给人看',
	labels: '风格',
	evidence: [{ kind: 'image' }],
};

describe('generic create and notify nodes', () => {
	it('creates uncertain findings and does not send Feishu', async () => {
		const create = vi.fn(async () => ({ items: [{ id: 'issue-2', title: finding.title, created: true }] }));
		const send = vi.fn(async () => undefined);
		const node = new FlowDeskCreateWorkItem();
		const result = await node.execute.call({
			getNodeParameter: (name: string) => (name === 'title' ? '界面扫描' : name === 'relation' ? '跟进' : ''),
			getInputData: () => [{ json: { workItem: 'parent-1', area: 'web', newIssues: [finding] } }],
			flowDesk: { workItems: { create }, notify: { send } },
		} as never);
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'parent-1', findings: [finding] }));
		expect(send).not.toHaveBeenCalled();
		expect(result?.[0]?.[0]?.json.createdWorkItems).toEqual([{ id: 'issue-2', title: finding.title, created: true }]);
	});

	it('creates the parent from the title when there are no findings', async () => {
		const create = vi.fn(async () => ({ id: 'parent-1', title: '界面扫描' }));
		const node = new FlowDeskCreateWorkItem();
		const result = await node.execute.call({
			getNodeParameter: (name: string) => (name === 'title' ? '界面扫描' : name === 'flowType' ? 'ui-audit' : '跟进'),
			getInputData: () => [{ json: { area: 'web' } }],
			flowDesk: { workItems: { create }, notify: { send: vi.fn() } },
		} as never);
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: '界面扫描', flowType: 'ui-audit', findings: [] }));
		expect(result?.[0]?.[0]?.json.workItem).toBe('parent-1');
	});

	it('sends Feishu for created work items and does not create another task', async () => {
		const create = vi.fn();
		const send = vi.fn(async () => undefined);
		const node = new FlowDeskNotify();
		await node.execute.call({
			getNodeParameter: (name: string) => (name === 'buttons' ? '待修复,忽略' : '发现'),
			getInputData: () => [{ json: { createdWorkItems: [{ id: 'issue-2', title: '对比度可能不足', created: true }, { created: false }] } }],
			flowDesk: { workItems: { create }, notify: { send } },
		} as never);
		expect(create).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({ workItemId: 'issue-2', title: '对比度可能不足', buttons: ['待修复', '忽略'], area: undefined });
	});

	it('treats only the whole reply as the end marker', async () => {
		const node = new FlowDeskEndCheck();
		const call = (summary: string) =>
			node.execute.call({
				getNodeParameter: () => '<promise>COMPLETE</promise>',
				getInputData: () => [{ json: { summary, attempt: 1 } }],
			} as never);
		const done = await call('<promise>COMPLETE</promise>');
		const again = await call('还在看\n<promise>COMPLETE</promise>');
		expect(done?.[0]?.[0]?.json.summary).toBe('<promise>COMPLETE</promise>');
		expect(done?.[1]).toEqual([]);
		expect(again?.[0]).toEqual([]);
		expect(again?.[1]?.[0]?.json.summary).toContain('还在看');
	});
});

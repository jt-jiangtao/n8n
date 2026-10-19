import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { UiScanService, type ScanCatalog } from '../ui-scan/ui-scan.service';
import { writeThroughDecisions } from '../ui-scan/feishu-decision';

const root = path.resolve(__dirname, '../../../../../../../..');

const catalog: ScanCatalog = {
	prompt: {
		id: 'ui-scan',
		body: '只读扫描',
		skills: ['accessibility-audit'],
		taskTemplates: ['ui-scan-bug'],
	},
	skills: { 'accessibility-audit': 'name: accessibility-audit' },
	template: {
		id: 'ui-scan-bug',
		fields: ['title', 'reproduction', 'suggestion', 'labels', 'evidence', 'files'],
	},
};

const finding = {
	title: '按钮点不到',
	page: '/settings',
	reproduction: '打开 /settings，宽 375',
	suggestion: '把按钮移进可视区域',
	labels: '交互',
	evidence: [
		{ kind: 'image', name: 'full' },
		{ kind: 'image', name: 'crop' },
	],
	files: 'apps/web/settings.tsx',
};

function harness(tasks: Array<{ id: string; title: string; status: string; page?: string }> = []) {
	const plane = {
		createIssue: vi.fn(async (input: { title: string }) => ({ id: `issue-${plane.createIssue.mock.calls.length}` })),
		comment: vi.fn(async () => undefined),
	};
	const feishu = { notify: vi.fn(async () => undefined) };
	const dispatch = vi.fn(async () => undefined);
	const startFlow = vi.fn(async () => undefined);
	const service = new UiScanService({
		plane,
		feishu,
		dispatch,
		catalog,
		tasks: [...tasks],
		startFlow,
	});
	return { service, plane, feishu, dispatch, startFlow };
}

describe('ui scan flow', () => {
	it('creates the parent task before dispatching the prompt and its skills', async () => {
		const { service, plane, dispatch, feishu } = harness();
		const started = await service.start({ title: '界面扫描', area: 'web' });
		expect(plane.createIssue).toHaveBeenCalledBefore(dispatch);
		expect(started.parentId).toBe('issue-1');
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: 'issue-1',
				promptId: 'ui-scan',
				skills: ['accessibility-audit'],
			}),
		);
		const payload = dispatch.mock.calls[0][0] as { instructions: string; contentHash: string };
		expect(payload.instructions).toContain('只读扫描');
		expect(payload.contentHash).toBe(
			createHash('sha256').update(JSON.stringify({ body: '只读扫描', skills: ['accessibility-audit'], template: 'ui-scan-bug' })).digest('hex'),
		);
		expect(feishu.notify).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'issue-1' }));
		expect(plane.comment).toHaveBeenCalledWith('issue-1', expect.stringContaining('界面扫描'));
	});

	it('lists open tasks without changing them, and skips a duplicate title and page', async () => {
		const { service, plane } = harness([{ id: 'old', title: '按钮点不到', status: '待处理', page: '/settings' }]);
		const started = await service.start({ title: '界面扫描', area: 'web' });
		const token = started.token;
		const before = plane.createIssue.mock.calls.length;
		const listed = service.listTasks(token);
		expect(listed).toEqual([{ id: 'old', title: '按钮点不到', status: '待处理' }]);
		expect(plane.createIssue).toHaveBeenCalledTimes(before);
		const duplicate = await service.addTask(token, finding);
		expect(duplicate.created).toBe(false);
		expect(plane.createIssue).toHaveBeenCalledTimes(before);
	});

	it('creates a child bug and notifies both sides, and rejects a bad payload', async () => {
		const { service, plane, feishu } = harness();
		const started = await service.start({ title: '界面扫描', area: 'web' });
		const created = await service.addTask(started.token, finding);
		expect(created.created).toBe(true);
		expect(created.issueId).toBeTruthy();
		expect(plane.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ parentId: started.parentId, title: '按钮点不到' }));
		expect(feishu.notify).toHaveBeenCalledWith(expect.objectContaining({ workItemId: created.issueId }));
		await expect(service.addTask(started.token, { title: '缺字段' })).rejects.toThrow(/字段/);
		await expect(
			service.addTask(started.token, { ...finding, title: '另一处', evidence: [{ kind: 'text', name: 'note' }] }),
		).rejects.toThrow(/图片/);
	});

	it('does not read a skill outside the prompt, and a dead token cannot add a task', async () => {
		const { service, plane } = harness();
		const started = await service.start({ title: '界面扫描', area: 'web' });
		expect(service.readSkill(started.token, 'accessibility-audit')).toContain('accessibility-audit');
		expect(() => service.readSkill(started.token, 'ui-design')).toThrow(/技能/);
		service.endTask(started.token);
		const calls = plane.createIssue.mock.calls.length;
		await expect(service.addTask(started.token, finding)).rejects.toThrow(/凭证/);
		expect(plane.createIssue).toHaveBeenCalledTimes(calls);
	});

	it('does not start a fix flow when a bug becomes 待修复', async () => {
		const { service, startFlow } = harness();
		const started = await service.start({ title: '界面扫描', area: 'web' });
		const created = await service.addTask(started.token, finding);
		await service.transition(created.issueId!, '待修复');
		expect(startFlow).not.toHaveBeenCalled();
	});

	it('keeps the work item when Feishu notification fails', async () => {
		const { service, plane, feishu } = harness();
		feishu.notify.mockRejectedValueOnce(new Error('down'));
		const started = await service.start({ title: '界面扫描', area: 'web' });
		expect(started.parentId).toBe('issue-1');
		expect(plane.createIssue).toHaveBeenCalled();
	});

	it('points the shipped flow at ui-scan and the bug template', () => {
		const flow = JSON.parse(readFileSync(path.join(root, 'flows/ui-audit.json'), 'utf8')) as {
			nodes: Array<{ parameters?: { promptId?: string; instructions?: string } }>;
		};
		const scan = flow.nodes.find((node) => node.parameters?.promptId || node.parameters?.instructions);
		expect(scan?.parameters?.promptId).toBe('ui-scan');
		expect(scan?.parameters?.instructions).toBeUndefined();
		const prompt = readFileSync(path.join(root, 'catalog/prompts/ui-scan.yaml'), 'utf8');
		expect(prompt).toContain('ui-scan-bug');
		const template = JSON.parse(readFileSync(path.join(root, 'catalog/templates/ui-scan-bug.json'), 'utf8')) as {
			id: string;
			fields: Array<{ name: string }>;
		};
		expect(template.id).toBe('ui-scan-bug');
		expect(template.fields.map((field) => field.name)).toEqual([
			'title',
			'reproduction',
			'suggestion',
			'labels',
			'evidence',
			'files',
		]);
	});
});

describe('feishu decision write', () => {
	it('writes the button through the existing decision submit', async () => {
		const submit = vi.fn(async () => ({ ok: true }));
		const result = await writeThroughDecisions(
			{ submit },
			{
				workItemId: 'WEB-9',
				button: '待修复',
				executionId: 'exec-1',
				nodeId: 'human-1',
				area: 'web',
				attempt: 1,
			},
			'jiangtao',
		);
		expect(result).toEqual({ ok: true });
		expect(submit).toHaveBeenCalledWith(
			expect.objectContaining({
				decision: '待修复',
				source: 'feishu',
				childIssueId: 'WEB-9',
				actor: 'jiangtao',
			}),
		);
	});
});

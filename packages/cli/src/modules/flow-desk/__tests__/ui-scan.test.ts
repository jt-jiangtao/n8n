import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadUiScanCatalog, UiScanService, type ScanCatalog } from '../ui-scan/ui-scan.service';
import { writeThroughDecisions } from '../ui-scan/feishu-decision';

const root = path.resolve(__dirname, '../../../../../../../..');

const catalog: ScanCatalog = {
	prompt: {
		id: 'ui-scan',
		body: '只读扫描',
		skills: ['accessibility-audit'],
		taskTemplates: ['ui-scan-bug'],
	},
	root: '',
	template: {
		id: 'ui-scan-bug',
		fields: ['title', 'reproduction', 'suggestion', 'labels', 'evidence', 'files'],
	},
};

const skillBody = `---
name: accessibility-audit
description: Checks pages for accessibility.
---

# Audit

## Scope

Look at the page.

## Later

Do not include this.
`;

beforeAll(() => {
	catalog.root = mkdtempSync(path.join(tmpdir(), 'ui-scan-'));
	const skill = path.join(catalog.root, 'catalog/skills/accessibility-audit');
	mkdirSync(path.join(skill, 'references'), { recursive: true });
	writeFileSync(path.join(skill, 'SKILL.md'), skillBody);
	writeFileSync(path.join(skill, 'references/notes.md'), 'only this file\n');
	writeFileSync(path.join(catalog.root, 'catalog/skills/outside.txt'), 'outside skill');
	mkdirSync(path.join(catalog.root, 'catalog/prompts'), { recursive: true });
	writeFileSync(
		path.join(catalog.root, 'catalog/prompts/ui-scan.yaml'),
		'id: ui-scan\nbody: |\n  只读扫描\nskills:\n  - accessibility-audit\ntaskTemplates:\n  - ui-scan-bug\n',
	);
	mkdirSync(path.join(catalog.root, 'catalog/templates'), { recursive: true });
	writeFileSync(
		path.join(catalog.root, 'catalog/templates/ui-scan-bug.json'),
		JSON.stringify({
			id: 'ui-scan-bug',
			fields: ['title', 'reproduction', 'suggestion', 'labels', 'evidence', 'files'].map((name) => ({ name })),
		}),
	);
});

afterAll(() => {
	if (catalog.root) rmSync(catalog.root, { recursive: true, force: true });
});

type Progressive = {
	listSkills: (token: string) => { id: string; description: string }[];
	listSkillOutline: (token: string, skillId: string) => { files: string[]; headings: string[] };
	readSkill: (token: string, skillId: string, selector?: { path?: string; heading?: string }) => string;
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
		const tools = service as unknown as Progressive;
		expect(() => tools.readSkill(started.token, 'ui-design', { path: 'SKILL.md' })).toThrow(/技能/);
		service.endTask(started.token);
		const calls = plane.createIssue.mock.calls.length;
		await expect(service.addTask(started.token, finding)).rejects.toThrow(/凭证/);
		expect(plane.createIssue).toHaveBeenCalledTimes(calls);
	});

	it('lists skill names and one outline without skill bodies', async () => {
		const { service } = harness();
		const started = await service.start({ title: '界面扫描', area: 'web' });
		const tools = service as unknown as Progressive;
		const listed = tools.listSkills(started.token);
		expect(listed).toEqual([{ id: 'accessibility-audit', description: 'Checks pages for accessibility.' }]);
		expect(JSON.stringify(listed)).not.toContain('Look at the page');
		const outline = tools.listSkillOutline(started.token, 'accessibility-audit');
		expect(outline.files).toEqual(['SKILL.md', 'references/notes.md']);
		expect(outline.headings).toEqual(['Audit', 'Scope', 'Later']);
		expect(JSON.stringify(outline)).not.toContain('Look at the page');
		expect(JSON.stringify(outline)).not.toContain('only this file');
	});

	it('reads one file or one heading, and rejects a whole skill or an escaped path', async () => {
		const { service } = harness();
		const started = await service.start({ title: '界面扫描', area: 'web' });
		const tools = service as unknown as Progressive;
		expect(() => tools.readSkill(started.token, 'accessibility-audit')).toThrow(/路径|标题/);
		expect(tools.readSkill(started.token, 'accessibility-audit', { path: 'references/notes.md' })).toBe('only this file\n');
		const section = tools.readSkill(started.token, 'accessibility-audit', { heading: 'Scope' });
		expect(section).toContain('Look at the page');
		expect(section).not.toContain('Do not include this');
		expect(() => tools.readSkill(started.token, 'accessibility-audit', { path: '../outside.txt' })).toThrow(/路径/);
		expect(() => tools.readSkill(started.token, 'accessibility-audit', { heading: 'Missing' })).toThrow(/标题/);
		expect(() =>
			tools.readSkill(started.token, 'accessibility-audit', { path: 'SKILL.md', heading: 'Scope' }),
		).toThrow(/路径|标题/);
		service.endTask(started.token);
		expect(() => tools.readSkill(started.token, 'accessibility-audit', { path: 'SKILL.md' })).toThrow(/凭证/);
	});

	it('does not put skill bodies into the catalog snapshot', () => {
		const loaded = loadUiScanCatalog(catalog.root);
		expect(loaded.prompt.skills).toEqual(['accessibility-audit']);
		expect(JSON.stringify(loaded)).not.toContain('Look at the page');
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

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type ScanCatalog = {
	prompt: { id: string; body: string; skills: string[]; taskTemplates: string[] };
	skills: Record<string, string>;
	template: { id: string; fields: string[] };
};

export type OpenTask = { id: string; title: string; status: string; page?: string };

type Finding = Record<string, unknown>;

const CLOSED = new Set(['已关闭', 'closed']);

export function loadUiScanCatalog(root: string | undefined): ScanCatalog {
	if (!root) throw new Error('catalog missing');
	const prompt = readFileSync(path.join(root, 'catalog/prompts/ui-scan.yaml'), 'utf8');
	const bodyStart = prompt.indexOf('body: |');
	const skillsStart = prompt.indexOf('\nskills:');
	const body = prompt.slice(bodyStart + 'body: |'.length, skillsStart).replace(/\n {2}/g, '\n').trim();
	const skills = [...prompt.matchAll(/^\s+- ([a-z0-9-]+)$/gm)].map((match) => match[1]).filter((id) => id !== 'ui-scan-bug');
	const template = JSON.parse(readFileSync(path.join(root, 'catalog/templates/ui-scan-bug.json'), 'utf8')) as {
		id: string;
		fields: Array<{ name: string }>;
	};
	const skillBodies: Record<string, string> = {};
	for (const id of skills) {
		skillBodies[id] = readFileSync(path.join(root, 'catalog/skills', id, 'SKILL.md'), 'utf8');
	}
	return {
		prompt: { id: 'ui-scan', body, skills, taskTemplates: ['ui-scan-bug'] },
		skills: skillBodies,
		template: { id: template.id, fields: template.fields.map((field) => field.name) },
	};
}

export function resolveCatalogPrompt(catalog: ScanCatalog) {
	const body = catalog.prompt.body;
	const skills = catalog.prompt.skills;
	const template = catalog.template.id;
	return {
		body,
		skills,
		contentHash: createHash('sha256').update(JSON.stringify({ body, skills, template })).digest('hex'),
	};
}

export class UiScanService {
	private readonly tokens = new Map<string, { parentId: string }>();

	constructor(
		private readonly deps: {
			plane: {
				createIssue: (input: { title: string; parentId?: string; flowType?: string; area?: string; page?: string }) => Promise<{ id: string }>;
				comment: (issueId: string, body: string) => Promise<void>;
			};
			feishu: { notify: (input: { workItemId: string; title: string; buttons: string[] }) => Promise<void> } | null;
			dispatch: (payload: Record<string, unknown>) => Promise<void>;
			catalog: ScanCatalog;
			tasks: OpenTask[];
			startFlow?: (flowType: string, issueId: string) => Promise<void>;
		},
	) {}

	async start(input: { title: string; area: string }) {
		const parent = await this.deps.plane.createIssue({ title: input.title, flowType: 'ui-audit', area: input.area });
		try {
			await this.deps.plane.comment(parent.id, `已创建${input.title}`);
			if (this.deps.feishu) {
				await this.deps.feishu.notify({ workItemId: parent.id, title: input.title, buttons: [] });
			}
		} catch {
			// 飞书失败不取消已经创建的工单。
		}
		const resolved = resolveCatalogPrompt(this.deps.catalog);
		const token = randomUUID();
		this.tokens.set(token, { parentId: parent.id });
		await this.deps.dispatch({
			workItem: parent.id,
			promptId: this.deps.catalog.prompt.id,
			instructions: resolved.body,
			skills: resolved.skills,
			contentHash: resolved.contentHash,
			token,
		});
		return { parentId: parent.id, token, dispatched: true };
	}

	listTasks(token: string) {
		this.session(token);
		return this.deps.tasks
			.filter((task) => !CLOSED.has(task.status))
			.map(({ id, title, status }) => ({ id, title, status }));
	}

	readSkill(token: string, skillId: string) {
		this.session(token);
		if (!this.deps.catalog.prompt.skills.includes(skillId)) throw new Error('技能不在允许列表');
		const body = this.deps.catalog.skills[skillId];
		if (!body) throw new Error('技能不在允许列表');
		return body;
	}

	async addTask(token: string, fields: Finding) {
		const session = this.session(token);
		for (const name of ['title', 'reproduction', 'suggestion', 'labels', 'evidence']) {
			if (fields[name] === undefined || fields[name] === '') throw new Error('缺少必填字段');
		}
		const evidence = fields.evidence;
		if (!Array.isArray(evidence) || evidence.some((item) => (item as { kind?: string })?.kind !== 'image')) {
			throw new Error('证据必须是图片');
		}
		const page = String(fields.page ?? '');
		const duplicate = this.deps.tasks.find(
			(task) => !CLOSED.has(task.status) && task.title === fields.title && task.page === page,
		);
		if (duplicate) return { created: false as const };
		const issue = await this.deps.plane.createIssue({
			title: String(fields.title),
			parentId: session.parentId,
			page,
		});
		this.deps.tasks.push({ id: issue.id, title: String(fields.title), status: '待处理', page });
		try {
			await this.deps.plane.comment(issue.id, String(fields.title));
			if (this.deps.feishu) {
				await this.deps.feishu.notify({
					workItemId: issue.id,
					title: String(fields.title),
					buttons: ['待修复', '忽略'],
				});
			}
		} catch {
			// 通知失败不取消子任务。
		}
		return { created: true as const, issueId: issue.id };
	}

	endTask(token: string) {
		this.tokens.delete(token);
	}

	async transition(issueId: string, status: string) {
		const task = this.deps.tasks.find((item) => item.id === issueId);
		if (task) task.status = status;
		return { status };
	}

	private session(token: string) {
		const row = this.tokens.get(token);
		if (!row) throw new Error('凭证无效');
		return row;
	}
}

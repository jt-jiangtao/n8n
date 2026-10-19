import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ScanCatalog = {
	prompt: { id: string; body: string; skills: string[]; taskTemplates: string[] };
	root: string;
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
	return {
		prompt: { id: 'ui-scan', body, skills, taskTemplates: ['ui-scan-bug'] },
		root,
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

	listSkills(token: string) {
		this.session(token);
		return this.deps.catalog.prompt.skills.map((id) => ({
			id,
			description: descriptionOf(readFileSync(this.skillFile(id, 'SKILL.md'), 'utf8')),
		}));
	}

	listSkillOutline(token: string, skillId: string) {
		this.session(token);
		this.assertAllowed(skillId);
		const base = this.skillDir(skillId);
		const files = walk(base)
			.map((file) => path.relative(base, file).split(path.sep).join('/'))
			.sort();
		const headings = headingsOf(readFileSync(path.join(base, 'SKILL.md'), 'utf8'));
		return { files, headings };
	}

	readSkill(token: string, skillId: string, selector?: { path?: string; heading?: string }) {
		this.session(token);
		this.assertAllowed(skillId);
		const hasPath = selector?.path !== undefined;
		const hasHeading = selector?.heading !== undefined;
		if (hasPath === hasHeading) throw new Error('需要路径或标题');
		if (hasPath) return readFileSync(this.skillFile(skillId, selector.path!), 'utf8');
		return sectionOf(readFileSync(this.skillFile(skillId, 'SKILL.md'), 'utf8'), selector!.heading!);
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

	private assertAllowed(skillId: string) {
		if (!this.deps.catalog.prompt.skills.includes(skillId)) throw new Error('技能不在允许列表');
	}

	private skillDir(skillId: string) {
		return path.resolve(this.deps.catalog.root, 'catalog/skills', skillId);
	}

	private skillFile(skillId: string, rel: string) {
		if (rel.includes('\0') || path.isAbsolute(rel)) throw new Error('路径越界');
		const base = this.skillDir(skillId);
		const target = path.resolve(base, rel);
		if (target !== base && !target.startsWith(base + path.sep)) throw new Error('路径越界');
		try {
			if (!statSync(target).isFile()) throw new Error('路径越界');
		} catch (error) {
			if (error instanceof Error && error.message === '路径越界') throw error;
			throw new Error('路径越界');
		}
		return target;
	}
}

function descriptionOf(markdown: string) {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	const line = (frontmatter?.[1] ?? '').split('\n').find((row) => row.startsWith('description:'));
	return (line?.slice('description:'.length) ?? '').trim();
}

function headingsOf(markdown: string) {
	return [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => match[2].trim());
}

function sectionOf(markdown: string, heading: string) {
	const lines = markdown.split('\n');
	const start = lines.findIndex((line) => {
		const match = /^(#{1,6})\s+(.*)$/.exec(line);
		return match?.[2].trim() === heading;
	});
	if (start < 0) throw new Error('标题不存在');
	const level = /^(#{1,6})/.exec(lines[start])![1].length;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const match = /^(#{1,6})\s+/.exec(lines[i]);
		if (match && match[1].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join('\n').trim();
}

function walk(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) files.push(...walk(full));
		else files.push(full);
	}
	return files;
}

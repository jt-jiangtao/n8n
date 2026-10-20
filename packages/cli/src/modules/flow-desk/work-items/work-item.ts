export const RALPH_END_MARKER = '<promise>COMPLETE</promise>';

export type WorkItemClient = {
	plane: {
		createIssue: (input: {
			title: string;
			parentId?: string;
			flowType?: string;
			area?: string;
			page?: string;
			reproduction?: string;
			suggestion?: string;
			labels?: unknown;
			evidence?: unknown;
			files?: unknown;
		}) => Promise<{ id: string }>;
		comment: (issueId: string, body: string) => Promise<void>;
	};
	feishu: { notify: (input: { workItemId: string; title: string; buttons: string[] }) => Promise<void> } | null;
};

export type FindingFields = {
	kind?: string;
	title: string;
	page?: string;
	reproduction: string;
	suggestion: string;
	labels: unknown;
	evidence: Array<{ kind: string }>;
	files?: unknown;
};

export async function openWorkItem(
	deps: WorkItemClient,
	input: { title: string; parentId?: string; flowType?: string; area?: string; page?: string },
	notice: { comment: string; title: string; buttons: string[] },
) {
	const issue = await deps.plane.createIssue(input);
	await notifyWorkItem(deps, issue.id, notice);
	return issue;
}

export async function notifyWorkItem(
	deps: WorkItemClient,
	issueId: string,
	notice: { comment: string; title: string; buttons: string[] },
) {
	await deps.plane.comment(issueId, notice.comment);
	if (deps.feishu) await deps.feishu.notify({ workItemId: issueId, title: notice.title, buttons: notice.buttons });
}

export function readAgentDecision(result: Record<string, unknown>, marker = RALPH_END_MARKER) {
	const summary = String(result.summary ?? '').trim();
	const ended = summary === marker.trim();
	if (!ended) return { kind: 'continue' as const };
	const raw = Array.isArray(result.newIssues) ? result.newIssues : [];
	const issues: FindingFields[] = [];
	const rejected: string[] = [];
	for (const item of raw) {
		const checked = validateFinding(item);
		if (checked.ok) issues.push(checked.value);
		else rejected.push(checked.reason);
	}
	return { kind: 'finished' as const, summary, issues, rejected };
}

export async function createPlannedWorkItems(
	deps: WorkItemClient,
	parentId: string | undefined,
	tasks: Array<{ id: string; title: string; status: string; page?: string }>,
	findings: unknown[],
) {
	const validated = findings.map((item) => {
		const checked = validateFinding(item);
		if (!checked.ok) throw new Error(checked.reason);
		return checked.value;
	});
	const created = [];
	for (const item of validated) {
		const checked = validateFinding(item);
		if (!checked.ok) {
			throw new Error(checked.reason);
		}
		const page = checked.value.page ?? '';
		const duplicate = tasks.find((task) => task.status !== '已关闭' && task.title === checked.value.title && (task.page ?? '') === page);
		if (duplicate) {
			created.push({ created: false as const });
			continue;
		}
		const issue = await deps.plane.createIssue({
			...checked.value,
			parentId,
			page,
		});
		tasks.push({ id: issue.id, title: checked.value.title, status: '待处理', page });
		created.push({ created: true as const, id: issue.id, issueId: issue.id, title: checked.value.title, status: '待处理' as const });
	}
	return { items: created };
}

export function validateFinding(item: unknown): { ok: true; value: FindingFields } | { ok: false; reason: string } {
	if (!item || typeof item !== 'object') return { ok: false, reason: '缺少必填字段' };
	const fields = item as Record<string, unknown>;
	for (const name of ['title', 'reproduction', 'suggestion', 'labels', 'evidence']) {
		if (fields[name] === undefined || fields[name] === '') return { ok: false, reason: '缺少必填字段' };
	}
	const evidence = fields.evidence;
	const validEvidence = fields.kind === 'code'
		? Array.isArray(fields.files) && fields.files.length > 0 && Array.isArray(evidence) && evidence.length > 0 && evidence.every(entry => entry && typeof entry === 'object' && entry.kind === 'code' && typeof entry.url === 'string')
		: Array.isArray(evidence) && evidence.length >= 2 && evidence.every(entry => entry && typeof entry === 'object' && entry.kind === 'image');
	if (!validEvidence) return {ok:false,reason:'Finding evidence is missing or invalid'};

	return {
		ok: true,
		value: {
			...(fields.kind === 'code' ? {kind:'code'} : {}),
			title: String(fields.title),
			page: fields.page === undefined ? undefined : String(fields.page),
			reproduction: String(fields.reproduction),
			suggestion: String(fields.suggestion),
			labels: fields.labels,
			evidence: evidence as Array<{ kind: string }>,
			files: fields.files,
		},
	};
}

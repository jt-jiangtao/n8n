import { Service } from '@n8n/di';

import type { FlowDeskConfigService } from '../config/config.service';

export type IntakePlane = {
	createIssue: (input: {
		title: string;
		description?: string;
		labels: string[];
		project?: string;
		state?: string;
	}) => Promise<{ id: string; identifier?: string }>;
	createRelation: (from: string, to: string, type: string) => Promise<unknown>;
	updateIssueState: (id: string, state: string) => Promise<unknown>;
	comment: (issueId: string, body: string) => Promise<unknown>;
};

export type IndexedIssue = {
	id: string;
	title: string;
	area: string;
	state: string;
	dedupeKey?: string;
	errorSignature?: string;
	files?: string[];
};

const CLOSED = new Set(['完成', '已取消']);

function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/\d+/g, '')
		.replace(/\s+/g, '')
		.trim();
}

function sameFiles(a: string[] = [], b: string[] = []): boolean {
	if (a.length === 0 || b.length === 0) return false;
	const sa = [...a].map((f) => f.trim()).filter(Boolean).sort();
	const sb = [...b].map((f) => f.trim()).filter(Boolean).sort();
	if (sa.length !== sb.length) return false;
	return sa.every((f, i) => f === sb[i]);
}

@Service()
export class FlowDeskIntakeService {
	private index: IndexedIssue[] = [];

	constructor(
		private readonly plane: IntakePlane,
		private readonly config: FlowDeskConfigService,
	) {}

	indexExisting(issues: IndexedIssue[]) {
		this.index = [...issues];
	}

	private findDuplicate(input: {
		title: string;
		area: string;
		dedupeKey?: string;
		errorSignature?: string;
		files?: string[];
	}): { issue: IndexedIssue; rule: string } | null {
		const open = this.index.filter(
			(i) => i.area === input.area && !CLOSED.has(i.state),
		);
		for (const issue of open) {
			if (input.dedupeKey && issue.dedupeKey && input.dedupeKey === issue.dedupeKey) {
				return { issue, rule: 'dedupeKey' };
			}
		}
		const norm = normalizeTitle(input.title);
		for (const issue of open) {
			if (norm && normalizeTitle(issue.title) === norm) {
				return { issue, rule: 'title' };
			}
		}
		for (const issue of open) {
			if (
				input.errorSignature &&
				issue.errorSignature &&
				input.errorSignature === issue.errorSignature
			) {
				return { issue, rule: 'errorSignature' };
			}
		}
		for (const issue of open) {
			if (sameFiles(input.files, issue.files)) {
				return { issue, rule: 'files' };
			}
		}
		return null;
	}

	async submit(input: {
		title: string;
		reproduction: string;
		evidence: string;
		discoveredIn?: string;
		area: string;
		files?: string[];
		dedupeKey?: string;
		errorSignature?: string;
		source?: 'agent' | 'signal' | 'human';
		flowType?: string;
		state?: string;
	}): Promise<
		| { ok: true; id: string; deduped?: boolean }
		| { ok: false; missing: string[] }
	> {
		const missing: string[] = [];
		if (!input.reproduction?.trim()) missing.push('reproduction');
		if (!input.evidence?.trim()) missing.push('evidence');
		if (missing.length) return { ok: false, missing };

		const hit = this.findDuplicate(input);
		if (hit) {
			await this.plane.comment(
				hit.issue.id,
				`查重命中（规则: ${hit.rule}）\n证据:\n${input.evidence}\n复现:\n${input.reproduction}`,
			);
			return { ok: true, id: hit.issue.id, deduped: true };
		}

		const area = this.config.getArea(input.area);
		const source = input.source ?? 'agent';
		const labels = [`source:${source}`, `area:${input.area}`];
		if (input.flowType) labels.push(`flow:${input.flowType}`);
		const issue = await this.plane.createIssue({
			title: input.title,
			description: `${input.reproduction}\n\nEvidence:\n${input.evidence}`,
			labels,
			project: area?.plane.project,
			state: input.state ?? '收件箱',
		});
		if (input.discoveredIn) {
			await this.plane.createRelation(issue.id, input.discoveredIn, '发现于');
		}
		this.index.push({
			id: issue.id,
			title: input.title,
			area: input.area,
			state: input.state ?? '收件箱',
			dedupeKey: input.dedupeKey,
			errorSignature: input.errorSignature,
			files: input.files,
		});
		return { ok: true, id: issue.id };
	}

	async accept(opts: { issueId: string; actor: string }) {
		await this.plane.updateIssueState(opts.issueId, '待做');
		return { state: '待做' as const, actor: opts.actor };
	}
}

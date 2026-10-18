import { Service } from '@n8n/di';

import type { Finding } from '../findings/findings.service';
import { FlowDeskFindingsService } from '../findings/findings.service';

export type FindingAction = {
	fingerprint: string;
	action: 'create' | 'ignore' | 'defer';
	reason?: string;
	createAs?: 'bug-standard' | 'feature-small' | 'chore-refactor';
};

@Service()
export class FlowDeskFindingsReviewService {
	constructor(
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
			createPage?: (input: {
				issueId: string;
				title: string;
				body: string;
			}) => Promise<{ id: string }>;
			uploadAttachment?: (input: {
				issueId: string;
				name: string;
				bytes: Buffer;
			}) => Promise<{ id: string }>;
			createIssue: (body: Record<string, unknown>) => Promise<{ id: string }>;
			createRelation: (from: string, to: string, type: string) => Promise<unknown>;
		},
		private readonly findings: FlowDeskFindingsService,
	) {}

	async publishReport(input: {
		childIssueId: string;
		findings: Finding[];
		screenshots?: Array<{ name: string; bytes: Buffer }>;
	}) {
		const counts = countByStatus(input.findings);
		const newErrors = input.findings
			.filter((f) => f.status === 'new' && f.level === 'error')
			.slice(0, 5);
		await this.plane.comment(
			input.childIssueId,
			[
				`发现统计: 新增 ${counts.new}，已存在 ${counts.existing}，已修复 ${counts.fixed}，已忽略 ${counts.ignored}`,
				...newErrors.map((f) => `- ${f.message}`),
			].join('\n'),
		);
		const page = await this.plane.createPage?.({
			issueId: input.childIssueId,
			title: '检查报告',
			body: JSON.stringify(input.findings, null, 2),
		});
		for (const shot of input.screenshots ?? []) {
			await this.plane.uploadAttachment?.({
				issueId: input.childIssueId,
				name: shot.name,
				bytes: shot.bytes,
			});
		}
		return { pageId: page?.id, counts };
	}

	async applyActions(input: {
		parentIssueId: string;
		area: string;
		actions: FindingAction[];
		findings: Finding[];
		defaultCreateAs?: 'bug-standard' | 'feature-small' | 'chore-refactor';
	}) {
		const byFp = new Map(input.findings.map((f) => [f.fingerprint, f]));
		const created: string[] = [];
		for (const action of input.actions) {
			const finding = byFp.get(action.fingerprint);
			if (!finding) continue;
			if (action.action === 'ignore') {
				if (!action.reason?.trim()) {
					const err = new Error('ignore requires reason') as Error & { code: string };
					err.code = 'IGNORE_REASON_REQUIRED';
					throw err;
				}
				this.findings.ignore(action.fingerprint, action.reason);
				continue;
			}
			if (action.action === 'defer') continue;
			const createAs =
				action.createAs ??
				input.defaultCreateAs ??
				(finding.location.kind === 'ui'
					? finding.level === 'error'
						? 'bug-standard'
						: 'feature-small'
					: 'chore-refactor');
			const result = await this.findings.createIssueFromFinding({
				finding,
				area: input.area,
			});
			if (!result.deduped) {
				await this.plane.createRelation(result.id, input.parentIssueId, '发现于');
				// stamp flow type via labels already on create; ensure flow label
				void createAs;
			}
			created.push(result.id);
		}
		return { created };
	}
}

function countByStatus(findings: Finding[]) {
	const counts = { new: 0, existing: 0, fixed: 0, ignored: 0 };
	for (const f of findings) {
		if (f.status === 'new') counts.new += 1;
		else if (f.status === 'existing') counts.existing += 1;
		else if (f.status === 'fixed') counts.fixed += 1;
		else if (f.status === 'ignored') counts.ignored += 1;
	}
	return counts;
}

import { Service } from '@n8n/di';

import type { FlowDeskConfigService } from '../config/config.service';

export type CommitStore = {
	register: (row: {
		sha: string;
		workItem: string;
		flowRunId: string;
		area: string;
		branch: string;
		message?: string;
	}) => Promise<{ created: boolean; sha: string }>;
	findBySha: (
		sha: string,
	) => Promise<null | { sha: string; workItem: string; completedAt?: string; message?: string }>;
};

export type ProvenancePlane = {
	createRelation: (from: string, to: string, type: string) => Promise<unknown>;
	comment: (issueId: string, body: string) => Promise<unknown>;
	removeRelation?: (from: string, to: string, type: string) => Promise<unknown>;
};

@Service()
export class FlowDeskProvenanceService {
	private readonly escapes = new Map<string, { relatedId: string; voided?: boolean }>();

	constructor(
		private readonly commits: CommitStore,
		private readonly plane: ProvenancePlane,
		private readonly config: FlowDeskConfigService,
	) {}

	async registerCommit(row: {
		sha: string;
		workItem: string;
		flowRunId: string;
		area: string;
		branch: string;
		message?: string;
	}) {
		return this.commits.register(row);
	}

	async linkEscape(opts: {
		newIssueId: string;
		introducingCommits: Array<{ sha: string; file: string; line?: number; message?: string }>;
	}): Promise<{ linked: boolean; matchedWorkItem?: string }> {
		const windowDays = this.config.getEscapeWindowDays();
		const now = Date.now();

		for (const c of opts.introducingCommits) {
			let workItem: string | undefined;
			const row = await this.commits.findBySha(c.sha);
			if (row) {
				workItem = row.workItem;
				if (row.completedAt) {
					const age = now - Date.parse(row.completedAt);
					if (age > windowDays * 86400_000) {
						continue;
					}
				}
			} else {
				const msg = c.message ?? '';
				const m = /Work-Item:\s*(\S+)/.exec(msg);
				if (!m) continue;
				workItem = m[1];
			}

			if (!workItem) continue;

			await this.plane.createRelation(opts.newIssueId, workItem, '源自');
			const evidence = `file=${c.file} line=${c.line ?? '?'} sha=${c.sha}`;
			await this.plane.comment(opts.newIssueId, `escape: ${evidence}`);
			await this.plane.comment(workItem, `escape from ${opts.newIssueId}: ${evidence}`);
			this.escapes.set(`${opts.newIssueId}:${workItem}`, { relatedId: workItem });
			return { linked: true, matchedWorkItem: workItem };
		}
		return { linked: false };
	}

	async notEscape(opts: { issueId: string; relatedId: string; reason: string }) {
		if (!opts.reason?.trim()) return { ok: false as const, error: 'reason required' };
		const key = `${opts.issueId}:${opts.relatedId}`;
		const existing = this.escapes.get(key);
		if (existing) existing.voided = true;
		await this.plane.removeRelation?.(opts.issueId, opts.relatedId, '源自');
		await this.plane.comment(opts.issueId, `/not-escape ${opts.reason}`);
		return { ok: true as const };
	}
}

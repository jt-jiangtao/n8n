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
};

@Service()
export class FlowDeskIntakeService {
	constructor(
		private readonly plane: IntakePlane,
		private readonly config: FlowDeskConfigService,
	) {}

	async submit(input: {
		title: string;
		reproduction: string;
		evidence: string;
		discoveredIn: string;
		area: string;
		files?: string[];
	}): Promise<{ ok: true; id: string } | { ok: false; missing: string[] }> {
		const missing: string[] = [];
		if (!input.reproduction?.trim()) missing.push('reproduction');
		if (!input.evidence?.trim()) missing.push('evidence');
		if (missing.length) return { ok: false, missing };

		const area = this.config.getArea(input.area);
		const issue = await this.plane.createIssue({
			title: input.title,
			description: `${input.reproduction}\n\nEvidence:\n${input.evidence}`,
			labels: ['source:agent', `area:${input.area}`],
			project: area?.plane.project,
			state: '收件箱',
		});
		await this.plane.createRelation(issue.id, input.discoveredIn, '发现于');
		return { ok: true, id: issue.id };
	}

	async accept(opts: { issueId: string; actor: string }) {
		await this.plane.updateIssueState(opts.issueId, '待做');
		return { state: '待做' as const, actor: opts.actor };
	}
}

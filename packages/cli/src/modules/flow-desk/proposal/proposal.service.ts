import { Service } from '@n8n/di';

@Service()
export class FlowDeskProposalService {
	constructor(
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
		},
	) {}

	async validate(input: {
		childIssueId: string;
		alternatives?: unknown[];
		risks?: unknown[];
	}): Promise<{ ok: boolean; missing?: string[] }> {
		const missing: string[] = [];
		if (!input.alternatives?.length) missing.push('替代方案');
		if (!input.risks?.length) missing.push('风险');
		if (missing.length) {
			await this.plane.comment(
				input.childIssueId,
				`方案缺少必填项: ${missing.join('、')}`,
			);
			return { ok: false, missing };
		}
		return { ok: true };
	}
}

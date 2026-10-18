import { Service } from '@n8n/di';

@Service()
export class FlowDeskRegressionProofService {
	constructor(
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
		},
		private readonly resume: {
			resume: (input: {
				executionId: string;
				nodeId: string;
				branch: string;
				data?: unknown;
			}) => Promise<{ ok: boolean }>;
		},
	) {}

	async applyResult(input: {
		executionId: string;
		nodeId: string;
		childIssueId: string;
		before?: { summary: string; ok: boolean };
		after?: { summary: string; ok: boolean };
		proofOk: boolean;
		reason?: string;
	}): Promise<{ branch: 'pass' | 'failure' }> {
		if (!input.before || !input.after) {
			await this.plane.comment(
				input.childIssueId,
				`回归证明不完整：缺少${ !input.before ? '修复前' : ''}${!input.before && !input.after ? '与' : ''}${!input.after ? '修复后' : ''}结果`,
			);
			await this.resume.resume({
				executionId: input.executionId,
				nodeId: input.nodeId,
				branch: 'failure',
			});
			return { branch: 'failure' };
		}

		await this.plane.comment(
			input.childIssueId,
			[
				'回归证明结果',
				`修复前: ${input.before.ok ? '通过' : '失败'}`,
				input.before.summary,
				`修复后: ${input.after.ok ? '通过' : '失败'}`,
				input.after.summary,
				input.proofOk ? '证明通过' : `证明失败: ${input.reason ?? ''}`,
			].join('\n'),
		);

		const branch = input.proofOk ? 'pass' : 'failure';
		await this.resume.resume({
			executionId: input.executionId,
			nodeId: input.nodeId,
			branch,
			data: { before: input.before, after: input.after },
		});
		return { branch };
	}
}

import { Service } from '@n8n/di';

const MAX_SWITCHES = 3;

@Service()
export class FlowDeskSwitchFlowService {
	private switchCounts = new Map<string, number>();

	constructor(
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
			updateIssueState: (id: string, state: string) => Promise<unknown>;
			updateIssueLabels: (id: string, labels: string[]) => Promise<unknown>;
			getIssue: (id: string) => Promise<{ id: string; stateName: string; labels: string[] }>;
		},
		private readonly resume: {
			resume: (input: {
				executionId: string;
				nodeId: string;
				branch: string;
				data?: unknown;
			}) => Promise<{ ok: boolean }>;
		},
		private readonly registry: {
			findActiveByFlowType: (flowType: string) => Promise<{ id: string; flowType: string } | null>;
		},
		private readonly runs: {
			startOnIssue: (input: {
				issueId: string;
				flowType: string;
			}) => Promise<{ executionId: string }>;
			markConverted: (executionId: string) => Promise<void>;
			markSkippedRemaining: (executionId: string) => Promise<void>;
		},
	) {}

	async switch(input: {
		parentIssueId: string;
		executionId: string;
		nodeId: string;
		targetFlowType: string;
		childIssueId: string;
	}): Promise<{ ok: boolean; error?: string }> {
		const count = this.switchCounts.get(input.parentIssueId) ?? 0;
		if (count >= MAX_SWITCHES) {
			await this.plane.updateIssueState(input.parentIssueId, '失败');
			await this.plane.comment(
				input.childIssueId,
				`Switch Flow 超过上限（${MAX_SWITCHES}），拒绝第 ${count + 1} 次转换`,
			);
			return { ok: false, error: 'switch-limit' };
		}

		const target = await this.registry.findActiveByFlowType(input.targetFlowType);
		if (!target) {
			await this.plane.comment(input.childIssueId, `目标流程类型不存在: ${input.targetFlowType}`);
			await this.resume.resume({
				executionId: input.executionId,
				nodeId: input.nodeId,
				branch: 'failure',
			});
			return { ok: false, error: 'missing-flow-type' };
		}

		const issue = await this.plane.getIssue(input.parentIssueId);
		const labels = (issue.labels ?? []).filter((l) => !l.startsWith('flow:'));
		labels.push(`flow:${input.targetFlowType}`);
		await this.plane.updateIssueLabels(input.parentIssueId, labels);
		await this.runs.markConverted(input.executionId);
		await this.runs.markSkippedRemaining(input.executionId);
		await this.runs.startOnIssue({
			issueId: input.parentIssueId,
			flowType: input.targetFlowType,
		});
		this.switchCounts.set(input.parentIssueId, count + 1);
		await this.resume.resume({
			executionId: input.executionId,
			nodeId: input.nodeId,
			branch: 'converted',
		});
		return { ok: true };
	}
}

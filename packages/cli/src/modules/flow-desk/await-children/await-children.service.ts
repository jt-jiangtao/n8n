import { Service } from '@n8n/di';

type WaitReg = {
	executionId: string;
	nodeId: string;
	childIssueId: string;
	relatedIds: string[];
};

@Service()
export class FlowDeskAwaitChildrenService {
	private waits = new Map<string, WaitReg>();

	constructor(
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
			getIssue: (id: string) => Promise<{ id: string; stateName: string }>;
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

	registerWait(reg: WaitReg) {
		this.waits.set(`${reg.executionId}:${reg.nodeId}`, reg);
	}

	async evaluate(input: {
		executionId: string;
		nodeId: string;
		childIssueId: string;
		related: Array<{ id: string; state: string }>;
	}) {
		if (input.related.length === 0) {
			await this.plane.comment(input.childIssueId, '没有关联工单');
			await this.resume.resume({
				executionId: input.executionId,
				nodeId: input.nodeId,
				branch: 'has-failure',
				data: { reason: 'no-children' },
			});
			return { branch: 'has-failure' as const, failedIds: [] as string[] };
		}

		const failedIds = input.related
			.filter((r) => r.state === '失败' || r.state === '已取消')
			.map((r) => r.id);
		if (failedIds.length) {
			await this.plane.comment(input.childIssueId, `有失败: ${failedIds.join(', ')}`);
			await this.resume.resume({
				executionId: input.executionId,
				nodeId: input.nodeId,
				branch: 'has-failure',
				data: { failedIds },
			});
			return { branch: 'has-failure' as const, failedIds };
		}

		const allDone = input.related.every((r) => r.state === '完成');
		if (!allDone) {
			this.registerWait({
				executionId: input.executionId,
				nodeId: input.nodeId,
				childIssueId: input.childIssueId,
				relatedIds: input.related.map((r) => r.id),
			});
			return { branch: 'waiting' as const, failedIds: [] as string[] };
		}

		await this.resume.resume({
			executionId: input.executionId,
			nodeId: input.nodeId,
			branch: 'all-done',
		});
		return { branch: 'all-done' as const, failedIds: [] as string[] };
	}

	async onRelatedStateChange(opts: { relatedId: string }) {
		for (const [key, wait] of this.waits) {
			if (!wait.relatedIds.includes(opts.relatedId)) continue;
			const related = [];
			for (const id of wait.relatedIds) {
				const issue = await this.plane.getIssue(id);
				related.push({ id, state: issue.stateName });
			}
			const result = await this.evaluate({ ...wait, related });
			if (result.branch !== 'waiting') {
				this.waits.delete(key);
				return { resumed: true, branch: result.branch };
			}
		}
		return { resumed: false };
	}

	async reconcile() {
		let resumed = 0;
		for (const wait of [...this.waits.values()]) {
			const related = [];
			for (const id of wait.relatedIds) {
				const issue = await this.plane.getIssue(id);
				related.push({ id, state: issue.stateName });
			}
			const result = await this.evaluate({ ...wait, related });
			if (result.branch !== 'waiting') resumed += 1;
		}
		return { resumed };
	}
}

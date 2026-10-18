import { Service } from '@n8n/di';

type Created = {
	id: string;
	state: string;
	executionId: string;
	relation: string;
	parentIssueId: string;
};

@Service()
export class FlowDeskRelatedIssuesService {
	private created: Created[] = [];

	constructor(
		private readonly plane: {
			createIssue: (body: Record<string, unknown>) => Promise<{ id: string }>;
			updateIssueState: (id: string, state: string) => Promise<unknown>;
			getIssue?: (id: string) => Promise<{ id: string; stateName: string }>;
		},
	) {}

	async create(input: {
		parentIssueId: string;
		title: string;
		flowType: string;
		area: string;
		relation: string;
		autoStart?: boolean;
		executionId?: string;
	}) {
		const created = await this.plane.createIssue({
			name: input.title,
			parent: input.parentIssueId,
			labels: [`flow:${input.flowType}`, `area:${input.area}`],
			relation: input.relation,
		});
		if (input.autoStart) {
			await this.plane.updateIssueState(created.id, '待做');
		}
		this.created.push({
			id: created.id,
			state: input.autoStart ? '待做' : '收件箱',
			executionId: input.executionId ?? '',
			relation: input.relation,
			parentIssueId: input.parentIssueId,
		});
		return created;
	}

	async listCreated(input: { executionId: string; relationType: string }) {
		const rows = this.created.filter(
			(c) => c.executionId === input.executionId && c.relation === input.relationType,
		);
		const out: Array<{ id: string; state: string }> = [];
		for (const row of rows) {
			if (this.plane.getIssue) {
				const issue = await this.plane.getIssue(row.id);
				out.push({ id: row.id, state: issue.stateName });
			} else {
				out.push({ id: row.id, state: row.state });
			}
		}
		return out;
	}
}

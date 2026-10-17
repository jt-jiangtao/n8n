import { Service } from '@n8n/di';

@Service()
export class FlowDeskRelatedIssuesService {
	constructor(
		private readonly plane: {
			createIssue: (body: Record<string, unknown>) => Promise<{ id: string }>;
			updateIssueState: (id: string, state: string) => Promise<unknown>;
		},
	) {}

	async create(input: {
		parentIssueId: string;
		title: string;
		flowType: string;
		area: string;
		relation: string;
		autoStart?: boolean;
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
		return created;
	}
}

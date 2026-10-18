const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

type Ctx = {
	getNodeParameter: (name: string) => unknown;
	getNode: () => { id: string; name: string; type: string };
	getExecutionId: () => string;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	flowDesk?: {
		awaitChildren: {
			evaluate: (input: Record<string, unknown>) => Promise<{
				branch: string;
				failedIds?: string[];
			}>;
			registerWait: (reg: Record<string, unknown>) => void;
		};
		related: {
			listCreated: (input: {
				executionId: string;
				relationType: string;
			}) => Promise<Array<{ id: string; state: string }>>;
		};
	};
	flowDeskResume?: { branch: string; data?: Record<string, unknown> };
	putExecutionToWait: (until: Date) => Promise<void>;
};

export class FlowDeskAwaitChildren {
	description = {
		displayName: 'Flow Desk Await Children',
		name: 'flowDeskAwaitChildren',
		group: ['transform'],
		version: 1,
		description: 'Wait until related child issues finish',
		defaults: { name: 'Await Children' },
		inputs: ['main'],
		outputs: ['main', 'main'],
		outputNames: ['all-done', 'has-failure'],
		properties: [
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				required: true,
			},
			{
				displayName: 'Relation Type',
				name: 'relationType',
				type: 'string',
				default: '跟进',
			},
		],
	};

	async execute(this: Ctx) {
		if (this.flowDeskResume) {
			const item = {
				json: { branch: this.flowDeskResume.branch, ...(this.flowDeskResume.data || {}) },
			};
			if (this.flowDeskResume.branch === 'has-failure') return [[], [item]];
			return [[item], []];
		}

		const api = this.flowDesk;
		if (!api) throw new Error('flowDesk API missing');

		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		const relationType = String(this.getNodeParameter('relationType') || '跟进');
		const related = await api.related.listCreated({
			executionId: this.getExecutionId(),
			relationType,
		});

		const result = await api.awaitChildren.evaluate({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			childIssueId: String(input.workItem ?? input.childIssueId ?? ''),
			related,
		});

		if (result.branch === 'waiting') {
			await this.putExecutionToWait(WAIT_INDEFINITELY);
			return undefined;
		}

		const item = { json: { ...input, branch: result.branch, failedIds: result.failedIds } };
		if (result.branch === 'has-failure') return [[], [item]];
		return [[item], []];
	}
}

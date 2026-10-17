const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z')

type Ctx = {
	getNodeParameter: (name: string) => unknown;
	getNode: () => { id: string; name: string; type: string };
	getExecutionId: () => string;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	flowDesk?: {
		steps: { register: (body: Record<string, unknown>) => Promise<{ attempt: number }> };
	};
	flowDeskResume?: { branch: string; data?: Record<string, unknown> };
	putExecutionToWait: (until: Date) => Promise<void>;
};

export class FlowDeskHumanStep {
	description = {
		displayName: 'Flow Desk Human Step',
		name: 'flowDeskHumanStep',
		group: ['transform'],
		version: 1,
		description: 'Wait for a human decision',
		defaults: { name: 'Human Step' },
		inputs: ['main'],
		outputs: ['main'],
		properties: [],
	};

	async execute(this: Ctx) {
		if (this.flowDeskResume) {
			return [[{ json: { branch: this.flowDeskResume.branch, ...(this.flowDeskResume.data || {}) } }]];
		}
		const api = this.flowDesk;
		if (!api) throw new Error('flowDesk API missing');
		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskHumanStep',
			workItem: input.workItem,
			flowRunId: input.flowRunId,
			kind: 'human',
			title: this.getNodeParameter('title'),
			assigneeRole: this.getNodeParameter('assigneeRole'),
		});
		await this.putExecutionToWait(WAIT_INDEFINITELY);
		return undefined;
	}
}

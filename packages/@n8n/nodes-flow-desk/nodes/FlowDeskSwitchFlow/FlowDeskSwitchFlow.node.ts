type Ctx = {
	getNodeParameter: (name: string) => unknown;
	getNode: () => { id: string; name: string; type: string };
	getExecutionId: () => string;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	flowDesk?: {
		switchFlow: {
			switch: (input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
		};
	};
	flowDeskResume?: { branch: string; data?: Record<string, unknown> };
};

export class FlowDeskSwitchFlow {
	description = {
		displayName: 'Flow Desk Switch Flow',
		name: 'flowDeskSwitchFlow',
		group: ['transform'],
		version: 1,
		description: 'Convert parent issue to another flow type',
		defaults: { name: 'Switch Flow' },
		inputs: ['main'],
		outputs: ['main', 'main'],
		outputNames: ['converted', 'failure'],
		properties: [
			{
				displayName: 'Target Flow Type',
				name: 'targetFlowType',
				type: 'string',
				default: '',
				required: true,
			},
			{
				displayName: 'Reason',
				name: 'reason',
				type: 'string',
				default: '',
				required: true,
			},
		],
	};

	async execute(this: Ctx) {
		if (this.flowDeskResume) {
			const item = {
				json: { branch: this.flowDeskResume.branch, ...(this.flowDeskResume.data || {}) },
			};
			if (this.flowDeskResume.branch === 'failure') return [[], [item]];
			return [[item], []];
		}

		const api = this.flowDesk;
		if (!api) throw new Error('flowDesk API missing');

		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		const result = await api.switchFlow.switch({
			parentIssueId: String(input.parentIssueId ?? input.workItem ?? ''),
			executionId: this.getExecutionId(),
			nodeId: node.id,
			targetFlowType: this.getNodeParameter('targetFlowType'),
			reason: this.getNodeParameter('reason'),
			childIssueId: String(input.childIssueId ?? input.workItem ?? ''),
		});

		const item = { json: { ...input, branch: result.ok ? 'converted' : 'failure', error: result.error } };
		if (!result.ok) return [[], [item]];
		return [[item], []];
	}
}

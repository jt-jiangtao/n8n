type Ctx = {
	getNodeParameter: (name: string) => unknown
	getNode: () => { id: string }
	getInputData: () => Array<{ json: Record<string, unknown> }>
	flowDesk?: {
		related: { create: (body: Record<string, unknown>) => Promise<{ id: string }> }
	}
}

export class FlowDeskCreateWorkItem {
	description = {
		displayName: 'Flow Desk Create Work Item',
		name: 'flowDeskCreateWorkItem',
		group: ['transform'],
		version: 1,
		inputs: ['main'],
		outputs: ['main'],
		properties: [],
	}

	async execute(this: Ctx) {
		const input = this.getInputData()[0]?.json ?? {}
		const created = await this.flowDesk!.related.create({
			parentIssueId: input.workItem,
			title: this.getNodeParameter('title'),
			flowType: this.getNodeParameter('flowType'),
			relation: this.getNodeParameter('relation'),
			area: input.area,
		})
		return [[{ json: { ...input, createdIssueId: created.id } }]]
	}
}

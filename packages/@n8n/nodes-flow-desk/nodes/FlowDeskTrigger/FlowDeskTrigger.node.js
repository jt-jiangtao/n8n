'use strict';

class FlowDeskTrigger {
	constructor() {
		this.description = {
			displayName: 'Flow Desk Trigger',
			name: 'flowDeskTrigger',
			group: ['trigger'],
			version: 1,
			description: 'Entry trigger for a Flow Desk typed flow',
			defaults: { name: 'Flow Desk Trigger' },
			inputs: [],
			outputs: ['main'],
			properties: [
				{
					displayName: 'Flow Type',
					name: 'flowType',
					type: 'string',
					default: 'skeleton',
					required: true,
				},
			],
		};
	}

	async execute() {
		const flowType = this.getNodeParameter('flowType', 0);
		const items = this.getInputData?.() ?? [{ json: {} }];
		return [items.map((item) => ({ json: { ...item.json, flowType } }))];
	}
}

module.exports = { FlowDeskTrigger };

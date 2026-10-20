'use strict';

const { getFlowDeskApi } = require('../shared/stepBase');

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
		const current = this.getInputData?.()?.[0]?.json ?? {};
		let json = { ...current, flowType };
		if (!json.repo) {
			const started = await getFlowDeskApi(this).steps.manualStart?.(flowType);
			if (started) json = { ...started, flowType };
		}
		return [[{ json }]];
	}
}

module.exports = { FlowDeskTrigger };

const Source = module.exports.FlowDeskTrigger;
module.exports.FlowDeskTrigger = class extends Source { constructor() { super(); this.description.defaults ??= { name: this.description.displayName }; this.description.description ??= this.description.displayName; } };

'use strict';

/**
 * Placeholder node so the Flow Desk nodes package can be loaded.
 * Real Flow Desk step nodes land in later milestones.
 */
class FlowDeskPlaceholder {
	constructor() {
		this.description = {
			displayName: 'Flow Desk Placeholder',
			name: 'flowDeskPlaceholder',
			group: ['transform'],
			version: 1,
			description: 'Flow Desk nodes package shell (no-op)',
			defaults: {
				name: 'Flow Desk Placeholder',
			},
			inputs: ['main'],
			outputs: ['main'],
			properties: [
				{
					displayName: 'Notice',
					name: 'notice',
					type: 'notice',
					default: '',
					description: 'This package is a foundation shell. Real nodes arrive in later milestones.',
				},
			],
		};
	}

	async execute() {
		const items = this.getInputData();
		return [items];
	}
}

module.exports = { FlowDeskPlaceholder };

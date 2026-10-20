'use strict';

class FlowDeskEndCheck {
	constructor() {
		this.description = {
			displayName: 'Flow Desk End Check',
			name: 'flowDeskEndCheck',
			group: ['transform'],
			version: 1,
			description: 'Stop when the reply is only the end marker',
			defaults: { name: 'End Check' },
			inputs: ['main'],
			outputs: ['main', 'main'],
			outputNames: ['全部扫完', '继续扫描'],
			properties: [
				{ displayName: 'End Marker', name: 'endMarker', type: 'string', default: '<promise>COMPLETE</promise>' },
			],
		};
	}

	async execute() {
		const marker = String(this.getNodeParameter('endMarker') || '').trim();
		const input = this.getInputData()[0]?.json ?? {};
		const summary = String(input.summary ?? '').trim();
		const item = { json: input };
		if (marker && summary === marker) {
			if (Array.isArray(input.newIssues) && input.newIssues.length) throw new Error('End marker must not contain findings');
			return [[item], []];
		}
		return [[], [item]];
	}
}

module.exports = { FlowDeskEndCheck };

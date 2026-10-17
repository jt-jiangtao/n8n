'use strict';

const { getFlowDeskApi, readResume, putWait } = require('../shared/stepBase');

class FlowDeskHumanStep {
	constructor() {
		this.description = {
			displayName: 'Flow Desk Human Step',
			name: 'flowDeskHumanStep',
			group: ['transform'],
			version: 1,
			description: 'Wait for a human decision',
			defaults: { name: 'Human Step' },
			inputs: ['main'],
			outputs: ['main'],
			properties: [
				{ displayName: 'Title', name: 'title', type: 'string', default: '' },
				{
					displayName: 'Assignee Role',
					name: 'assigneeRole',
					type: 'string',
					default: 'area.planApprover',
				},
				{
					displayName: 'Options',
					name: 'options',
					type: 'fixedCollection',
					typeOptions: { multipleValues: true },
					default: {},
					options: [
						{
							name: 'option',
							displayName: 'Option',
							values: [
								{ displayName: 'Name', name: 'name', type: 'string', default: 'approve' },
								{ displayName: 'Label', name: 'label', type: 'string', default: '通过' },
							],
						},
					],
				},
			],
		};
	}

	async execute() {
		const resume = readResume(this);
		if (resume) {
			return [[{ json: { branch: resume.branch, ...(resume.data || {}) } }]];
		}

		const title = this.getNodeParameter('title');
		const assigneeRole = this.getNodeParameter('assigneeRole');
		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		const api = getFlowDeskApi(this);
		await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskHumanStep',
			workItem: input.workItem,
			flowRunId: input.flowRunId,
			kind: 'human',
			title,
			assigneeRole,
		});
		await putWait(this);
		return undefined;
	}
}

module.exports = { FlowDeskHumanStep };

'use strict';

const { getFlowDeskApi, readResume, putWait } = require('../shared/stepBase');

class FlowDeskAgentStep {
	constructor() {
		this.description = {
			displayName: 'Flow Desk Agent Step',
			name: 'flowDeskAgentStep',
			group: ['transform'],
			version: 1,
			description: 'Dispatch an Agent task and wait for the result',
			defaults: { name: 'Agent Step' },
			inputs: ['main'],
			outputs: ['main', 'main'],
			outputNames: ['success', 'failure'],
			properties: [
				{ displayName: 'Title', name: 'title', type: 'string', default: '' },
				{ displayName: 'Step', name: 'step', type: 'string', default: 'implement' },
				{ displayName: 'Instructions', name: 'instructions', type: 'string', default: '' },
				{
					displayName: 'Required Fields',
					name: 'requiredFields',
					type: 'fixedCollection',
					typeOptions: { multipleValues: true },
					default: {},
					options: [
						{
							name: 'field',
							displayName: 'Field',
							values: [{ displayName: 'Name', name: 'name', type: 'string', default: '' }],
						},
					],
				},
			],
		};
	}

	async execute() {
		const resume = readResume(this);
		if (resume) {
			const item = { json: { branch: resume.branch, ...(resume.data || {}) } };
			if (resume.branch === 'failure') {
				return [[], [item]];
			}
			return [[item], []];
		}

		const title = this.getNodeParameter('title');
		const step = this.getNodeParameter('step');
		const instructions = this.getNodeParameter('instructions');
		const requiredFieldsRaw = this.getNodeParameter('requiredFields');
		const requiredFields = Array.isArray(requiredFieldsRaw)
			? requiredFieldsRaw
			: requiredFieldsRaw?.field?.map((f) => f.name).filter(Boolean) ?? [];
		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		const api = getFlowDeskApi(this);

		const registered = await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskAgentStep',
			workItem: input.workItem,
			flowRunId: input.flowRunId,
			kind: 'agent',
			title,
			step,
			instructions,
			requiredFields,
			repo: input.repo,
			area: input.area,
			baseRef: input.baseRef,
			acceptance: input.acceptance ?? '',
		});

		if (api.tasks?.dispatch && registered.taskId) {
			await api.tasks.dispatch({
				taskId: registered.taskId,
				workItem: input.workItem,
				step,
				attempt: registered.attempt,
				repo: input.repo,
				area: input.area,
				baseRef: input.baseRef,
				instructions,
				acceptance: input.acceptance ?? '',
				flowRunId: input.flowRunId,
				requiredFields,
			});
		}

		await putWait(this);
		return undefined;
	}
}

module.exports = { FlowDeskAgentStep };

const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z')

type Ctx = {
	getNodeParameter: (name: string) => unknown;
	getNode: () => { id: string; name: string; type: string };
	getExecutionId: () => string;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	flowDesk?: {
		steps: {
			register: (
				body: Record<string, unknown>,
			) => Promise<{ attempt: number; taskId?: string }>;
		};
		tasks: { dispatch: (body: Record<string, unknown>) => Promise<void> };
	};
	flowDeskResume?: { branch: string; data?: Record<string, unknown> };
	putExecutionToWait: (until: Date) => Promise<void>;
};

export class FlowDeskAgentStep {
	description = {
		displayName: 'Flow Desk Agent Step',
		name: 'flowDeskAgentStep',
		group: ['transform'],
		version: 1,
		description: 'Dispatch an Agent task and wait for the result',
		defaults: { name: 'Agent Step' },
		inputs: ['main'],
		outputs: ['main', 'main'],
		outputNames: ['success', 'failure'],
		properties: [],
	};

	async execute(this: Ctx) {
		if (this.flowDeskResume) {
			const item = {
				json: { branch: this.flowDeskResume.branch, ...(this.flowDeskResume.data || {}) },
			};
			if (this.flowDeskResume.branch === 'failure') {
				return [[], [item]];
			}
			return [[item], []];
		}
		const api = this.flowDesk;
		if (!api) throw new Error('flowDesk API missing');
		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		const registered = await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskAgentStep',
			workItem: input.workItem,
			flowRunId: input.flowRunId,
			kind: 'agent',
			title: this.getNodeParameter('title'),
			step: this.getNodeParameter('step'),
			instructions: this.getNodeParameter('instructions'),
			requiredFields: this.getNodeParameter('requiredFields'),
			repo: input.repo,
			area: input.area,
			baseRef: input.baseRef,
		});
		if (registered.taskId) {
			await api.tasks.dispatch({
				taskId: registered.taskId,
				workItem: input.workItem,
				step: this.getNodeParameter('step'),
				attempt: registered.attempt,
				repo: input.repo,
				area: input.area,
				baseRef: input.baseRef,
				instructions: this.getNodeParameter('instructions'),
				flowRunId: input.flowRunId,
				requiredFields: this.getNodeParameter('requiredFields'),
			});
		}
		await this.putExecutionToWait(WAIT_INDEFINITELY);
		return undefined;
	}
}

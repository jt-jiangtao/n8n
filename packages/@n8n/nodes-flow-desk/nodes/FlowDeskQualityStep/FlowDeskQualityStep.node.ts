const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

type Ctx = {
	getNodeParameter: (name: string) => unknown;
	getNode: () => { id: string; name: string; type: string };
	getExecutionId: () => string;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	flowDesk?: {
		steps: { register: (body: Record<string, unknown>) => Promise<{ attempt: number; taskId?: string }> };
		tasks: { dispatch: (body: Record<string, unknown>) => Promise<void> };
	};
	flowDeskResume?: { branch: string; data?: Record<string, unknown> };
	putExecutionToWait: (until: Date) => Promise<void>;
};

export class FlowDeskQualityStep {
	description = {
		displayName: 'Flow Desk Quality Step',
		name: 'flowDeskQualityStep',
		group: ['transform'],
		version: 1,
		description: 'Run code quality analysis',
		defaults: { name: 'Quality Check' },
		inputs: ['main'],
		outputs: ['main', 'main', 'main', 'main'],
		outputNames: ['pass', 'new-errors', 'cannot-run', 'maxAttempts'],
		properties: [
			{ displayName: 'Title', name: 'title', type: 'string', default: '' },
			{ displayName: 'Scope', name: 'scope', type: 'string', default: 'changed' },
			{ displayName: 'Max Attempts', name: 'maxAttempts', type: 'number', default: 2 },
		],
	};

	async execute(this: Ctx) {
		if (this.flowDeskResume) {
			const item = {
				json: { branch: this.flowDeskResume.branch, ...(this.flowDeskResume.data || {}) },
			};
			const b = this.flowDeskResume.branch;
			if (b === 'new-errors') return [[], [item], [], []];
			if (b === 'cannot-run') return [[], [], [item], []];
			if (b === 'maxAttempts') return [[], [], [], [item]];
			return [[item], [], [], []];
		}
		const api = this.flowDesk;
		if (!api) throw new Error('flowDesk API missing');
		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		const registered = await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskQualityStep',
			kind: 'quality',
			title: this.getNodeParameter('title'),
			scope: this.getNodeParameter('scope'),
			workItem: input.workItem,
			flowRunId: input.flowRunId,
		});
		if (registered.taskId) {
			await api.tasks.dispatch({
				taskId: registered.taskId,
				kind: 'quality',
				workItem: input.workItem,
				area: input.area,
				attempt: registered.attempt,
			});
		}
		await this.putExecutionToWait(WAIT_INDEFINITELY);
		return undefined;
	}
}

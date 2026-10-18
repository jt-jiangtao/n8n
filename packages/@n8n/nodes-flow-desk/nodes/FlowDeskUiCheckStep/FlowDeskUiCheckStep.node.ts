const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

type Ctx = {
	getNodeParameter: (name: string) => unknown;
	getNode: () => { id: string; name: string; type: string };
	getExecutionId: () => string;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	flowDesk?: {
		steps: { register: (body: Record<string, unknown>) => Promise<{ attempt: number; taskId?: string }> };
		tasks: { dispatch: (body: Record<string, unknown>) => Promise<void> };
		getKillSwitch?: () => boolean;
	};
	flowDeskResume?: { branch: string; data?: Record<string, unknown> };
	putExecutionToWait: (until: Date) => Promise<void>;
};

export class FlowDeskUiCheckStep {
	description = {
		displayName: 'Flow Desk UI Check Step',
		name: 'flowDeskUiCheckStep',
		group: ['transform'],
		version: 1,
		description: 'Run UI checks on managed project pages',
		defaults: { name: 'UI Check' },
		inputs: ['main'],
		outputs: ['main', 'main', 'main', 'main'],
		outputNames: ['pass', 'new-errors', 'cannot-run', 'maxAttempts'],
		properties: [
			{ displayName: 'Title', name: 'title', type: 'string', default: '' },
			{ displayName: 'Scope', name: 'scope', type: 'string', default: 'changed' },
			{
				displayName: 'Fail On Visual Change',
				name: 'failOnVisualChange',
				type: 'boolean',
				default: false,
			},
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
		if (api.getKillSwitch?.()) {
			throw new Error('kill switch on');
		}
		const node = this.getNode();
		const input = this.getInputData()[0]?.json ?? {};
		const registered = await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskUiCheckStep',
			kind: 'ui-check',
			title: this.getNodeParameter('title'),
			scope: this.getNodeParameter('scope'),
			failOnVisualChange: this.getNodeParameter('failOnVisualChange'),
			maxAttempts: this.getNodeParameter('maxAttempts'),
			workItem: input.workItem,
			flowRunId: input.flowRunId,
		});
		if (registered.taskId) {
			await api.tasks.dispatch({
				taskId: registered.taskId,
				kind: 'ui-check',
				workItem: input.workItem,
				area: input.area,
				attempt: registered.attempt,
				failOnVisualChange: this.getNodeParameter('failOnVisualChange'),
			});
		}
		await this.putExecutionToWait(WAIT_INDEFINITELY);
		return undefined;
	}
}

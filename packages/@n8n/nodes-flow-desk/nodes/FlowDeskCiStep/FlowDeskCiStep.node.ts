const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z')

type Ctx = {
	getNodeParameter: (name: string) => unknown
	getNode: () => { id: string; name: string; type: string }
	getExecutionId: () => string
	getInputData: () => Array<{ json: Record<string, unknown> }>
	flowDesk?: {
		steps: { register: (body: Record<string, unknown>) => Promise<{ attempt: number; taskId?: string }> }
		tasks: { dispatch: (body: Record<string, unknown>) => Promise<void> }
	}
	flowDeskResume?: { branch: string; data?: Record<string, unknown> }
	putExecutionToWait: (until: Date) => Promise<void>
}

export class FlowDeskCiStep {
	description = {
		displayName: 'Flow Desk CI Step',
		name: 'flowDeskCiStep',
		group: ['transform'],
		version: 1,
		inputs: ['main'],
		outputs: ['main', 'main', 'main'],
		outputNames: ['pass', 'failure', 'maxAttempts'],
		properties: [
			{ displayName: 'Title', name: 'title', type: 'string', default: '' },
			{ displayName: 'Suite', name: 'suite', type: 'string', default: 'targeted' },
			{ displayName: 'Repeat', name: 'repeat', type: 'string', default: '' },
			{ displayName: 'Compare With Base', name: 'compareWithBase', type: 'boolean', default: false },
		],
	}

	async execute(this: Ctx) {
		if (this.flowDeskResume) {
			const item = { json: { branch: this.flowDeskResume.branch, ...(this.flowDeskResume.data || {}) } }
			if (this.flowDeskResume.branch === 'failure') return [[], [item], []]
			if (this.flowDeskResume.branch === 'maxAttempts') return [[], [], [item]]
			return [[item], [], []]
		}
		const api = this.flowDesk
		if (!api) throw new Error('flowDesk API missing')
		const node = this.getNode()
		const input = this.getInputData()[0]?.json ?? {}
		const registered = await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskCiStep',
			kind: 'ci',
			suite: this.getNodeParameter('suite'),
			repeat: this.getNodeParameter('repeat'),
			compareWithBase: this.getNodeParameter('compareWithBase'),
			workItem: input.workItem,
			flowRunId: input.flowRunId,
		})
		if (registered.taskId) {
			await api.tasks.dispatch({
				taskId: registered.taskId,
				kind: 'ci',
				workItem: input.workItem,
				area: input.area,
				attempt: registered.attempt,
			})
		}
		await this.putExecutionToWait(WAIT_INDEFINITELY)
		return undefined
	}
}

const { getFlowDeskApi } = require('../shared/stepBase')
const { roundCap, settleAgentRound, withRalphBrief } = require('../shared/ralph-round')

const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z')

type Ctx = {
	getNodeParameter: (name: string, fallback?: unknown) => unknown;
	getNode: () => { id: string; name: string; type: string };
	getExecutionId: () => string;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	flowDesk?: {
		steps: {
			register: (
				body: Record<string, unknown>,
			) => Promise<{ attempt: number; taskId?: string }>;
			savedResult?: (
				executionId: string,
				nodeId: string,
			) => Promise<{ branch: string; data?: Record<string, unknown> } | null>;
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
		outputs: ['main', 'main', 'main'],
		outputNames: ['success', 'failure', 'exceeded'],
		properties: [
			{ displayName: 'Title', name: 'title', type: 'string', default: '' },
			{ displayName: 'Step', name: 'step', type: 'string', default: '' },
			{ displayName: 'Prompt', name: 'promptId', type: 'string', default: '' },
			{ displayName: 'Writes', name: 'writes', type: 'boolean', default: true },
			{ displayName: 'Instructions', name: 'instructions', type: 'string', default: '' },
			{ displayName: 'End Marker', name: 'endMarker', type: 'string', default: '' },
			{ displayName: 'Max Attempts', name: 'maxAttempts', type: 'number', default: 3 },
			{
				displayName: 'Adapter',
				name: 'adapter',
				type: 'options',
				default: '',
				options: [
					{ name: 'From flow start', value: '' },
					{ name: 'Codex CLI', value: 'codex' },
						{ name: 'Cursor', value: 'cursor' },
				],
			},
			{ displayName: 'Model', name: 'model', type: 'string', default: 'auto' },
		],
	};

	async execute(this: Ctx) {
		const marker = String(this.getNodeParameter('endMarker', '') ?? '');
		const loop = { maxRounds: roundCap(this.getNodeParameter('maxAttempts', 3)), marker };
		const input = this.getInputData()[0]?.json ?? {};
		if (marker && this.flowDeskResume) {
			throwRunnerError(this.flowDeskResume);
			return roundOutputs(this.flowDeskResume, input);
		}
		if (this.flowDeskResume && !marker) {
			const settled = settleAgentRound(this.flowDeskResume, loop);
			if (settled.action === 'stop') return settled.outputs;
		}
		const api = this.flowDesk ?? getFlowDeskApi(this);
		const node = this.getNode();
		const saved = await api.steps.savedResult?.(this.getExecutionId(), node.id);
		if (saved?.branch && marker && Number(saved.data?.attempt ?? 1) > Number(input.attempt ?? 0)) {
			throwRunnerError(saved);
			return roundOutputs(saved, input);
		}
		if (saved?.branch && !marker) {
			const settled = settleAgentRound(saved, loop);
			if (settled.action === 'stop') return settled.outputs;
		}
		if (loop.maxRounds < 1) {
			return [[], [], [{ json: { branch: 'exceeded' } }]];
		}
		if (marker && Number(input.attempt) >= loop.maxRounds) {
			throw new Error('扫描达到轮数上限，尚未全部完成');
		}
		const configured = (node as { parameters?: { adapter?: string } }).parameters?.adapter;
		const started = input.model;
		const picked = configured === 'cursor' || configured === 'codex' ? configured : started;
		const adapter = picked === 'cursor' || picked === 'codex' ? picked : '';
		const model = String(this.getNodeParameter('model') || (node as { parameters?: { model?: string } }).parameters?.model || '').trim() || 'auto';
		const requiredFields = this.getNodeParameter('requiredFields', []);
		const finished = Number(input.attempt ?? this.flowDeskResume?.data?.attempt ?? (marker ? 0 : saved?.data?.attempt) ?? 0);
		const round = (Number.isFinite(finished) ? finished : 0) + 1;
		const instructions = withRalphBrief(this.getNodeParameter('instructions', ''), round, loop.maxRounds, marker);
		const registered = await api.steps.register({
			executionId: this.getExecutionId(),
			nodeId: node.id,
			nodeType: 'flowDeskAgentStep',
			workItem: input.workItem,
			flowRunId: input.flowRunId,
			kind: 'agent',
			attempt: round,
			title: this.getNodeParameter('title', ''),
			step: this.getNodeParameter('step', ''),
			instructions,
			promptId: this.getNodeParameter('promptId', ''),
			requiredFields,
			repo: input.repo,
			area: input.area,
			baseRef: input.baseRef,
			writes: this.getNodeParameter('writes', true),
			adapter,
			model,
			sessionId: String(input.workItem ?? '') || `${this.getExecutionId()}:${node.id}`,
			resume: Number(input.attempt) >= 1,
			maxAttempts: loop.maxRounds,
			endMarker: marker,
		});
		if (!registered.taskId) throw new Error('Agent task was not accepted');
		if (registered.taskId) {
			await api.tasks.dispatch({
				taskId: registered.taskId,
				workItem: input.workItem,
				step: this.getNodeParameter('step', ''),
				attempt: registered.attempt,
				repo: input.repo,
				area: input.area,
				baseRef: input.baseRef,
				instructions,
				promptId: this.getNodeParameter('promptId', ''),
				flowRunId: input.flowRunId,
				requiredFields,
				writes: this.getNodeParameter('writes', true),
			adapter,
				model,
				sessionId: String(input.workItem ?? '') || `${this.getExecutionId()}:${node.id}`,
				resume: Number(input.attempt) >= 1,
				maxAttempts: loop.maxRounds,
				endMarker: marker,
			});
		}
		await this.putExecutionToWait(WAIT_INDEFINITELY);
		return [this.getInputData()];
	}
}

function throwRunnerError(saved: { branch?: string; data?: Record<string, unknown> }) {
	if (saved.branch === 'failure' || ['failed', 'aborted'].includes(String(saved.data?.status))) throw new Error(String(saved.data?.error || 'Agent execution failed'));
	const error = typeof saved.data?.error === 'string' ? saved.data.error.trim() : '';
	if (error) throw new Error(error);
}

function roundOutputs(resume: { branch: string; data?: Record<string, unknown> }, input: Record<string, unknown>) {
	const data = { ...input, branch: resume.branch === 'failure' ? 'failure' : 'success', ...(resume.data ?? {}) };
	if (!Array.isArray(data.newIssues)) data.newIssues = [];
	const item = { json: data };
	if (resume.branch === 'failure') return [[], [item], []];
	return [[item], [], []];
}

import { Service } from '@n8n/di';

export type DispatchInput = {
	taskId: string;
	workItem: string;
	step: string;
	attempt: number;
	repo: string;
	area: string;
	baseRef: string;
	instructions: string;
	acceptance: string;
	flowRunId: string;
	requiredFields: string[];
};

@Service()
export class FlowDeskTasksService {
	private runnerUrl = process.env.FLOW_DESK_RUNNER_URL ?? 'http://host.docker.internal:39201';
	private runnerToken = process.env.FLOW_DESK_RUNNER_TOKEN ?? '';

	async dispatch(input: DispatchInput): Promise<void> {
		const res = await fetch(`${this.runnerUrl}/tasks`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${this.runnerToken}`,
			},
			body: JSON.stringify({
				...input,
				kind: 'agent',
				adapter: 'fake',
				context: { previousResults: [], rejectReasons: [] },
				limits: { timeoutSeconds: 600 },
			}),
		});
		if (!res.ok) {
			throw new Error(`agent-runner dispatch failed: ${res.status}`);
		}
	}

	setRunner(url: string, token: string) {
		this.runnerUrl = url;
		this.runnerToken = token;
	}
}

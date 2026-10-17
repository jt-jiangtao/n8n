import { Service } from '@n8n/di';
import { randomUUID } from 'node:crypto';

export type StepRegisterInput = {
	executionId: string;
	nodeId: string;
	nodeType: string;
	workItem: string;
	flowRunId: string;
	kind: 'human' | 'agent';
};

@Service()
export class FlowDeskStepsService {
	private readonly steps = new Map<string, { attempt: number; taskId?: string; status: string }>();

	key(executionId: string, nodeId: string) {
		return `${executionId}:${nodeId}`;
	}

	async register(input: StepRegisterInput): Promise<{ attempt: number; taskId?: string }> {
		const k = this.key(input.executionId, input.nodeId);
		const existing = this.steps.get(k);
		const attempt = (existing?.attempt ?? 0) + 1;
		const taskId = input.kind === 'agent' ? randomUUID() : undefined;
		this.steps.set(k, { attempt, taskId, status: 'waiting' });
		return { attempt, taskId };
	}

	get(executionId: string, nodeId: string) {
		return this.steps.get(this.key(executionId, nodeId));
	}

	markDone(executionId: string, nodeId: string) {
		const step = this.get(executionId, nodeId);
		if (step) step.status = 'done';
	}
}

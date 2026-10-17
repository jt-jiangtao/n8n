import { Service } from '@n8n/di';

/**
 * First-version resume: records the intended branch/data for a waiting step.
 * Full in-process WorkflowRunner wiring lands with the real execution engine
 * integration; nodes read `flowDeskResume` when re-entered.
 */
@Service()
export class FlowDeskResumeService {
	private readonly pending = new Map<
		string,
		{ branch: string; data: Record<string, unknown>; attempt: number }
	>();

	key(executionId: string, nodeId: string) {
		return `${executionId}:${nodeId}`;
	}

	async resume(input: {
		executionId: string;
		nodeId: string;
		branch: string;
		data?: Record<string, unknown>;
		attempt: number;
	}): Promise<{ ok: boolean; reason?: string }> {
		const k = this.key(input.executionId, input.nodeId);
		this.pending.set(k, {
			branch: input.branch,
			data: input.data ?? {},
			attempt: input.attempt,
		});
		return { ok: true };
	}

	take(executionId: string, nodeId: string) {
		const k = this.key(executionId, nodeId);
		const value = this.pending.get(k);
		if (value) this.pending.delete(k);
		return value;
	}
}

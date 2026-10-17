import { createHash } from 'node:crypto';
import { Service } from '@n8n/di';

@Service()
export class FlowDeskFlowsSyncService {
	private paused = new Set<string>();

	constructor(
		private readonly runner: { commitConfig?: (input: unknown) => Promise<void> },
		private readonly plane?: { createIssue: (body: Record<string, unknown>) => Promise<{ id: string }> },
	) {}

	normalizedHash(workflow: Record<string, unknown>): string {
		const clone = { ...workflow };
		delete clone.versionId;
		delete clone.updatedAt;
		const stable = JSON.stringify(clone, Object.keys(clone).sort());
		// Also stabilize nested node key order roughly:
		return createHash('sha256').update(stable).digest('hex');
	}

	async onWorkflowSaved(workflow: {
		id: string;
		flowType: string;
		name: string;
		nodes: unknown[];
		connections: unknown;
	}) {
		try {
			await this.runner.commitConfig?.({
				path: `flows/${workflow.flowType}.json`,
				content: workflow,
			});
			return { saved: true, exported: true };
		} catch {
			return { saved: true, exported: false };
		}
	}

	async handleConflict(input: { flowType: string }) {
		this.paused.add(input.flowType);
		await this.plane?.createIssue({
			name: `流程冲突: ${input.flowType}`,
			labels: ['flow-desk', 'system'],
		});
		return { paused: true };
	}
}

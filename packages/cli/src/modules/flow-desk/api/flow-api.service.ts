import { Service } from '@n8n/di';

import { FlowDeskAuthError } from '../ingest/ingest.service';
import type { FlowDeskRunsService } from '../runs/runs.service';

@Service()
export class FlowDeskFlowApiService {
	constructor(
		private readonly runs: FlowDeskRunsService,
		private readonly config: { serviceToken: string },
		private readonly registry?: {
			listActiveFlowTypes: () => Promise<Array<{ flowType: string; name: string }>>;
		},
	) {}

	private assert(token: string) {
		if (token !== this.config.serviceToken) throw new FlowDeskAuthError();
	}

	async getWorkItemFlow(issueId: string, token: string) {
		this.assert(token);
		const snap = this.runs.getSnapshot(issueId);
		if (!snap) {
			const err = new Error('not found') as Error & { httpCode: number };
			err.httpCode = 404;
			throw err;
		}
		return {
			nodes: (snap.nodes as unknown[]) ?? [],
			connections: snap.connections ?? {},
			steps: (snap.steps as unknown[]) ?? [],
		};
	}

	async listFlowTypes(token: string) {
		this.assert(token);
		if (this.registry) return this.registry.listActiveFlowTypes();
		return [];
	}
}

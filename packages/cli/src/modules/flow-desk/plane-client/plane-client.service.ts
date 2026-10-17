import { Service } from '@n8n/di';

@Service()
export class FlowDeskPlaneClient {
	constructor(
		private readonly transport: {
			request: (input: unknown) => Promise<{ id: string }>;
		},
	) {}

	async createIssue(body: Record<string, unknown>) {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await this.transport.request(body);
			} catch (error) {
				const err = error as { status?: number; retryAfterMs?: number };
				if (err.status === 429) {
					await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 100));
					continue;
				}
				throw error;
			}
		}
		throw new Error('plane createIssue exhausted retries');
	}
}

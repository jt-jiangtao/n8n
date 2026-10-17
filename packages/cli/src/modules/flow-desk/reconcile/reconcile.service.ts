import { Service } from '@n8n/di';

@Service()
export class FlowDeskReconcileService {
	constructor(
		private readonly deps: {
			saveEvent?: (row: { dedupeKey: string; kind: string }) => Promise<{ duplicate: boolean }>;
			pullEvents?: () => Promise<void>;
			replayDecisions?: () => Promise<void>;
			fixTasks?: () => Promise<void>;
			fixWaiting?: () => Promise<void>;
			repairChildren?: () => Promise<void>;
		},
	) {}

	async recordEvent(row: { dedupeKey: string; kind: string }) {
		return this.deps.saveEvent?.(row) ?? { duplicate: false };
	}

	async runStartup() {
		await this.deps.pullEvents?.();
		await this.deps.replayDecisions?.();
		await this.deps.fixTasks?.();
		await this.deps.fixWaiting?.();
		await this.deps.repairChildren?.();
		return { status: '对账完成' as const };
	}
}

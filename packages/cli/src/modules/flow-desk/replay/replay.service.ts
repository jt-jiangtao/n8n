export type HistoricRun = {
	runId: string;
	outcome: '完成' | '失败' | '已取消';
	nodeResults: Record<string, { branch: string; attempt?: number }>;
};

export type FlowDef = {
	flowType: string;
	nodes: Array<{ id: string; type: string }>;
	order: string[];
	endByBranch?: Record<string, string>;
};

export type ReplayStore = {
	save: (row: unknown) => Promise<void>;
	rows: unknown[];
};

export type ReplaySideEffects = {
	callRunner: () => Promise<void>;
	writePlane: () => Promise<void>;
	commit: () => Promise<void>;
};

export class FlowDeskReplayService {
	private readonly store: ReplayStore;
	private readonly sideEffects: ReplaySideEffects;

	constructor(store?: ReplayStore, sideEffects?: ReplaySideEffects) {
		this.store = store ?? {
			rows: [],
			save: async (row) => {
				this.store.rows.push(row);
			},
		};
		this.sideEffects = sideEffects ?? {
			callRunner: async () => {
				throw new Error('replay must not call agent-runner');
			},
			writePlane: async () => {
				throw new Error('replay must not write Plane');
			},
			commit: async () => {
				throw new Error('replay must not commit');
			},
		};
	}

	async replay(input: { flow: FlowDef; history: HistoricRun[]; limit?: number }) {
		const limit = input.limit ?? 20;
		const runs = input.history.slice(-limit).map((h) => this.replayOne(input.flow, h));
		const result = {
			flowType: input.flow.flowType,
			runs,
			worseCount: runs.filter((r) => r.status === 'worse').length,
		};
		await this.store.save(result);
		return result;
	}

	private replayOne(flow: FlowDef, historic: HistoricRun) {
		const missing: string[] = [];
		let lastBranch = 'pass';
		for (const nodeId of flow.order) {
			const recorded = historic.nodeResults[nodeId];
			if (!recorded) {
				missing.push(nodeId);
				continue;
			}
			lastBranch = recorded.branch;
		}
		if (missing.length) {
			return {
				runId: historic.runId,
				originalOutcome: historic.outcome,
				status: 'unreplayable' as const,
				missingNodes: missing,
			};
		}
		const newOutcome =
			flow.endByBranch?.[lastBranch] ??
			(lastBranch === 'pass' || lastBranch === 'approve' ? '完成' : '失败');
		let status: 'same' | 'worse' | 'improved' = 'same';
		if (historic.outcome === '完成' && newOutcome !== '完成') status = 'worse';
		else if (historic.outcome !== '完成' && newOutcome === '完成') status = 'improved';
		return {
			runId: historic.runId,
			originalOutcome: historic.outcome,
			newOutcome,
			status,
		};
	}

	getSideEffects() {
		return this.sideEffects;
	}
}

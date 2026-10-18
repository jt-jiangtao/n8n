export const REJECT_CATEGORIES = [
	'需求理解',
	'实现错误',
	'测试不足',
	'范围',
	'其他',
] as const;

export type RejectCategory = (typeof REJECT_CATEGORIES)[number] | '未分类';

export type MetricsEvent = {
	type: string;
	at: number;
	area?: string;
	flowType?: string;
	issueId?: string;
	voided?: boolean;
};

export type MetricsDecision = {
	nodeId: string;
	area: string;
	flowType: string;
	firstPass: boolean;
	rejectCategory?: RejectCategory;
	rejectReason?: string;
	at: number;
};

export type MetricsTask = {
	area: string;
	flowType: string;
	adapter: string;
	durationMs: number;
	at: number;
};

export type MetricsWorkItem = {
	area: string;
	flowType: string;
	todoAt: number;
	endedAt: number;
	merged?: boolean;
};

export class FlowDeskMetricsService {
	compute(input: {
		events: MetricsEvent[];
		decisions: MetricsDecision[];
		tasks: MetricsTask[];
		workItems: MetricsWorkItem[];
		from?: number;
		to?: number;
		area?: string;
		flowType?: string;
	}) {
		const inRange = (at: number) =>
			(input.from === undefined || at >= input.from) && (input.to === undefined || at <= input.to);
		const match = (area?: string, flowType?: string) =>
			(!input.area || area === input.area) && (!input.flowType || flowType === input.flowType);

		const durations = input.workItems
			.filter((w) => inRange(w.endedAt) && match(w.area, w.flowType))
			.map((w) => w.endedAt - w.todoAt)
			.sort((a, b) => a - b);
		const handlingTime = {
			medianMs: percentile(durations, 0.5),
			p90Ms: percentile(durations, 0.9),
		};

		const decisions = input.decisions.filter((d) => inRange(d.at) && match(d.area, d.flowType));
		const confirmPassRate = {
			rate: decisions.length ? decisions.filter((d) => d.firstPass).length / decisions.length : 0,
			byNode: Object.fromEntries(
				[...new Set(decisions.map((d) => d.nodeId))].map((nodeId) => {
					const subset = decisions.filter((d) => d.nodeId === nodeId);
					return [nodeId, subset.filter((d) => d.firstPass).length / subset.length];
				}),
			),
		};

		const rejects = decisions.filter((d) => d.rejectReason);
		const counts: Record<string, number> = {};
		for (const r of rejects) {
			const cat = r.rejectCategory ?? '未分类';
			counts[cat] = (counts[cat] ?? 0) + 1;
		}
		const rejectReasons = {
			counts,
			recent: rejects.slice(-5).map((r) => ({
				category: r.rejectCategory ?? '未分类',
				reason: r.rejectReason ?? '',
			})),
		};

		const merges = input.workItems.filter(
			(w) => w.merged && inRange(w.endedAt) && match(w.area, w.flowType),
		).length;
		const escapes = input.events.filter(
			(e) =>
				e.type === 'escape' &&
				!e.voided &&
				inRange(e.at) &&
				match(e.area, e.flowType),
		).length;
		const escapeRate = {
			rate: merges === 0 ? 0 : escapes / merges,
			escapes,
			merges,
		};

		const tasks = input.tasks.filter((t) => inRange(t.at) && match(t.area, t.flowType));
		const taskDurations = tasks.map((t) => t.durationMs).sort((a, b) => a - b);
		const byAdapter: Record<string, number> = {};
		for (const t of tasks) {
			byAdapter[t.adapter] = (byAdapter[t.adapter] ?? 0) + t.durationMs;
		}
		const agentDuration = {
			medianMs: percentile(taskDurations, 0.5),
			byAdapter,
		};

		return { handlingTime, confirmPassRate, rejectReasons, escapeRate, agentDuration };
	}

	parseRejectCommand(text: string): { category: RejectCategory; reason: string } | null {
		const m = text.trim().match(/^\/reject\s+(.+)$/s);
		if (!m) return null;
		const rest = m[1]!.trim();
		const first = rest.split(/\s+/)[0] ?? '';
		if ((REJECT_CATEGORIES as readonly string[]).includes(first)) {
			return { category: first as RejectCategory, reason: rest.slice(first.length).trim() || first };
		}
		return { category: '未分类', reason: rest };
	}
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[idx]!;
}

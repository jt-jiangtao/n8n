import type { FlowDeskConfigService } from '../config/config.service';
import type { FlowDeskIntakeService } from '../intake/intake.service';

export type SignalPlan = {
	id: string;
	name: string;
	area: string;
	source: 'main-regression' | 'dependencies' | 'docs-drift';
	every: string;
	dailyLimit: number;
	autoStart?: boolean;
	commands?: string[];
	lastRunAt?: Date;
	candidatesToday?: number;
	dayKey?: string;
};

export type SignalCandidate = {
	flowType: 'bug-standard' | 'bug-flaky' | 'chore-deps' | 'docs';
	title: string;
	area: string;
	dedupeKey: string;
	evidence: string;
	reproduction?: string;
	failedTests?: string[];
	runs?: Array<{ attempt: number; passed: boolean; summary: string }>;
};

export type SignalsDeps = {
	intake: FlowDeskIntakeService;
	plane: {
		createIssue: (input: Record<string, unknown>) => Promise<{ id: string }>;
		updateIssueState: (id: string, state: string) => Promise<unknown>;
		comment: (id: string, body: string) => Promise<unknown>;
	};
	config: FlowDeskConfigService;
	clock: { now: () => Date };
	recordEvent: (e: { type: string; detail?: string }) => void;
	startFlow: (input: { issueId: string; flowType: string; area: string }) => Promise<void>;
	runSignal: (plan: SignalPlan) => Promise<{ candidates: SignalCandidate[] }>;
	getKillSwitch: () => boolean;
};

export class FlowDeskSignalsService {
	private plans: SignalPlan[] = [];

	constructor(private readonly deps: SignalsDeps) {}

	add(plan: SignalPlan) {
		this.plans.push({
			dailyLimit: plan.dailyLimit ?? 1,
			candidatesToday: 0,
			...plan,
		});
	}

	async tick(at: Date) {
		if (this.deps.getKillSwitch()) return;
		const dayKey = at.toISOString().slice(0, 10);
		for (const plan of this.plans) {
			if (plan.dayKey !== dayKey) {
				plan.dayKey = dayKey;
				plan.candidatesToday = 0;
			}
			const due =
				!plan.lastRunAt || at.getTime() - plan.lastRunAt.getTime() >= 60 * 60 * 1000;
			if (!due) continue;
			plan.lastRunAt = at;
			const { candidates } = await this.deps.runSignal(plan);
			for (const c of candidates) {
				if ((plan.candidatesToday ?? 0) >= plan.dailyLimit) {
					this.deps.recordEvent({
						type: 'signal-daily-limit',
						detail: `${plan.id}:${c.dedupeKey}`,
					});
					continue;
				}
				const result = await this.deps.intake.submit({
					title: c.title,
					reproduction: c.reproduction ?? c.evidence,
					evidence:
						c.failedTests?.length
							? `${c.evidence}\nfailedTests: ${c.failedTests.join(', ')}`
							: c.evidence,
					area: c.area,
					dedupeKey: c.dedupeKey,
					source: 'signal',
					flowType: c.flowType,
					state: '收件箱',
				});
				if (!result.ok) continue;
				if (!result.deduped) {
					plan.candidatesToday = (plan.candidatesToday ?? 0) + 1;
					if (plan.autoStart) {
						await this.deps.plane.updateIssueState(result.id, '待做');
						await this.deps.startFlow({
							issueId: result.id,
							flowType: c.flowType,
							area: c.area,
						});
					}
				}
			}
		}
	}
}

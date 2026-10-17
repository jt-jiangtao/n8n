import { Service } from '@n8n/di';

type Schedule = {
	id: string;
	cron: string;
	flowType: string;
	dailyLimit: number;
	lastRunAt?: Date;
	runsToday?: number;
	dayKey?: string;
	enabled?: boolean;
};

@Service()
export class FlowDeskSchedulerService {
	private schedules: Schedule[] = [];

	constructor(
		private readonly runs: { startScheduled: (id: string) => Promise<void> },
		private readonly clock: { now: () => Date },
	) {}

	add(schedule: Schedule) {
		this.schedules.push({ enabled: true, runsToday: 0, ...schedule });
	}

	async tick(at: Date) {
		const dayKey = at.toISOString().slice(0, 10);
		for (const schedule of this.schedules) {
			if (schedule.enabled === false) continue;
			if (schedule.dayKey !== dayKey) {
				schedule.dayKey = dayKey;
				schedule.runsToday = 0;
			}
			if ((schedule.runsToday ?? 0) >= schedule.dailyLimit) continue;
			// Hourly cron "0 * * * *": due if minute==0 or backfill once after lastRunAt.
			const due =
				!schedule.lastRunAt || at.getTime() - schedule.lastRunAt.getTime() >= 60 * 60 * 1000;
			if (!due) continue;
			await this.runs.startScheduled(schedule.id);
			schedule.lastRunAt = at;
			schedule.runsToday = (schedule.runsToday ?? 0) + 1;
			// M88: only backfill once even if multiple hours missed.
		}
	}
}

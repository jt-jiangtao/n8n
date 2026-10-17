/** 1.5 schedules with fake clock: M87–M90 */
import { describe, expect, it, vi } from 'vitest';

import { FlowDeskSchedulerService } from '../scheduler/scheduler.service';

describe('flow-schedules (M87–M90)', () => {
	it('M87: every minute tick evaluates due schedules', async () => {
		const runs = { startScheduled: vi.fn(async () => undefined) };
		const clock = { now: () => new Date('2026-01-01T00:00:00Z') };
		const scheduler = new FlowDeskSchedulerService(runs as never, clock);
		scheduler.add({
			id: 's1',
			cron: '0 * * * *',
			flowType: 'bug-standard',
			dailyLimit: 10,
		});
		await scheduler.tick(new Date('2026-01-01T01:00:00Z'));
		expect(runs.startScheduled).toHaveBeenCalled();
	});

	it('M88: missed window is backfilled once', async () => {
		const starts: string[] = [];
		const runs = {
			startScheduled: vi.fn(async (id: string) => {
				starts.push(id);
			}),
		};
		const scheduler = new FlowDeskSchedulerService(runs as never, {
			now: () => new Date('2026-01-01T03:00:00Z'),
		});
		scheduler.add({
			id: 's1',
			cron: '0 * * * *',
			flowType: 'bug-standard',
			dailyLimit: 10,
			lastRunAt: new Date('2026-01-01T00:00:00Z'),
		});
		await scheduler.tick(new Date('2026-01-01T03:00:00Z'));
		expect(starts.length).toBe(1);
	});

	it('M89: daily limit stops further runs that day', async () => {
		const runs = { startScheduled: vi.fn(async () => undefined) };
		const scheduler = new FlowDeskSchedulerService(runs as never, {
			now: () => new Date('2026-01-01T05:00:00Z'),
		});
		scheduler.add({
			id: 's1',
			cron: '0 * * * *',
			flowType: 'bug-standard',
			dailyLimit: 1,
			runsToday: 1,
			dayKey: '2026-01-01',
		});
		await scheduler.tick(new Date('2026-01-01T05:00:00Z'));
		expect(runs.startScheduled).not.toHaveBeenCalled();
	});

	it('M90: disabled schedule is skipped', async () => {
		const runs = { startScheduled: vi.fn(async () => undefined) };
		const scheduler = new FlowDeskSchedulerService(runs as never, {
			now: () => new Date('2026-01-01T01:00:00Z'),
		});
		scheduler.add({
			id: 's1',
			cron: '0 * * * *',
			flowType: 'bug-standard',
			dailyLimit: 10,
			enabled: false,
		});
		await scheduler.tick(new Date('2026-01-01T01:00:00Z'));
		expect(runs.startScheduled).not.toHaveBeenCalled();
	});
});

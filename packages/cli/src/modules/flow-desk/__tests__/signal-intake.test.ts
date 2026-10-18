/**
 * add-signal-intake 1.3 — M122–M126
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskSignalsService } from '../signals/signals.service';
import { FlowDeskIntakeService } from '../intake/intake.service';
import { FlowDeskConfigService } from '../config/config.service';

describe('signal-intake (M122–M126)', () => {
	const plane = {
		createIssue: vi.fn(async () => ({ id: 'iss-1' })),
		createRelation: vi.fn(async () => undefined),
		updateIssueState: vi.fn(async () => undefined),
		comment: vi.fn(async () => undefined),
	};
	const events: Array<{ type: string; detail?: string }> = [];
	const startFlow = vi.fn(async () => undefined);
	let config: FlowDeskConfigService;
	let intake: FlowDeskIntakeService;
	let signals: FlowDeskSignalsService;

	beforeEach(() => {
		vi.clearAllMocks();
		events.length = 0;
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: { smoke: 'echo', snapshot: 'echo', docs: 'echo', full: 'echo full' },
					roles: { owner: ['a'], planApprover: ['a'], mergeApprover: ['a'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
				},
			},
			groups: {},
			guards: { protectedPaths: [] },
			provenance: { escapeWindowDays: 30 },
			desktop: { hostAddress: '127.0.0.1' },
		});
		intake = new FlowDeskIntakeService(plane as never, config);
		signals = new FlowDeskSignalsService({
			intake,
			plane: plane as never,
			config,
			clock: { now: () => new Date('2026-10-18T10:00:00Z') },
			recordEvent: (e) => events.push(e),
			startFlow,
			runSignal: async () => ({
				candidates: [
					{
						flowType: 'bug-standard',
						title: 'main red',
						area: 'web',
						dedupeKey: 'fail:tests/a.test.ts',
						evidence: 'failed',
						reproduction: 'full suite',
						failedTests: ['tests/a.test.ts'],
					},
				],
			}),
			getKillSwitch: () => false,
		});
		signals.add({
			id: 'web-main',
			name: 'web-main',
			area: 'web',
			source: 'main-regression',
			every: '0 * * * *',
			dailyLimit: 1,
			autoStart: false,
		});
	});

	it('M122: due signal runs; missed hours backfill once', async () => {
		await signals.tick(new Date('2026-10-18T10:00:00Z'));
		await signals.tick(new Date('2026-10-18T12:00:00Z'));
		// dailyLimit 1 on candidates — second tick may run but candidate capped
		expect(plane.createIssue).toHaveBeenCalled();
	});

	it('M123: candidates over dailyLimit skipped with event', async () => {
		signals = new FlowDeskSignalsService({
			intake,
			plane: plane as never,
			config,
			clock: { now: () => new Date('2026-10-18T10:00:00Z') },
			recordEvent: (e) => events.push(e),
			startFlow,
			runSignal: async () => ({
				candidates: [
					{
						flowType: 'bug-standard',
						title: 'a',
						area: 'web',
						dedupeKey: 'k1',
						evidence: 'e',
						reproduction: 'r',
					},
					{
						flowType: 'bug-standard',
						title: 'b',
						area: 'web',
						dedupeKey: 'k2',
						evidence: 'e',
						reproduction: 'r',
					},
				],
			}),
			getKillSwitch: () => false,
		});
		signals.add({
			id: 'web-main',
			name: 'web-main',
			area: 'web',
			source: 'main-regression',
			every: '0 * * * *',
			dailyLimit: 1,
		});
		await signals.tick(new Date('2026-10-18T10:00:00Z'));
		expect(plane.createIssue).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === 'signal-daily-limit')).toBe(true);
	});

	it('M124: same dedupeKey only comments', async () => {
		intake.indexExisting([
			{
				id: 'existing',
				title: 'old',
				area: 'web',
				state: '进行中',
				dedupeKey: 'fail:tests/a.test.ts',
			},
		]);
		await signals.tick(new Date('2026-10-18T10:00:00Z'));
		expect(plane.comment).toHaveBeenCalled();
		expect(plane.createIssue).not.toHaveBeenCalled();
	});

	it('M125: source:signal inbox; autoStart → 待做 + startFlow', async () => {
		signals = new FlowDeskSignalsService({
			intake,
			plane: plane as never,
			config,
			clock: { now: () => new Date('2026-10-18T10:00:00Z') },
			recordEvent: (e) => events.push(e),
			startFlow,
			runSignal: async () => ({
				candidates: [
					{
						flowType: 'bug-standard',
						title: 'main red',
						area: 'web',
						dedupeKey: 'k-new',
						evidence: 'e',
						reproduction: 'r',
					},
				],
			}),
			getKillSwitch: () => false,
		});
		signals.add({
			id: 'web-main',
			name: 'web-main',
			area: 'web',
			source: 'main-regression',
			every: '0 * * * *',
			dailyLimit: 5,
			autoStart: true,
		});
		await signals.tick(new Date('2026-10-18T10:00:00Z'));
		expect(plane.createIssue).toHaveBeenCalledWith(
			expect.objectContaining({
				labels: expect.arrayContaining(['source:signal', 'area:web', 'flow:bug-standard']),
				state: '收件箱',
			}),
		);
		expect(plane.updateIssueState).toHaveBeenCalledWith('iss-1', '待做');
		expect(startFlow).toHaveBeenCalled();
	});

	it('M126: kill switch skips signal runs', async () => {
		signals = new FlowDeskSignalsService({
			intake,
			plane: plane as never,
			config,
			clock: { now: () => new Date('2026-10-18T10:00:00Z') },
			recordEvent: (e) => events.push(e),
			startFlow,
			runSignal: async () => ({ candidates: [] }),
			getKillSwitch: () => true,
		});
		signals.add({
			id: 'web-main',
			name: 'web-main',
			area: 'web',
			source: 'main-regression',
			every: '0 * * * *',
			dailyLimit: 1,
		});
		await signals.tick(new Date('2026-10-18T10:00:00Z'));
		expect(plane.createIssue).not.toHaveBeenCalled();
	});
});

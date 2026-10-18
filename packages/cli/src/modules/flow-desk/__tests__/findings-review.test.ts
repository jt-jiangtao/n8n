/**
 * add-findings-review 1.2 — M120, M121, F31, F32
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskFindingsService } from '../findings/findings.service';
import { FlowDeskFindingsReviewService } from '../findings-review/findings-review.service';
import { FlowDeskSchedulerService } from '../scheduler/scheduler.service';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../../../../',
);

describe('findings-review (M120, M121, F31, F32)', () => {
	const plane = {
		comment: vi.fn(async () => undefined),
		createPage: vi.fn(async () => ({ id: 'page-1' })),
		uploadAttachment: vi.fn(async () => ({ id: 'att-1' })),
		createIssue: vi.fn(async () => ({ id: 'iss-new' })),
		createRelation: vi.fn(async () => undefined),
	};
	let findings: FlowDeskFindingsService;
	let review: FlowDeskFindingsReviewService;

	beforeEach(() => {
		vi.clearAllMocks();
		findings = new FlowDeskFindingsService(plane as never);
		review = new FlowDeskFindingsReviewService(plane as never, findings);
	});

	it('M120: applyActions creates with 发现于; ignore requires reason; dedupe comments', async () => {
		const list = [
			{
				fingerprint: 'fp-a',
				rule: 'overflow',
				deterministic: true,
				level: 'error' as const,
				source: 'deterministic' as const,
				message: '溢出',
				location: {
					kind: 'ui' as const,
					page: '/',
					width: 1280,
					theme: 'light',
					selector: '#x',
				},
				status: 'new' as const,
			},
		];
		await expect(
			review.applyActions({
				parentIssueId: 'p1',
				area: 'web',
				findings: list,
				actions: [{ fingerprint: 'fp-a', action: 'ignore' }],
			}),
		).rejects.toMatchObject({ code: 'IGNORE_REASON_REQUIRED' });

		const created = await review.applyActions({
			parentIssueId: 'p1',
			area: 'web',
			findings: list,
			actions: [{ fingerprint: 'fp-a', action: 'create', createAs: 'bug-standard' }],
		});
		expect(created.created).toContain('iss-new');
		expect(plane.createRelation).toHaveBeenCalledWith('iss-new', 'p1', '发现于');

		plane.createIssue.mockResolvedValueOnce({ id: 'iss-2' });
		const again = await review.applyActions({
			parentIssueId: 'p1',
			area: 'web',
			findings: list,
			actions: [{ fingerprint: 'fp-a', action: 'create', createAs: 'bug-standard' }],
		});
		expect(again.created[0]).toBe('iss-new');
		expect(plane.comment).toHaveBeenCalled();
	});

	it('P41/P42 via publishReport: page + attachment + count comment', async () => {
		const r = await review.publishReport({
			childIssueId: 'c1',
			findings: [
				{
					fingerprint: 'n1',
					rule: 'r',
					deterministic: true,
					level: 'error',
					source: 'deterministic',
					message: 'new err',
					location: { kind: 'code', file: 'a.ts', contentHash: '1' },
					status: 'new',
				},
				{
					fingerprint: 'e1',
					rule: 'r',
					deterministic: true,
					level: 'warning',
					source: 'deterministic',
					message: 'old',
					location: { kind: 'code', file: 'b.ts', contentHash: '2' },
					status: 'existing',
				},
			],
			screenshots: [{ name: 'diff.png', bytes: Buffer.from('png') }],
		});
		expect(r.counts.new).toBe(1);
		expect(plane.createPage).toHaveBeenCalled();
		expect(plane.uploadAttachment).toHaveBeenCalled();
		expect(String(plane.comment.mock.calls[0]?.[1])).toMatch(/新增 1/);
	});

	it('F31/F32: ui-audit and code-quality flow files exist with expected nodes', () => {
		for (const name of ['ui-audit', 'code-quality']) {
			const p = path.join(repoRoot, 'flows', `${name}.json`);
			expect(existsSync(p), name).toBe(true);
			const flow = JSON.parse(readFileSync(p, 'utf8')) as {
				meta?: { flowType?: string };
				nodes: Array<{ type: string; parameters?: Record<string, unknown> }>;
			};
			expect(flow.meta?.flowType).toBe(name);
			expect(flow.nodes.some((n) => n.type === 'flowDeskHumanStep')).toBe(true);
			if (name === 'ui-audit') {
				expect(flow.nodes.some((n) => n.type === 'flowDeskUiCheckStep')).toBe(true);
			} else {
				expect(flow.nodes.some((n) => n.type === 'flowDeskQualityStep')).toBe(true);
			}
		}
	});

	it('M121: schedules for audit flows honor daily limit per area', async () => {
		const startScheduled = vi.fn(async () => undefined);
		const clock = { now: () => new Date('2026-10-18T10:00:00Z') };
		const scheduler = new FlowDeskSchedulerService({ startScheduled }, clock);
		scheduler.add({
			id: 'web-ui-audit',
			cron: '0 * * * *',
			flowType: 'ui-audit',
			dailyLimit: 1,
		});
		await scheduler.tick(new Date('2026-10-18T10:00:00Z'));
		await scheduler.tick(new Date('2026-10-18T11:00:00Z'));
		expect(startScheduled).toHaveBeenCalledTimes(1);
	});
});

/** 1.3 records / related issues / rate-limit / reconcile: M59–M61, M66–M74, M101 */
import { describe, expect, it, vi } from 'vitest';

import { FlowDeskReconcileService } from '../reconcile/reconcile.service';
import { FlowDeskPlaneClient } from '../plane-client/plane-client.service';
import { FlowDeskRelatedIssuesService } from '../related/related-issues.service';

describe('flow-reconcile (M59–M61, M66–M74, M101)', () => {
	it('M59–M61: events and decisions are recorded with dedupe keys', async () => {
		const events = new Map<string, unknown>();
		const svc = new FlowDeskReconcileService({
			saveEvent: async (row) => {
				if (events.has(row.dedupeKey)) return { duplicate: true };
				events.set(row.dedupeKey, row);
				return { duplicate: false };
			},
		} as never);
		await svc.recordEvent({ dedupeKey: 'd1', kind: 'state' });
		await svc.recordEvent({ dedupeKey: 'd1', kind: 'state' });
		expect(events.size).toBe(1);
	});

	it('M66–M68: create related work item with flow/area labels and optional auto-start', async () => {
		const plane = { createIssue: vi.fn(async () => ({ id: 'new-1' })), updateIssueState: vi.fn() };
		const related = new FlowDeskRelatedIssuesService(plane as never);
		const created = await related.create({
			parentIssueId: 'p1',
			title: 'follow-up',
			flowType: 'bug-standard',
			area: 'web',
			relation: 'follow_up',
			autoStart: true,
		});
		expect(created.id).toBe('new-1');
		expect(plane.createIssue).toHaveBeenCalledWith(
			expect.objectContaining({ labels: expect.arrayContaining(['flow:bug-standard', 'area:web']) }),
		);
		expect(plane.updateIssueState).toHaveBeenCalledWith('new-1', '待做');
	});

	it('M69–M74: reconcile five steps then marks complete', async () => {
		const steps: string[] = [];
		const reconcile = new FlowDeskReconcileService({
			pullEvents: async () => {
				steps.push('events');
			},
			replayDecisions: async () => {
				steps.push('decisions');
			},
			fixTasks: async () => {
				steps.push('tasks');
			},
			fixWaiting: async () => {
				steps.push('waiting');
			},
			repairChildren: async () => {
				steps.push('children');
			},
		} as never);
		const result = await reconcile.runStartup();
		expect(steps).toEqual(['events', 'decisions', 'tasks', 'waiting', 'children']);
		expect(result.status).toBe('对账完成');
	});

	it('M101: Plane 429 retries after Retry-After without duplicating creates', async () => {
		let calls = 0;
		const client = new FlowDeskPlaneClient({
			request: async () => {
				calls += 1;
				if (calls === 1) {
					const err = new Error('429') as Error & { status: number; retryAfterMs: number };
					err.status = 429;
					err.retryAfterMs = 10;
					throw err;
				}
				return { id: 'ok' };
			},
		});
		const result = await client.createIssue({ name: 'x' });
		expect(result.id).toBe('ok');
		expect(calls).toBe(2);
	});
});

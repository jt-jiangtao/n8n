import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowDeskEventEntity } from '../database/flow-desk-event.entity';
import { FlowDeskIngestService } from '../ingest/ingest.service';

describe('FlowDeskIngestService (M1–M3, M97)', () => {
	const events = new Map<number, FlowDeskEventEntity>();
	let cursor = 0;
	let pullAfter: number | null = null;
	let planeEvents: Array<{ id: number; kind: string; issueId: string; payload: object }> = [];

	const eventRepo = {
		findOneBy: vi.fn(async ({ dedupeKey }: { dedupeKey: string }) => {
			const id = Number(dedupeKey.replace('plane:', ''));
			return events.get(id) ?? null;
		}),
		save: vi.fn(async (row: FlowDeskEventEntity) => {
			events.set(Number(row.dedupeKey.replace('plane:', '')), row);
			return row;
		}),
	};

	const cursorStore = {
		get: vi.fn(async () => cursor),
		set: vi.fn(async (value: number) => {
			cursor = value;
		}),
	};

	const planeClient = {
		pullEvents: vi.fn(async (after: number) => {
			pullAfter = after;
			return planeEvents.filter((e) => e.id > after);
		}),
	};

	const dispatcher = {
		dispatch: vi.fn(async (_event: unknown) => undefined),
	};

	let service: FlowDeskIngestService;

	beforeEach(() => {
		events.clear();
		cursor = 0;
		pullAfter = null;
		planeEvents = [
			{ id: 1, kind: 'state', issueId: 'issue-1', payload: { state: 'todo' } },
			{ id: 2, kind: 'comment', issueId: 'issue-1', payload: { body: '/approve' } },
		];
		vi.clearAllMocks();
		service = new FlowDeskIngestService(
			eventRepo as never,
			cursorStore as never,
			planeClient as never,
			dispatcher as never,
			{ serviceToken: 'svc-secret' },
		);
	});

	it('M1: notify with valid token pulls from cursor and advances it', async () => {
		await service.handleNotify('svc-secret');
		expect(pullAfter).toBe(0);
		expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
		expect(cursor).toBe(2);
		expect(events.size).toBe(2);
	});

	it('M2: bad or missing token returns 401 and has no side effects', async () => {
		await expect(service.handleNotify(undefined)).rejects.toMatchObject({ httpCode: 401 });
		await expect(service.handleNotify('wrong')).rejects.toMatchObject({ httpCode: 401 });
		expect(planeClient.pullEvents).not.toHaveBeenCalled();
		expect(events.size).toBe(0);
		expect(cursor).toBe(0);
	});

	it('M3: duplicate event id is processed only once', async () => {
		await service.handleNotify('svc-secret');
		planeEvents = [{ id: 1, kind: 'state', issueId: 'issue-1', payload: { state: 'todo' } }];
		cursor = 0;
		await service.pullAndProcess();
		expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
		expect(events.size).toBe(2);
	});

	it('M97: timed pull processes events when notify was lost', async () => {
		await service.pullAndProcess();
		expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
		expect(cursor).toBe(2);
	});
});

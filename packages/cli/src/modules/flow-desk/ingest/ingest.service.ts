import { Service } from '@n8n/di';

export class FlowDeskAuthError extends Error {
	httpCode = 401;
	constructor(message = 'unauthorized') {
		super(message);
		this.name = 'FlowDeskAuthError';
	}
}

export type PlaneEvent = {
	id: number;
	kind: string;
	issueId: string;
	payload: object;
};

export type EventRepo = {
	findOneBy: (where: { dedupeKey: string }) => Promise<{ dedupeKey: string } | null>;
	save: (row: {
		dedupeKey: string;
		eventId: string;
		kind: string;
		issueId: string;
		payload: Record<string, unknown>;
	}) => Promise<unknown>;
};

export type CursorStore = {
	get: () => Promise<number>;
	set: (value: number) => Promise<void>;
};

export type PlaneClient = {
	pullEvents: (after: number) => Promise<PlaneEvent[]>;
};

export type EventDispatcher = {
	dispatch: (event: PlaneEvent) => Promise<void>;
};

/**
 * Ingest core. Constructed explicitly (tests + module init) rather than via DI,
 * because repos/clients are swapped for fakes in unit tests.
 */
export class FlowDeskIngestService {
	constructor(
		private readonly eventRepo: EventRepo,
		private readonly cursorStore: CursorStore,
		private readonly planeClient: PlaneClient,
		private readonly dispatcher: EventDispatcher,
		private readonly config: { serviceToken: string },
	) {}

	async handleNotify(token: string | undefined): Promise<void> {
		this.assertToken(token);
		await this.pullAndProcess();
	}

	async pullAndProcess(): Promise<void> {
		const after = await this.cursorStore.get();
		const events = await this.planeClient.pullEvents(after);
		let maxId = after;
		for (const event of events) {
			const dedupeKey = `plane:${event.id}`;
			const existing = await this.eventRepo.findOneBy({ dedupeKey });
			if (!existing) {
				await this.eventRepo.save({
					dedupeKey,
					eventId: String(event.id),
					kind: event.kind,
					issueId: event.issueId,
					payload: event.payload as Record<string, unknown>,
				});
				await this.dispatcher.dispatch(event);
			}
			if (event.id > maxId) maxId = event.id;
		}
		if (maxId > after) {
			await this.cursorStore.set(maxId);
		}
	}

	private assertToken(token: string | undefined): void {
		if (!token || token !== this.config.serviceToken) {
			throw new FlowDeskAuthError();
		}
	}
}

@Service()
export class FlowDeskIngestFacade {
	private impl: FlowDeskIngestService | undefined;

	setImplementation(impl: FlowDeskIngestService) {
		this.impl = impl;
	}

	private get(): FlowDeskIngestService {
		if (!this.impl) throw new Error('FlowDeskIngestService not initialized');
		return this.impl;
	}

	handleNotify(token: string | undefined) {
		return this.get().handleNotify(token);
	}

	pullAndProcess() {
		return this.get().pullAndProcess();
	}
}

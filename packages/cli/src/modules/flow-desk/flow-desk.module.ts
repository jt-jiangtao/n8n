import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

import {
	FlowDeskIngestFacade,
	FlowDeskIngestService,
	type PlaneEvent,
} from './ingest/ingest.service';

@BackendModule({ name: 'flow-desk', instanceTypes: ['main'] })
export class FlowDeskModule implements ModuleInterface {
	private pollTimer: ReturnType<typeof setInterval> | undefined;

	async init() {
		await import('./flow-desk.controller.js');
		await import('./projects/project.controller.js');
		const { ProjectRuntimeService } = await import('./projects/project-runtime.service.js');
		Container.get(ProjectRuntimeService).startWatching();
		const { EventService } = await import('@n8n/backend-services');
		Container.get(EventService).on('execution-cancelled', ({ executionId }) => {
			void Container.get(ProjectRuntimeService).cancelIfKnown(String(executionId));
		});

		const events = new Map<string, { dedupeKey: string }>();
		let cursor = 0;
		const facade = Container.get(FlowDeskIngestFacade);

		const planeBase = process.env.FLOW_DESK_PLANE_URL ?? 'http://api:8000';
		const serviceToken = process.env.FLOW_DESK_SERVICE_TOKEN ?? 'svc-secret';

		const impl = new FlowDeskIngestService(
			{
				findOneBy: async ({ dedupeKey }) => events.get(dedupeKey) ?? null,
				save: async (row) => {
					events.set(row.dedupeKey, row);
					return row;
				},
			},
			{
				get: async () => cursor,
				set: async (value) => {
					cursor = value;
				},
			},
			{
				pullEvents: async (after) => {
					const res = await fetch(
						`${planeBase}/api/flow-desk/internal/events/?after=${after}`,
						{ headers: { authorization: `Bearer ${serviceToken}` } },
					);
					if (!res.ok) return [];
					const body = (await res.json()) as { events: PlaneEvent[] };
					return body.events ?? [];
				},
			},
			{
				dispatch: async (_event: PlaneEvent) => {
					// Runs / projection dispatch expands in add-flow-engine.
				},
			},
			{ serviceToken },
		);
		facade.setImplementation(impl);

		this.pollTimer = setInterval(() => {
			void impl.pullAndProcess().catch(() => undefined);
		}, 10_000);
	}

	async entities() {
		const { ProjectRecordEntity } = await import('./database/project-record.entity.js');
		const { FlowDeskEventEntity } = await import('./database/flow-desk-event.entity.js');
		const { FlowDeskCursorEntity } = await import('./database/flow-desk-cursor.entity.js');
		const { FlowDeskRunEntity } = await import('./database/flow-desk-run.entity.js');
		const { FlowDeskStepEntity } = await import('./database/flow-desk-step.entity.js');
		const { FlowDeskCommitEntity } = await import('./database/flow-desk-commit.entity.js');
		return [
			ProjectRecordEntity,
			FlowDeskEventEntity,
			FlowDeskCursorEntity,
			FlowDeskRunEntity,
			FlowDeskStepEntity,
			FlowDeskCommitEntity,
		];
	}

	@OnShutdown()
	async shutdown() {
		const { ProjectRuntimeService } = await import('./projects/project-runtime.service.js');
		Container.get(ProjectRuntimeService).stopWatching();
		if (this.pollTimer) clearInterval(this.pollTimer);
	}
}

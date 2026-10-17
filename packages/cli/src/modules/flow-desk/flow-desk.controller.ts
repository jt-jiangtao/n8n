import { Body, Get, Post, RestController } from '@n8n/decorators';
import type { Request, Response } from 'express';

import { FlowDeskE17Service } from './e17/e17.service';
import { FlowDeskAuthError, FlowDeskIngestFacade } from './ingest/ingest.service';
import { FlowDeskResumeService } from './resume/resume.service';
import { FlowDeskStepsService } from './steps/steps.service';
import { FlowDeskTasksService } from './tasks/tasks.service';

function bearer(req: Request): string | undefined {
	const auth = req.headers.authorization;
	if (!auth?.startsWith('Bearer ')) return undefined;
	return auth.slice('Bearer '.length).trim();
}

@RestController('/flow-desk')
export class FlowDeskController {
	constructor(
		private readonly ingest: FlowDeskIngestFacade,
		private readonly steps: FlowDeskStepsService,
		private readonly tasks: FlowDeskTasksService,
		private readonly resume: FlowDeskResumeService,
		private readonly e17: FlowDeskE17Service,
	) {}

	@Post('/plane/notify', { skipAuth: true })
	async notify(req: Request, res: Response) {
		try {
			await this.ingest.handleNotify(bearer(req));
			res.status(204).end();
		} catch (error) {
			if (error instanceof FlowDeskAuthError) {
				res.status(401).json({ error: 'unauthorized' });
				return;
			}
			throw error;
		}
	}

	@Post('/steps/register', { skipAuth: true })
	async registerStep(req: Request, res: Response, @Body body: Record<string, unknown>) {
		const result = await this.steps.register(body as never);
		if (body.kind === 'agent' && result.taskId) {
			await this.tasks.dispatch({
				taskId: result.taskId,
				workItem: String(body.workItem ?? ''),
				step: String(body.step ?? 'implement'),
				attempt: result.attempt,
				repo: String(body.repo ?? ''),
				area: String(body.area ?? 'web'),
				baseRef: String(body.baseRef ?? 'main'),
				instructions: String(body.instructions ?? ''),
				acceptance: String(body.acceptance ?? ''),
				flowRunId: String(body.flowRunId ?? ''),
				requiredFields: (body.requiredFields as string[]) ?? [],
			});
		}
		res.json(result);
	}

	@Post('/resume', { skipAuth: true })
	async resumeStep(req: Request, res: Response, @Body body: Record<string, unknown>) {
		const result = await this.resume.resume({
			executionId: String(body.executionId),
			nodeId: String(body.nodeId),
			branch: String(body.branch),
			data: (body.data as Record<string, unknown>) ?? {},
			attempt: Number(body.attempt ?? 1),
		});
		res.json(result);
	}

	@Post('/commits', { skipAuth: true })
	async registerCommit(_req: Request, res: Response) {
		res.status(204).end();
	}

	@Post('/tasks/:taskId/result', { skipAuth: true })
	async taskResult(req: Request, res: Response, @Body body: Record<string, unknown>) {
		const status = body.status === 'ok' ? 'success' : 'failure';
		await this.resume.resume({
			executionId: String(body.executionId ?? ''),
			nodeId: String(body.nodeId ?? ''),
			branch: status,
			data: body,
			attempt: Number(body.attempt ?? 1),
		});
		res.status(204).end();
	}

	@Post('/e17/run', { skipAuth: true })
	async e17Run(req: Request, res: Response, @Body body: Record<string, unknown>) {
		try {
			this.assertService(req);
			await this.e17.start(body as never);
			res.status(202).json({ started: true });
		} catch (error) {
			if (error instanceof FlowDeskAuthError) {
				res.status(401).json({ error: 'unauthorized' });
				return;
			}
			res.status(500).json({ error: String(error) });
		}
	}

	@Get('/e17/status', { skipAuth: true })
	async e17Status(req: Request, res: Response) {
		try {
			this.assertService(req);
			res.json(this.e17.status());
		} catch (error) {
			if (error instanceof FlowDeskAuthError) {
				res.status(401).json({ error: 'unauthorized' });
				return;
			}
			throw error;
		}
	}

	private assertService(req: Request) {
		const token = bearer(req);
		const expected = process.env.FLOW_DESK_SERVICE_TOKEN ?? 'svc-secret';
		if (!token || token !== expected) throw new FlowDeskAuthError();
	}
}

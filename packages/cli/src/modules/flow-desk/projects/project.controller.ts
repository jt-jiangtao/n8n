import { Get, Post, Param, RestController } from '@n8n/decorators';
import type { Request, Response } from 'express';
import type { User } from '@n8n/db';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { readHumanAssertion } from './human-assertion';
import { ProjectRecordRepository } from '../database/project-record.repository';
import { Container } from '@n8n/di';
import { ProjectRuntimeService } from './project-runtime.service';

function internalCredential(req: Request) {
	const secret = readFileSync(
		process.env.FLOW_DESK_DESKTOP_SECRET_FILE ?? '/tmp/flow-desk-desktop-token',
		'utf8',
	).trim();
	const expected = Buffer.from(`Bearer ${secret}`),
		provided = Buffer.from(req.headers.authorization ?? '');
	return (
		/^[a-f0-9]{64}$/.test(secret) &&
		expected.length === provided.length &&
		timingSafeEqual(expected, provided)
	);
}
function human(req: Request): User {
	const user = (req as Request & { user?: User }).user;
	if (!user || user.disabled) throw new Error('Authenticated human required');
	return user;
}
@RestController('/flow-desk/projects')
export class ProjectController {
	constructor(private readonly service: ProjectRuntimeService) {}
	@Post('/desktop', { skipAuth: true })
	async desktop(req: Request, res: Response) {
		try {
			const secret = readFileSync(
				process.env.FLOW_DESK_DESKTOP_SECRET_FILE ?? '/tmp/flow-desk-desktop-token',
				'utf8',
			).trim();
			const assertion = readHumanAssertion(
				String(req.headers['x-flow-desk-human-assertion'] ?? ''),
				secret,
			);
			if (
				!(await Container.get(ProjectRecordRepository).claim(`human-nonce:${assertion.nonce}`, {
					actor: assertion.actor,
					issuedAt: assertion.issuedAt,
				}))
			) {
				res.status(409).json({ error: 'Human assertion already used' });
				return;
			}
			await this.service.bindDesktopOwner(assertion.actor);
			res.json(
				await this.service.humanOperation(assertion.actor, assertion.operation, assertion.input),
			);
		} catch (error) {
			res.status(400).json({ error: String(error) });
		}
	}
	@Get('/')
	async list(_req: Request, res: Response) {
		const root = path.join(
			path.dirname(process.env.FLOW_DESK_CONFIG ?? '/data/flow-desk/flow-desk.yaml'),
			'projects',
		);
		const entries = existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [];
		const projects = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name)) continue;
			const active = await this.service.configuration.active(entry.name);
			const candidate = await this.service.configuration.candidate(entry.name);
			projects.push({
				id: entry.name,
				name: active?.snapshot.config.name ?? candidate?.config.name ?? entry.name,
				configHash: active?.contentHash ?? null,
				candidateHash: candidate?.contentHash ?? null,
				flows: active ? Object.keys(active.snapshot.flows) : [],
			});
		}
		res.json({ projects });
	}
	@Post('/:projectId/candidate')
	async propose(req: Request, res: Response, @Param('projectId') projectId: string) {
		human(req);
		res.json(await this.service.propose(projectId, String(req.body?.flowId ?? '')));
	}
	@Get('/:projectId/candidate')
	async candidate(_req: Request, res: Response, @Param('projectId') projectId: string) {
		res.json(await this.service.configuration.candidate(projectId));
	}
	@Post('/:projectId/activate')
	async activate(req: Request, res: Response, @Param('projectId') projectId: string) {
		res.json(
			await this.service.configuration.approve(
				projectId,
				String(req.body?.contentHash ?? ''),
				human(req).id,
			),
		);
	}
	@Get('/runs/:runId/artifacts/:artifactId')
	async artifact(
		req: Request,
		res: Response,
		@Param('runId') runId: string,
		@Param('artifactId') artifactId: string,
	) {
		const run = await this.service.runtime.inspect(runId);
		if (!Object.values(run.snapshot.config.roles).flat().includes(human(req).id)) {
			res.sendStatus(403);
			return;
		}
		const response = await this.service.artifact(run.projectId, runId, artifactId);
		res.setHeader(
			'content-type',
			response.headers.get('content-type') ?? 'application/octet-stream',
		);
		res.send(Buffer.from(await response.arrayBuffer()));
	}
	@Post('/runs')
	async start(req: Request, res: Response) {
		const user = human(req);
		res.status(202).json(await this.service.launch(user, req.body));
	}
	@Post('/execute-node', { skipAuth: true })
	async execute(req: Request, res: Response) {
		if (!internalCredential(req)) {
			res.sendStatus(401);
			return;
		}
		res.json(await this.service.execute(req.body));
	}
	@Post('/tasks/:taskId/findings', { skipAuth: true })
	async createFinding(req: Request, res: Response, @Param('taskId') taskId: string) {
		if (!internalCredential(req)) {
			res.sendStatus(401);
			return;
		}
		const body = req.body as {
			identity: Record<string, unknown>;
			finding: Record<string, unknown>;
		};
		res.json(await this.service.runtime.createAgentTask(taskId, body.identity, body.finding));
	}
	@Post('/tasks/:taskId/result', { skipAuth: true })
	async receiveResult(req: Request, res: Response, @Param('taskId') taskId: string) {
		if (!internalCredential(req)) {
			res.sendStatus(401);
			return;
		}
		await this.service.runtime.complete(taskId, req.body);
		res.status(204).end();
	}
	@Post('/runs/:executionId/nodes/:nodeId/decision')
	async decide(
		req: Request,
		res: Response,
		@Param('executionId') executionId: string,
		@Param('nodeId') nodeId: string,
	) {
		res.json(
			await this.service.runtime.decide(executionId, nodeId, { ...req.body, actor: human(req).id }),
		);
	}
}

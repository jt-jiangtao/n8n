import { requireApplicationMcp } from '../application-mcp';
import { diagnosticComment } from './diagnostic-evidence';
import { workItemOperations } from './work-item-operations';
import { snapshotFromBundle } from './config-bundle';
import { configurationTrial } from './configuration-trial';
import { FlowDeskConfigService } from '../config/config.service';
import { ProjectMigrationService } from './project-migration';
import { gateResults, type VerificationEvidence } from './execution-policy';
import { platformActors } from './platform-actors';
import { parse } from 'yaml';
import { createRunExecutionData } from 'n8n-workflow';
import { Service, Container } from '@n8n/di';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { WorkflowEntity, type User, UserRepository, GLOBAL_OWNER_ROLE } from '@n8n/db';
import { WorkflowCreationService } from '@/workflows/workflow-creation.service';
import { WorkflowRunner } from '@/workflow-runner';
import { ExecutionPersistence } from '@/executions/execution-persistence';
import { WaitTracker } from '@/wait-tracker';
import { ProjectRecordRepository } from '../database/project-record.repository';
import { markForRerun, claimWaitingExecution } from '../tasks/resume-target';
import { ProjectRuntime, type Run, type NodeRecord } from './project-runtime';
import { ProjectConfigurationService } from './project-store';
import {
	bindProjectFlow,
	loadProjectSnapshot,
	contentDigest,
	type ProjectSnapshot,
} from './project-config';
import { nativeProjectFlow } from './native-flow';
import { readRef, type ParentRun } from './runtime-model';
@Service()
export class ProjectRuntimeService {
	readonly configuration: ProjectConfigurationService;
	readonly runtime: ProjectRuntime;
	readonly migration: ProjectMigrationService;
	constructor(private readonly records: ProjectRecordRepository) {
		this.configuration = new ProjectConfigurationService(records);
		const origin =
			process.env.FLOW_DESK_MODULE_CALLBACK_ORIGIN ??
			`http://127.0.0.1:${process.env.N8N_PORT ?? 5678}`;
		this.runtime = new ProjectRuntime(
			records,
			async (task) => {
				await this.runner('/project-tasks', task);
			},
			async (executionId, nodeId) => {
				const persistence = Container.get(ExecutionPersistence),
					execution = await persistence.findSingleExecution(executionId, {
						includeData: true,
						unflattenData: true,
					});
				if (execution && ['success', 'error', 'canceled', 'crashed'].includes(execution.status))
					return;
				if (!execution?.data || execution.status !== 'waiting')
					throw new Error('Result saved; execution is not waiting yet');
				if (nodeId) {
					const last = execution.data.resultData.lastNodeExecuted;
					const waitingNode = execution.workflowData.nodes.find((node) => node.name === last);
					if (waitingNode && waitingNode.id !== nodeId) return;
				}

				markForRerun(execution.data);
				await persistence.updateExistingExecution(executionId, { data: execution.data });
				await claimWaitingExecution(Container.get(WaitTracker), executionId);
			},
			origin,
			{
				approvalActors: async (_run, role) => await this.platformActors(role),
				configurationCandidate: async (run, result) => {
					const bundle = result.configBundle as {
						id?: string;
						sha256?: string;
						candidateSha?: string;
					};
					const evidence = result.evidence as Array<{ name: string; artifactHash: string }>;
					if (
						!bundle?.id ||
						bundle.candidateSha !== result.candidateSha ||
						!evidence?.some(
							(item) => item.name === 'project-config' && item.artifactHash === bundle.sha256,
						)
					)
						throw new Error('Configuration bundle is not bound to verification');
					const response = await this.runner(
						`/project-artifacts/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.rootRunId)}/${encodeURIComponent(bundle.id)}`,
					);
					if (!response.ok) throw new Error('Configuration bundle is unavailable');
					const bytes = Buffer.from(await response.arrayBuffer());
					if (createHash('sha256').update(bytes).digest('hex') !== bundle.sha256)
						throw new Error('Configuration bundle hash changed');
					const snapshot = snapshotFromBundle(JSON.parse(bytes.toString()), {
						projectId: run.projectId,
						candidateSha: String(result.candidateSha),
						flowId: run.flowId,
					});
					const historical = (await this.records.list<Run>('run:'))
						.filter(
							(item) =>
								item.projectId === run.projectId &&
								item.executionId !== run.executionId &&
								['passed', 'failed', 'canceled', 'blocked', 'timed-out', 'exceeded'].includes(
									item.status,
								),
						)
						.sort((a, b) => a.startedAt - b.startedAt)
						.slice(-20);
					const history = await Promise.all(
						historical.map(async (historic) => ({
							run: historic,
							records: (
								await Promise.all(
									historic.appliedTasks.map(
										async (id) => await this.records.read<NodeRecord>(`attempt:${id}`),
									),
								)
							).filter((item): item is NodeRecord => !!item),
						})),
					);
					const samples = [];
					for (const item of (result.configSamples ?? []) as Array<{
						artifact: { id: string; sha256: string; candidateSha: string };
					}>) {
						if (
							item.artifact.candidateSha !== result.candidateSha ||
							!evidence.some((row) => row.artifactHash === item.artifact.sha256)
						)
							throw new Error('Sample report is not bound to candidate verification');
						const response = await this.runner(
							`/project-artifacts/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.rootRunId)}/${encodeURIComponent(item.artifact.id)}`,
						);
						if (!response.ok) throw new Error('Real sample report unavailable');
						const bytes = Buffer.from(await response.arrayBuffer());
						if (createHash('sha256').update(bytes).digest('hex') !== item.artifact.sha256)
							throw new Error('Sample report hash changed');
						samples.push(JSON.parse(bytes.toString()));
					}
					const report = configurationTrial({
						candidate: snapshot,
						original: run.snapshot,
						candidateSha: String(result.candidateSha),
						history,
						samples,
					});
					await this.records.write(
						`project:validation:${run.projectId}:${report.validationHash}`,
						report,
					);
					await this.configuration.propose(snapshot);
					return {
						contentHash: snapshot.contentHash,
						validationHash: report.validationHash,
						report,
					};
				},
				activateConfiguration: async (run, hash, actor) => {
					await this.configuration.activateVersion(run.projectId, hash, actor, run.configHash);
				},
				launch: async (input) => {
					const parent = await this.records.read<{ userId: string }>(
						`execution-owner:${input.parent.executionId}`,
					);
					if (!parent) throw new Error('Missing parent execution owner');
					const user = await Container.get(UserRepository).findOne({
						where: { id: parent.userId },
						relations: ['role'],
					});
					if (!user || user.disabled) throw new Error('Missing human owner');
					return await this.launchSnapshot(user, input.snapshot, input.childId, {
						parent: input.parent,
						rootRunId: input.rootRunId,
						context: input.context,
						depth: input.depth,
					});
				},
				completed: async (parent, outcome) => {
					await this.runtime.childCompleted(
						parent.executionId,
						parent.nodeId,
						parent.childId,
						outcome,
					);
				},
				cancel: async (id) => {
					await this.records.write(`cancel-request:${id}`, { id, status: 'queued' });
					setImmediate(() => {
						void this.processCancellation(id);
					});
				},
				finalize: async (run) => {
					await this.runner('/project-runs/cancel', {
						projectId: run.projectId,
						runId: run.rootRunId,
						instanceId: origin,
					});
				},
				workItem: async (run, node, p, items) => await this.workItems(run, node, p, items),
				notify: async (run, node, p) => await this.notify(run, node, p),
				integration: async (subject, verification) => {
					if (
						subject.kind === 'managed-cli' &&
						!(await this.platformActors('platform.owner')).includes(String(subject.actor))
					)
						throw new Error('Only a platform owner can authorize CLI maintenance');
					if (subject.repoRef === 'project-config') {
						const validation = await this.records.read<{
							contentHash: string;
							candidateSha: string;
						}>(
							`project:validation:${String(subject.projectId)}:${String(subject.configValidationHash)}`,
						);
						if (
							!validation ||
							validation.contentHash !== subject.configCandidateHash ||
							validation.candidateSha !== subject.candidateSha
						)
							throw new Error('Approved configuration trial proof is unavailable or stale');
						const active = await this.configuration.active(String(subject.projectId));
						if (
							active?.contentHash !== subject.configHash &&
							active?.contentHash !== subject.configCandidateHash
						)
							throw new Error('Active project configuration changed before publication');
					}
					return {
						authorization: {
							payload: subject,
							mac: createHmac('sha256', this.runnerToken())
								.update(contentDigest(subject))
								.digest('hex'),
						},
						verification,
					};
				},
			},
		);
		this.migration = new ProjectMigrationService(records, this.configuration, {
			source: async (areaId, flowIds) => {
				if (!/^[a-z][a-z0-9-]{0,63}$/.test(areaId)) throw new Error('Invalid legacy area');
				const root = path.dirname(process.env.FLOW_DESK_CONFIG ?? '/data/flow-desk/flow-desk.yaml');
				const config = parse(readFileSync(path.join(root, 'flow-desk.yaml'), 'utf8')) as {
					areas: Record<string, unknown>;
				};
				if (!config.areas?.[areaId]) throw new Error('Unknown legacy area');
				const flows: Record<string, string> = {};
				for (const id of flowIds) {
					if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid legacy flow');
					flows[id] = readFileSync(path.join(root, 'flows', id + '.json'), 'utf8');
				}
				return { areaId, area: config.areas[areaId], flows };
			},
			publish: async (candidate, actor) => {
				const subject = {
					kind: 'project-migration',
					projectId: candidate.projectId,
					filesHash: contentDigest(candidate.files),
					sourceHash: candidate.sourceHash,
					actor,
					decisionId: candidate.contentHash,
				};
				const response = await this.runner('/project-migrations/publish', {
					projectId: candidate.projectId,
					files: candidate.files,
					source: candidate.source,
					authorization: {
						payload: subject,
						mac: createHmac('sha256', this.runnerToken())
							.update(contentDigest(subject))
							.digest('hex'),
					},
				});
				if (!response.ok) throw new Error('Reviewed migration publication failed');
				return (await response.json()) as { sha: string };
			},
			trial: async (snapshot, flowId) => {
				const owner = await Container.get(UserRepository).findOne({
					where: { role: { slug: GLOBAL_OWNER_ROLE.slug } },
					relations: ['role'],
				});
				if (!owner || owner.disabled) throw new Error('Local workflow owner unavailable');
				const bound = bindProjectFlow(snapshot, flowId, {});
				const result = await this.launchSnapshot(owner, bound, randomUUID(), {
					context: { migrationTrial: true },
				});
				await this.records.write(`migration:trial:${result.runId}`, { snapshot: bound });
				return result;
			},
			inspect: async (id) => await this.inspectMigrationTrial(id),
			verify: (node) => {
				const checks = [
					...((node.dispatch?.suites ?? []) as Array<{ name: string; repeat?: number }>),
					...(node.dispatch?.managedCli ? [{ name: 'managed-cli' }] : []),
					...(node.dispatch?.browser ? [{ name: 'browser' }] : []),
				];
				const evidence = node.result.evidence as Array<
					VerificationEvidence & { artifact?: { taskId?: string } }
				>;
				if (
					!Array.isArray(evidence) ||
					evidence.some((item) => item.artifact?.taskId !== node.taskId)
				)
					throw new Error('Migration trial artifact belongs to another task');
				const evidenceHash = gateResults(evidence, checks, {
					candidateSha: String(node.dispatch?.candidateSha),
					configHash: node.configHash,
				}).evidenceHash;
				const receipt = node.result.verification as {
					payload: {
						projectId: string;
						runId: string;
						configHash: string;
						candidateSha: string;
						evidenceHash: string;
					};
					mac: string;
				};
				if (
					!receipt?.payload ||
					receipt.payload.evidenceHash !== evidenceHash ||
					receipt.payload.projectId !== node.projectId ||
					receipt.payload.runId !== node.runId ||
					receipt.payload.configHash !== node.configHash ||
					receipt.payload.candidateSha !== node.dispatch?.candidateSha ||
					createHmac('sha256', this.runnerToken())
						.update(contentDigest(receipt.payload))
						.digest('hex') !== receipt.mac
				)
					throw new Error('Migration trial verification signature is invalid');
			},
		});
	}
	private cancellations = new Set<string>();
	private async inspectMigrationTrial(id: string): Promise<{
		run: Pick<Run, 'executionId' | 'projectId' | 'flowId' | 'configHash' | 'status' | 'failures'>;
		nodes: (NodeRecord | null)[];
		source: string;
	}> {
		try {
			return {
				run: await this.runtime.inspect(id),
				nodes: await this.runtime.nodes(id),
				source: 'project-runtime',
			};
		} catch (error) {
			const meta = await this.records.read<{ snapshot: ProjectSnapshot }>(`migration:trial:${id}`);
			if (!meta) throw error;
			const native = await Container.get(ExecutionPersistence).findSingleExecution(id, {
				includeData: false,
			});
			const status =
				native?.status === 'canceled'
					? 'canceled'
					: !native || ['success', 'error', 'crashed'].includes(native.status)
						? 'failed'
						: 'queued';
			return {
				run: {
					executionId: id,
					projectId: meta.snapshot.projectId,
					flowId: meta.snapshot.flowId,
					configHash: meta.snapshot.contentHash,
					status,
					failures: status === 'failed' ? { native: 'missing-verified-run' } : {},
				},
				nodes: [],
				source: 'native-persistence',
			};
		}
	}
	private async platformActors(role: string) {
		return await platformActors(
			this.records,
			Container.get(FlowDeskConfigService).resolveRole(role, ''),
		);
	}
	/** Called only after the Plane bridge verifies the signed workspace-owner assertion. */
	async bindDesktopOwner(actor: string) {
		if (!actor || ['agent-bot', 'flow-desk', 'system'].includes(actor))
			throw new Error('Verified desktop owner required');
		await this.records.claim('platform:desktop-owner', { actor });
	}
	private migrationPolls = new Map<string, Promise<unknown>>();
	private async processCancellation(id: string) {
		if (this.cancellations.has(id)) return;
		this.cancellations.add(id);
		try {
			const owner = await this.records.read<{ executionId: string }>(`launch-owner:${id}`),
				executionId = owner?.executionId ?? id;
			if (!owner && !(await this.records.read(`run:${id}`))) {
				if (await this.records.read(`launch:${id}`))
					throw new Error('Child launch handoff is still pending');
				await this.records.write(`cancel-request:${id}`, {
					id,
					status: 'passed',
					reason: 'No child execution was launched',
				});
				return;
			}
			await this.runtime.cancel(executionId, false);
			const execution = await Container.get(ExecutionPersistence).findSingleExecution(executionId, {
				includeData: false,
			});
			if (execution && !['success', 'error', 'canceled', 'crashed'].includes(execution.status)) {
				const { ExecutionService } = await import('@/executions/execution.service.js');
				await Container.get(ExecutionService).stop(executionId, [execution.workflowId!]);
			}
			await this.records.write(`cancel-request:${id}`, { id, status: 'passed' });
		} catch (error) {
			await this.records
				.write(`cancel-request:${id}`, { id, status: 'failed', error: String(error) })
				.catch(() => undefined);
		} finally {
			this.cancellations.delete(id);
		}
	}
	private watchTimer?: ReturnType<typeof setInterval>;
	private reconciling = false;
	startWatching() {
		if (this.watchTimer) return;
		this.watchTimer = setInterval(() => {
			void this.reconcile();
		}, 5000);
		this.watchTimer.unref();
	}
	stopWatching() {
		if (this.watchTimer) clearInterval(this.watchTimer);
		this.watchTimer = undefined;
	}
	private async reconcile() {
		if (this.reconciling) return;
		this.reconciling = true;
		try {
			for (const job of await this.records.list<{
				jobId: string;
				actor: string;
				contentHash?: string;
				error?: string;
			}>('migration:prepare:'))
				if (!job.contentHash && !job.error) {
					try {
						await this.humanOperation(job.actor, 'migration-preparing', { jobId: job.jobId });
					} catch (error) {
						await this.records.write(`migration:prepare:${job.jobId}`, {
							...job,
							status: 'failed',
							error: String(error),
						});
					}
				}
			for (const request of await this.records.list<{ id: string; status: string }>(
				'cancel-request:',
			))
				if (request.status !== 'passed') await this.processCancellation(request.id);
			for (const run of await this.records.list<Run>('run:')) {
				if (run.status === 'running') {
					const execution = await Container.get(ExecutionPersistence).findSingleExecution(
						run.executionId,
						{ includeData: false },
					);
					if (execution && ['success', 'error', 'canceled', 'crashed'].includes(execution.status))
						await this.runtime.terminate(
							run.executionId,
							execution.status === 'canceled' ? 'canceled' : 'failed',
							'Native execution ended without a verified Finish',
						);
					else if (
						Date.now() - run.startedAt >
						(run.snapshot.flow.limits?.maxDurationMs ?? 7200000)
					)
						await this.runtime.terminate(
							run.executionId,
							'exceeded',
							'Project execution time budget exhausted',
						);
					else await this.runtime.resumePending(run.executionId);
				} else if (run.cleanup?.status === 'failed')
					await this.runtime.resumePending(run.executionId);
			}
		} catch (error) {
			await this.records
				.write('runtime:last-recovery-error', {
					error: String(error),
					at: new Date().toISOString(),
				})
				.catch(() => undefined);
		} finally {
			this.reconciling = false;
		}
	}

	private runnerToken() {
		return (
			process.env.FLOW_DESK_RUNNER_TOKEN ??
			readFileSync(
				process.env.FLOW_DESK_RUNNER_TOKEN_FILE ?? '/tmp/flow-desk-runner-token',
				'utf8',
			).trim()
		);
	}
	private async runner(route: string, body?: unknown) {
		if ((body as { actionDriverMcp?: unknown } | undefined)?.actionDriverMcp)
			await requireApplicationMcp(
				process.env.FLOW_DESK_RUNNER_URL ?? 'http://host.docker.internal:39201',
				this.runnerToken(),
			);
		const response = await fetch(
			`${process.env.FLOW_DESK_RUNNER_URL ?? 'http://host.docker.internal:39201'}${route}`,
			{
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${this.runnerToken()}`,
					'content-type': 'application/json',
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30000),
			},
		);
		if (!response.ok) throw new Error(`Runner request failed: ${response.status}`);
		return response;
	}
	private async plane(route: string, body?: unknown) {
		const response = await fetch(
			`${process.env.FLOW_DESK_PLANE_URL ?? 'http://api:8000'}/api/flow-desk/internal${route}`,
			{
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${process.env.FLOW_DESK_SERVICE_TOKEN ?? ''}`,
					'content-type': 'application/json',
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(15000),
			},
		);
		if (!response.ok)
			throw new Error(
				`Plane request failed: ${response.status}: ${(await response.text()).slice(0, 300)}`,
			);
		return (await response.json()) as Record<string, unknown>;
	}
	private async workItems(run: Run, node: NodeRecord, p: Record<string, unknown>, items: unknown) {
		const project = run.snapshot.config.defaults?.planeProject;
		if (typeof project !== 'string' || !project)
			throw new Error('Project Plane binding is missing');
		if (p.operation === 'create-parent') {
			const parent = await this.plane('/issues/', {
				project,
				title: String(run.snapshot.params.title ?? `${run.snapshot.config.name} / ${run.flowId}`),
				sourceKey: `${run.projectId}:${run.runId}:parent`,
				labels: [`flow:${run.flowId}`],
			});
			const tasks = await this.plane(`/issues/?project=${encodeURIComponent(project)}`);
			return { ...parent, openTasks: tasks.items };
		}
		if (p.operation === 'update' || p.operation === 'link') {
			const operations = workItemOperations(project, run.runId, node.nodeId, p, items);
			const receipts = [];
			for (const operation of operations)
				receipts.push(await this.plane(operation.route, operation.body));
			return { items: receipts };
		}
		if (p.operation !== 'create') throw new Error('Unsupported work item operation');

		if (!Array.isArray(items)) throw new Error('Work item input must be a list');
		const { validateFinding } = await import('../work-items/work-item.js');
		const findings = items.map((item) => {
			const result = validateFinding(item);
			if (!result.ok) throw new Error(result.reason);
			return result.value;
		});
		const created = [];
		const diagnosticHtml = await diagnosticComment(run, async (url) => await this.runner(url));
		for (const item of findings) {
			const evidence = [];
			for (const image of item.evidence as Array<{ kind: string; name?: string; url?: string }>) {
				const id = String(image.url ?? '').replace(/^artifact:/, '');
				const response = await this.runner(
					`/project-artifacts/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.rootRunId)}/${encodeURIComponent(id)}`,
				);
				await response.body?.cancel();
				if (
					!(item.kind === 'code'
						? response.headers.get('content-type')?.startsWith('application/json')
						: response.headers.get('content-type')?.startsWith('image/')) ||
					response.headers.get('x-flow-desk-candidate-sha') !== run.context.candidateSha
				)
					throw new Error('Finding evidence is outside the verified candidate');
				evidence.push({
					...image,
					artifactUri: image.url,
					url: `/api/flow-desk/desktop/project-artifacts/${encodeURIComponent(run.runId)}/${encodeURIComponent(id)}/`,
				});
			}
			const receipt = await this.plane('/issues/', {
				...item,
				evidence,
				labels: Array.isArray(item.labels) ? item.labels : [String(item.labels)],
				project,
				parentId: run.context.parentIssueId,
				sourceKey: `${run.projectId}:${run.runId}:finding:${contentDigest({ kind: item.kind ?? 'ui', title: item.title, page: item.page ?? '', reproduction: item.reproduction })}`,
			});
			if (diagnosticHtml)
				await this.plane(`/issues/${encodeURIComponent(String(receipt.id))}/comments/`, {
					comment: diagnosticHtml,
					sourceKey: `${run.runId}:finding:${contentDigest({ title: item.title, page: item.page ?? '', reproduction: item.reproduction })}:diagnostics`,
				});
			created.push({ ...item, evidence, ...receipt });
		}
		return { items: created };
	}
	private async notify(run: Run, node: NodeRecord, p: Record<string, unknown>) {
		const channels = Array.isArray(p.channels) ? p.channels : ['plane'];
		const receipts = [];
		const resultsRef = p.itemsRef ? readRef(run.context, String(p.itemsRef)) : undefined;
		const issues = Array.isArray(resultsRef) ? resultsRef : [{ id: run.context.parentIssueId }];
		for (const channel of channels) {
			const saved = await this.records.read(`notice:${node.taskId}:${channel}`);
			if (saved) {
				receipts.push(saved);
				continue;
			}
			let receipt: Record<string, unknown>;
			if (channel === 'plane') {
				for (const issue of issues) {
					const id = String((issue as { id?: string }).id ?? '');
					if (!id) throw new Error('Notification issue identity missing');
					await this.plane(`/issues/${encodeURIComponent(id)}/comments/`, {
						comment: String(p.message ?? 'Flow Desk 任务已更新'),
						sourceKey: node.taskId,
					});
				}
				receipt = { channel, status: 'passed' };
			} else if (channel === 'feishu') {
				const base = process.env.FLOW_DESK_REMOTE_FEISHU_URL;
				if (!base) {
					if (p.required !== false) throw new Error('Required Feishu channel is not configured');
					receipt = { channel, status: 'skipped', reason: 'not configured' };
				} else {
					const response = await fetch(`${base}/notifications`, {
						method: 'POST',
						headers: {
							authorization: `Bearer ${process.env.FLOW_DESK_RELAY_TOKEN ?? ''}`,
							'content-type': 'application/json',
						},
						body: JSON.stringify({
							workItemId: String((issues[0] as { id?: string })?.id ?? run.context.parentIssueId),
							title: String(p.message ?? 'Flow Desk 任务已更新'),
							buttons: [],
						}),
						signal: AbortSignal.timeout(15000),
					});
					if (!response.ok) throw new Error('Required Feishu delivery failed');
					receipt = { channel, status: 'passed' };
				}
			} else throw new Error('Unknown notification channel');
			await this.records.write(`notice:${node.taskId}:${channel}`, receipt);
			receipts.push(receipt);
		}
		return { receipts };
	}
	async propose(projectId: string, flowId: string) {
		return await this.configuration.propose(
			loadProjectSnapshot({
				root: path.dirname(process.env.FLOW_DESK_CONFIG ?? '/data/flow-desk/flow-desk.yaml'),
				projectId,
				flowId,
			}),
		);
	}
	async launch(
		user: User,
		input: {
			projectId: string;
			flowId: string;
			params?: Record<string, unknown>;
			retryOf?: string;
		},
	) {
		const active = await this.configuration.active(input.projectId);
		if (!active) throw new Error('Project configuration has not been approved');
		let options: { context?: Record<string, unknown> } = {};
		if (input.retryOf) {
			const previous = await this.runtime.inspect(input.retryOf);
			if (
				previous.projectId !== input.projectId ||
				previous.flowId !== input.flowId ||
				previous.configHash !== active.contentHash ||
				!['failed', 'canceled'].includes(previous.status)
			)
				throw new Error(
					'Retry requires a failed or canceled run of the same approved project and flow',
				);
			options = {
				context: {
					retryOf: input.retryOf,
					browserSpaceId:
						previous.context.browserSpaceId ??
						(previous.context.browserObservation as { spaceId?: number })?.spaceId,
				},
			};
		} else options = await this.onboardingBrowser(active.snapshot);
		try {
			return await this.launchSnapshot(
				user,
				bindProjectFlow(active.snapshot, input.flowId, input.params),
				randomUUID(),
				options,
			);
		} catch (error) {
			const jobId = active.snapshot.config.defaults?.onboardingJobId;
			if (
				!input.retryOf &&
				options.context?.browserSpaceId !== undefined &&
				typeof jobId === 'string'
			)
				await this.records.delete(`onboard-browser:${jobId}`);
			throw error;
		}
	}
	private async launchSnapshot(
		user: User,
		snapshot: ProjectSnapshot,
		launchId: string,
		options: {
			parent?: ParentRun;
			rootRunId?: string;
			context?: Record<string, unknown>;
			depth?: number;
		} = {},
	) {
		const owner = await this.records.read<{ executionId: string }>(`launch-owner:${launchId}`);
		if (owner)
			return {
				runId: owner.executionId,
				executionId: owner.executionId,
				configHash: snapshot.contentHash,
			};
		const saved = await this.records.read(`launch:${launchId}`);
		if (!saved)
			await this.records.write(`launch:${launchId}`, { snapshot, options, userId: user.id });
		const workflow = await Container.get(WorkflowCreationService).createWorkflow(
			user,
			Object.assign(new WorkflowEntity(), nativeProjectFlow(snapshot.projectId, snapshot.flow)),
		);
		const trigger = workflow.nodes.find(
			(node) => node.id === snapshot.flow.nodes.find((node) => node.type === 'start')!.id,
		)!;
		const executionId = await Container.get(WorkflowRunner).run({
			executionMode: 'integrated',
			workflowData: workflow,
			userId: user.id,
			executionData: createRunExecutionData({
				startData: {},
				resultData: { runData: {} },
				executionData: {
					contextData: {},
					metadata: {},
					nodeExecutionStack: [
						{
							node: trigger,
							data: {
								main: [
									[{ json: { projectId: snapshot.projectId, flowId: snapshot.flowId, launchId } }],
								],
							},
							source: null,
						},
					],
					waitingExecution: {},
					waitingExecutionSource: {},
				},
			}),
		});
		await this.records.write(`execution-owner:${executionId}`, { userId: user.id });
		return {
			runId: executionId,
			executionId,
			workflowId: workflow.id,
			configHash: snapshot.contentHash,
		};
	}
	async execute(input: {
		executionId: string;
		nodeId: string;
		projectId: string;
		flowId: string;
		type: string;
		input?: Record<string, unknown>;
		invocationId?: string;
	}) {
		if (await this.records.read(`migration:cancel:${input.executionId}`)) {
			if (await this.records.read(`run:${input.executionId}`))
				await this.runtime.cancel(input.executionId);
			throw new Error('Migration trial cancellation requested');
		}
		if (input.type === 'start') {
			const launchId = String(input.input?.launchId ?? '');
			if (!/^[a-f0-9-]{36}$/.test(launchId)) throw new Error('Missing project launch identity');
			const launch = await this.records.read<{
				snapshot: ProjectSnapshot;
				options: {
					parent?: ParentRun;
					rootRunId?: string;
					context?: Record<string, unknown>;
					depth?: number;
				};
				userId: string;
			}>(`launch:${launchId}`);
			if (
				!launch ||
				launch.snapshot.projectId !== input.projectId ||
				launch.snapshot.flowId !== input.flowId
			)
				throw new Error('Invalid project launch');
			const owner = await this.records.read<{ executionId: string }>(`launch-owner:${launchId}`);
			if (owner && owner.executionId !== input.executionId)
				throw new Error('Launch belongs to another execution');
			if (
				!owner &&
				!(await this.records.claim(`launch-owner:${launchId}`, { executionId: input.executionId }))
			)
				throw new Error('Concurrent project launch');
			await this.records.write(`execution-owner:${input.executionId}`, { userId: launch.userId });
			await this.runtime.start(input.executionId, launch.snapshot, launch.options);
		}
		return await this.runtime.executeNode(input);
	}
	async humanOperation(
		actor: string,
		operation: string,
		input: Record<string, unknown>,
		migrationPoll = false,
	): Promise<unknown> {
		if (operation === 'migration-preparing' && !migrationPoll) {
			const key = actor + ':' + String(input.jobId),
				pending = this.migrationPolls.get(key);
			if (pending) return await pending;
			const action = this.humanOperation(actor, operation, input, true);
			this.migrationPolls.set(key, action);
			try {
				return await action;
			} finally {
				this.migrationPolls.delete(key);
			}
		}
		if (operation.startsWith('migration-')) {
			if (!(await this.platformActors('platform.owner')).includes(actor))
				throw new Error('Platform owner required for legacy migration');
			const projectId = String(input.projectId ?? ''),
				hash = String(input.contentHash ?? '');
			if (operation === 'migration-prepare') {
				const jobId = randomUUID(),
					job = { jobId, projectId, areaId: String(input.areaId ?? ''), actor };
				await this.runner('/project-migrations/prepare', job);
				await this.records.write(`migration:prepare:${jobId}`, job);
				return { jobId };
			}
			if (operation === 'migration-preparing' || operation === 'migration-cancel') {
				const id = String(input.jobId ?? ''),
					job = await this.records.read<{
						actor: string;
						projectId: string;
						areaId: string;
						contentHash?: string;
						error?: string;
						status?: string;
					}>(`migration:prepare:${id}`);
				if (!job || job.actor !== actor) throw new Error('Unknown migration preparation');
				if (operation === 'migration-cancel') {
					await this.runner('/tasks/abort', { taskId: id });
					return { status: 'cancel-requested' };
				}
				if (job.error) return { status: job.status ?? 'failed', error: job.error };
				if (job.contentHash)
					return {
						status: 'candidate-ready',
						projectId: job.projectId,
						contentHash: job.contentHash,
					};
				const response = await this.runner(`/project-migrations/jobs/${encodeURIComponent(id)}`),
					state = (await response.json()) as {
						status: string;
						error?: string;
						result?: {
							sourceHash: string;
							flowId: string;
							files: Record<string, string>;
							mapping: Record<string, string>;
						};
					};
				if (state.status === 'generated' && state.result) {
					try {
						const candidate = await this.migration.propose({
							projectId: job.projectId,
							areaId: job.areaId,
							flowId: state.result.flowId,
							files: state.result.files,
							mapping: state.result.mapping,
							expectedSourceHash: state.result.sourceHash,
						});
						await this.records.write(`migration:prepare:${id}`, {
							...job,
							contentHash: candidate.contentHash,
						});
						return {
							status: 'candidate-ready',
							projectId: job.projectId,
							contentHash: candidate.contentHash,
						};
					} catch (error) {
						await this.records.write(`migration:prepare:${id}`, { ...job, error: String(error) });
						return { status: 'failed', error: String(error) };
					}
				}
				if (['failed', 'canceled'].includes(state.status))
					await this.records.write(`migration:prepare:${id}`, {
						...job,
						status: state.status,
						error: state.error ?? 'Migration preparation canceled',
					});
				return { status: state.status, error: state.error };
			}
			if (operation === 'migration-propose')
				return await this.migration.propose({
					projectId,
					areaId: String(input.areaId ?? ''),
					flowId: String(input.flowId ?? ''),
					mapping: input.mapping as Record<string, string>,
					files: input.files as Record<string, string>,
				});
			if (operation === 'migration-candidate') return await this.migration.candidate(projectId);
			if (operation === 'migration-trial')
				return await this.migration.trial(projectId, hash, String(input.flowId ?? ''));
			if (operation === 'migration-trials') {
				const candidate = await this.migration.candidate(projectId);
				if (!candidate || candidate.contentHash !== hash)
					throw new Error('Migration candidate changed');
				const ids = [...new Set(Object.values(candidate.mapping))];
				if (
					ids.length > 32 ||
					ids.some((id) => !candidate.snapshot.flows[id]?.nodes.some((n) => n.type === 'verify'))
				)
					throw new Error('Every migrated flow requires real verification');
				const trials = [];
				for (const id of ids) trials.push(await this.migration.trial(projectId, hash, id));
				return { trials };
			}
			if (operation === 'migration-activate')
				return await this.migration.activate(projectId, hash, actor);
			if (operation === 'migration-rollback')
				return await this.migration.rollback(projectId, hash, actor);
			throw new Error('Unknown migration operation');
		}
		if (operation === 'start' && !input.projectId && input.areaId) {
			const route = await this.migration.resolve(
				String(input.areaId),
				String(input.flowType ?? ''),
			);
			if (!route) throw new Error('Legacy area has no activated project migration');
			input = { ...input, ...route };
		}
		if (operation === 'onboard') {
			const projectId = String(input.projectId ?? '');
			if (!/^[a-z][a-z0-9-]{0,63}$/.test(projectId) || typeof input.repo !== 'string')
				throw new Error('Project id and repository path required');
			const jobId = randomUUID(),
				job = { jobId, projectId, actor, repo: input.repo, status: 'queued' };
			await this.records.write(`onboard:${jobId}`, job);
			setImmediate(() => {
				void this.startOnboardingJob(job);
			});
			return { jobId, status: 'running' };
		}
		if (operation === 'onboarding') {
			const jobId = String(input.jobId),
				job = await this.records.read<{
					jobId: string;
					repo: string;
					actor: string;
					projectId: string;
					status: string;
					planeProject?: string;
					error?: string;
				}>(`onboard:${jobId}`);
			if (!job || job.actor !== actor) throw new Error('Unknown onboarding job');
			if (job.status === 'failed') return { status: 'failed', error: job.error };
			if (!job.planeProject) {
				setImmediate(() => {
					void this.startOnboardingJob(job);
				});
				return { status: 'running' };
			}
			let value: Record<string, unknown>;
			try {
				const response = await this.runner(`/project-onboarding/${encodeURIComponent(jobId)}`);
				value = (await response.json()) as Record<string, unknown>;
			} catch {
				setImmediate(() => {
					void this.startOnboardingJob(job);
				});
				return { status: 'running' };
			}
			if (value.status === 'candidate-ready') {
				const current = await this.configuration.candidate(job.projectId);
				if (!current) await this.propose(job.projectId, 'ui-audit');
			}
			return value;
		}
		if (operation === 'artifact') {
			const job = await this.records.read<{ actor: string; projectId: string }>(
				`onboard:${String(input.runId)}`,
			);
			if (job) {
				if (job.actor !== actor) throw new Error('Project owner required');
				const response = await this.runner(
					`/project-artifacts/${encodeURIComponent(job.projectId)}/${encodeURIComponent(String(input.runId))}/${encodeURIComponent(String(input.artifactId))}`,
				);
				return {
					mimeType: response.headers.get('content-type'),
					base64: Buffer.from(await response.arrayBuffer()).toString('base64'),
				};
			}
		}

		const projectId = String(input.projectId ?? '');
		if (operation === 'list') {
			const { readdirSync, existsSync } = await import('node:fs');
			const directory = path.join(
				path.dirname(process.env.FLOW_DESK_CONFIG ?? '/data/flow-desk/flow-desk.yaml'),
				'projects',
			);
			const projects = [];
			const candidateIds = (await this.records.list<ProjectSnapshot>('project:candidate:')).map(
				(s) => s.projectId,
			);
			const entries = new Set([
				...(existsSync(directory)
					? readdirSync(directory, { withFileTypes: true })
							.filter((e) => e.isDirectory())
							.map((e) => e.name)
					: []),
				...candidateIds,
			]);
			for (const name of entries) {
				const entry = { name };
				const active = await this.configuration.active(entry.name),
					candidate = await this.configuration.candidate(entry.name),
					config = active?.snapshot.config ?? candidate?.config;
				if (!config || !Object.values(config.roles).flat().includes(actor)) continue;
				projects.push({
					id: entry.name,
					name: config.name,
					flows: active
						? Object.keys(active.snapshot.flows)
								.filter((id) => active.snapshot.flows[id].exposure !== 'test-only')
								.map((id) => ({
									id,
									name: id,
									parameters: active.snapshot.flows[id].parameters,
								}))
						: [],
					configHash: active?.contentHash,
					candidateHash: candidate?.contentHash,
					migration: await this.migration.status(entry.name),
				});
			}
			const legacyAreas = [];
			if ((await this.platformActors('platform.owner')).includes(actor)) {
				const raw = parse(
					readFileSync(process.env.FLOW_DESK_CONFIG ?? '/data/flow-desk/flow-desk.yaml', 'utf8'),
				) as { areas?: Record<string, unknown> };
				for (const id of Object.keys(raw.areas ?? {})) {
					const route = await this.records.read<{ status: string }>(`migration:area:${id}`);
					if (route?.status !== 'active') legacyAreas.push({ id, name: id });
				}
			}
			return { projects, legacyAreas };
		}
		if (operation === 'propose') {
			const candidate = loadProjectSnapshot({
				root: path.dirname(process.env.FLOW_DESK_CONFIG ?? '/data/flow-desk/flow-desk.yaml'),
				projectId,
				flowId: String(input.flowId ?? ''),
			});
			if (!candidate.config.roles.owner?.includes(actor)) throw new Error('Project owner required');
			return await this.configuration.propose(candidate);
		}
		if (operation === 'candidate' || operation === 'activate') {
			const candidate = await this.configuration.candidate(projectId);
			if (!candidate) throw new Error('Project candidate is unavailable');
			const active = await this.configuration.active(projectId);
			if (!(active?.snapshot ?? candidate)?.config.roles.owner?.includes(actor))
				throw new Error('Project owner required');
			return operation === 'candidate'
				? await this.candidateWithEvidence(candidate)
				: await this.configuration.approve(projectId, String(input.contentHash ?? ''), actor);
		}
		if (operation === 'start') {
			const active = await this.configuration.active(projectId);
			if (!active || !Object.values(active.snapshot.config.roles).flat().includes(actor))
				throw new Error('Project role required');
			const owner = await Container.get(UserRepository).findOne({
				where: { role: { slug: GLOBAL_OWNER_ROLE.slug } },
				relations: ['role'],
			});
			if (!owner || owner.disabled) throw new Error('Local workflow owner is unavailable');
			return await this.launch(owner, {
				projectId,
				flowId: String(input.flowId),
				params: input.params as Record<string, unknown> | undefined,
				retryOf: typeof input.retryOf === 'string' ? input.retryOf : undefined,
			});
		}
		const trialJob =
			operation === 'artifact'
				? await this.records.read<{ actor: string; projectId: string }>(
						`onboard:${String(input.runId ?? '')}`,
					)
				: null;
		if (trialJob) {
			if (trialJob.actor !== actor) throw new Error('Onboarding human owner required');
			const response = await this.runner(
				`/project-artifacts/${encodeURIComponent(trialJob.projectId)}/${encodeURIComponent(String(input.runId))}/${encodeURIComponent(String(input.artifactId))}`,
			);
			return {
				mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
				base64: Buffer.from(await response.arrayBuffer()).toString('base64'),
			};
		}
		if (operation === 'artifact' && /^scan_[a-f0-9]{32}$/.test(String(input.runId ?? ''))) {
			const response = await this.legacyArtifact(String(input.runId), String(input.artifactId));
			if (!response.ok) throw new Error('Scan artifact is unavailable');
			return {
				mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
				base64: Buffer.from(await response.arrayBuffer()).toString('base64'),
			};
		}
		const migrationMeta = await this.records.read<{ snapshot: ProjectSnapshot }>(
			`migration:trial:${String(input.runId ?? '')}`,
		);
		if (migrationMeta && ['inspect', 'cancel'].includes(operation)) {
			if (!Object.values(migrationMeta.snapshot.config.roles).flat().includes(actor))
				throw new Error('Project role required');
			const id = String(input.runId),
				state = await this.inspectMigrationTrial(id);
			if (operation === 'inspect')
				return {
					...state.run,
					runId: id,
					source: state.source,
					nodes: state.nodes.filter(Boolean).map((node) => ({
						...node,
						name:
							migrationMeta.snapshot.flow.nodes.find((def) => def.id === node!.nodeId)?.name ??
							node!.nodeId,
					})),
				};
			if (
				['passed', 'failed', 'canceled', 'blocked', 'timed-out', 'exceeded'].includes(
					state.run.status,
				)
			)
				return { status: state.run.status, alreadyTerminal: true };
			await this.records.write(`migration:cancel:${id}`, { actor, requestedAt: Date.now() });
			if (await this.records.read(`run:${id}`)) await this.runtime.cancel(id);
			const native = await Container.get(ExecutionPersistence).findSingleExecution(id, {
				includeData: false,
			});
			if (native && !['success', 'error', 'canceled', 'crashed'].includes(native.status)) {
				const { ExecutionService } = await import('@/executions/execution.service.js');
				await Container.get(ExecutionService).stop(id, [native.workflowId!]);
			}
			return { status: 'cancel-requested' };
		}
		const runId = String(input.runId ?? ''),
			run = await this.runtime.inspect(runId);
		if (!Object.values(run.snapshot.config.roles).flat().includes(actor))
			throw new Error('Project role required');
		if (operation === 'artifact') {
			const response = await this.artifact(run.projectId, runId, String(input.artifactId));
			const bytes = Buffer.from(await response.arrayBuffer()),
				mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
			return mimeType.startsWith('image/')
				? { mimeType, base64: bytes.toString('base64') }
				: { mimeType, text: bytes.toString('utf8') };
		}
		if (operation === 'inspect')
			return {
				runId,
				status: run.status,
				context: run.context,
				cleanup: run.cleanup,
				nodes: (await this.runtime.nodes(runId))
					.filter((node): node is NodeRecord => node !== null)
					.map((node) => ({
						...node,
						name:
							run.snapshot.flow.nodes.find((definition) => definition.id === node.nodeId)?.name ??
							node.nodeId,
					})),
			};
		if (operation === 'decision')
			return await this.runtime.decide(runId, String(input.nodeId), {
				actor,
				digest: String(input.digest),
				decision: input.decision as 'approve' | 'reject',
				selectedIds: input.selectedIds as string[] | undefined,
			});
		if (operation === 'cancel') return await this.runtime.cancel(runId);
		throw new Error('Unknown human project operation');
	}
	private onboardingDispatch = new Set<string>();
	private async startOnboardingJob(job: {
		jobId: string;
		projectId: string;
		actor: string;
		repo: string;
		planeProject?: string;
	}) {
		if (this.onboardingDispatch.has(job.jobId)) return;
		this.onboardingDispatch.add(job.jobId);
		try {
			const planeProject =
				job.planeProject ??
				String(
					(await this.plane('/projects/', { projectId: job.projectId, name: job.projectId }))
						.identifier,
				);
			const input = {
				jobId: job.jobId,
				projectId: job.projectId,
				actor: job.actor,
				repo: job.repo,
				planeProject,
			};
			await this.records.write(`onboard:${job.jobId}`, { ...input, status: 'running' });
			await this.runner('/project-onboarding', input);
		} catch (error) {
			await this.records.write(`onboard:${job.jobId}`, {
				...job,
				status: 'failed',
				error: String(error),
			});
		} finally {
			this.onboardingDispatch.delete(job.jobId);
		}
	}

	private async candidateWithEvidence(candidate: ProjectSnapshot) {
		const migration = await this.migration.candidate(candidate.projectId);
		if (migration?.snapshot.contentHash === candidate.contentHash) {
			const trials = await Promise.all(
				migration.trials.map(async (runId) => {
					try {
						const { run } = await this.inspectMigrationTrial(runId);
						return { runId, flowId: run.flowId, status: run.status };
					} catch {
						return { runId, flowId: '', status: 'failed', error: 'Trial record unavailable' };
					}
				}),
			);
			const latest = new Map<string, string>();
			for (const trial of trials) if (trial.flowId) latest.set(trial.flowId, trial.status);
			const ready = Object.values(migration.mapping).every((id) => latest.get(id) === 'passed');
			return { ...candidate, migration: { ...migration, trials, ready } };
		}
		const jobId = candidate.config.defaults?.onboardingJobId;
		if (typeof jobId !== 'string') return candidate;
		const response = await this.runner(`/project-onboarding/${encodeURIComponent(jobId)}`),
			job = (await response.json()) as { result?: Record<string, unknown> };
		return { ...candidate, onboarding: job.result };
	}
	private async onboardingBrowser(snapshot: ProjectSnapshot) {
		const id = snapshot.config.defaults?.onboardingJobId;
		if (typeof id !== 'string') return {};
		if (!(await this.records.claim(`onboard-browser:${id}`, { claimedAt: Date.now() }))) return {};
		const response = await this.runner(`/project-onboarding/${encodeURIComponent(id)}`),
			job = (await response.json()) as {
				result?: { trial?: { browserObservation?: { spaceId: number } } };
			};
		return { context: { browserSpaceId: job.result?.trial?.browserObservation?.spaceId } };
	}

	async cancelIfKnown(executionId: string) {
		if (await this.records.read(`run:${executionId}`)) await this.runtime.cancel(executionId);
	}
	async legacyArtifact(runId: string, id: string) {
		if (!/^scan_[a-f0-9]{32}$/.test(runId) || !/^[a-f0-9-]{36}$/.test(id))
			throw new Error('Invalid legacy scan artifact');
		return await this.runner(`/scan-artifacts/${runId}/${id}`);
	}
	async artifact(projectId: string, runId: string, id: string) {
		const run = await this.runtime.inspect(runId);
		if (run.projectId !== projectId) throw new Error('Artifact project mismatch');
		return await this.runner(
			`/project-artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(run.rootRunId)}/${encodeURIComponent(id)}`,
		);
	}
}

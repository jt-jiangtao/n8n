import { randomUUID } from 'node:crypto';
import { evaluateCondition } from './conditions';
import type { ProjectRecords } from '../database/project-record.repository';
import { contentDigest, bindProjectFlow, type ProjectSnapshot } from './project-config';
import { gateResults, type VerificationEvidence } from './execution-policy';
import {
	readRef,
	type Run,
	type NodeRecord,
	type NodeResult,
	type RuntimePorts,
	type ParentRun,
} from './runtime-model';
export type { Run, NodeRecord, RuntimePorts } from './runtime-model';
type Records = ProjectRecords & { claim(key: string, value: unknown): Promise<boolean> };
const terminal = new Set(['passed', 'failed', 'blocked', 'timed-out', 'canceled', 'exceeded']);
const runnerTypes = new Set([
	'workspace',
	'command',
	'service',
	'agent',
	'verify',
	'integrate',
	'finish',
]);
const fields = [
	'repoRef',
	'configCandidateHash',
	'configValidationHash',
	'workspace',
	'workspaceId',
	'workspaceOwnerRunId',
	'baseSha',
	'targetSha',
	'candidateSha',
	'diffHash',
	'branch',
	'serviceId',
	'serviceUrl',
	'resourceIds',
	'browserObservation',
	'browserSpaceId',
	'mergedSha',
	'revertOf',
	'integration',
	'integrationTarget',
	'integrationChildren',
	'targetRef',
] as const;
export class ProjectRuntime {
	private queues = new Map<string, Promise<unknown>>();
	constructor(
		private readonly records: Records,
		private readonly dispatch: (task: Record<string, unknown>) => Promise<void>,
		private readonly wake: (executionId: string, nodeId?: string) => Promise<void>,
		private readonly instanceId: string,
		private readonly ports: RuntimePorts = {},
	) {}
	private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
		const old = this.queues.get(id) ?? Promise.resolve(),
			next = old.catch(() => {}).then(action);
		this.queues.set(id, next);
		try {
			return await next;
		} finally {
			if (this.queues.get(id) === next) this.queues.delete(id);
		}
	}
	private key(executionId: string, nodeId: string) {
		return `node:${executionId}:${nodeId}`;
	}
	private async saveNode(node: NodeRecord) {
		await this.records.write(`attempt:${node.taskId}`, node);
		await this.records.write(this.key(node.executionId, node.nodeId), node);
	}
	private async save(run: Run) {
		await this.records.write(`run:${run.executionId}`, run);
	}
	async inspect(executionId: string) {
		const run = await this.records.read<Run>(`run:${executionId}`);
		if (!run) throw new Error('Unknown project run');
		return run;
	}
	async nodes(executionId: string) {
		const run = await this.inspect(executionId);
		return await Promise.all(
			run.snapshot.flow.nodes.map(
				async (node) => await this.records.read<NodeRecord>(this.key(executionId, node.id)),
			),
		);
	}
	private response(run: Run, node: NodeRecord): NodeResult {
		return {
			status: node.status,
			result: node.result,
			error: node.error,
			outputIndex: node.outputIndex,
			context: {
				...run.context,
				projectId: run.projectId,
				flowId: run.flowId,
				runId: run.runId,
				configHash: run.configHash,
			},
		};
	}
	private activate(run: Run, node: NodeRecord) {
		const definition = run.snapshot.flow.nodes.find((item) => item.id === node.nodeId)!;
		const index =
			node.outputIndex ?? (node.status === 'passed' ? 0 : node.status === 'blocked' ? 2 : 1);
		const links = run.snapshot.flow.connections[definition.name]?.main[index] ?? [];
		for (const link of links) {
			const target = run.snapshot.flow.nodes.find((item) => item.name === link.node)!;
			const id = `${node.taskId}:${index}:${target.id}`;
			if (!run.tokens.some((token) => token.id === id)) run.tokens.push({ id, to: target.id });
		}
		if (links.length) node.outputIndex = index;
		return links.length > 0;
	}
	async start(
		executionId: string,
		snapshot: ProjectSnapshot,
		options: {
			parent?: ParentRun;
			rootRunId?: string;
			context?: Record<string, unknown>;
			depth?: number;
		} = {},
	): Promise<Run> {
		let run = await this.records.read<Run>(`run:${executionId}`);
		if (run) {
			if (
				run.projectId !== snapshot.projectId ||
				run.flowId !== snapshot.flowId ||
				run.configHash !== snapshot.contentHash
			)
				throw new Error('Run snapshot identity conflict');
		} else {
			run = {
				executionId,
				runId: executionId,
				rootRunId: options.rootRunId ?? executionId,
				projectId: snapshot.projectId,
				flowId: snapshot.flowId,
				configHash: snapshot.contentHash,
				snapshot,
				context: { ...options.context, params: snapshot.params },
				steps: 0,
				appliedTasks: [],
				startedAt: Date.now(),
				status: 'running',
				parent: options.parent,
				depth: options.depth ?? 0,
				tokens: [],
				failures: {},
			};
			if (run.depth > 16) throw new Error('Subflow depth budget exceeded');
			if (!(await this.records.claim(`run:${executionId}`, run)))
				return await this.start(executionId, snapshot, options);
		}
		const start = snapshot.flow.nodes.find((item) => item.type === 'start');
		if (!start) throw new Error('Missing start node');
		if (!(await this.records.read<NodeRecord>(this.key(executionId, start.id)))) {
			const record: NodeRecord = {
				taskId: randomUUID(),
				executionId,
				nodeId: start.id,
				projectId: run.projectId,
				runId: run.runId,
				configHash: run.configHash,
				attempt: 1,
				instanceId: this.instanceId,
				type: 'start',
				status: 'passed',
				result: { params: snapshot.params },
				invocationId: 'start',
			};
			if (this.ports.workItem && !run.context.parentIssueId) {
				const parent = await this.ports.workItem(run, record, { operation: 'create-parent' }, []);
				run.context.parentIssueId = parent.id;
				run.context.openTasks = parent.openTasks ?? [];
				record.result = { ...record.result, parentIssueId: parent.id };
			}
			await this.saveNode(record);
			this.activate(run, record);
			await this.save(run);
		}
		return run;
	}
	async executeNode(input: {
		executionId: string;
		nodeId: string;
		projectId: string;
		flowId: string;
		invocationId?: string;
		input?: Record<string, unknown>;
	}): Promise<NodeResult> {
		return await this.serial(input.executionId, async () => {
			const run = await this.inspect(input.executionId);
			if (run.projectId !== input.projectId || run.flowId !== input.flowId)
				throw new Error('Project execution identity mismatch');
			const definition = run.snapshot.flow.nodes.find((item) => item.id === input.nodeId);
			if (!definition) throw new Error('Unknown approved node');
			const existing = await this.records.read<NodeRecord>(this.key(run.executionId, input.nodeId)),
				invocationId = input.invocationId ?? 'default';
			if (existing && (definition.type === 'start' || existing.invocationId === invocationId)) {
				if (run.status === 'canceled')
					return this.response(run, { ...existing, status: 'canceled' });
				if (existing.children && existing.status === 'running')
					await this.launchChildren(run, existing, definition.parameters);
				if (existing.dispatch && existing.status === 'queued') await this.send(existing);
				return this.response(
					await this.inspect(run.executionId),
					(await this.records.read<NodeRecord>(this.key(run.executionId, input.nodeId))) ??
						existing,
				);
			}
			if (run.status !== 'running')
				throw new Error('Required predecessor has not passed; run is terminal');
			if (
				run.steps >= (run.snapshot.flow.limits?.maxSteps ?? 128) ||
				Date.now() - run.startedAt > (run.snapshot.flow.limits?.maxDurationMs ?? 7200000)
			)
				throw new Error('Project run budget exceeded');
			if (existing && !terminal.has(existing.status))
				throw new Error('Previous node attempt is still running');
			const token = run.tokens.find((item) => item.to === definition.id && !item.consumed);
			if (!token)
				throw new Error('Required predecessor has not passed or has no declared recovery route');
			const attempt = (existing?.attempt ?? 0) + 1;
			if (attempt > Number(definition.parameters.maxAttempts ?? 8))
				throw new Error('Node attempt budget exceeded');
			const node: NodeRecord = {
				taskId: randomUUID(),
				executionId: run.executionId,
				nodeId: definition.id,
				projectId: run.projectId,
				runId: run.runId,
				configHash: run.configHash,
				attempt,
				instanceId: this.instanceId,
				type: definition.type,
				status: 'queued',
				result: {},
				invocationId,
				replayContext: structuredClone(run.context),
			};
			const p = definition.parameters;
			if (node.type === 'approval') {
				const subject = this.approvalSubject(run, node, p);
				node.status = 'waiting-approval';
				node.result = { subject, digest: contentDigest(subject), role: p.role ?? 'owner' };
			} else if (node.type === 'subflow') {
				if (!this.ports.launch) throw new Error('Subflow launcher unavailable');
				if (
					p.target === 'integration' &&
					(!run.context.integration || (p.join && p.join !== 'all'))
				)
					throw new Error('An isolated integration target and all-child join are required');
				const items = p.itemsRef ? readRef(run.context, String(p.itemsRef)) : [{}];
				if (!Array.isArray(items)) throw new Error('Subflow items reference is not a list');
				if (!items.length && !p.allowEmpty) throw new Error('Required child list is empty');
				const childFlow = run.snapshot.flows[String(p.flowRef)];
				if (!childFlow) throw new Error('Unknown project child flow');
				const declared = (childFlow.parameters?.properties ?? {}) as Record<string, unknown>;
				node.children = items.map((item) => {
					const params: Record<string, unknown> = {};
					for (const key of Object.keys(declared))
						if (Object.hasOwn(run.snapshot.params, key)) params[key] = run.snapshot.params[key];
					if (Object.hasOwn(declared, 'finding') && p.itemsRef) params.finding = item;
					for (const [key, value] of Object.entries((p.input ?? {}) as Record<string, unknown>))
						params[key] =
							value && typeof value === 'object' && 'ref' in value
								? readRef({ ...run.context, item }, String(value.ref))
								: value;
					return { childId: randomUUID(), status: 'queued', params };
				});
				node.status = 'running';
			} else if (runnerTypes.has(node.type)) {
				node.dispatch = await this.runnerTask(run, node, p);
			} else if (node.type === 'work-item' || node.type === 'notify') {
				node.status = 'running';
			} else if (node.type === 'if') {
				const condition = evaluateCondition(run.context, p);
				node.status = 'passed';
				node.result = { condition };
				node.outputIndex = condition ? 0 : 1;
			} else throw new Error('Unknown capability');
			token.consumed = node.taskId;
			run.steps++;
			await this.save(run);
			await this.saveNode(node);
			await this.records.write(`task:${node.taskId}`, {
				executionId: run.executionId,
				nodeId: node.nodeId,
			});
			if (node.dispatch) await this.send(node);
			else if (node.children) {
				if (!node.children.length)
					await this.settle(run, node, { status: 'passed', result: { items: [] } }, false);
				else await this.launchChildren(run, node, p);
			} else if (node.type === 'work-item' || node.type === 'notify') {
				try {
					const result =
						node.type === 'work-item'
							? await this.ports.workItem?.(
									run,
									node,
									p,
									p.itemsRef ? readRef(run.context, String(p.itemsRef)) : [],
								)
							: await this.ports.notify?.(run, node, p);
					if (!result) throw new Error('Required side effect adapter unavailable');
					await this.settle(run, node, { status: 'passed', result }, false);
				} catch (error) {
					await this.settle(
						run,
						node,
						{ status: 'failed', result: {}, error: String(error) },
						false,
					);
				}
			} else if (node.type === 'if')
				await this.settle(run, node, { status: 'passed', result: node.result }, false);
			return this.response(await this.inspect(run.executionId), node);
		});
	}
	private approvalSubject(run: Run, node: NodeRecord, p: Record<string, unknown>) {
		return {
			projectId: run.projectId,
			runId: run.runId,
			nodeId: node.nodeId,
			configHash: run.configHash,
			context: run.context,
			parameters: p,
		};
	}
	private async runnerTask(run: Run, node: NodeRecord, p: Record<string, unknown>) {
		const repoRef =
			node.type === 'workspace'
				? (p.repoRef ?? run.context.repoRef ?? 'project')
				: (run.context.repoRef ?? 'project');
		const switchingRepo = repoRef !== (run.context.repoRef ?? 'project');
		const config = run.snapshot.config,
			env = {
				FLOW_DESK_PARAMS_JSON: JSON.stringify(run.snapshot.params),
				FLOW_DESK_SERVICE_URL: String(run.context.serviceUrl ?? ''),
			};
		let args: Record<string, unknown> = {};
		if (node.type === 'workspace' && p.target === 'integration') args = { target: 'integration' };
		if (node.type === 'workspace' && p.operation === 'assemble') {
			const children = readRef(run.context, String(p.childrenRef));
			if (!Array.isArray(children) || !children.length)
				throw new Error('Integration child manifest is missing');
			args = { operation: 'assemble', children };
		}
		if (node.type === 'workspace' && p.operation === 'revert') {
			const revertOf = readRef(run.context, String(p.revertRef));
			if (typeof revertOf !== 'string' || !/^[a-f0-9]{40,64}$/.test(revertOf))
				throw new Error('Revert preparation requires an exact original commit');
			args = { operation: 'revert', revertOf };
		}
		if (node.type === 'command' && !p.managedCli) {
			args =
				typeof p.command === 'string'
					? {
							command: p.command,
							cwd: p.cwd,
							timeoutMs: p.timeoutMs,
							env: p.env,
							artifacts: p.artifacts,
						}
					: (config.commands?.[String(p.commandRef)] ?? {});
			if (!args.command) throw new Error('Missing approved command');
			if (Array.isArray(p.argv))
				args = {
					...args,
					argv: p.argv.map((item) => {
						const value =
							item && typeof item === 'object' && 'ref' in item
								? readRef(run.context, String(item.ref))
								: item;
						if (!['string', 'number', 'boolean'].includes(typeof value))
							throw new Error('Command argument reference is missing or not scalar');
						return String(value);
					}),
				};
		}
		if (node.type === 'service') {
			args = {
				...config.services?.[String(p.serviceRef)],
				operation: p.operation ?? 'start',
				serviceId: run.context.serviceId,
			};
		}
		if (node.type === 'agent') {
			const prompt = run.snapshot.prompts[String(p.promptRef)],
				schema = run.snapshot.schemas[String(p.schemaRef)];
			if (!prompt || !schema) throw new Error('Missing approved Agent prompt/schema');
			const skillRefs = [...(Array.isArray(p.skillRefs) ? p.skillRefs : [])];
			if (run.snapshot.skills['flow-desk-mcp'] && !skillRefs.includes('flow-desk-mcp'))
				skillRefs.push('flow-desk-mcp');
			const applicationMcp =
				p.writes !== true && (p.promptRef === 'scan' || skillRefs.includes('action-driver-mcp'))
					? config.actionDriverMcp
					: undefined;
			if (applicationMcp && !skillRefs.includes('action-driver-mcp'))
				skillRefs.push('action-driver-mcp');
			const skills = skillRefs.map((id) => {
				const files = run.snapshot.skills[String(id)];
				if (!files) throw new Error('Unknown allowed skill');
				return { id, files };
			});
			args = {
				instructions:
					prompt +
					'\n\nProject runtime data:\n' +
					JSON.stringify({
						params: run.snapshot.params,
						context: run.context,
						skillIds: skills.map((item) => item.id),
					}),
				schema,
				adapter: p.adapter ?? 'codex',
				sessionId: p.sessionPolicy === 'continue' ? `${run.runId}:${node.nodeId}` : undefined,
				resume: p.sessionPolicy === 'continue' && node.attempt > 1,
				keepSession: p.sessionPolicy === 'continue',
				maxAttempts: p.maxAttempts,
				model: p.model,
				writes: p.writes === true,
				resolveConflicts: p.resolveConflicts === true,
				actionDriverMcp: applicationMcp,
				timeoutMs: p.timeoutMs,
				browserObservation: run.context.browserObservation,
				taskContext: {
					...(typeof run.context.parentIssueId === 'string'
						? { taskCreation: { parentId: run.context.parentIssueId } }
						: {}),
					tasks: run.context.openTasks ?? [],
					skills: Object.fromEntries(skills.map((item) => [String(item.id), item.files])),
				},
				requireTaskList: p.requireTaskList === true,
			};
		}
		if (node.type === 'verify' && !p.managedCli) {
			const suites = (Array.isArray(p.suites) ? p.suites : []).map((ref) => {
				const suite = config.verification[String(ref)];
				if (!suite) throw new Error('Missing project verification suite');
				const command = config.commands?.[suite.commandRef];
				if (!command) throw new Error('Missing verification command');
				return {
					...command,
					name: String(ref),
					configurationSamples:
						String(ref) === (p.configuration as { sampleSuite?: string } | undefined)?.sampleSuite,
					mode: p.mode ?? 'gate',
					compareWithBase: p.compareWithBase === true,
					baselinePreparation:
						p.compareWithBase === true
							? config.preparation.commands.map((ref) => config.commands?.[ref])
							: undefined,
					baselineService:
						p.compareWithBase === true && config.preparation.services.length === 1
							? config.services?.[config.preparation.services[0]]
							: undefined,
					report: suite.report,
					repeat: p.repeat ?? suite.repeat,
					regressionFiles: suite.regression?.files,
					env: { ...command.env, ...env },
				};
			});
			if (!suites.length) throw new Error('No verification suites configured');
			if (p.configuration && !suites.some((s) => s.configurationSamples))
				throw new Error('Configuration sample suite is missing');
			const observed = run.context.browserObservation as
				| {
						spaceId?: number;
						pages?: Array<{ path: string; evidence: Array<{ candidateSha: string }> }>;
				  }
				| undefined;
			const stale = observed?.pages?.some((page) =>
				page.evidence.some((image) => image.candidateSha !== run.context.candidateSha),
			);
			const browser =
				p.browser ?? (stale ? { paths: observed!.pages!.map((page) => page.path) } : undefined);
			args = {
				suites,
				resolves: p.resolves ?? [],
				requiredAncestors: run.context.integrationChildren,
				browser: browser
					? {
							...(browser as object),
							spaceId:
								run.context.browserSpaceId ??
								(run.context.browserObservation as { spaceId?: number })?.spaceId,
						}
					: undefined,
				evidence: p.evidenceRef ? readRef(run.context, String(p.evidenceRef)) : undefined,
			};
			if (p.evidenceRef && !Array.isArray(args.evidence))
				throw new Error('Required evidence list is missing');
		}
		if (node.type === 'integrate') {
			const approval = await this.records.read<NodeRecord>(
					this.key(run.executionId, String(p.approvalRef)),
				),
				verification = await this.records.read<NodeRecord>(
					this.key(run.executionId, String(p.verificationRef)),
				);
			if (
				approval?.status !== 'passed' ||
				approval.type !== 'approval' ||
				approval.result.decision !== 'approve' ||
				verification?.status !== 'passed' ||
				verification.type !== 'verify' ||
				!verification.result.verification
			)
				throw new Error('Valid human delivery approval and verification are required');
			const approved = (approval.result.subject as { context: Record<string, unknown> }).context;
			for (const key of ['candidateSha', 'targetSha', 'diffHash', 'evidenceHash'])
				if (!run.context[key] || approved[key] !== run.context[key])
					throw new Error('Approval no longer matches candidate, target, diff or evidence');
			if (
				repoRef === 'project-config' &&
				(!run.context.configCandidateHash ||
					!run.context.configValidationHash ||
					approved.configValidationHash !== run.context.configValidationHash ||
					approved.configCandidateHash !== run.context.configCandidateHash ||
					approved.repoRef !== repoRef)
			)
				throw new Error('Approved configuration candidate changed');
			if (verification.dispatch?.candidateSha !== run.context.candidateSha)
				throw new Error('Verification candidate changed');
			const subject = {
				projectId: run.projectId,
				runId: run.runId,
				configHash: run.configHash,
				candidateSha: run.context.candidateSha,
				targetSha: run.context.targetSha,
				targetRef: run.context.targetRef ?? config.baseRef,
				operation: p.operation ?? 'merge',
				repoRef,
				...(repoRef === 'project-config'
					? {
							configCandidateHash: run.context.configCandidateHash,
							configValidationHash: run.context.configValidationHash,
						}
					: {}),
				scopeHash: approval.result.digest,
				evidenceHash: run.context.evidenceHash,
				diffHash: run.context.diffHash,
				actor: approval.result.actor,
				decisionId: approval.taskId,
				...(p.operation === 'revert'
					? { revertOf: readRef(run.context, String(p.revertRef)) }
					: {}),
			};
			if (p.operation === 'revert' && (approved.revertOf !== subject.revertOf || !subject.revertOf))
				throw new Error('Revert original commit changed after approval');
			if (!this.ports.integration) throw new Error('Integration authorization issuer unavailable');
			args = {
				integration: {
					repo: config.repo,
					...subject,
					...(await this.ports.integration(subject, verification.result.verification)),
				},
			};
		}
		if (p.managedCli && ['command', 'verify'].includes(node.type)) {
			const managed = p.managedCli as Record<string, unknown>;
			const version = readRef(run.context, String(managed.versionRef));
			if (typeof version !== 'string' || !version)
				throw new Error('An exact CLI version reference is required');
			args = { managedCli: { operation: managed.operation, version } };
			if (node.type === 'command') {
				const approval = await this.records.read<NodeRecord>(
					this.key(run.executionId, String(managed.approvalRef)),
				);
				if (
					approval?.type !== 'approval' ||
					approval.status !== 'passed' ||
					approval.result.decision !== 'approve' ||
					approval.result.role !== 'platform.owner'
				)
					throw new Error('Platform owner CLI approval required');
				const approved = (approval.result.subject as { context: Record<string, unknown> }).context;
				if (
					readRef(approved, String(managed.versionRef)) !== version ||
					approved.candidateSha !== run.context.candidateSha
				)
					throw new Error('CLI approval version or workspace changed');
				const subject: Record<string, unknown> = {
					kind: 'managed-cli',
					projectId: run.projectId,
					runId: run.runId,
					taskId: node.taskId,
					configHash: run.configHash,
					operation: managed.operation,
					version,
					actor: approval.result.actor,
					decisionId: approval.taskId,
				};
				if (managed.operation !== 'install') {
					const verification = await this.records.read<NodeRecord>(
						this.key(run.executionId, String(managed.verificationRef)),
					);
					const smokeHash = readRef(run.context, String(managed.smokeRef)),
						expectedVersion = readRef(run.context, String(managed.expectedVersionRef));
					if (
						verification?.type !== 'verify' ||
						verification.status !== 'passed' ||
						!verification.result.verification ||
						verification.result.receiptHash !== smokeHash ||
						verification.result.version !== version ||
						verification.dispatch?.candidateSha !== run.context.candidateSha ||
						!smokeHash ||
						!expectedVersion
					)
						throw new Error('Real CLI smoke proof is required before switch');
					if (
						readRef(approved, String(managed.smokeRef)) !== smokeHash ||
						readRef(approved, String(managed.expectedVersionRef)) !== expectedVersion
					)
						throw new Error('Reviewed CLI smoke or active version changed');
					subject.smokeHash = smokeHash;
					subject.expectedVersion = expectedVersion;
				}
				if (!this.ports.integration) throw new Error('CLI authorization issuer unavailable');
				args = {
					managedCli: {
						operation: managed.operation,
						version,
						...(await this.ports.integration(subject, undefined)),
					},
				};
			}
		}
		if (node.type === 'finish') {
			if (p.outcome !== 'failed' && p.outcome !== 'canceled' && Object.keys(run.failures).length)
				throw new Error('Unresolved failed nodes prevent successful completion');
			args = { retainResources: !!run.parent, outcome: p.outcome ?? 'completed' };
		}
		return {
			...args,
			env: { ...((args.env ?? {}) as Record<string, string>), ...env },
			type: node.type,
			repoRef,
			repo: config.repo,
			baseRef: run.context.targetRef ?? config.baseRef,
			integrationTarget: run.context.integrationTarget,
			workspace: switchingRepo ? undefined : run.context.workspace,
			workspaceOwnerRunId: switchingRepo ? undefined : run.context.workspaceOwnerRunId,
			candidateSha: switchingRepo ? undefined : run.context.candidateSha,
			expectedTargetSha: node.type === 'verify' ? run.context.mergedSha : undefined,
			serviceUrl: switchingRepo ? undefined : run.context.serviceUrl,
			resourceOwnerRunId: run.rootRunId,
			projectId: run.projectId,
			runId: run.runId,
			nodeId: node.nodeId,
			taskId: node.taskId,
			configHash: run.configHash,
			attempt: node.attempt,
			callbackBase: this.instanceId,
		};
	}
	private async send(node: NodeRecord) {
		await this.records.write(`task:${node.taskId}`, {
			executionId: node.executionId,
			nodeId: node.nodeId,
		});
		await this.dispatch(node.dispatch!);
		node.status = 'running';
		await this.saveNode(node);
	}
	private async launchChildren(run: Run, node: NodeRecord, p: Record<string, unknown>) {
		const concurrency = Number(p.concurrency ?? 1);
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
			throw new Error('Invalid child concurrency');
		let free = concurrency - node.children!.filter((child) => child.status === 'running').length;
		for (const child of node.children!) {
			if (free <= 0) break;
			if (child.status !== 'queued') continue;
			const snapshot = bindProjectFlow(run.snapshot, String(p.flowRef), child.params);
			const context: Record<string, unknown> = {
				failure: run.context.failure,
				parentResults: run.context.results,
				browserSpaceId:
					run.context.browserSpaceId ??
					(run.context.browserObservation as { spaceId?: number })?.spaceId,
				parentIssueId:
					(p.itemsRef ? (child.params.finding as { id?: string })?.id : undefined) ??
					run.context.parentIssueId,
			};
			if (p.target === 'integration') {
				const integration = run.context.integration as Record<string, unknown>;
				context.integrationTarget = { ...integration, childId: child.childId };
				context.targetRef = `${String(integration.branch)}-child-${child.childId}`;
			}
			if (!p.itemsRef)
				for (const field of fields)
					if (run.context[field] !== undefined) context[field] = run.context[field];
			const result = await this.ports.launch!({
				childId: child.childId,
				parent: { executionId: run.executionId, nodeId: node.nodeId, childId: child.childId },
				rootRunId: run.rootRunId,
				snapshot,
				context,
				depth: run.depth + 1,
			});
			child.executionId = result.executionId;
			child.status = 'running';
			free--;
			await this.saveNode(node);
		}
	}
	async childCompleted(
		executionId: string,
		nodeId: string,
		childId: string,
		outcome: { status: string; context: Record<string, unknown>; error?: string },
	) {
		return await this.serial(executionId, async () => {
			const run = await this.inspect(executionId),
				node = await this.records.read<NodeRecord>(this.key(executionId, nodeId));
			const child = node?.children?.find((item) => item.childId === childId);
			if (!node || !child) throw new Error('Unknown declared child');
			if (run.status === 'canceled') return this.response(run, { ...node, status: 'canceled' });
			if (terminal.has(child.status)) {
				if (child.status !== outcome.status) throw new Error('Conflicting child terminal result');
			} else {
				child.status = outcome.status;
				child.context = outcome.context;
				child.error = outcome.error;
				await this.saveNode(node);
			}
			if (terminal.has(node.status)) return this.response(run, node);
			const parameters = run.snapshot.flow.nodes.find((item) => item.id === nodeId)!.parameters;
			const joinAny = parameters.join === 'any';
			if (joinAny && node.children!.some((item) => item.status === 'passed')) {
				for (const pending of node.children!.filter((item) =>
					['running', 'queued'].includes(item.status),
				)) {
					if (pending.status === 'running')
						await this.ports.cancel?.(pending.executionId ?? pending.childId);
					pending.status = 'canceled';
				}
				await this.settle(
					run,
					node,
					{
						status: 'passed',
						result: {
							children: node.children,
							items: node
								.children!.filter((item) => item.status === 'passed')
								.map((item) => item.context),
						},
					},
					true,
				);
				return this.response(run, node);
			}
			if (
				node.children!.some((item) => terminal.has(item.status) && item.status !== 'passed') &&
				(!joinAny || node.children!.every((item) => terminal.has(item.status)))
			) {
				for (const pending of node.children!.filter((item) => item.status === 'running'))
					await this.ports.cancel?.(pending.executionId ?? pending.childId);
				await this.settle(
					run,
					node,
					{
						status: 'failed',
						result: { children: node.children },
						error: outcome.error ?? 'A child did not pass',
					},
					true,
				);
			} else if (node.children!.every((item) => item.status === 'passed')) {
				if (parameters.target === 'integration') {
					const commits = node.children!.map((item) => item.context?.mergedSha);
					if (commits.some((sha) => typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(sha)))
						throw new Error('An integration child has no published verified commit');
					run.context.integrationChildren = commits;
				}
				if (
					node.children!.length === 1 &&
					!run.snapshot.flow.nodes.find((item) => item.id === nodeId)!.parameters.itemsRef
				)
					for (const field of fields)
						if (child.context?.[field] !== undefined) run.context[field] = child.context[field];
				await this.settle(
					run,
					node,
					{
						status: 'passed',
						result: { children: node.children, items: node.children!.map((item) => item.context) },
					},
					true,
				);
			} else
				await this.launchChildren(
					run,
					node,
					run.snapshot.flow.nodes.find((item) => item.id === nodeId)!.parameters,
				);
			return this.response(run, node);
		});
	}
	private requiredChecks(node: NodeRecord): Array<{ name: string; repeat?: number }> {
		return [
			...(node.dispatch?.managedCli ? [{ name: 'managed-cli' }] : []),
			...((node.dispatch?.suites ?? []) as Array<{ name: string; repeat?: number }>),
			...(node.dispatch?.browser ? [{ name: 'browser' }] : []),
		];
	}
	private async settle(
		run: Run,
		node: NodeRecord,
		event: { status: string; result: Record<string, unknown>; error?: string },
		wake: boolean,
	) {
		if (terminal.has(node.status) && node.status !== event.status)
			throw new Error('Conflicting terminal result');
		event = { ...event, result: { ...event.result } };
		if (node.type === 'verify' && event.status === 'passed') {
			try {
				gateResults(event.result.evidence as VerificationEvidence[], this.requiredChecks(node), {
					candidateSha: String(node.dispatch?.candidateSha ?? ''),
					configHash: run.configHash,
				});
			} catch (error) {
				event = {
					status: 'failed',
					result: { ...event.result, runnerStatus: 'passed' },
					error: String(error),
				};
			}
		}
		const resolvedFailures: string[] = [];
		if (node.type === 'verify' && event.status === 'passed') {
			try {
				for (const id of (node.dispatch?.resolves ?? []) as string[]) {
					if (!run.failures[id]) continue;
					const failed = await this.records.read<NodeRecord>(this.key(run.executionId, id));
					if (
						!failed ||
						!['agent', 'verify'].includes(failed.type) ||
						failed.dispatch?.workspace !== node.dispatch?.workspace
					)
						throw new Error('Recovery verification does not cover the failed workspace');
					if (failed.type === 'verify') {
						const actual = new Map(
							this.requiredChecks(node).map((check) => [check.name, check.repeat ?? 1]),
						);
						if (
							failed.dispatch?.managedCli ||
							this.requiredChecks(failed).some(
								(check) => (actual.get(check.name) ?? 0) < (check.repeat ?? 1),
							)
						)
							throw new Error('Recovery verification does not cover the failed checks');
						const suites = (failed.dispatch?.suites ?? []) as Array<{
							name: string;
							mode?: string;
							compareWithBase?: boolean;
							regressionFiles?: unknown;
						}>;
						const current = (node.dispatch?.suites ?? []) as typeof suites;
						if (
							suites.some(
								(s) =>
									s.mode === 'measure' ||
									(s.compareWithBase && !current.find((c) => c.name === s.name)?.compareWithBase) ||
									(s.regressionFiles &&
										contentDigest(s.regressionFiles) !==
											contentDigest(
												current.find((c) => c.name === s.name)?.regressionFiles ?? null,
											)),
							)
						)
							throw new Error('Recovery verification weakens the failed acceptance gate');
					}
					resolvedFailures.push(id);
				}
			} catch (error) {
				event = {
					status: 'failed',
					result: { ...event.result, runnerStatus: 'passed' },
					error: String(error),
				};
			}
		}
		if (node.dispatch?.repoRef === 'project-config' && event.status === 'passed') {
			try {
				if (node.type === 'verify') {
					if (!this.ports.configurationCandidate)
						throw new Error('Configuration candidate validator unavailable');
					const candidate = await this.ports.configurationCandidate(run, event.result);
					event.result.configCandidateHash = candidate.contentHash;
					event.result.configValidationHash = candidate.validationHash;
					event.result.configValidation = candidate.report;
				}
				if (node.type === 'integrate') {
					if (!this.ports.activateConfiguration)
						throw new Error('Configuration activation unavailable');
					const request = node.dispatch.integration as {
						actor?: string;
						configCandidateHash?: string;
						candidateSha?: string;
					};
					if (
						!request?.actor ||
						!request.configCandidateHash ||
						request.candidateSha !== event.result.mergedSha
					)
						throw new Error('Configuration activation does not match approved publication');
					await this.ports.activateConfiguration(run, request.configCandidateHash, request.actor);
					event.result.activatedConfigHash = request.configCandidateHash;
				}
			} catch (error) {
				event = {
					status: 'failed',
					result: { ...event.result, runnerStatus: 'passed' },
					error: String(error),
				};
			}
		}
		node.status = event.status;
		node.result = event.result;
		node.error = event.error;
		await this.saveNode(node);
		if (!run.appliedTasks.includes(node.taskId)) {
			run.appliedTasks.push(node.taskId);
			run.context.results = {
				...((run.context.results ?? {}) as Record<string, unknown>),
				[node.nodeId]: node.result,
			};
			if (node.status === 'passed') {
				delete run.failures[node.nodeId];
				if (
					node.type === 'workspace' &&
					(run.context.repoRef ?? 'project') !== node.result.repoRef &&
					node.result.repoRef
				) {
					for (const field of [
						'evidenceHash',
						'diffHash',
						'configCandidateHash',
						'serviceId',
						'serviceUrl',
						'browserObservation',
						'revertOf',
						'integration',
						'integrationTarget',
						'integrationChildren',
						'mergedSha',
					])
						delete run.context[field];
				}
				const ownedFields: Record<string, readonly string[]> = {
					workspace: [
						'repoRef',
						'targetRef',
						'workspace',
						'workspaceId',
						'workspaceOwnerRunId',
						'baseSha',
						'targetSha',
						'candidateSha',
						'branch',
						'revertOf',
						'integration',
						'integrationChildren',
						'diffHash',
					],
					service: ['serviceId', 'serviceUrl', 'resourceIds'],
					agent: ['candidateSha', 'diffHash', 'diagnostics'],
					verify: [
						'candidateSha',
						'browserObservation',
						'configCandidateHash',
						'configValidationHash',
					],
					integrate: ['candidateSha', 'mergedSha'],
					subflow: fields,
				};
				for (const field of ownedFields[node.type] ?? [])
					if (node.result[field] !== undefined) run.context[field] = node.result[field];
				if (node.type === 'verify') {
					run.context.evidenceHash = gateResults(
						node.result.evidence as VerificationEvidence[],
						this.requiredChecks(node),
						{ candidateSha: String(node.dispatch?.candidateSha ?? ''), configHash: run.configHash },
					).evidenceHash;
					for (const id of resolvedFailures) delete run.failures[id];
				}
				if (node.type === 'finish')
					run.status =
						node.dispatch?.outcome === 'failed'
							? 'failed'
							: node.dispatch?.outcome === 'canceled'
								? 'canceled'
								: 'passed';
			} else {
				run.failures[node.nodeId] = node.type;
				run.context.failure = {
					nodeId: node.nodeId,
					status: node.status,
					error: node.error,
					result: node.result,
				};
			}
			const routed = this.activate(run, node);
			if (node.status !== 'passed' && !routed) run.status = node.status;
			await this.save(run);
			await this.saveNode(node);
		}
		if (run.status !== 'running') await this.finalize(run, node.error);
		if (!wake) {
			node.woken = true;
			await this.saveNode(node);
		}
		if (wake && !node.woken) {
			await this.wake(run.executionId, node.nodeId);
			node.woken = true;
			await this.saveNode(node);
		}
	}
	private async finalize(run: Run, error?: string) {
		if (run.parent) {
			await this.ports.completed?.(run.parent, { status: run.status, context: run.context, error });
			return;
		}
		if (run.cleanup?.status === 'passed') return;
		try {
			await this.ports.finalize?.(run);
			run.cleanup = { status: 'passed' };
		} catch (failure) {
			run.cleanup = { status: 'failed', error: String(failure) };
		}
		await this.save(run);
	}
	async createAgentTask(
		taskId: string,
		identity: Record<string, unknown>,
		finding: Record<string, unknown>,
	) {
		const binding = await this.records.read<{ executionId: string; nodeId: string }>(
			`task:${taskId}`,
		);
		if (!binding) throw new Error('Unknown task creation binding');
		return await this.serial(binding.executionId, async () => {
			const run = await this.inspect(binding.executionId);
			const node = await this.records.read<NodeRecord>(
				this.key(binding.executionId, binding.nodeId),
			);
			if (
				!node ||
				node.taskId !== taskId ||
				node.type !== 'agent' ||
				node.status !== 'running' ||
				run.status !== 'running'
			)
				throw new Error('Task creation binding is no longer active');
			for (const field of [
				'taskId',
				'projectId',
				'runId',
				'nodeId',
				'configHash',
				'attempt',
			] as const)
				if (identity[field] !== node[field]) throw new Error('Task creation identity mismatch');
			if (node.instanceId !== this.instanceId || !this.ports.workItem)
				throw new Error('Task creation instance mismatch');
			const parentId = run.context.parentIssueId;
			if (
				typeof parentId !== 'string' ||
				!parentId ||
				(finding.parentId !== undefined && finding.parentId !== parentId)
			)
				throw new Error('Task parent is missing or mismatched');
			const key = contentDigest({
				kind: finding.kind ?? 'ui',
				title: finding.title,
				page: finding.page ?? '',
				reproduction: finding.reproduction,
			});
			const previous = await this.records.read<Record<string, unknown>>(
				`mcp-finding:${run.runId}:${key}`,
			);
			if (previous) return previous;
			const result = await this.ports.workItem(run, node, { operation: 'create' }, [finding]);
			const items = result.items;
			if (!Array.isArray(items) || !items[0] || typeof items[0].id !== 'string')
				throw new Error('Task creation returned no receipt');
			const receipt = { ...items[0], parentId };
			await this.records.write(`mcp-finding:${run.runId}:${key}`, receipt);
			return receipt;
		});
	}

	async complete(taskId: string, event: Record<string, unknown>) {
		const binding = await this.records.read<{ executionId: string; nodeId: string }>(
			`task:${taskId}`,
		);
		if (!binding) throw new Error('Unknown task callback');
		return await this.serial(binding.executionId, async () => {
			const run = await this.inspect(binding.executionId),
				node =
					(await this.records.read<NodeRecord>(`attempt:${taskId}`)) ??
					(await this.records.read<NodeRecord>(this.key(binding.executionId, binding.nodeId)));
			if (!node) throw new Error('Unknown task attempt');
			for (const field of [
				'taskId',
				'projectId',
				'runId',
				'nodeId',
				'configHash',
				'attempt',
			] as const)
				if (event[field] !== node[field]) throw new Error('Callback identity mismatch');
			if (node.instanceId !== this.instanceId)
				throw new Error('Callback instance identity mismatch');
			if (
				!terminal.has(String(event.status)) ||
				!event.result ||
				typeof event.result !== 'object' ||
				Array.isArray(event.result)
			)
				throw new Error('Invalid terminal result');
			const current = await this.records.read<NodeRecord>(
				this.key(binding.executionId, binding.nodeId),
			);
			if (current?.taskId !== taskId) return this.response(run, current!);
			if (run.status === 'canceled') return this.response(run, { ...node, status: 'canceled' });
			const callbackDigest = contentDigest({
				status: event.status,
				result: event.result,
				error: event.error ?? null,
			});
			if (
				terminal.has(node.status) &&
				(node.callbackDigest ??
					contentDigest({
						status: node.status,
						result: node.result,
						error: node.error ?? null,
					})) !== callbackDigest
			)
				throw new Error('Conflicting terminal callback');
			if (terminal.has(node.status) && node.callbackDigest === callbackDigest) {
				if (!node.woken) {
					await this.wake(run.executionId, node.nodeId);
					node.woken = true;
					await this.saveNode(node);
				}
				return this.response(run, node);
			}
			node.callbackDigest = callbackDigest;
			await this.settle(
				run,
				node,
				{
					status: String(event.status),
					result: event.result as Record<string, unknown>,
					error: event.error ? String(event.error) : undefined,
				},
				true,
			);
			return this.response(run, node);
		});
	}
	async decide(
		executionId: string,
		nodeId: string,
		input: {
			actor: string;
			digest: string;
			decision: 'approve' | 'reject';
			selectedIds?: string[];
		},
	) {
		return await this.serial(executionId, async () => {
			const run = await this.inspect(executionId),
				node = await this.records.read<NodeRecord>(this.key(executionId, nodeId));
			if (!node || node.type !== 'approval') throw new Error('Approval is not pending');
			const role = String(node.result.role);
			const actors = role.startsWith('platform.')
				? ((await this.ports.approvalActors?.(run, role)) ?? [])
				: ((run.snapshot.config.roles as Record<string, string[]>)[role] ?? []);
			if (
				['agent-bot', 'flow-desk', 'system'].includes(input.actor) ||
				!actors.includes(input.actor)
			)
				throw new Error('Only an authorized human can approve');
			if (input.digest !== node.result.digest || !['approve', 'reject'].includes(input.decision))
				throw new Error('Approval subject changed');
			if (terminal.has(node.status)) {
				if (node.result.actor !== input.actor || node.result.decision !== input.decision)
					throw new Error('Conflicting terminal human decision');
				if (!node.woken) {
					await this.wake(executionId, node.nodeId);
					node.woken = true;
					await this.saveNode(node);
				}
				return this.response(run, node);
			}
			const p = run.snapshot.flow.nodes.find((item) => item.id === nodeId)!.parameters;
			if (contentDigest(this.approvalSubject(run, node, p)) !== input.digest)
				throw new Error('Approval subject changed');
			let approved: unknown[] = [];
			if (p.batch && input.decision === 'approve') {
				const source = readRef(run.context, String(p.subjectRef));
				const items = Array.isArray(source) ? source : (source as { items?: unknown[] })?.items;
				if (!Array.isArray(items) || !Array.isArray(input.selectedIds))
					throw new Error('An explicit finding selection is required');
				const ids = new Set(input.selectedIds);
				if (
					ids.size !== input.selectedIds.length ||
					input.selectedIds.some((id) => !items.some((item) => (item as { id?: string }).id === id))
				)
					throw new Error('Approval selection is outside the reviewed findings');
				approved = items.filter((item) => ids.has(String((item as { id?: string }).id)));
			}
			const result = {
				...node.result,
				actor: input.actor,
				decision: input.decision,
				selectedIds: input.selectedIds ?? [],
				approved,
				decidedAt: new Date().toISOString(),
			};
			await this.settle(
				run,
				node,
				{ status: input.decision === 'approve' ? 'passed' : 'blocked', result },
				true,
			);
			return this.response(run, node);
		});
	}
	async cancel(executionId: string, notifyParent = true) {
		return await this.serial(executionId, async () => {
			const run = await this.inspect(executionId);
			if (terminal.has(run.status)) return run;
			run.status = 'canceled';
			await this.save(run);
			for (const definition of run.snapshot.flow.nodes) {
				const node = await this.records.read<NodeRecord>(this.key(executionId, definition.id));
				if (node && !terminal.has(node.status)) {
					for (const child of node.children ?? [])
						if (['running', 'queued'].includes(child.status))
							await this.ports.cancel?.(child.executionId ?? child.childId);
					node.status = 'canceled';
					await this.saveNode(node);
				}
			}
			if (notifyParent || !run.parent) await this.finalize(run, 'Canceled');
			return run;
		});
	}
	async terminate(executionId: string, status: 'failed' | 'exceeded' | 'canceled', error: string) {
		return await this.serial(executionId, async () => {
			const run = await this.inspect(executionId);
			if (terminal.has(run.status)) return run;
			run.status = status;
			run.context.terminationError = error;
			await this.save(run);
			for (const definition of run.snapshot.flow.nodes) {
				const node = await this.records.read<NodeRecord>(this.key(executionId, definition.id));
				if (node && !terminal.has(node.status)) {
					for (const child of node.children ?? [])
						if (['queued', 'running'].includes(child.status))
							await this.ports.cancel?.(child.executionId ?? child.childId);
					node.status = status;
					node.error = error;
					await this.saveNode(node);
				}
			}
			await this.finalize(run, error);
			return run;
		});
	}
	async resumePending(executionId: string) {
		await this.serial(executionId, async () => {
			const run = await this.inspect(executionId);
			for (const definition of run.snapshot.flow.nodes) {
				const node = await this.records.read<NodeRecord>(this.key(executionId, definition.id));
				if (node && terminal.has(node.status) && !node.woken) {
					await this.wake(executionId, node.nodeId);
					node.woken = true;
					await this.saveNode(node);
				}
			}
			if (run.status !== 'running' && (!run.cleanup || run.cleanup.status === 'failed'))
				await this.finalize(run);
		});
	}
}

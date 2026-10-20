import { migrationCandidate, assertMigrationSource, type LegacySource } from './legacy-migration';
import { snapshotFromBundle } from './config-bundle';
import { contentDigest, type ProjectSnapshot } from './project-config';
import { ProjectConfigurationService, type ApprovedProject } from './project-store';
import type { ProjectRecords } from '../database/project-record.repository';
import type { Run, NodeRecord } from './runtime-model';
type Candidate = ReturnType<typeof migrationCandidate> & {
	snapshot: ProjectSnapshot;
	before: ApprovedProject | null;
	trials: string[];
};
export type MigrationPorts = {
	source: (areaId: string, flows: string[]) => Promise<LegacySource>;
	publish: (candidate: Candidate, actor: string) => Promise<{ sha: string }>;
	trial: (snapshot: ProjectSnapshot, flowId: string) => Promise<{ runId: string }>;
	inspect: (id: string) => Promise<{
		run: Pick<Run, 'executionId' | 'projectId' | 'configHash' | 'flowId' | 'status' | 'failures'>;
		nodes: Array<NodeRecord | null>;
	}>;
	verify: (node: NodeRecord) => void;
};
export class ProjectMigrationService {
	private pending = new Map<string, Promise<unknown>>();
	private async serial<T>(projectId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.pending.get(projectId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(action);
		this.pending.set(projectId, next);
		try {
			return await next;
		} finally {
			if (this.pending.get(projectId) === next) this.pending.delete(projectId);
		}
	}
	constructor(
		private readonly records: ProjectRecords & {
			claim: (key: string, value: unknown) => Promise<boolean>;
		},
		private readonly configuration: ProjectConfigurationService,
		private readonly ports: MigrationPorts,
	) {}
	async propose(input: {
		expectedSourceHash?: string;
		projectId: string;
		areaId: string;
		files: Record<string, string>;
		mapping: Record<string, string>;
		flowId: string;
	}) {
		return await this.serial(input.projectId, async () => {
			const existing = await this.candidate(input.projectId);
			if (existing && existing.source.areaId !== input.areaId)
				throw new Error('Project migration already belongs to another legacy area');
			const source = await this.ports.source(input.areaId, Object.keys(input.mapping));
			if (input.expectedSourceHash && contentDigest(source) !== input.expectedSourceHash)
				throw new Error('Legacy source changed during migration preparation');
			const draft = migrationCandidate({ ...input, source });
			if (existing?.contentHash === draft.contentHash) return existing;
			const snapshot = snapshotFromBundle(
				{
					projectId: input.projectId,
					candidateSha: contentDigest(input.files),
					files: input.files,
				},
				{
					projectId: input.projectId,
					candidateSha: contentDigest(input.files),
					flowId: input.flowId,
				},
			);
			for (const flow of Object.values(input.mapping))
				if (!snapshot.flows[flow]) throw new Error('Migration references an unknown target flow');
			const area = source.area as { repo?: string; baseRef?: string };
			if (
				!area.repo ||
				snapshot.config.repo !== area.repo ||
				snapshot.config.baseRef !== (area.baseRef ?? 'main')
			)
				throw new Error('Migration cannot change the legacy repository or base branch');
			const before = await this.configuration.active(input.projectId);
			const candidate: Candidate = { ...draft, snapshot, before, trials: [] };
			await this.configuration.propose(snapshot);
			await this.records.write(
				`project:activation-gate:${input.projectId}:${snapshot.contentHash}`,
				{
					status: 'pending',
					migrationHash: draft.contentHash,
				},
			);
			await this.records.write(`migration:candidate:${input.projectId}`, candidate);
			return candidate;
		});
	}
	async candidate(projectId: string) {
		return await this.records.read<Candidate>(`migration:candidate:${projectId}`);
	}
	async status(projectId: string) {
		const candidate = await this.candidate(projectId);
		if (!candidate) return null;
		const route = await this.records.read<{ status: string; hash: string; projectId: string }>(
			`migration:area:${candidate.source.areaId}`,
		);
		if (!route || route.projectId !== projectId) return null;
		const version = await this.records.read<Candidate>(
				`migration:version:${projectId}:${route.hash}`,
			),
			active = await this.configuration.active(projectId);
		return {
			...route,
			canRollback:
				route.status === 'active' &&
				!!version &&
				active?.contentHash === version.snapshot.contentHash,
		};
	}
	private async exact(projectId: string, hash: string) {
		const candidate = await this.candidate(projectId);
		if (!candidate || candidate.contentHash !== hash)
			throw new Error('Migration candidate changed');
		return candidate;
	}
	async trial(projectId: string, hash: string, flowId: string) {
		return await this.serial(projectId, async () => {
			const candidate = await this.exact(projectId, hash);
			if (!candidate.snapshot.flows[flowId]?.nodes.some((n) => n.type === 'verify'))
				throw new Error('Migration trial must include actual verification');
			assertMigrationSource(
				candidate,
				await this.ports.source(candidate.source.areaId, Object.keys(candidate.mapping)),
			);
			for (const id of [...candidate.trials].reverse()) {
				const old = await this.ports.inspect(id);
				if (old.run.flowId === flowId && ['passed', 'running', 'queued'].includes(old.run.status))
					return { runId: id };
				if (old.run.flowId === flowId) break;
			}
			const started = await this.ports.trial(candidate.snapshot, flowId);
			candidate.trials.push(started.runId);
			await this.records.write(`migration:candidate:${projectId}`, candidate);
			return started;
		});
	}
	async activate(projectId: string, hash: string, actor: string) {
		return await this.serial(projectId, async () => {
			const candidate = await this.exact(projectId, hash);
			assertMigrationSource(
				candidate,
				await this.ports.source(candidate.source.areaId, Object.keys(candidate.mapping)),
			);
			const active = await this.configuration.active(projectId),
				beforeHash = candidate.before?.contentHash ?? null;
			if (
				(active?.contentHash ?? null) !== beforeHash &&
				active?.contentHash !== candidate.snapshot.contentHash
			)
				throw new Error('Project changed during migration');
			const covered = new Set<string>();
			const proofs = [];
			const latest = new Map<string, Awaited<ReturnType<MigrationPorts['inspect']>>>();
			for (const id of candidate.trials) {
				const trial = await this.ports.inspect(id);
				latest.set(trial.run.flowId, trial);
			}
			for (const { run, nodes } of latest.values()) {
				const id = run.executionId;
				if (run.projectId !== projectId || run.configHash !== candidate.snapshot.contentHash)
					throw new Error('Migration trial snapshot changed');
				if (run.status !== 'passed' || Object.keys(run.failures).length)
					throw new Error('Migration trial failed or is incomplete');
				const verified = nodes.filter(
					(node): node is NodeRecord => node?.type === 'verify' && node.status === 'passed',
				);
				if (!verified.length) throw new Error('Migration trial has no real verification');
				for (const node of verified) {
					this.ports.verify(node);
					proofs.push({ runId: id, taskId: node.taskId, verification: node.result.verification });
				}
				covered.add(run.flowId);
			}
			for (const flow of new Set(Object.values(candidate.mapping)))
				if (!covered.has(flow))
					throw new Error(`Migration has no successful real trial for ${flow}`);
			const routeKey = `migration:area:${candidate.source.areaId}`;
			const route = await this.records.read<{ projectId: string }>(routeKey);
			if (route && route.projectId !== projectId)
				throw new Error('Area belongs to another project migration');
			if (!route && !(await this.records.claim(routeKey, { status: 'preparing', projectId }))) {
				const owner = await this.records.read<{ projectId: string }>(routeKey);
				if (owner?.projectId !== projectId) throw new Error('Concurrent migration owns this area');
			}
			// Publish may fail; activation and routing must stay untouched until it succeeds.
			const publication = await this.ports.publish(candidate, actor);
			await this.exact(projectId, hash);
			await this.records.write(
				`project:activation-gate:${projectId}:${candidate.snapshot.contentHash}`,
				{ status: 'passed', migrationHash: hash, proofHash: contentDigest(proofs), publication },
			);
			await this.configuration.activateVersion(
				projectId,
				candidate.snapshot.contentHash,
				actor,
				beforeHash,
			);
			const result = {
				status: 'active',
				projectId,
				hash,
				sourceHash: candidate.sourceHash,
				mapping: candidate.mapping,
				publication,
				actor,
			};
			await this.records.write(routeKey, result);
			await this.records.write(`migration:version:${projectId}:${hash}`, {
				...candidate,
				activation: result,
			});
			return result;
		});
	}
	async resolve(areaId: string, flowType: string) {
		const route = await this.records.read<{
			status: string;
			projectId: string;
			mapping: Record<string, string>;
		}>(`migration:area:${areaId}`);
		if (route?.status !== 'active') return null;
		const flowId = route.mapping[flowType];
		if (!flowId) throw new Error('Legacy flow has no approved project mapping');
		return { projectId: route.projectId, flowId };
	}
	async rollback(projectId: string, hash: string, actor: string) {
		return await this.serial(projectId, async () => {
			const candidate = await this.records.read<Candidate>(
				`migration:version:${projectId}:${hash}`,
			);
			if (!candidate) throw new Error('Activated migration is unavailable');
			const route = await this.records.read<{ status: string; hash: string; projectId: string }>(
				`migration:area:${candidate.source.areaId}`,
			);
			if (route?.status === 'legacy' && route.hash === hash && route.projectId === projectId)
				return route;
			if (route?.hash !== hash || route.projectId !== projectId)
				throw new Error('Active migration changed');
			assertMigrationSource(
				candidate,
				await this.ports.source(candidate.source.areaId, Object.keys(candidate.mapping)),
			);
			const active = await this.configuration.active(projectId);
			if (active?.contentHash !== candidate.snapshot.contentHash)
				throw new Error('Active project changed after migration');
			if (candidate.before) {
				await this.configuration.propose(candidate.before.snapshot);
				await this.configuration.activateVersion(
					projectId,
					candidate.before.contentHash,
					actor,
					active.contentHash,
				);
			} else await this.records.write(`project:active:${projectId}`, null);
			const result = {
				status: 'legacy',
				projectId,
				hash,
				actor,
				restoredHash: candidate.before?.contentHash ?? null,
			};
			await this.records.write(`migration:area:${candidate.source.areaId}`, result);
			return result;
		});
	}
}

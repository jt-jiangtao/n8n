import type { ProjectRecords } from '../database/project-record.repository';
import type { ProjectSnapshot } from './project-config';
export type ApprovedProject = {
	snapshot: ProjectSnapshot;
	actor: string;
	approvedAt: string;
	contentHash: string;
};
export class ProjectConfigurationService {
	constructor(private readonly records: ProjectRecords) {}
	async propose(snapshot: ProjectSnapshot) {
		await this.records.write(
			`project:version:${snapshot.projectId}:${snapshot.contentHash}`,
			snapshot,
		);
		await this.records.write(`project:candidate:${snapshot.projectId}`, snapshot);
		return { projectId: snapshot.projectId, contentHash: snapshot.contentHash };
	}
	async candidate(projectId: string) {
		return await this.records.read<ProjectSnapshot>(`project:candidate:${projectId}`);
	}
	async active(projectId: string) {
		return await this.records.read<ApprovedProject>(`project:active:${projectId}`);
	}
	async approve(projectId: string, hash: string, actor: string) {
		const candidate = await this.candidate(projectId);
		if (!candidate || candidate.contentHash !== hash)
			throw new Error('Project candidate changed; reload before approval');
		return await this.activateSnapshot(candidate, actor);
	}
	async activateVersion(
		projectId: string,
		hash: string,
		actor: string,
		expectedHash: string | null,
	) {
		const candidate = await this.records.read<ProjectSnapshot>(
			`project:version:${projectId}:${hash}`,
		);
		if (!candidate || candidate.projectId !== projectId || candidate.contentHash !== hash)
			throw new Error('Pinned project configuration is unavailable');
		const current = await this.active(projectId);
		if (current?.contentHash === hash && current.actor === actor) return current;
		if ((current?.contentHash ?? null) !== expectedHash)
			throw new Error('Active project configuration changed');
		return await this.activateSnapshot(candidate, actor);
	}
	private async activateSnapshot(candidate: ProjectSnapshot, actor: string) {
		const projectId = candidate.projectId;
		const gate = await this.records.read<{ status: string }>(
			`project:activation-gate:${projectId}:${candidate.contentHash}`,
		);
		if (gate && gate.status !== 'passed')
			throw new Error('Candidate real validation is incomplete');
		const activeProject = await this.active(projectId);
		const owners = (activeProject?.snapshot ?? candidate).config.roles.owner;
		if (['agent-bot', 'flow-desk', 'system'].includes(actor) || !owners?.includes(actor))
			throw new Error('An authorized human must approve project configuration');
		const active = {
			snapshot: candidate,
			actor,
			contentHash: candidate.contentHash,
			approvedAt: new Date().toISOString(),
		};
		await this.records.write(`project:active:${projectId}`, active);
		return active;
	}
}

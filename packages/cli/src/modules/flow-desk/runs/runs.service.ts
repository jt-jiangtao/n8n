import { Service } from '@n8n/di';

import { FlowDeskProjectionService, type FlowDef } from '../projection/projection.service';

type Issue = { id: string; stateName: string; labels: string[] };

@Service()
export class FlowDeskRunsService {
	private active = new Map<string, { flowType: string; definitionHash: string; area: string; executionId?: string }>();
	private snapshots = new Map<string, Record<string, unknown>>();
	private areas: string[] = ['web'];

	constructor(
		private readonly plane: {
			getIssue: (id: string) => Promise<Issue>;
			comment: (issueId: string, body: string) => Promise<unknown>;
			updateIssueState: (issueId: string, state: string) => Promise<unknown>;
		},
		private readonly registry: {
			findActiveByFlowType: (flowType: string) => Promise<(FlowDef & { id: string; flowType: string }) | null>;
			listActiveFlowTypes: () => Promise<Array<{ flowType: string; name: string }>>;
		},
		private readonly projection: FlowDeskProjectionService,
		private readonly executions: { start: (input: unknown) => Promise<{ executionId: string }> },
	) {}

	setConfiguredAreas(areas: string[]) {
		this.areas = areas;
	}

	async handleStateEvent(event: { issueId: string; payload: { new?: string; old?: string } }) {
		const issue = await this.plane.getIssue(event.issueId);
		// M4: trust Plane current state, not stale event payload.
		if (issue.stateName !== '待做') return null;

		const flowLabels = issue.labels.filter((l) => l.startsWith('flow:'));
		const areaLabels = issue.labels.filter((l) => l.startsWith('area:'));

		if (flowLabels.length === 0) return null;

		if (flowLabels.length > 1) {
			await this.fail(issue.id, `多个 flow: 标签冲突: ${flowLabels.join(', ')}`);
			return null;
		}
		if (areaLabels.length !== 1) {
			await this.fail(issue.id, '需要且只能有一个 area: 标签');
			return null;
		}

		const flowType = flowLabels[0].slice('flow:'.length);
		const area = areaLabels[0].slice('area:'.length);

		if (!this.areas.includes(area)) {
			await this.fail(issue.id, `区域不在配置中，已配置: ${this.areas.join(', ')}`);
			return null;
		}

		if (this.active.has(issue.id)) return this.active.get(issue.id)!;

		const workflow = await this.registry.findActiveByFlowType(flowType);
		if (!workflow) {
			const active = await this.registry.listActiveFlowTypes();
			await this.fail(
				issue.id,
				`没有激活的流程 ${flowType}；已激活: ${active.map((a) => a.flowType).join(', ') || '(无)'}`,
			);
			return null;
		}

		const definitionHash = this.projection.definitionHash(workflow);
		const started = await this.executions.start({
			workflowId: workflow.id,
			area,
			parentIssueId: issue.id,
		});
		const run = { flowType, definitionHash, area, executionId: started.executionId };
		this.active.set(issue.id, run);
		this.snapshots.set(issue.id, {
			nodes: workflow.nodes,
			connections: workflow.connections,
			steps: [],
			definitionHash,
		});
		return run;
	}

	private async fail(issueId: string, message: string) {
		await this.plane.comment(issueId, message);
		await this.plane.updateIssueState(issueId, '失败');
	}

	async markSkipped(runId: string, skipIds: string[], keepIds: string[]) {
		void runId;
		void keepIds;
		for (const id of skipIds) {
			await this.plane.updateIssueState(id, '已跳过');
		}
	}

	private runMeta = new Map<
		string,
		{ status: string; childIssueIds: string[]; doneIds: string[] }
	>();

	rememberChildren(executionId: string, childIssueIds: string[]) {
		const meta = this.runMeta.get(executionId) ?? {
			status: 'running',
			childIssueIds: [],
			doneIds: [],
		};
		meta.childIssueIds = [...new Set([...meta.childIssueIds, ...childIssueIds])];
		this.runMeta.set(executionId, meta);
	}

	markChildDone(executionId: string, childIssueId: string) {
		const meta = this.runMeta.get(executionId) ?? {
			status: 'running',
			childIssueIds: [],
			doneIds: [],
		};
		if (!meta.doneIds.includes(childIssueId)) meta.doneIds.push(childIssueId);
		this.runMeta.set(executionId, meta);
	}

	async markConverted(executionId: string) {
		const meta = this.runMeta.get(executionId) ?? {
			status: 'running',
			childIssueIds: [],
			doneIds: [],
		};
		meta.status = 'converted';
		this.runMeta.set(executionId, meta);
		for (const [issueId, run] of this.active) {
			if (run.executionId === executionId) {
				this.active.delete(issueId);
				break;
			}
		}
	}

	async markSkippedRemaining(executionId: string) {
		const meta = this.runMeta.get(executionId);
		if (!meta) return;
		const remaining = meta.childIssueIds.filter((id) => !meta.doneIds.includes(id));
		for (const id of remaining) {
			await this.plane.updateIssueState(id, '已跳过');
		}
	}

	async startOnIssue(input: { issueId: string; flowType: string }) {
		const issue = await this.plane.getIssue(input.issueId);
		const areaLabels = issue.labels.filter((l) => l.startsWith('area:'));
		const area = areaLabels[0]?.slice('area:'.length) ?? this.areas[0];
		const workflow = await this.registry.findActiveByFlowType(input.flowType);
		if (!workflow) throw new Error(`no active flow ${input.flowType}`);
		const definitionHash = this.projection.definitionHash(workflow);
		const started = await this.executions.start({
			workflowId: workflow.id,
			area,
			parentIssueId: input.issueId,
		});
		const run = {
			flowType: input.flowType,
			definitionHash,
			area,
			executionId: started.executionId,
		};
		this.active.set(input.issueId, run);
		this.snapshots.set(input.issueId, {
			nodes: workflow.nodes,
			connections: workflow.connections,
			steps: [],
			definitionHash,
			flowType: input.flowType,
		});
		return started;
	}

	getRunStatus(executionId: string) {
		return this.runMeta.get(executionId)?.status ?? null;
	}

	saveSnapshot(issueId: string, snapshot: Record<string, unknown>) {
		this.snapshots.set(issueId, snapshot);
	}

	clearExecution(issueId: string) {
		const run = this.active.get(issueId);
		if (run) delete run.executionId;
	}

	getSnapshot(issueId: string) {
		return this.snapshots.get(issueId);
	}

	getActive(issueId: string) {
		return this.active.get(issueId);
	}
}

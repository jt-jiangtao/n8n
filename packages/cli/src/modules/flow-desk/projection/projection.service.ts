import { createHash } from 'node:crypto';
import { Service } from '@n8n/di';

export type FlowNode = { id: string; type: string; name: string };
export type FlowDef = {
	nodes: FlowNode[];
	connections: Record<string, { main?: Array<Array<{ node: string }>> }>;
};

const STEP_TYPES = new Set([
	'flowDeskHumanStep',
	'flowDeskAgentStep',
	'flowDeskCiStep',
	'flowDeskUiCheckStep',
	'flowDeskQualityStep',
]);

export class NoStepsError extends Error {
	code = 'NO_STEPS';
	constructor() {
		super('no step nodes');
	}
}

@Service()
export class FlowDeskProjectionService {
	constructor(
		private readonly plane: {
			createIssue: (body: Record<string, unknown>) => Promise<{ id: string; external_id?: string }>;
			createRelation: (body: Record<string, unknown>) => Promise<unknown>;
		},
	) {}

	async orderSteps(def: FlowDef): Promise<Array<{ nodeId: string; name: string; type: string }>> {
		const byName = new Map(def.nodes.map((n) => [n.name, n]));
		const byId = new Map(def.nodes.map((n) => [n.id, n]));
		const resolve = (ref: string) => byId.get(ref) ?? byName.get(ref);
		const trigger = def.nodes.find((n) => n.type === 'flowDeskTrigger');
		if (!trigger) return [];

		const visited = new Set<string>();
		const order: FlowNode[] = [];
		const queue: string[] = [trigger.id];

		const outgoing = (node: FlowNode) =>
			def.connections[node.name]?.main ?? def.connections[node.id]?.main ?? [];

		while (queue.length) {
			const id = queue.shift()!;
			if (visited.has(id)) continue;
			visited.add(id);
			const node = byId.get(id);
			if (!node) continue;
			if (STEP_TYPES.has(node.type)) order.push(node);

			for (const branch of outgoing(node)) {
				for (const link of branch ?? []) {
					const target = resolve(link.node);
					if (target && !visited.has(target.id)) queue.push(target.id);
				}
			}
		}
		return order.map((n) => ({ nodeId: n.id, name: n.name, type: n.type }));
	}

	async mirrorSteps(input: {
		parentIssueId: string;
		nodes: FlowNode[];
		connections: FlowDef['connections'];
		existingByExternalId?: Record<string, string>;
	}): Promise<Array<{ nodeId: string; childIssueId: string; name: string }>> {
		const ordered = await this.orderSteps(input);
		if (ordered.length === 0) throw new NoStepsError();

		const existing = { ...(input.existingByExternalId ?? {}) };
		const created: Array<{ nodeId: string; childIssueId: string; name: string }> = [];
		const relationsMade = new Set<string>();

		for (const step of ordered) {
			const externalId = `flow:${input.parentIssueId}:${step.nodeId}`;
			let childId = existing[externalId];
			if (!childId) {
				const issue = await this.plane.createIssue({
					name: step.name,
					external_id: externalId,
					parent: input.parentIssueId,
				});
				childId = issue.id;
				existing[externalId] = childId;
			}
			created.push({ nodeId: step.nodeId, childIssueId: childId, name: step.name });
		}

		for (let i = 0; i < created.length - 1; i++) {
			const key = `${created[i].childIssueId}->${created[i + 1].childIssueId}`;
			if (relationsMade.has(key) || input.existingByExternalId) {
				// On retry with existing children, skip recreating relations.
				if (input.existingByExternalId && Object.keys(input.existingByExternalId).length >= created.length) {
					continue;
				}
			}
			if (!relationsMade.has(key)) {
				await this.plane.createRelation({
					issue: created[i + 1].childIssueId,
					related_issue: created[i].childIssueId,
					relation_type: 'blocked_by',
				});
				relationsMade.add(key);
			}
		}

		return created;
	}

	definitionHash(def: FlowDef): string {
		return createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16);
	}
}

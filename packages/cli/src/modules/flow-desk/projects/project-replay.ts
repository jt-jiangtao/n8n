import { contentDigest, type ProjectFlow } from './project-config';
import { evaluateCondition } from './conditions';
import type { Run, NodeRecord } from './runtime-model';

export function replayProjectHistory(input: {
	projectId: string;
	flows: Record<string, ProjectFlow>;
	history: Array<{ run: Run; records: NodeRecord[] }>;
	limit?: number;
}) {
	const limit = input.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 20)
		throw new Error('Invalid historical replay limit');
	const runs = [...input.history]
		.sort((a, b) => a.run.startedAt - b.run.startedAt)
		.slice(-limit)
		.map(({ run, records }) => {
			if (run.projectId !== input.projectId) throw new Error('Historical replay project mismatch');
			const candidate = input.flows[run.flowId];
			const unavailable = (reason: string) => ({
				runId: run.executionId,
				status: 'unreplayable' as const,
				reason,
				originalOutcome: run.status,
			});
			if (!candidate) return unavailable('Flow is no longer present');
			const start = candidate.nodes.find((n) => n.type === 'start');
			if (!start) return unavailable('Missing start');
			const tokens: string[] = [];
			const advance = (name: string, index: number) => {
				for (const edge of candidate.connections[name]?.main[index] ?? []) {
					const target = candidate.nodes.find((n) => n.name === edge.node);
					if (!target) throw new Error('Invalid replay target');
					tokens.push(target.id);
				}
			};
			advance(start.name, 0);
			let outcome = 'failed',
				finished = false;
			const applied = run.appliedTasks.filter(
				(id) => records.find((r) => r.taskId === id)?.type !== 'start',
			);
			if (!applied.length) return unavailable('No recorded attempts');
			const unresolved = new Set<string>();
			if (applied.length > (candidate.limits?.maxSteps ?? 128))
				return {
					runId: run.executionId,
					originalOutcome: run.status,
					newOutcome: 'exceeded',
					status: run.status === 'passed' ? ('worse' as const) : ('same' as const),
				};
			for (const id of applied) {
				const recorded = records.find((r) => r.taskId === id);
				if (!recorded) return unavailable('Missing recorded attempt');
				const node = candidate.nodes.find((n) => n.id === recorded.nodeId);
				if (!node || node.type !== recorded.type)
					return unavailable('Node identity or capability changed');
				const at = tokens.indexOf(node.id);
				if (at < 0) {
					outcome = 'failed';
					break;
				}
				tokens.splice(at, 1);
				if (recorded.status === 'passed') {
					unresolved.delete(node.id);
					if (node.type === 'verify')
						for (const id of (node.parameters.resolves ?? []) as string[]) unresolved.delete(id);
				} else unresolved.add(node.id);
				let index = recorded.status === 'passed' ? 0 : recorded.status === 'blocked' ? 2 : 1;
				if (node.type === 'approval') index = recorded.result.decision === 'approve' ? 0 : 1;
				if (node.type === 'if') {
					if (!recorded.replayContext) return unavailable('Condition input was not recorded');
					try {
						index = evaluateCondition(recorded.replayContext, node.parameters) ? 0 : 1;
					} catch {
						return unavailable('Condition input cannot be evaluated');
					}
				}
				if (node.type === 'finish') {
					outcome =
						recorded.status === 'passed'
							? String(node.parameters.outcome ?? 'completed') === 'completed'
								? 'passed'
								: String(node.parameters.outcome)
							: recorded.status;
					finished = true;
					if (outcome === 'passed' && unresolved.size) outcome = 'failed';
					continue;
				}
				advance(node.name, index);
				if (recorded.status !== 'passed' && !tokens.length) {
					outcome = recorded.status;
					finished = true;
				}
			}
			if (tokens.length)
				return unavailable('Candidate requires observations absent from the history');
			if (!finished) outcome = 'failed';
			return {
				runId: run.executionId,
				originalOutcome: run.status,
				newOutcome: outcome,
				status:
					run.status === 'passed' && outcome !== 'passed'
						? ('worse' as const)
						: run.status !== 'passed' && outcome === 'passed'
							? ('improved' as const)
							: ('same' as const),
			};
		});
	const report = {
		projectId: input.projectId,
		runs,
		worseCount: runs.filter((r) => r.status === 'worse').length,
		unreplayableCount: runs.filter((r) => r.status === 'unreplayable').length,
		replayedCount: runs.filter((r) => r.status !== 'unreplayable').length,
	};
	return { ...report, reportHash: contentDigest(report) };
}

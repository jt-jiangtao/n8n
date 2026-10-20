import { describe, expect, it } from 'vitest';
import { replayProjectHistory } from '../project-replay';
import type { Run, NodeRecord } from '../runtime-model';
import type { ProjectFlow } from '../project-config';

const flow = (): ProjectFlow => ({
	id: 'scan',
	nodes: [
		{ id: 's', name: 'Start', type: 'start', parameters: {} },
		{ id: 'a', name: 'Inspect', type: 'agent', parameters: {} },
		{ id: 'f', name: 'Finish', type: 'finish', parameters: { outcome: 'completed' } },
	],
	connections: {
		Start: { main: [[{ node: 'Inspect' }]] },
		Inspect: { main: [[{ node: 'Finish' }]] },
	},
});
function history() {
	const run = {
		projectId: 'p',
		executionId: 'r',
		flowId: 'scan',
		status: 'passed',
		startedAt: 1,
		appliedTasks: ['a', 'f'],
		snapshot: { flow: flow() },
	} as Run;
	const records = [
		{ taskId: 'a', nodeId: 'a', type: 'agent', status: 'passed', result: {} },
		{
			taskId: 'f',
			nodeId: 'f',
			type: 'finish',
			status: 'passed',
			result: {},
			dispatch: { outcome: 'completed' },
		},
	] as NodeRecord[];
	return { run, records };
}
describe('project historical replay', () => {
	it('replays the unresolved-failure gate instead of accepting an old success label', () => {
		const row = history(),
			candidate = flow();
		row.records[0].status = 'failed';
		candidate.connections.Inspect.main = [[], [{ node: 'Finish' }]];
		expect(
			replayProjectHistory({ projectId: 'p', flows: { scan: candidate }, history: [row] })
				.worseCount,
		).toBe(1);
	});
	it('reuses recorded outcomes without any execution adapters', () => {
		const report = replayProjectHistory({
			projectId: 'p',
			flows: { scan: flow() },
			history: [history()],
		});
		expect(report.runs[0].status).toBe('same');
		expect(report.worseCount).toBe(0);
	});
	it('detects a completed history routed to failure by the candidate', () => {
		const candidate = flow();
		candidate.nodes[2].parameters.outcome = 'failed';
		expect(
			replayProjectHistory({ projectId: 'p', flows: { scan: candidate }, history: [history()] })
				.worseCount,
		).toBe(1);
	});
	it('reports missing observations separately and rejects cross-project history', () => {
		const row = history();
		row.records = [];
		expect(
			replayProjectHistory({ projectId: 'p', flows: { scan: flow() }, history: [row] }).runs[0]
				.status,
		).toBe('unreplayable');
		row.run.projectId = 'other';
		expect(() =>
			replayProjectHistory({ projectId: 'p', flows: { scan: flow() }, history: [row] }),
		).toThrow(/project/);
	});
	it('does not infer old conditions using the final run context', () => {
		const row = history();
		const candidate = flow();
		candidate.nodes[1] = {
			id: 'a',
			name: 'Inspect',
			type: 'if',
			parameters: { valueRef: 'items', operator: 'not-empty' },
		};
		row.records[0].type = 'if';
		expect(
			replayProjectHistory({ projectId: 'p', flows: { scan: candidate }, history: [row] }).runs[0]
				.status,
		).toBe('unreplayable');
	});
});

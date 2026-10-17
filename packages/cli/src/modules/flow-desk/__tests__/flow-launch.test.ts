/**
 * Flow engine 1.1 — launch & projection: M4–M22, M99, M100.
 * Fails until runs/projection/flow-api services exist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskRunsService } from '../runs/runs.service';
import { FlowDeskProjectionService } from '../projection/projection.service';
import { FlowDeskFlowApiService } from '../api/flow-api.service';

describe('flow-launch (M4–M22, M99, M100)', () => {
	const plane = {
		getIssue: vi.fn(),
		createIssue: vi.fn(),
		createRelation: vi.fn(),
		updateIssueState: vi.fn(),
		comment: vi.fn(),
		listLabels: vi.fn(),
	};
	const registry = {
		findActiveByFlowType: vi.fn(),
		listActiveFlowTypes: vi.fn(),
	};
	const executions = {
		start: vi.fn(),
	};
	let runs: FlowDeskRunsService;
	let projection: FlowDeskProjectionService;
	let api: FlowDeskFlowApiService;

	beforeEach(() => {
		vi.clearAllMocks();
		projection = new FlowDeskProjectionService(plane as never);
		runs = new FlowDeskRunsService(plane as never, registry as never, projection, executions as never);
		api = new FlowDeskFlowApiService(runs, { serviceToken: 'svc' }, registry as never);
	});

	it('M4: stale event state does not roll Plane current state back', async () => {
		plane.getIssue.mockResolvedValue({ id: 'i1', stateName: '进行中', labels: ['flow:bug-standard', 'area:web'] });
		await runs.handleStateEvent({
			issueId: 'i1',
			payload: { new: '待做', old: '收件箱' },
		});
		expect(executions.start).not.toHaveBeenCalled();
	});

	it('M5: flow:bug-standard + area:web → 待做 starts the active workflow', async () => {
		plane.getIssue.mockResolvedValue({
			id: 'i1',
			stateName: '待做',
			labels: ['flow:bug-standard', 'area:web'],
		});
		registry.findActiveByFlowType.mockResolvedValue({
			id: 'wf-1',
			flowType: 'bug-standard',
			nodes: [{ id: 't', type: 'flowDeskTrigger' }],
			connections: {},
		});
		executions.start.mockResolvedValue({ executionId: 'exec-1' });
		const run = await runs.handleStateEvent({
			issueId: 'i1',
			payload: { new: '待做' },
		});
		expect(executions.start).toHaveBeenCalled();
		expect(run?.flowType).toBe('bug-standard');
		expect(run?.definitionHash).toBeTruthy();
		expect(run?.area).toBe('web');
	});

	it('M6: no flow: label — do not start or comment', async () => {
		plane.getIssue.mockResolvedValue({ id: 'i1', stateName: '待做', labels: ['area:web'] });
		await runs.handleStateEvent({ issueId: 'i1', payload: { new: '待做' } });
		expect(executions.start).not.toHaveBeenCalled();
		expect(plane.comment).not.toHaveBeenCalled();
	});

	it('M7: two flow: labels — fail with comment', async () => {
		plane.getIssue.mockResolvedValue({
			id: 'i1',
			stateName: '待做',
			labels: ['flow:a', 'flow:b', 'area:web'],
		});
		await runs.handleStateEvent({ issueId: 'i1', payload: { new: '待做' } });
		expect(executions.start).not.toHaveBeenCalled();
		expect(plane.comment).toHaveBeenCalled();
		expect(plane.updateIssueState).toHaveBeenCalledWith('i1', '失败');
	});

	it('M8: no active flow for flowType — fail listing active types', async () => {
		plane.getIssue.mockResolvedValue({
			id: 'i1',
			stateName: '待做',
			labels: ['flow:missing', 'area:web'],
		});
		registry.findActiveByFlowType.mockResolvedValue(null);
		registry.listActiveFlowTypes.mockResolvedValue([{ flowType: 'bug-standard', name: 'Bug' }]);
		await runs.handleStateEvent({ issueId: 'i1', payload: { new: '待做' } });
		expect(plane.comment.mock.calls[0][1]).toMatch(/bug-standard/);
	});

	it('M9: missing or duplicate area: — fail', async () => {
		plane.getIssue.mockResolvedValue({
			id: 'i1',
			stateName: '待做',
			labels: ['flow:bug-standard'],
		});
		await runs.handleStateEvent({ issueId: 'i1', payload: { new: '待做' } });
		expect(executions.start).not.toHaveBeenCalled();
		expect(plane.updateIssueState).toHaveBeenCalledWith('i1', '失败');
	});

	it('M10: area not in config — fail listing areas', async () => {
		plane.getIssue.mockResolvedValue({
			id: 'i1',
			stateName: '待做',
			labels: ['flow:bug-standard', 'area:unknown'],
		});
		runs.setConfiguredAreas(['web']);
		await runs.handleStateEvent({ issueId: 'i1', payload: { new: '待做' } });
		expect(plane.comment.mock.calls[0][1]).toMatch(/web/);
	});

	it('M11: duplicate 待做 while run is active — do not restart', async () => {
		plane.getIssue.mockResolvedValue({
			id: 'i1',
			stateName: '待做',
			labels: ['flow:bug-standard', 'area:web'],
		});
		registry.findActiveByFlowType.mockResolvedValue({
			id: 'wf-1',
			flowType: 'bug-standard',
			nodes: [{ id: 't', type: 'flowDeskTrigger' }],
			connections: {},
		});
		executions.start.mockResolvedValue({ executionId: 'exec-1' });
		await runs.handleStateEvent({ issueId: 'i1', payload: { new: '待做' } });
		await runs.handleStateEvent({ issueId: 'i1', payload: { new: '待做' } });
		expect(executions.start).toHaveBeenCalledTimes(1);
	});

	it('M12: only step nodes get child issues, ordered by edges', async () => {
		plane.createIssue.mockImplementation(async ({ external_id }: { external_id: string }) => ({
			id: `c-${external_id}`,
			external_id,
		}));
		const order = await projection.mirrorSteps({
			parentIssueId: 'i1',
			nodes: [
				{ id: 't', type: 'flowDeskTrigger', name: 'T' },
				{ id: 'h', type: 'flowDeskHumanStep', name: 'H' },
				{ id: 'a', type: 'flowDeskAgentStep', name: 'A' },
				{ id: 'c', type: 'flowDeskCiStep', name: 'C' },
				{ id: 'x', type: 'n8n-nodes-base.set', name: 'X' },
			],
			connections: {
				T: { main: [[{ node: 'A' }]] },
				A: { main: [[{ node: 'H' }], []] },
				H: { main: [[{ node: 'C' }]] },
			},
		});
		expect(order.map((s) => s.nodeId)).toEqual(['a', 'h', 'c']);
		expect(plane.createIssue).toHaveBeenCalledTimes(3);
	});

	it('M13: back-edge does not revisit a node', async () => {
		const order = await projection.orderSteps({
			nodes: [
				{ id: 't', type: 'flowDeskTrigger', name: 'T' },
				{ id: 'a', type: 'flowDeskAgentStep', name: 'A' },
				{ id: 'h', type: 'flowDeskHumanStep', name: 'H' },
			],
			connections: {
				T: { main: [[{ node: 'A' }]] },
				A: { main: [[{ node: 'H' }]] },
				H: { main: [[{ node: 'A' }]] }, // back edge
			},
		});
		expect(order.map((s) => s.nodeId)).toEqual(['a', 'h']);
	});

	it('M14: BFS order is stable across two runs', async () => {
		const def = {
			nodes: [
				{ id: 't', type: 'flowDeskTrigger', name: 'T' },
				{ id: 'a', type: 'flowDeskAgentStep', name: 'A' },
				{ id: 'b', type: 'flowDeskHumanStep', name: 'B' },
				{ id: 'c', type: 'flowDeskHumanStep', name: 'C' },
			],
			connections: {
				T: { main: [[{ node: 'A' }]] },
				A: { main: [[{ node: 'B' }, { node: 'C' }]] },
			},
		};
		const first = await projection.orderSteps(def);
		const second = await projection.orderSteps(def);
		expect(first.map((s) => s.nodeId)).toEqual(second.map((s) => s.nodeId));
	});

	it('M15: no step nodes — refuse start with comment', async () => {
		await expect(
			projection.mirrorSteps({
				parentIssueId: 'i1',
				nodes: [{ id: 't', type: 'flowDeskTrigger', name: 'T' }],
				connections: {},
			}),
		).rejects.toMatchObject({ code: 'NO_STEPS' });
	});

	it('M16: retry after partial child create uses external_id, no duplicates', async () => {
		plane.createIssue
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValue({ id: 'child-2', external_id: 'flow:i1:h' });
		plane.createIssue.mockResolvedValueOnce({ id: 'child-1', external_id: 'flow:i1:a' });
		// First attempt fails mid-way; second completes missing only.
		await expect(
			projection.mirrorSteps({
				parentIssueId: 'i1',
				nodes: [
					{ id: 't', type: 'flowDeskTrigger', name: 'T' },
					{ id: 'a', type: 'flowDeskAgentStep', name: 'A' },
					{ id: 'h', type: 'flowDeskHumanStep', name: 'H' },
				],
				connections: { T: { main: [[{ node: 'A' }]] }, A: { main: [[{ node: 'H' }]] } },
			}),
		).rejects.toThrow();
		const second = await projection.mirrorSteps({
			parentIssueId: 'i1',
			nodes: [
				{ id: 't', type: 'flowDeskTrigger', name: 'T' },
				{ id: 'a', type: 'flowDeskAgentStep', name: 'A' },
				{ id: 'h', type: 'flowDeskHumanStep', name: 'H' },
			],
			connections: { T: { main: [[{ node: 'A' }]] }, A: { main: [[{ node: 'H' }]] } },
			existingByExternalId: { 'flow:i1:a': 'child-1' },
		});
		expect(second.find((s) => s.nodeId === 'a')?.childIssueId).toBe('child-1');
	});

	it('M17: blocked-by relations between adjacent children, idempotent', async () => {
		plane.createIssue.mockImplementation(async ({ external_id }: { external_id: string }) => ({
			id: `c-${external_id}`,
			external_id,
		}));
		await projection.mirrorSteps({
			parentIssueId: 'i1',
			nodes: [
				{ id: 't', type: 'flowDeskTrigger', name: 'T' },
				{ id: 'a', type: 'flowDeskAgentStep', name: 'A' },
				{ id: 'h', type: 'flowDeskHumanStep', name: 'H' },
			],
			connections: { T: { main: [[{ node: 'A' }]] }, A: { main: [[{ node: 'H' }]] } },
		});
		expect(plane.createRelation).toHaveBeenCalled();
		const calls = plane.createRelation.mock.calls.length;
		await projection.mirrorSteps({
			parentIssueId: 'i1',
			nodes: [
				{ id: 't', type: 'flowDeskTrigger', name: 'T' },
				{ id: 'a', type: 'flowDeskAgentStep', name: 'A' },
				{ id: 'h', type: 'flowDeskHumanStep', name: 'H' },
			],
			connections: { T: { main: [[{ node: 'A' }]] }, A: { main: [[{ node: 'H' }]] } },
			existingByExternalId: {
				'flow:i1:a': 'c-flow:i1:a',
				'flow:i1:h': 'c-flow:i1:h',
			},
		});
		expect(plane.createRelation.mock.calls.length).toBe(calls);
	});

	it('M18: rename keeps node id; new run uses new title', async () => {
		plane.createIssue.mockResolvedValue({ id: 'c1', external_id: 'flow:i1:a' });
		const steps = await projection.mirrorSteps({
			parentIssueId: 'i1',
			nodes: [
				{ id: 't', type: 'flowDeskTrigger', name: 'T' },
				{ id: 'a', type: 'flowDeskAgentStep', name: 'New Title' },
			],
			connections: { T: { main: [[{ node: 'New Title' }]] } },
		});
		expect(steps[0].nodeId).toBe('a');
		expect(plane.createIssue.mock.calls[0][0].name).toBe('New Title');
	});

	it('M99: unfinished branch children become 已跳过', async () => {
		await runs.markSkipped('run-1', ['child-skipped'], ['child-done', 'child-failed']);
		expect(plane.updateIssueState).toHaveBeenCalledWith('child-skipped', '已跳过');
		expect(plane.updateIssueState).not.toHaveBeenCalledWith('child-done', '已跳过');
	});

	it('M100: flow view survives after execution cleanup via snapshot', async () => {
		runs.saveSnapshot('i1', { nodes: [{ id: 'a' }], connections: {}, steps: [] });
		runs.clearExecution('i1');
		const view = await api.getWorkItemFlow('i1', 'svc');
		expect(view.nodes).toHaveLength(1);
	});

	it('M19: GET work-items flow returns nodes, edges, status, attempts', async () => {
		runs.saveSnapshot('i1', {
			nodes: [{ id: 'a', name: 'A' }],
			connections: {},
			steps: [{ nodeId: 'a', status: 'waiting', attempt: 1, childIssueId: 'c1' }],
		});
		const view = await api.getWorkItemFlow('i1', 'svc');
		expect(view.steps[0]).toMatchObject({ status: 'waiting', attempt: 1 });
	});

	it('M20: no associated flow → 404', async () => {
		await expect(api.getWorkItemFlow('missing', 'svc')).rejects.toMatchObject({ httpCode: 404 });
	});

	it('M21: GET flow-types returns only active', async () => {
		registry.listActiveFlowTypes.mockResolvedValue([{ flowType: 'bug-standard', name: 'Bug' }]);
		const types = await api.listFlowTypes('svc');
		expect(types).toEqual([{ flowType: 'bug-standard', name: 'Bug' }]);
	});

	it('M22: bad service token → 401', async () => {
		await expect(api.listFlowTypes('wrong')).rejects.toMatchObject({ httpCode: 401 });
	});
});

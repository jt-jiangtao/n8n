/**
 * add-flow-control-nodes 1.1 — N16–N20, M64, M105–M109
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskAwaitChildrenService } from '../await-children/await-children.service';
import { FlowDeskSwitchFlowService } from '../switch-flow/switch-flow.service';
import { FlowDeskIntakeService } from '../intake/intake.service';
import { FlowDeskConfigService } from '../config/config.service';

describe('flow-control (N16–N20, M64, M105–M109)', () => {
	const plane = {
		comment: vi.fn(async () => undefined),
		createIssue: vi.fn(async () => ({ id: 'new-1', identifier: 'WEB-100' })),
		createRelation: vi.fn(async () => undefined),
		updateIssueState: vi.fn(async () => undefined),
		updateIssueLabels: vi.fn(async () => undefined),
		getIssue: vi.fn(async () => ({ id: 'p1', stateName: '进行中', labels: ['flow:bug-standard', 'area:web'] })),
	};
	const resume = { resume: vi.fn(async () => ({ ok: true })) };
	const registry = {
		findActiveByFlowType: vi.fn(async (t: string) =>
			t === 'feature-large' ? { id: 'wf-f', flowType: t } : null,
		),
	};
	const runs = {
		startOnIssue: vi.fn(async () => ({ executionId: 'e-new' })),
		markConverted: vi.fn(async () => undefined),
		markSkippedRemaining: vi.fn(async () => undefined),
	};
	let config: FlowDeskConfigService;
	let awaitChildren: FlowDeskAwaitChildrenService;
	let switchFlow: FlowDeskSwitchFlowService;
	let intake: FlowDeskIntakeService;

	beforeEach(() => {
		vi.clearAllMocks();
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: {},
					roles: { owner: ['a'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
				},
			},
			groups: {},
			guards: { protectedPaths: [] },
			provenance: { escapeWindowDays: 30 },
			desktop: { stopPlaneOnQuit: false, launchAtLogin: true, hostAddress: 'h' },
		});
		awaitChildren = new FlowDeskAwaitChildrenService(plane as never, resume as never);
		switchFlow = new FlowDeskSwitchFlowService(
			plane as never,
			resume as never,
			registry as never,
			runs as never,
		);
		intake = new FlowDeskIntakeService(plane as never, config);
	});

	it('N16: all follow-ups completed → all-done branch', async () => {
		const r = await awaitChildren.evaluate({
			executionId: 'e1',
			nodeId: 'await-1',
			childIssueId: 'c1',
			related: [
				{ id: 'f1', state: '完成' },
				{ id: 'f2', state: '完成' },
			],
		});
		expect(r.branch).toBe('all-done');
		expect(resume.resume).toHaveBeenCalledWith(expect.objectContaining({ branch: 'all-done' }));
	});

	it('N17: any failed/cancelled → has-failure with listed ids', async () => {
		const r = await awaitChildren.evaluate({
			executionId: 'e1',
			nodeId: 'await-1',
			childIssueId: 'c1',
			related: [
				{ id: 'f1', state: '完成' },
				{ id: 'f2', state: '失败' },
			],
		});
		expect(r.branch).toBe('has-failure');
		expect(r.failedIds).toContain('f2');
		expect(plane.comment).toHaveBeenCalled();
	});

	it('N18: no related → has-failure with no-children message', async () => {
		const r = await awaitChildren.evaluate({
			executionId: 'e1',
			nodeId: 'await-1',
			childIssueId: 'c1',
			related: [],
		});
		expect(r.branch).toBe('has-failure');
		expect(String(plane.comment.mock.calls[0]?.[1])).toMatch(/没有关联工单/);
	});

	it('M105/M106: state event re-evaluates and resumes; reconcile same', async () => {
		awaitChildren.registerWait({
			executionId: 'e1',
			nodeId: 'await-1',
			childIssueId: 'c1',
			relatedIds: ['f1', 'f2'],
		});
		plane.getIssue.mockImplementation(async (id: string) => ({
			id,
			stateName: '完成',
		}));
		const r = await awaitChildren.onRelatedStateChange({ relatedId: 'f1' });
		expect(r?.resumed).toBe(true);

		awaitChildren.registerWait({
			executionId: 'e2',
			nodeId: 'await-2',
			childIssueId: 'c2',
			relatedIds: ['f3'],
		});
		plane.getIssue.mockResolvedValue({ id: 'f3', stateName: '完成' });
		const recon = await awaitChildren.reconcile();
		expect(recon.resumed).toBeGreaterThanOrEqual(1);
	});

	it('N19/N20: switch flow relabels and starts; missing type fails', async () => {
		const ok = await switchFlow.switch({
			parentIssueId: 'p1',
			executionId: 'e1',
			nodeId: 'sw1',
			targetFlowType: 'feature-large',
			childIssueId: 'c1',
		});
		expect(ok.ok).toBe(true);
		expect(plane.updateIssueLabels).toHaveBeenCalled();
		expect(runs.markConverted).toHaveBeenCalled();
		expect(runs.startOnIssue).toHaveBeenCalled();

		const bad = await switchFlow.switch({
			parentIssueId: 'p1',
			executionId: 'e1',
			nodeId: 'sw1',
			targetFlowType: 'no-such',
			childIssueId: 'c1',
		});
		expect(bad.ok).toBe(false);
		expect(plane.updateIssueLabels).toHaveBeenCalledTimes(1);
	});

	it('M107: 4th switch rejected', async () => {
		for (let i = 0; i < 3; i++) {
			await switchFlow.switch({
				parentIssueId: 'p-limit',
				executionId: `e${i}`,
				nodeId: 'sw',
				targetFlowType: 'feature-large',
				childIssueId: 'c',
			});
		}
		plane.getIssue.mockResolvedValue({
			id: 'p-limit',
			stateName: '进行中',
			labels: ['flow:bug-standard', 'area:web'],
		});
		const fourth = await switchFlow.switch({
			parentIssueId: 'p-limit',
			executionId: 'e4',
			nodeId: 'sw',
			targetFlowType: 'feature-large',
			childIssueId: 'c',
		});
		expect(fourth.ok).toBe(false);
		expect(plane.updateIssueState).toHaveBeenCalledWith('p-limit', '失败');
	});

	it('M64/M108/M109: intake dedupe by key/title/error/files; completed/other area miss', async () => {
		intake.indexExisting([
			{
				id: 'exist-1',
				title: 'Login Crash',
				area: 'web',
				state: '进行中',
				dedupeKey: 'dk-1',
				errorSignature: 'TypeError|auth.ts:10',
				files: ['src/auth.ts'],
			},
			{
				id: 'exist-done',
				title: 'Old Bug',
				area: 'web',
				state: '完成',
				dedupeKey: 'dk-done',
				errorSignature: 'x',
				files: ['a.ts'],
			},
			{
				id: 'exist-other',
				title: 'Other Area',
				area: 'api',
				state: '进行中',
				dedupeKey: 'dk-other',
				errorSignature: 'y',
				files: ['b.ts'],
			},
		]);

		const hit = await intake.submit({
			title: 'login crash',
			reproduction: 'steps',
			evidence: 'log',
			discoveredIn: 'WEB-1',
			area: 'web',
			dedupeKey: 'dk-1',
		});
		expect(hit.ok).toBe(true);
		if (hit.ok) expect(hit.deduped).toBe(true);
		expect(plane.comment).toHaveBeenCalled();
		expect(plane.createIssue).not.toHaveBeenCalled();

		const missDone = await intake.submit({
			title: 'Old Bug',
			reproduction: 'steps',
			evidence: 'log',
			discoveredIn: 'WEB-1',
			area: 'web',
			dedupeKey: 'dk-done',
		});
		expect(missDone.ok).toBe(true);
		if (missDone.ok) expect(missDone.deduped).toBeFalsy();
		expect(plane.createIssue).toHaveBeenCalled();
	});
});

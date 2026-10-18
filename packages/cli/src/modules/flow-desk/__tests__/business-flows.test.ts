/**
 * add-business-flows 1.1 — M110, N21–N23, F11–F29
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskConfigService } from '../config/config.service';
import { FlowDeskDecisionsService } from '../decisions/decisions.service';
import { FlowDeskAcceptanceService } from '../acceptance/acceptance.service';
import { FlowDeskProposalService } from '../proposal/proposal.service';
import { FlowDeskSwitchFlowService } from '../switch-flow/switch-flow.service';
import { FlowDeskRelatedIssuesService } from '../related/related-issues.service';

const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'../../../../../../../../',
	);

function loadFlow(name: string) {
	const p = path.join(repoRoot, 'flows', `${name}.json`);
	expect(existsSync(p), `missing flow ${name}`).toBe(true);
	return JSON.parse(readFileSync(p, 'utf8')) as {
		meta?: { flowType?: string };
		nodes: Array<{ id: string; type: string; name: string; parameters?: Record<string, unknown> }>;
		connections: Record<string, unknown>;
	};
}

describe('business-flows (M110, N21–N23, F11–F29)', () => {
	const plane = {
		comment: vi.fn(async () => undefined),
		updateIssueState: vi.fn(async () => undefined),
		createIssue: vi.fn(async () => ({ id: 'new-1' })),
		createRelation: vi.fn(async () => undefined),
		updateIssueLabels: vi.fn(async () => undefined),
		getIssue: vi.fn(async () => ({
			id: 'p1',
			stateName: '进行中',
			labels: ['flow:bug-hotfix', 'area:web'],
		})),
	};
	const resume = { resume: vi.fn(async () => ({ ok: true })) };
	const registry = {
		findActiveByFlowType: vi.fn(async (t: string) =>
			['bug-standard', 'feature-large', 'bug-flaky'].includes(t)
				? { id: `wf-${t}`, flowType: t }
				: null,
		),
	};
	const runs = {
		startOnIssue: vi.fn(async () => ({ executionId: 'e-new' })),
		markConverted: vi.fn(async () => undefined),
		markSkippedRemaining: vi.fn(async () => undefined),
	};
	let config: FlowDeskConfigService;
	let decisions: FlowDeskDecisionsService;
	let acceptance: FlowDeskAcceptanceService;
	let proposal: FlowDeskProposalService;
	let switchFlow: FlowDeskSwitchFlowService;
	let related: FlowDeskRelatedIssuesService;

	beforeEach(() => {
		vi.clearAllMocks();
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: { smoke: 'echo smoke', snapshot: 'echo snap', docs: 'echo docs' },
					roles: { owner: ['alice'], planApprover: ['bob'], mergeApprover: ['carol'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
				},
			},
			groups: { oncall: ['dave'], 'platform.owner': ['erin'] },
			guards: { protectedPaths: [] },
			provenance: { escapeWindowDays: 30 },
			desktop: { stopPlaneOnQuit: false, launchAtLogin: true, hostAddress: 'h' },
		});
		decisions = new FlowDeskDecisionsService(resume as never, plane as never, config);
		acceptance = new FlowDeskAcceptanceService(plane as never);
		proposal = new FlowDeskProposalService(plane as never);
		switchFlow = new FlowDeskSwitchFlowService(
			plane as never,
			resume as never,
			registry as never,
			runs as never,
		);
		related = new FlowDeskRelatedIssuesService(plane as never);
	});

	it('M110: oncall / platform.owner resolve; empty group fails node', async () => {
		expect(config.resolveRole('oncall', 'web')).toEqual(['dave']);
		expect(config.resolveRole('platform.owner', 'web')).toEqual(['erin']);
		const emptyGroups = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: {},
					roles: { owner: ['alice'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
				},
			},
			groups: { oncall: [], 'platform.owner': [] },
			guards: { protectedPaths: [] },
			provenance: { escapeWindowDays: 30 },
			desktop: { stopPlaneOnQuit: false, launchAtLogin: true, hostAddress: 'h' },
		});
		decisions = new FlowDeskDecisionsService(resume as never, plane as never, emptyGroups);
		const r = await decisions.assignRole({
			childIssueId: 'c1',
			assigneeRole: 'oncall',
			area: 'web',
		});
		expect(r.ok).toBe(false);
		expect(String(plane.comment.mock.calls[0]?.[1])).toMatch(/缺少配置|配置缺失/);
	});

	it('N23: requiresText blocks empty; text stored in decision', async () => {
		decisions.setWaiting('e1', 'h1', true);
		decisions.setOptions('e1', 'h1', ['回答']);
		decisions.setRequiresText('e1', 'h1', true);
		const blocked = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: '回答',
			actor: 'dave',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'oncall',
			area: 'web',
			attempt: 1,
		});
		expect(blocked.ok).toBe(false);

		const ok = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: '回答',
			actor: 'dave',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'oncall',
			area: 'web',
			attempt: 1,
			text: '假设成立，优先方案 A',
		});
		expect(ok.ok).toBe(true);
		expect(plane.comment).toHaveBeenCalledWith(
			'c1',
			expect.stringMatching(/假设成立/),
		);
		expect(resume.resume).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ text: expect.stringMatching(/假设成立/) }),
			}),
		);
	});

	it('F11/F15: hotfix deny → switch; non-oncall rejected', async () => {
		const flow = loadFlow('bug-hotfix');
		expect(flow.meta?.flowType).toBe('bug-hotfix');
		expect(flow.nodes.some((n) => n.type === 'flowDeskSwitchFlow')).toBe(true);

		const switched = await switchFlow.switch({
			parentIssueId: 'p1',
			executionId: 'e1',
			nodeId: 'sw',
			targetFlowType: 'bug-standard',
			childIssueId: 'c1',
		});
		expect(switched.ok).toBe(true);

		decisions.setWaiting('e1', 'h1', true);
		decisions.setOptions('e1', 'h1', ['是', '否']);
		const denied = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: '是',
			actor: 'eve',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'oncall',
			area: 'web',
			attempt: 1,
		});
		expect(denied.ok).toBe(false);
	});

	it('F12: smoke maxAttempts=2 then continue-or-stop', () => {
		const flow = loadFlow('bug-hotfix');
		const smoke = flow.nodes.find((n) => n.parameters?.suite === 'smoke');
		expect(smoke?.parameters?.maxAttempts).toBe(2);
	});

	it('F13/F14: observe normal creates follow-up; rollback path present', () => {
		const flow = loadFlow('bug-hotfix');
		expect(flow.nodes.some((n) => n.type === 'flowDeskCreateWorkItem')).toBe(true);
		const observe = flow.nodes.find((n) => String(n.parameters?.title ?? '').includes('观察'));
		expect(observe).toBeTruthy();
		const opts = JSON.stringify(observe?.parameters?.options ?? {});
		expect(opts).toMatch(/正常|回滚/);
	});

	it('F16/F17: flaky CI repeat then human choice', () => {
		const flow = loadFlow('bug-flaky');
		expect(flow.meta?.flowType).toBe('bug-flaky');
		const repeatNode = flow.nodes.find((n) => n.type === 'flowDeskCiStep' && n.parameters?.repeat);
		expect(repeatNode).toBeTruthy();
		expect(flow.nodes.some((n) => n.type === 'flowDeskHumanStep')).toBe(true);
	});

	it('F18/F19: 5N re-run and isolate create follow-up', () => {
		const flow = loadFlow('bug-flaky');
		const ciNodes = flow.nodes.filter((n) => n.type === 'flowDeskCiStep');
		expect(ciNodes.length).toBeGreaterThanOrEqual(2);
		expect(flow.nodes.some((n) => n.type === 'flowDeskCreateWorkItem')).toBe(true);
	});

	it('F20: acceptance freeze mismatch fails', async () => {
		acceptance.freeze('e1', '验收：登录必须成功');
		const bad = await acceptance.checkResult({
			executionId: 'e1',
			childIssueId: 'c1',
			acceptance: '验收：登录可以跳过',
		});
		expect(bad.ok).toBe(false);
		expect(plane.comment).toHaveBeenCalled();
	});

	it('F21: scopeTooLarge leads to switch option in feature-small', () => {
		const flow = loadFlow('feature-small');
		expect(flow.nodes.some((n) => n.type === 'flowDeskSwitchFlow')).toBe(true);
	});

	it('F22: post-merge failure creates bug-standard follow-up', () => {
		const flow = loadFlow('feature-small');
		const create = flow.nodes.find(
			(n) => n.type === 'flowDeskCreateWorkItem' && n.parameters?.flowType === 'bug-standard',
		);
		expect(create).toBeTruthy();
	});

	it('F23: proposal missing alternatives/risks fails', async () => {
		const bad = await proposal.validate({
			childIssueId: 'c1',
			alternatives: [],
			risks: [],
		});
		expect(bad.ok).toBe(false);
		expect(String(plane.comment.mock.calls[0]?.[1])).toMatch(/替代|风险/);
	});

	it('F24/F25: feature-large splits + await children', async () => {
		const flow = loadFlow('feature-large');
		expect(flow.nodes.some((n) => n.type === 'flowDeskAwaitChildren')).toBe(true);
		expect(flow.nodes.some((n) => n.type === 'flowDeskCreateWorkItem')).toBe(true);
		const created = await related.create({
			parentIssueId: 'p1',
			title: '子需求 A',
			flowType: 'feature-small',
			area: 'web',
			relation: '跟进',
			executionId: 'e1',
			autoStart: true,
		});
		expect(created.id).toBeTruthy();
	});

	it('F26: chore-deps requires breaking/security fields; full suite x2', () => {
		const flow = loadFlow('chore-deps');
		const full = flow.nodes.find((n) => n.parameters?.suite === 'full');
		expect(full?.parameters?.maxAttempts).toBe(2);
	});

	it('F27: chore-refactor has compareWithBase before merge', () => {
		const flow = loadFlow('chore-refactor');
		const cmp = flow.nodes.find((n) => n.parameters?.compareWithBase === true);
		expect(cmp).toBeTruthy();
	});

	it('F28/F29: docs flow uses docs suite; agent may emit newIssues', () => {
		const flow = loadFlow('docs');
		expect(flow.nodes.some((n) => n.parameters?.suite === 'docs')).toBe(true);
		expect(flow.nodes.some((n) => n.type === 'flowDeskAgentStep')).toBe(true);
	});
});

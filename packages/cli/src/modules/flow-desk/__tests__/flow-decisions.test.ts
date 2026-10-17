/** 1.2 decisions & config: M23–M39, M102, M104 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskDecisionsService } from '../decisions/decisions.service';
import { FlowDeskConfigService } from '../config/config.service';

describe('flow-decisions (M23–M39, M102, M104)', () => {
	const resume = { resume: vi.fn(async () => ({ ok: true })) };
	const plane = {
		comment: vi.fn(),
		updateIssueState: vi.fn(),
		ensureProjectStates: vi.fn(),
	};
	let decisions: FlowDeskDecisionsService;
	let config: FlowDeskConfigService;

	beforeEach(() => {
		vi.clearAllMocks();
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: { targeted: 'pnpm test' },
					roles: { planApprover: ['alice'], mergeApprover: ['bob'], owner: ['carol'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
				},
			},
			groups: { oncall: ['dave'], 'platform.owner': ['erin'] },
			guards: { protectedPaths: [] },
			provenance: { escapeWindowDays: 30 },
			desktop: { stopPlaneOnQuit: false, launchAtLogin: true, hostAddress: 'host.docker.internal' },
		});
		decisions = new FlowDeskDecisionsService(resume as never, plane as never, config);
	});

	it('M23: panel approve resumes approve branch and completes child', async () => {
		const r = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: 'approve',
			actor: 'alice',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(r.ok).toBe(true);
		expect(resume.resume).toHaveBeenCalledWith(expect.objectContaining({ branch: 'approve' }));
		expect(plane.updateIssueState).toHaveBeenCalledWith('c1', '完成');
	});

	it('M24: /approve comment equals panel approve', async () => {
		const r = await decisions.fromComment({
			childIssueId: 'c1',
			body: '/approve',
			actor: 'alice',
			executionId: 'e1',
			nodeId: 'h1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(r.ok).toBe(true);
	});

	it('M25: child state → 完成 equals approve', async () => {
		const r = await decisions.fromStateChange({
			childIssueId: 'c1',
			newState: '完成',
			actor: 'alice',
			executionId: 'e1',
			nodeId: 'h1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(r.ok).toBe(true);
	});

	it('M26: reject with reason takes reject branch', async () => {
		const r = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: 'reject',
			reason: 'needs tests',
			actor: 'alice',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(resume.resume).toHaveBeenCalledWith(
			expect.objectContaining({ branch: 'reject', data: expect.objectContaining({ reason: 'needs tests' }) }),
		);
		void r;
	});

	it('M27: reject without reason does not resume', async () => {
		const r = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: 'reject',
			actor: 'alice',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(r.ok).toBe(false);
		expect(plane.comment).toHaveBeenCalled();
		expect(resume.resume).not.toHaveBeenCalled();
	});

	it('M28: actor not in role — no resume', async () => {
		const r = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: 'approve',
			actor: 'stranger',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(r.ok).toBe(false);
	});

	it('M29: agent-bot / flow-desk cannot decide', async () => {
		for (const actor of ['agent-bot', 'flow-desk']) {
			const r = await decisions.submit({
				executionId: 'e1',
				nodeId: 'h1',
				decision: 'approve',
				actor,
				source: 'panel',
				childIssueId: 'c1',
				assigneeRole: 'area.planApprover',
				area: 'web',
				attempt: 1,
			});
			expect(r.ok).toBe(false);
		}
	});

	it('M30: decision while not waiting is ignored', async () => {
		decisions.setWaiting('e1', 'h1', false);
		const r = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: 'approve',
			actor: 'alice',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(r.ok).toBe(false);
		expect(resume.resume).not.toHaveBeenCalled();
	});

	it('M31: duplicate decision resumes once', async () => {
		decisions.setWaiting('e1', 'h1', true);
		const body = {
			executionId: 'e1',
			nodeId: 'h1',
			decision: 'approve' as const,
			actor: 'alice',
			source: 'panel' as const,
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		};
		await decisions.submit(body);
		await decisions.submit({ ...body, source: 'comment' });
		expect(resume.resume).toHaveBeenCalledTimes(1);
	});

	it('M32: custom option / unknown option', async () => {
		decisions.setWaiting('e1', 'h1', true);
		decisions.setOptions('e1', 'h1', ['ship', 'hold']);
		await expect(
			decisions.submit({
				executionId: 'e1',
				nodeId: 'h1',
				decision: 'ship',
				actor: 'alice',
				source: 'panel',
				childIssueId: 'c1',
				assigneeRole: 'area.planApprover',
				area: 'web',
				attempt: 1,
			}),
		).resolves.toMatchObject({ ok: true });
		await expect(
			decisions.submit({
				executionId: 'e1',
				nodeId: 'h1',
				decision: 'nope',
				actor: 'alice',
				source: 'panel',
				childIssueId: 'c1',
				assigneeRole: 'area.planApprover',
				area: 'web',
				attempt: 1,
			}),
		).rejects.toMatchObject({ httpCode: 400 });
	});

	it('M33: wait ceiling comments but keeps waiting', async () => {
		await decisions.onWaitCeiling({ childIssueId: 'c1', executionId: 'e1', nodeId: 'h1' });
		expect(plane.comment).toHaveBeenCalled();
		decisions.setWaiting('e1', 'h1', true);
		const r = await decisions.submit({
			executionId: 'e1',
			nodeId: 'h1',
			decision: 'approve',
			actor: 'alice',
			source: 'panel',
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'web',
			attempt: 1,
		});
		expect(r.ok).toBe(true);
	});

	it('M34: reject back to agent reopens child and bumps attempt', async () => {
		const r = await decisions.reopenAfterReject({
			childIssueId: 'c1',
			reason: 'fix tests',
			previousAttempt: 1,
		});
		expect(r.attempt).toBe(2);
		expect(plane.comment.mock.calls[0][1]).toMatch(/fix tests/);
	});

	it('M35: area.planApprover resolves from area roles', () => {
		expect(config.resolveRole('area.planApprover', 'web')).toEqual(['alice']);
	});

	it('M36: oncall / platform.owner are global', () => {
		expect(config.resolveRole('oncall', 'web')).toEqual(['dave']);
		expect(config.resolveRole('platform.owner', 'web')).toEqual(['erin']);
	});

	it('M37: empty role resolution fails the node', async () => {
		const r = await decisions.assignRole({
			childIssueId: 'c1',
			assigneeRole: 'area.planApprover',
			area: 'missing',
		});
		expect(r.ok).toBe(false);
		expect(plane.updateIssueState).toHaveBeenCalledWith('c1', '失败');
	});

	it('M38: agent/ci settings come from area config', () => {
		const area = config.getArea('web');
		expect(area?.repo).toBe('/tmp/web');
		expect(area?.baseRef).toBe('main');
		expect(area?.suites.targeted).toBe('pnpm test');
	});

	it('M39: invalid config blocks event processing', () => {
		const bad = FlowDeskConfigService.tryLoad('areas: [');
		expect(bad.ok).toBe(false);
		expect(bad.error?.position).toBeTruthy();
	});

	it('M102: reload keeps old config when new file is invalid', () => {
		config.reload('areas: { web: {} }'); // invalid/incomplete
		expect(config.getArea('web')?.repo).toBe('/tmp/web');
		expect(config.status().error).toBeTruthy();
	});

	it('M104: ensure missing flow-desk states are created once', async () => {
		await config.ensureAreaStates(plane as never);
		expect(plane.ensureProjectStates).toHaveBeenCalled();
		await config.ensureAreaStates(plane as never);
		expect(plane.ensureProjectStates).toHaveBeenCalledTimes(1);
	});
});

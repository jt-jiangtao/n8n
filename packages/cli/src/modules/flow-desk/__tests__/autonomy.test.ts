/**
 * add-autonomy-levels 1.1 — M134–M142
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskAutonomyService } from '../autonomy/autonomy.service';
import { FlowDeskConfigService } from '../config/config.service';

const NON_SKIPPABLE = new Set([
	'bug-standard',
	'bug-hotfix',
	'feature-small',
	'feature-large',
	'chore-refactor',
	'ui-audit',
	'code-quality',
	'meta-retro',
	'platform-upgrade',
]);

describe('autonomy (M134–M142)', () => {
	const plane = {
		createIssue: vi.fn(async () => ({ id: 'upgrade-1' })),
		createRelation: vi.fn(async () => undefined),
		comment: vi.fn(async () => undefined),
		updateIssueState: vi.fn(async () => undefined),
	};
	const writeConfig = vi.fn(async () => undefined);
	let config: FlowDeskConfigService;
	let autonomy: FlowDeskAutonomyService;

	beforeEach(() => {
		vi.clearAllMocks();
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: { smoke: 'e', snapshot: 'e', docs: 'e' },
					roles: { owner: ['a'], planApprover: ['a'], mergeApprover: ['carol'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
					autonomy: { docs: 1, 'bug-flaky': 2 },
				},
			},
			groups: { 'platform.owner': ['erin'] },
			guards: { protectedPaths: ['**/auth/**'] },
			provenance: { escapeWindowDays: 30 },
			desktop: { hostAddress: '127.0.0.1' },
			autonomyPolicy: { window: 20, minPassRate: 0.9, maxEscapes: 0, maxReturns: 2 },
		});
		autonomy = new FlowDeskAutonomyService({
			config,
			plane: plane as never,
			writeConfig,
			getGroup: (name) => (name === 'platform.owner' ? ['erin'] : []),
		});
	});

	it('M134: default level 1; non-skippable at 2 fails validation', () => {
		expect(autonomy.getLevel('web', 'docs')).toBe(1);
		expect(autonomy.getLevel('web', 'missing-flow')).toBe(1);
		expect(autonomy.validateAutonomy({ web: { 'bug-standard': 2 } })).toMatchObject({
			ok: false,
		});
		expect(autonomy.validateAutonomy({ web: { docs: 2 } }).ok).toBe(true);
		for (const f of NON_SKIPPABLE) {
			expect(autonomy.canGrantLevel2(f)).toBe(false);
		}
		expect(autonomy.canGrantLevel2('docs')).toBe(true);
	});

	it('M135: evaluate builds upgrade issue only when policy met', async () => {
		const records = Array.from({ length: 20 }, (_, i) => ({
			id: `w${i}`,
			flowType: 'docs',
			area: 'web',
			ended: true,
			confirmPass: true,
			escapes: 0,
			returns: 0,
		}));
		const built = await autonomy.evaluateDaily(records);
		expect(built).toBe(true);
		expect(plane.createIssue).toHaveBeenCalled();

		plane.createIssue.mockClear();
		const bad = records.map((r, i) => (i < 3 ? { ...r, confirmPass: false } : r));
		expect(await autonomy.evaluateDaily(bad)).toBe(false);
		expect(plane.createIssue).not.toHaveBeenCalled();
	});

	it('M136: only platform.owner confirms upgrade writeback', async () => {
		await expect(
			autonomy.confirmUpgrade({ actor: 'alice', area: 'web', flowType: 'docs', toLevel: 2 }),
		).rejects.toMatchObject({ code: 'NOT_PLATFORM_OWNER' });
		await autonomy.confirmUpgrade({ actor: 'erin', area: 'web', flowType: 'docs', toLevel: 2 });
		expect(writeConfig).toHaveBeenCalled();
		expect(autonomy.getLevel('web', 'docs')).toBe(2);
	});

	it('M137: escape demotes level 2 → 1 only', async () => {
		await autonomy.applyEscape({ area: 'web', flowType: 'bug-flaky', issueId: 'a', escapeIssueId: 'b' });
		expect(autonomy.getLevel('web', 'bug-flaky')).toBe(1);
		expect(writeConfig).toHaveBeenCalled();
		expect(plane.comment).toHaveBeenCalledTimes(2);

		writeConfig.mockClear();
		await autonomy.applyEscape({ area: 'web', flowType: 'docs', issueId: 'c', escapeIssueId: 'd' });
		expect(autonomy.getLevel('web', 'docs')).toBe(1);
		expect(writeConfig).not.toHaveBeenCalled();
	});

	it('M138: level-2 skipAtLevel records autonomy decision + sample issue', async () => {
		const r = await autonomy.maybeAutoPass({
			area: 'web',
			flowType: 'bug-flaky',
			parentIssueId: 'p1',
			skipAtLevel: 2,
			touchedPaths: ['src/x.ts'],
		});
		expect(r.autoPassed).toBe(true);
		expect(r.decision).toBe('autonomy');
		expect(plane.createIssue).toHaveBeenCalledWith(
			expect.objectContaining({
				labels: expect.not.arrayContaining([expect.stringMatching(/^flow:/)]),
			}),
		);
		expect(plane.createRelation).toHaveBeenCalledWith(expect.any(String), 'p1', '跟进');
	});

	it('M139/M140: protected path or major/security deps do not skip', async () => {
		expect(
			(
				await autonomy.maybeAutoPass({
					area: 'web',
					flowType: 'bug-flaky',
					parentIssueId: 'p',
					skipAtLevel: 2,
					touchedPaths: ['src/auth/login.ts'],
				})
			).autoPassed,
		).toBe(false);

		expect(
			(
				await autonomy.maybeAutoPass({
					area: 'web',
					flowType: 'chore-deps',
					parentIssueId: 'p',
					skipAtLevel: 2,
					touchedPaths: ['package.json'],
					depsMajorOrSecurity: true,
				})
			).autoPassed,
		).toBe(false);
	});

	it('M141: level 0 ends run after writes agent suggestion', async () => {
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: { smoke: 'e', snapshot: 'e', docs: 'e' },
					roles: { owner: ['a'], planApprover: ['a'], mergeApprover: ['a'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
					autonomy: { docs: 0 },
				},
			},
			groups: { 'platform.owner': ['erin'] },
			guards: { protectedPaths: [] },
			provenance: { escapeWindowDays: 30 },
			desktop: { hostAddress: '127.0.0.1' },
		});
		autonomy = new FlowDeskAutonomyService({
			config,
			plane: plane as never,
			writeConfig,
			getGroup: () => ['erin'],
		});
		const r = await autonomy.handleLevel0Writes({
			parentIssueId: 'p0',
			childIssueId: 'c0',
			suggestion: 'update docs',
		});
		expect(r.endRun).toBe(true);
		expect(plane.comment).toHaveBeenCalledWith('p0', expect.stringMatching(/0 级/));
		expect(plane.updateIssueState).toHaveBeenCalledWith('p0', '完成');
	});

	it('M142: agent-bot / flow-desk cannot confirm; autonomy decisions only from module', () => {
		expect(autonomy.isAutonomyDecisionActor('agent-bot')).toBe(false);
		expect(autonomy.isAutonomyDecisionActor('flow-desk')).toBe(false);
		expect(autonomy.isAutonomyDecisionActor('module')).toBe(true);
	});
});

/**
 * add-agent-runner 1.3 — M40–M58, M62, M63, M65, M75, M91–M96
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskTasksService } from '../tasks/tasks.service';
import { FlowDeskGuardsService } from '../guards/guards.service';
import { FlowDeskIntakeService } from '../intake/intake.service';
import { FlowDeskProvenanceService } from '../provenance/provenance.service';
import { FlowDeskSecretsService } from '../secrets/secrets.service';
import { FlowDeskConfigService } from '../config/config.service';

describe('agent-tasks (M40–M58, M62, M63, M65, M75, M91–M96)', () => {
	const runner = {
		dispatch: vi.fn(async () => ({ ok: true })),
		abort: vi.fn(async () => undefined),
		status: vi.fn(async () => 200),
	};
	const plane = {
		comment: vi.fn(async () => undefined),
		createIssue: vi.fn(async () => ({ id: 'inbox-1', identifier: 'WEB-99' })),
		createRelation: vi.fn(async () => undefined),
		updateIssueState: vi.fn(async () => undefined),
		createPage: vi.fn(async () => ({ id: 'page-1', url: 'flowdesk://page/page-1' })),
	};
	const resume = { resume: vi.fn(async () => ({ ok: true })) };
	const commits = {
		register: vi.fn(async (row: { sha: string }) => ({ created: true, sha: row.sha })),
		findBySha: vi.fn(async () => null as null | { sha: string; workItem: string; completedAt?: string }),
		list: vi.fn(async () => [] as { sha: string; workItem: string; completedAt?: string }[]),
	};
	let config: FlowDeskConfigService;
	let tasks: FlowDeskTasksService;
	let guards: FlowDeskGuardsService;
	let intake: FlowDeskIntakeService;
	let provenance: FlowDeskProvenanceService;
	let secrets: FlowDeskSecretsService;
	let tokenFile: { value: string };

	beforeEach(() => {
		vi.clearAllMocks();
		tokenFile = { value: 'runner-token-v1' };
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: { targeted: 'pnpm test', full: 'pnpm test:e2e' },
					roles: { planApprover: ['alice'], mergeApprover: ['bob'], owner: ['carol'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
				},
			},
			groups: { admins: ['admin-1'] },
			guards: {
				protectedPaths: ['**/auth/**'],
				baselinePaths: ['vendor/plane/**', 'vendor/n8n/**'],
				killSwitch: false,
			},
			provenance: { escapeWindowDays: 30 },
			desktop: { stopPlaneOnQuit: false, launchAtLogin: true, hostAddress: 'host.docker.internal' },
		});
		secrets = new FlowDeskSecretsService({
			readRunnerToken: async () => tokenFile.value,
			forwardCursorKey: async () => ({ ok: true }),
			isAdmin: (actor) => actor === 'admin-1',
			serviceToken: 'svc',
			shellToken: 'shell',
		});
		guards = new FlowDeskGuardsService(config, runner as never, plane as never);
		tasks = new FlowDeskTasksService(
			config,
			runner as never,
			plane as never,
			resume as never,
			guards,
			secrets,
		);
		intake = new FlowDeskIntakeService(plane as never, config);
		provenance = new FlowDeskProvenanceService(commits as never, plane as never, config);
	});

	it('M40: Agent Step dispatches kind=agent with requiredFields and rejectReasons', async () => {
		await tasks.dispatchAgent({
			taskId: 't1',
			workItem: 'WEB-1',
			step: 'implement',
			attempt: 2,
			area: 'web',
			flowRunId: 'fr-1',
			instructions: 'fix',
			acceptance: 'tests pass',
			requiredFields: ['summary', 'changes'],
			rejectReasons: ['needs tests'],
			nodeAdapter: 'cursor',
		});
		expect(runner.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'agent',
				adapter: 'cursor',
				requiredFields: ['summary', 'changes'],
				context: expect.objectContaining({ rejectReasons: ['needs tests'] }),
			}),
		);
	});

	it('M41: CI Step dispatches kind=ci with suite command', async () => {
		await tasks.dispatchCi({
			taskId: 't2',
			workItem: 'WEB-1',
			step: 'targeted-regression',
			attempt: 1,
			area: 'web',
			flowRunId: 'fr-1',
			suite: 'targeted',
		});
		expect(runner.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'ci',
				command: 'pnpm test',
			}),
		);
	});

	it('M42/M43: valid agent result comments and resumes success; long reasoning uses page', async () => {
		const short = await tasks.handleAgentResult({
			taskId: 't1',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c1',
			attempt: 1,
			result: {
				workItem: 'WEB-1',
				step: 'implement',
				attempt: 1,
				summary: 'done',
				changes: { files: ['a.ts'], branch: 'agent/WEB-1', pr: 'https://example/pr/1' },
				verification: { howToCheck: 'ok', tests: [] },
				regression: { suite: 'targeted' },
				risks: [],
				needsFromHuman: '',
				status: 'ok',
			},
			requiredFields: [],
		});
		expect(short.branch).toBe('success');
		expect(plane.comment).toHaveBeenCalled();
		expect(resume.resume).toHaveBeenCalledWith(expect.objectContaining({ branch: 'success' }));

		const longReasoning = 'x'.repeat(5000);
		await tasks.handleAgentResult({
			taskId: 't1b',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c1',
			attempt: 1,
			result: {
				workItem: 'WEB-1',
				step: 'implement',
				attempt: 1,
				summary: 'done',
				changes: { files: ['a.ts'] },
				verification: { howToCheck: 'ok', tests: [] },
				regression: { suite: 'targeted' },
				risks: [],
				needsFromHuman: '',
				reasoning: longReasoning,
				status: 'ok',
			},
			requiredFields: [],
		});
		expect(plane.createPage).toHaveBeenCalled();
	});

	it('M44–M46: missing fields fail; attempt mismatch rejected; duplicate ignored', async () => {
		const missing = await tasks.handleAgentResult({
			taskId: 't3',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c1',
			attempt: 1,
			result: {
				workItem: 'WEB-1',
				step: 'implement',
				attempt: 1,
				summary: '',
				changes: { files: [] },
				verification: { howToCheck: '', tests: [] },
				regression: { suite: 'targeted' },
				risks: [],
				needsFromHuman: '',
				status: 'ok',
			},
			requiredFields: ['reproduction'],
		});
		expect(missing.branch).toBe('failure');
		expect(missing.missing).toEqual(expect.arrayContaining(['summary', 'reproduction']));

		resume.resume.mockClear();
		const mismatch = await tasks.handleAgentResult({
			taskId: 't4',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c1',
			attempt: 2,
			result: {
				workItem: 'WEB-1',
				step: 'implement',
				attempt: 1,
				summary: 'ok',
				changes: { files: ['a.ts'] },
				verification: { howToCheck: 'ok', tests: [] },
				regression: { suite: 'targeted' },
				risks: [],
				needsFromHuman: '',
				status: 'ok',
			},
			requiredFields: [],
		});
		expect(mismatch.accepted).toBe(false);
		expect(resume.resume).not.toHaveBeenCalled();

		const once = await tasks.handleAgentResult({
			taskId: 't5',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c1',
			attempt: 1,
			result: {
				workItem: 'WEB-1',
				step: 'implement',
				attempt: 1,
				summary: 'ok',
				changes: { files: ['a.ts'] },
				verification: { howToCheck: 'ok', tests: [] },
				regression: { suite: 'targeted' },
				risks: [],
				needsFromHuman: '',
				status: 'ok',
			},
			requiredFields: [],
		});
		expect(once.accepted).toBe(true);
		const twice = await tasks.handleAgentResult({
			taskId: 't5',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c1',
			attempt: 1,
			result: once.result as never,
			requiredFields: [],
		});
		expect(twice.accepted).toBe(false);
		expect(twice.reason).toMatch(/duplicate|重复/i);
	});

	it('M47/M48: progress throttled; CI result branches on exitCode', async () => {
		const childIssueId = 'c-progress';
		await tasks.reportProgress({ childIssueId, text: 'a', at: 1000 });
		await tasks.reportProgress({ childIssueId, text: 'b', at: 1100 });
		await tasks.reportProgress({ childIssueId, text: 'c', at: 1200 });
		expect(plane.comment.mock.calls.filter((c) => c[0] === childIssueId).length).toBeLessThanOrEqual(1);

		const pass = await tasks.handleCiResult({
			taskId: 'ci1',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c2',
			attempt: 1,
			result: { exitCode: 0, summary: 'ok', cases: [] },
		});
		expect(pass.branch).toBe('pass');
		const fail = await tasks.handleCiResult({
			taskId: 'ci2',
			executionId: 'e1',
			nodeId: 'n1',
			childIssueId: 'c2',
			attempt: 1,
			result: { exitCode: 1, summary: 'fail', cases: [{ name: 't', ok: false }] },
		});
		expect(fail.branch).toBe('failure');
	});

	it('M49/M50/M75: runner unavailable retries then fails; 401; token file re-read', async () => {
		runner.dispatch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		runner.dispatch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		runner.dispatch.mockResolvedValueOnce({ ok: true });
		await tasks.dispatchAgent({
			taskId: 't-retry',
			workItem: 'WEB-1',
			step: 'implement',
			attempt: 1,
			area: 'web',
			flowRunId: 'fr-1',
			instructions: 'x',
			acceptance: 'y',
			requiredFields: [],
			rejectReasons: [],
			maxRetries: 3,
		});
		expect(runner.dispatch).toHaveBeenCalledTimes(3);

		runner.dispatch.mockClear();
		runner.dispatch.mockResolvedValue({ ok: false, status: 401 });
		await expect(
			tasks.dispatchAgent({
				taskId: 't-401',
				workItem: 'WEB-1',
				step: 'implement',
				attempt: 1,
				area: 'web',
				flowRunId: 'fr-1',
				instructions: 'x',
				acceptance: 'y',
				requiredFields: [],
				rejectReasons: [],
			}),
		).rejects.toMatchObject({ status: 401 });

		tokenFile.value = 'runner-token-v2';
		runner.dispatch.mockClear();
		runner.dispatch.mockResolvedValue({ ok: true });
		await tasks.dispatchAgent({
			taskId: 't-token',
			workItem: 'WEB-1',
			step: 'implement',
			attempt: 1,
			area: 'web',
			flowRunId: 'fr-1',
			instructions: 'x',
			acceptance: 'y',
			requiredFields: [],
			rejectReasons: [],
		});
		expect(runner.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ token: 'runner-token-v2' }),
		);
	});

	it('M51–M55: kill switch, unsandboxed mark, adapter selection', async () => {
		config.setKillSwitch(true);
		const blocked = await tasks.dispatchAgent({
			taskId: 't-ks',
			workItem: 'WEB-1',
			step: 'implement',
			attempt: 1,
			area: 'web',
			flowRunId: 'fr-1',
			instructions: 'x',
			acceptance: 'y',
			requiredFields: [],
			rejectReasons: [],
			childIssueId: 'c-ks',
		});
		expect(blocked.dispatched).toBe(false);
		expect(plane.comment).toHaveBeenCalled();
		expect(runner.dispatch).not.toHaveBeenCalled();

		await guards.onKillSwitchOpened({ runningTaskIds: ['t-run'] });
		expect(runner.abort).toHaveBeenCalledWith('t-run');

		const humanOk = await guards.allowsHumanStep();
		expect(humanOk).toBe(true);

		const cursorComment = guards.annotateResult({
			adapter: 'cursor',
			sandboxed: false,
			files: ['src/a.ts'],
		});
		expect(cursorComment).toMatch(/未在沙箱|unsandboxed/i);
		const codexComment = guards.annotateResult({
			adapter: 'codex',
			sandboxed: true,
			files: ['src/a.ts'],
		});
		expect(codexComment).not.toMatch(/未在沙箱|unsandboxed/i);

		expect(guards.selectAdapter({ nodeAdapter: 'cursor', areaAdapter: 'fake' })).toBe('cursor');
		expect(() => guards.selectAdapter({ nodeAdapter: undefined, areaAdapter: undefined })).toThrow(
			/adapter|适配器/i,
		);
	});

	it('M56–M58: protected/baseline paths; kill-switch auth', async () => {
		const protectedHit = guards.checkPaths(['src/auth/login.ts']);
		expect(protectedHit.protected).toContain('src/auth/login.ts');
		const baselineHit = guards.checkPaths(['vendor/plane/apps/api/x.py']);
		expect(baselineHit.baseline).toContain('vendor/plane/apps/api/x.py');
		expect(baselineHit.allowed).toBe(false);

		const badSvc = await guards.setKillSwitch({ on: true, actor: 'admin-1', serviceToken: 'wrong' });
		expect(badSvc.status).toBe(401);
		const notAdmin = await guards.setKillSwitch({ on: true, actor: 'alice', serviceToken: 'svc' });
		expect(notAdmin.status).toBe(403);
		const badShell = await guards.setKillSwitch({ on: true, actor: 'shell', shellToken: 'wrong' });
		expect(badShell.status).toBe(401);
		const ok = await guards.setKillSwitch({ on: true, actor: 'admin-1', serviceToken: 'svc' });
		expect(ok.status).toBe(200);
		expect(config.getKillSwitch()).toBe(true);
	});

	it('M62/M63/M65: intake with evidence; reject missing; accept starts flow', async () => {
		const ok = await intake.submit({
			title: 'found bug',
			reproduction: 'click X',
			evidence: 'screenshot',
			discoveredIn: 'WEB-1',
			area: 'web',
		});
		expect(ok.ok).toBe(true);
		expect(plane.createIssue).toHaveBeenCalledWith(
			expect.objectContaining({
				labels: expect.arrayContaining(['source:agent']),
			}),
		);
		expect(plane.createRelation).toHaveBeenCalled();

		const bad = await intake.submit({
			title: 'no evidence',
			reproduction: '',
			evidence: '',
			discoveredIn: 'WEB-1',
			area: 'web',
		});
		expect(bad.ok).toBe(false);
		expect(bad.missing).toEqual(expect.arrayContaining(['reproduction', 'evidence']));

		const accepted = await intake.accept({ issueId: 'inbox-1', actor: 'alice' });
		expect(accepted.state).toBe('待做');
		expect(plane.updateIssueState).toHaveBeenCalledWith('inbox-1', '待做');
	});

	it('M91–M96: commit register + provenance escape / not-escape', async () => {
		commits.register.mockResolvedValueOnce({ created: true, sha: 'abc1234' });
		commits.register.mockResolvedValueOnce({ created: false, sha: 'abc1234' });
		const first = await provenance.registerCommit({
			sha: 'abc1234',
			workItem: 'WEB-1',
			flowRunId: 'fr-1',
			area: 'web',
			branch: 'agent/WEB-1',
		});
		const second = await provenance.registerCommit({
			sha: 'abc1234',
			workItem: 'WEB-1',
			flowRunId: 'fr-1',
			area: 'web',
			branch: 'agent/WEB-1',
		});
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);

		const recent = new Date().toISOString();
		commits.findBySha.mockResolvedValueOnce({
			sha: 'deadbee',
			workItem: 'WEB-OLD',
			completedAt: recent,
		});
		const linked = await provenance.linkEscape({
			newIssueId: 'WEB-NEW',
			introducingCommits: [{ sha: 'deadbee', file: 'a.ts', line: 10 }],
		});
		expect(linked.linked).toBe(true);
		expect(plane.createRelation).toHaveBeenCalled();

		commits.findBySha.mockResolvedValueOnce({
			sha: 'oldold1',
			workItem: 'WEB-ANCIENT',
			completedAt: new Date(Date.now() - 90 * 86400_000).toISOString(),
		});
		const stale = await provenance.linkEscape({
			newIssueId: 'WEB-NEW2',
			introducingCommits: [{ sha: 'oldold1', file: 'a.ts', line: 1 }],
		});
		expect(stale.linked).toBe(false);

		commits.findBySha.mockResolvedValueOnce(null);
		const byMarker = await provenance.linkEscape({
			newIssueId: 'WEB-NEW3',
			introducingCommits: [{ sha: 'mark123', file: 'a.ts', line: 1, message: 'fix\n\nWork-Item: WEB-MARK' }],
		});
		expect(byMarker.matchedWorkItem).toBe('WEB-MARK');

		commits.findBySha.mockResolvedValueOnce(null);
		const none = await provenance.linkEscape({
			newIssueId: 'WEB-NEW4',
			introducingCommits: [{ sha: 'zzzzzzz', file: 'a.ts', line: 1, message: 'no marker' }],
		});
		expect(none.linked).toBe(false);

		const denied = await provenance.notEscape({
			issueId: 'WEB-NEW',
			relatedId: 'WEB-OLD',
			reason: 'false positive',
		});
		expect(denied.ok).toBe(true);
		const needReason = await provenance.notEscape({
			issueId: 'WEB-NEW',
			relatedId: 'WEB-OLD',
			reason: '',
		});
		expect(needReason.ok).toBe(false);
	});
});

import { describe, expect, it } from 'vitest';
import {
	gateResults,
	joinChildren,
	approvalDigest,
	assertApproval,
	transition,
} from '../execution-policy';
const identity = {
	projectId: 'p',
	runId: 'r',
	nodeId: 'n',
	attempt: 1,
	taskId: 't',
	instanceId: 'local',
	configHash: 'config',
};
describe('success, evidence and approval boundaries', () => {
	it('does not allow normal progress on a self-declared success', () => {
		expect(() =>
			gateResults([{ name: 'tests', status: 'passed' }], ['tests'], {
				candidateSha: 'a',
				configHash: 'c',
			}),
		).toThrow();
	});
	it('requires all evidence to bind the actual candidate and configuration', () => {
		expect(
			gateResults(
				[
					{
						name: 'tests',
						status: 'passed',
						candidateSha: 'a',
						configHash: 'c',
						artifactHash: 'report',
					},
				],
				['tests'],
				{ candidateSha: 'a', configHash: 'c' },
			).passed,
		).toBe(true);
		expect(() =>
			gateResults(
				[
					{
						name: 'tests',
						status: 'passed',
						candidateSha: 'old',
						configHash: 'c',
						artifactHash: 'report',
					},
				],
				['tests'],
				{ candidateSha: 'a', configHash: 'c' },
			),
		).toThrow();
		expect(() => gateResults([], ['tests'], { candidateSha: 'a', configHash: 'c' })).toThrow();
	});
	it('requires a human and the same approved content', () => {
		const subject = {
			projectId: 'p',
			runId: 'r',
			configHash: 'c',
			candidateSha: 'a',
			targetSha: 'b',
			scopeHash: 'scope',
			evidenceHash: 'e',
		};
		const receipt = {
			...subject,
			actor: 'human',
			decision: 'approve',
			digest: approvalDigest(subject),
		};
		expect(() => assertApproval(receipt, subject, ['human'])).not.toThrow();
		expect(() => assertApproval({ ...receipt, actor: 'agent-bot' }, subject, ['human'])).toThrow();
		expect(() =>
			assertApproval(receipt, { ...subject, candidateSha: 'changed' }, ['human']),
		).toThrow();
	});
	it('joins only the declared successful child runs', () => {
		expect(
			joinChildren(
				['a', 'b'],
				[
					{ runId: 'a', status: 'passed' },
					{ runId: 'b', status: 'passed' },
				],
			).status,
		).toBe('passed');
		expect(joinChildren(['a', 'b'], [{ runId: 'a', status: 'passed' }]).status).toBe('waiting');
		expect(joinChildren(['a'], [{ runId: 'a', status: 'canceled' }]).status).toBe('failed');
		expect(joinChildren([], []).status).toBe('failed');
	});
	it('rejects stale events and terminal state overwrite', () => {
		const state = { ...identity, status: 'running' };
		expect(transition(state, { ...identity, status: 'passed' }).status).toBe('passed');
		expect(() => transition(state, { ...identity, attempt: 2, status: 'passed' })).toThrow();
		expect(() =>
			transition({ ...state, status: 'passed' }, { ...identity, status: 'failed' }),
		).toThrow();
	});
});

it('accepts complete repeated evidence only when every declared round has passed', () => {
	const evidence = [0, 1].map((round) => ({
		name: 'flaky',
		round,
		status: 'passed',
		candidateSha: 'a',
		configHash: 'c',
		artifactHash: `report-${round}`,
	}));
	expect(
		gateResults(evidence, [{ name: 'flaky', repeat: 2 }], { candidateSha: 'a', configHash: 'c' })
			.passed,
	).toBe(true);
	expect(() =>
		gateResults(evidence.slice(0, 1), [{ name: 'flaky', repeat: 2 }], {
			candidateSha: 'a',
			configHash: 'c',
		}),
	).toThrow();
	expect(() =>
		gateResults([evidence[0]!, evidence[0]!], [{ name: 'flaky', repeat: 2 }], {
			candidateSha: 'a',
			configHash: 'c',
		}),
	).toThrow();
});

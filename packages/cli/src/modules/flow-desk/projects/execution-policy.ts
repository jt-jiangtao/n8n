import { createHash } from 'node:crypto';

export type VerificationEvidence = {
	name: string;
	round?: number;
	status: string;
	candidateSha?: string;
	configHash?: string;
	artifactHash?: string;
};
export type ApprovalSubject = {
	projectId: string;
	runId: string;
	configHash: string;
	candidateSha: string;
	targetSha: string;
	scopeHash: string;
	evidenceHash: string;
};
export function approvalDigest(subject: ApprovalSubject): string {
	const fields = [
		'projectId',
		'runId',
		'configHash',
		'candidateSha',
		'targetSha',
		'scopeHash',
		'evidenceHash',
	] as const;
	for (const key of fields)
		if (typeof subject[key] !== 'string' || !subject[key])
			throw new Error(`Missing approval binding: ${key}`);
	return createHash('sha256')
		.update(JSON.stringify(fields.map((key) => [key, subject[key]])))
		.digest('hex');
}
export function assertApproval(
	receipt: ApprovalSubject & { actor: string; decision: string; digest: string },
	subject: ApprovalSubject,
	actors: string[],
): void {
	if (
		['agent-bot', 'flow-desk', 'system'].includes(receipt.actor) ||
		!actors.includes(receipt.actor) ||
		receipt.decision !== 'approve'
	)
		throw new Error('An authorized human must approve this action');
	if (receipt.digest !== approvalDigest(subject) || approvalDigest(receipt) !== receipt.digest)
		throw new Error('Approval no longer matches the candidate, target, scope or evidence');
}
export function gateResults(
	results: VerificationEvidence[],
	required: Array<string | { name: string; repeat?: number }>,
	expected: { candidateSha: string; configHash: string },
) {
	if (!required.length) throw new Error('A verification gate must declare required checks');
	const names = new Set<string>();
	for (const result of results) {
		const key = `${result.name}:${result.round ?? 0}`;
		if (names.has(key)) throw new Error('Duplicate verification evidence');
		names.add(key);
	}
	for (const check of required) {
		const { name, repeat = 1 } = typeof check === 'string' ? { name: check } : check;
		if (!Number.isInteger(repeat) || repeat < 1 || repeat > 1000)
			throw new Error('Invalid verification repeat count');
		const matching = results.filter((item) => item.name === name);
		if (matching.length !== repeat) throw new Error(`Incomplete verification rounds: ${name}`);
		for (let round = 0; round < repeat; round++) {
			const result = matching.find((item) => (item.round ?? 0) === round);
			if (
				!result ||
				result.status !== 'passed' ||
				result.candidateSha !== expected.candidateSha ||
				result.configHash !== expected.configHash ||
				!result.artifactHash
			)
				throw new Error(`Verification did not pass with matching evidence: ${name}`);
		}
	}
	return {
		passed: true as const,
		evidenceHash: createHash('sha256')
			.update(
				JSON.stringify(
					[...results].sort(
						(a, b) => a.name.localeCompare(b.name) || (a.round ?? 0) - (b.round ?? 0),
					),
				),
			)
			.digest('hex'),
	};
}
export function joinChildren(
	expected: string[],
	results: Array<{ runId: string; status: string }>,
	allowEmpty = false,
) {
	if (!expected.length)
		return { status: allowEmpty ? 'passed' : 'failed', reason: 'No child runs' };
	if (
		new Set(expected).size !== expected.length ||
		results.some((item) => !expected.includes(item.runId)) ||
		new Set(results.map((item) => item.runId)).size !== results.length
	)
		throw new Error('Child run identity mismatch');
	if (
		results.some((item) =>
			['failed', 'blocked', 'timed-out', 'canceled', 'exceeded'].includes(item.status),
		)
	)
		return { status: 'failed' };
	if (results.length !== expected.length || results.some((item) => item.status !== 'passed'))
		return { status: 'waiting' };
	return { status: 'passed' };
}
const identity = [
	'projectId',
	'runId',
	'nodeId',
	'attempt',
	'taskId',
	'instanceId',
	'configHash',
] as const;
type Attempt = Record<(typeof identity)[number], string | number> & { status: string };
const terminal = new Set([
	'passed',
	'failed',
	'blocked',
	'timed-out',
	'canceled',
	'exceeded',
	'skipped',
]);
const states = new Set(['queued', 'running', 'waiting-approval', ...terminal]);
export function transition(current: Attempt, event: Attempt): Attempt {
	if (identity.some((key) => current[key] !== event[key]))
		throw new Error('Stale or conflicting execution identity');
	if (!states.has(event.status)) throw new Error('Unknown execution state');
	if (terminal.has(current.status)) {
		if (current.status === event.status) return current;
		throw new Error('A terminal attempt cannot be overwritten');
	}
	if (
		current.status === 'queued' &&
		!['running', 'canceled', 'failed', 'blocked'].includes(event.status)
	)
		throw new Error('A queued task must start before it can finish');
	return { ...current, ...event };
}

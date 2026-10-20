import { contentDigest, type ProjectSnapshot } from './project-config';
import { replayProjectHistory } from './project-replay';
import type { Run, NodeRecord } from './runtime-model';
export function configurationTrial(input: {
	candidate: ProjectSnapshot;
	original: ProjectSnapshot;
	candidateSha: string;
	history: Array<{ run: Run; records: NodeRecord[] }>;
	samples: unknown[];
}) {
	if (!input.history.length)
		throw new Error('Configuration validation has no recorded historical runs');
	const replay = replayProjectHistory({
		projectId: input.candidate.projectId,
		flows: input.candidate.flows,
		history: input.history,
	});
	if (replay.worseCount) throw new Error('Candidate makes historical workflow outcomes worse');
	const flows = new Set<string>();
	let count = 0;
	for (const raw of input.samples) {
		const sample = raw as {
			passed?: boolean;
			candidateSha?: string;
			tests?: Array<{ name?: string; flowId?: string; executed?: boolean; status?: string }>;
		};
		if (
			!sample ||
			sample.passed !== true ||
			sample.candidateSha !== input.candidateSha ||
			!Array.isArray(sample.tests) ||
			!sample.tests.length
		)
			throw new Error('Real sample observations are missing or stale');
		const names = new Set<string>();
		for (const test of sample.tests) {
			if (
				!test?.name ||
				!test.flowId ||
				!input.candidate.flows[test.flowId] ||
				test.executed !== true ||
				test.status !== 'passed' ||
				names.has(`${test.flowId}:${test.name}`)
			)
				throw new Error('Invalid, failed or duplicate real sample observation');
			names.add(`${test.flowId}:${test.name}`);
			flows.add(test.flowId);
			count++;
		}
	}
	if (!count) throw new Error('Configuration validation requires real samples');
	const sharedChanged =
		contentDigest({
			config: input.original.config,
			prompts: input.original.prompts,
			skills: input.original.skills,
			schemas: input.original.schemas,
		}) !==
		contentDigest({
			config: input.candidate.config,
			prompts: input.candidate.prompts,
			skills: input.candidate.skills,
			schemas: input.candidate.schemas,
		});
	const changedFlows = Object.keys(input.candidate.flows).filter(
		(id) =>
			sharedChanged ||
			contentDigest(input.original.flows[id] ?? null) !== contentDigest(input.candidate.flows[id]),
	);
	for (const id of changedFlows)
		if (!flows.has(id)) throw new Error(`Real samples do not cover affected flow: ${id}`);
	const report = {
		projectId: input.candidate.projectId,
		candidateSha: input.candidateSha,
		contentHash: input.candidate.contentHash,
		replay,
		samples: { count, flows: [...flows].sort(), changedFlows },
		sampleHash: contentDigest(input.samples),
	};
	return { ...report, validationHash: contentDigest(report) };
}

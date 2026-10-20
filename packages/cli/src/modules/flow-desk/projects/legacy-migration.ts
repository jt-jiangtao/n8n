import { contentDigest } from './project-config';
export type LegacySource = { areaId: string; area: unknown; flows: Record<string, unknown> };
export function migrationCandidate(input: {
	projectId: string;
	source: LegacySource;
	files: Record<string, string>;
	mapping: Record<string, string>;
}) {
	if (
		!/^[a-z][a-z0-9-]{0,63}$/.test(input.projectId) ||
		!input.source.areaId ||
		!input.files['project.yaml']
	)
		throw new Error('Invalid project migration');
	for (const [file, content] of Object.entries(input.files)) {
		if (
			typeof content !== 'string' ||
			file.includes('\\') ||
			file.split('/').some((p) => !p || p === '.' || p === '..') ||
			!(file === 'project.yaml' || /^(flows|prompts|skills|schemas)\/.+/.test(file))
		)
			throw new Error('Migration file escapes project scope');
	}
	if (!Object.keys(input.mapping).length) throw new Error('Migration needs explicit flow mappings');
	const targets = new Set<string>();
	for (const [legacy, flow] of Object.entries(input.mapping)) {
		if (
			!Object.hasOwn(input.source.flows, legacy) ||
			!/^[a-z][a-z0-9-]{0,63}$/.test(flow) ||
			targets.has(flow)
		)
			throw new Error('Invalid or ambiguous migration mapping');
		targets.add(flow);
	}
	const value = {
		...structuredClone(input),
		sourceHash: contentDigest(input.source),
		status: 'candidate' as const,
	};
	return { ...value, contentHash: contentDigest(value) };
}
export function assertMigrationSource(candidate: { sourceHash: string }, source: LegacySource) {
	if (contentDigest(source) !== candidate.sourceHash)
		throw new Error('Legacy project configuration changed; regenerate migration candidate');
}

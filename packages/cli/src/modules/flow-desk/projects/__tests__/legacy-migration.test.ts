import { expect, it } from 'vitest';
import { migrationCandidate, assertMigrationSource } from '../legacy-migration';
it('retains exact legacy and project files in a reviewable candidate without overwriting either', () => {
	const source = {
		areaId: 'area',
		area: { repo: '/repo' },
		flows: { scan: { nodes: [{ id: 'custom', parameters: { instructions: 'my edit' } }] } },
	};
	const candidate = migrationCandidate({
		projectId: 'p',
		source,
		files: { 'project.yaml': 'original', 'prompts/custom.md': 'my prompt' },
		mapping: { scan: 'scan' },
	});
	expect(candidate.files['prompts/custom.md']).toBe('my prompt');
	expect(candidate.source).toEqual(source);
	expect(candidate.status).toBe('candidate');
	expect(() => assertMigrationSource(candidate, { ...source, area: { repo: '/changed' } })).toThrow(
		/changed/,
	);
});
it('rejects ambiguous or escaping migration mappings', () => {
	expect(() =>
		migrationCandidate({
			projectId: 'p',
			source: { areaId: 'a', area: {}, flows: { scan: {} } },
			files: { '../platform': 'x' },
			mapping: { scan: 'scan' },
		}),
	).toThrow();
	expect(() =>
		migrationCandidate({
			projectId: 'p',
			source: { areaId: 'a', area: {}, flows: { scan: {} } },
			files: { 'project.yaml': 'x' },
			mapping: { unknown: 'scan' },
		}),
	).toThrow();
});

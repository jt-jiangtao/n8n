import { expect, it } from 'vitest';
import { snapshotFromBundle } from '../config-bundle';
it.each([
	'../flow-desk.yaml',
	'/tmp/config',
	'prompts/../../other/file',
	'prompts\\escape',
	'credentials.json',
])('rejects an invalid bundled path %s before loading it', (file) => {
	expect(() =>
		snapshotFromBundle(
			{ projectId: 'p', candidateSha: 'a'.repeat(40), files: { [file]: 'x' } },
			{ projectId: 'p', candidateSha: 'a'.repeat(40), flowId: 'meta-retro' },
		),
	).toThrow(/path/);
});
it('rejects bundles from another candidate', () => {
	expect(() =>
		snapshotFromBundle(
			{ projectId: 'q', candidateSha: 'b'.repeat(40), files: {} },
			{ projectId: 'p', candidateSha: 'a'.repeat(40), flowId: 'meta-retro' },
		),
	).toThrow(/binding/);
});

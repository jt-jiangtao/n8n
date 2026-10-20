import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProjectSnapshot } from './project-config';

export function snapshotFromBundle(
	bundle: unknown,
	expected: { projectId: string; candidateSha: string; flowId: string },
) {
	const data = bundle as {
		projectId?: string;
		candidateSha?: string;
		files?: Record<string, string>;
	};
	if (
		!data ||
		data.projectId !== expected.projectId ||
		data.candidateSha !== expected.candidateSha ||
		!data.files ||
		typeof data.files !== 'object' ||
		Array.isArray(data.files)
	)
		throw new Error('Project configuration bundle binding changed');
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(expected.projectId)) throw new Error('Invalid project path');
	let size = 0;
	for (const [rel, content] of Object.entries(data.files)) {
		if (
			typeof content !== 'string' ||
			rel.includes('\\') ||
			rel.includes('\0') ||
			rel.split('/').some((part) => !part || part === '.' || part === '..') ||
			!(rel === 'project.yaml' || /^(flows|prompts|skills|schemas)\/.+/.test(rel))
		)
			throw new Error('Invalid project configuration path');
		size += Buffer.byteLength(content);
	}
	if (size > 4 * 1024 * 1024 || Object.keys(data.files).length > 2048)
		throw new Error('Project configuration bundle exceeds limits');
	const root = mkdtempSync(path.join(tmpdir(), 'flow-desk-config-verify-'));
	try {
		const base = path.join(root, 'projects', expected.projectId);
		for (const [rel, content] of Object.entries(data.files)) {
			const file = path.join(base, rel);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, content, { mode: 0o600 });
		}
		return loadProjectSnapshot({ root, projectId: expected.projectId, flowId: expected.flowId });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

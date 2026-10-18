/**
 * add-regression-proof 1.2 — M111, F30
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskRegressionProofService } from '../regression-proof/regression-proof.service';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../../../../',
);

describe('regression-proof module (M111, F30)', () => {
	const plane = {
		comment: vi.fn(async () => undefined),
	};
	const resume = { resume: vi.fn(async () => ({ ok: true })) };
	let svc: FlowDeskRegressionProofService;

	beforeEach(() => {
		vi.clearAllMocks();
		svc = new FlowDeskRegressionProofService(plane as never, resume as never);
	});

	it('M111: both results written; missing either → failure branch', async () => {
		const ok = await svc.applyResult({
			executionId: 'e1',
			nodeId: 'ci1',
			childIssueId: 'c1',
			before: { summary: 'before fail', ok: false },
			after: { summary: 'after pass', ok: true },
			proofOk: true,
		});
		expect(ok.branch).toBe('pass');
		expect(plane.comment).toHaveBeenCalledWith(
			'c1',
			expect.stringMatching(/before|after|证明/i),
		);

		const missing = await svc.applyResult({
			executionId: 'e1',
			nodeId: 'ci1',
			childIssueId: 'c1',
			before: { summary: 'before', ok: false },
			after: undefined,
			proofOk: false,
		});
		expect(missing.branch).toBe('failure');
	});

	it('F30: bug-standard targeted has proveRegression; bug-flaky does not', () => {
		const std = JSON.parse(
			readFileSync(path.join(repoRoot, 'flows/bug-standard.json'), 'utf8'),
		) as {
			nodes: Array<{ type: string; parameters?: Record<string, unknown> }>;
		};
		const flakyPath = path.join(repoRoot, 'flows/bug-flaky.json');
		expect(existsSync(flakyPath)).toBe(true);
		const flaky = JSON.parse(readFileSync(flakyPath, 'utf8')) as {
			nodes: Array<{ type: string; parameters?: Record<string, unknown> }>;
		};

		const stdCi = std.nodes.find(
			(n) => n.type === 'flowDeskCiStep' && n.parameters?.suite === 'targeted',
		);
		expect(stdCi?.parameters?.proveRegression).toBe(true);

		const flakyCi = flaky.nodes.filter((n) => n.type === 'flowDeskCiStep');
		expect(flakyCi.every((n) => n.parameters?.proveRegression !== true)).toBe(true);
	});
});

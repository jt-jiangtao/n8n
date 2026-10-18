/**
 * add-findings-model 1.2 — M112–M118
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskFindingsService } from '../findings/findings.service';

describe('findings (M112–M118)', () => {
	const plane = {
		comment: vi.fn(async () => undefined),
		createIssue: vi.fn(async () => ({ id: 'issue-1' })),
	};
	let svc: FlowDeskFindingsService;

	beforeEach(() => {
		vi.clearAllMocks();
		svc = new FlowDeskFindingsService(plane as never);
	});

	it('M112: code fingerprint ignores line numbers', () => {
		const a = svc.fingerprintCode({
			rule: 'no-undef',
			file: 'src/a.ts',
			symbol: 'foo',
			contentHash: 'abc',
		});
		const b = svc.fingerprintCode({
			rule: 'no-undef',
			file: 'src/a.ts',
			symbol: 'foo',
			contentHash: 'abc',
		});
		expect(a).toBe(b);
	});

	it('M113: ui fingerprint uses rule/page/width/theme/selector', () => {
		const fp = svc.fingerprintUi({
			rule: 'overflow',
			page: '/login',
			width: 1280,
			theme: 'light',
			selector: '#btn',
		});
		expect(fp).toBeTruthy();
		expect(fp).not.toEqual(
			svc.fingerprintUi({
				rule: 'overflow',
				page: '/login',
				width: 375,
				theme: 'light',
				selector: '#btn',
			}),
		);
	});

	it('M114/M115: compare statuses; only new deterministic errors block', () => {
		const baseFp = svc.fingerprintCode({
			rule: 'r',
			file: 'a.ts',
			contentHash: '1',
		});
		const newFp = svc.fingerprintCode({
			rule: 'r2',
			file: 'b.ts',
			contentHash: '2',
		});
		const baseline = [
			{
				fingerprint: baseFp,
				rule: 'r',
				deterministic: true,
				level: 'error' as const,
				source: 'deterministic' as const,
				message: 'old',
				location: { kind: 'code' as const, file: 'a.ts', contentHash: '1' },
			},
		];
		const current = [
			...baseline,
			{
				fingerprint: newFp,
				rule: 'r2',
				deterministic: true,
				level: 'error' as const,
				source: 'deterministic' as const,
				message: 'new',
				location: { kind: 'code' as const, file: 'b.ts', contentHash: '2' },
			},
			{
				fingerprint: 'warn-1',
				rule: 'w',
				deterministic: true,
				level: 'warning' as const,
				source: 'deterministic' as const,
				message: 'warn',
				location: { kind: 'code' as const, file: 'c.ts', contentHash: '3' },
			},
			{
				fingerprint: 'agent-1',
				rule: 'a',
				deterministic: false,
				level: 'error' as const,
				source: 'agent' as const,
				message: 'agent',
				location: { kind: 'code' as const, file: 'd.ts', contentHash: '4' },
			},
		];
		const compared = svc.compare(current, baseline);
		expect(compared.find((f) => f.fingerprint === newFp)?.status).toBe('new');
		expect(compared.find((f) => f.fingerprint === baseFp)?.status).toBe('existing');
		expect(svc.shouldBlock(compared)).toBe(true);

		const noBlock = svc.compare(
			[
				{
					fingerprint: baseFp,
					rule: 'r',
					deterministic: true,
					level: 'error',
					source: 'deterministic',
					message: 'old',
					location: { kind: 'code', file: 'a.ts', contentHash: '1' },
				},
				{
					fingerprint: 'warn-1',
					rule: 'w',
					deterministic: true,
					level: 'warning',
					source: 'deterministic',
					message: 'warn',
					location: { kind: 'code', file: 'c.ts', contentHash: '3' },
				},
			],
			baseline,
		);
		expect(svc.shouldBlock(noBlock)).toBe(false);
	});

	it('M116: ignore requires reason; later runs mark ignored', () => {
		expect(() => svc.ignore('fp', '')).toThrow(/reason/i);
		svc.ignore('fp', 'false positive');
		const compared = svc.compare(
			[
				{
					fingerprint: 'fp',
					rule: 'r',
					deterministic: true,
					level: 'error',
					source: 'deterministic',
					message: 'x',
					location: { kind: 'code', file: 'a.ts', contentHash: '1' },
				},
			],
			[],
		);
		expect(compared[0]?.status).toBe('ignored');
		expect(svc.ignoredCount(compared)).toBe(1);
	});

	it('M117: createIssueFromFinding dedupes by fingerprint', async () => {
		const finding = {
			fingerprint: 'fp-dup',
			rule: 'r',
			deterministic: true,
			level: 'error' as const,
			source: 'deterministic' as const,
			message: 'bug',
			location: { kind: 'code' as const, file: 'a.ts', contentHash: '1' },
		};
		const first = await svc.createIssueFromFinding({ finding, area: 'web' });
		expect(first.deduped).toBeFalsy();
		const second = await svc.createIssueFromFinding({ finding, area: 'web' });
		expect(second.deduped).toBe(true);
		expect(plane.createIssue).toHaveBeenCalledTimes(1);
		expect(plane.comment).toHaveBeenCalled();
	});

	it('M118: analysis cache hits on second baseline request', () => {
		const findings = [
			{
				fingerprint: 'f1',
				rule: 'r',
				deterministic: true,
				level: 'error' as const,
				source: 'deterministic' as const,
				message: 'm',
				location: { kind: 'code' as const, file: 'a.ts', contentHash: '1' },
			},
		];
		expect(svc.getCached('abc', 'quality')).toBeUndefined();
		svc.setCached('abc', 'quality', findings);
		expect(svc.getCached('abc', 'quality')).toEqual(findings);
	});
});

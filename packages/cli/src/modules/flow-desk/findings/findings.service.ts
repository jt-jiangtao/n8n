import { createHash } from 'node:crypto';

import { Service } from '@n8n/di';

export type FindingLocation =
	| {
			kind: 'code';
			file: string;
			symbol?: string;
			contentHash: string;
			line?: number;
	  }
	| {
			kind: 'ui';
			page: string;
			width: number;
			theme: string;
			selector: string;
	  };

export type Finding = {
	fingerprint: string;
	rule: string;
	deterministic: boolean;
	level: 'error' | 'warning' | 'info';
	source: 'deterministic' | 'agent';
	message: string;
	location: FindingLocation;
	status?: 'new' | 'existing' | 'fixed' | 'ignored';
};

@Service()
export class FlowDeskFindingsService {
	private ignores = new Map<string, string>();
	private openIssues = new Map<string, string>();
	private analysisCache = new Map<string, Finding[]>();

	constructor(
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
			createIssue?: (body: Record<string, unknown>) => Promise<{ id: string }>;
		},
	) {}

	fingerprintCode(input: {
		rule: string;
		file: string;
		symbol?: string;
		contentHash: string;
	}): string {
		return hashParts(['code', input.rule, input.file, input.symbol ?? '', input.contentHash]);
	}

	fingerprintUi(input: {
		rule: string;
		page: string;
		width: number;
		theme: string;
		selector: string;
	}): string {
		return hashParts([
			'ui',
			input.rule,
			input.page,
			String(input.width),
			input.theme,
			input.selector,
		]);
	}

	compare(current: Finding[], baseline: Finding[]): Finding[] {
		const baseMap = new Map(baseline.map((f) => [f.fingerprint, f]));
		const curMap = new Map(current.map((f) => [f.fingerprint, f]));
		const out: Finding[] = [];

		for (const f of current) {
			if (this.ignores.has(f.fingerprint)) {
				out.push({ ...f, status: 'ignored' });
				continue;
			}
			out.push({
				...f,
				status: baseMap.has(f.fingerprint) ? 'existing' : 'new',
			});
		}
		for (const f of baseline) {
			if (!curMap.has(f.fingerprint) && !this.ignores.has(f.fingerprint)) {
				out.push({ ...f, status: 'fixed' });
			}
		}
		return out;
	}

	shouldBlock(findings: Finding[]): boolean {
		return findings.some(
			(f) =>
				f.status === 'new' &&
				f.deterministic &&
				f.level === 'error' &&
				f.source === 'deterministic',
		);
	}

	ignore(fingerprint: string, reason: string) {
		if (!reason.trim()) {
			const err = new Error('ignore requires reason') as Error & { code: string };
			err.code = 'IGNORE_REASON_REQUIRED';
			throw err;
		}
		this.ignores.set(fingerprint, reason.trim());
	}

	ignoredCount(findings: Finding[]): number {
		return findings.filter((f) => f.status === 'ignored' || this.ignores.has(f.fingerprint))
			.length;
	}

	async createIssueFromFinding(input: {
		finding: Finding;
		area: string;
	}): Promise<{ ok: true; id: string; deduped?: boolean }> {
		const existing = this.openIssues.get(input.finding.fingerprint);
		if (existing) {
			await this.plane.comment(existing, `发现复现: ${input.finding.message}`);
			return { ok: true, id: existing, deduped: true };
		}
		if (!this.plane.createIssue) {
			throw new Error('createIssue unavailable');
		}
		const created = await this.plane.createIssue({
			title: input.finding.message.slice(0, 120),
			labels: ['source:finding', `area:${input.area}`, `fp:${input.finding.fingerprint}`],
		});
		this.openIssues.set(input.finding.fingerprint, created.id);
		return { ok: true, id: created.id };
	}

	cacheKey(sha: string, kind: string) {
		return `${sha}:${kind}`;
	}

	getCached(sha: string, kind: string): Finding[] | undefined {
		return this.analysisCache.get(this.cacheKey(sha, kind));
	}

	setCached(sha: string, kind: string, findings: Finding[]) {
		this.analysisCache.set(this.cacheKey(sha, kind), findings);
	}
}

function hashParts(parts: string[]): string {
	return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

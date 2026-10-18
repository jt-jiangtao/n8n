import { createHash } from 'node:crypto';

import { Service } from '@n8n/di';

@Service()
export class FlowDeskAcceptanceService {
	private frozen = new Map<string, string>();

	constructor(
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
		},
	) {}

	freeze(executionId: string, acceptance: string) {
		this.frozen.set(executionId, hashAcceptance(acceptance));
	}

	async checkResult(input: {
		executionId: string;
		childIssueId: string;
		acceptance: string;
	}): Promise<{ ok: boolean }> {
		const expected = this.frozen.get(input.executionId);
		if (!expected) return { ok: true };
		const actual = hashAcceptance(input.acceptance);
		if (actual === expected) return { ok: true };
		await this.plane.comment(
			input.childIssueId,
			`验收标准与冻结版本不一致\n冻结哈希: ${expected}\n结果哈希: ${actual}`,
		);
		return { ok: false };
	}
}

function hashAcceptance(text: string): string {
	return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

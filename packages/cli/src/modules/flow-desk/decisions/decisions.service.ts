import { Service } from '@n8n/di';

import type { FlowDeskConfigService } from '../config/config.service';

type DecisionInput = {
	executionId: string;
	nodeId: string;
	decision: string;
	reason?: string;
	text?: string;
	actor: string;
	source: 'panel' | 'comment' | 'state';
	childIssueId: string;
	assigneeRole: string;
	area: string;
	attempt: number;
};

@Service()
export class FlowDeskDecisionsService {
	private waiting = new Map<string, boolean>();
	private options = new Map<string, string[]>();
	private requiresText = new Map<string, boolean>();
	private seen = new Set<string>();

	constructor(
		private readonly resume: {
			resume: (input: {
				executionId: string;
				nodeId: string;
				branch: string;
				data?: Record<string, unknown>;
				attempt: number;
			}) => Promise<{ ok: boolean }>;
		},
		private readonly plane: {
			comment: (issueId: string, body: string) => Promise<unknown>;
			updateIssueState: (issueId: string, state: string) => Promise<unknown>;
		},
		private readonly config: FlowDeskConfigService,
	) {}

	key(executionId: string, nodeId: string) {
		return `${executionId}:${nodeId}`;
	}

	setWaiting(executionId: string, nodeId: string, value: boolean) {
		this.waiting.set(this.key(executionId, nodeId), value);
	}

	setOptions(executionId: string, nodeId: string, opts: string[]) {
		this.options.set(this.key(executionId, nodeId), opts);
	}

	setRequiresText(executionId: string, nodeId: string, required: boolean) {
		this.requiresText.set(this.key(executionId, nodeId), required);
	}

	async submit(input: DecisionInput): Promise<{ ok: boolean }> {
		const k = this.key(input.executionId, input.nodeId);

		const opts = this.options.get(k);
		if (opts && !opts.includes(input.decision) && !['approve', 'reject'].includes(input.decision)) {
			const err = new Error('unknown option') as Error & { httpCode: number };
			err.httpCode = 400;
			throw err;
		}

		if (this.waiting.has(k) && this.waiting.get(k) === false) {
			return { ok: false };
		}
		// Default to waiting=true for skeleton tests that don't set it.
		if (!this.waiting.has(k)) this.waiting.set(k, true);

		if (input.actor === 'agent-bot' || input.actor === 'flow-desk') {
			await this.plane.comment(input.childIssueId, 'Agent 与系统用户不能确认');
			return { ok: false };
		}

		const allowed = this.config.resolveRole(input.assigneeRole, input.area);
		if (!allowed.includes(input.actor)) {
			await this.plane.comment(input.childIssueId, '无权限');
			return { ok: false };
		}

		if (input.decision === 'reject' && !input.reason) {
			await this.plane.comment(input.childIssueId, '退回必须补充原因');
			return { ok: false };
		}

		if (this.requiresText.get(k) && !input.text?.trim()) {
			await this.plane.comment(input.childIssueId, '必须填写文字回答');
			return { ok: false };
		}

		const dedupe = `${k}:${input.decision}:${input.attempt}`;
		if (this.seen.has(dedupe)) return { ok: true };
		this.seen.add(dedupe);

		const branch =
			input.decision === 'approve' ? 'approve' : input.decision === 'reject' ? 'reject' : input.decision;

		if (input.text?.trim()) {
			await this.plane.comment(input.childIssueId, `回答: ${input.text.trim()}`);
		}

		await this.resume.resume({
			executionId: input.executionId,
			nodeId: input.nodeId,
			branch,
			data: { reason: input.reason, text: input.text, decidedBy: input.actor },
			attempt: input.attempt,
		});
		this.waiting.set(k, false);
		if (branch === 'approve') {
			await this.plane.updateIssueState(input.childIssueId, '完成');
		}
		return { ok: true };
	}

	async fromComment(input: Omit<DecisionInput, 'decision' | 'source'> & { body: string }) {
		const decision = input.body.trim().startsWith('/approve') ? 'approve' : 'reject';
		return this.submit({ ...input, decision, source: 'comment' });
	}

	async fromStateChange(input: Omit<DecisionInput, 'decision' | 'source'> & { newState: string }) {
		if (input.newState !== '完成') return { ok: false };
		return this.submit({ ...input, decision: 'approve', source: 'state' });
	}

	async onWaitCeiling(input: { childIssueId: string; executionId: string; nodeId: string }) {
		await this.plane.comment(input.childIssueId, '等待已达上限，仍可继续确认');
	}

	async reopenAfterReject(input: { childIssueId: string; reason: string; previousAttempt: number }) {
		await this.plane.comment(input.childIssueId, `退回原因: ${input.reason}`);
		return { attempt: input.previousAttempt + 1 };
	}

	async assignRole(input: { childIssueId: string; assigneeRole: string; area: string }) {
		const people = this.config.resolveRole(input.assigneeRole, input.area);
		if (people.length === 0) {
			await this.plane.comment(input.childIssueId, '配置缺失：角色解析不到任何人');
			await this.plane.updateIssueState(input.childIssueId, '失败');
			return { ok: false };
		}
		return { ok: true, assignees: people };
	}
}

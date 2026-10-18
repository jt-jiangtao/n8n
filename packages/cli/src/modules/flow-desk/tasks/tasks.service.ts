import { Service } from '@n8n/di';

import type { FlowDeskConfigService } from '../config/config.service';
import type { FlowDeskGuardsService, RunnerClient, PlaneClient } from '../guards/guards.service';
import type { FlowDeskSecretsService } from '../secrets/secrets.service';

export type ResumeClient = {
	resume: (input: {
		executionId: string;
		nodeId: string;
		branch: string;
		data?: unknown;
		attempt?: number;
	}) => Promise<{ ok: boolean }>;
};

export type DispatchInput = {
	taskId: string;
	workItem: string;
	step: string;
	attempt: number;
	repo: string;
	area: string;
	baseRef: string;
	instructions: string;
	acceptance: string;
	flowRunId: string;
	requiredFields: string[];
};

type AgentResult = {
	workItem: string;
	step: string;
	attempt: number;
	summary: string;
	changes: { files: string[]; branch?: string; pr?: string };
	verification: { howToCheck: string; tests: string[] };
	regression: { suite: string };
	risks: string[];
	needsFromHuman: string;
	reasoning?: string;
	status?: string;
	sandboxed?: boolean;
	adapter?: string;
};

const REASONING_LIMIT = 2000;
const PROGRESS_WINDOW_MS = 5000;

type TasksDeps = {
	config?: FlowDeskConfigService;
	runner?: RunnerClient;
	plane?: PlaneClient & {
		createPage?: (input: { title: string; body: string; issueId: string }) => Promise<{
			id: string;
			url: string;
		}>;
	};
	resume?: ResumeClient;
	guards?: FlowDeskGuardsService;
	secrets?: FlowDeskSecretsService;
};

@Service()
export class FlowDeskTasksService {
	private runnerUrl = process.env.FLOW_DESK_RUNNER_URL ?? 'http://host.docker.internal:39201';
	private runnerToken = process.env.FLOW_DESK_RUNNER_TOKEN ?? '';
	private readonly seenResults = new Set<string>();
	private readonly progressBuckets = new Map<
		string,
		{ lastAt: number; text: string; flushed: boolean }
	>();
	private readonly config?: FlowDeskConfigService;
	private readonly runner?: RunnerClient;
	private readonly plane?: TasksDeps['plane'];
	private readonly resume?: ResumeClient;
	private readonly guards?: FlowDeskGuardsService;
	private readonly secrets?: FlowDeskSecretsService;

	/** Zero-arg for n8n DI; tests pass deps positionally or as a bag. */
	constructor(
		configOrBag?: FlowDeskConfigService | TasksDeps,
		runner?: RunnerClient,
		plane?: TasksDeps['plane'],
		resume?: ResumeClient,
		guards?: FlowDeskGuardsService,
		secrets?: FlowDeskSecretsService,
	) {
		if (configOrBag && typeof configOrBag === 'object' && 'config' in (configOrBag as object)) {
			const bag = configOrBag as TasksDeps;
			this.config = bag.config;
			this.runner = bag.runner;
			this.plane = bag.plane;
			this.resume = bag.resume;
			this.guards = bag.guards;
			this.secrets = bag.secrets;
		} else {
			this.config = configOrBag as FlowDeskConfigService | undefined;
			this.runner = runner;
			this.plane = plane;
			this.resume = resume;
			this.guards = guards;
			this.secrets = secrets;
		}
	}

	setRunner(url: string, token: string) {
		this.runnerUrl = url;
		this.runnerToken = token;
	}

	/** Skeleton-compatible dispatch used by controller. */
	async dispatch(input: DispatchInput): Promise<void> {
		await this.dispatchAgent({
			...input,
			rejectReasons: [],
		});
	}

	async dispatchAgent(input: {
		taskId: string;
		workItem: string;
		step: string;
		attempt: number;
		area: string;
		flowRunId: string;
		instructions: string;
		acceptance: string;
		requiredFields: string[];
		rejectReasons: string[];
		nodeAdapter?: string;
		childIssueId?: string;
		maxRetries?: number;
		repo?: string;
		baseRef?: string;
	}): Promise<{ dispatched: boolean }> {
		if (this.config?.getKillSwitch()) {
			if (input.childIssueId && this.plane) {
				await this.plane.comment(input.childIssueId, '总开关已打开，未派发 Agent 任务');
			}
			return { dispatched: false };
		}

		const area = this.config?.getArea(input.area);
		const adapter = this.guards
			? this.guards.selectAdapter({
					nodeAdapter: input.nodeAdapter,
					areaAdapter: area?.agent.adapter,
				})
			: (input.nodeAdapter ?? area?.agent.adapter ?? 'fake');

		const token = this.secrets ? await this.secrets.readRunnerToken() : this.runnerToken;
		const payload = {
			taskId: input.taskId,
			kind: 'agent' as const,
			adapter,
			workItem: input.workItem,
			step: input.step,
			attempt: input.attempt,
			repo: input.repo ?? area?.repo ?? '',
			area: input.area,
			baseRef: input.baseRef ?? area?.baseRef ?? 'main',
			instructions: input.instructions,
			acceptance: input.acceptance,
			flowRunId: input.flowRunId,
			requiredFields: input.requiredFields,
			context: { previousResults: [], rejectReasons: input.rejectReasons },
			limits: { timeoutSeconds: 600 },
			token,
		};

		await this.dispatchWithRetry(payload, input.maxRetries ?? 3);
		return { dispatched: true };
	}

	async dispatchCi(input: {
		taskId: string;
		workItem: string;
		step: string;
		attempt: number;
		area: string;
		flowRunId: string;
		suite: string;
		maxRetries?: number;
	}): Promise<{ dispatched: boolean }> {
		if (this.config?.getKillSwitch()) {
			return { dispatched: false };
		}
		const area = this.config?.getArea(input.area);
		const command = area?.suites?.[input.suite] ?? 'true';
		const token = this.secrets ? await this.secrets.readRunnerToken() : this.runnerToken;
		await this.dispatchWithRetry(
			{
				taskId: input.taskId,
				kind: 'ci',
				workItem: input.workItem,
				step: input.step,
				attempt: input.attempt,
				repo: area?.repo ?? '',
				area: input.area,
				baseRef: area?.baseRef ?? 'main',
				command,
				flowRunId: input.flowRunId,
				token,
			},
			input.maxRetries ?? 3,
		);
		return { dispatched: true };
	}

	private async dispatchWithRetry(payload: Record<string, unknown>, maxRetries: number) {
		let lastError: unknown;
		for (let i = 0; i < maxRetries; i++) {
			try {
				if (this.runner) {
					const result = (await this.runner.dispatch(payload)) as {
						ok?: boolean;
						status?: number;
					};
					if (result && result.ok === false && result.status === 401) {
						const err = new Error('unauthorized') as Error & { status: number };
						err.status = 401;
						throw err;
					}
					return;
				}
				const res = await fetch(`${this.runnerUrl}/tasks`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${String(payload.token ?? this.runnerToken)}`,
					},
					body: JSON.stringify(payload),
				});
				if (res.status === 401) {
					const err = new Error('unauthorized') as Error & { status: number };
					err.status = 401;
					throw err;
				}
				if (!res.ok) throw new Error(`agent-runner dispatch failed: ${res.status}`);
				return;
			} catch (error) {
				lastError = error;
				if ((error as { status?: number }).status === 401) throw error;
				await new Promise((r) => setTimeout(r, 10 * (i + 1)));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	async handleAgentResult(input: {
		taskId: string;
		executionId: string;
		nodeId: string;
		childIssueId: string;
		attempt: number;
		result: AgentResult;
		requiredFields: string[];
	}): Promise<{
		accepted: boolean;
		branch?: string;
		missing?: string[];
		reason?: string;
		result?: AgentResult;
	}> {
		if (this.seenResults.has(input.taskId)) {
			return { accepted: false, reason: 'duplicate result（重复）' };
		}

		if (input.result.attempt !== input.attempt) {
			return { accepted: false, reason: 'attempt mismatch' };
		}

		const missing: string[] = [];
		if (!input.result.summary?.trim()) missing.push('summary');
		for (const field of input.requiredFields) {
			const value = (input.result as Record<string, unknown>)[field];
			if (value === undefined || value === null || value === '') missing.push(field);
		}
		if (missing.length) {
			this.seenResults.add(input.taskId);
			await this.plane?.comment(
				input.childIssueId,
				`结果缺少必填项: ${missing.join(', ')}`,
			);
			await this.resume?.resume({
				executionId: input.executionId,
				nodeId: input.nodeId,
				branch: 'failure',
				data: { missing },
				attempt: input.attempt,
			});
			return { accepted: true, branch: 'failure', missing, result: input.result };
		}

		const files = input.result.changes?.files ?? [];
		const pathCheck = this.guards?.checkPaths(files);
		if (pathCheck && !pathCheck.allowed) {
			this.seenResults.add(input.taskId);
			await this.plane?.comment(
				input.childIssueId,
				`Agent 不能修改底线代码: ${pathCheck.baseline.join(', ')}`,
			);
			await this.resume?.resume({
				executionId: input.executionId,
				nodeId: input.nodeId,
				branch: 'failure',
				attempt: input.attempt,
			});
			return { accepted: true, branch: 'failure', result: input.result };
		}

		let comment = this.renderAgentComment(input.result);
		const annotation = this.guards?.annotateResult({
			adapter: input.result.adapter ?? 'fake',
			sandboxed: input.result.sandboxed,
			files,
		});
		if (annotation) comment = `${comment}\n\n${annotation}`;

		if (input.result.reasoning && input.result.reasoning.length > REASONING_LIMIT) {
			const page = await this.plane?.createPage?.({
				title: `reasoning ${input.taskId}`,
				body: input.result.reasoning,
				issueId: input.childIssueId,
			});
			comment = `${input.result.summary}\n\n完整推理见: ${page?.url ?? 'page'}`;
		}

		await this.plane?.comment(input.childIssueId, comment);
		this.seenResults.add(input.taskId);
		await this.resume?.resume({
			executionId: input.executionId,
			nodeId: input.nodeId,
			branch: 'success',
			data: input.result,
			attempt: input.attempt,
		});
		return { accepted: true, branch: 'success', result: input.result };
	}

	async handleCiResult(input: {
		taskId: string;
		executionId: string;
		nodeId: string;
		childIssueId: string;
		attempt: number;
		result: { exitCode: number; summary: string; cases: Array<{ name: string; ok: boolean }> };
	}) {
		const branch = input.result.exitCode === 0 ? 'pass' : 'failure';
		await this.plane?.comment(
			input.childIssueId,
			`CI exit=${input.result.exitCode}\n${input.result.summary}`,
		);
		await this.resume?.resume({
			executionId: input.executionId,
			nodeId: input.nodeId,
			branch,
			data: input.result,
			attempt: input.attempt,
		});
		return { branch };
	}

	async reportProgress(input: { childIssueId: string; text: string; at: number }) {
		const bucket = this.progressBuckets.get(input.childIssueId);
		if (!bucket || input.at - bucket.lastAt > PROGRESS_WINDOW_MS) {
			this.progressBuckets.set(input.childIssueId, {
				lastAt: input.at,
				text: input.text,
				flushed: true,
			});
			await this.plane?.comment(input.childIssueId, `进度: ${input.text}`);
			return;
		}
		bucket.text = input.text;
		bucket.lastAt = input.at;
		// coalesce into the existing comment window — no extra comment
	}

	private renderAgentComment(result: AgentResult): string {
		const pr = result.changes.pr ? `[PR](${result.changes.pr})` : '';
		return [`Agent: ${result.summary}`, pr, `files: ${result.changes.files.join(', ')}`]
			.filter(Boolean)
			.join('\n');
	}
}

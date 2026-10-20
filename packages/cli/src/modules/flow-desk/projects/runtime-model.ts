import type { ProjectSnapshot } from './project-config';
export type NodeResult = {
	status: string;
	result: Record<string, unknown>;
	error?: string;
	context?: Record<string, unknown>;
	outputIndex?: number;
};
export type ParentRun = { executionId: string; nodeId: string; childId: string };
export type Child = {
	childId: string;
	executionId?: string;
	status: string;
	params: Record<string, unknown>;
	context?: Record<string, unknown>;
	error?: string;
};
export type Run = {
	executionId: string;
	projectId: string;
	flowId: string;
	runId: string;
	rootRunId: string;
	configHash: string;
	snapshot: ProjectSnapshot;
	context: Record<string, unknown>;
	steps: number;
	appliedTasks: string[];
	startedAt: number;
	status: string;
	parent?: ParentRun;
	depth: number;
	tokens: Array<{ id: string; to: string; consumed?: string }>;
	failures: Record<string, string>;
	cleanup?: { status: string; error?: string };
};
export type NodeRecord = {
	taskId: string;
	executionId: string;
	nodeId: string;
	projectId: string;
	runId: string;
	configHash: string;
	attempt: number;
	instanceId: string;
	type: string;
	status: string;
	result: Record<string, unknown>;
	invocationId: string;
	error?: string;
	woken?: boolean;
	callbackDigest?: string;
	replayContext?: Record<string, unknown>;
	outputIndex?: number;
	dispatch?: Record<string, unknown>;
	children?: Child[];
};
export type RuntimePorts = {
	approvalActors?: (run: Run, role: string) => Promise<string[]>;
	configurationCandidate?: (
		run: Run,
		result: Record<string, unknown>,
	) => Promise<{ contentHash: string; validationHash: string; report: unknown }>;
	activateConfiguration?: (run: Run, hash: string, actor: string) => Promise<void>;
	launch?: (input: {
		childId: string;
		parent: ParentRun;
		rootRunId: string;
		snapshot: ProjectSnapshot;
		context: Record<string, unknown>;
		depth: number;
	}) => Promise<{ executionId: string }>;
	cancel?: (executionId: string) => Promise<void>;
	completed?: (
		parent: ParentRun,
		outcome: { status: string; context: Record<string, unknown>; error?: string },
	) => Promise<void>;
	finalize?: (run: Run) => Promise<void>;
	workItem?: (
		run: Run,
		node: NodeRecord,
		params: Record<string, unknown>,
		items: unknown,
	) => Promise<Record<string, unknown>>;
	notify?: (
		run: Run,
		node: NodeRecord,
		params: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
	integration?: (
		subject: Record<string, unknown>,
		verification: unknown,
	) => Promise<Record<string, unknown>>;
};
export function readRef(context: Record<string, unknown>, ref: string): unknown {
	const parts = ref.split('.');
	if (parts.some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part)))
		throw new Error('Invalid typed result reference');
	let value: unknown = Object.hasOwn(context, parts[0]) ? context : (context.results ?? {});
	for (const part of parts) {
		if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

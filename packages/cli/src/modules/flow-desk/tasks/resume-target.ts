export type TaskBinding = {
	executionId: string;
	nodeId: string;
	attempt: number;
};

export function resumeTarget(
	binding: TaskBinding | undefined,
	body: Record<string, unknown>,
): { executionId: string; nodeId: string; branch: 'success' | 'failure'; attempt: number } | null {
	if (binding && ((text(body.executionId) && body.executionId !== binding.executionId) ||
		(text(body.nodeId) && body.nodeId !== binding.nodeId) ||
		(body.attempt !== undefined && Number(body.attempt) !== binding.attempt))) return null;
	const executionId = text(body.executionId) || binding?.executionId || '';
	const nodeId = text(body.nodeId) || binding?.nodeId || '';
	if (!executionId || !nodeId) return null;
	const attempt = Number(body.attempt ?? binding?.attempt ?? 1);
	return {
		executionId,
		nodeId,
		branch: body.status === 'ok' ? 'success' : 'failure',
		attempt: Number.isFinite(attempt) ? attempt : 1,
	};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

export function markForRerun(data: { waitReason?: 'suspended' }) {
	data.waitReason = 'suspended';
}

export async function claimWaitingExecution(
	waits: {
		stopExecution: (executionId: string) => void;
		startExecution: (executionId: string) => Promise<void>;
	},
	executionId: string,
) {
	waits.stopExecution(executionId);
	await waits.startExecution(executionId);
}

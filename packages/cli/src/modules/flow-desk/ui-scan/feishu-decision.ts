export type FeishuButton = {
	workItemId: string;
	button: string;
	executionId?: string;
	nodeId?: string;
	area?: string;
	attempt?: number;
};

export async function writeThroughDecisions(
	decisions: { submit: (input: Record<string, unknown>) => Promise<{ ok: boolean }> },
	item: FeishuButton,
	actor: string,
) {
	return decisions.submit({
		executionId: item.executionId ?? '',
		nodeId: item.nodeId ?? '',
		decision: item.button,
		actor,
		source: 'feishu',
		childIssueId: item.workItemId,
		assigneeRole: 'area.owner',
		area: item.area ?? '',
		attempt: item.attempt ?? 1,
	});
}

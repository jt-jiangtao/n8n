export function workItemDeepLink(identifier: string): string {
	return `flowdesk://work-item/${identifier}`;
}

export function executionDeepLink(executionId: string): string {
	return `flowdesk://execution/${executionId}`;
}

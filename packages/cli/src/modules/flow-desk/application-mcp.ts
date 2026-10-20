export async function requireApplicationMcp(
	base: string,
	token: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`${base}/health`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error('RUNNER_MCP_UNAVAILABLE');
	const value = (await response.json()) as { ok?: boolean; capabilities?: string[] };
	if (!value.ok || !value.capabilities?.includes('action-driver-mcp'))
		throw new Error('RUNNER_MCP_UNAVAILABLE: update the runner before scanning the application');
}

export async function diagnosticComment(
	run: { projectId: string; runId: string; rootRunId: string; context: Record<string, unknown> },
	runner: (url: string) => Promise<Response>,
): Promise<string | undefined> {
	const report = (run.context.diagnostics as { artifact?: { id?: string } } | undefined)?.artifact;
	if (!report) return undefined;
	if (!report.id || !/^[a-f0-9-]{36}$/.test(report.id))
		throw new Error('Invalid diagnostic report reference');
	const response = await runner(
		`/project-artifacts/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.rootRunId)}/${report.id}`,
	);
	await response.body?.cancel();
	if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json'))
		throw new Error('Diagnostic report is unavailable');
	return `<a href="/api/flow-desk/desktop/project-artifacts/${encodeURIComponent(run.runId)}/${report.id}/">Application logs, operations and instance information</a>`;
}

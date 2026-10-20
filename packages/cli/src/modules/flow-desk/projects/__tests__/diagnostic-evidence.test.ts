import { expect, it, vi } from 'vitest';
import { diagnosticComment } from '../diagnostic-evidence';
it('publishes only an existing JSON report through the Plane artifact proxy', async () => {
	const id = '12345678-1234-1234-1234-123456789abc';
	const runner = vi.fn(
		async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
	);
	const html = await diagnosticComment(
		{
			projectId: 'p',
			runId: 'r',
			rootRunId: 'root',
			context: { diagnostics: { artifact: { id } } },
		},
		runner,
	);
	expect(runner).toHaveBeenCalledWith(`/project-artifacts/p/root/${id}`);
	expect(html).toContain(`/api/flow-desk/desktop/project-artifacts/r/${id}/`);
	await expect(
		diagnosticComment(
			{
				projectId: 'p',
				runId: 'r',
				rootRunId: 'root',
				context: { diagnostics: { artifact: { id: 'file:///fake' } } },
			},
			runner,
		),
	).rejects.toThrow();
	await expect(
		diagnosticComment(
			{
				projectId: 'p',
				runId: 'r',
				rootRunId: 'root',
				context: { diagnostics: { artifact: { id } } },
			},
			async () => new Response('missing', { status: 404 }),
		),
	).rejects.toThrow();
});

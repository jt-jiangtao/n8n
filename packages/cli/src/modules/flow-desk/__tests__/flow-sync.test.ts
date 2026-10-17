/** 1.4 flow sync & whitelist: M77–M86, M98, M103, N1, N12–N14 */
import { describe, expect, it, vi } from 'vitest';

import { FlowDeskFlowsSyncService } from '../flows-sync/flows-sync.service';
import { FlowDeskFlowRegistry } from '../flow-registry/flow-registry.service';

describe('flow-sync (M77–M86, M98, M103, N1, N12–N14)', () => {
	it('N1: activating duplicate flowType is rejected', async () => {
		const registry = new FlowDeskFlowRegistry();
		await registry.activate({ id: 'wf-1', flowType: 'bug-standard', nodes: [{ type: 'flowDeskTrigger' }] });
		await expect(
			registry.activate({ id: 'wf-2', flowType: 'bug-standard', nodes: [{ type: 'flowDeskTrigger' }] }),
		).rejects.toMatchObject({ code: 'DUPLICATE_FLOW_TYPE' });
	});

	it('M77–M80: whitelist rejects unknown node types on activate/import', async () => {
		const registry = new FlowDeskFlowRegistry();
		await expect(
			registry.activate({
				id: 'wf-1',
				flowType: 'x',
				nodes: [{ type: 'n8n-nodes-base.executeCommand' }],
			}),
		).rejects.toMatchObject({ code: 'NODE_NOT_ALLOWED' });
	});

	it('M81–M86 / M103: normalized hash ignores versionId/updatedAt/key order', () => {
		const sync = new FlowDeskFlowsSyncService({} as never);
		const a = sync.normalizedHash({
			name: 'x',
			versionId: '1',
			updatedAt: 't1',
			nodes: [{ id: 'a', name: 'A' }],
		});
		const b = sync.normalizedHash({
			updatedAt: 't2',
			versionId: '2',
			name: 'x',
			nodes: [{ name: 'A', id: 'a' }],
		});
		expect(a).toBe(b);
	});

	it('N12–N14: save exports to config repo and asks runner to commit; failures are non-fatal', async () => {
		const runner = { commitConfig: vi.fn(async () => undefined) };
		const sync = new FlowDeskFlowsSyncService(runner as never);
		await sync.onWorkflowSaved({
			id: 'wf-1',
			flowType: 'bug-standard',
			name: 'Bug',
			nodes: [],
			connections: {},
		});
		expect(runner.commitConfig).toHaveBeenCalled();
		runner.commitConfig.mockRejectedValueOnce(new Error('down'));
		await expect(
			sync.onWorkflowSaved({
				id: 'wf-1',
				flowType: 'bug-standard',
				name: 'Bug',
				nodes: [],
				connections: {},
			}),
		).resolves.toMatchObject({ saved: true, exported: false });
	});

	it('M98: conflict creates system issue and pauses sync for that flow', async () => {
		const plane = { createIssue: vi.fn(async () => ({ id: 'sys-1' })) };
		const sync = new FlowDeskFlowsSyncService({} as never, plane as never);
		const result = await sync.handleConflict({ flowType: 'bug-standard' });
		expect(result.paused).toBe(true);
		expect(plane.createIssue).toHaveBeenCalled();
	});
});

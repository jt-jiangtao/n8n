import { it, expect, vi } from 'vitest';
vi.mock('@/workflows/workflow-creation.service', () => ({ WorkflowCreationService: class {} }));
vi.mock('@/workflow-runner', () => ({ WorkflowRunner: class {} }));
vi.mock('@/executions/execution-persistence', () => ({ ExecutionPersistence: class {} }));
vi.mock('@/wait-tracker', () => ({ WaitTracker: class {} }));
vi.mock('../../database/project-record.repository', () => ({ ProjectRecordRepository: class {} }));
import { ProjectRuntimeService } from '../project-runtime.service';
const id = '11111111-1111-4111-8111-111111111111',
	targetId = '22222222-2222-4222-8222-222222222222';
function fixture() {
	const service = new ProjectRuntimeService({} as never);
	const adapter = service as unknown as {
		plane: (route: string, body: unknown) => Promise<Record<string, unknown>>;
		workItems: (
			run: unknown,
			node: unknown,
			p: unknown,
			items: unknown,
		) => Promise<Record<string, unknown>>;
	};
	const plane = vi.spyOn(adapter, 'plane').mockResolvedValue({ id, updated: true });
	const run = {
		projectId: 'p',
		runId: 'r',
		snapshot: { config: { defaults: { planeProject: 'P' } } },
		context: { parentIssueId: id, candidateSha: 'sha' },
	};
	return { adapter, plane, run, node: { nodeId: 'items', taskId: 'task' } };
}
it('updates the referenced work item rather than creating a finding', async () => {
	const s = fixture();
	await s.adapter.workItems(s.run, s.node, { operation: 'update' }, [
		{ id, stateGroup: 'completed' },
	]);
	expect(s.plane).toHaveBeenCalledWith(
		'/issues/' + id + '/',
		expect.objectContaining({
			operation: 'update',
			project: 'P',
			stateGroup: 'completed',
			sourceKey: expect.any(String),
		}),
	);
});
it('links existing work items with an explicit relation', async () => {
	const s = fixture();
	await s.adapter.workItems(s.run, s.node, { operation: 'link', relation: 'follow-up' }, [
		{ id, targetId },
	]);
	expect(s.plane).toHaveBeenCalledWith(
		'/issues/' + id + '/',
		expect.objectContaining({ operation: 'link', targetId, relation: 'follow_up', project: 'P' }),
	);
});
it('validates the entire operation batch before any remote effect', async () => {
	const s = fixture();
	await expect(
		s.adapter.workItems(s.run, s.node, { operation: 'update' }, [
			{ id, title: 'valid' },
			{ id: 'bad', stateGroup: 'completed' },
		]),
	).rejects.toThrow();
	expect(s.plane).not.toHaveBeenCalled();
});
it('does not interpret an unsupported operation as create', async () => {
	const s = fixture();
	await expect(s.adapter.workItems(s.run, s.node, { operation: 'invented' }, [])).rejects.toThrow();
	expect(s.plane).not.toHaveBeenCalled();
});

it('uses the same source key for MCP and downstream finding creation',async()=>{
 const s=fixture();const runner=vi.spyOn(s.adapter as unknown as {runner:(url:string)=>Promise<Response>},'runner').mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json','x-flow-desk-candidate-sha':'sha'}}));
 s.run.context={...s.run.context,candidateSha:'sha'} as typeof s.run.context;
 const finding={kind:'code',title:'Bug',reproduction:'Read f.ts',suggestion:'Fix',labels:['bug'],files:['f.ts'],evidence:[{kind:'code',name:'source',url:'artifact:11111111-1111-4111-8111-111111111111'}]};
 await s.adapter.workItems(s.run,s.node,{operation:'create'},[finding]);
 await s.adapter.workItems(s.run,{nodeId:'downstream',taskId:'task2'},{operation:'create'},[finding]);
 const bodies=s.plane.mock.calls.filter(call=>call[0]==='/issues/').map(call=>call[1] as Record<string,unknown>);
 expect(bodies[0].sourceKey).toBe(bodies[1].sourceKey);expect(bodies[0].parentId).toBe(id);expect(runner).toHaveBeenCalled();
});

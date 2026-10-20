import { it, expect } from 'vitest';
import { nativeProjectFlow } from '../native-flow';
it('uses generic capabilities with stable ids and the approved project flow', () => {
	const flow = {
		id: 'scan',
		nodes: [
			{ id: 's', name: '开始任务', type: 'start', parameters: {} },
			{ id: 'c', name: '准备依赖', type: 'command', parameters: { commandRef: 'install' } },
		],
		connections: { 开始任务: { main: [[{ node: '准备依赖', type: 'main', index: 0 }]] } },
	};
	const native = nativeProjectFlow('p', flow as never);
	expect(native.nodes[0]).toMatchObject({
		id: 's',
		type: '@n8n/nodes-flow-desk.flowDeskStart',
		parameters: { projectId: 'p', flowId: 'scan' },
	});
	expect(native.nodes[1]).toMatchObject({
		id: 'c',
		name: '准备依赖',
		parameters: { commandRef: 'install' },
	});
	expect(native.connections).toEqual(flow.connections);
	expect(() =>
		nativeProjectFlow('p', { ...flow, nodes: [{ ...flow.nodes[0], type: 'unknown' }] } as never),
	).toThrow();
});
it('registers typed conditions without adding a business capability', () => {
	const result = nativeProjectFlow('p', {
		id: 'scan',
		nodes: [
			{
				id: 'c',
				type: 'if',
				name: 'Has findings',
				parameters: { valueRef: 'scan.newIssues', operator: 'not-empty' },
			},
		],
		connections: {},
	});
	expect(result.nodes[0]).toMatchObject({
		id: 'c',
		type: '@n8n/nodes-flow-desk.flowDeskCondition',
	});
});
it('rejects unknown condition operators before a native workflow is created', () => {
	expect(() =>
		nativeProjectFlow('p', {
			id: 'x',
			nodes: [
				{
					id: 'c',
					type: 'if',
					name: 'Condition',
					parameters: { valueRef: 'items', operator: 'eval' },
				},
			],
			connections: {},
		}),
	).toThrow(/condition|parameters/i);
});

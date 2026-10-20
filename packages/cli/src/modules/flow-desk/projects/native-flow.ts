import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectFlow } from './project-config';
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
const catalog = JSON.parse(
	readFileSync(path.resolve(__dirname, '../contracts/node-catalog.json'), 'utf8'),
) as Array<{ type: string; n8nType: string }>;
export function nativeProjectFlow(projectId: string, flow: ProjectFlow) {
	return {
		name: `${projectId} / ${flow.id}`,
		nodes: flow.nodes.map((node, index) => {
			if (node.type === 'if') {
				const schema = JSON.parse(
					readFileSync(
						path.resolve(__dirname, '../contracts/workflow-condition-params.schema.json'),
						'utf8',
					),
				);
				if (!new Ajv({ strict: false }).compile(schema)(node.parameters))
					throw new Error('Invalid condition parameters');
			}
			const entry =
				node.type === 'if'
					? { n8nType: 'flowDeskCondition' }
					: catalog.find((item) => item.type === node.type);
			if (!entry) throw new Error(`Unsupported native project capability: ${node.type}`);
			return {
				...node,
				type: `@n8n/nodes-flow-desk.${entry.n8nType}`,
				typeVersion: 1,
				retryOnFail: true,
				maxTries: 3,
				waitBetweenTries: 1000,
				position: [index * 240, 300] as [number, number],
				parameters: {
					...node.parameters,
					...(node.type === 'start' ? { projectId, flowId: flow.id } : {}),
				},
			};
		}),
		connections: flow.connections,
		settings: { executionOrder: 'v1' as const },
	};
}

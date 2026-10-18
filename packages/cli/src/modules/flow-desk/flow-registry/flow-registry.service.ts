import { Service } from '@n8n/di';

const ALLOWED = new Set([
	'flowDeskTrigger',
	'flowDeskHumanStep',
	'flowDeskAgentStep',
	'flowDeskCiStep',
	'flowDeskCreateWorkItem',
	'flowDeskAwaitChildren',
	'flowDeskSwitchFlow',
	'flowDeskUiCheckStep',
	'flowDeskQualityStep',
	'n8n-nodes-base.set',
	'n8n-nodes-base.if',
	'n8n-nodes-base.merge',
	'n8n-nodes-base.noOp',
]);

@Service()
export class FlowDeskFlowRegistry {
	private active = new Map<string, { id: string; flowType: string; nodes: Array<{ type: string }> }>();

	async activate(workflow: { id: string; flowType: string; nodes: Array<{ type: string }> }) {
		for (const node of workflow.nodes) {
			if (!ALLOWED.has(node.type) && !node.type.startsWith('flowDesk')) {
				const err = new Error('node not allowed') as Error & { code: string };
				err.code = 'NODE_NOT_ALLOWED';
				throw err;
			}
			if (node.type === 'n8n-nodes-base.executeCommand') {
				const err = new Error('node not allowed') as Error & { code: string };
				err.code = 'NODE_NOT_ALLOWED';
				throw err;
			}
		}
		for (const [, existing] of this.active) {
			if (existing.flowType === workflow.flowType && existing.id !== workflow.id) {
				const err = new Error('duplicate flowType') as Error & { code: string };
				err.code = 'DUPLICATE_FLOW_TYPE';
				throw err;
			}
		}
		this.active.set(workflow.id, workflow);
	}

	async findActiveByFlowType(flowType: string) {
		for (const wf of this.active.values()) {
			if (wf.flowType === flowType) return wf as never;
		}
		return null;
	}

	async listActiveFlowTypes() {
		return [...this.active.values()].map((w) => ({ flowType: w.flowType, name: w.flowType }));
	}
}

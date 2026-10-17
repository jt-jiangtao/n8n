import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

/**
 * Flow Desk backend module shell.
 * Later milestones add controllers, entities, and resume/HITL wiring.
 */
@BackendModule({ name: 'flow-desk', instanceTypes: ['main'] })
export class FlowDeskModule implements ModuleInterface {
	async init() {
		// Intentionally empty in the foundation milestone.
	}
}

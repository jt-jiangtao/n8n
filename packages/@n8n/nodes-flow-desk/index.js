'use strict';

module.exports = {
	nodes: [
		require('./dist/nodes/FlowDeskCondition/FlowDeskCondition.node.js').FlowDeskCondition,
		require('./dist/nodes/FlowDeskStart/FlowDeskStart.node.js').FlowDeskStart,
		require('./dist/nodes/FlowDeskWorkspace/FlowDeskWorkspace.node.js').FlowDeskWorkspace,
		require('./dist/nodes/FlowDeskCommand/FlowDeskCommand.node.js').FlowDeskCommand,
		require('./dist/nodes/FlowDeskService/FlowDeskService.node.js').FlowDeskService,
		require('./dist/nodes/FlowDeskAgent/FlowDeskAgent.node.js').FlowDeskAgent,
		require('./dist/nodes/FlowDeskVerify/FlowDeskVerify.node.js').FlowDeskVerify,
		require('./dist/nodes/FlowDeskApproval/FlowDeskApproval.node.js').FlowDeskApproval,
		require('./dist/nodes/FlowDeskWorkItem/FlowDeskWorkItem.node.js').FlowDeskWorkItem,
		require('./dist/nodes/FlowDeskIntegrate/FlowDeskIntegrate.node.js').FlowDeskIntegrate,
		require('./dist/nodes/FlowDeskSubflow/FlowDeskSubflow.node.js').FlowDeskSubflow,
		require('./dist/nodes/FlowDeskProjectNotify/FlowDeskProjectNotify.node.js').FlowDeskProjectNotify,
		require('./dist/nodes/FlowDeskFinish/FlowDeskFinish.node.js').FlowDeskFinish,
		require('./dist/nodes/FlowDeskTrigger/FlowDeskTrigger.node.js').FlowDeskTrigger,
		require('./dist/nodes/FlowDeskHumanStep/FlowDeskHumanStep.node.js').FlowDeskHumanStep,
		require('./dist/nodes/FlowDeskAgentStep/FlowDeskAgentStep.node.js').FlowDeskAgentStep,
		require('./dist/nodes/FlowDeskCreateWorkItem/FlowDeskCreateWorkItem.node.js').FlowDeskCreateWorkItem,
		require('./dist/nodes/FlowDeskNotify/FlowDeskNotify.node.js').FlowDeskNotify,
		require('./dist/nodes/FlowDeskEndCheck/FlowDeskEndCheck.node.js').FlowDeskEndCheck,
	],
};

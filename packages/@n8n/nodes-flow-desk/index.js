'use strict';

module.exports = {
	nodes: [
		require('./dist/nodes/FlowDeskTrigger/FlowDeskTrigger.node.js').FlowDeskTrigger,
		require('./dist/nodes/FlowDeskHumanStep/FlowDeskHumanStep.node.js').FlowDeskHumanStep,
		require('./dist/nodes/FlowDeskAgentStep/FlowDeskAgentStep.node.js').FlowDeskAgentStep,
	],
};

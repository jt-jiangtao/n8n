'use strict';

// Mirror of n8n-workflow WAIT_INDEFINITELY — avoid hard dependency at load time in tests.
const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

/**
 * Shared helpers for Flow Desk step nodes (Human / Agent / CI).
 */
function getFlowDeskApi(ctx) {
	if (ctx.flowDesk) return ctx.flowDesk;
	// Runtime: nodes call the module HTTP API when DI hook is absent.
	const base = process.env.N8N_HOST
		? `http://127.0.0.1:${process.env.N8N_PORT || 5678}`
		: 'http://127.0.0.1:5678';
	const headers = { 'content-type': 'application/json' };
	if (process.env.FLOW_DESK_DESKTOP_MODE === 'true') {
		const secret = require('node:fs').readFileSync(process.env.FLOW_DESK_DESKTOP_SECRET_FILE || '/tmp/flow-desk-desktop-token', 'utf8').trim();
		headers.authorization = `Bearer ${secret}`;
	}
	return {
		executeNode: async (body) => {
			const response = await fetch(`${base}/rest/flow-desk/projects/execute-node`, { method: 'POST', headers, body: JSON.stringify(body) });
			if (!response.ok) throw new Error(`Project node failed: ${response.status}: ${(await response.text()).slice(0, 500)}`);
			return response.json();
		},
		steps: {
			register: async (body) => {
				const res = await fetch(`${base}/rest/flow-desk/steps/register`, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
				});
				if (!res.ok) throw new Error(`register failed: ${res.status}`);
				return res.json();
			},
			manualStart: async (flowType) => {
				const res = await fetch(`${base}/rest/flow-desk/manual-start?flowType=${encodeURIComponent(flowType)}`, { headers });
				if (!res.ok) return null;
				return res.json();
			},
			savedResult: async (executionId, nodeId) => {
				const params = new URLSearchParams({ executionId, nodeId });
				const res = await fetch(`${base}/rest/flow-desk/steps/result?${params}`, { headers });
				if (res.status === 204 || !res.ok) return null;
				return res.json();
			},
		},
		tasks: {
			dispatch: async () => undefined,
		},
		workItems: {
			create: async (body) => {
				const res = await fetch(`${base}/rest/flow-desk/work-items`, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
				});
				if (!res.ok) throw new Error(`create work item failed: ${res.status}`);
				return res.json();
			},
		},
		notify: {
			send: async (body) => {
				const res = await fetch(`${base}/rest/flow-desk/notifications`, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
				});
				if (!res.ok) throw new Error(`notify failed: ${res.status}`);
				return res.json();
			},
		},
	};
}

function readResume(ctx) {
	if (ctx.flowDeskResume) return ctx.flowDeskResume;
	return null;
}

async function putWait(ctx) {
	if (typeof ctx.putExecutionToWait === 'function') {
		await ctx.putExecutionToWait(WAIT_INDEFINITELY);
	}
}

module.exports = { getFlowDeskApi, readResume, putWait, WAIT_INDEFINITELY };

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
	return {
		steps: {
			register: async (body) => {
				const res = await fetch(`${base}/rest/flow-desk/steps/register`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!res.ok) throw new Error(`register failed: ${res.status}`);
				return res.json();
			},
		},
		tasks: {
			dispatch: async () => undefined,
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

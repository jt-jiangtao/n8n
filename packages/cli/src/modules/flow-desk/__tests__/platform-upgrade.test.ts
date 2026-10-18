/**
 * add-agent-cli-upgrade 1.2 — F44, F45
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../../../../',
);

describe('platform-upgrade flow (F44, F45)', () => {
	it('F44/F45: flow has install → smoke → platform.owner confirm → switch', () => {
		const p = path.join(repoRoot, 'flows/platform-upgrade.json');
		expect(existsSync(p)).toBe(true);
		const flow = JSON.parse(readFileSync(p, 'utf8')) as {
			meta: { flowType: string };
			nodes: Array<{ name: string; type: string; parameters?: Record<string, unknown> }>;
			connections: Record<string, { main?: Array<Array<{ node: string }> | null> }>;
		};
		expect(flow.meta.flowType).toBe('platform-upgrade');
		expect(flow.nodes.some((n) => n.parameters?.step === 'cli-install')).toBe(true);
		expect(flow.nodes.some((n) => n.parameters?.suite === 'cli-smoke')).toBe(true);
		expect(
			flow.nodes.some(
				(n) =>
					n.type === 'flowDeskHumanStep' && n.parameters?.assigneeRole === 'platform.owner',
			),
		).toBe(true);
		expect(flow.nodes.some((n) => n.parameters?.step === 'cli-switch')).toBe(true);

		// smoke failure path: CI failure has empty next (flow fails / no switch)
		const smokeFail = flow.connections['冒烟']?.main?.[1] ?? [];
		expect(smokeFail.length).toBe(0);
	});
});

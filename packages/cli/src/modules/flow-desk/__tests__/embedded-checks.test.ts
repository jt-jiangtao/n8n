/**
 * add-embedded-checks 1.1 — F33–F38
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../../../../',
);

type FlowNode = {
	id: string;
	type: string;
	name: string;
	parameters?: Record<string, unknown>;
};

type FlowConn = Record<
	string,
	{ main?: Array<Array<{ node: string; type: string; index: number }> | null> }
>;

function loadFlow(name: string) {
	const p = path.join(repoRoot, 'flows', `${name}.json`);
	expect(existsSync(p), `missing flow ${name}`).toBe(true);
	return JSON.parse(readFileSync(p, 'utf8')) as {
		meta?: { flowType?: string };
		nodes: FlowNode[];
		connections: FlowConn;
	};
}

function nodesOfType(flow: { nodes: FlowNode[] }, type: string) {
	return flow.nodes.filter((n) => n.type === type);
}

function outgoing(flow: { connections: FlowConn }, fromName: string, branchIndex: number) {
	const mains = flow.connections[fromName]?.main ?? [];
	return (mains[branchIndex] ?? []).map((c) => c.node);
}

describe('embedded-checks (F33–F38)', () => {
	it('F33: bug-standard quality (+ ui) after targeted CI, new-errors → implement x2', () => {
		const flow = loadFlow('bug-standard');
		const quality = nodesOfType(flow, 'flowDeskQualityStep');
		const ui = nodesOfType(flow, 'flowDeskUiCheckStep');
		expect(quality.length).toBeGreaterThanOrEqual(1);
		expect(ui.length).toBeGreaterThanOrEqual(1);
		expect(quality[0]?.parameters?.maxAttempts ?? 2).toBe(2);

		const ci = flow.nodes.find((n) => n.type === 'flowDeskCiStep' && n.parameters?.suite === 'targeted');
		expect(ci).toBeTruthy();
		const afterCi = outgoing(flow, ci!.name, 0);
		const checkNames = new Set([...quality, ...ui].map((n) => n.name));
		expect(afterCi.some((n) => checkNames.has(n))).toBe(true);

		const merge = flow.nodes.find((n) => n.name.includes('确认合入') || n.id === 'human-merge');
		expect(merge).toBeTruthy();

		const implement = flow.nodes.find((n) => n.type === 'flowDeskAgentStep' && n.parameters?.step === 'implement');
		expect(implement).toBeTruthy();
		for (const check of [...quality, ...ui]) {
			expect(outgoing(flow, check.name, 1)).toContain(implement!.name);
		}
	});

	it('F34: feature-small runs ui + quality before acceptance', () => {
		const flow = loadFlow('feature-small');
		const quality = nodesOfType(flow, 'flowDeskQualityStep');
		const ui = nodesOfType(flow, 'flowDeskUiCheckStep');
		expect(quality.length).toBeGreaterThanOrEqual(1);
		expect(ui.length).toBeGreaterThanOrEqual(1);

		const accept = flow.nodes.find((n) => n.name === '验收' || n.id === 'human-accept');
		expect(accept).toBeTruthy();

		const ci = flow.nodes.find((n) => n.type === 'flowDeskCiStep' && n.parameters?.suite === 'targeted');
		expect(ci).toBeTruthy();
		const afterCi = outgoing(flow, ci!.name, 0);
		const checkNames = new Set([...quality, ...ui].map((n) => n.name));
		expect(afterCi.some((n) => checkNames.has(n))).toBe(true);

		const intoAccept = Object.entries(flow.connections).some(([from, conn]) => {
			if (!checkNames.has(from)) return false;
			return (conn.main?.[0] ?? []).some((c) => c.node === accept!.name);
		});
		expect(intoAccept).toBe(true);
	});

	it('F35: feature-large ui check before final acceptance, scope covers child pages', () => {
		const flow = loadFlow('feature-large');
		const ui = nodesOfType(flow, 'flowDeskUiCheckStep');
		expect(ui.length).toBeGreaterThanOrEqual(1);
		const scope = String(ui[0]?.parameters?.scope ?? '');
		expect(['changed', 'all', 'children']).toContain(scope);

		const final = flow.nodes.find((n) => n.name === '整体验收' || n.id === 'human-final');
		expect(final).toBeTruthy();
		const fullCi = flow.nodes.find(
			(n) => n.type === 'flowDeskCiStep' && (n.parameters?.suite === 'full' || n.name.includes('整体回归')),
		);
		expect(fullCi).toBeTruthy();
		expect(outgoing(flow, fullCi!.name, 0).some((n) => ui.some((u) => u.name === n))).toBe(true);
		expect(
			Object.entries(flow.connections).some(([from, conn]) => {
				if (!ui.some((u) => u.name === from)) return false;
				return (conn.main?.[0] ?? []).some((c) => c.node === final!.name);
			}),
		).toBe(true);
	});

	it('F36: chore-refactor visual/new-errors route back to refactor', () => {
		const flow = loadFlow('chore-refactor');
		const quality = nodesOfType(flow, 'flowDeskQualityStep');
		const ui = nodesOfType(flow, 'flowDeskUiCheckStep');
		expect(quality.length).toBeGreaterThanOrEqual(1);
		expect(ui.length).toBeGreaterThanOrEqual(1);
		expect(ui[0]?.parameters?.failOnVisualChange).toBe(true);

		const refactor = flow.nodes.find(
			(n) => n.type === 'flowDeskAgentStep' && (n.parameters?.step === 'refactor' || n.name === '重构'),
		);
		expect(refactor).toBeTruthy();
		for (const check of [...quality, ...ui]) {
			expect(outgoing(flow, check.name, 1)).toContain(refactor!.name);
		}
	});

	it('F37: chore-deps full-scope ui check after full regression', () => {
		const flow = loadFlow('chore-deps');
		const ui = nodesOfType(flow, 'flowDeskUiCheckStep');
		expect(ui.length).toBeGreaterThanOrEqual(1);
		expect(ui[0]?.parameters?.scope).toBe('all');

		const fullCi = flow.nodes.find(
			(n) => n.type === 'flowDeskCiStep' && (n.parameters?.suite === 'full' || n.name.includes('全量')),
		);
		expect(fullCi).toBeTruthy();
		expect(outgoing(flow, fullCi!.name, 0).some((n) => ui.some((u) => u.name === n))).toBe(true);

		const merge = flow.nodes.find((n) => n.name.includes('确认合入') || n.id === 'human-merge');
		expect(merge).toBeTruthy();
		expect(
			Object.entries(flow.connections).some(([from, conn]) => {
				if (!ui.some((u) => u.name === from)) return false;
				return (conn.main?.[0] ?? []).some((c) => c.node === merge!.name);
			}),
		).toBe(true);
	});

	it('F38: bug-hotfix, bug-flaky, docs have no check steps', () => {
		for (const name of ['bug-hotfix', 'bug-flaky', 'docs']) {
			const flow = loadFlow(name);
			expect(nodesOfType(flow, 'flowDeskUiCheckStep')).toHaveLength(0);
			expect(nodesOfType(flow, 'flowDeskQualityStep')).toHaveLength(0);
		}
	});
});

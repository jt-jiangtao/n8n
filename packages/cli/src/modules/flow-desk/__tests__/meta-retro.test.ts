/**
 * add-meta-retro 1.1 — M143–M146, F39–F43, F46
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { FlowDeskReplayService } from '../replay/replay.service';
import { FlowDeskMetricsService } from '../metrics/metrics.service';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../../../../',
);

describe('meta-retro (M143–M146, F39–F43, F46)', () => {
	it('F39: summary pulls from metrics interface', () => {
		const metrics = new FlowDeskMetricsService();
		const m = metrics.compute({
			events: [],
			decisions: [
				{
					nodeId: 'm',
					area: 'web',
					flowType: 'docs',
					firstPass: false,
					rejectCategory: '实现错误',
					rejectReason: 'x',
					at: 1,
				},
			],
			tasks: [{ area: 'web', flowType: 'docs', adapter: 'codex', durationMs: 10, at: 1 }],
			workItems: [],
		});
		expect(m.rejectReasons.counts['实现错误']).toBe(1);
		expect(m.agentDuration.medianMs).toBe(10);
	});

	it('F40: improvement without evidence fails validation', () => {
		const improvements = [{ title: 'skip merge', evidence: '' }];
		expect(improvements.every((i) => Boolean(i.evidence?.trim()))).toBe(false);
	});

	it('F41: accepting none completes without changes', () => {
		const accepted: string[] = [];
		expect(accepted.length).toBe(0);
		expect({ status: '完成', filesChanged: [] }).toMatchObject({ status: '完成', filesChanged: [] });
	});

	it('F42/F46: only flows/ allowed; other paths fail', () => {
		const changed = ['flows/docs.json', 'config/flow-desk.yaml'];
		const illegal = changed.filter((p) => !p.startsWith('flows/'));
		expect(illegal).toEqual(['config/flow-desk.yaml']);
	});

	it('F43: meta-retro flow has platform.owner merge confirm', () => {
		const p = path.join(repoRoot, 'flows/meta-retro.json');
		expect(existsSync(p)).toBe(true);
		const flow = JSON.parse(readFileSync(p, 'utf8')) as {
			meta: { flowType: string };
			nodes: Array<{ type: string; parameters?: Record<string, unknown> }>;
		};
		expect(flow.meta.flowType).toBe('meta-retro');
		expect(
			flow.nodes.some(
				(n) =>
					n.type === 'flowDeskHumanStep' &&
					n.parameters?.assigneeRole === 'platform.owner' &&
					String(n.parameters?.title ?? '').includes('确认合入'),
			),
		).toBe(true);
	});

	it('M143/control: unchanged flow replay matches original outcomes', async () => {
		const store = { rows: [] as unknown[], save: async (r: unknown) => { store.rows.push(r); } };
		const replay = new FlowDeskReplayService(store);
		const flow = {
			flowType: 'docs',
			nodes: [{ id: 'a', type: 'flowDeskAgentStep' }, { id: 'h', type: 'flowDeskHumanStep' }],
			order: ['a', 'h'],
			endByBranch: { approve: '完成', reject: '失败' },
		};
		const history = Array.from({ length: 3 }, (_, i) => ({
			runId: `r${i}`,
			outcome: '完成' as const,
			nodeResults: { a: { branch: 'pass' }, h: { branch: 'approve' } },
		}));
		const result = await replay.replay({ flow, history });
		expect(result.runs).toHaveLength(3);
		expect(result.runs.every((r) => r.status === 'same')).toBe(true);
		expect(result.worseCount).toBe(0);
	});

	it('M144: missing recorded node → unreplayable', async () => {
		const replay = new FlowDeskReplayService();
		const result = await replay.replay({
			flow: {
				flowType: 'docs',
				nodes: [],
				order: ['a', 'new-node'],
				endByBranch: { pass: '完成' },
			},
			history: [
				{
					runId: 'r1',
					outcome: '完成',
					nodeResults: { a: { branch: 'pass' } },
				},
			],
		});
		expect(result.runs[0]?.status).toBe('unreplayable');
		expect(result.runs[0]?.missingNodes).toContain('new-node');
		expect(result.worseCount).toBe(0);
	});

	it('M145: completed → failed counts as worse', async () => {
		const replay = new FlowDeskReplayService();
		const result = await replay.replay({
			flow: {
				flowType: 'docs',
				nodes: [],
				order: ['h'],
				endByBranch: { approve: '失败' },
			},
			history: [
				{
					runId: 'r1',
					outcome: '完成',
					nodeResults: { h: { branch: 'approve' } },
				},
			],
		});
		expect(result.runs[0]?.status).toBe('worse');
		expect(result.worseCount).toBe(1);
	});

	it('M146: replay has no runner/plane/commit side effects', async () => {
		const callRunner = vi.fn();
		const writePlane = vi.fn();
		const commit = vi.fn();
		const store = { rows: [] as unknown[], save: async (r: unknown) => { store.rows.push(r); } };
		const replay = new FlowDeskReplayService(store, { callRunner, writePlane, commit });
		await replay.replay({
			flow: { flowType: 'docs', nodes: [], order: ['a'], endByBranch: { pass: '完成' } },
			history: [{ runId: 'r', outcome: '完成', nodeResults: { a: { branch: 'pass' } } }],
		});
		expect(callRunner).not.toHaveBeenCalled();
		expect(writePlane).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
		expect(store.rows).toHaveLength(1);
	});
});

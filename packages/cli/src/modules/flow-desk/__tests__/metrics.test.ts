/**
 * add-metrics-dashboard 1.2 — M127–M133, M150
 */
import { describe, expect, it } from 'vitest';

import { FlowDeskMetricsService } from '../metrics/metrics.service';

describe('metrics (M127–M133, M150)', () => {
	const svc = new FlowDeskMetricsService();
	const base = {
		events: [
			{ type: 'escape', at: 100, area: 'web', flowType: 'bug-standard' },
			{ type: 'escape', at: 110, area: 'web', flowType: 'bug-standard', voided: true },
		],
		decisions: [
			{ nodeId: 'merge', area: 'web', flowType: 'bug-standard', firstPass: true, at: 50 },
			{
				nodeId: 'merge',
				area: 'web',
				flowType: 'bug-standard',
				firstPass: false,
				rejectCategory: '实现错误' as const,
				rejectReason: '缺测试',
				at: 60,
			},
		],
		tasks: [
			{ area: 'web', flowType: 'bug-standard', adapter: 'codex', durationMs: 1000, at: 40 },
			{ area: 'web', flowType: 'bug-standard', adapter: 'cursor', durationMs: 3000, at: 45 },
		],
		workItems: [
			{ area: 'web', flowType: 'bug-standard', todoAt: 0, endedAt: 1000, merged: true },
			{ area: 'web', flowType: 'bug-standard', todoAt: 0, endedAt: 2000, merged: true },
			{ area: 'web', flowType: 'docs', todoAt: 0, endedAt: 500, merged: false },
		],
	};

	it('M127: handling time median and p90', () => {
		const m = svc.compute(base);
		expect(m.handlingTime.medianMs).toBeGreaterThan(0);
		expect(m.handlingTime.p90Ms).toBeGreaterThanOrEqual(m.handlingTime.medianMs);
	});

	it('M128: confirm first-pass rate', () => {
		const m = svc.compute(base);
		expect(m.confirmPassRate.rate).toBe(0.5);
		expect(m.confirmPassRate.byNode.merge).toBe(0.5);
	});

	it('M129: reject reason distribution', () => {
		const m = svc.compute(base);
		expect(m.rejectReasons.counts['实现错误']).toBe(1);
		expect(m.rejectReasons.recent[0]?.reason).toMatch(/缺测试/);
	});

	it('M130/M131: escape rate ignores voided', () => {
		const m = svc.compute(base);
		expect(m.escapeRate.escapes).toBe(1);
		expect(m.escapeRate.merges).toBe(2);
		expect(m.escapeRate.rate).toBe(0.5);
	});

	it('M132: agent duration by adapter', () => {
		const m = svc.compute(base);
		expect(m.agentDuration.medianMs).toBeGreaterThan(0);
		expect(m.agentDuration.byAdapter.codex).toBe(1000);
	});

	it('M133: compute only uses provided events/decisions/tasks (no Plane)', () => {
		const m = svc.compute({ ...base, area: 'web', flowType: 'bug-standard' });
		expect(m.handlingTime.medianMs).toBeGreaterThan(0);
		expect(Object.keys(m)).toEqual([
			'handlingTime',
			'confirmPassRate',
			'rejectReasons',
			'escapeRate',
			'agentDuration',
		]);
	});

	it('M150: /reject parses category or 未分类', () => {
		expect(svc.parseRejectCommand('/reject 实现错误 缺用例')).toEqual({
			category: '实现错误',
			reason: '缺用例',
		});
		expect(svc.parseRejectCommand('/reject 随便写的原因')).toEqual({
			category: '未分类',
			reason: '随便写的原因',
		});
		expect(svc.parseRejectCommand('not a command')).toBeNull();
	});
});

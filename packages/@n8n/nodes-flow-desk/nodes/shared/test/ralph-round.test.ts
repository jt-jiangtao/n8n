import { describe, expect, it } from 'vitest';

import { hasEndMarker, RALPH_END_MARKER, ralphRound, withRalphBrief } from '../ralph-round.js';

const marker = RALPH_END_MARKER;

describe('ralph round', () => {
	it('ends only when the whole reply is the marker', () => {
		expect(hasEndMarker(`  ${marker}\n`, marker)).toBe(true);
		expect(hasEndMarker(`发现了一处\n${marker}`, marker)).toBe(false);
		expect(hasEndMarker(`结束标记是 ${marker}，但还没做完`, marker)).toBe(false);
		expect(hasEndMarker('COMPLETE', marker)).toBe(false);
		expect(hasEndMarker('', marker)).toBe(false);
	});

	it('continues until the whole reply is the marker or the round cap', () => {
		expect(ralphRound({ round: 1, maxRounds: 8, output: '还在看布局', marker, valid: true })).toBe('again');
		expect(ralphRound({ round: 2, maxRounds: 8, output: `这一轮没有发现\n${marker}`, marker, valid: true })).toBe('again');
		expect(ralphRound({ round: 7, maxRounds: 8, output: marker, marker, valid: true })).toBe('done');
		expect(ralphRound({ round: 8, maxRounds: 8, output: '还没写完', marker, valid: true })).toBe('exceeded');
		expect(ralphRound({ round: 8, maxRounds: 8, output: `  ${marker}  `, marker, valid: true })).toBe('done');
	});

	it('does not treat an invalid result as finished, and a zero cap never runs', () => {
		expect(
			ralphRound({ round: 1, maxRounds: 3, output: marker, marker, valid: false }),
		).toBe('failed');
		expect(
			ralphRound({ round: 3, maxRounds: 3, output: marker, marker, valid: false }),
		).toBe('exceeded');
		expect(ralphRound({ round: 1, maxRounds: 0, output: marker, marker, valid: true })).toBe('exceeded');
		expect(ralphRound({ round: 4, maxRounds: 3, output: marker, marker, valid: true })).toBe('exceeded');
	});

	it('keeps a single valid round when the flow does not ask for a marker', () => {
		expect(ralphRound({ round: 1, maxRounds: 3, output: 'done', marker: '', valid: true })).toBe('done');
	});

	it('adds the round brief without dropping the task instructions', () => {
		const text = withRalphBrief('只读扫描', 2, 8, marker);
		expect(text).toContain('只读扫描');
		expect(text).toContain('第 2/8 轮');
		expect(text).toContain(marker);
		expect(withRalphBrief('只读扫描', 1, 3, '')).toBe('只读扫描');
	});
});

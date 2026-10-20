'use strict';

const RALPH_END_MARKER = '<promise>COMPLETE</promise>';

function hasEndMarker(output, marker) {
	if (!marker) return false;
	return String(output).trim() === String(marker).trim();
}

function roundCap(value) {
	if (value === undefined || value === null || value === '') return 3;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.floor(parsed) : 3;
}

function ralphRound(input) {
	const maxRounds = Number.isFinite(input.maxRounds) ? Math.floor(input.maxRounds) : 1;
	const round = Number.isFinite(input.round) ? Math.floor(input.round) : 1;
	if (maxRounds < 1 || round > maxRounds) return 'exceeded';
	if (!input.valid) return round >= maxRounds ? 'exceeded' : 'failed';
	const marker = String(input.marker ?? '').trim();
	if (!marker) return 'done';
	if (hasEndMarker(input.output, marker)) return 'done';
	return round >= maxRounds ? 'exceeded' : 'again';
}

function ralphBrief(round, maxRounds, marker) {
	return [
		`第 ${round}/${maxRounds} 轮。`,
		'你决定这一轮做什么。',
		`全部完成时，回复全文只能是 ${marker}，不要加别的字。`,
		'不是这一整段回复会进入下一轮。到达轮数上限后不再继续。',
	].join('\n');
}

function withRalphBrief(instructions, round, maxRounds, marker) {
	const markerText = String(marker ?? '').trim();
	if (!markerText) return String(instructions ?? '');
	const body = String(instructions ?? '').trim();
	const brief = ralphBrief(round, maxRounds, markerText);
	return body ? `${body}\n\n${brief}` : brief;
}

function settleAgentRound(resume, options) {
	const data = resume.data || {};
	const decision = ralphRound({
		round: Number(data.attempt ?? 1),
		maxRounds: options.maxRounds,
		output: String(data.summary ?? ''),
		marker: options.marker,
		valid: resume.branch !== 'failure',
	});
	if (decision === 'again') return { action: 'again' };
	const branch = decision === 'done' ? resume.branch : decision === 'failed' ? 'failure' : 'exceeded';
	const item = { json: { branch, ...data } };
	if (decision === 'exceeded') return { action: 'stop', outputs: [[], [], [item]] };
	if (decision === 'failed') return { action: 'stop', outputs: [[], [item], []] };
	return { action: 'stop', outputs: [[item], [], []] };
}

module.exports = {
	RALPH_END_MARKER,
	roundCap,
	hasEndMarker,
	ralphRound,
	ralphBrief,
	withRalphBrief,
	settleAgentRound,
};

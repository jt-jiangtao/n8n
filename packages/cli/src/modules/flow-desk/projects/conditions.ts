import { contentDigest } from './project-config';
import { readRef } from './runtime-model';

export function evaluateCondition(
	context: Record<string, unknown>,
	params: Record<string, unknown>,
) {
	const value = readRef(context, String(params.valueRef));
	if (value === undefined) throw new Error('Condition reference is missing');
	const operator = params.operator ?? 'equals';
	if (operator === 'empty' || operator === 'not-empty') {
		if (!Array.isArray(value)) throw new Error('Condition requires a list');
		return operator === 'empty' ? value.length === 0 : value.length > 0;
	}
	if (!['equals', 'not-equals'].includes(String(operator)) || !Object.hasOwn(params, 'equals'))
		throw new Error('Invalid typed condition');
	const equal = contentDigest(value) === contentDigest(params.equals);
	return operator === 'equals' ? equal : !equal;
}

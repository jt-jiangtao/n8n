import { createHmac, timingSafeEqual } from 'node:crypto';
export type HumanAssertion = {
	actor: string;
	operation: string;
	input: Record<string, unknown>;
	issuedAt: number;
	nonce: string;
};
export function readHumanAssertion(header: string, secret: string): HumanAssertion {
	const [encoded, mac, ...extra] = header.split('.');
	if (!encoded || !mac || extra.length || !secret || header.length > 24000)
		throw new Error('Invalid human assertion');
	const expected = Buffer.from(createHmac('sha256', secret).update(encoded).digest('hex')),
		actual = Buffer.from(mac);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new Error('Invalid human assertion');
	const value = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as HumanAssertion;
	if (
		!value.actor ||
		['agent-bot', 'flow-desk', 'system'].includes(value.actor) ||
		!Number.isFinite(value.issuedAt) ||
		Math.abs(Date.now() - value.issuedAt) > 30000 ||
		!value.nonce ||
		!value.input ||
		typeof value.input !== 'object'
	)
		throw new Error('Invalid or expired human assertion');
	return value;
}

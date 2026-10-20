import { createHmac } from 'node:crypto';
import { it, expect } from 'vitest';
import { readHumanAssertion } from '../human-assertion';
const secret = 'a'.repeat(64),
	envelope = {
		actor: 'human',
		operation: 'decision',
		input: { decision: 'approve' },
		issuedAt: Date.now(),
		nonce: 'n',
	};
function header(value: unknown) {
	const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
	return encoded + '.' + createHmac('sha256', secret).update(encoded).digest('hex');
}
it('accepts only a current assertion issued by the human session edge', () => {
	expect(readHumanAssertion(header(envelope), secret)).toEqual(envelope);
	expect(() => readHumanAssertion(header({ ...envelope, actor: 'agent-bot' }), secret)).toThrow();
	expect(() => readHumanAssertion(header({ ...envelope, issuedAt: 0 }), secret)).toThrow();
	expect(() => readHumanAssertion(header(envelope) + 'x', secret)).toThrow();
});

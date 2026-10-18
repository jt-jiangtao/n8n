/** N10, N11 — Plane deep links from n8n UI helpers */
import { describe, expect, it } from 'vitest';

import { executionDeepLink, workItemDeepLink } from '../planeLinks';

describe('n8n plane links (N10, N11)', () => {
	it('N10: parameter panel uses flowdesk://work-item/<id>', () => {
		expect(workItemDeepLink('WEB-42')).toBe('flowdesk://work-item/WEB-42');
	});

	it('N11: execution title bar uses flowdesk://execution/<id>', () => {
		expect(executionDeepLink('exec-9')).toBe('flowdesk://execution/exec-9');
	});
});

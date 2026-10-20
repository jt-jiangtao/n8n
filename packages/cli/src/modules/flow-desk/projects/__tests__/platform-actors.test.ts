import { expect, it } from 'vitest';
import { platformActors } from '../platform-actors';
it('resolves me only from the verified desktop-owner record, never from project roles', async () => {
	const rows = new Map<string, unknown>();
	const records = {
		read: async <T>(key: string) => (rows.get(key) as T) ?? null,
		write: async () => {},
	};
	expect(await platformActors(records, ['me'])).toEqual([]);
	rows.set('project:active:p', { snapshot: { config: { roles: { owner: ['intruder'] } } } });
	expect(await platformActors(records, ['me'])).toEqual([]);
	rows.set('platform:desktop-owner', { actor: 'actual-owner' });
	expect(await platformActors(records, ['me', 'explicit-owner'])).toEqual([
		'actual-owner',
		'explicit-owner',
	]);
});

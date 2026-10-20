import { describe, expect, it } from 'vitest';
import { ProjectConfigurationService } from '../project-store';
it('activates a pinned version idempotently and rejects an intervening active version', async () => {
	const rows = new Map<string, unknown>();
	const service = new ProjectConfigurationService({
		read: async (key: string) => rows.get(key) ?? null,
		write: async (key: string, value: unknown) => {
			rows.set(key, value);
		},
	} as never);
	const draft = (hash: string) => ({
		projectId: 'p',
		contentHash: hash,
		config: { roles: { owner: ['owner'] } },
	});
	await service.propose(draft('old') as never);
	await service.approve('p', 'old', 'owner');
	await service.propose(draft('new') as never);
	await service.propose(draft('other') as never);
	await service.activateVersion('p', 'new', 'owner', 'old');
	const active = await service.activateVersion('p', 'new', 'owner', 'old');
	expect(active.contentHash).toBe('new');
	await expect(service.activateVersion('p', 'other', 'owner', 'old')).rejects.toThrow(/changed/);
});
it('uses active owners for updates rather than owners introduced by the candidate', async () => {
	const rows = new Map<string, unknown>();
	const service = new ProjectConfigurationService({
		read: async (key: string) => rows.get(key) ?? null,
		write: async (key: string, value: unknown) => {
			rows.set(key, value);
		},
	} as never);
	await service.propose({
		projectId: 'p',
		contentHash: 'old',
		config: { roles: { owner: ['owner'] } },
	} as never);
	await service.approve('p', 'old', 'owner');
	await service.propose({
		projectId: 'p',
		contentHash: 'new',
		config: { roles: { owner: ['intruder'] } },
	} as never);
	await expect(service.approve('p', 'new', 'intruder')).rejects.toThrow();
	expect(await service.active('p')).toMatchObject({ contentHash: 'old' });
	await expect(service.approve('p', 'new', 'owner')).resolves.toMatchObject({ contentHash: 'new' });
});
describe('project activation is separate from editing', () => {
	it('does not activate a draft until an authorized human approves its content', async () => {
		const rows = new Map<string, unknown>();
		const repo = {
			read: async (key: string) => rows.get(key) ?? null,
			write: async (key: string, value: unknown) => {
				rows.set(key, value);
			},
		};
		const service = new ProjectConfigurationService(repo as never);
		const candidate = {
			projectId: 'p',
			contentHash: 'draft',
			config: { roles: { owner: ['human'] } },
			flowId: 'scan',
		};
		await service.propose(candidate as never);
		expect(await service.active('p')).toBeNull();
		await expect(service.approve('p', 'draft', 'agent-bot')).rejects.toThrow();
		await service.approve('p', 'draft', 'human');
		expect(await service.active('p')).toMatchObject({ contentHash: 'draft' });
		await service.propose({ ...candidate, contentHash: 'new' } as never);
		expect(await service.active('p')).toMatchObject({ contentHash: 'draft' });
		await expect(service.approve('p', 'draft', 'human')).rejects.toThrow();
	});
});

it('does not let a delivery reviewer activate project execution configuration', async () => {
	const rows = new Map<string, unknown>();
	const service = new ProjectConfigurationService({
		read: async (key: string) => rows.get(key) ?? null,
		write: async (key: string, value: unknown) => {
			rows.set(key, value);
		},
	} as never);
	await service.propose({
		projectId: 'p',
		contentHash: 'draft',
		config: { roles: { owner: ['owner'], reviewer: ['reviewer'] } },
	} as never);
	await expect(service.approve('p', 'draft', 'reviewer')).rejects.toThrow();
	await expect(service.approve('p', 'draft', 'owner')).resolves.toMatchObject({ actor: 'owner' });
});

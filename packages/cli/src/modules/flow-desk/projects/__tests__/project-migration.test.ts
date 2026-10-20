import { expect, it, vi } from 'vitest';
import { ProjectMigrationService } from '../project-migration';
import { ProjectConfigurationService } from '../project-store';
import { migrationCandidate } from '../legacy-migration';
import type { Run, NodeRecord } from '../runtime-model';
async function setup(status = 'passed') {
	const rows = new Map<string, unknown>();
	const records = {
		read: async <T>(key: string) => structuredClone(rows.get(key) ?? null) as T | null,
		write: async (key: string, value: unknown) => {
			rows.set(key, structuredClone(value));
		},
		claim: async (key: string, value: unknown) => {
			if (rows.has(key)) return false;
			rows.set(key, structuredClone(value));
			return true;
		},
	};
	const config = new ProjectConfigurationService(records);
	const source = { areaId: 'a', area: { repo: '/repo' }, flows: { scan: 'custom legacy graph' } };
	const snapshot = {
		projectId: 'p',
		contentHash: 'config',
		config: { roles: { owner: ['human'] } },
		flows: { scan: { id: 'scan', nodes: [{ id: 'verify', type: 'verify' }] } },
	};
	const draft = migrationCandidate({
		projectId: 'p',
		source,
		files: { 'project.yaml': 'preserved' },
		mapping: { scan: 'scan' },
	});
	await config.propose(snapshot as never);
	await records.write('project:activation-gate:p:config', { status: 'pending' });
	await records.write('migration:candidate:p', {
		...draft,
		snapshot,
		before: null,
		trials: ['trial'],
	});
	const old = { executionId: 'old', status: 'canceled', snapshot: { unchanged: true } };
	await records.write('run:old', old);
	const publish = vi.fn(async (_candidate: unknown, _actor: string) => ({ sha: 'a'.repeat(40) }));
	const inspect = vi.fn(async (id: string) => ({
		run: {
			executionId: id,
			projectId: 'p',
			configHash: 'config',
			flowId: 'scan',
			status,
			failures: {},
		} as Run,
		nodes: [
			{
				projectId: 'p',
				executionId: id,
				runId: id,
				nodeId: 'verify',
				attempt: 1,
				configHash: 'config',
				instanceId: 'test',
				invocationId: 'verify',
				taskId: 'verified',
				type: 'verify',
				status: 'passed',
				result: { verification: { signed: true } },
			} satisfies NodeRecord,
		],
	}));
	const verify = vi.fn((_node: NodeRecord) => {});
	const service = new ProjectMigrationService(records, config, {
		source: async () => source,
		publish,
		trial: async () => ({ runId: 'trial' }),
		inspect,
		verify,
	});
	return { service, records, rows, config, draft, publish, inspect, verify, old };
}
it.each(['failed', 'running', 'canceled'])(
	'does not publish or activate a %s migration trial',
	async (status) => {
		const s = await setup(status);
		await expect(s.service.activate('p', s.draft.contentHash, 'human')).rejects.toThrow(/trial/);
		expect(s.publish).not.toHaveBeenCalled();
		expect(await s.config.active('p')).toBeNull();
	},
);
it('rejects invalid trial signatures before publication', async () => {
	const s = await setup();
	s.verify.mockImplementationOnce(() => {
		throw new Error('Invalid signature');
	});
	await expect(s.service.activate('p', s.draft.contentHash, 'human')).rejects.toThrow(/signature/);
	expect(s.publish).not.toHaveBeenCalled();
});
it('keeps publication failure visible and retries the same candidate without activating early', async () => {
	const s = await setup();
	s.publish.mockRejectedValueOnce(new Error('publication failed'));
	await expect(s.service.activate('p', s.draft.contentHash, 'human')).rejects.toThrow(
		/publication/,
	);
	expect(await s.config.active('p')).toBeNull();
	await s.service.activate('p', s.draft.contentHash, 'human');
	expect(await s.config.active('p')).toMatchObject({ contentHash: 'config' });
});
it('switches only new routing and preserves old run snapshots during activation and rollback', async () => {
	const s = await setup();
	await s.service.activate('p', s.draft.contentHash, 'human');
	expect(await s.service.resolve('a', 'scan')).toEqual({ projectId: 'p', flowId: 'scan' });
	await s.service.rollback('p', s.draft.contentHash, 'human');
	expect(await s.service.resolve('a', 'scan')).toBeNull();
	expect(await s.records.read('run:old')).toEqual(s.old);
	expect(await s.service.rollback('p', s.draft.contentHash, 'human')).toMatchObject({
		status: 'legacy',
	});
});
it('does not let ordinary configuration activation bypass pending migration trials', async () => {
	const s = await setup();
	await expect(s.config.approve('p', 'config', 'human')).rejects.toThrow(/incomplete/);
});
it('rejects binding a second legacy area to an existing migration project', async () => {
	const s = await setup();
	await expect(
		s.service.propose({
			projectId: 'p',
			areaId: 'another-area',
			files: { 'project.yaml': 'unused' },
			mapping: { scan: 'scan' },
			flowId: 'scan',
		}),
	).rejects.toThrow(/area/i);
	expect(await s.service.candidate('p')).toMatchObject({ source: { areaId: 'a' } });
});

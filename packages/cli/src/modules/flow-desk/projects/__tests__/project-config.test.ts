import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectSnapshot, bindProjectFlow } from '../project-config';
it('binds only declared project defaults and preserves explicit run overrides', () => {
	const snapshot = {
		config: { defaults: { version: '1.2.3', unrelated: 'private' } },
		flows: {
			upgrade: {
				id: 'upgrade',
				parameters: {
					type: 'object',
					additionalProperties: false,
					properties: { version: { type: 'string' } },
					required: ['version'],
				},
			},
		},
	};
	expect(bindProjectFlow(snapshot as never, 'upgrade').params).toEqual({ version: '1.2.3' });
	expect(bindProjectFlow(snapshot as never, 'upgrade', { version: '2.0.0' }).params).toEqual({
		version: '2.0.0',
	});
	expect(() => bindProjectFlow(snapshot as never, 'upgrade', { unrelated: 'x' })).toThrow();
});
function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), 'project-config-'));
	const dir = path.join(root, 'projects', 'p');
	mkdirSync(dir, { recursive: true });
	const config = {
		version: 1,
		projectId: 'p',
		name: 'Project',
		repo: '/tmp/repo',
		baseRef: 'main',
		flows: { scan: 'flows/scan.json' },
		prompts: { scan: 'prompts/scan.md' },
		skills: { audit: { path: 'skills/audit' } },
		schemas: { scan: 'schemas/scan.json' },
		preparation: { commands: [], services: [] },
		verification: {},
		roles: { owner: ['human'] },
	};
	for (const sub of ['flows', 'prompts', 'schemas', 'skills/audit'])
		mkdirSync(path.join(dir, sub), { recursive: true });
	writeFileSync(path.join(dir, 'project.yaml'), JSON.stringify(config));
	writeFileSync(path.join(dir, 'prompts/scan.md'), 'Scan only the selected project.');
	writeFileSync(path.join(dir, 'skills/audit/SKILL.md'), '# Audit\nCheck visible evidence.');
	writeFileSync(
		path.join(dir, 'schemas/scan.json'),
		JSON.stringify({
			type: 'object',
			required: ['summary'],
			properties: { summary: { type: 'string' } },
			additionalProperties: false,
		}),
	);
	writeFileSync(
		path.join(dir, 'flows/scan.json'),
		JSON.stringify({
			id: 'scan',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: { target: { type: 'string', default: 'all' } },
			},
			nodes: [{ id: 'start', name: 'Start', type: 'start', parameters: {} }],
			connections: {},
		}),
	);
	return { root, dir, config };
}
describe('project-scoped immutable snapshots', () => {
	it('binds declared parameters as data and freezes source content', () => {
		const { root, dir } = fixture();
		const target = 'users; $(touch /tmp/never-execute)';
		const snapshot = loadProjectSnapshot({
			root,
			projectId: 'p',
			flowId: 'scan',
			params: { target },
		});
		expect(snapshot.params.target).toBe(target);
		expect(snapshot.prompts.scan).toContain('selected project');
		writeFileSync(path.join(dir, 'prompts/scan.md'), 'changed');
		expect(snapshot.prompts.scan).not.toBe('changed');
		expect(loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' }).contentHash).not.toBe(
			snapshot.contentHash,
		);
	});
	it('uses project defaults and rejects undeclared input', () => {
		const { root } = fixture();
		expect(loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' }).params.target).toBe('all');
		expect(() =>
			loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan', params: { command: 'rm -rf' } }),
		).toThrow();
	});
	it('rejects missing required parameters', () => {
		const { root, dir } = fixture();
		writeFileSync(
			path.join(dir, 'flows/scan.json'),
			JSON.stringify({
				id: 'scan',
				parameters: {
					type: 'object',
					required: ['target'],
					properties: { target: { type: 'string' } },
				},
				nodes: [],
				connections: {},
			}),
		);
		expect(() => loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' })).toThrow();
	});
	it('rejects project traversal and symlink escapes', () => {
		const { root, dir, config } = fixture();
		expect(() => loadProjectSnapshot({ root, projectId: '../p', flowId: 'scan' })).toThrow();
		const outside = mkdtempSync(path.join(tmpdir(), 'outside-project-'));
		writeFileSync(path.join(outside, 'secret.md'), 'outside');
		symlinkSync(outside, path.join(dir, 'external'));
		config.prompts.scan = 'external/secret.md';
		writeFileSync(path.join(dir, 'project.yaml'), JSON.stringify(config));
		expect(() => loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' })).toThrow();
	});
	it('rejects corrupt schemas and unknown node types', () => {
		const { root, dir } = fixture();
		writeFileSync(path.join(dir, 'schemas/scan.json'), '{');
		expect(() => loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' })).toThrow();
	});
});

describe('child flow snapshot ownership', () => {
	it('captures and validates all referenced subflow definitions before activation', () => {
		const { root, dir, config } = fixture();
		Object.assign(config.flows, { prepare: 'flows/prepare.json' });
		writeFileSync(path.join(dir, 'project.yaml'), JSON.stringify(config));
		const child = {
			id: 'prepare',
			nodes: [{ id: 's', name: 'Start', type: 'start', parameters: {} }],
			connections: {},
		};
		writeFileSync(path.join(dir, 'flows/prepare.json'), JSON.stringify(child));
		const snapshot = loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' });
		expect(snapshot.flows.prepare).toEqual(child);
		writeFileSync(path.join(dir, 'flows/prepare.json'), JSON.stringify({ ...child, nodes: [] }));
		expect(snapshot.flows.prepare.nodes).toHaveLength(1);
		expect(() => loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' })).toThrow();
	});
});

it('binds each run to declared parameters without changing configuration approval', async () => {
	const { bindProjectFlow } = await import('../project-config.js');
	const { root } = fixture();
	const frozen = loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' });
	const run = bindProjectFlow(frozen, 'scan', { target: 'account settings' });
	expect(run.params.target).toBe('account settings');
	expect(run.contentHash).toBe(frozen.contentHash);
	expect(frozen.params.target).toBe('all');
	expect(() => bindProjectFlow(frozen, 'scan', { command: 'arbitrary' })).toThrow();
});
it('rejects a condition with an unknown operator before approving its configuration', () => {
	const { root, dir } = fixture();
	writeFileSync(
		path.join(dir, 'flows/scan.json'),
		JSON.stringify({
			id: 'scan',
			nodes: [
				{ id: 's', name: 'Start', type: 'start', parameters: {} },
				{
					id: 'c',
					name: 'Condition',
					type: 'if',
					parameters: { valueRef: 'items', operator: 'eval' },
				},
			],
			connections: { Start: { main: [[{ node: 'Condition' }]] } },
		}),
	);
	expect(() => loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' })).toThrow(
		/condition|parameters/i,
	);
});
it('rejects missing preparation and verification command references at configuration load', () => {
	const { root, dir, config } = fixture();
	writeFileSync(
		path.join(dir, 'project.yaml'),
		JSON.stringify({ ...config, preparation: { commands: ['absent'], services: [] } }),
	);
	expect(() => loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' })).toThrow(
		/preparation|command/i,
	);
});
it('rejects conflicting inline and referenced commands in an approved flow', () => {
	const { root, dir } = fixture();
	writeFileSync(
		path.join(dir, 'flows/scan.json'),
		JSON.stringify({
			id: 'scan',
			nodes: [
				{ id: 's', name: 'Start', type: 'start', parameters: {} },
				{
					id: 'c',
					name: 'Command',
					type: 'command',
					parameters: { command: 'echo inline', commandRef: 'build' },
				},
			],
			connections: { Start: { main: [[{ node: 'Command' }]] } },
		}),
	);
	expect(() => loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' })).toThrow(
		/parameters|command/i,
	);
});

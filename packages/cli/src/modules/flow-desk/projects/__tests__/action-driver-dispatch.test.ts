import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadProjectSnapshot } from '../project-config';
it('keeps the application MCP and its skill in the immutable project snapshot', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'mcp-project-'));
	const dir = path.join(root, 'projects/p');
	mkdirSync(dir, { recursive: true });
	const config = {
		version: 1,
		projectId: 'p',
		name: 'P',
		repo: '/tmp/repo',
		baseRef: 'main',
		flows: { scan: 'flow.json' },
		prompts: { scan: 'scan.md' },
		schemas: { scan: 'schema.json' },
		skills: { 'action-driver-mcp': { path: 'skills/action-driver-mcp' }, 'flow-desk-mcp': { path: 'skills/flow-desk-mcp' } },
		preparation: { commands: [], services: [] },
		verification: {},
		roles: { owner: ['me'] },
		actionDriverMcp: {
			command: 'node',
			args: ['/app/mcp.js', '--mode', 'attach', '--data-root', '/data'],
		},
	};
	mkdirSync(path.join(dir, 'skills/action-driver-mcp'), { recursive: true });
	const templateRoot = fileURLToPath(
		new URL('../../../../../../../../../templates/project/', import.meta.url),
	);
	const skill = readFileSync(
		path.join(templateRoot, 'skills/action-driver-mcp/SKILL.md'),
		'utf8',
	);
	mkdirSync(path.join(dir, 'skills/flow-desk-mcp'), { recursive: true });
	const guide=readFileSync(path.join(templateRoot,'skills/flow-desk-mcp/SKILL.md'),'utf8');
	writeFileSync(path.join(dir,'skills/flow-desk-mcp/SKILL.md'),guide);
	const prompt = readFileSync(path.join(templateRoot, 'prompts/scan.md'), 'utf8');
	writeFileSync(path.join(dir, 'skills/action-driver-mcp/SKILL.md'), skill);
	writeFileSync(path.join(dir, 'project.yaml'), JSON.stringify(config));
	writeFileSync(path.join(dir, 'scan.md'), prompt);
	writeFileSync(path.join(dir, 'schema.json'), '{}');
	writeFileSync(
		path.join(dir, 'flow.json'),
		JSON.stringify({
			id: 'scan',
			nodes: [{ id: 'start', name: 'Start', type: 'start', parameters: {} }],
			connections: {},
		}),
	);
	const snapshot = loadProjectSnapshot({ root, projectId: 'p', flowId: 'scan' });
	expect(snapshot.config.actionDriverMcp).toEqual(config.actionDriverMcp);
	expect(snapshot.skills['action-driver-mcp']['SKILL.md']).toBe(skill);
	expect(snapshot.prompts.scan).toBe(prompt);
	expect(snapshot.skills['flow-desk-mcp']['SKILL.md']).toBe(guide);
	writeFileSync(path.join(dir, 'skills/flow-desk-mcp/SKILL.md'), 'changed after dispatch');
	expect(snapshot.skills['flow-desk-mcp']['SKILL.md']).toBe(guide);
	writeFileSync(path.join(dir, 'scan.md'), 'changed after dispatch');
	writeFileSync(path.join(dir, 'skills/action-driver-mcp/SKILL.md'), 'changed after dispatch');
	expect(snapshot.prompts.scan).toBe(prompt);
	expect(snapshot.skills['action-driver-mcp']['SKILL.md']).toBe(skill);
	config.actionDriverMcp.args[0] = '/changed';
	writeFileSync(path.join(dir, 'project.yaml'), JSON.stringify(config));
	expect(snapshot.config.actionDriverMcp.args[0]).toBe('/app/mcp.js');
});

import { it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PackageDirectoryLoader } from 'n8n-core';
const require = createRequire(path.join(__dirname, 'loader.test.cjs'));
it('registers all generic capabilities through the actual n8n package loader', async () => {
	const directory = path.dirname(require.resolve('@n8n/nodes-flow-desk/package.json'));
	const loader = new PackageDirectoryLoader(directory);
	await loader.loadAll();
	expect(Object.keys(loader.known.nodes)).toHaveLength(19);
	for (const name of [
		'flowDeskStart',
		'flowDeskWorkspace',
		'flowDeskCommand',
		'flowDeskService',
		'flowDeskAgent',
		'flowDeskVerify',
		'flowDeskApproval',
		'flowDeskWorkItem',
		'flowDeskIntegrate',
		'flowDeskSubflow',
		'flowDeskProjectNotify',
		'flowDeskFinish',
		'flowDeskCondition',
	])
		expect(loader.known.nodes[name]).toBeDefined();
}, 30000);
it('keeps the compatibility JS entry points as delegates to the compiled TS source', async () => {
	const { readFileSync } = await import('node:fs');
	const root = path.dirname(require.resolve('@n8n/nodes-flow-desk/package.json'));
	for (const name of ['FlowDeskAgentStep', 'FlowDeskHumanStep', 'FlowDeskCreateWorkItem']) {
		const source = readFileSync(path.join(root, 'nodes', name, name + '.node.js'), 'utf8');
		expect(source).toContain('../../dist/nodes/' + name + '/' + name + '.node.js');
		expect(source).not.toContain('async execute');
	}
});

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
describe('source node package', () => {
  it('builds loadable CommonJS node classes for the native n8n loader', () => {
    const root = path.resolve(__dirname, '../../..');
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root });
    for (const name of ['FlowDeskTrigger', 'FlowDeskAgentStep', 'FlowDeskHumanStep', 'FlowDeskCiStep', 'FlowDeskCreateWorkItem', 'FlowDeskAwaitChildren', 'FlowDeskSwitchFlow', 'FlowDeskUiCheckStep', 'FlowDeskQualityStep']) {
      const exported = require(path.join(root, 'dist/nodes', name, `${name}.node.js`));
      const node = new exported[name]();
      expect(node.description.name).toMatch(/^flowDesk/);
      expect(node.description.defaults.name).toBeTypeOf('string');
      expect(node.description.description).toBeTypeOf('string');
    }
  });
});

import { copyFileSync, mkdirSync, cpSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'nodes');
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
for (const name of readdirSync(path.join(root, 'nodes'))) {
  if (!name.startsWith('FlowDesk') || name === 'FlowDeskPlaceholder') continue;
  const source = path.join(root, 'nodes', name);
  const output = path.join(dist, name);
  mkdirSync(output, { recursive: true });
  const js = path.join(source, `${name}.node.js`);
  const target = path.join(output, `${name}.node.js`);
  const typescript = path.join(source, `${name}.node.ts`);
  if (existsSync(typescript)) writeFileSync(target, ts.transpileModule(readFileSync(typescript, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
  else copyFileSync(js, target);
  writeFileSync(target, readFileSync(target, 'utf8') + `\n;(() => { const Source = module.exports.${name};\nmodule.exports.${name} = class extends Source { constructor() { super(); this.description.defaults ??= { name: this.description.displayName }; this.description.description ??= this.description.displayName; } }; })();\n`);
}
cpSync(path.join(root, 'nodes', 'shared'), path.join(dist, 'shared'), { recursive: true, filter: source => !source.includes('/test') });
cpSync(path.join(root, 'contracts'), path.join(root, 'dist', 'contracts'), { recursive: true });
mkdirSync(path.join(dist, 'helpers'), { recursive: true });
for (const name of readdirSync(path.join(root, 'nodes/helpers'))) {
  if (name.endsWith('.ts')) writeFileSync(path.join(dist, 'helpers', name.replace(/\.ts$/, '.js')), ts.transpileModule(readFileSync(path.join(root, 'nodes/helpers', name), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
}
console.log('nodes-flow-desk build ok');

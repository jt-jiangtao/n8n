import { copyFileSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist', 'nodes')

for (const name of ['FlowDeskTrigger', 'FlowDeskHumanStep', 'FlowDeskAgentStep']) {
  const srcDir = path.join(root, 'nodes', name)
  const outDir = path.join(dist, name)
  mkdirSync(outDir, { recursive: true })
  copyFileSync(path.join(srcDir, `${name}.node.js`), path.join(outDir, `${name}.node.js`))
}

const sharedSrc = path.join(root, 'nodes', 'shared')
const sharedOut = path.join(dist, 'shared')
mkdirSync(sharedOut, { recursive: true })
cpSync(sharedSrc, sharedOut, { recursive: true })

console.log('nodes-flow-desk build ok')

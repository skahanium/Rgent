import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const nodeRoot = path.resolve(path.dirname(process.execPath), '..')
const args = ['rebuild']
if (existsSync(path.join(nodeRoot, 'include', 'node', 'node_api.h'))) {
  args.push(`--nodedir=${nodeRoot}`)
} else {
  args.push(`--devdir=${path.join(root, 'build', '.node-gyp')}`)
}
const require = createRequire(import.meta.url)
const command = require.resolve('node-gyp/bin/node-gyp.js')
const run = spawnSync(process.execPath, [command, ...args], { cwd: root, stdio: 'inherit' })
if (run.error) throw run.error
process.exit(run.status ?? 1)

import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const nodeRoot = path.resolve(path.dirname(process.execPath), '..')
const cachedHeaders = process.env.RGENT_NODE_HEADERS_DIR
const args = ['rebuild']
if (cachedHeaders) {
  if (!existsSync(path.join(cachedHeaders, 'include', 'node', 'node_api.h'))) {
    throw new Error(`RGENT_NODE_HEADERS_DIR is missing Node headers: ${cachedHeaders}`)
  }
  args.push(`--nodedir=${path.resolve(cachedHeaders)}`)
} else if (existsSync(path.join(nodeRoot, 'include', 'node', 'node_api.h'))) {
  args.push(`--nodedir=${nodeRoot}`)
} else {
  args.push(`--devdir=${path.join(root, 'build', '.node-gyp')}`)
}
const require = createRequire(import.meta.url)
const command = require.resolve('node-gyp/bin/node-gyp.js')
const run = spawnSync(process.execPath, [command, ...args], { cwd: root, stdio: 'inherit' })
if (run.error) throw run.error
process.exit(run.status ?? 1)

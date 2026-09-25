import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const addon = path.join(root, 'out', 'main', 'rgent_fs.node')
if (!existsSync(addon)) throw new Error('Built native vault module is missing')

const require = createRequire(import.meta.url)
const electron = require('electron')
const probe = `const fs = require(${JSON.stringify(addon)}); if (typeof fs.openRoot !== 'function') process.exit(2)`
const run = spawnSync(electron, ['-e', probe], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit'
})
if (run.error) throw run.error
if (run.status !== 0) process.exit(run.status ?? 1)

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

/** node-gyp 12 只扫 Windows 默认的 3.8–3.11；3.12+ 装在用户目录时，普通 CMD 会找不到。 */
function usablePython(command) {
  if (!command || !existsSync(command)) return false
  const probe = spawnSync(command, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 6) else 1)'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return probe.status === 0
}

function resolvePython() {
  const forced = process.env.NODE_GYP_FORCE_PYTHON || process.env.PYTHON
  if (forced && usablePython(forced)) return forced
  if (process.platform !== 'win32') return null
  const local = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files'
  for (const version of ['314', '313', '312']) {
    for (const candidate of [
      path.join(local, 'Programs', 'Python', `Python${version}`, 'python.exe'),
      path.join(programFiles, `Python${version}`, 'python.exe')
    ]) {
      if (usablePython(candidate)) return candidate
    }
  }
  return null
}

const python = resolvePython()
const env = { ...process.env }
if (python) {
  env.PYTHON = python
  args.push(`--python=${python}`)
} else if (process.platform === 'win32') {
  process.stderr.write(
    '找不到可用的 Python 3（node-gyp 编译原生模块需要它）。' +
    '商店里的 python 空壳不算。若已安装 3.12+，可先执行：\n' +
    '  set PYTHON=%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\n'
  )
}

const require = createRequire(import.meta.url)
const command = require.resolve('node-gyp/bin/node-gyp.js')
const run = spawnSync(process.execPath, [command, ...args], { cwd: root, env, stdio: 'inherit' })
if (run.error) throw run.error
process.exit(run.status ?? 1)

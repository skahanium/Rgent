#!/usr/bin/env node
/**
 * `pnpm dev` 的启动器，只为一件事：清掉 ELECTRON_RUN_AS_NODE。
 *
 * 从 Electron 宿主的终端启动时（VS Code / Cursor / 各种 GUI 终端，以及本机的
 * 智能体宿主），环境里会带着 ELECTRON_RUN_AS_NODE=1。此时 electron 二进制会退化
 * 成普通 Node（`electron --version` 报 Node 版本而不是 44.x），主进程里
 * `import { BrowserWindow } from 'electron'` 就报
 * "does not provide an export named 'BrowserWindow'"。
 *
 * verify-ui.mjs 起真实窗口时已经这样清过一次；开发入口同样处理，免得每个人
 * 都要先意识到自己的终端不对。
 *
 * `RGENT_DEV_BIN` 可以换成别的 electron-vite 可执行文件，只为本机验证与自定义安装留口。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const executable = process.env.RGENT_DEV_BIN
  ?? path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')
const child = spawn(executable, ['dev', ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { child.kill(signal) })
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
child.on('error', (error) => {
  process.stderr.write(`无法启动 electron-vite：${error.message}\n`)
  process.exit(1)
})

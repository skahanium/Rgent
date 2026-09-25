import { spawn } from 'node:child_process'

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(command, ['test'], { shell: process.platform === 'win32' })
let tail = ''
for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  source.on('data', (chunk) => {
    destination.write(chunk)
    tail = (tail + chunk.toString()).slice(-6000)
  })
}
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('close', (code) => {
  if (code !== 0) {
    const detail = tail.replace(/\x1b\[[0-9;]*m/g, '').slice(-4000)
      .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
    console.log(`::error title=CI test output::${detail}`)
  }
  process.exitCode = code ?? 1
})

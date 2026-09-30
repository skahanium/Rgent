import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// No caller-controlled source paths. Native executables create their own unique fixtures.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'rgent-trash-runner-'))
const reportPath = process.env.RGENT_TRASH_REPORT
  ? resolve(process.env.RGENT_TRASH_REPORT)
  : join(scratch, 'report.json')
const report = {
  schemaVersion: 1, platform: process.platform, scratch, reportPath,
  productionGateOpen: false, systemPutBackVerified: false,
  status: 'incomplete', compiler: null, scenarios: [],
}

async function save() {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
async function run(command, args, timeoutMs) {
  return await new Promise(resolveRun => {
    const child = spawn(command, args, { cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, settled = false
    child.stdout.on('data', bytes => { stdout += bytes.toString() })
    child.stderr.on('data', bytes => { stderr += bytes.toString() })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    const finish = (exitCode, signal, error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolveRun({ command, args, exitCode, signal, timedOut, stdout, stderr, error: error?.message ?? '' })
    }
    child.on('error', error => finish(null, null, error))
    child.on('close', (exitCode, signal) => finish(exitCode, signal))
  })
}

try {
  let binary, modes
  if (process.platform === 'darwin') {
    binary = join(scratch, 'trash-probe')
    report.compiler = await run('clang++', [
      '-std=c++17', '-fobjc-arc', '-Wno-deprecated-declarations',
      join(repo, 'test/native/trash_mac.mm'), '-framework', 'AppKit', '-o', binary,
    ], 60_000)
    modes = ['ordinary', 'file-replace', 'parent-swap', 'parent-link', 'reference-outside', 'same-name', 'partial']
  } else if (process.platform === 'win32') {
    binary = join(scratch, 'trash-probe.exe')
    // Locate the installed C++ toolchain without rebuilding the production addon.
    const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const discovery = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], 15_000)
    report.compilerDiscovery = discovery
    if (discovery.exitCode !== 0 || !discovery.stdout.trim()) throw new Error('MSVC C++ toolchain was not found')
    const installation = discovery.stdout.trim().split(/\r?\n/)[0]
    // Batch quoting rejects metacharacters instead of allowing caller input to become cmd.exe syntax.
    const quote = value => {
      if (/["\r\n%&|<>^!]/u.test(value)) throw new Error('Unsupported compiler path characters')
      return `"${value}"`
    }
    const vcvars = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    const source = join(repo, 'test/native/trash_win.cc')
    const buildFile = join(scratch, 'compile.cmd')
    await writeFile(buildFile, `@echo off\r\ncall ${quote(vcvars)} >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /EHsc /std:c++20 /W4 /DUNICODE /D_UNICODE ${quote(source)} /Fe:${quote(binary)} /Fo:${quote(join(scratch, 'trash-probe.obj'))} /link ole32.lib shell32.lib uuid.lib bcrypt.lib\r\n`)
    report.compiler = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${buildFile}"`], 60_000)
    modes = ['ordinary', 'initial-file-replace', 'queued-file-replace', 'predelete-file-replace',
      'initial-parent-move', 'queued-parent-move', 'predelete-parent-move',
      'initial-junction', 'queued-junction', 'predelete-junction',
      'same-name', 'partial', 'leaf-pin', 'parent-pin-replace']
  } else {
    report.status = 'unsupported'
    throw new Error(`No native trash probe for ${process.platform}`)
  }
  await save()
  if (report.compiler.exitCode !== 0 || report.compiler.timedOut) throw new Error('Native probe compilation failed')
  for (const mode of modes) {
    const execution = await run(binary, [mode], 45_000)
    let evidence = null, parseError = ''
    try { evidence = JSON.parse(execution.stdout.trim()) } catch (error) { parseError = error.message }
    const ok = execution.exitCode === 0 && !execution.timedOut && evidence?.mode === mode
      && evidence?.experimentComplete === true && evidence?.fixtureReclaimed === true
      && evidence?.systemPutBackVerified === false
    report.scenarios.push({ mode, ok, evidence, parseError, execution })
    await save()
    console.log(`${mode}: ${ok ? 'evidence collected; own fixture reclaimed' : 'incomplete or cleanup failed'}`)
    // A wrong-object observation is valuable evidence and does not fail CI. Missing evidence or cleanup does.
  }
  report.status = report.scenarios.every(scenario => scenario.ok) ? 'evidence-collected' : 'incomplete'
} catch (error) {
  report.error = error.message
} finally {
  await save()
  console.log(`Native trash report: ${reportPath}`)
}
process.exitCode = report.status === 'evidence-collected' ? 0 : 1

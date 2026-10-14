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

// Candidate list per platform. Every entry is judged by the identical rules below; only the
// destructive call selected through RGENT_TRASH_API changes. The defaults add the newly tried
// macOS candidate beside the already-tried one and leave the Windows CI surface unchanged.
const candidates = {
  darwin: {
    workspace: ['ordinary', 'file-replace', 'parent-swap', 'parent-link', 'reference-outside', 'same-name', 'partial'],
    'file-manager': ['ordinary', 'file-replace', 'parent-swap', 'parent-link', 'reference-outside', 'same-name', 'partial'],
  },
  win32: {
    'file-operation': ['ordinary', 'initial-file-replace', 'queued-file-replace', 'predelete-file-replace',
      'initial-parent-move', 'queued-parent-move', 'predelete-parent-move',
      'initial-junction', 'queued-junction', 'predelete-junction',
      'same-name', 'partial', 'leaf-pin', 'parent-pin-replace'],
    // Selectable through RGENT_TRASH_APIS, never run by default: this API returns no per-item
    // receipt, so the exact-receipt judgment below cannot pass and the trashed fixture has no
    // landing path this probe may reclaim. Selecting it is expected to report incomplete evidence.
    shfileoperation: ['ordinary', 'initial-file-replace', 'initial-parent-move', 'initial-junction', 'same-name'],
  },
}
const defaultApis = { darwin: ['workspace', 'file-manager'], win32: ['file-operation'] }
const apiNotes = {
  shfileoperation: 'SHFileOperationW + FOF_ALLOWUNDO has no receipt output, so a run is expected to report incomplete evidence by construction; it may leave the fixture in the runner Recycle Bin.',
}

async function save() {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
async function run(command, args, timeoutMs, env) {
  return await new Promise(resolveRun => {
    const child = spawn(command, args, { cwd: scratch, windowsHide: true, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  if (!candidates[process.platform]) {
    report.status = 'unsupported'
    throw new Error(`No native trash probe for ${process.platform}`)
  }
  const requested = (process.env.RGENT_TRASH_APIS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const apis = requested.length ? requested : defaultApis[process.platform]
  const onlyModes = (process.env.RGENT_TRASH_MODES ?? '').split(',').map(value => value.trim()).filter(Boolean)
  for (const api of apis) {
    if (!candidates[process.platform][api]) throw new Error(`Unknown RGENT_TRASH_APIS entry for ${process.platform}: ${api}`)
  }
  // A requested mode that no selected candidate knows would silently shrink the run.
  for (const mode of onlyModes) {
    if (!apis.some(api => candidates[process.platform][api].includes(mode))) throw new Error(`Unknown RGENT_TRASH_MODES entry for ${process.platform}: ${mode}`)
  }
  report.apis = apis
  report.modeFilter = onlyModes
  report.apiNotes = Object.fromEntries(apis.filter(api => apiNotes[api]).map(api => [api, apiNotes[api]]))
  let binary
  if (process.platform === 'darwin') {
    binary = join(scratch, 'trash-probe')
    report.compiler = await run('clang++', [
      '-std=c++17', '-fobjc-arc', '-Wno-deprecated-declarations',
      join(repo, 'test/native/trash_mac.mm'), '-framework', 'AppKit', '-o', binary,
    ], 60_000)
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
    // Fixed basename in our scratch cwd avoids Node/cmd.exe double-quoting absolute paths.
    report.compiler = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'compile.cmd'], 60_000)
  }
  await save()
  if (report.compiler.exitCode !== 0 || report.compiler.timedOut) {
    console.error(report.compiler.stdout.slice(-4_000), report.compiler.stderr.slice(-4_000))
    throw new Error('Native probe compilation failed')
  }
  for (const api of apis) {
    for (const mode of candidates[process.platform][api].filter(mode => !onlyModes.length || onlyModes.includes(mode))) {
      const execution = await run(binary, [mode], 45_000, { RGENT_TRASH_API: api })
      let evidence = null, parseError = ''
      try { evidence = JSON.parse(execution.stdout.trim()) } catch (error) { parseError = error.message }
      // Evidence must declare the very candidate it was asked to exercise; no looser rule exists.
      const ok = execution.exitCode === 0 && !execution.timedOut && evidence?.mode === mode && evidence?.trashApi === api
        && evidence?.experimentComplete === true && evidence?.fixtureReclaimed === true
        && evidence?.ownedFixtureObjectsAccounted === true && evidence?.residualFixture === ''
        && !evidence?.probeError && !evidence?.cleanupError && evidence?.systemPutBackVerified === false
      report.scenarios.push({ api, mode, ok, evidence, parseError, execution })
      await save()
      console.log(`${api}/${mode}: ${ok ? 'evidence collected; own fixture reclaimed' : 'incomplete or cleanup failed'}`)
      // A wrong-object observation is valuable evidence and does not fail CI. Missing evidence or cleanup does.
    }
  }
  // An empty run is not evidence either.
  report.status = report.scenarios.length > 0 && report.scenarios.every(scenario => scenario.ok) ? 'evidence-collected' : 'incomplete'
} catch (error) {
  report.error = error.message
} finally {
  await save()
  console.log(`Native trash report: ${reportPath}`)
}
process.exitCode = report.status === 'evidence-collected' ? 0 : 1

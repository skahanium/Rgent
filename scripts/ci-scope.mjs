import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const trashFiles = new Set(['scripts/probe-trash.mjs', 'test/native/trash_mac.mm', 'test/native/trash_win.cc'])
const docsTests = new Set(['scripts/check-docs.mjs', 'test/scripts/check-docs.test.ts'])
const shellFiles = new Set(['src/main/index.ts', 'src/main/theme-preference.ts', 'scripts/verify-ui.mjs'])
const rootDocs = new Set(['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'LICENSE'])

export function classifyChanges(files, mode) {
  if (mode !== undefined && !['full', 'standard', 'trash'].includes(mode)) throw new Error('未知 CI 模式')
  const scope = { runtime: false, visual: false, trash: false, docsTests: false }
  if (mode) {
    return { runtime: mode !== 'trash', visual: mode === 'full', trash: mode !== 'standard', docsTests: mode === 'full' }
  }
  // 新分支、取不到差异或空差异均不作为免验依据。
  if (!files.length) return { ...scope, runtime: true, visual: true }
  for (const file of files) {
    if (rootDocs.has(file) || file.startsWith('docs/')) continue
    if (docsTests.has(file)) { scope.docsTests = true; continue }
    if (trashFiles.has(file)) { scope.trash = true; continue }
    scope.runtime = true
    // 主进程业务和对应单测仍跑功能窗口；其他未知改动保守采视觉证据。
    if (shellFiles.has(file) || !/^(?:src\/main\/|test\/main\/)/u.test(file)) scope.visual = true
  }
  return scope
}

export function verificationPassed(scope, results, duplicate = false) {
  if (results.plan !== 'success') return false
  if (duplicate) return ['docs', 'verify', 'trash'].every(job => results[job] === 'skipped')
  return ['docs', 'verify', 'trash'].every(job => {
    const required = job === 'docs' || (job === 'verify' ? scope.runtime : scope.trash)
    return required ? results[job] === 'success' : ['success', 'skipped'].includes(results[job])
  })
}

function gitFiles(event, eventName) {
  let base, head, range
  if (eventName === 'pull_request') {
    base = event.pull_request.base.sha; head = event.pull_request.head.sha; range = '...'
  } else if (eventName === 'push') {
    base = event.before; head = event.after; range = '..'
  } else { throw new Error('不支持的 CI 事件') }
  if (![base, head].every(sha => /^[a-f\d]{40,64}$/u.test(sha))) throw new Error('无效的差异修订')
  if (/^0+$/u.test(base)) return []
  // 不启用 rename 检测：旧路径和新路径都必须参与门禁分类；NUL 保留特殊文件名。
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}${range}${head}`, '--'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean)
}

function main() {
  if (process.argv[2] === 'summary') {
    const needs = JSON.parse(process.env.CI_NEEDS)
    const outputs = needs.plan.outputs
    if (!['runtime', 'visual', 'trash', 'docsTests', 'duplicate'].every(key => ['true', 'false'].includes(outputs?.[key]))) {
      throw new Error('CI 分类输出缺失或无效，不能跳过门禁')
    }
    const scope = { runtime: outputs.runtime === 'true', trash: outputs.trash === 'true' }
    const results = Object.fromEntries(Object.entries(needs).map(([job, value]) => [job, value.result]))
    if (!verificationPassed(scope, results, outputs.duplicate === 'true')) {
      throw new Error(`CI 门禁未全部通过：${JSON.stringify(results)}`)
    }
    console.log(outputs.duplicate === 'true' ? '同一提交交由已开放 PR 的检查验收。' : '本次变更所需门禁全部通过。')
    return
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  let files = []
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    try { files = gitFiles(event, process.env.GITHUB_EVENT_NAME) }
    catch (error) { console.warn(`无法核定差异，回到完整代码门禁：${error.message}`) }
  }
  const scope = classifyChanges(files, process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? event.inputs?.mode ?? 'full' : undefined)
  console.log(JSON.stringify({ changedFiles: files.length, ...scope }))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join(''))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

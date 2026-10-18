import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 交付证据核验（**本地专用**，best-effort，不进 CI）：
 * - 解析文档里 `**已交**`／`**本机已交**` 表行末列引用的提交号与 `actions/runs/<id>`；
 * - 提交须存在且是 `origin/branch-v0.1.0` 的祖先；run 用 `gh api` 查 `conclusion`，须为 success；
 * - 另报当前 HEAD 上尚未推送的提交（`origin/branch-v0.1.0..HEAD`）——这是有意的提醒，
 *   两笔未推送的人删除／AI 删除提交在本机交付时就应当被这条报出来；
 * - 无 gh／离线／非 git 工作树／取不到远端引用：打印提示并跳过对应检查，不判错。
 *
 * 退出码：发现未推送提交、不存在的提交、非 success（或已删除）的 run → 1；仅环境跳过 → 0。
 * 它只核「文档声明与远端引用的一致性」，不代替 CI、窗口门或人工复核。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', ...[
  'README.md', 'architecture.md', 'build.md', 'build-history.md', 'decisions.md', 'frontend.md', 'handbook.md',
  'opensource.md', 'topics.md', 'vision.md', 'memory.md'
].map((name) => `docs/${name}`)]
const findings = []
const notices = []
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })

if (git('rev-parse', '--show-toplevel').status !== 0) {
  process.stdout.write('delivery:check 跳过：不是 git 工作树（本检查只在完整克隆里有效）。\n')
  process.exit(0)
}
const base = 'origin/branch-v0.1.0'
if (git('rev-parse', '--verify', '--quiet', base).status !== 0) {
  process.stdout.write(`delivery:check 跳过：找不到 ${base}（离线、未配置远端或尚未 fetch）。\n`)
  process.exit(0)
}
const commitExists = (sha) => git('cat-file', '-e', `${sha}^{commit}`).status === 0
const objectExists = (sha) => git('cat-file', '-e', sha).status === 0
const isAncestor = (sha) => git('merge-base', '--is-ancestor', sha, base).status === 0

// 1) 文档声明：只认「已交／本机已交」表行的末列（与 check-docs 的包表判据同一批）。
const commits = new Map()
const runs = new Map()
for (const file of files) {
  const lines = readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!line.startsWith('|')) return
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) return
    const state = /^\*\*([^*]+)\*\*/.exec(cells.at(-1) ?? '')?.[1]
    if (state !== '已交' && state !== '本机已交') return
    for (const match of line.matchAll(/`([0-9a-f]{7,40})`/g)) {
      if (!commits.has(match[1])) commits.set(match[1], [])
      commits.get(match[1]).push({ file, line: index + 1, state })
    }
    for (const match of line.matchAll(/actions\/runs\/(\d+)/g)) {
      runs.set(match[1], { file, line: index + 1, state })
    }
  })
}

// 2) 提交：存在且已推送。文档里声明的号与「HEAD 上尚未推送」两路都查。
const unpushed = git('log', '--format=%h%x09%s', `${base}..HEAD`).stdout.trim()
if (unpushed) {
  for (const line of unpushed.split('\n')) findings.push(`未推送提交：${line}（${base} 之后）`)
}
for (const [sha, refs] of commits) {
  const where = refs.map((ref) => `${ref.file}:${ref.line}（${ref.state}）`).join('、')
  if (!commitExists(sha)) {
    // 反引号里的 7–40 位十六进制不一定是提交（可能是 tree／blob 片段）；对象存在就不算缺证据。
    if (!objectExists(sha)) findings.push(`文档引用的提交不存在：\`${sha}\`（${where}）`)
  } else if (!isAncestor(sha)) {
    findings.push(`文档标记已交但未推送：\`${sha}\` 不在 ${base} 历史里（${where}）`)
  }
}

// 3) run：有 gh 才查，离线／未登录／无 gh 一律提示后跳过。
if (runs.size > 0) {
  const remote = git('config', '--get', 'remote.origin.url').stdout.trim()
  const slug = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/.exec(remote)?.[1]
  const ghReady = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0
  if (!ghReady) {
    notices.push('未找到 gh，跳过 run 结论核验（提交检查仍已执行）。')
  } else if (!slug) {
    notices.push('无法从 origin 解析 GitHub 仓库名，跳过 run 结论核验。')
  } else {
    for (const [id, ref] of runs) {
      const where = `${ref.file}:${ref.line}（${ref.state}）`
      const result = spawnSync('gh', ['api', `repos/${slug}/actions/runs/${id}`, '--jq', '.conclusion'], {
        cwd: root, encoding: 'utf8', timeout: 20_000
      })
      if (result.status !== 0) {
        const detail = `${result.stderr}${result.stdout}`.trim().split('\n')[0] ?? ''
        if (/not found|404/i.test(detail)) {
          findings.push(`run 不存在（可能已删除）：${id}（${where}）`)
        } else {
          notices.push(`gh 不可用或离线，跳过其余 run 核验：${detail || '未知错误'}`)
          break
        }
        continue
      }
      const conclusion = result.stdout.trim()
      if (conclusion !== 'success') {
        findings.push(`run ${id} 结论是 ${conclusion || 'null'}，不是 success（${where}）`)
      }
    }
  }
}

if (notices.length > 0) for (const notice of notices) process.stderr.write(`${notice}\n`)
if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${finding}\n`)
  process.stderr.write(`delivery:check 发现 ${findings.length} 条（本机引用 ${base}，不代替 fetch／CI／窗口门）。\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`delivery:check 通过：文档声明的 ${commits.size} 个提交都在 ${base} 里，${runs.size} 个 run 均为 success（best-effort，本地专用）。\n`)
}

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', ...[
  'README.md', 'architecture.md', 'build.md', 'decisions.md', 'frontend.md', 'handbook.md',
  'opensource.md', 'topics.md', 'vision.md'
].map((name) => `docs/${name}`)]
const errors = []

/** GitHub 风格的标题锚点：小写、去标点、空白转连字符。中文保留原字。 */
function anchorsOf(source) {
  const anchors = new Set()
  const withoutCode = source.replace(/```[\s\S]*?```/g, '')
  for (const match of withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const text = match[1]
      .replace(/`[^`]*`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      // 每个空格各换一个连字符，不合并：`多进程 / 并发` 去掉 `/` 是两个空格，
      // GitHub 的锚点就是 `多进程--并发`。
      .replace(/ /g, '-')
    if (text) anchors.add(text)
  }
  return anchors
}

for (const file of files) {
  const source = readFileSync(path.join(root, file), 'utf8')
  const withoutCode = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  for (const match of withoutCode.matchAll(/!?\[[^\]\n]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, '')
    const [target, hash] = raw.split('#')
    if (!target) continue
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue
    const resolved = path.resolve(root, path.dirname(file), decodeURIComponent(target))
    if (!existsSync(resolved)) {
      errors.push(`${file}: 相对链接不存在：${match[1]}`)
      continue
    }
    // 锚点也要存在：跨篇引用很多，标题一改就会悄悄失效。
    if (!hash || !resolved.endsWith('.md')) continue
    const anchors = anchorsOf(readFileSync(resolved, 'utf8'))
    if (!anchors.has(decodeURIComponent(hash).toLowerCase())) {
      errors.push(`${file}: 锚点不存在：${match[1]}`)
    }
  }
}

const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
const build = readFileSync(path.join(root, 'docs/build.md'), 'utf8')
const stageOf = (source) => source.match(/^## 当前阶段\s*\n+\*\*([^*]+)\*\*/m)?.[1]
const agentsStage = stageOf(agents)
const buildStage = stageOf(build)
if (!agentsStage || !buildStage || agentsStage !== buildStage) {
  errors.push(`当前阶段不一致：AGENTS.md=${agentsStage ?? '缺失'}；docs/build.md=${buildStage ?? '缺失'}`)
}
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`文档检查通过：${files.length} 个文件，当前阶段「${buildStage}」。\n`)
}

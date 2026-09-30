import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', ...[
  'README.md', 'architecture.md', 'build.md', 'decisions.md', 'frontend.md', 'handbook.md',
  'opensource.md', 'topics.md', 'vision.md'
].map((name) => `docs/${name}`)]
const errors = []

/** 只消费独占行的围栏；行内代码中的三个反引号不是围栏起点。兼容 CRLF。 */
function stripFencedCode(source) {
  return source.replace(/^ {0,3}```[^\r\n]*\r?\n[\s\S]*?^ {0,3}```[ \t]*\r?$/gm, '')
}

/** GitHub 风格的标题锚点：小写、去标点、空白转连字符。中文保留原字。 */
function anchorsOf(source) {
  const anchors = new Set()
  const withoutCode = stripFencedCode(source)
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
  const withoutCode = stripFencedCode(source).replace(/`[^`\n]*`/g, '')
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
const order = build.match(/^## 依赖顺序\s*\n[\s\S]*?```text\s*\n([\s\S]*?)\n```/m)?.[1]
const inOrder = (name) => order?.split(/\r?\n/).some((line) => {
  const label = line.trim().replace(/^→\s*/, '')
  return label === name || label.startsWith(`${name}（`)
}) ?? false
if (!agentsStage || !buildStage || agentsStage !== buildStage) {
  errors.push(`当前阶段不一致：AGENTS.md=${agentsStage ?? '缺失'}；docs/build.md=${buildStage ?? '缺失'}`)
}
if (buildStage) {
  const stageName = buildStage.replace(/[。.!！\s]+$/u, '')
  const sections = [...build.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1])
  if (!sections.includes(stageName)) errors.push(`docs/build.md: 缺少当前阶段节「## ${stageName}」`)
  if (!inOrder(stageName)) {
    errors.push(`docs/build.md: 当前阶段「${stageName}」未列入依赖顺序代码块`)
  }
}
const matrixSection = build.split(/^## 对象 × 阶段\s*$/m)[1]?.split(/^## /m)[0]
const currentRows = matrixSection?.split('\n').filter((line) => line.startsWith('|') && line.includes('**当前**')) ?? []
if (currentRows.length !== 1) errors.push(`docs/build.md: 对象矩阵须恰有一个「当前」行，实际 ${currentRows.length} 行`)
// 矩阵按代码地盘切，行名不必都是阶段名；但「当前」那一行必须能在依赖顺序里找到，
// 否则当前阶段会指向一个路标里不存在的对象。
const currentObject = currentRows[0]?.split('|')[1]?.trim()
if (currentObject && !inOrder(currentObject)) {
  errors.push(`docs/build.md: 对象矩阵「当前」行「${currentObject}」未列入依赖顺序代码块`)
}
const matrixRows = matrixSection?.split(/\r?\n/).filter((line) => /^\|[^-]/.test(line)).slice(1) ?? []
if (matrixRows.length === 0) errors.push('docs/build.md: 对象矩阵缺少阶段状态行')
for (const row of matrixRows) {
  const [object, , status] = row.split('|').slice(1).map((cell) => cell.trim())
  if (!['**已交**', '**当前**', '**未开**'].includes(status)) {
    errors.push(`docs/build.md: 对象「${object}」的阶段状态无效：${status ?? '缺失'}`)
  }
}
const handoffs = build.split(/^### 跨能力交接\s*$/m)[1]?.split(/^#{2,3}\s/m)[0]
const handoffRows = handoffs?.split(/\r?\n/).filter((line) => /^\|[^-]/.test(line)).slice(1) ?? []
if (handoffRows.length === 0) errors.push('docs/build.md: 跨能力交接表缺少阶段行')
for (const row of handoffRows) {
  const stage = row.split('|')[1]?.trim()
  if (stage && !inOrder(stage)) errors.push(`docs/build.md: 交接表阶段「${stage}」未列入依赖顺序代码块`)
}
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`文档检查通过：${files.length} 个文件，当前阶段「${buildStage}」。\n`)
}

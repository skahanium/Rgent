import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 四条机械规则（每条只判可判定的形态，不猜散文）：
 * 1. 链接与锚点：相对链接存在、同文件锚点、跨文件锚点；
 * 2. 阶段一致性：`AGENTS.md` 与 `docs/build.md` 的「当前阶段」同名、有同名节、在依赖顺序里，
 *    对象矩阵恰有一行「当前」且与当前阶段一致、矩阵状态只用既有词汇；
 * 3. 交付证据形态：本轮交付对照表的提交引用与四项证据状态、v2 交付证据须带日期或受验提交；
 * 4. 本轮新增：**提交号存在性**与**包表状态格**——
 *    - 提交号：正文里按本仓库惯例写成裸短号的十六进制号必须真的存在（`git cat-file -e <sha>^{commit}`）。
 *      判据只收「提交引用形态」，排除明确不是提交号的哈希（见下面规则 4a 的注释）；浅克隆无法
 *      区分「没取回」与「不存在」，此时只提示、不判错。
 *    - 包表状态格：核**当下有效包表**——标题含「本轮」「写类」或「结构工具」（或标题去括号后
 *      等于当前阶段名）的小节里、表头含「包」的表的**数据行**（表头行与分隔行不算）。末列
 *      （门／验收／证据列）**必须**以五个状态词之一加粗开头（`**已交**`／`**本机已交**`／
 *      `**未开**`／`**进行中**`／`**待核**`）；**缺失即报错**。以前写成「若以加粗词开头才校验」，
 *      于是**只有写了状态格才被检查**，漏写反而合法；写类包 0 与结构包表重复行也曾因此漏检。
 *    - 交付证据：同一批数据行里，`**已交**` 的末列**必须**含反引号提交号（7–40 位十六进制）
 *      或 `actions/runs/<id>` 链接之一；`**本机已交**` 是「本机已交、待推送」，不要求远端证据。
 *      历史表（`## 2026-*`、更早的施工图小节）不按本轮词汇要求，不在判据内。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', ...[
  'README.md', 'architecture.md', 'build.md', 'build-history.md', 'decisions.md', 'frontend.md', 'handbook.md',
  'opensource.md', 'topics.md', 'vision.md', 'memory.md'
].map((name) => `docs/${name}`)]
const errors = []
const notices = []

/** 只消费独占行的围栏；行内代码中的三个反引号不是围栏起点。兼容 CRLF。 */
function stripFencedCode(source) {
  return source.replace(/^ {0,3}```[^\r\n]*\r?\n[\s\S]*?^ {0,3}```[ \t]*\r?$/gm, '')
}

/** 同上，但保留行号：围栏内的字符换成空格，报告的行号才对得上原文。 */
function blankFencedCode(source) {
  return source.replace(/^ {0,3}```[^\r\n]*\r?\n[\s\S]*?^ {0,3}```[ \t]*\r?$/gm, (block) => block.replace(/[^\r\n]/g, ' '))
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
    if (!target) {
      // 同文件锚点也要核：标题一改就会悄悄失效，以前这里直接跳过。
      if (hash && file.endsWith('.md') && !anchorsOf(source).has(decodeURIComponent(hash).toLowerCase())) {
        errors.push(`${file}: 锚点不存在：${match[1]}`)
      }
      continue
    }
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
if (buildStage && currentObject !== buildStage.replace(/[。.!！\s]+$/u, '')) {
  errors.push(`docs/build.md: 当前阶段与矩阵当前行不一致：${buildStage}／${currentObject ?? '缺失'}`)
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
// 只核提交引用的明确形态和状态字段；是否已有平台证据仍由人核对。
const delivery = build.split(/^### 本轮交付对照\s*$/m)[1]?.split(/^#{2,3}\s/m)[0]
const deliveryRows = delivery?.split(/\r?\n/).filter((line) => /^\|[^-]/.test(line)).slice(1) ?? []
if (deliveryRows.length === 0) errors.push('docs/build.md: 交付对照表缺少施工包')
const evidenceStates = new Set(['通过', '失败', '待核', '未运行', '不适用'])
const commitReference = /^`[a-f\d]{7,40}`(?:[、, ]+`[a-f\d]{7,40}`)*$/
for (const row of deliveryRows) {
  const cells = row.split('|').slice(1, -1).map((cell) => cell.trim())
  const [work, commit, ...states] = cells
  if (cells.length !== 6 || !work) {
    errors.push('docs/build.md: 交付对照行必须有施工包、提交和四项证据状态')
    continue
  }
  if (commit !== '待提交' && !commitReference.test(commit)) {
    errors.push(`docs/build.md: 交付对照提交引用无效：${work}／${commit}`)
  }
  if (states.some((state) => !evidenceStates.has(state))) {
    errors.push(`docs/build.md: 交付对照证据状态无效：${work}／${states.join('、')}`)
  }
}

// v2 当前交付字段必须指向日期或受验提交；不据此推断产品语义正确。
const currentV2 = build.split(/^### 2026-10-03 账本上下文与记忆重构\s*$/m)[1]?.split(/^### /m)[0]
if (currentV2) for (const row of currentV2.split(/\r?\n/).filter(line=>/^\| [0-5] /.test(line))) {
  const evidence = row.split('|').at(-2) ?? ''
  if (!/20\d{2}-\d{2}-\d{2}|`[a-f\d]{7,40}`/.test(evidence)) errors.push('docs/build.md: v2 交付证据缺少日期或受验提交')
  if (/通过/.test(evidence) && !/`[a-f\d]{7,40}`|待提交/.test(evidence)) errors.push('docs/build.md: v2 代码通过证据必须标记受验提交或待提交')
}

// 规则 4a：提交号存在性。只有「提交引用形态」才核，判据如下（每一条都有既有文档为证，改动前先看标定）：
//   · 裸十六进制 7–40 位，两侧不与字母数字相邻（不切长标识符，`baseline83c700b` 不是提交号）；
//   · 排除：纯数字、链接目标（URL／路径）里的片段、明确截断的前缀（代码跨度内含 `…`／`...`）、
//     连字符连接的十六进制组（UUID 片段）、紧跟 `@版本`（记忆条目版本引用）、
//     紧邻对象种类标签（`tree`／`树`／`条目`／`事实`／`entry`／`uuid`）的哈希；
//   · 9 位以上只核显式提交声明形态（`**`sha`**`）与紧跟在「受验／执行提交／提交」之后的号——
//     长号在正文里绝大多数是冻结、评分与产物哈希（sha256 前缀），不是提交。
// 浅克隆只能看见一部分历史，报错会把「没取回」说成「不存在」，故那时只提示。
const KIND_LABELS = ['条目', '事实', 'entry', 'uuid', 'UUID']
const COMMIT_WORDS = ['受验', '执行提交', '提交']
const gitAvailable = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).status === 0
const shallowClone = gitAvailable
  && spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).stdout.trim() === 'true'
const commitExists = (() => {
  const cache = new Map()
  return (sha) => {
    if (!cache.has(sha)) {
      cache.set(sha, spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0)
    }
    return cache.get(sha)
  }
})()
let checkedCommits = 0
const missingCommits = []
if (gitAvailable) {
  for (const file of files) {
    const lines = blankFencedCode(readFileSync(path.join(root, file), 'utf8')).split(/\r?\n/)
    lines.forEach((raw, index) => {
      // 链接目标先抹掉：URL 与绝对路径里的十六进制片段不是提交号引用。
      const line = raw.replace(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g, (match, target) => match.replace(target, ' '.repeat(target.length)))
      const spans = [...line.matchAll(/`([^`\n]*)`/g)].map((match) => ({ text: match[1], start: match.index, end: match.index + match[0].length }))
      for (const match of line.matchAll(/(?<![0-9A-Za-z])([0-9a-f]{7,40})(?![0-9A-Za-z])/g)) {
        const sha = match[1]
        if (/^\d+$/.test(sha)) continue
        const before = line.slice(0, match.index)
        const after = line.slice(match.index + sha.length)
        if (!/`[^`]*$/.test(before) || !/^[^`]*`/.test(after)) continue
        const span = spans.find((item) => item.start < match.index && item.end > match.index + sha.length)
        if (!span || /…|\.\.\./.test(span.text)) continue
        if (/[0-9a-f]-[0-9a-f]/.test(line.slice(Math.max(0, match.index - 2), match.index + sha.length + 2))) continue
        if (/^@\d/.test(after)) continue
        const spanContext = line.slice(Math.max(0, span.start - 8), span.start)
        if (/(tree|树)/.test(spanContext)) continue
        if (KIND_LABELS.some((label) => spanContext.includes(label))) continue
        const declared = line.includes(`**\`${sha}\`**`) || COMMIT_WORDS.some((word) => before.slice(-12).includes(word))
        if (sha.length > 8 && !declared) continue
        checkedCommits += 1
        if (!commitExists(sha)) {
          missingCommits.push(`${file}:${index + 1}: 提交号在仓库里不存在：\`${sha}\``)
        }
      }
    })
  }
  if (shallowClone) {
    if (missingCommits.length > 0) {
      notices.push(`浅克隆里 ${missingCommits.length} 个提交号无法确认（缺完整历史），本次按提示处理：${missingCommits[0]}`)
    }
  } else {
    errors.push(...missingCommits)
  }
} else {
  notices.push('未找到 git 工作树，提交号存在性检查跳过（需要在完整克隆里跑才有效）')
}

// 规则 4b：当下有效包表状态格。核标题含「本轮」「写类」或「结构工具」（或标题去括号后等于
// 当前阶段名）的小节里，表头含「包」的表（`| 包 |`／`| # | 包 |`…）的**数据行**；末列必须以
// 五个状态词之一加粗开头，**缺失即报错**。历史表（`## 2026-*`、更早小节）不按本轮词汇要求。
// 规则 4c：同一批数据行里，`**已交**` 的末列必须含反引号提交号或 `actions/runs/<id>` 链接；
// `**本机已交**` 明说还没推送，不要求远端证据。
const PACKAGE_STATES = new Set(['已交', '本机已交', '未开', '进行中', '待核'])
const EVIDENCE_PATTERN = /`[a-f\d]{7,40}`|actions\/runs\/\d+/
const STATE_WORDS = [...PACKAGE_STATES].map((s) => `**${s}**`).join('／')
const CURRENT_SECTION = /本轮|写类|结构工具/
/** 标题去掉尾部括号（全角／半角）后的主名，用来认「当前阶段」那一节。 */
const headingBase = (text) => text.replace(/[（(][^（()）]*[)）]\s*$/u, '').trim()
let checkedStatusCells = 0
{
  const lines = blankFencedCode(build).split(/\r?\n/)
  const stageBase = buildStage?.replace(/[。.!！\s]+$/u, '') ?? null
  let scoped = false
  let header = null
  for (const [index, line] of lines.entries()) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const text = heading[1]
      // 当下有效包表怎么认：标题带「本轮」「写类」「结构工具」，或去括号后就是当前阶段名。
      scoped = CURRENT_SECTION.test(text) || (stageBase !== null && headingBase(text) === stageBase)
      header = null
      continue
    }
    if (!line.startsWith('|')) { header = null; continue }
    if (/^\|[\s:|-]+\|$/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (header === null) { header = cells; continue }
    if (!scoped || !header.includes('包')) continue
    checkedStatusCells += 1
    const last = cells.at(-1) ?? ''
    const state = /^\*\*([^*]+)\*\*/.exec(last)?.[1]
    if (state === undefined) {
      errors.push(`docs/build.md:${index + 1}: 本轮包表（表头含「包」）的数据行末列必须以状态词开头（${STATE_WORDS}），本行缺失`)
    } else if (!PACKAGE_STATES.has(state)) {
      errors.push(`docs/build.md:${index + 1}: 包表状态格「**${state}**」不在既有词汇内（${STATE_WORDS}）`)
    } else if (state === '已交' && !EVIDENCE_PATTERN.test(last)) {
      errors.push(`docs/build.md:${index + 1}: 「已交」行末列缺少证据：须含反引号提交号或 actions/runs/<id> 链接（「本机已交」不要求）`)
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  for (const notice of notices) process.stderr.write(`${notice}\n`)
  process.stdout.write(`文档检查通过：${files.length} 个文件，当前阶段「${buildStage}」；四条机械规则：链接与锚点／阶段一致性／交付证据形态／提交号存在性（核 ${checkedCommits} 个）＋本轮包表状态格（核 ${checkedStatusCells} 个：缺失、超出五个词或「已交」缺提交号／run 链接即报错）。\n`)
}

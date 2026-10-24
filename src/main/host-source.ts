import { encodeLedgerProvenance, type LedgerProvenance } from './ledger-provenance.ts'
import { compile, compileFragment, composeSource, markerLine, parseMarker, partitionSource } from '../markdown/index.ts'
import type { CompileResult, SourceRange } from '../markdown/types.ts'
import { assertLedgerPreserved, LEDGER_ANCHOR } from '../markdown/partition.ts'

/** 草稿块升级：`range`、`expectedText`、`promptText` 都只指提问正文，不含 marker；`/` 只是普通正文。 */
export interface PromptWrite {
  taskId: string
  range: SourceRange
  expectedText: string
  promptText: string
}

export interface AnswerWrite {
  taskId: string
  answer: string
  /** Last answer successfully written by this task; rejects external edits to owned blocks. */
  expectedPreviousAnswer?: string
}

/** Exact derived history sent in one model request. Duplicate dispatches remain separate. */
export type SentSummary = {
  step: number
  text: string
  sourceChapterIds: string[]
  generators: import('./summary-cache.ts').SummaryGenerator[]
  dependencies: {sourceId:string;hash:string;provenance?:LedgerProvenance}[]
}

/** 一次联网只读外发的审计条目：只进账本记录，不进笔记正文，也不含正文。
 *  `fetch` 记主机与去查询串的路径；`search` 的 path 为空，另记截断到 120 字的查询；
 *  `mcp` 的 path 为空，另记服务器名与工具名（参数与结果都不进账本）。 */
export type LedgerNetworkEntry = {
  at: string
  action: 'fetch' | 'search' | 'mcp'
  host: string
  /** pathname（去查询串），最长 120 字；搜索与 MCP 用空串。 */
  path: string
  /** 只对 search 出现：查询截断到 120 字。 */
  query?: string
  /** 仅搜索成功：结果条数（1–10）。 */
  count?: number
  /** 仅 mcp：本场白名单里的服务器名与工具名。 */
  server?: string
  tool?: string
  bytes?: number
  truncated?: boolean
  outcome: string
}

export interface LedgerChapterWrite {
  failure?: import('../shared/task-failure.ts').TaskFailure
  material?:import('./host-material.ts').SentTaskMaterial
  metrics?:{step:number;estimatedInput:number;actualInput:number|null;actualOutput:number|null}[]
  sentSummaries?: SentSummary[]
  summaryGenerators?:import('./summary-cache.ts').SummaryGenerator[]
  taskId: string
  startedAt: string
  status: 'completed' | 'cancelled' | 'failed' | 'limit'
  prompt: string
  /** 只进正文的可见回答；推理不在其中。 */
  answer: string
  reason?: string
  provenance?: LedgerProvenance
  /** 本场外发记录：主机、去查询串的路径、MCP 的服务器／工具名、字节数、是否截断、结果。 */
  network?: readonly LedgerNetworkEntry[]
  /** 模型自述思考。只进账本的「推理」，不进正文；超长时截断。 */
  reasoning?: string
  /** 按发生顺序的一句话过程：模型步、工具调用与结果、收尾。 */
  trace?: readonly string[]
  /** 该场助手习惯的一行摘要（已应用时）。 */
  assistant?: string
}

/** 账本里的推理保留上限；超出只留开头并标注截断。 */
export const MAX_LEDGER_REASONING = 8000

function boundedReasoning(text: string): string {
  const flat = text.replace(/\r\n|\r/g, '\n')
  return flat.length > MAX_LEDGER_REASONING ? `${flat.slice(0, MAX_LEDGER_REASONING)}\n…（推理已截断）` : flat
}

function taskKey(taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new Error('无效任务 ID')
  return taskId
}

function lineEnding(source: string): string {
  return source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
}

function lineStart(source: string, pos: number): number {
  const start = Math.max(source.lastIndexOf('\n', pos - 1), source.lastIndexOf('\r', pos - 1)) + 1
  return start === 0 && source.startsWith('\ufeff') ? 1 : start
}

function markerTaskId(source: string, range: SourceRange): string | null {
  return parseMarker(source.slice(range.start, range.end))?.attrs['task-id'] ?? null
}

/** 追加块（part=append）不是「本次回答」：最终保存不得把它当成要替换的答案块。 */
function isAppendMarker(source: string, range: SourceRange): boolean {
  return parseMarker(source.slice(range.start, range.end))?.attrs['part'] === 'append'
}

function escapedModelText(text: string): string {
  // 累积流每次重投影：即使还没有 rgent 名称或闭合符，也不能让注释吞进后文。
  return text.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;')
}

/**
 * 提问块的两种拒绝：结构不对（不是带草稿 marker 的单个顶层段落）与正文不安全
 * （含注释定界符）。都必须在写盘前整件拒绝，不能留下半截 marker。
 */
const PROMPT_BLOCK_INVALID = 'PROMPT_BLOCK_INVALID'
const PROMPT_UNSAFE = 'PROMPT_UNSAFE'

/** 草稿 marker 与正文之间只允许一个换行：空行属于空草稿，不是可发送的提问。 */
function adjacentDraftMarker(source: string, compiled: CompileResult, start: number): SourceRange | null {
  const marker = compiled.index.markers.find((item) =>
    item.identity === 'command' &&
    item.range.end < start &&
    /^(?:\r\n|\r|\n)$/.test(source.slice(item.range.end, start)))
  if (!marker) return null
  const parsed = parseMarker(source.slice(marker.range.start, marker.range.end))
  if (!parsed || parsed.identity !== 'command') return null
  if (parsed.attrs.state !== 'draft' || 'task-id' in parsed.attrs) return null
  return marker.range
}

/**
 * 把草稿块升级成已发送的口令块：只换 marker 行，正文、空白与换行风格逐字保留。
 * 旧 `/…` 触发路径已退役；`/` 开头的正文不再被当成口令。
 */
export function markPrompt(source: string, write: PromptWrite): string {
  const taskId = taskKey(write.taskId)
  const part = partitionSource(source)
  const { start, end } = write.range
  if (start < 0 || end > part.body.length || end <= start || source.slice(start, end) !== write.expectedText) {
    throw new Error(PROMPT_BLOCK_INVALID)
  }
  if (write.expectedText !== write.promptText) throw new Error(PROMPT_BLOCK_INVALID)
  if (!write.promptText.trim()) throw new Error(PROMPT_BLOCK_INVALID)
  if (write.promptText.includes('<!--') || write.promptText.includes('-->')) throw new Error(PROMPT_UNSAFE)
  if (start !== lineStart(source, start)) throw new Error(PROMPT_BLOCK_INVALID)
  const compiled = compile(source)
  if (compiled.stale) throw new Error(PROMPT_BLOCK_INVALID)
  const block = compiled.index.blocks.find((item) => item.range.start === start && item.range.end === end)
  // 身份必须是 command，且来自紧邻上方的草稿 marker；普通段落、标题、列表、引用都不行。
  if (!block || block.type !== 'paragraph' || block.identity !== 'command') throw new Error(PROMPT_BLOCK_INVALID)
  const markerRange = adjacentDraftMarker(source, compiled, start)
  if (!markerRange) throw new Error(PROMPT_BLOCK_INVALID)
  if (compiled.index.markers.some((item) => markerTaskId(source, item.range) === taskId)) throw new Error(PROMPT_BLOCK_INVALID)
  const marker = markerLine('command', { 'task-id': taskId })
  // 纯字符串替换：marker 行以外一个字节都不动，换行风格也不改写。
  return source.slice(0, markerRange.start) + marker + source.slice(markerRange.end)
}

/** 尾部 HTML 块与后文之间只能由空行分隔；这段空白属于本任务的答案范围。 */
function endOfBlankLines(source: string, from: number): number {
  let end = from
  for (;;) {
    const match = /^[ \t]*(?:\r\n|\r|\n)/.exec(source.slice(end))
    if (!match) return end
    end += match[0].length
  }
}

/** Host 自己插入的块尾空白不算外部改写；它只是模型块与后文之间的分隔。 */
function withoutTrailingBlankLines(text: string): string {
  return text.replace(/(?:[ \t]*(?:\r\n|\r|\n))+$/, '')
}

function locatedPrompt(source: string, taskId: string): { blockEnd: number; firstAnswer: number | null; answerEnd: number | null } {
  const compiled = compile(source)
  if (compiled.stale) throw new Error('无法解析笔记')
  const marker = compiled.index.markers.find((item) => item.identity === 'command' && markerTaskId(source, item.range) === taskId)
  if (!marker) throw new Error('找不到这次任务的口令')
  const blocks = compiled.index.blocks
  const promptAt = blocks.findIndex((block) => block.range.start > marker.range.end && block.identity === 'command')
  if (promptAt < 0) throw new Error('任务口令标记未关联正文块')
  const prompt = blocks[promptAt]!
  const nextMarker = compiled.index.markers.find((item) => item.range.start > marker.range.start && item.range.start < prompt.range.start)
  if (nextMarker) throw new Error('任务口令标记被覆盖')
  let firstAnswer: number | null = null
  let answerEnd: number | null = null
  let lastAnswerType: string | null = null
  for (let at = promptAt + 1; at < blocks.length; at += 1) {
    const block = blocks[at]!
    const preceding = blocks[at - 1]!
    const between = compiled.index.markers.filter((item) =>
      item.range.start >= preceding.range.end && item.range.end <= block.range.start)
    const own = between.at(-1)
    if (between.length !== 1 || own?.identity !== 'ai' || markerTaskId(source, own.range) !== taskId || isAppendMarker(source, own.range)) break
    if (firstAnswer == null) firstAnswer = lineStart(source, own.range.start)
    answerEnd = block.range.end
    lastAnswerType = block.type
  }
  // HTML 块以空行结束：分隔空行是 Host 自己补的，必须跟着答案范围一起被替换。
  if (answerEnd !== null && lastAnswerType === 'html') answerEnd = endOfBlankLines(source, answerEnd)
  return { blockEnd: prompt.range.end, firstAnswer, answerEnd }
}

/** Replace only AI blocks tagged with this task ID in freshly read source. */
function renderedAnswer(taskId: string, input: string, newline: string): string {
  return renderedAiBlocks(taskId, input, newline)
}

/** 每个顶层块一枚标记；模型注释先逃逸。补路径带 part=append，避免被最终回答替换。 */
function renderedAiBlocks(taskId: string, input: string, newline: string, attrs: Record<string, string> = {}): string {
  let answer = escapedModelText(input.replace(/\r\n|\r/g, '\n'))
  let parsed = compileFragment(answer)
  if (parsed.stale) throw new Error('无法解析模型回答')
  const last = parsed.index.blocks.at(-1)
  if (last?.type === 'code') {
    const raw = answer.slice(last.range.start, last.range.end)
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(raw.split('\n')[0] ?? '')?.[1]
    if (opening) {
      const closing = raw.trimEnd().split('\n').at(-1) ?? ''
      const closePattern = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`)
      if (!closePattern.test(closing)) {
        // A partial stream must not turn subsequent human prose into this AI code block.
        answer += `\n${opening[0]!.repeat(opening.length)}`
        parsed = compileFragment(answer)
        if (parsed.stale) throw new Error('无法隔离未完代码块')
      }
    }
  }
  const rendered = parsed.index.blocks.map((block) =>
    `${markerLine('ai', { 'task-id': taskId, ...attrs })}${newline}${answer.slice(block.range.start, block.range.end).replace(/\r\n|\r/g, '\n').replace(/\n/g, newline)}`
  ).join(newline + newline)
  // CommonMark 的 HTML 块以空行结束，不以闭合标签结束：紧贴其后的账本锚点或人写段落
  // 都会并进同一个块（`</table>` 结尾也一样）。这里补出分隔空行，让边界重新成立。
  // 人的写盘仍由 assertLedgerPreserved 拒绝，不在这里替他补。
  return parsed.index.blocks.at(-1)?.type === 'html' ? rendered + newline + newline : rendered
}

/** 追加 AI 块：只往正文末尾加，不改已有块、不动人写文本，也不碰账本分区。
 *  写入门会独立核「新内容 = 原文 + 与块数对得上的 AI 标记」，这里只负责产出守约的内容。 */
export function appendAiBlock(source: string, write: { taskId: string; text: string }): string {
  const taskId = taskKey(write.taskId)
  const newline = lineEnding(source)
  // part=append 让最终回答保存不会把追加块当成「本次回答」而替换掉它。
  const rendered = renderedAiBlocks(taskId, write.text, newline, { part: 'append' })
  const body = source.replace(/[\s\n]*$/u, '')
  const separator = body.length === 0 ? '' : newline + newline
  return `${body}${separator}${rendered}${newline}${newline}`
}

export function upsertAiAnswer(source: string, write: AnswerWrite): string {
  const taskId = taskKey(write.taskId)
  const part = partitionSource(source)
  const where = locatedPrompt(source, taskId)
  const newline = lineEnding(source)
  if (write.expectedPreviousAnswer !== undefined) {
    const expected = renderedAnswer(taskId, write.expectedPreviousAnswer, newline)
    const actual = where.firstAnswer === null ? '' : source.slice(where.firstAnswer, where.answerEnd ?? where.firstAnswer)
    if (withoutTrailingBlankLines(actual) !== withoutTrailingBlankLines(expected)) throw new Error('AI_BLOCK_CHANGED')
  }
  const rendered = renderedAnswer(taskId, write.answer, newline)
  const start = where.firstAnswer ?? where.blockEnd
  const end = where.answerEnd ?? where.blockEnd
  const insert = where.firstAnswer == null && rendered ? newline + newline + rendered : rendered
  // Independent ledgers no longer contribute the trailing separator: leave a human paragraph at EOF.
  const trailing=end===part.body.length&&rendered&&!rendered.endsWith(newline+newline)?newline+newline:''
  const body = source.slice(0, start) + insert + trailing + source.slice(end, part.body.length)
  return composeSource(body, part.ledger)
}

/** Append the final, read-only record once. Existing ledger bytes are never rewritten. */
export function appendLedgerChapter(source: string, write: LedgerChapterWrite): string {
  const taskId = taskKey(write.taskId)
  const part = partitionSource(source)
  if (part.ledger && new RegExp(`^<!-- rgent:ledger-task:v1 id="${taskId}"(?: sources="v[12]")? -->\\r?$`, 'm').test(part.ledger)) return source
  const newline = lineEnding(source)
  const prelude = part.ledger ?? `${/[\r\n]$/.test(part.body) || !part.body ? '' : newline}<!-- rgent:ledger:v1 -->${newline}`
  const boundary = prelude.endsWith(newline + newline) ? '' : prelude.endsWith(newline) ? newline : newline + newline
  const lines = [
    `<!-- rgent:ledger-task:v1 id="${taskId}"${write.provenance ? ` sources="v${write.provenance.version}"` : ''} -->`,
    ...(write.provenance ? [encodeLedgerProvenance(write.provenance)] : []),
    `## ${write.startedAt} · ${write.status}`,
    '',
    '### 口令',
    '',
    escapedModelText(write.prompt).replace(/\r\n|\r/g, '\n'),
    '',
    '### 回答',
    '',
    escapedModelText(write.answer).replace(/\r\n|\r/g, '\n') || '（无输出）',
    '',
    '### 工具摘要',
    '',
    write.provenance?.tools.length ? write.provenance.tools.map(tool => `${escapedModelText(tool.name === 'read_library' ? '读库' : tool.name === 'search_library' ? '搜库' : tool.name==='search_memory'?'检索记忆':tool.name)}：${escapedModelText(tool.outcome)}`).join('；') : '无工具',
    ...(write.trace?.length ? ['', '### 过程', '', ...write.trace.map(line => escapedModelText(line))] : []),
    ...(write.reasoning?.trim() ? ['', '### 推理', '', escapedModelText(boundedReasoning(write.reasoning))] : []),
    ...(write.provenance ? ['', `模型：${escapedModelText(write.provenance.model.provider)} / ${escapedModelText(write.provenance.model.modelId)}（${escapedModelText(write.provenance.model.endpointHost)}）`, `授权范围：${escapedModelText(write.provenance.scope.join('、'))}`, `实际读取来源：${escapedModelText(write.provenance.sources.map(source => source.relPath).join('、')) || '仅发起篇'}`, `模型消息引用来源：${escapedModelText((write.provenance.sentSources ?? write.provenance.sources.map(source => source.relPath)).join('、')) || '仅发起篇'}`] : []),
    ...(write.provenance?.version === 2 ? ['', `记忆使用：${write.provenance.memoryDeps.map(dep => `${dep.id}@${dep.version}（${dep.sourceDeps.map(s => `${escapedModelText(s.relPath)} / ${s.kind}${s.taskId ? ` / ${s.taskId}` : ''}`).join('、')}）`).join('；') || '无'}`] : []),
    // 习惯摘要不依赖 provenance：没有授权记录的最小环也要能核对用了什么人格
    ...(write.assistant ? [`助手习惯：已应用（${escapedModelText(write.assistant)}）`] : []),
    ...(write.reason ? ['', `中止原因：${escapedModelText(write.reason)}`] : []),
    ''
  ]
  const chapter = lines.join('\n').replace(/\n/g, newline)
  const result = part.ledger ? part.body + part.ledger + boundary + chapter : part.body + prelude + boundary + chapter
  assertLedgerPreserved(result, part.ledger ?? LEDGER_ANCHOR)
  return result
}

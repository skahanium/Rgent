import { createHash, randomUUID } from 'node:crypto'
import { compile, parseMarker } from '../markdown/index.ts'
import type { CompileResult } from '../markdown/types.ts'
import type { NoteSnapshot } from '../shared/ipc.ts'
import type { TaskGrant } from './task-authorization.ts'
import { blankMarkers, folderOf, searchDocuments, searchSnippetRange } from './vault-index.ts'
import { bodyFingerprint, historicalContextPolicy, ledgerProvenance, type LedgerSource } from './ledger-provenance.ts'
import { ledgerChapters, type ContextSourceRef } from './host-context.ts'

export const READ_ONLY_TOOL_SCHEMAS = {
  read_library: { description: '列出本场获准笔记；使用返回的 sourceId 分页读取正文块。账本与附件不可读，nextCursor 用于续读。', inputSchema: { type: 'object', properties: { sourceId: { type: 'string', maxLength: 256 }, cursor: { type: 'string', maxLength: 256 } }, additionalProperties: false } },
  search_library: { description: '仅搜索本场获准笔记标题和正文，返回来源及命中片段；结果有分页和省略说明。', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 512 }, cursor: { type: 'string', maxLength: 256 } }, required: ['query'], additionalProperties: false } }
} as const

export interface ScopedAgentTools {
  contextPolicy(source: string, signal: AbortSignal): Promise<{ allowedLedgerChapterIds: string[]; excludedAiTaskIds: string[] }>
  execute(name: string, input: unknown, signal: AbortSignal): Promise<unknown>
  assertCurrent(signal: AbortSignal): Promise<void>
  dependencies(): LedgerSource[]
  summary(): { name: string; outcome: string }[]
  recordContext(refs: readonly ContextSourceRef[]): void
  markSent(): void
  sentSources(): string[]
}
type Dependencies = {
  read(path: string): Promise<NoteSnapshot>
  tier(root: string, path: string): Promise<'reference' | 'follow'>
  acceptsObject(path: string, expected: string, current: string): boolean
}
type Policy = { allowedLedgerChapterIds: string[]; excludedAiTaskIds: string[]; byChapter: Map<string, LedgerSource[]>; byTask: Map<string, LedgerSource[]> }
type Loaded = { path: string; snapshot: NoteSnapshot; parsed: CompileResult; body: string; policy: Policy; proof: LedgerSource }
type Cursor = { kind: 'list' | 'read' | 'search'; sourceId?: string; query?: string; stamp: string; index: number; offset: number }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
function active(signal: AbortSignal): void { if (signal.aborted) throw Error('TASK_CANCELLED') }
function awaiting<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  active(signal)
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('TASK_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(Error('TASK_CANCELLED')); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
function args(value: unknown, required: string[], optional: string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_TOOL_ARGUMENTS')
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => ![...required, ...optional].includes(key)) || required.some(key => !(key in object))) throw Error('INVALID_TOOL_ARGUMENTS')
  for (const [key, v] of Object.entries(object)) if (typeof v !== 'string' || !v.trim() || v.length > (key === 'query' ? 512 : 256)) throw Error('INVALID_TOOL_ARGUMENTS')
  return object as Record<string, string>
}
/** Only receives a fixed, main-process grant; it never sees the human global index. */
export function createScopedAgentTools(grant: TaskGrant, _taskId: string, deps: Dependencies): ScopedAgentTools {
  const sources = new Map(grant.sources.map(source => [source.relPath, source]))
  const ids = new Map(grant.sources.map(source => [source.sourceId, source.relPath]))
  const reads = new Map<string, LedgerSource>()
  const staged = new Set<string>()
  const sent = new Set<string>()
  const outcomes = new Map<string, number>()
  const cursors = new Map<string, Cursor>()
  const limit = Math.max(1024, Math.min(8192, Math.floor(grant.credential.contextTokens / 4)))
  let originPolicy: Policy | undefined
  let originParsed: CompileResult | undefined

  async function check(signal: AbortSignal): Promise<void> {
    active(signal)
    await awaiting(grant.validateSources(signal), signal)
    for (const dependency of reads.values()) {
      if (!(await dependencyValid(dependency, signal))) { grant.revoke(); throw Error('SOURCE_CHANGED') }
    }
    active(signal)
  }
  async function snapshot(path: string, signal: AbortSignal): Promise<NoteSnapshot> {
    active(signal)
    const approved = sources.get(path)
    if (!approved) throw Error('OUTSIDE_TASK_SCOPE')
    const tier = await awaiting(deps.tier(grant.root, path), signal)
    const current = await awaiting(deps.read(path), signal)
    const after = await awaiting(deps.tier(grant.root, path), signal)
    if (tier !== approved.tier || after !== approved.tier) throw Error('SOURCE_PERMISSION_CHANGED')
    if (current.sessionId !== grant.sessionId) throw Error('VAULT_CHANGED')
    if (path !== grant.origin) {
      if (current.objectVersion !== approved.objectVersion && !deps.acceptsObject(path, approved.objectVersion, current.objectVersion)) throw Error('SOURCE_REPLACED')
      if (current.revision !== approved.revision || hash(current.content) !== approved.fingerprint) throw Error('SOURCE_CHANGED')
    }
    return current
  }
  async function dependencyValid(dependency: LedgerSource, signal: AbortSignal): Promise<boolean> {
    active(signal)
    if (!sources.has(dependency.relPath) || dependency.relPath === grant.origin) return false
    try {
      const current = await snapshot(dependency.relPath, signal)
      return (current.objectVersion === dependency.objectVersion || deps.acceptsObject(dependency.relPath, dependency.objectVersion, current.objectVersion)) && bodyFingerprint(current.content) === dependency.bodyHash
    } catch (error) { active(signal); return false }
  }
  async function policy(source: string, signal: AbortSignal, parsed = compile(source)): Promise<Policy> {
    if (parsed.stale) throw Error('SOURCE_PARSE_FAILED')
    const chapters = ledgerChapters(parsed.partition.ledger)
    const result = await historicalContextPolicy(source, dep => dependencyValid(dep, signal), parsed, chapters)
    const byChapter = new Map<string, LedgerSource[]>()
    const byTask = new Map<string, LedgerSource[]>()
    for (const chapter of chapters) {
      if (!result.allowedLedgerChapterIds.includes(chapter.sourceId)) continue
      const record = ledgerProvenance(chapter.text)
      const dependencies = record.status === 'valid' ? record.record.sources : []
      byChapter.set(chapter.sourceId, dependencies)
      if (chapter.taskId) byTask.set(chapter.taskId, dependencies)
    }
    return { ...result, byChapter, byTask }
  }
  function taskOf(parsed: CompileResult, start: number): string | undefined {
    const marker = parsed.index.markers.filter(marker => marker.range.end <= start).at(-1)
    return marker && parseMarker(parsed.source.slice(marker.range.start, marker.range.end))?.attrs['task-id']
  }
  function excluded(parsed: CompileResult, p: Policy, start: number, identity?: string): boolean {
    const task = taskOf(parsed, start)
    return identity === 'ai' && (p.excludedAiTaskIds.includes('*') || !!task && p.excludedAiTaskIds.includes(task))
  }
  function remember(dependency: LedgerSource, outgoing: boolean): void {
    if (dependency.relPath === grant.origin) return
    const previous = reads.get(dependency.relPath)
    if (previous && (previous.objectVersion !== dependency.objectVersion || previous.bodyHash !== dependency.bodyHash)) throw Error('SOURCE_CHANGED')
    reads.set(dependency.relPath, { ...dependency })
    if (outgoing) staged.add(dependency.relPath)
  }
  async function load(path: string, signal: AbortSignal): Promise<Loaded> {
    const current = await snapshot(path, signal)
    const parsed = compile(current.content)
    if (parsed.stale) throw Error('SOURCE_PARSE_FAILED')
    const p = await policy(current.content, signal, parsed)
    let body = blankMarkers(parsed.partition.body, parsed.index.markers)
    for (const block of parsed.index.blocks) if (excluded(parsed, p, block.range.start, block.identity)) body = body.slice(0, block.range.start) + ' '.repeat(block.range.end - block.range.start) + body.slice(block.range.end)
    const proof = { relPath: path, objectVersion: current.objectVersion, bodyHash: bodyFingerprint(current.content, parsed) }
    return { path, snapshot: current, parsed, body, policy: p, proof }
  }
  function recordBody(item: Loaded, start?: number, end?: number): void {
    remember(item.proof, true)
    for (const block of item.parsed.index.blocks) {
      if (block.identity !== 'ai' || excluded(item.parsed, item.policy, block.range.start, block.identity)) continue
      if (start !== undefined && end !== undefined && (block.range.end <= start || block.range.start >= end)) continue
      const task = taskOf(item.parsed, block.range.start)
      for (const dep of task ? item.policy.byTask.get(task) ?? [] : []) remember(dep, true)
    }
  }
  function cursor(input: string | undefined, expected: Pick<Cursor, 'kind' | 'sourceId' | 'query' | 'stamp'>): Cursor {
    if (!input) return { ...expected, index: 0, offset: 0 }
    const value = cursors.get(input)
    if (!value || Object.entries(expected).some(([key, v]) => value[key as keyof Cursor] !== v)) throw Error('INVALID_TOOL_CURSOR')
    return { ...value }
  }
  function next(value: Cursor): string {
    const id = randomUUID()
    if (cursors.size >= 256) cursors.delete(cursors.keys().next().value!)
    cursors.set(id, value)
    return id
  }
  function base(items: unknown[], complete: boolean, nextCursor?: string, omitted = 0): Record<string, unknown> {
    return { items, complete, omitted, ...(nextCursor ? { nextCursor } : {}), notice: complete ? '已返回本次范围内全部结果；正文不含账本或未授权历史派生内容。' : '本页因预算省略后续内容；使用 nextCursor 续读，不代表完整原文。' }
  }
  async function list(input: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const approved = [...grant.sources]
    const state = cursor(input.cursor, { kind: 'list', stamp: hash(JSON.stringify(approved)) })
    const items: unknown[] = []
    let at = state.index
    const loaded: Loaded[] = []
    for (; at < approved.length; at++) {
      const source = approved[at]!
      const item = { sourceId: source.sourceId, relPath: source.relPath, title: source.title, fingerprint: source.fingerprint }
      if (bytes(base([...items, item], false, 'x'.repeat(36), approved.length)) > limit) break
      loaded.push(await load(source.relPath, signal)); items.push(item)
    }
    if (!items.length && at < approved.length) throw Error('SOURCE_METADATA_TOO_LARGE')
    await check(signal)
    for (const item of loaded) remember(item.proof, true)
    return base(items, at === approved.length, at < approved.length ? next({ ...state, index: at }) : undefined, approved.length - at)
  }
  async function read(input: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const path = ids.get(input.sourceId!)
    if (!path) throw Error('OUTSIDE_TASK_SCOPE')
    const item = await load(path, signal)
    const state = cursor(input.cursor, { kind: 'read', sourceId: input.sourceId, stamp: item.snapshot.revision })
    const blocks = item.parsed.index.blocks.filter(block => !excluded(item.parsed, item.policy, block.range.start, block.identity))
    const output: { block: number; from: number; to: number; text: string }[] = []
    let at = state.index; let offset = state.offset
    const wrap = (items: unknown[], complete = false) => ({ ...base(items, complete, complete ? undefined : 'x'.repeat(36), blocks.length - at), sourceId: input.sourceId, relPath: path, title: sources.get(path)!.title, fingerprint: item.proof.bodyHash })
    while (at < blocks.length) {
      const block = blocks[at]!
      const text = item.body.slice(block.range.start + offset, block.range.end)
      let lo = 0; let hi = text.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        const candidate = { block: at + 1, from: block.range.start + offset, to: block.range.start + offset + mid, text: text.slice(0, mid) }
        if (bytes(wrap([...output, candidate])) <= limit) lo = mid; else hi = mid - 1
      }
      // Never bisect an emoji surrogate pair at a page boundary.
      if (lo < text.length && lo > 0 && /[\uD800-\uDBFF]/.test(text[lo - 1]!)) lo--
      if (lo === 0 && text.length) { if (!output.length) throw Error('SOURCE_METADATA_TOO_LARGE'); break }
      output.push({ block: at + 1, from: block.range.start + offset, to: block.range.start + offset + lo, text: text.slice(0, lo) })
      offset += lo
      if (offset < block.range.end - block.range.start) break
      at++; offset = 0
    }
    await check(signal)
    remember(item.proof, false)
    for (const part of output) recordBody(item, part.from, part.to)
    const complete = at === blocks.length
    const result = { ...base(output, complete, complete ? undefined : next({ ...state, index: at, offset }), blocks.length - at), sourceId: input.sourceId, relPath: path, title: sources.get(path)!.title, fingerprint: item.proof.bodyHash }
    if (bytes(result) > limit) throw Error('TOOL_RESULT_LIMIT')
    return result
  }
  async function search(input: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const documents: Loaded[] = []
    for (const source of grant.sources) { active(signal); documents.push(await load(source.relPath, signal)) }
    const stamp = hash(documents.map(doc => `${doc.path}:${doc.snapshot.revision}`).join('\n'))
    const state = cursor(input.cursor, { kind: 'search', query: input.query, stamp })
    // Scope first. The human index is never called, even if thousands of outside hits exist.
    const hits = searchDocuments(documents.map(doc => ({ relPath: doc.path, folder: folderOf(doc.path), title: sources.get(doc.path)!.title, body: doc.body })), input.query!, grant.sources.length)
    const items: unknown[] = []
    let at = state.index
    for (; at < hits.length; at++) {
      const hit = hits[at]!
      const doc = documents.find(doc => doc.path === hit.relPath)!
      const item = { ...hit, sourceId: sources.get(hit.relPath)!.sourceId, fingerprint: doc.proof.bodyHash }
      if (bytes(base([...items, item], false, 'x'.repeat(36), hits.length)) > limit) break
      items.push(item)
    }
    if (!items.length && at < hits.length) throw Error('SOURCE_METADATA_TOO_LARGE')
    await check(signal)
    for (const doc of documents) remember(doc.proof, false)
    for (const hit of hits.slice(state.index, at)) {
      const doc = documents.find(doc => doc.path === hit.relPath)!
      const range = searchSnippetRange(doc.body, input.query!)
      if (range) recordBody(doc, range.start, range.end)
      else remember(doc.proof, true)
    }
    return base(items, at === hits.length, at < hits.length ? next({ ...state, index: at }) : undefined, hits.length - at)
  }
  return {
    async contextPolicy(source, signal) {
      active(signal); originParsed = compile(source); originPolicy = await policy(source, signal, originParsed); active(signal)
      return { allowedLedgerChapterIds: [...originPolicy.allowedLedgerChapterIds], excludedAiTaskIds: [...originPolicy.excludedAiTaskIds] }
    },
    async execute(name, input, signal) {
      const label = name === 'read_library' || name === 'search_library' ? name : 'unknown'
      let outcome = 'refused'
      try {
        active(signal)
        if (label === 'unknown') throw Error('UNKNOWN_TOOL')
        const request = args(input, name === 'search_library' ? ['query'] : [], name === 'search_library' ? ['cursor'] : ['sourceId', 'cursor'])
        await check(signal)
        // read_library 不带 sourceId 时是列表续页：列表分页只有 nextCursor，没有第二个工具名。
        // cursor 的 kind 校验保证两种游标不能互相复用，所以这个别名不扩大范围。
        const result = name === 'search_library' ? await search(request, signal) : request.sourceId ? await read(request, signal) : await list(request, signal)
        outcome = 'ok'; return result
      } finally { const key = `${label}\0${outcome}`; outcomes.set(key, (outcomes.get(key) ?? 0) + 1) }
    },
    assertCurrent: check,
    dependencies: () => [...reads.values()].map(dep => ({ ...dep })),
    summary: () => [...outcomes].map(([key, count]) => { const [name, outcome] = key.split('\0'); return { name: name!, outcome: `${outcome} (${count})` } }),
    recordContext(refs) {
      if (!originPolicy || !originParsed) return
      for (const ref of refs) {
        if (ref.kind === 'ledger' || ref.kind === 'summary') for (const id of ref.kind === 'summary' ? ref.sourceId.split(',') : [ref.sourceId]) for (const dep of originPolicy.byChapter.get(id) ?? []) remember(dep, true)
        else {
          const block = originParsed.index.blocks[Number(ref.sourceId.slice(5)) - 1]
          if (block?.identity === 'ai') { const task = taskOf(originParsed, block.range.start); for (const dep of task ? originPolicy.byTask.get(task) ?? [] : []) remember(dep, true) }
        }
      }
    },
    markSent() { for (const path of staged) sent.add(path) },
    sentSources: () => [...sent]
  }
}

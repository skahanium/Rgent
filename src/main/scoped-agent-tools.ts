import type { ContextChapter } from './host-context.ts'
import type { TaskMaterialTracker, MaterialDependencies } from './host-material.ts'
import { createHash, randomUUID } from 'node:crypto'
import { compile } from '../markdown/index.ts'
import type { CompileResult } from '../markdown/types.ts'
import type { NoteSnapshot } from '../shared/ipc.ts'
import type { TaskGrant } from './task-authorization.ts'
import { blankMarkers, folderOf, searchDocuments, searchSnippetRange } from './vault-index.ts'
import { bodyFingerprint, historicalContextPolicy, ledgerProvenance, chapterProvenance, type LedgerSource, type LedgerMemoryDependency } from './ledger-provenance.ts'
import { ledgerChapters, historicalBodyTasks, type ContextSourceRef } from './host-context.ts'

export const READ_ONLY_TOOL_SCHEMAS = {
  read_library: { description: '列出本场获准笔记；使用返回的 sourceId 分页读取正文块。账本与附件不可读，nextCursor 用于续读。', inputSchema: { type: 'object', properties: { sourceId: { type: 'string', maxLength: 256 }, cursor: { type: 'string', maxLength: 256 } }, additionalProperties: false } },
  search_library: { description: '仅搜索本场获准笔记标题和正文，返回来源及命中片段；结果有分页和省略说明。', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 512 }, cursor: { type: 'string', maxLength: 256 } }, required: ['query'], additionalProperties: false } }
} as const

/** 写类工具：补／建在仅发起篇也宣告；读搜与结构仍要范围内另有对象。 */
export const WRITE_TOOL_SCHEMAS = {
  append_to_note: {
    description: '只往本场发起篇正文末尾追加一个新块，用来补充依据或结论。不能改人写文本、不能动账本，也不能写别的笔记；超限会被拒。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 8192, description: '要追加的正文（纯文本或 Markdown）。' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  rename_note: {
    description: '给本场授权范围内的一篇笔记改名（不含正在写入的发起篇）。会先给人看预览，人点了同意才真的改；库里有引用会一并修好。',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: { type: 'string', minLength: 1, maxLength: 256, description: '要改名的笔记路径（本场来源清单里的 relPath）。' },
        newName: { type: 'string', minLength: 1, maxLength: 120, description: '新名字，不带路径与扩展名。' }
      },
      required: ['relPath', 'newName'],
      additionalProperties: false
    }
  },
  move_note: {
    description: '把本场授权范围内的一篇笔记挪到库里已有的某个目录（不含正在写入的发起篇）。文件名不变；会先给人看预览，人点了同意才真的挪。',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: { type: 'string', minLength: 1, maxLength: 256, description: '要移动的笔记路径（本场来源清单里的 relPath）。' },
        targetFolder: { type: 'string', maxLength: 256, description: '目标目录（相对库根；空字符串表示库根）。' }
      },
      required: ['relPath', 'targetFolder'],
      additionalProperties: false
    }
  },
  create_note: {
    description: '在发起篇所在目录新建一篇笔记，内容由你给出。落点不能选，重名会被拒；会先给人看预览，人点了同意才真的建。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120, description: '笔记名，不带路径与扩展名。' },
        body: { type: 'string', minLength: 1, maxLength: 32768, description: '新笔记的正文。' }
      },
      required: ['name', 'body'],
      additionalProperties: false
    }
  }
} as const

/** 宿主提供的写入能力：门在宿主侧构造，这里只调用并记账。
 *  create 只在宿主既有人确认、又能真的落盘时才出现。 */
export type StructuralOutcome = { ok: true; target: string; moved: number; linkChanges: number; permissionChanges: number } | { ok: false; reason: string }
export type ScopedWriteTool = {
  append(text: string, signal: AbortSignal): Promise<{ ok: true; revision: string; bytes: number } | { ok: false; reason: string }>
  create?(name: string, body: string, signal: AbortSignal): Promise<{ ok: true; revision: string; bytes: number; relPath: string; objectVersion?: string } | { ok: false; reason: string }>
  /** 结构操作（改名／挪）：要人确认与库层迁移两条都在才出现。 */
  rename?(relPath: string, newName: string, signal: AbortSignal): Promise<StructuralOutcome>
  move?(relPath: string, targetFolder: string, signal: AbortSignal): Promise<StructuralOutcome>
}

export interface ScopedAgentTools {
  /** 这套工具是否带写入能力；宿主据此决定要不要把写工具宣告给模型。 */
  writes?: boolean
  /** 是否带「建」的能力（需要人确认与落盘两条都在）。 */
  creates?: boolean
  /** 是否带结构操作（改名／挪）。 */
  renames?: boolean
  contextPolicy(source: string, signal: AbortSignal, chapters?: ContextChapter[]): Promise<{ allowedLedgerChapterIds: string[]; excludedAiTaskIds: string[] }>
  execute(name: string, input: unknown, signal: AbortSignal): Promise<unknown>
  assertCurrent(signal: AbortSignal): Promise<void>
  dependencies(): LedgerSource[]
  contextDependencies?(ref: ContextSourceRef): MaterialDependencies
  memoryDependencies?(): LedgerMemoryDependency[]
  summary(): { name: string; outcome: string }[]
  recordContext(refs: readonly ContextSourceRef[]): void
  markSent(includeTools?: boolean): void
  sentSources(): string[]
}
type Dependencies = {
  read(path: string): Promise<NoteSnapshot>
  tier(root: string, path: string): Promise<'reference' | 'follow'>
  materials?: TaskMaterialTracker
  validateMemoryBatch?: (dependencies: readonly LedgerMemoryDependency[]) => Promise<boolean[]>
  validateMemory?: (dependency: LedgerMemoryDependency) => Promise<boolean>
  acceptsObject(path: string, expected: string, current: string): boolean
  /** 只有宿主给了写入能力时，「补任务发起篇」才会出现在工具清单里。 */
  write?: ScopedWriteTool
}
type Policy = { bodyTasks: Map<number,string[]>; memoryByChapter: Map<string, LedgerMemoryDependency[]>; memoryByTask: Map<string, LedgerMemoryDependency[]>; allowedLedgerChapterIds: string[]; excludedAiTaskIds: string[]; byChapter: Map<string, LedgerSource[]>; byTask: Map<string, LedgerSource[]> }
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
function args(value: unknown, required: string[], optional: string[], allowEmpty: string[] = []): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_TOOL_ARGUMENTS')
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => ![...required, ...optional].includes(key)) || required.some(key => !(key in object))) throw Error('INVALID_TOOL_ARGUMENTS')
  for (const [key, v] of Object.entries(object)) if (typeof v !== 'string' || (!v.trim() && !allowEmpty.includes(key)) || v.length > (key === 'query' ? 512 : key === 'text' ? 8192 : key === 'body' ? 32768 : 256)) throw Error('INVALID_TOOL_ARGUMENTS')
  return object as Record<string, string>
}
/** Only receives a fixed, main-process grant; it never sees the human global index. */
export function createScopedAgentTools(grant: TaskGrant, _taskId: string, deps: Dependencies): ScopedAgentTools {
  const sources = new Map(grant.sources.map(source => [source.relPath, source]))
  const ids = new Map(grant.sources.map(source => [source.sourceId, source.relPath]))
  const reads = new Map<string, LedgerSource>()
  const memories = new Map<string, LedgerMemoryDependency>()
  const stagedMemory = new Set<string>(), sentMemory = new Set<string>()
  const contextPaths = new Set<string>(), contextMemories = new Set<string>()
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
    if ((await memoryValid([...memories.values()],signal)).some(valid=>!valid)) { grant.revoke(); throw Error('MEMORY_CHANGED') }
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
    const proof = path === grant.origin ? grant.originProof : approved
    if (current.objectVersion !== proof.objectVersion && !deps.acceptsObject(path, proof.objectVersion, current.objectVersion)) throw Error('SOURCE_REPLACED')
    if (current.revision !== proof.revision || hash(current.content) !== proof.fingerprint) throw Error('SOURCE_CHANGED')
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
  async function memoryValid(dependencies: LedgerMemoryDependency[], signal: AbortSignal): Promise<boolean[]> {
    if (!dependencies.length) return []
    if (deps.validateMemoryBatch) return awaiting(deps.validateMemoryBatch(dependencies),signal)
    const valid: boolean[] = []
    for (const dep of dependencies) valid.push(await awaiting(deps.validateMemory?.(dep) ?? Promise.resolve(false),signal))
    return valid
  }
  async function policy(source: string, signal: AbortSignal, parsed = compile(source), supplied?: ContextChapter[]): Promise<Policy> {
    if (parsed.stale) throw Error('SOURCE_PARSE_FAILED')
    const chapters = supplied ?? ledgerChapters(parsed.partition.ledger)
    const memoryDependencies = [...new Map(chapters.flatMap(chapter=>{const p=chapterProvenance(chapter);return p.status === 'valid' && p.record.version === 2 ? p.record.memoryDeps : []}).map(dep=>[JSON.stringify(dep),dep])).values()]
    const validMemories = await memoryValid(memoryDependencies,signal)
    const memoryChecks = new Map(memoryDependencies.map((dep,i)=>[JSON.stringify(dep),validMemories[i] === true]))
    const result = await historicalContextPolicy(source, dep => dependencyValid(dep, signal), parsed, chapters, async dep => memoryChecks.get(JSON.stringify(dep)) === true)
    const memoryByChapter = new Map<string, LedgerMemoryDependency[]>(), memoryByTask = new Map<string, LedgerMemoryDependency[]>()
    const byChapter = new Map<string, LedgerSource[]>()
    const byTask = new Map<string, LedgerSource[]>()
    for (const chapter of chapters) {
      if (!result.allowedLedgerChapterIds.includes(chapter.sourceId)) continue
      const record = chapterProvenance(chapter)
      const dependencies = record.status === 'valid' ? record.record.sources : []
      const memory = record.status === 'valid' && record.record.version === 2 ? record.record.memoryDeps : []
      memoryByChapter.set(chapter.sourceId, memory)
      if (chapter.taskId) memoryByTask.set(chapter.taskId, memory)
      byChapter.set(chapter.sourceId, dependencies)
      if (chapter.taskId) byTask.set(chapter.taskId, dependencies)
    }
    return { ...result, byChapter, byTask, memoryByChapter, memoryByTask, bodyTasks:historicalBodyTasks(parsed,chapters) }
  }
  function excluded(_parsed: CompileResult, p: Policy, start: number, identity?: string): boolean {
    const tasks = p.bodyTasks.get(start) ?? []
    return (identity === 'ai' || tasks.length > 0) && (p.excludedAiTaskIds.includes('*') || tasks.some(task=>p.excludedAiTaskIds.includes(task)))
  }
  function blockDependencies(p: Policy, start: number): MaterialDependencies {
    const tasks = p.bodyTasks.get(start) ?? []
    return {sources:tasks.flatMap(task=>p.byTask.get(task) ?? []),memories:tasks.flatMap(task=>p.memoryByTask.get(task) ?? [])}
  }
  function remember(dependency: LedgerSource, outgoing: boolean, context = false): void {
    if (dependency.relPath === grant.origin) return
    const previous = reads.get(dependency.relPath)
    if (previous && (previous.objectVersion !== dependency.objectVersion || previous.bodyHash !== dependency.bodyHash)) throw Error('SOURCE_CHANGED')
    reads.set(dependency.relPath, { ...dependency })
    if (outgoing) (context ? contextPaths : staged).add(dependency.relPath)
  }
  function rememberMemory(deps: LedgerMemoryDependency[], context = false): void {
    for (const dep of deps) {
      const previous = memories.get(dep.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(dep)) throw Error('MEMORY_CHANGED')
      memories.set(dep.id, structuredClone(dep)); (context ? contextMemories : stagedMemory).add(dep.id)
    }
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
      if (excluded(item.parsed, item.policy, block.range.start, block.identity)) continue
      if (start !== undefined && end !== undefined && (block.range.end <= start || block.range.start >= end)) continue
      const dependencies = blockDependencies(item.policy,block.range.start)
      deps.materials?.body(item.snapshot.content, {start:Math.max(start ?? 0, block.range.start), end:Math.min(end ?? item.body.length, block.range.end)}, { ...item.snapshot,relPath:item.path,permissionTier:grant.sources.find(s=>s.relPath===item.path)!.tier }, {sources:[item.proof,...dependencies.sources],memories:dependencies.memories}, false, item.parsed, item.policy.bodyTasks)
      for (const dep of dependencies.sources) remember(dep, true)
      rememberMemory(dependencies.memories)
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
    writes: !!deps.write,
    creates: !!deps.write?.create,
    renames: !!(deps.write?.rename && deps.write?.move),
    async contextPolicy(source, signal, chapters) {
      active(signal); originParsed = compile(source); originPolicy = await policy(source, signal, originParsed,chapters); active(signal)
      return { allowedLedgerChapterIds: [...originPolicy.allowedLedgerChapterIds], excludedAiTaskIds: [...originPolicy.excludedAiTaskIds] }
    },
    async execute(name, input, signal) {
      const writeEnabled = !!deps.write
      const known = name === 'read_library' || name === 'search_library' || (writeEnabled && name === 'append_to_note') || (!!deps.write?.create && name === 'create_note') || (!!deps.write?.rename && (name === 'rename_note' || name === 'move_note'))
      const label = known ? name : 'unknown'
      let outcome = 'refused'
      try {
        active(signal)
        if (!known) throw Error('UNKNOWN_TOOL')
        if (name === 'rename_note' || name === 'move_note') {
          const request = name === 'rename_note'
            ? args(input, ['relPath', 'newName'], [])
            : args(input, ['relPath', 'targetFolder'], [], ['targetFolder'])
          await check(signal)
          const result = name === 'rename_note'
            ? await deps.write!.rename!(request.relPath!, request.newName!, signal)
            : await deps.write!.move!(request.relPath!, request.targetFolder ?? '', signal)
          if (!result.ok) { outcome = `refused:${result.reason}`; throw Error(result.reason) }
          // 账本要能审：落到哪、影响了几处引用与权限，都记进 outcome（量都很小，字符串有界）。
          outcome = `ok:${result.target}·引用${result.linkChanges}·权限${result.permissionChanges}`
          return { target: result.target, moved: result.moved }
        }
        if (name === 'create_note') {
          const request = args(input, ['name', 'body'], [])
          await check(signal)
          const created = await deps.write!.create!(request.name!, request.body!, signal)
          if (!created.ok) { outcome = `refused:${created.reason}`; throw Error(created.reason) }
          outcome = `ok:${created.relPath}${created.objectVersion ? `·${created.objectVersion}` : ''}`
          return { revision: created.revision, bytes: created.bytes, relPath: created.relPath, objectVersion: created.objectVersion }
        }
        if (name === 'append_to_note') {
          const appended = args(input, ['text'], [])
          await check(signal)
          const result = await deps.write!.append(appended.text!, signal)
          if (!result.ok) { outcome = `refused:${result.reason}`; throw Error(result.reason) }
          outcome = 'ok'
          return { revision: result.revision, bytes: result.bytes }
        }
        const request = args(input, name === 'search_library' ? ['query'] : [], name === 'search_library' ? ['cursor'] : ['sourceId', 'cursor'])
        await check(signal)
        // read_library 不带 sourceId 时是列表续页：列表分页只有 nextCursor，没有第二个工具名。
        // cursor 的 kind 校验保证两种游标不能互相复用，所以这个别名不扩大范围。
        const result = name === 'search_library' ? await search(request, signal) : request.sourceId ? await read(request, signal) : await list(request, signal)
        outcome = 'ok'; return result
      } finally { const key = `${label}\0${outcome}`; outcomes.set(key, (outcomes.get(key) ?? 0) + 1) }
    },
    assertCurrent: check,
    contextDependencies(ref) {
      if (!originPolicy || !originParsed) return {sources:[],memories:[]}
      if (ref.kind !== 'body') return {sources:originPolicy.byChapter.get(ref.sourceId) ?? [],memories:originPolicy.memoryByChapter.get(ref.sourceId) ?? []}
      const block = originParsed.index.blocks[Number(ref.sourceId.slice(5)) - 1]
      return block ? blockDependencies(originPolicy,block.range.start) : {sources:[],memories:[]}
    },
    memoryDependencies: () => [...sentMemory].map(id => structuredClone(memories.get(id)!)),
    dependencies: () => [...reads.values()].map(dep => ({ ...dep })),
    summary: () => [...outcomes].map(([key, count]) => { const [name, outcome] = key.split('\0'); return { name: name!, outcome: `${outcome} (${count})` } }),
    recordContext(refs) {
      contextPaths.clear(); contextMemories.clear()
      for (const id of memories.keys()) if (!stagedMemory.has(id) && !sentMemory.has(id)) memories.delete(id)
      if (!originPolicy || !originParsed) return
      for (const ref of refs) {
        if (ref.kind === 'ledger' || ref.kind === 'summary') {
          for (const id of ref.kind === 'summary' ? ref.sourceId.split(',') : [ref.sourceId]) {
            for (const dep of originPolicy.byChapter.get(id) ?? []) remember(dep, true, true)
            rememberMemory(originPolicy.memoryByChapter.get(id) ?? [], true)
          }
        } else {
          const block = originParsed.index.blocks[Number(ref.sourceId.slice(5)) - 1]
          if (block) {
            const dependencies = blockDependencies(originPolicy,block.range.start)
            for (const dep of dependencies.sources) remember(dep, true, true)
            rememberMemory(dependencies.memories, true)
          }
        }
      }
    },
    markSent(includeTools = true) {
      for (const path of contextPaths) sent.add(path)
      for (const id of contextMemories) sentMemory.add(id)
      contextPaths.clear(); contextMemories.clear()
      if (includeTools) { for (const path of staged) sent.add(path); staged.clear(); for (const id of stagedMemory) sentMemory.add(id); stagedMemory.clear() }
    },
    sentSources: () => [...sent]
  }
}

import type { BacklinkGroup, BacklinkRef, SearchHit, TreeEntry } from '../shared/ipc.ts'
import { ROOT_GROUP } from '../shared/ipc.ts'
import { collectNotePaths, noteTitle } from '../shared/vault-rel.ts'
import type { SourceRange } from '../markdown/types.ts'
import { compile, type MarkerRef } from '../markdown/index.ts'
import { readNote } from './notes-fs.ts'

export { ROOT_GROUP }

const SNIPPET_PAD = 40
/** 单篇最多数这么多次命中，只用于排序。 */
const MAX_COUNTED_HITS = 20
const MAX_RESULTS = 100

type IndexedNote = {
  relPath: string
  folder: string
  title: string
  /** 只存正文：账本锚点之后的内容永远不进索引。 */
  body: string
  /** 指向别的笔记的 [[全路径]]，已由 wikilink 语法补成 .md 结尾。 */
  targets: string[]
}

/**
 * 全库索引，住主进程（架构：主进程管索引）。
 *
 * 这是人的全量索引，含禁止触碰。模型仅载入本场批准对象，并复用下面的纯匹配器，
 * 不得在建索引时把禁区抹掉（围栏 §检索与联网）。
 *
 * 重建是惰性全量的：变脏后等下一次查询才重扫。查询由人的动作触发（切笔记、搜一次），
 * 不跟着按键走，所以现在还不需要增量索引。
 */
export class VaultIndex {
  private notes = new Map<string, IndexedNote>()
  private byTarget = new Map<string, Set<string>>()
  private dirty = true
  private rebuilding: Promise<void> | null = null

  constructor(
    private readonly getRoot: () => string | null,
    private readonly listTree: () => Promise<TreeEntry[]>
  ) {}

  reset(): void {
    this.notes.clear()
    this.byTarget.clear()
    this.dirty = true
    // 不清 rebuilding：清掉会让在飞重建的收尾注销**新**重建的注册，查询就可能
    // 在索引装好之前提前返回。dirty 已经足够要求重扫；同一时刻只留一个在飞重建。
  }

  markDirty(): void {
    this.dirty = true
  }

  async backlinks(relPath: string): Promise<BacklinkGroup[]> {
    await this.ready()
    const sources = [...(this.byTarget.get(relPath) ?? [])]
    const groups = new Map<string, BacklinkRef[]>()
    for (const source of sources) {
      const note = this.notes.get(source)
      if (!note) continue
      const list = groups.get(note.folder) ?? []
      list.push({ relPath: note.relPath, title: note.title })
      groups.set(note.folder, list)
    }
    return [...groups.entries()]
      .map(([folder, notes]) => ({
        folder,
        notes: notes.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
      }))
      .sort((a, b) => groupOrder(a.folder).localeCompare(groupOrder(b.folder), 'zh'))
  }

  async search(query: string): Promise<SearchHit[]> {
    await this.ready()
    return searchDocuments(this.notes.values(), query)
  }

  private async ready(): Promise<void> {
    // 条件必须同时看 rebuilding：rebuild() 在第一个 await 之前就把 dirty 清了，
    // 所以「dirty 为假」不等于「已建好」。第二项防的是同一 tick 里的第二个查询
    // 误判成已建好、读到上一代的 notes / byTarget。
    while (this.dirty || this.rebuilding) {
      if (this.rebuilding) {
        await this.rebuilding
        continue
      }
      const attempt = this.rebuild()
      // 只有仍登记着自己的那次重建才能清注册位：库失效时的在飞重建不得注销后继者。
      const tracked: Promise<void> = attempt.finally(() => {
        if (this.rebuilding === tracked) this.rebuilding = null
      })
      this.rebuilding = tracked
      await tracked
    }
  }

  private async rebuild(): Promise<void> {
    this.dirty = false
    const root = this.getRoot()
    if (!root) {
      this.notes.clear()
      this.byTarget.clear()
      return
    }
    const notes = new Map<string, IndexedNote>()
    const byTarget = new Map<string, Set<string>>()
    for (const relPath of collectNotePaths(await this.listTree())) {
      const indexed = await this.readOne(root, relPath)
      if (!indexed) continue
      notes.set(relPath, indexed)
      for (const target of indexed.targets) {
        const sources = byTarget.get(target) ?? new Set<string>()
        sources.add(relPath)
        byTarget.set(target, sources)
      }
    }
    if (this.getRoot() !== root) { this.dirty = true; return }
    this.notes = notes
    this.byTarget = byTarget
  }

  private async readOne(root: string, relPath: string): Promise<IndexedNote | null> {
    try {
      if (this.getRoot() !== root) return null
      const source = await readNote(root, relPath)
      if (this.getRoot() !== root) return null
      const parsed = compile(source)
      if (parsed.stale) return null
      const { index, partition } = parsed
      const targets = index.wikilinks.filter((link) => isNoteTarget(link.target)).map((link) => link.target)
      return {
        relPath,
        folder: folderOf(relPath),
        title: noteTitle(relPath),
        // 身份标记是机器语法，不该出现在人的搜索命中与片段里（搜 "rgent" 会搜到它们）。
        // 等长填空格，偏移不变，片段位置照旧对得上。
        body: blankMarkers(partition.body, index.markers),
        targets: [...new Set(targets)]
      }
    } catch {
      // 读不了的笔记跳过，不拖垮整次重建。
      return null
    }
  }
}

/** Pure matcher shared by human search and already-scoped task documents. */
export function searchDocuments(notes: Iterable<Pick<IndexedNote, 'relPath' | 'folder' | 'title' | 'body'>>, query: string, limit = MAX_RESULTS): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const hits: SearchHit[] = []
  for (const note of notes) {
    const titleHit = note.title.toLowerCase().includes(needle)
    const body = note.body.toLowerCase()
    const positions = matchPositions(body, needle)
    if (!titleHit && positions.length === 0) continue
    const first = positions[0]
    const detail = first == null ? emptySnippet() : makeSnippet(note.body, first, needle.length)
    hits.push({
      relPath: note.relPath,
      title: note.title,
      folder: note.folder,
      titleHit,
      count: positions.length,
      ...detail
    })
  }

  return hits
    .sort(
      (a, b) =>
        Number(b.titleHit) - Number(a.titleHit) ||
        b.count - a.count ||
        a.relPath.localeCompare(b.relPath, 'zh')
    )
    .slice(0, limit)
}

function isNoteTarget(target: string): boolean {
  return target.toLowerCase().endsWith('.md')
}

/** 把身份标记的位置换成等长空格：机器语法不进人的搜索语料，偏移也不动。 */
export function blankMarkers(body: string, markers: readonly MarkerRef[]): string {
  if (markers.length === 0) return body
  const parts: string[] = []
  let at = 0
  for (const marker of [...markers].sort((left, right) => left.range.start - right.range.start)) {
    const start = Math.max(at, Math.min(body.length, marker.range.start))
    const end = Math.max(start, Math.min(body.length, marker.range.end))
    if (end === start) continue
    parts.push(body.slice(at, start), ' '.repeat(end - start))
    at = end
  }
  parts.push(body.slice(at))
  return parts.join('')
}

export function folderOf(relPath: string): string {
  const parts = relPath.split('/')
  parts.pop()
  return parts.length > 0 ? parts.join('/') : ROOT_GROUP
}

/** 库根排在文件夹前面，其余按名字。 */
function groupOrder(folder: string): string {
  return folder === ROOT_GROUP ? '' : folder
}

function matchPositions(haystack: string, needle: string): number[] {
  const out: number[] = []
  let from = 0
  while (out.length < MAX_COUNTED_HITS) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

function emptySnippet(): { snippet: string; matchStart: number; matchLength: number } {
  return { snippet: '', matchStart: 0, matchLength: 0 }
}

/**
 * 首次命中前后各留一段。换行按 1:1 换成空格，长度不变，
 * 所以 matchStart 能精确落在片段里那一段命中上。
 */
function makeSnippet(
  body: string,
  at: number,
  length: number
): { snippet: string; matchStart: number; matchLength: number } {
  const { start, end } = snippetRange(body, at, length)
  const leading = start > 0 ? '…' : ''
  const trailing = end < body.length ? '…' : ''
  const middle = body.slice(start, end).replaceAll('\n', ' ')
  return {
    snippet: `${leading}${middle}${trailing}`,
    matchStart: leading.length + (at - start),
    matchLength: length
  }
}

/** The same original offsets used by snippets and task provenance; never split UTF-16 pairs. */
function snippetRange(body: string, at: number, length: number): SourceRange {
  let start = Math.max(0, at - SNIPPET_PAD)
  let end = Math.min(body.length, at + length + SNIPPET_PAD)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start] ?? '') && /[\uD800-\uDBFF]/.test(body[start - 1] ?? '')) start--
  if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(body[end] ?? '')) end++
  return { start, end }
}
export function searchSnippetRange(body: string, query: string): SourceRange | null {
  const needle = query.trim().toLowerCase()
  const at = needle ? body.toLowerCase().indexOf(needle) : -1
  return at < 0 ? null : snippetRange(body, at, needle.length)
}

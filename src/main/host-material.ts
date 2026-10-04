import type { MemoryContext } from '../shared/memory.ts'
import { createHash } from 'node:crypto'
import { compile, parseMarker } from '../markdown/index.ts'
import { ledgerChapters, type ContextChapter, ledgerTaskFields, historicalBodyTasks, type ContextSourceRef } from './host-context.ts'
import type { LedgerMemoryDependency, LedgerSource } from './ledger-provenance.ts'

export type MaterialBinding = { relPath: string; sessionId: string; objectVersion: string; revision: string; permissionTier?: 'reference' | 'follow' }
export type SentFragment = MaterialBinding & {
  permissionTier: 'reference' | 'follow'
  kind: 'body' | 'ledger'; classification: 'human' | 'command' | 'ai'; taskId: string | null
  start: number; end: number; text: string; hash: string
  sourceDeps: LedgerSource[]; memoryDeps: LedgerMemoryDependency[]
}
/** Successful saving evidence only; this does not authorize background model work. */
export type SavedTaskMaterial = {
  taskId: string; context: MemoryContext | null; origin: MaterialBinding
  status: 'completed' | 'cancelled' | 'failed' | 'limit'; reason?: string
  prompt: string; answer: string; ledgerHash: string; materialVersion: string
  material: SentTaskMaterial; sourceDeps: LedgerSource[]; memoryDeps: LedgerMemoryDependency[]
}
export type SentTaskMaterial = { fragments: SentFragment[]; truncated: boolean }
export function validTaskMaterial(value:unknown):value is SentTaskMaterial{
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const m=value as SentTaskMaterial;return Array.isArray(m.fragments)&&m.fragments.length<=512&&typeof m.truncated==='boolean'&&Buffer.byteLength(JSON.stringify(m))<=256*1024
}
export type MaterialDependencies = { sources: LedgerSource[]; memories: LedgerMemoryDependency[] }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
/** Bounded evidence of text actually dispatched; never contains model reasoning or whole grant/history copies. */
export class TaskMaterialTracker {
  private stagedContext: SentFragment[] = []
  private stagedTools: SentFragment[] = []
  private readonly sent = new Map<string, SentFragment>()
  private truncated = false
  constructor(private readonly maxBytes = 256 * 1024, private readonly maxFragments = 512) {}
  private fits(fragments:readonly SentFragment[]) { return fragments.length<=this.maxFragments&&Buffer.byteLength(JSON.stringify({fragments,truncated:false}))<=this.maxBytes }
  private stage(lane: SentFragment[], fragment: SentFragment) {
    // Bound pending as well as committed buffers. A dropped fragment can never become a candidate basis.
    if (!this.fits([...lane,fragment])) { this.truncated = true; return }
    lane.push(fragment)
  }
  body(source: string, range: {start: number; end: number}, binding: MaterialBinding, dependencies: MaterialDependencies = {sources:[],memories:[]}, context = false, parsed = compile(source), historical = historicalBodyTasks(parsed)) {
    if (parsed.stale) throw Error('SOURCE_PARSE_FAILED')
    for (const block of parsed.index.blocks) {
      const start = Math.max(range.start, block.range.start), end = Math.min(range.end, block.range.end)
      if (start >= end) continue
      const marker = parsed.index.markers.filter(m => m.range.end <= block.range.start).at(-1)
      const taskId = marker && block.identity ? parseMarker(source.slice(marker.range.start, marker.range.end))?.attrs['task-id'] ?? null : historical.get(block.range.start)?.[0] ?? null
      const text = source.slice(start, end)
      this.stage(context ? this.stagedContext : this.stagedTools, { ...binding, permissionTier: binding.permissionTier ?? 'reference', kind: 'body', classification: block.identity === 'ai' || historical.has(block.range.start) ? 'ai' : block.identity === 'command' ? 'command' : 'human', taskId, start, end, text, hash:hash(text), sourceDeps:structuredClone(dependencies.sources), memoryDeps:structuredClone(dependencies.memories) })
    }
  }
  context(source: string, refs: readonly ContextSourceRef[], binding: MaterialBinding, dependencies: (ref: ContextSourceRef) => MaterialDependencies = () => ({sources:[],memories:[]}), supplied?: ContextChapter[]) {
    this.stagedContext = []
    const parsed = compile(source)
    if (parsed.stale) throw Error('SOURCE_PARSE_FAILED')
    const chapters = supplied ?? ledgerChapters(parsed.partition.ledger), historical = historicalBodyTasks(parsed,chapters)
    for (const ref of refs) {
      // A summary is derived text; its actual input fragments were committed on the summarization dispatch.
      if (ref.kind === 'summary') continue
      const deps = dependencies(ref)
      if (ref.kind === 'body') {
        const block = parsed.index.blocks[Number(ref.sourceId.slice(5)) - 1]
        if (block) this.body(source, block.range, binding, deps, true, parsed, historical)
      } else {
        const chapter = chapters.find(c => c.sourceId === ref.sourceId)
        if (!chapter?.taskId) continue
        const fields=chapter.fields ?? ledgerTaskFields(chapter.text)
        if(fields.status !== 'valid'){this.truncated=true;continue}
        for(const [field,classification] of [[fields.prompt,'command'],[fields.answer,'ai']] as const) {
          const start=Math.max(field.start,ref.start ?? 0),end=Math.min(field.end,ref.end ?? chapter.text.length)
          if(start>=end)continue
          const text=chapter.text.slice(start,end)
          this.stage(this.stagedContext,{...binding,permissionTier:binding.permissionTier ?? 'reference',kind:'ledger',classification,taskId:chapter.taskId,start,end,text,hash:hash(text),sourceDeps:structuredClone(deps.sources),memoryDeps:structuredClone(deps.memories)})
        }
      }
    }
  }
  commit(includeTools = true) {
    for (const fragment of [...this.stagedContext, ...(includeTools ? this.stagedTools : [])]) {
      const key = JSON.stringify([fragment.relPath,fragment.objectVersion,fragment.kind,fragment.taskId,fragment.start,fragment.end,fragment.hash])
      if (this.sent.has(key)) continue
      if (!this.fits([...this.sent.values(),fragment])) { this.truncated = true; continue }
      this.sent.set(key,structuredClone(fragment))
    }
    this.stagedContext=[];if (includeTools) this.stagedTools=[]
  }
  snapshot(): SentTaskMaterial { return {fragments: structuredClone([...this.sent.values()]),truncated:this.truncated} }
}

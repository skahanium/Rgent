import { createHash, randomUUID } from 'node:crypto'
import { compile, parseMarker, partitionSource } from '../markdown/index.ts'
import { ledgerChapters, ledgerTaskFields, historicalTextMatches } from './host-context.ts'
import { bodyFingerprint, ledgerProvenance, type LedgerMemoryDependency } from './ledger-provenance.ts'
import type { MemorySource, MemoryWholeSource } from '../shared/memory.ts'
import type { NoteSnapshot, PermissionTier } from '../shared/ipc.ts'

export const memoryHash = (text: string): string => createHash('sha256').update(text).digest('hex')
export type MemorySourceAnalysis = { parsed: ReturnType<typeof compile>; chapters: ReturnType<typeof ledgerChapters> }
export function analyzeMemorySource(content: string): MemorySourceAnalysis {
  const parsed = compile(content)
  if (parsed.stale || parsed.error) throw Error('MEMORY_SOURCE_UNKNOWN')
  return {parsed,chapters:ledgerChapters(parsed.partition.ledger)}
}
export type MemorySourceSnapshot = NoteSnapshot & { permissionTier: PermissionTier; analysis?: MemorySourceAnalysis }
export type ManualMemorySourceRequest = Omit<NoteSnapshot, 'content'> & { relPath: string; kind: 'body' | 'ledger'; taskId?: string; start: number; end: number }
export type MemorySourceReader = (relPath: string) => Promise<MemorySourceSnapshot>
const strength = { reference: 0, follow: 1, forbidden: 2 }

function material(source: MemorySource, content: string, analysis?: MemorySourceAnalysis): string {
  const part = analysis?.parsed.partition ?? partitionSource(content)
  if (source.kind === 'body') return part.body
  const matches = (analysis?.chapters ?? ledgerChapters(part.ledger)).filter(c => c.taskId === source.taskId)
  if (matches.length !== 1) throw new Error('MEMORY_SOURCE_AMBIGUOUS')
  return matches[0]!.text
}
export function uniqueMemoryRange(text: string, fragment: string): { start: number; end: number } {
  const start = text.indexOf(fragment)
  if (!fragment || start < 0 || text.indexOf(fragment, start + 1) >= 0) throw new Error('MEMORY_SOURCE_CHANGED')
  return { start, end: start + fragment.length }
}
/** Reused at preview, every use, and controlled identity continuation. */
function classifyMaterial(content: string, kind: MemorySource['kind'], requestedTaskId: string | null,
  range: { start: number; end: number }, established?: MemorySource['classification'], analysis = analyzeMemorySource(content)): Pick<MemorySource, 'classification' | 'taskId' | 'taskMaterialHash'> & { chapter?: string } {
  const {parsed,chapters} = analysis
  let classification: MemorySource['classification'] = 'human'
  let taskId: string | null = kind === 'ledger' ? requestedTaskId : null
  if (kind === 'body') {
    const corpus = parsed.partition.body
    const blocks = parsed.index.blocks.filter(b => b.range.start < range.end && b.range.end > range.start)
    if (!blocks.length || blocks.some(b => b.identity === 'ai') || new Set(blocks.map(b => b.identity ?? 'human')).size > 1) throw new Error('MEMORY_SOURCE_UNCONFIRMED')
    for (const block of blocks) {
      const previous = parsed.index.blocks[parsed.index.blocks.indexOf(block) - 1]
      if (previous?.type !== 'html' || corpus.slice(previous.range.end, block.range.start).trim()) continue
      const marker = corpus.slice(previous.range.start, previous.range.end).trim()
      if (/^<!--\s*rgent:(?:ai|prompt):/.test(marker) && !parseMarker(marker)) throw new Error('MEMORY_SOURCE_UNKNOWN')
    }
    if (blocks[0]!.identity === 'command') classification = 'command'
    const pieces = blocks.map(b => corpus.slice(Math.max(range.start, b.range.start), Math.min(range.end, b.range.end)).trim()).filter(Boolean)
    const answers = (established === 'human' || established === 'command' ? [] : chapters).filter(c => {
      const fields = c.fields ?? ledgerTaskFields(c.text)
      if(fields.status === 'ambiguous') {
        if(pieces.some(piece=>historicalTextMatches(c.text,piece)))throw Error('MEMORY_SOURCE_AMBIGUOUS')
        return false
      }
      return pieces.some(piece=>historicalTextMatches(fields.answer.text,piece))
    })
    if (answers.length > 1) throw new Error('MEMORY_SOURCE_AMBIGUOUS')
    if (answers.length === 1) {
      const fields=answers[0]!.fields ?? ledgerTaskFields(answers[0]!.text)
      if (fields.status !== 'valid' || !pieces.every(piece => fields.answer.text.includes(piece))) throw new Error('MEMORY_SOURCE_UNKNOWN')
      classification = 'adopted-ai'; taskId = answers[0]!.taskId ?? null
      if (!taskId) throw new Error('MEMORY_SOURCE_UNKNOWN')
    }
    if (classification === 'command') {
      const marker = parsed.index.markers.filter(m => m.range.end <= range.start).at(-1)
      taskId = marker ? parseMarker(content.slice(marker.range.start, marker.range.end))?.attrs['task-id'] ?? null : null
    }
  } else {
    const matches = chapters.filter(c => c.taskId === taskId)
    if (!taskId || matches.length !== 1) throw new Error('MEMORY_SOURCE_AMBIGUOUS')
    const chapter = matches[0]!.text
    const fields = matches[0]!.fields ?? ledgerTaskFields(chapter)
    if(fields.status !== 'valid')throw Error('MEMORY_SOURCE_AMBIGUOUS')
    if(range.start >= fields.answer.start && range.end <= fields.answer.end)classification='adopted-ai'
    else if(range.start >= fields.prompt.start && range.end <= fields.prompt.end)classification='command'
    else throw Error('MEMORY_SOURCE_UNCONFIRMED')
  }
  if (classification !== 'adopted-ai') return { classification, taskId, taskMaterialHash: null }
  const matches = chapters.filter(c => c.taskId === taskId)
  if (matches.length !== 1 || !/^## .* · completed\r?$/m.test(matches[0]!.text)) throw new Error('MEMORY_SOURCE_UNCONFIRMED')
  const chapter = matches[0]!.text
  if (ledgerProvenance(chapter).status !== 'valid') throw new Error('MEMORY_SOURCE_UNKNOWN')
  return { classification, taskId, taskMaterialHash: memoryHash(chapter.trimEnd()), chapter }
}
function verifyClassification(source: MemorySource, content: string, range: { start: number; end: number }, analysis?: MemorySourceAnalysis): void {
  const current = classifyMaterial(content, source.kind, source.taskId, range, source.classification, analysis)
  if (current.classification !== source.classification || current.taskId !== source.taskId || current.taskMaterialHash !== source.taskMaterialHash) throw new Error('MEMORY_SOURCE_IDENTITY_CHANGED')
}
/** Derive provenance locally, including an adopted block whose AI marker was removed. */
export async function createManualMemorySource(request: ManualMemorySourceRequest, read: MemorySourceReader, validateMemory: (dependency: LedgerMemoryDependency) => Promise<boolean> = async () => false): Promise<MemorySource> {
  const current = await read(request.relPath)
  if (current.sessionId !== request.sessionId || current.objectVersion !== request.objectVersion || current.revision !== request.revision) throw new Error('MEMORY_SOURCE_CHANGED')
  if (current.permissionTier === 'forbidden') throw new Error('MEMORY_SOURCE_FORBIDDEN')
  const part = partitionSource(current.content)
  let corpus = part.body
  if (request.kind === 'ledger') {
    const matches = ledgerChapters(part.ledger).filter(c => c.taskId === request.taskId)
    if (!request.taskId || matches.length !== 1) throw new Error('MEMORY_SOURCE_AMBIGUOUS')
    corpus = matches[0]!.text
  }
  if (!Number.isSafeInteger(request.start) || !Number.isSafeInteger(request.end) || request.start < 0 || request.end <= request.start || request.end > corpus.length) throw new Error('MEMORY_SOURCE_RANGE')
  const text = corpus.slice(request.start, request.end)
  if (Buffer.byteLength(text) > 4096) throw new Error('MEMORY_SOURCE_LIMIT')
  uniqueMemoryRange(corpus, text)
  const { classification, taskId, taskMaterialHash, chapter } = classifyMaterial(current.content, request.kind, request.taskId ?? null, request, undefined, current.analysis)
  const sourceDeps: MemoryWholeSource[] = []
  const memoryDeps: MemorySource['memoryDeps'] = []
  if (chapter !== undefined) {
    const provenance = ledgerProvenance(chapter)
    // Unknown/new dependency versions require their dedicated verifier; never wash them into human facts.
    if (provenance.status !== 'valid') throw new Error('MEMORY_SOURCE_UNKNOWN')
    if (provenance.record.version === 2) for (const dep of provenance.record.memoryDeps) {
      if (!(await validateMemory(dep))) throw Error('MEMORY_DEPENDENCY_CHANGED')
      memoryDeps.push({ id: dep.id, version: dep.version })
    }
    for (const dependency of provenance.record.sources) {
      const snapshot = await read(dependency.relPath)
      if (snapshot.permissionTier === 'forbidden' || snapshot.objectVersion !== dependency.objectVersion || bodyFingerprint(snapshot.content) !== dependency.bodyHash) throw new Error('MEMORY_SOURCE_CHANGED')
      sourceDeps.push({ ...dependency, permissionTier: snapshot.permissionTier })
    }
  }
  const hash = memoryHash(text)
  return { id: randomUUID(), version: 1, relPath: request.relPath, objectVersion: current.objectVersion, revision: current.revision, permissionTier: current.permissionTier, kind: request.kind, taskId, taskMaterialHash, classification, start: request.start, end: request.end, text, hash,
    basisHash: memoryHash(JSON.stringify([request.kind, taskId, hash])), sourceDeps, memoryDeps }
}
export async function verifyMemorySource(source: MemorySource, read: MemorySourceReader, validateMemory: (id: string, version: number) => Promise<boolean>): Promise<MemorySource> {
  const current = await read(source.relPath)
  if (current.objectVersion !== source.objectVersion) throw new Error('MEMORY_SOURCE_REPLACED')
  if (strength[current.permissionTier] > strength[source.permissionTier]) throw new Error('MEMORY_SOURCE_PERMISSION')
  if (memoryHash(source.text) !== source.hash) throw new Error('MEMORY_SOURCE_CHANGED')
  const range = uniqueMemoryRange(material(source, current.content, current.analysis), source.text)
  verifyClassification(source, current.content, range, current.analysis)
  for (const dep of source.sourceDeps) {
    const other = await read(dep.relPath)
    if (other.objectVersion !== dep.objectVersion || strength[other.permissionTier] > strength[dep.permissionTier] || bodyFingerprint(other.content, other.analysis?.parsed) !== dep.bodyHash) throw new Error('MEMORY_DEPENDENCY_CHANGED')
  }
  for (const dep of source.memoryDeps) if (!(await validateMemory(dep.id, dep.version))) throw new Error('MEMORY_DEPENDENCY_CHANGED')
  return { ...source, ...range, revision: current.revision }
}
/** The caller has a native success receipt, but unchanged, unique material is still mandatory. */
export function continueMemorySource(source: MemorySource, content: string, analysis?: MemorySourceAnalysis): MemorySource {
  const range = uniqueMemoryRange(material(source, content, analysis), source.text)
  verifyClassification(source, content, range, analysis)
  return { ...source, ...range, revision: memoryHash(content) }
}

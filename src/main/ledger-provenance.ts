import { ledgerChapters, type ContextChapter } from './host-context.ts'
import { createHash } from 'node:crypto'
import { compile } from '../markdown/index.ts'
import type { CompileResult } from '../markdown/types.ts'
import { isNotePath, hasHiddenSegment } from './paths.ts'

export type LedgerSource = { relPath: string; objectVersion: string; bodyHash: string }
export type LedgerProvenance = {
  version: 1
  model: { provider: string; modelId: string; endpointHost: string }
  scope: string[]
  sources: LedgerSource[]
  tools: { name: string; outcome: string }[]
  /** Sources referenced by outgoing model messages, a subset of the actual reads above. */
  sentSources?: string[]
}
const PREFIX = 'rgent:ledger-sources:'
const MAX_RECORD_BYTES = 131072
const bounded = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v)
function fields(v: unknown, names: string[]): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.sort().join(',')
}
function notePath(v: unknown): v is string { return bounded(v, 4096) && isNotePath(v) && !hasHiddenSegment(v) && !/[:\\]/.test(v) && v.split('/').every(segment => segment.length > 0 && segment !== '..' && segment !== '.') }
function valid(v: unknown): v is LedgerProvenance {
  if (!fields(v, ['version', 'model', 'scope', 'sources', 'tools', ...(v && typeof v === 'object' && 'sentSources' in v ? ['sentSources'] : [])]) || v.version !== 1) return false
  if (!fields(v.model, ['provider', 'modelId', 'endpointHost']) || !bounded(v.model.provider) || !bounded(v.model.modelId) || !bounded(v.model.endpointHost, 512)) return false
  if (!Array.isArray(v.scope) || v.scope.length > 256 || !v.scope.every(notePath) || new Set(v.scope).size !== v.scope.length) return false
  const scope = v.scope
  if (!Array.isArray(v.sources) || v.sources.length > 256 || !v.sources.every(s => fields(s, ['relPath', 'objectVersion', 'bodyHash']) && notePath(s.relPath) && scope.includes(s.relPath) && bounded(s.objectVersion, 512) && typeof s.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(s.bodyHash))) return false
  if (new Set(v.sources.map(s => s.relPath)).size !== v.sources.length) return false
  if (v.sentSources !== undefined && (!Array.isArray(v.sentSources) || v.sentSources.length > 256 || !v.sentSources.every(path => v.sources instanceof Array && v.sources.some(s => s.relPath === path)) || new Set(v.sentSources).size !== v.sentSources.length)) return false
  return Array.isArray(v.tools) && v.tools.length <= 512 && v.tools.every(t => fields(t, ['name', 'outcome']) && bounded(t.name) && bounded(t.outcome, 1024))
}
export function bodyFingerprint(source: string, parsed: CompileResult = compile(source)): string {
  if (parsed.source !== source || parsed.stale) throw new Error('SOURCE_PARSE_FAILED')
  return createHash('sha256').update(parsed.partition.body).digest('hex')
}
export function encodeLedgerProvenance(record: LedgerProvenance): string {
  if (!valid(record)) throw new Error('INVALID_LEDGER_PROVENANCE')
  const json = JSON.stringify(record)
  if (Buffer.byteLength(json) > MAX_RECORD_BYTES) throw new Error('LEDGER_PROVENANCE_LIMIT')
  return `<!-- ${PREFIX}v1 data="${Buffer.from(json).toString('base64url')}" -->`
}
export function ledgerProvenance(chapter: string): { status: 'legacy' } | { status: 'invalid' } | { status: 'valid'; record: LedgerProvenance } {
  const occurrences = [...chapter.matchAll(/<!--\s*rgent:ledger-sources:/g)].length
  if (!occurrences) return /<!-- rgent:ledger-task:v1[^>]* sources=/.test(chapter) ? { status: 'invalid' } : { status: 'legacy' }
  const matches = [...chapter.matchAll(/^<!-- rgent:ledger-sources:v1 data="([A-Za-z0-9_-]+)" -->\r?$/gm)]
  if (occurrences !== 1 || matches.length !== 1 || matches[0]![1]!.length > MAX_RECORD_BYTES * 2) return { status: 'invalid' }
  try {
    const raw = Buffer.from(matches[0]![1]!, 'base64url')
    if (raw.length > MAX_RECORD_BYTES || raw.toString('base64url') !== matches[0]![1]) return { status: 'invalid' }
    const record: unknown = JSON.parse(raw.toString('utf8'))
    return valid(record) ? { status: 'valid', record } : { status: 'invalid' }
  } catch { return { status: 'invalid' } }
}
/** Historical records never grant permission: the caller must independently prove every dependency. */
export async function validateLedgerProvenance(chapter: string, validate: (source: LedgerSource) => Promise<boolean>): Promise<boolean> {
  const result = ledgerProvenance(chapter)
  if (result.status === 'legacy') return true
  if (result.status === 'invalid') return false
  for (const source of result.record.sources) { try { if (!(await validate(source))) return false } catch { return false } }
  return true
}

export async function historicalContextPolicy(source: string, validate: (dependency: LedgerSource) => Promise<boolean>, parsed: CompileResult = compile(source), chapters: ContextChapter[] = ledgerChapters(parsed.partition.ledger)): Promise<{
  allowedLedgerChapterIds: string[]; excludedAiTaskIds: string[]; dependencies: LedgerSource[]
}> {
  if (parsed.source !== source || parsed.stale) throw new Error('SOURCE_PARSE_FAILED')
  const result = { allowedLedgerChapterIds: [] as string[], excludedAiTaskIds: [] as string[], dependencies: [] as LedgerSource[] }
  for (const chapter of chapters) {
    if (!(await validateLedgerProvenance(chapter.text, validate))) {
      result.excludedAiTaskIds.push(chapter.taskId ?? '*')
      continue
    }
    result.allowedLedgerChapterIds.push(chapter.sourceId)
    const provenance = ledgerProvenance(chapter.text)
    if (provenance.status === 'valid') {
      for (const dependency of provenance.record.sources) {
        const previous = result.dependencies.find(s => s.relPath === dependency.relPath)
        if (previous && (previous.objectVersion !== dependency.objectVersion || previous.bodyHash !== dependency.bodyHash)) throw new Error('HISTORICAL_SOURCE_CONFLICT')
        if (!previous) result.dependencies.push({ ...dependency })
      }
    }
  }
  return result
}

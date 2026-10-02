import { randomUUID } from 'node:crypto'
import type { MemoryContext, MemoryDependency, MemoryEntry, MemoryRecord, MemorySnapshot, MemorySource, MemoryStatus, MemoryStorePinPort } from '../shared/memory.ts'
import type { CommittedNoteWrite, VerifiedRelocation } from './vault-lifecycle.ts'
import { bodyFingerprint } from './ledger-provenance.ts'
import { continueMemorySource, createManualMemorySource, memoryHash, verifyMemorySource, type ManualMemorySourceRequest, type MemorySourceReader } from './memory-source.ts'

export const MEMORY_FILE = '.rgent-memory'
export const MAX_MEMORY_FILE_BYTES = 2 * 1024 * 1024
export const MAX_MEMORY_CONTENT_BYTES = 4096
/** This port is constructed only inside VaultSession; mutations share its existing queue. */
export type MemoryStoreAccess = {
  context(): MemoryContext
  ready(manageRecovery?: boolean): Promise<void>
  run<T>(operation: () => Promise<T>, manageRecovery?: boolean): Promise<T>
  read(): { raw: string; objectVersion: string } | null
  replace(expected: { raw: string; objectVersion: string } | null, raw: string): string
  source: MemorySourceReader
  pins: MemoryStorePinPort
}
const empty = (): MemoryRecord => ({ version: 1, entries: [], forgotten: [], jobs: [], relocations: [] })
const bounded = (v: unknown, n = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= n
const id = (v: unknown): v is string => bounded(v, 128) && /^[A-Za-z0-9_-]+$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',')
const notePath = (v: unknown): v is string => bounded(v, 4096) && /\.md$/i.test(v) && !/[:\\\x00-\x1f]/.test(v) && v.split('/').every(p => !!p && !p.startsWith('.'))
const text = (v: unknown): v is string => bounded(v, 4096) && !!v.trim() && Buffer.byteLength(v) <= MAX_MEMORY_CONTENT_BYTES
const dependency = (v: unknown): v is MemoryDependency => fields(v, ['id', 'version']) && id(v.id) && integer(v.version)
function validWholeSource(v: unknown): boolean {
  return fields(v, ['relPath', 'objectVersion', 'bodyHash', 'permissionTier']) && notePath(v.relPath) &&
    bounded(v.objectVersion) && hash(v.bodyHash) && ['reference', 'follow'].includes(String(v.permissionTier))
}
function validSource(v: unknown): v is MemorySource {
  if (!fields(v, ['id', 'version', 'relPath', 'objectVersion', 'revision', 'permissionTier', 'kind', 'taskId', 'taskMaterialHash', 'classification', 'start', 'end', 'text', 'hash', 'basisHash', 'sourceDeps', 'memoryDeps'])) return false
  if (!id(v.id) || !integer(v.version) || !notePath(v.relPath) || !bounded(v.objectVersion) || !hash(v.revision) ||
      !['reference', 'follow'].includes(String(v.permissionTier)) || !['body', 'ledger'].includes(String(v.kind)) ||
      !(v.taskId === null || id(v.taskId)) || !(v.taskMaterialHash === null || hash(v.taskMaterialHash)) ||
      !['human', 'command', 'adopted-ai'].includes(String(v.classification))) return false
  if (v.classification === 'adopted-ai' && (v.taskId === null || !hash(v.taskMaterialHash)) ||
      v.kind === 'ledger' && v.taskId === null) return false
  if (!Number.isSafeInteger(v.start) || Number(v.start) < 0 || !Number.isSafeInteger(v.end) || Number(v.end) <= Number(v.start) ||
      !text(v.text) || Number(v.end) - Number(v.start) !== v.text.length || !hash(v.hash) || memoryHash(v.text) !== v.hash || !hash(v.basisHash)) return false
  if (!Array.isArray(v.sourceDeps) || v.sourceDeps.length > 256 || !v.sourceDeps.every(validWholeSource) ||
      new Set(v.sourceDeps.map(d => d.relPath)).size !== v.sourceDeps.length) return false
  return Array.isArray(v.memoryDeps) && v.memoryDeps.length <= 1000 && v.memoryDeps.every(dependency) &&
    new Set(v.memoryDeps.map(d => d.id)).size === v.memoryDeps.length
}
function validEntry(v: unknown): v is MemoryEntry {
  return fields(v, ['id', 'version', 'content', 'layer', 'scope', 'sources', 'status', 'reason', 'updatedAt', 'updateBasis']) &&
    id(v.id) && integer(v.version) && text(v.content) && ['core', 'demand'].includes(String(v.layer)) && bounded(v.scope, 1024) &&
    Array.isArray(v.sources) && v.sources.length > 0 && v.sources.length <= 16 && v.sources.every(validSource) &&
    new Set(v.sources.map(s => s.id)).size === v.sources.length && ['active', 'paused', 'pending', 'disabled'].includes(String(v.status)) &&
    (v.reason === null || bounded(v.reason)) && bounded(v.updatedAt) && fields(v.updateBasis, ['kind', 'id', 'version']) &&
    ['manual', 'consolidation'].includes(String(v.updateBasis.kind)) && id(v.updateBasis.id) && integer(v.updateBasis.version)
}
function validForget(v: unknown): boolean {
  return fields(v, ['id', 'throughVersion', 'basisHashes', 'contentHash', 'forgottenAt']) && id(v.id) && integer(v.throughVersion) &&
    Array.isArray(v.basisHashes) && v.basisHashes.length > 0 && v.basisHashes.every(hash) && hash(v.contentHash) && bounded(v.forgottenAt)
}
function validJob(v: unknown): boolean {
  return fields(v, ['taskId', 'materialVersion', 'outcome', 'entryIds']) && id(v.taskId) && hash(v.materialVersion) &&
    ['applied', 'rejected', 'interrupted'].includes(String(v.outcome)) && Array.isArray(v.entryIds) && v.entryIds.every(id)
}
export function parseMemoryRecord(raw: string): MemoryRecord {
  if (Buffer.byteLength(raw) > MAX_MEMORY_FILE_BYTES) throw new Error('MEMORY_FILE_LIMIT')
  try {
    const v: unknown = JSON.parse(raw)
    if (!fields(v, ['version', 'entries', 'forgotten', 'jobs', 'relocations']) || v.version !== 1 ||
        !Array.isArray(v.entries) || v.entries.length > 1000 || !v.entries.every(validEntry) ||
        !Array.isArray(v.forgotten) || !v.forgotten.every(validForget) || !Array.isArray(v.jobs) || !v.jobs.every(validJob) ||
        !Array.isArray(v.relocations) || !v.relocations.every(hash)) throw new Error()
    if (new Set(v.relocations).size !== v.relocations.length || new Set(v.entries.map(e => e.id)).size !== v.entries.length ||
        new Set(v.forgotten.map(f => f.id)).size !== v.forgotten.length ||
        v.entries.some(e => v.forgotten instanceof Array && v.forgotten.some(f => f.id === e.id)) ||
        new Set(v.jobs.map(j => `${j.taskId}:${j.materialVersion}`)).size !== v.jobs.length) throw new Error()
    return v as MemoryRecord
  } catch { throw new Error('MEMORY_RECORD_INVALID') }
}

export class MemoryStore {
  private failure: string | null = null
  private readonly issued = new WeakMap<MemorySource, string>()
  constructor(private readonly access: MemoryStoreAccess) {}

  private read(manageRecovery = false): { snapshot: MemorySnapshot; disk: { raw: string; objectVersion: string } | null } {
    const context = this.access.context()
    if (this.failure && !manageRecovery) throw new Error(this.failure)
    const disk = this.access.read()
    const pin = this.access.pins.get(context.vaultKey)
    if (!disk && pin) throw new Error('MEMORY_REPLACED')
    const record = disk ? parseMemoryRecord(disk.raw) : empty()
    const revision = disk ? memoryHash(disk.raw) : null
    if (disk && (!pin || pin.objectVersion !== disk.objectVersion || pin.revision !== revision)) throw new Error('MEMORY_REPLACED')
    return { snapshot: { ...context, revision, objectVersion: disk?.objectVersion ?? null, record }, disk }
  }
  async snapshot(): Promise<MemorySnapshot> { await this.access.ready(); return structuredClone(this.read().snapshot) }
  /** Human management only: no source read, recall or permission to send. */
  async managementSnapshot(): Promise<MemorySnapshot> { await this.access.ready(true); return structuredClone(this.read(true).snapshot) }
  async status(): Promise<MemoryStatus> {
    try { const snapshot = await this.snapshot(); return { status: 'ready', count: snapshot.record.entries.length } }
    catch (error) { return { status: 'invalid', reason: reason(error) } }
  }
  async list(): Promise<MemoryEntry[]> {
    const snapshot = await this.snapshot()
    const pauses = new Map<string, string>()
    for (const entry of snapshot.record.entries) if (entry.status === 'active') {
      try { await this.verifyEntry(entry, snapshot.record, new Set()) }
      catch (error) { pauses.set(entry.id, reason(error)) }
    }
    if (pauses.size) return this.mutate(snapshot, async record => {
      for (const entry of record.entries) if (pauses.has(entry.id)) {
        entry.status = 'paused'; entry.reason = pauses.get(entry.id)!; entry.version++; entry.updatedAt = new Date().toISOString()
      }
      return structuredClone(record.entries)
    })
    return snapshot.record.entries
  }
  async validatedEntries(): Promise<MemoryEntry[]> { return (await this.list()).filter(e => e.status === 'active') }
  async validateDependency(dependency: MemoryDependency): Promise<boolean> {
    try { return (await this.validatedEntries()).some(e => e.id === dependency.id && e.version === dependency.version) } catch { return false }
  }
  private async verifyEntry(entry: MemoryEntry, record: MemoryRecord, seen: Set<string>): Promise<void> {
    if (seen.has(entry.id) || entry.status !== 'active') throw new Error('MEMORY_DEPENDENCY_CHANGED')
    const nextSeen = new Set(seen).add(entry.id)
    for (const source of entry.sources) await verifyMemorySource(source, this.access.source, async (id, version) => {
      const dependency = record.entries.find(e => e.id === id && e.version === version && e.status === 'active')
      if (!dependency || record.forgotten.some(f => f.id === id && f.throughVersion >= version)) return false
      try { await this.verifyEntry(dependency, record, nextSeen); return true } catch { return false }
    })
  }
  async createManualSource(request: ManualMemorySourceRequest): Promise<MemorySource> {
    await this.access.ready()
    const source = await createManualMemorySource(request, this.access.source)
    this.issued.set(source, JSON.stringify(source)); return source
  }
  async verifySource(source: MemorySource): Promise<boolean> {
    try { await this.access.ready(); await verifyMemorySource(source, this.access.source, (id, version) => this.validateDependency({ id, version })); return true } catch { return false }
  }
  private async mutate<T>(expected: MemorySnapshot, operation: (record: MemoryRecord) => Promise<T>, manageRecovery = false): Promise<T> {
    await this.access.ready(manageRecovery)
    return this.access.run(async () => {
      const { snapshot, disk } = this.read(manageRecovery)
      if (snapshot.sessionId !== expected.sessionId || snapshot.vaultKey !== expected.vaultKey) throw new Error('STALE_SESSION')
      if (snapshot.objectVersion !== expected.objectVersion || snapshot.revision !== expected.revision) throw new Error('MEMORY_CONFLICT')
      const result = await operation(snapshot.record)
      this.commit(snapshot.record, disk)
      return result
    }, manageRecovery)
  }
  private commit(record: MemoryRecord, disk: { raw: string; objectVersion: string } | null): void {
    const context = this.access.context(); const raw = JSON.stringify(record) + '\n'
    parseMemoryRecord(raw)
    const objectVersion = this.access.replace(disk, raw)
    try { this.access.pins.set(context.vaultKey, { objectVersion, revision: memoryHash(raw) }) }
    catch (error) { this.failure = `MEMORY_PIN_FAILED:${reason(error)}`; throw new Error(this.failure) }
  }
  async remember(expected: MemorySnapshot, input: { content: string; layer: MemoryEntry['layer']; scope: string; sources: MemorySource[]; explicit: boolean }): Promise<MemoryEntry> {
    const result = await this.mutate(expected, async record => {
      if (!input.sources.length || input.sources.some(s => this.issued.get(s) !== JSON.stringify(s))) throw new Error('MEMORY_SOURCE_NOT_VERIFIED')
      const sources = structuredClone(input.sources)
      for (const source of sources) {
        const current = await this.access.source(source.relPath)
        if (current.revision !== source.revision || current.objectVersion !== source.objectVersion) throw new Error('MEMORY_SOURCE_CHANGED')
      }
      const candidate: MemoryEntry = { id: randomUUID(), version: 1, content: input.content, layer: input.layer, scope: input.scope, sources, status: 'active', reason: null, updatedAt: new Date().toISOString(), updateBasis: { kind: 'manual', id: randomUUID(), version: 1 } }
      await this.verifyEntry(candidate, record, new Set())
      if (!input.explicit && sources.some(s => record.forgotten.some(f => f.basisHashes.includes(s.basisHash)))) throw new Error('MEMORY_FORGOTTEN_BASIS')
      const entry: MemoryEntry = { id: randomUUID(), version: 1, content: input.content, layer: input.layer, scope: input.scope, sources, status: input.explicit ? 'active' : 'pending', reason: input.explicit ? null : 'MEMORY_CONFIRMATION_REQUIRED', updatedAt: new Date().toISOString(), updateBasis: { kind: 'manual', id: randomUUID(), version: 1 } }
      record.entries.push(entry); return structuredClone(entry)
    })
    for (const source of input.sources) this.issued.delete(source)
    return result
  }
  async edit(expected: MemorySnapshot, id: string, version: number, changes: Partial<Pick<MemoryEntry, 'content' | 'layer' | 'scope'>>): Promise<MemoryEntry> {
    return this.mutate(expected, async record => {
      const entry = findEntry(record, id, version)
      if (Object.keys(changes).some(key => !['content', 'layer', 'scope'].includes(key))) throw new Error('BAD_MEMORY_EDIT')
      Object.assign(entry, changes); entry.version++; entry.updatedAt = new Date().toISOString(); entry.updateBasis = { kind: 'manual', id: randomUUID(), version: 1 }
      return structuredClone(entry)
    })
  }
  async forget(expected: MemorySnapshot, id: string, version: number): Promise<void> {
    await this.mutate(expected, async record => {
      const entry = findEntry(record, id, version)
      record.forgotten.push({ id, throughVersion: version, basisHashes: entry.sources.map(s => s.basisHash), contentHash: memoryHash(entry.content), forgottenAt: new Date().toISOString() })
      record.entries = record.entries.filter(e => e.id !== id)
    }, true)
    if (!(await this.managementSnapshot()).record.entries.length) this.failure = null
  }
  async toggle(expected: MemorySnapshot, id: string, version: number, enabled: boolean): Promise<void> {
    await this.mutate(expected, async record => {
      const entry = findEntry(record, id, version)
      if (enabled) { entry.status = 'active'; await this.verifyEntry(entry, record, new Set()) }
      else entry.status = 'disabled'
      entry.reason = null; entry.version++; entry.updatedAt = new Date().toISOString()
    })
  }
  async resume(expected: MemorySnapshot, id: string, version: number): Promise<void> { return this.toggle(expected, id, version, true) }

  /** Called by VaultSession while its queue is already held. Never requeue here. */
  async onCommittedWrite(write: CommittedNoteWrite): Promise<void> {
    try {
      const { snapshot, disk } = this.read(); if (!disk) return
      let changed = false
      for (const entry of snapshot.record.entries) for (const source of entry.sources) {
        if (source.relPath === write.previousPath && source.objectVersion === write.previousObjectVersion) {
          changed = true
          try { Object.assign(source, continueMemorySource(source, write.content), { relPath: write.relPath, objectVersion: write.objectVersion }) }
          catch (error) { source.relPath = write.relPath; source.objectVersion = write.objectVersion; source.revision = memoryHash(write.content); entry.status = 'paused'; entry.reason = reason(error) }
        }
        for (const dep of source.sourceDeps) if (dep.relPath === write.previousPath && dep.objectVersion === write.previousObjectVersion) {
          changed = true
          if (bodyFingerprint(write.content) === dep.bodyHash) { dep.relPath = write.relPath; dep.objectVersion = write.objectVersion }
          else { dep.relPath = write.relPath; dep.objectVersion = write.objectVersion; entry.status = 'paused'; entry.reason = 'MEMORY_DEPENDENCY_CHANGED' }
        }
      }
      if (changed) this.commit(snapshot.record, disk)
    } catch (error) { this.failure = reason(error) }
  }
  /** Final verified relocation hook; failure keeps lifecycle recovery state on disk. */
  async onVerifiedRelocation(receipt: VerifiedRelocation): Promise<void> {
    this.access.context()
    if (!this.access.read()) return
    const { snapshot, disk } = this.read()
    if (!disk) return
    const before = JSON.stringify(snapshot.record)
    if (receipt.sessionId !== snapshot.sessionId) throw new Error('STALE_SESSION')
    let uncertain = false
    for (const entry of snapshot.record.entries) for (const source of entry.sources) {
      for (const target of [source, ...source.sourceDeps]) {
        const object = receipt.objects.find(o => o.from === target.relPath && o.previousObjectVersion === target.objectVersion)
        if (!object) continue
        if (!object.identityProven) { entry.status = 'paused'; entry.reason = 'MEMORY_RELOCATION_IDENTITY_UNKNOWN'; uncertain = true; continue }
        target.relPath = object.to; target.objectVersion = object.objectVersion
      }
    }
    for (const entry of snapshot.record.entries) if (entry.status === 'active') {
      try { await this.verifyEntry(entry, snapshot.record, new Set()) }
      catch (error) { entry.status = 'paused'; entry.reason = reason(error) }
    }
    if (!uncertain && !snapshot.record.relocations.includes(receipt.operationId)) snapshot.record.relocations.push(receipt.operationId)
    if (JSON.stringify(snapshot.record) !== before) this.commit(snapshot.record, disk)
    if (uncertain) throw new Error('MEMORY_RELOCATION_IDENTITY_UNKNOWN')
  }
}
function findEntry(record: MemoryRecord, id: string, version: number): MemoryEntry {
  const entry = record.entries.find(e => e.id === id)
  if (!entry || entry.version !== version) throw new Error('MEMORY_CONFLICT')
  return entry
}
function reason(error: unknown): string { return error instanceof Error ? error.message : 'MEMORY_UNAVAILABLE' }

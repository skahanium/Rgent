import { randomUUID } from 'node:crypto'
import type { MemoryContext, MemoryDependency, MemoryEntry, MemoryRecord, MemorySnapshot, MemorySource, MemoryStatus, MemoryStorePinPort, MemoryJobMaterial, MemoryJobReceipt, MemoryProposal } from '../shared/memory.ts'
import type { CommittedNoteWrite, VerifiedRelocation } from './vault-lifecycle.ts'
import type { SavedTaskMaterial, SentFragment } from './host-material.ts'
import { compile } from '../markdown/index.ts'
import { ledgerChapters, ledgerTaskFields } from './host-context.ts'
import { memoryDependency, sameMemoryDependency } from './memory-use.ts'
import { bodyFingerprint } from './ledger-provenance.ts'
import { analyzeMemorySource, continueMemorySource, createManualMemorySource, memoryHash, uniqueLedgerMemoryRange, uniqueMemoryRange, verifyMemorySource, type ManualMemorySourceRequest, type MemorySourceReader } from './memory-source.ts'

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
  acceptsObject?(relPath: string, expected: string, current: string): boolean
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
  if (!v || typeof v !== 'object' || !fields(v, ['id', 'version', 'relPath', 'objectVersion', 'revision', 'permissionTier', 'kind', 'taskId', 'taskMaterialHash', 'classification', 'start', 'end', 'text', 'hash', 'basisHash', 'sourceDeps', 'memoryDeps', ...('basisGroups' in v ? ['basisGroups'] : [])])) return false
  if(v.basisGroups!==undefined && (!Array.isArray(v.basisGroups)||!v.basisGroups.length||v.basisGroups.length>128||!v.basisGroups.every(hash)))return false
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
  return !!v && typeof v === 'object' && fields(v, ['id', 'version', 'content', 'layer', 'scope', 'sources', 'status', 'reason', 'updatedAt', 'updateBasis', ...('pendingTarget' in v ? ['pendingTarget'] : [])]) &&
    (v.pendingTarget === undefined || dependency(v.pendingTarget)) &&
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
  if (!v || typeof v !== 'object' || !fields(v, ['taskId','materialVersion','outcome','entryIds',...('reason' in v ? ['reason'] : []),...('material' in v ? ['material'] : [])])) return false
  return id(v.taskId) && hash(v.materialVersion) && ['queued','running','applied','rejected','interrupted'].includes(String(v.outcome)) &&
    Array.isArray(v.entryIds) && v.entryIds.every(id) && (v.reason === undefined || bounded(v.reason)) && (v.material === undefined || validJobMaterial(v.material))
}
function validJobMaterial(v: unknown): v is MemoryJobMaterial {
  return fields(v,['sources','related','result','status','reason','omitted']) && Array.isArray(v.sources) && v.sources.length <= 128 && v.sources.every(validSource) &&
    new Set(v.sources.map(s=>s.id)).size === v.sources.length && Array.isArray(v.related) && v.related.length <= 1000 && v.related.every(dependency) &&
    new Set(v.related.map(d=>d.id)).size === v.related.length && typeof v.result === 'string' && Buffer.byteLength(v.result) <= 4096 &&
    ['completed','cancelled','failed','limit'].includes(String(v.status)) && (v.reason === null || bounded(v.reason)) && typeof v.omitted === 'boolean' && Buffer.byteLength(JSON.stringify(v)) <= 32768
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
  private readonly captured = new WeakMap<MemoryJobMaterial, { context: MemoryContext; forgotten: string; payload: string }>()
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
  /** One operation sees one checked snapshot per source; never retained across uses or commits. */
  private sourceBatch(): MemorySourceReader {
    const sources = new Map<string, ReturnType<MemorySourceReader>>()
    return path => {
      let reading = sources.get(path)
      if (!reading) { reading = this.access.source(path).then(snapshot => ({...snapshot,analysis:analyzeMemorySource(snapshot.content)})); sources.set(path,reading) }
      return reading
    }
  }
  private async readEntries(ids?: readonly string[]): Promise<MemoryEntry[]> {
    if (ids && (ids.length > 1000 || !ids.every(id))) throw Error('MEMORY_DEPENDENCY_INVALID')
    const selected = ids ? new Set(ids) : null
    const select = (entries: MemoryEntry[]) => selected ? entries.filter(entry => selected.has(entry.id)) : entries
    const snapshot = await this.snapshot()
    const pauses = new Map<string, string>()
    const verified = new Map<string, Promise<void>>(), read = this.sourceBatch()
    for (const entry of select(snapshot.record.entries)) if (entry.status === 'active') {
      try { await this.verifyEntry(entry, snapshot.record, new Set(), verified, read) }
      catch (error) { pauses.set(entry.id, reason(error)) }
    }
    // Persist every failure actually observed in this dependency walk, including unselected parents.
    // Otherwise restoring a failed parent's bytes could silently reactivate its old version.
    for (const [entryId, checking] of verified) {
      try { await checking } catch (error) { pauses.set(entryId, reason(error)) }
    }
    if (pauses.size) return this.mutate(snapshot, async record => {
      for (const entry of record.entries) if (pauses.has(entry.id)) {
        entry.status = 'paused'; entry.reason = pauses.get(entry.id)!; entry.version++; entry.updatedAt = new Date().toISOString()
      }
      return structuredClone(select(record.entries))
    })
    const after = await this.snapshot()
    if (after.revision !== snapshot.revision || after.objectVersion !== snapshot.objectVersion) throw Error('MEMORY_CONFLICT')
    return select(snapshot.record.entries)
  }
  async list(): Promise<MemoryEntry[]> { return this.readEntries() }
  /** IDs are entry identities, never caller-supplied source paths. Each operation uses a fresh snapshot/CAS. */
  async validatedEntries(ids?: readonly string[]): Promise<MemoryEntry[]> { return (await this.readEntries(ids)).filter(e => e.status === 'active') }
  async validateDependency(dependency: MemoryDependency): Promise<boolean> {
    try { return (await this.validatedEntries([dependency.id])).some(e => e.id === dependency.id && e.version === dependency.version) } catch { return false }
  }
  private async verifyEntry(entry: MemoryEntry, record: MemoryRecord, seen: Set<string>, memo = new Map<string, Promise<void>>(), read = this.sourceBatch()): Promise<void> {
    if (seen.has(entry.id) || entry.status !== 'active') throw new Error('MEMORY_DEPENDENCY_CHANGED')
    const cached = memo.get(entry.id)
    if (cached) return cached
    const nextSeen = new Set(seen).add(entry.id)
    const checking = (async () => {
      for (const source of entry.sources) await verifyMemorySource(source, read, async (id, version) => {
        const dependency = record.entries.find(e => e.id === id && e.version === version && e.status === 'active')
        if (!dependency || record.forgotten.some(f => f.id === id && f.throughVersion >= version)) return false
        try { await this.verifyEntry(dependency, record, nextSeen, memo, read); return true } catch { return false }
      })
    })()
    memo.set(entry.id, checking)
    return checking
  }
  async createManualSource(request: ManualMemorySourceRequest): Promise<MemorySource> {
    await this.access.ready()
    const snapshot = await this.snapshot(), memo = new Map<string, Promise<void>>(), read = this.sourceBatch()
    const source = await createManualMemorySource(request, read, async dep => {
      const entry = snapshot.record.entries.find(e => e.id === dep.id && e.version === dep.version)
      if (!entry || !sameMemoryDependency(dep, memoryDependency(entry))) return false
      try { await this.verifyEntry(entry, snapshot.record, new Set(), memo, read); return true } catch { return false }
    })
    const after = await this.snapshot()
    if (after.revision !== snapshot.revision || after.objectVersion !== snapshot.objectVersion) throw Error('MEMORY_CONFLICT')
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
  private async currentMutation<T>(operation: (record: MemoryRecord) => Promise<T>): Promise<T> {
    await this.access.ready()
    return this.access.run(async () => {
      const {snapshot,disk}=this.read()
      const result=await operation(snapshot.record)
      this.commit(snapshot.record,disk)
      return result
    })
  }
  /** Only successful Host evidence enters here. Reading is local source verification, not model scope. */
  async captureTaskMaterial(material: SavedTaskMaterial): Promise<MemoryJobMaterial> {
    const context=this.access.context()
    if (!material.context || material.context.sessionId !== context.sessionId || material.context.vaultKey !== context.vaultKey) throw Error('MEMORY_PERMISSION_CHANGED')
    // Read before the first material read/await: forgetting during capture must also
    // invalidate unproven result copies. This proof never crosses process or disk.
    const forgotten=memoryHash(JSON.stringify(this.read().snapshot.record.forgotten))
    const current=await this.access.source(material.origin.relPath)
    if (!this.sameObject(material.origin.relPath,material.origin.objectVersion,current.objectVersion)) throw Error('MEMORY_SOURCE_REPLACED')
    const chapter=ledgerChapters(compile(current.content).partition.ledger).filter(c=>c.taskId===material.taskId)
    if(chapter.length!==1 || memoryHash(chapter[0]!.text.trimEnd())!==material.ledgerHash)throw Error('SAVED_MATERIAL_CHANGED')
    const fields=ledgerTaskFields(chapter[0]!.text)
    if(fields.status!=='valid' || fields.prompt.text.trim()!==material.prompt.trim())throw Error('MEMORY_SOURCE_AMBIGUOUS')
    const payload:MemoryJobMaterial={sources:[],related:[],result:'',status:material.status,reason:material.reason?.slice(0,512) ?? null,omitted:material.material.truncated}
    const entries=await this.validatedEntries(material.memoryDeps.map(d=>d.id))
    for(const dep of material.memoryDeps){const entry=entries.find(e=>e.id===dep.id);if(!entry || !sameMemoryDependency(dep,memoryDependency(entry)))throw Error('MEMORY_DEPENDENCY_CHANGED');payload.related.push({id:dep.id,version:dep.version})}
    const add = async (fragment:SentFragment) => {
      if(fragment.classification==='ai')return
      const now=await this.access.source(fragment.relPath)
      if(!fragment.permissionTier || now.permissionTier==='forbidden' || fragment.permissionTier==='reference'&&now.permissionTier!=='reference')throw Error('MEMORY_SOURCE_PERMISSION')
      if(fragment.sessionId!==context.sessionId || !this.sameObject(fragment.relPath,fragment.objectVersion,now.objectVersion))throw Error('MEMORY_SOURCE_REPLACED')
      const corpus=fragment.kind==='body'?compile(now.content).partition.body:ledgerChapters(compile(now.content).partition.ledger).find(c=>c.taskId===fragment.taskId)?.text
      if(corpus===undefined || memoryHash(fragment.text)!==fragment.hash)throw Error('MEMORY_SOURCE_CHANGED')
      const locate=(text:string)=>fragment.kind==='ledger'?uniqueLedgerMemoryRange(corpus,text,'command'):uniqueMemoryRange(corpus,text)
      const full=locate(fragment.text)
      for(const piece of splitMemoryText(fragment.text)){
        const range=locate(piece.text)
        if(range.start<full.start || range.end>full.end)throw Error('MEMORY_SOURCE_CHANGED')
        const source=await this.createManualSource({...now,relPath:fragment.relPath,kind:fragment.kind,...(fragment.taskId?{taskId:fragment.taskId}:{}),...range})
        if(source.classification!==fragment.classification)throw Error('MEMORY_SOURCE_IDENTITY_CHANGED')
        for(const dep of fragment.memoryDeps){const entry=(await this.validatedEntries([dep.id])).find(e=>e.id===dep.id);if(!entry || !sameMemoryDependency(dep,memoryDependency(entry)))throw Error('MEMORY_DEPENDENCY_CHANGED');if(!payload.related.some(d=>d.id===dep.id))payload.related.push({id:dep.id,version:dep.version})}
        for(const dep of fragment.sourceDeps.filter(dep=>dep.relPath!==fragment.relPath)){
          const other=await this.access.source(dep.relPath)
          if(other.permissionTier==='forbidden' || !this.sameObject(dep.relPath,dep.objectVersion,other.objectVersion) || bodyFingerprint(other.content)!==dep.bodyHash)throw Error('MEMORY_DEPENDENCY_CHANGED')
          if(!source.sourceDeps.some(d=>d.relPath===dep.relPath))source.sourceDeps.push({...dep,objectVersion:other.objectVersion,permissionTier:other.permissionTier})
        }
        // Human fragments keep any actual inherited dependencies; model labels cannot erase them.
        source.memoryDeps=[...new Map([...source.memoryDeps,...fragment.memoryDeps.map(d=>({id:d.id,version:d.version}))].map(d=>[d.id,d])).values()]
        if(payload.sources.some(s=>s.basisHash===source.basisHash))continue
        if(payload.sources.length>=128 || Buffer.byteLength(JSON.stringify({...payload,sources:[...payload.sources,source]}))>28000){payload.omitted=true;continue}
        payload.sources.push(source)
      }
    }
    await add({...material.origin,objectVersion:current.objectVersion,revision:current.revision,kind:'ledger',permissionTier:'reference',classification:'command',taskId:material.taskId,start:fields.prompt.start,end:fields.prompt.end,text:fields.prompt.text,hash:memoryHash(fields.prompt.text),sourceDeps:material.sourceDeps,memoryDeps:material.memoryDeps})
    for(const fragment of material.material.fragments) {
      if(fragment.classification==='command'&&fragment.taskId===material.taskId&&fragment.relPath===material.origin.relPath)continue
      await add(fragment)
    }
    // Partial AI is explicitly unconfirmed and is never a source/citation.
    payload.result=boundedMemoryText(material.answer,4096);if(payload.result!==material.answer)payload.omitted=true
    if(!validJobMaterial(payload))throw Error('MEMORY_INPUT_LIMIT')
    this.captured.set(payload,{context:{...context},forgotten,payload:memoryHash(JSON.stringify(payload))})
    return payload
  }
  private sameObject(path:string,expected:string,current:string):boolean {return expected===current || !!this.access.acceptsObject?.(path,expected,current)}
  async enqueueJob(taskId:string,materialVersion:string,material:MemoryJobMaterial,guard:()=>void):Promise<boolean>{
    return this.currentMutation(async record=>{guard();if(record.jobs.some(j=>j.taskId===taskId&&j.materialVersion===materialVersion))return false
      if(material.result){
        const proof=this.captured.get(material),context=this.access.context()
        if(!proof || proof.context.sessionId!==context.sessionId || proof.context.vaultKey!==context.vaultKey || proof.payload!==memoryHash(JSON.stringify(material)))throw Error('MEMORY_MATERIAL_UNVERIFIED')
        if(proof.forgotten!==memoryHash(JSON.stringify(record.forgotten)))throw Error('MEMORY_MATERIAL_FORGOTTEN')
      }
      const continued=structuredClone(material),read=this.sourceBatch()
      // Capture is outside this queue. Only Vault's native successful-save chain can
      // bridge that gap; identical bytes alone never establish object succession.
      for(const source of continued.sources){
        const current=await read(source.relPath)
        if(source.objectVersion!==current.objectVersion){
          if(!this.sameObject(source.relPath,source.objectVersion,current.objectVersion))throw Error('MEMORY_SOURCE_REPLACED')
          Object.assign(source,continueMemorySource(source,current.content,current.analysis),{objectVersion:current.objectVersion})
        }
        for(const dep of source.sourceDeps){
          const other=await read(dep.relPath)
          if(dep.objectVersion!==other.objectVersion){
            if(!this.sameObject(dep.relPath,dep.objectVersion,other.objectVersion) || bodyFingerprint(other.content,other.analysis?.parsed)!==dep.bodyHash)throw Error('MEMORY_DEPENDENCY_CHANGED')
            dep.objectVersion=other.objectVersion
          }
        }
      }
      await this.verifyJobMaterial(continued,record);guard();record.jobs.push({taskId,materialVersion,outcome:'queued',entryIds:[],material:continued});return true})
  }
  private async verifyJobMaterial(material:MemoryJobMaterial,record:MemoryRecord):Promise<void>{
    const verified=new Map<string,Promise<void>>(),read=this.sourceBatch()
    for(const dep of material.related){const entry=record.entries.find(e=>e.id===dep.id&&e.version===dep.version);if(!entry)throw Error('MEMORY_DEPENDENCY_CHANGED');await this.verifyEntry(entry,record,new Set(),verified,read)}
    for(const source of material.sources){if(record.forgotten.some(f=>sourceBases(source).some(b=>f.basisHashes.includes(b))))throw Error('MEMORY_FORGOTTEN_BASIS');await verifyMemorySource(source,read,async(id,version)=>{const e=record.entries.find(e=>e.id===id&&e.version===version);if(!e)return false;try{await this.verifyEntry(e,record,new Set(),verified,read);return true}catch{return false}})}
  }
  async job(taskId:string,materialVersion:string):Promise<MemoryJobReceipt>{
    const snapshot=await this.snapshot(),job=snapshot.record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion)
    if(!job)throw Error('MEMORY_JOB_MISSING');if(!job.material)throw Error(job.reason==='MEMORY_MATERIAL_FORGOTTEN'?job.reason:'MEMORY_MATERIAL_UNAVAILABLE');await this.verifyJobMaterial(job.material,snapshot.record);return structuredClone(job)
  }
  async jobOutcome(taskId:string,materialVersion:string,outcome:MemoryJobReceipt['outcome'],reason?:string):Promise<void>{
    await this.currentMutation(async record=>{const j=record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion);if(!j)throw Error('MEMORY_JOB_MISSING');if(j.outcome==='applied'||j.reason==='MEMORY_MATERIAL_FORGOTTEN'&&!j.material)return;j.outcome=outcome;if(reason)j.reason=reason.slice(0,512);else delete j.reason})
  }
  async rejectJob(taskId:string,materialVersion:string,reason:string):Promise<void>{
    await this.currentMutation(async record=>{let job=record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion);if(job?.outcome==='applied'||job?.reason==='MEMORY_MATERIAL_FORGOTTEN'&&!job.material)return;if(!job){job={taskId,materialVersion,outcome:'rejected',entryIds:[]};record.jobs.push(job)}job.outcome='rejected';job.reason=reason.slice(0,512)})
  }
  async requeueJob(taskId:string,materialVersion:string,guard:()=>void):Promise<void>{
    await this.currentMutation(async record=>{guard();const job=record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion);if(!job?.material)throw Error(job?.reason==='MEMORY_MATERIAL_FORGOTTEN'?job.reason:'MEMORY_MATERIAL_UNAVAILABLE');if(!['interrupted','rejected'].includes(job.outcome))throw Error('MEMORY_JOB_STALE');await this.verifyJobMaterial(job.material,record);guard();job.outcome='queued';delete job.reason})
  }
  async interruptJobs():Promise<void>{
    const snapshot=await this.snapshot();if(!snapshot.record.jobs.some(j=>j.outcome==='queued'||j.outcome==='running'))return
    await this.currentMutation(async record=>{for(const j of record.jobs)if(j.outcome==='queued'||j.outcome==='running'){j.outcome='interrupted';j.reason='MEMORY_RESTARTED'}})
  }
  async applyJob(taskId:string,materialVersion:string,proposals:MemoryProposal[],guard:()=>void):Promise<string[]>{
    return this.currentMutation(async record=>{
      guard();const job=record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion)
      if(!job?.material || job.outcome!=='running')throw Error('MEMORY_JOB_STALE')
      await this.verifyJobMaterial(job.material,record);const ids:string[]=[]
      for(const proposal of proposals){
        const cited=proposal.citations.map(id=>job.material!.sources.find(s=>s.id===id))
        if(cited.some(s=>!s) || !cited.length)throw Error('MEMORY_CITATION_INVALID')
        const sources=cited as MemorySource[]
        if(!eligibleMemoryProposal(proposal,sources))throw Error('MEMORY_CATEGORY_INVALID')
        if(record.forgotten.some(f=>sources.some(s=>sourceBases(s).some(b=>f.basisHashes.includes(b)))))throw Error('MEMORY_FORGOTTEN_BASIS')
        const target=proposal.target?findEntry(record,proposal.target.id,proposal.target.version):null
        if(target && target.status!=='active')throw Error('MEMORY_CONFLICT')
        if(proposal.action==='update'&&!target || proposal.action==='add'&&target)throw Error('MEMORY_PROPOSAL_INVALID')
        if(target && !job.material.related.some(d=>d.id===target.id&&d.version===target.version))throw Error('MEMORY_TARGET_INVALID')
        const duplicate=record.entries.find(e=>e.status==='active'&&normalizeMemory(e.content)===normalizeMemory(proposal.content))
        if(duplicate && !target){duplicate.updatedAt=new Date().toISOString();ids.push(duplicate.id);continue}
        if(target && proposal.category==='correction'){
          const oldBases=new Set(target.sources.flatMap(sourceBases))
          if(!sources.some(source=>!sourceBases(source).some(b=>oldBases.has(b))))throw Error('MEMORY_CORRECTION_BASIS')
          // Preserve established bases, without introducing a self dependency on the superseded version.
          const merged=[...new Map([...target.sources,...sources].map(s=>[s.id,structuredClone(s)])).values()]
          for(const source of merged)source.memoryDeps=source.memoryDeps.filter(d=>d.id!==target.id)
          if(merged.length>16)throw Error('MEMORY_SOURCE_LIMIT')
          Object.assign(target,{content:proposal.content,layer:proposal.layer,scope:proposal.scope,sources:merged,version:target.version+1,updatedAt:new Date().toISOString(),updateBasis:{kind:'consolidation',id:taskId,version:1}});ids.push(target.id)
        }else{
          const pending=!!target || proposal.category==='ambiguous'
          const entry:MemoryEntry={id:randomUUID(),version:1,content:proposal.content,layer:proposal.layer,scope:proposal.scope,sources:structuredClone(sources),status:pending?'pending':'active',reason:pending?'MEMORY_CONFIRMATION_REQUIRED':null,updatedAt:new Date().toISOString(),updateBasis:{kind:'consolidation',id:taskId,version:1},...(target?{pendingTarget:{id:target.id,version:target.version}}:{})}
          record.entries.push(entry);ids.push(entry.id)
        }
      }
      // A proposal batch cannot commit dangling/self dependencies or silently replace a human revision.
      for(const id of ids){const entry=record.entries.find(e=>e.id===id)!;if(entry.status==='active')await this.verifyEntry(entry,record,new Set())}
      guard();job.outcome='applied';job.entryIds=ids;delete job.reason;delete job.material;return ids
    })
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
      if (!input.explicit && sources.some(s => record.forgotten.some(f => sourceBases(s).some(b=>f.basisHashes.includes(b))))) throw new Error('MEMORY_FORGOTTEN_BASIS')
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
      record.forgotten.push({ id, throughVersion: version, basisHashes: entry.sources.flatMap(sourceBases), contentHash: memoryHash(entry.content), forgottenAt: new Date().toISOString() })
      const removed=new Set([id]),removedBases=new Set(entry.sources.flatMap(sourceBases));let changed=true
      while(changed){changed=false;for(const other of record.entries)if(!removed.has(other.id)&&(other.pendingTarget && removed.has(other.pendingTarget.id) || other.sources.some(s=>sourceBases(s).some(b=>removedBases.has(b))||s.memoryDeps.some(d=>removed.has(d.id))))){removed.add(other.id);for(const b of other.sources.flatMap(sourceBases))removedBases.add(b);changed=true}}
      for(const other of record.entries)if(other.id!==id&&removed.has(other.id))record.forgotten.push({id:other.id,throughVersion:other.version,basisHashes:other.sources.flatMap(sourceBases),contentHash:memoryHash(other.content),forgottenAt:new Date().toISOString()})
      const bases=new Set(record.forgotten.flatMap(f=>f.basisHashes))
      record.entries=record.entries.filter(e=>!removed.has(e.id))
      // Results have no independently revocable source proof (including legacy jobs).
      // We cannot prove them unrelated to a forgotten fact, so discard their entire
      // retry payload conservatively; original notes and unrelated entries stay intact.
      for(const job of record.jobs)if(job.material && (job.material.result.length>0 || job.material.related.some(d=>removed.has(d.id)) || job.material.sources.some(s=>sourceBases(s).some(b=>bases.has(b))||s.memoryDeps.some(d=>removed.has(d.id))))){delete job.material;job.outcome='rejected';job.reason='MEMORY_MATERIAL_FORGOTTEN'}
    }, true)
    if (!(await this.managementSnapshot()).record.entries.length) this.failure = null
  }
  async toggle(expected: MemorySnapshot, id: string, version: number, enabled: boolean): Promise<void> {
    await this.mutate(expected, async record => {
      const entry = findEntry(record, id, version)
      if (enabled && entry.pendingTarget) throw Error('MEMORY_CONFIRMATION_REQUIRED')
      if (enabled) { entry.status = 'active'; await this.verifyEntry(entry, record, new Set()) }
      else entry.status = 'disabled'
      entry.reason = null; entry.version++; entry.updatedAt = new Date().toISOString()
    })
  }
  /** Explicit human conflict confirmation, bound to both visible versions. Never used by the model. */
  async confirmPending(expected:MemorySnapshot,id:string,version:number,targetVersion:MemoryDependency):Promise<MemoryEntry>{
    return this.mutate(expected,async record=>{
      const pending=findEntry(record,id,version)
      if(pending.status!=='pending'||!pending.pendingTarget||pending.pendingTarget.id!==targetVersion.id||pending.pendingTarget.version!==targetVersion.version)throw Error('MEMORY_CONFLICT')
      const target=findEntry(record,targetVersion.id,targetVersion.version)
      if(target.status!=='active')throw Error('MEMORY_CONFLICT')
      const sources=[...new Map([...target.sources,...pending.sources].map(s=>[s.id,structuredClone(s)])).values()]
      for(const source of sources)source.memoryDeps=source.memoryDeps.filter(d=>d.id!==target.id)
      if(sources.length>16)throw Error('MEMORY_SOURCE_LIMIT')
      Object.assign(target,{content:pending.content,scope:pending.scope,layer:pending.layer,sources,version:target.version+1,updatedAt:new Date().toISOString(),updateBasis:{kind:'manual',id:randomUUID(),version:1}})
      await this.verifyEntry(target,record,new Set())
      record.entries=record.entries.filter(e=>e.id!==pending.id)
      return structuredClone(target)
    })
  }
  async resume(expected: MemorySnapshot, id: string, version: number): Promise<void> { return this.toggle(expected, id, version, true) }

  /** Called by VaultSession while its queue is already held. Never requeue here. */
  async onCommittedWrite(write: CommittedNoteWrite): Promise<void> {
    try {
      const { snapshot, disk } = this.read(); if (!disk) return
      let changed = false
      const analysis = analyzeMemorySource(write.content), wholeHash = bodyFingerprint(write.content, analysis.parsed)
      for (const entry of snapshot.record.entries) for (const source of entry.sources) {
        if (source.relPath === write.previousPath && source.objectVersion === write.previousObjectVersion) {
          changed = true
          try { Object.assign(source, continueMemorySource(source, write.content, analysis), { relPath: write.relPath, objectVersion: write.objectVersion }) }
          catch (error) { source.relPath = write.relPath; source.objectVersion = write.objectVersion; source.revision = memoryHash(write.content); entry.status = 'paused'; entry.reason = reason(error) }
        }
        for (const dep of source.sourceDeps) if (dep.relPath === write.previousPath && dep.objectVersion === write.previousObjectVersion) {
          changed = true
          if (wholeHash === dep.bodyHash) { dep.relPath = write.relPath; dep.objectVersion = write.objectVersion }
          else { dep.relPath = write.relPath; dep.objectVersion = write.objectVersion; entry.status = 'paused'; entry.reason = 'MEMORY_DEPENDENCY_CHANGED' }
        }
      }
      for(const job of snapshot.record.jobs)if(job.material)for(const source of job.material.sources){
        if(source.relPath===write.previousPath&&source.objectVersion===write.previousObjectVersion){changed=true;try{Object.assign(source,continueMemorySource(source,write.content,analysis),{relPath:write.relPath,objectVersion:write.objectVersion})}catch(error){job.outcome='rejected';job.reason=reason(error);delete job.material;break}}
        for(const dep of source.sourceDeps)if(dep.relPath===write.previousPath&&dep.objectVersion===write.previousObjectVersion){changed=true;if(wholeHash===dep.bodyHash){dep.relPath=write.relPath;dep.objectVersion=write.objectVersion}else{job.outcome='rejected';job.reason='MEMORY_DEPENDENCY_CHANGED';delete job.material;break}}
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
    for(const job of snapshot.record.jobs)if(job.material)for(const source of job.material.sources)for(const target of [source,...source.sourceDeps]){
      const object=receipt.objects.find(o=>o.from===target.relPath&&o.previousObjectVersion===target.objectVersion)
      if(!object)continue
      if(!object.identityProven){job.outcome='interrupted';job.reason='MEMORY_RELOCATION_IDENTITY_UNKNOWN';delete job.material;uncertain=true;break}
      target.relPath=object.to;target.objectVersion=object.objectVersion
    }
    const verified = new Map<string, Promise<void>>(), read = this.sourceBatch()
    for (const entry of snapshot.record.entries) if (entry.status === 'active') {
      try { await this.verifyEntry(entry, snapshot.record, new Set(), verified, read) }
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

export function boundedMemoryText(value:string,limit:number):string{let result='';let size=0;for(const ch of value){const n=Buffer.byteLength(ch);if(size+n>limit)break;result+=ch;size+=n}return result}
function splitMemoryText(value:string):{text:string}[]{const out:{text:string}[]=[];let rest=value;while(rest){const text=boundedMemoryText(rest,4096);out.push({text});rest=rest.slice(text.length)}return out}
const normalizeMemory=(value:string)=>value.normalize('NFKC').replace(/\s+/gu,'').toLocaleLowerCase()
/** Conservative admission, based on main-process source roles, never on a model's claimed role. */
export function eligibleMemoryProposal(proposal:MemoryProposal,sources:MemorySource[]):boolean{
  if(sources.some(s=>s.classification==='adopted-ai'))return false
  const material=sources.map(s=>s.text).join('\n')
  if(/只(?:在|限|用)?这(?:一)?次|仅(?:本|这)次|临时|这一次|不要.*记住|不必.*记住|\b(?:only for (?:this|the current) (?:task|run|session)|just this (?:once|time)|temporar(?:y|ily))\b|\b(?:do not|don't|never)\s+(?:remember|store)/iu.test(material))return false
  // An explicit enduring writing rule may discuss uncertainty; that is not an asserted uncertain fact.
  const writingRule=/(?:以后|今后|始终|长期).{0,80}(?:回答|回复|写作|表达).{0,80}(?:请|不要|应当|必须|需要)/u.test(material)
  if(proposal.category==='lasting' && writingRule)return true
  if(/也许|猜测|可能|假设|未确认|不确定|\b(?:unconfirmed|uncertain|maybe|perhaps|guess|hypothetical)\b|\bnot\s+(?:yet\s+)?confirmed\b/iu.test(material))return false
  const lasting=/长期|以后|今后|始终|永久|记住|\b(?:remember|always)\b/iu.test(material)
  if(proposal.category==='lasting')return lasting
  if(proposal.category==='correction')return lasting&&/更正|纠正|改为|改成|不再|\b(?:correction|instead)\b/iu.test(material)
  if(proposal.category==='confirmed')return /已确认|确认：|确认:|我(?:的|是|住在|使用)|\bconfirmed\b/iu.test(material)
  return lasting || /确认|我(?:的|是)/u.test(material)
}

const sourceBases=(source:MemorySource):string[]=>[source.basisHash,...source.basisGroups ?? []]

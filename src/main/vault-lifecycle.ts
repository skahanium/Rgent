import { validOwner, validLedgerPublication, inspectLedgerPublication, recoverLedgerPublication, type LedgerPublication } from './ledger-store.ts'
import { applyMemoryRecovery, type MemoryRecoveryPatch } from './working-memory-store.ts'
import { vaultRootIdentity } from './watch.ts'
import { createHash, randomUUID } from 'node:crypto'
import { collectNotePaths, noteTitle } from '../shared/vault-rel.ts'
import { HUMAN_TRASH_ON_THIS_PLATFORM } from '../shared/human-trash.ts'
import { compile } from '../markdown/index.ts'
import { listVaultTree, readNoteSnapshot, revisionOf } from './notes-fs.ts'
import { effectivePermissionEntries, loadPermissionSnapshot, tierFor } from './permissions.ts'
import { hasHiddenSegment, isNotePath, resolveInVault } from './paths.ts'
import { secureFsFor } from './secure-fs.ts'
import { VaultMutationQueue } from './vault-mutation-queue.ts'
import type { LifecycleStatus } from '../shared/ipc.ts'

const JOURNAL = '.rgent-lifecycle'
const PERMISSIONS = '.rgent-permissions'

export type TrashPreview = {
  id: string
  sessionId: string
  relPath: string
  title: string
  objectVersion: string
  hasAttachments: boolean
  attachmentPath: string | null
  attachmentId: string | null
}
export type RelocationRequest = { kind: 'note' | 'folder'; source: string; target: string }
export type RelocationMove = { from: string; to: string; id: string }
export type LinkChange = { relPath: string; newPath: string; expectedRevision: string; expectedObjectVersion: string; changes: { start: number; end: number; before: string; after: string }[] }
export type RelocationPreview = {
  id: string
  sessionId: string
  kind: 'note' | 'folder'
  source: string
  target: string
  moves: RelocationMove[]
  linkChanges: LinkChange[]
  permissionChanges: { from: string; to: string; tier: string }[]
}
export type CommittedNoteWrite = { relPath: string; previousPath: string; previousObjectVersion: string; objectVersion: string; content: string }
export type VerifiedRelocation = {
  sessionId: string; operationId: string; journalRevision: string
  objects: { from: string; to: string; previousObjectVersion: string; objectVersion: string; identityProven: boolean }[]
}
type RepairReceipt = { relPath: string; previousPath: string; previousObjectVersion: string; objectVersion: string; revision: string }
type Fingerprint = { relPath: string; id: string; kind: string; hash?: string; repairedHash?: string }
type PendingMove = {
  kind: 'move'
  repairReceipts?: RepairReceipt[]
  intent: Pick<RelocationPreview, 'kind' | 'source' | 'target' | 'moves'>
  linkRepairs: { relPath: string; newPath: string; expectedRevision: string }[]
  fingerprints: Fingerprint[]
  permissionBefore: string | null
  permissionAfter: string | null
  repairLinks: boolean
}
export type RepairWrite={path:string;before:string|null;beforeId:string|null;after:string;receipt?:string}
export type MemoryRecoveryPlan={beforeHash:string;beforeId:string;afterHash:string;patches:MemoryRecoveryPatch[];receipt?:string}
export type PendingLedgerRepair={kind:'ledger-repair';rootIdentity:string;sessionId:string;mode:'rebuild'|'restore';fingerprints:Fingerprint[];writes:RepairWrite[];permissionRaw:string|null;memory?:MemoryRecoveryPlan}
/** 附件证据沿用登记记录（`LedgerOwner.recoveryEvidence`）的既有字段形状。 */
export type MissingAttachment = { relPath: string; kind: 'file' | 'dir'; hash?: string }
/** 外部消失（对象在库外被删或移走）的生命周期记录。字段取自既有登记：身份、内容哈希、
 *  附件证据与消失时的权限档。写在同一本 `.rgent-lifecycle` 的 version 1 信封里，不新增
 *  存储格式；不占用 `active`——`active` 仍是待恢复的中断，只由移动与账本恢复占用。 */
export type MissingObject = {
  relPath: string
  noteId: string
  objectVersion: string
  bodyRevision: string
  attachments: MissingAttachment[]
  rootIdentity: string
  /** `unknown` 只用于删除时权限名单不可读；恢复核验不会把它当成任何一档。 */
  permissionTier: import('../shared/ipc.ts').PermissionTier | 'unknown'
  detectedAt: string
}
type Journal = { version: 1; active: PendingMove | PendingLedgerRepair | LedgerPublication | null; missing?: MissingObject[] }
const MISSING_LIMIT = 64

function validPath(relPath: string, allowHidden = false): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || (!allowHidden && hasHiddenSegment(relPath))) return false
  if (process.platform === 'win32' && relPath.includes(':')) return false
  return relPath.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function parentOf(relPath: string): string { return relPath.split('/').slice(0, -1).join('/') }
function samePathOrChild(path: string, prefix: string): boolean { return path === prefix || path.startsWith(`${prefix}/`) }
function mapped(path: string, moves: readonly RelocationMove[]): string {
  const match = moves.find((move) => samePathOrChild(path, move.from))
  return match ? `${match.to}${path.slice(match.from.length)}` : path
}
function mappedLinkTarget(path: string, moves: readonly RelocationMove[]): string {
  if (path.toLowerCase().endsWith('.md')) return mapped(path, moves)
  const note = `${path}.md`
  const changed = mapped(note, moves)
  return changed === note ? path : changed.slice(0, -3)
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function asciiFold(value: string): string { return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) }

/** Main-process only. Preview tokens bind a structural change to verified disk objects. */
export class VaultLifecycle {
  /** Disk journal fields are recovery hints, not native-success identity evidence. */
  private readonly controlledRepairs = new Map<string, RepairReceipt>()
  private readonly previews = new Map<string, { view: RelocationPreview; fingerprints: Fingerprint[]; permissionBefore: string | null; permissionAfter: string | null }>()
  private readonly trashPreviews = new Map<string, TrashPreview>()

  constructor(private readonly root: string, private readonly queue = new VaultMutationQueue(),
    private readonly sessionId: string = randomUUID(), private readonly assertCurrent: () => void = () => {},
    private readonly onCommittedNoteWrite: (write: CommittedNoteWrite) => unknown = () => {},
    private readonly onVerifiedRelocation: (receipt: VerifiedRelocation) => Promise<void> = async () => {}) {}

  status(): LifecycleStatus {
    this.assertCurrent()
    const base: LifecycleStatus = { sessionId: this.sessionId, status: 'ready', revision: null, items: [] }
    let bytes: Buffer | null
    try { bytes = this.readJournalBytes() }
    catch { return { ...base, status: 'invalid', reason: 'journal-unreadable' } }
    if (bytes === null) return base
    base.revision = hash(bytes)
    let active: Journal['active']
    try { active = parseJournal(journalText(bytes)).active }
    catch { return { ...base, status: 'invalid', reason: 'journal-invalid' } }
    if (!active) return base
    if(active.kind==='ledger-publication'){let blocked=false;try{inspectLedgerPublication(secureFsFor(this.root),active,this.assertCurrent)}catch{blocked=true};return {...base,status:'pending',operation:{kind:'ledger-repair',source:active.relPath,target:active.relPath},reason:blocked?'object-changed':'recovery-required',items:active.writes.map(w=>({from:w.path,to:w.path,state:blocked?'blocked':w.receipt?'moved':'source'}))}}
    if(active.kind==='ledger-repair'){
      let blocked=false;try{this.verifyRepair(active)}catch{blocked=true}
      return {...base,status:'pending',operation:{kind:'ledger-repair',source:'',target:''},reason:blocked?'object-changed':'recovery-required',items:active.writes.map(w=>({from:w.path,to:w.path,state:blocked?'blocked':w.receipt?'moved':'source'}))}
    }
    const inspection = this.inspectObjects(active)
    let reason: LifecycleStatus['reason'] = inspection.blocked ? 'object-changed' : 'recovery-required'
    try { if (!this.policyMatches(active)) reason = 'policy-changed' }
    catch { reason = 'policy-changed' }
    return { ...base, status: 'pending', operation: {
      kind: active.intent.kind, source: active.intent.source, target: active.intent.target
    }, items: inspection.items, reason }
  }

  recoveryScope(revision: string): { moved: RelocationMove[]; relPaths: string[] } {
    this.assertCurrent()
    const { active } = this.journalAtRevision(revision)
    if (!active || active.kind!=='move') throw new Error('STALE_RECOVERY')
    return { moved: active.intent.moves, relPaths: [...new Set([
      ...active.intent.moves.flatMap((move) => [move.from, move.to]),
      ...active.linkRepairs.flatMap((link) => [link.relPath, link.newPath])
    ])] }
  }

  async retry(revision: string): Promise<{ moved: RelocationMove[]; unrepaired: string[] }> {
    return this.queue.run(() => {
      this.assertCurrent()
      const { active, raw } = this.journalAtRevision(revision)
      if (!active || active.kind!=='move' || raw === null) throw new Error('STALE_RECOVERY')
      return this.recoverMove(active, raw)
    })
  }

  private journalAtRevision(revision: string): Journal & { raw: string | null } {
    const bytes = this.readJournalBytes()
    if (bytes === null || hash(bytes) !== revision) throw new Error('STALE_RECOVERY')
    const raw = journalText(bytes)
    return { ...parseJournal(raw), raw }
  }

  peek(id: string): RelocationPreview | null { return this.previews.get(id)?.view ?? null }

  peekTrash(id: string): TrashPreview | null {
    const view = this.trashPreviews.get(id)
    return view ? structuredClone(view) : null
  }

  discardTrash(id: string): void { this.trashPreviews.delete(id) }

  /** 人删除预览：只接受一篇笔记。同名附件夹记为同一事务第二步。Windows 报 PLATFORM_UNPROVEN。 */
  previewTrash(relPath: string): TrashPreview {
    this.assertCurrent()
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) throw new Error('PLATFORM_UNPROVEN')
    if (this.loadJournal().active) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    if (!validPath(relPath) || !isNotePath(relPath) || !resolveInVault(this.root, relPath)) throw new Error('BAD_PATH')
    const fs = secureFsFor(this.root)
    const source = fs.resolve(relPath)
    if (source.at(-1)?.kind !== 'file') throw new Error('BAD_PATH')
    let attachmentPath: string | null = null
    let attachmentId: string | null = null
    const companion = relPath.slice(0, -3)
    try {
      const resolved = fs.resolve(companion)
      // 同名位置不是目录（普通文件／链接）时按「无附件夹」处理：它不是这次要送篓的附件夹，
      // 不该挡住笔记本身的删除，也不再报 ATTACHMENT_COLLISION。
      if (resolved.at(-1)?.kind === 'dir') {
        attachmentPath = companion
        attachmentId = resolved.at(-1)!.id
      }
    } catch (error) {
      // 笔记与它同一父目录已由上面核验；这里只剩同名对象本身不可解析（不存在／不是普通对象）。
      if (!(error instanceof Error && (error.message === 'ENOENT' || error.message === 'UNSAFE_PATH'))) throw error
    }
    const view: TrashPreview = {
      id: randomUUID(), sessionId: this.sessionId, relPath, title: noteTitle(relPath),
      objectVersion: source.at(-1)!.id, hasAttachments: attachmentPath !== null, attachmentPath, attachmentId
    }
    this.trashPreviews.clear()
    this.trashPreviews.set(view.id, view)
    return structuredClone(view)
  }

  /** 未核验的外部消失记录；只读，不改变 `active` 的中断语义。 */
  missingObjects(): MissingObject[] {
    this.assertCurrent()
    return (this.loadJournal().missing ?? []).map((item) => structuredClone(item))
  }

  /** 有记录的对象在核验通过前不继承身份：来源核验、任务绑定与写回一律失败关闭。 */
  hasMissing(relPath: string): boolean {
    this.assertCurrent()
    return (this.loadJournal().missing ?? []).some((item) => item.relPath === relPath)
  }

  /** 登记只按原字节 CAS 追加，不经过队列，也不覆盖既有记录（最早那次的外部消失证据保留）。 */
  recordMissing(entry: MissingObject): boolean {
    this.assertCurrent()
    if (!validMissing(entry)) throw new Error('BAD_REQUEST')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = this.readOptional(JOURNAL)
      const journal = parseJournal(raw)
      if (journal.active) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      const missing = journal.missing ?? []
      if (missing.some((item) => item.relPath === entry.relPath)) return false
      if (missing.length >= MISSING_LIMIT) throw new Error('MISSING_RECORD_LIMIT')
      try {
        this.saveJournal({ version: 1, active: null, missing: [...missing, entry] }, raw)
        return true
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
    return false
  }

  /** 核验通过才清除记录；清除后该路径重新回到既有的对象身份判据。 */
  clearMissing(relPath: string): boolean {
    this.assertCurrent()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = this.readOptional(JOURNAL)
      const journal = parseJournal(raw)
      if (journal.active) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      const missing = journal.missing ?? []
      if (!missing.some((item) => item.relPath === relPath)) return false
      const next = missing.filter((item) => item.relPath !== relPath)
      try {
        this.saveJournal({ version: 1, active: null, missing: next }, raw)
        return true
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
    return false
  }

  async preview(input: RelocationRequest): Promise<RelocationPreview> {
    this.assertCurrent()
    if (this.loadJournal().active) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    if (!validPath(input.source) || !validPath(input.target) || input.source === input.target ||
        !resolveInVault(this.root, input.source) || !resolveInVault(this.root, input.target)) throw new Error('BAD_PATH')
    if (input.kind === 'note' && (!isNotePath(input.source) || !isNotePath(input.target))) throw new Error('BAD_PATH')
    if (input.kind === 'folder' && samePathOrChild(input.target, input.source)) throw new Error('BAD_PATH')
    const fs = secureFsFor(this.root)
    const source = fs.resolve(input.source)
    if (source.at(-1)?.kind !== (input.kind === 'note' ? 'file' : 'dir')) throw new Error('BAD_PATH')
    const targetParent = parentOf(input.target)
    if (targetParent && fs.resolve(targetParent).at(-1)?.kind !== 'dir') throw new Error('BAD_PATH')
    const moves: RelocationMove[] = [{ from: input.source, to: input.target, id: source.at(-1)!.id }]
    if (input.kind === 'note') {
      const companion = input.source.slice(0, -3)
      try {
        const resolved = fs.resolve(companion)
        if (resolved.at(-1)?.kind !== 'dir') throw new Error('ATTACHMENT_COLLISION')
        moves.push({ from: companion, to: input.target.slice(0, -3), id: resolved.at(-1)!.id })
      } catch (error) {
        if (!(error instanceof Error && error.message === 'ENOENT')) throw error
      }
    }
    for (const move of moves) {
      try { fs.resolve(move.to); throw new Error('EEXIST') }
      catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) throw error }
    }
    const contextPaths = new Set<string>()
    for (const move of moves) {
      const parent = parentOf(move.from)
      if (parent) contextPaths.add(parent)
      const destinationParent = parentOf(move.to)
      if (destinationParent) contextPaths.add(destinationParent)
    }
    const fingerprints = [
      ...[...contextPaths].map((relPath) => {
        const leaf = fs.resolve(relPath).at(-1)!
        return { relPath, id: leaf.id, kind: leaf.kind }
      }),
      ...moves.flatMap((move) => this.fingerprintTree(move.from))
    ]
    const snapshot = await loadPermissionSnapshot(this.root)
    const policy = snapshot.state
    this.assertCurrent()
    if (policy.status !== 'ready') throw new Error('PERMISSIONS_INVALID')
    const permissionBefore = snapshot.raw
    const effectiveBefore = effectivePermissionEntries(this.root, policy.entries)
    const mappedEntries = policy.entries.map((entry) => ({ ...entry, relPath: mapped(entry.relPath, moves) }))
    if (new Set(mappedEntries.map((entry) => entry.relPath)).size !== mappedEntries.length) throw new Error('PERMISSION_COLLISION')
    const reversed = moves.map((move) => ({ from: move.to, to: move.from, id: move.id }))
    const effectiveAfter = effectivePermissionEntries(this.root, mappedEntries, (stem) => {
      const requested = mapped(stem, reversed)
      const resolved = fs.resolve(requested)
      if (resolved.at(-1)?.kind !== 'dir') return null
      const before = resolved.map((part) => part.name).join('/')
      const after = mapped(before, moves)
      // A folder moved away from an unchanged note is no longer its attachment.
      if (requested === stem && after !== before) return null
      return after
    })
    for (const item of fingerprints) {
      const oldTier = tierFor(item.relPath, effectiveBefore)
      const newTier = tierFor(mapped(item.relPath, moves), effectiveAfter)
      const strength = { reference: 0, follow: 1, forbidden: 2 }
      if (strength[newTier] < strength[oldTier]) throw new Error('PERMISSION_DOWNGRADE')
    }
    const permissionChanges = policy.entries.flatMap((entry) => {
      const to = mapped(entry.relPath, moves)
      return to === entry.relPath ? [] : [{ from: entry.relPath, to, tier: entry.tier }]
    })
    const permissionAfter = permissionChanges.length === 0 ? permissionBefore
      : `${JSON.stringify(Object.fromEntries(mappedEntries.map((entry) => [entry.relPath, entry.tier])), null, 2)}\n`
    const linkChanges = await this.scanLinks(moves)
    this.assertCurrent()
    const view: RelocationPreview = {
      id: randomUUID(), sessionId: this.sessionId, kind: input.kind, source: input.source, target: input.target,
      moves, linkChanges, permissionChanges
    }
    // The UI has one decision dialog. A newer preview supersedes older tokens.
    this.previews.clear()
    this.previews.set(view.id, { view, fingerprints, permissionBefore, permissionAfter })
    return view
  }

  async commit(id: string, options: { repairLinks: boolean }): Promise<{ moved: RelocationMove[]; unrepaired: string[] }> {
    const prepared = this.previews.get(id)
    if (!prepared) throw new Error('STALE_PREVIEW')
    return this.queue.run(async () => {
      this.assertCurrent()
      let fresh: RelocationPreview
      try { fresh = await this.preview({ kind: prepared.view.kind, source: prepared.view.source, target: prepared.view.target }) }
      catch { throw new Error('STALE_PREVIEW') }
      const freshState = this.previews.get(fresh.id)!
      this.previews.delete(fresh.id)
      if (!sameFingerprints(prepared.fingerprints, freshState.fingerprints) ||
          freshState.permissionBefore !== prepared.permissionBefore ||
          freshState.permissionAfter !== prepared.permissionAfter ||
          JSON.stringify(fresh.moves) !== JSON.stringify(prepared.view.moves) ||
          JSON.stringify(fresh.permissionChanges) !== JSON.stringify(prepared.view.permissionChanges) ||
          this.readOptional(PERMISSIONS) !== prepared.permissionBefore ||
          JSON.stringify(fresh.linkChanges) !== JSON.stringify(prepared.view.linkChanges)) throw new Error('STALE_PREVIEW')
      const journalRaw = this.readOptional(JOURNAL)
      const journal = parseJournal(journalRaw)
      if (journal.active) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      const fingerprints = prepared.fingerprints.map((item) => {
        const link = options.repairLinks ? prepared.view.linkChanges.find((change) => change.relPath === item.relPath) : undefined
        if (!link) return item
        const snapshot = secureFsFor(this.root).readSnapshot(item.relPath)
        const source = snapshot.bytes.toString('utf8')
        if (snapshot.objectVersion !== link.expectedObjectVersion || revisionOf(source) !== link.expectedRevision) throw new Error('STALE_PREVIEW')
        return { ...item, repairedHash: hash(Buffer.from(applyChanges(source, link.changes))) }
      })
      const active: PendingMove = {
        kind: 'move',
        intent: { kind: prepared.view.kind, source: prepared.view.source, target: prepared.view.target, moves: prepared.view.moves },
        linkRepairs: prepared.view.linkChanges.map(({ relPath, newPath, expectedRevision }) => ({ relPath, newPath, expectedRevision })),
        fingerprints,
        permissionBefore: prepared.permissionBefore, permissionAfter: prepared.permissionAfter,
        repairLinks: options.repairLinks
      }
      const raw = this.saveJournal({ version: 1, active }, journalRaw)
      this.previews.delete(id)
      return this.recoverMove(active, raw)
    })
  }

  /** Resume only an operation whose file identities still match the saved intent. */
  async recover(): Promise<{ moved: RelocationMove[]; unrepaired: string[] } | null> {
    return this.queue.run(async () => {
      this.assertCurrent()
      const bytes = this.readJournalBytes()
      const raw = bytes === null ? null : journalText(bytes)
      const active = parseJournal(raw).active
      return active?.kind==='move' && raw !== null ? this.recoverMove(active, raw) : null
    })
  }

  /** Explicit whole-library authorization creates this plan; startup never commits it. */
  prepareRepair(mode:'rebuild'|'restore',writes:RepairWrite[],permissionRaw:string|null,memory?:MemoryRecoveryPlan):PendingLedgerRepair{
    this.assertCurrent();if(this.loadJournal().active)throw Error('LIFECYCLE_RECOVERY_REQUIRED')
    return {kind:'ledger-repair',rootIdentity:vaultRootIdentity(this.root),sessionId:this.sessionId,mode,fingerprints:this.repairTree(),writes,permissionRaw,...(memory?{memory}: {})}
  }
  private repairTree():Fingerprint[]{
    return secureFsFor(this.root).list().filter(e=>e.name!==JOURNAL&&!(e.name==='.DS_Store'&&e.kind==='file')).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>this.fingerprintTree(e.name)).sort((a,b)=>a.relPath.localeCompare(b.relPath))
  }
  private verifyRepair(active:PendingLedgerRepair):void{
    this.assertCurrent();if(vaultRootIdentity(this.root)!==active.rootIdentity||this.readOptional(PERMISSIONS)!==active.permissionRaw)throw Error('STALE_RECOVERY')
    const current=this.repairTree(),expected=new Map(active.fingerprints.map(f=>[f.relPath,f]))
    for(const file of current){
      const prior=expected.get(file.relPath),write=active.writes.find(w=>w.path===file.relPath)
      if(file.relPath==='.rgent-memory'&&active.memory){const m=active.memory;if(!(file.id===m.beforeId&&file.hash===m.beforeHash&&!m.receipt||file.hash===m.afterHash&&(!m.receipt||m.receipt===file.id)))throw Error('STALE_RECOVERY')}
      else if(write){const raw=this.readOptional(write.path);if(file.kind!=='file'||!(raw===write.before&&file.id===write.beforeId&&!write.receipt||raw===write.after&&(!write.receipt||write.receipt===file.id)))throw Error('STALE_RECOVERY')}
      else if(!prior||JSON.stringify(file)!==JSON.stringify(prior))throw Error('STALE_RECOVERY')
      expected.delete(file.relPath)
    }
    for(const prior of expected.values())if(!active.writes.some(w=>w.path===prior.relPath&&w.before===null))throw Error('STALE_RECOVERY')
    for(const write of active.writes)if(!current.some(f=>f.relPath===write.path)&&write.before!==null)throw Error('STALE_RECOVERY')
  }
  async commitRepair(plan:PendingLedgerRepair){return this.queue.run(()=>{
    this.assertCurrent();if(!validRepair(plan))throw Error('LIFECYCLE_RECOVERY_REQUIRED');if(plan.sessionId!==this.sessionId||this.loadJournal().active)throw Error('STALE_PREVIEW')
    this.verifyRepair(plan);const raw=this.saveJournal({version:1,active:plan});return this.runRepairBatch(plan,raw)
  })}
  async resumeRepair(revision:string){return this.queue.run(()=>{
    this.assertCurrent();const {active,raw}=this.journalAtRevision(revision)
    if(active?.kind==='ledger-publication'&&raw){recoverLedgerPublication(secureFsFor(this.root),active,this.assertCurrent);return {status:'complete' as const,revision:null,processed:2,total:2}}
    if(active?.kind!=='ledger-repair'||!raw)throw Error('STALE_RECOVERY')
    this.verifyRepair(active);return this.runRepairBatch(active,raw)
  })}
  private runRepairBatch(active:PendingLedgerRepair,raw:string){
    // A bounded batch returns control so the person can pause and leave the vault.
    this.verifyRepair(active);let budget=4
    for(const write of active.writes){
      if(write.receipt)continue
      if(!budget--)break
      this.verifyRepair(active)
      const fs=secureFsFor(this.root),disk=this.readOptional(write.path)
      if(disk!==write.after)fs.replace(write.path,write.before,write.after,write.beforeId??undefined)
      this.assertCurrent();const saved=fs.readSnapshot(write.path)
      if(saved.bytes.toString()!==write.after)throw Error('STALE_RECOVERY')
      write.receipt=saved.objectVersion;raw=this.saveJournal({version:1,active},raw)
      this.verifyRepair(active)
    }
    this.verifyRepair(active)
    if(active.memory&&!active.memory.receipt&&active.writes.every(w=>w.receipt)&&budget>0){
      const m=active.memory,fs=secureFsFor(this.root),disk=fs.readSnapshot('.rgent-memory'),rawMemory=disk.bytes.toString()
      if(hash(disk.bytes)!==m.afterHash){const next=applyMemoryRecovery(rawMemory,m.patches);if(hash(Buffer.from(next))!==m.afterHash)throw Error('STALE_RECOVERY');fs.replace('.rgent-memory',rawMemory,next,m.beforeId)}
      this.assertCurrent();const saved=fs.readSnapshot('.rgent-memory');if(hash(saved.bytes)!==m.afterHash)throw Error('STALE_RECOVERY')
      m.receipt=saved.objectVersion;raw=this.saveJournal({version:1,active},raw);this.verifyRepair(active)
    }
    const processed=active.writes.filter(w=>w.receipt).length+Number(!!active.memory?.receipt),total=active.writes.length+Number(!!active.memory)
    if(processed===total){this.saveJournal({version:1,active:null},raw);return {status:'complete' as const,revision:null,processed,total}}
    return {status:'pending' as const,revision:hash(Buffer.from(raw)),processed,total}
  }

  private async recoverMove(active: PendingMove, raw: string): Promise<{ moved: RelocationMove[]; unrepaired: string[] }> {
    this.assertCurrent()
    const fs = secureFsFor(this.root)
    const { repairReceipts: _receipts, ...intent } = active
    const operationId = hash(Buffer.from(JSON.stringify(intent)))
    const matchesRecordedState = (item: Fingerprint, path: string): boolean => this.matchesRecordedState(active, item, path)
    if (this.readOptional(JOURNAL) !== raw || !this.policyMatches(active) || this.inspectObjects(active).blocked) {
      throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    }
    for (const item of active.fingerprints) {
      const relocated = mapped(item.relPath, active.intent.moves)
      const path = this.idOrNull(item.relPath) === item.id ? item.relPath : relocated
      try {
        if (!matchesRecordedState(item, path)) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      } catch { throw new Error('LIFECYCLE_RECOVERY_REQUIRED') }
    }
    for (const move of active.intent.moves) {
      const atSource = this.idOrNull(move.from)
      const atTarget = this.idOrNull(move.to)
      if (atSource === move.id && atTarget === null) fs.move(move.from, move.to, move.id)
      else if (atSource !== null || (atTarget !== move.id &&
        !active.fingerprints.some((item) => item.relPath === move.from && matchesRecordedState(item, move.to)))) {
        throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      }
      if (this.readOptional(JOURNAL) !== raw || this.inspectObjects(active).blocked || !this.policyMatches(active)) {
        throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      }
    }
    // A native rename can race an external replacement after its last path check.
    // Check once before touching policy, and again before clearing recovery state.
    const verifyMoved = (): void => {
      if (this.readOptional(JOURNAL) !== raw || this.inspectObjects(active).blocked) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      for (const item of active.fingerprints) {
        const relocated = mapped(item.relPath, active.intent.moves)
        try {
          if (!matchesRecordedState(item, relocated)) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
        } catch { throw new Error('LIFECYCLE_RECOVERY_REQUIRED') }
      }
      if (active.intent.moves.some((move) => this.idOrNull(move.from) === move.id)) {
        throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      }
    }
    verifyMoved()
    const currentPolicy = this.readOptional(PERMISSIONS)
    if (currentPolicy === active.permissionBefore && active.permissionAfter !== active.permissionBefore) {
      fs.replace(PERMISSIONS, currentPolicy, active.permissionAfter ?? '')
    } else if (currentPolicy !== active.permissionAfter) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    const unrepaired: string[] = []
    if (active.repairLinks) {
      for (const item of active.linkRepairs) {
        const relPath = item.newPath
        let committed: CommittedNoteWrite | null = null
        try {
          const snapshot = fs.readSnapshot(relPath)
          const source = snapshot.bytes.toString('utf8')
          if (revisionOf(source) !== item.expectedRevision) {
            if (!linkChangesInSource(source, active.intent.moves).length) continue
            unrepaired.push(relPath)
            continue
          }
          const next = applyChanges(source, linkChangesInSource(source, active.intent.moves))
          if (next !== source) {
            const objectVersion = fs.replace(relPath, source, next, snapshot.objectVersion)
            committed = { relPath, previousPath: item.relPath, previousObjectVersion: snapshot.objectVersion, objectVersion, content: next }
          }
        } catch { unrepaired.push(relPath) }
        // Only the successful native replace receipt proves this identity edge.
        // Callback failure preserves the recovery journal instead of swallowing it.
        if (committed) {
          // Persist the native success edge before notifying dependents. A crash in
          // replace→journal remains explicitly unproven on recovery.
          const repair = { relPath: committed.relPath, previousPath: committed.previousPath, previousObjectVersion: committed.previousObjectVersion, objectVersion: committed.objectVersion, revision: revisionOf(committed.content) }
          this.controlledRepairs.set(committed.relPath, repair)
          active.repairReceipts = [...(active.repairReceipts ?? []), repair]
          raw = this.saveJournal({ version: 1, active }, raw)
          await this.onCommittedNoteWrite(committed)
        }
      }
    }
    verifyMoved()
    if (this.readOptional(PERMISSIONS) !== active.permissionAfter || !this.policyMatches(active)) {
      throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    }
    const objects: VerifiedRelocation['objects'] = active.fingerprints.map(item => {
      const to = mapped(item.relPath, active.intent.moves)
      const current = fs.resolve(to).at(-1)!
      const candidate = this.controlledRepairs.get(to)
      const proof = candidate?.previousPath === item.relPath && candidate.previousObjectVersion === item.id && candidate.objectVersion === current.id ? candidate : undefined
      return { from: item.relPath, to, previousObjectVersion: item.id, objectVersion: current.id, identityProven: current.id === item.id || !!proof && proof.revision === revisionOf(fs.readText(to)) }
    })
    for (const link of active.linkRepairs) if (!objects.some(o => o.from === link.relPath)) {
      const proof = active.repairReceipts?.find(r => r.previousPath === link.relPath)
      if (proof) {
        const current = fs.readSnapshot(link.newPath)
        objects.push({ from: link.relPath, to: link.newPath, previousObjectVersion: proof.previousObjectVersion, objectVersion: current.objectVersion, identityProven: this.controlledRepairs.get(link.newPath)?.objectVersion === current.objectVersion && proof.objectVersion === current.objectVersion && proof.revision === revisionOf(current.bytes.toString('utf8')) })
      }
    }
    await this.onVerifiedRelocation({ sessionId: this.sessionId, operationId, journalRevision: hash(Buffer.from(raw)), objects })
    this.assertCurrent(); verifyMoved()
    if (this.readOptional(PERMISSIONS) !== active.permissionAfter || !this.policyMatches(active)) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    this.saveJournal({ version: 1, active: null }, raw)
    this.controlledRepairs.clear()
    return { moved: active.intent.moves, unrepaired }
  }

  private fingerprintTree(relPath: string): Fingerprint[] {
    const fs = secureFsFor(this.root)
    const components = fs.resolve(relPath)
    const leaf = components.at(-1)!
    const snapshot = leaf.kind === 'file' ? fs.readSnapshot(relPath) : null
    if (snapshot && snapshot.objectVersion !== leaf.id) throw new Error('PATH_CHANGED')
    const result: Fingerprint[] = [{ relPath, id: snapshot?.objectVersion ?? leaf.id, kind: leaf.kind,
      ...(snapshot ? { hash: hash(snapshot.bytes) } : {}) }]
    if (leaf.kind === 'dir') {
      for (const child of fs.list(relPath)) {
        if (child.kind !== 'file' && child.kind !== 'dir') throw new Error('UNSAFE_PATH')
        result.push(...this.fingerprintTree(`${relPath}/${child.name}`))
      }
    }
    return result
  }

  private async scanLinks(moves: readonly RelocationMove[]): Promise<LinkChange[]> {
    const results: LinkChange[] = []
    for (const relPath of collectNotePaths(await listVaultTree(this.root))) {
      const snapshot = await readNoteSnapshot(this.root, relPath)
      const changes = linkChangesInSource(snapshot.content, moves)
      if (changes.length) results.push({ relPath, newPath: mapped(relPath, moves), expectedRevision: snapshot.revision, expectedObjectVersion: snapshot.objectVersion, changes })
    }
    return results
  }

  private idOrNull(relPath: string): string | null {
    try { return secureFsFor(this.root).resolve(relPath).at(-1)?.id ?? null }
    catch (error) { if (error instanceof Error && error.message === 'ENOENT') return null; throw error }
  }

  private readOptional(relPath: string): string | null {
    try { return secureFsFor(this.root).readText(relPath) }
    catch (error) { if (error instanceof Error && error.message === 'ENOENT') return null; throw error }
  }

  private loadJournal(): Journal {
    const bytes = this.readJournalBytes()
    return parseJournal(bytes === null ? null : journalText(bytes))
  }

  private readJournalBytes(): Buffer | null {
    try { return secureFsFor(this.root).readBytes(JOURNAL) }
    catch (error) { if (error instanceof Error && error.message === 'ENOENT') return null; throw error }
  }

  private saveJournal(next: Journal, expected = this.readOptional(JOURNAL)): string {
    // 外部消失记录不随移动／账本恢复的 journal 重写而消失；调用方显式给出 missing 时以它为准。
    let preserved = next.missing
    if (preserved === undefined) {
      try { preserved = parseJournal(expected).missing } catch { preserved = [] }
    }
    const payload: Journal = { ...next, ...(preserved?.length ? { missing: preserved } : {}) }
    const raw = `${JSON.stringify(payload)}\n`
    secureFsFor(this.root).replace(JOURNAL, expected, raw)
    return raw
  }

  private policyMatches(active: PendingMove): boolean {
    const current = this.readOptional(PERMISSIONS)
    if (current !== active.permissionBefore && current !== active.permissionAfter) return false
    const fs = secureFsFor(this.root)
    const reversed = active.intent.moves.map((move) => ({ from: move.to, to: move.from, id: move.id }))
    const normalized = (raw: string | null, before: boolean, after?: ReadonlyMap<string, string>): Map<string, string> => {
      const entries = raw === null ? {} : JSON.parse(raw) as Record<string, string>
      const canonical = new Map<string, string>()
      for (const [relPath, tier] of Object.entries(entries)) {
        const destination = before ? mapped(relPath, active.intent.moves) : relPath
        const original = before ? relPath : mapped(relPath, reversed)
        let components
        try { components = fs.resolve(destination) }
        catch (error) {
          if (!(error instanceof Error && error.message === 'ENOENT')) throw error
          try { components = fs.resolve(original) }
          catch (sourceError) {
            if (!before || !after || !(sourceError instanceof Error && sourceError.message === 'ENOENT')) throw sourceError
            const target = this.movedRuleAlias(active, relPath, tier, after)
            const prior = canonical.get(target)
            if (prior && prior !== tier) throw new Error('PERMISSIONS_INVALID')
            canonical.set(target, tier)
            continue
          }
        }
        const target = mapped(components.map((part) => part.name).join('/'), active.intent.moves)
        const prior = canonical.get(target)
        if (prior && prior !== tier) throw new Error('PERMISSIONS_INVALID')
        canonical.set(target, tier)
      }
      return canonical
    }
    try {
      const after = normalized(active.permissionAfter, false)
      const before = normalized(active.permissionBefore, true, after)
      return before.size === after.size && [...before].every(([relPath, tier]) => after.get(relPath) === tier)
    } catch { return false }
  }

  /** Old v1 records retain raw rule spelling. Infer a vanished alias only from
   * one recorded object, its verified destination and the complete policy plan. */
  private movedRuleAlias(active: PendingMove, relPath: string, tier: string, after: ReadonlyMap<string, string>): string {
    const candidates = active.fingerprints.filter((part) => asciiFold(part.relPath) === asciiFold(relPath) &&
      mapped(part.relPath, active.intent.moves) !== part.relPath)
    if (candidates.length !== 1) throw new Error('PERMISSIONS_INVALID')
    const recorded = candidates[0]
    const move = active.intent.moves.find((part) => samePathOrChild(recorded.relPath, part.from))!
    if (this.idOrNull(move.from) !== null) throw new Error('PERMISSIONS_INVALID')
    const fs = secureFsFor(this.root)
    const sourceParent = parentOf(move.from)
    const rootDepth = move.from.split('/').length
    if (sourceParent) {
      const parentRecord = active.fingerprints.find((part) => part.relPath === sourceParent && part.kind === 'dir')
      const rawParent = relPath.split('/').slice(0, rootDepth - 1).join('/')
      const requested = fs.resolve(rawParent)
      const canonical = fs.resolve(sourceParent)
      if (!parentRecord || requested.at(-1)?.id !== parentRecord.id || canonical.at(-1)?.id !== parentRecord.id ||
          requested.map((part) => part.name).join('/') !== canonical.map((part) => part.name).join('/')) {
        throw new Error('PERMISSIONS_INVALID')
      }
    }
    const destination = mapped(recorded.relPath, active.intent.moves)
    if (!this.matchesRecordedState(active, recorded, destination)) throw new Error('PERMISSIONS_INVALID')
    // Raw spelling below the renamed root must still resolve to the same object.
    const suffix = relPath.split('/').slice(rootDepth).join('/')
    const requested = fs.resolve(suffix ? `${move.to}/${suffix}` : move.to)
    const verified = fs.resolve(destination)
    const target = verified.map((part) => part.name).join('/')
    if (requested.at(-1)?.id !== verified.at(-1)?.id || after.get(target) !== tier) throw new Error('PERMISSIONS_INVALID')
    return target
  }

  private matchesRecordedState(active: PendingMove, item: Fingerprint, relPath: string): boolean {
    const fs = secureFsFor(this.root)
    const current = fs.resolve(relPath).at(-1)
    if (!current || current.kind !== item.kind) return false
    if (!item.hash) return current.id === item.id
    const snapshot = fs.readSnapshot(relPath)
    if (snapshot.objectVersion !== current.id) return false
    const currentHash = hash(snapshot.bytes)
    if (snapshot.objectVersion === item.id) return currentHash === item.hash || currentHash === item.repairedHash
    return relPath === mapped(item.relPath, active.intent.moves) && currentHash === item.repairedHash
  }

  /** Enumerate both sides, including members absent from the saved snapshot. */
  private inspectObjects(active: PendingMove): { blocked: boolean; items: LifecycleStatus['items'] } {
    const items: LifecycleStatus['items'] = []
    let blocked = false
    for (const move of active.intent.moves) {
      const expected = active.fingerprints.filter((part) => samePathOrChild(part.relPath, move.from))
      const actual = new Map<string, { atSource: boolean; part: Fingerprint }[]>()
      for (const [base, atSource] of [[move.from, true], [move.to, false]] as const) {
        try {
          if (this.idOrNull(base) === null) continue
          for (const part of this.fingerprintTree(base)) {
            const original = `${move.from}${part.relPath.slice(base.length)}`
            actual.set(original, [...(actual.get(original) ?? []), { atSource, part }])
          }
        } catch { blocked = true }
      }
      for (const relPath of new Set([...expected.map((part) => part.relPath), ...actual.keys()])) {
        const record = expected.find((part) => part.relPath === relPath)
        const found = actual.get(relPath) ?? []
        let state: LifecycleStatus['items'][number]['state'] = 'blocked'
        try {
          if (record && found.length === 1 && this.matchesRecordedState(active, record, found[0].part.relPath)) {
            state = found[0].atSource ? 'source' : 'moved'
          }
        } catch { /* unverified objects stay blocked */ }
        if (state === 'blocked') blocked = true
        items.push({ from: relPath, to: mapped(relPath, active.intent.moves), state })
      }
    }
    for (const part of active.fingerprints.filter((item) => mapped(item.relPath, active.intent.moves) === item.relPath)) {
      try { if (!this.matchesRecordedState(active, part, part.relPath)) blocked = true }
      catch { blocked = true }
    }
    return { blocked, items }
  }
}

function parseJournal(raw: string | null): Journal {
  if (raw === null) return { version: 1, active: null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || (parsed as Journal).version !== 1 ||
        !('active' in parsed) || ((parsed as Journal).active !== null && !validPending((parsed as Journal).active)&&!validRepair((parsed as Journal).active)&&!validLedgerPublication((parsed as Journal).active))) {
      throw new Error('BAD_JOURNAL')
    }
    const missing = (parsed as Journal).missing
    if (missing !== undefined && (!Array.isArray(missing) || missing.length > MISSING_LIMIT || !missing.every(validMissing) ||
        new Set(missing.map((item) => item.relPath)).size !== missing.length)) throw new Error('BAD_JOURNAL')
    return { version: 1, active: (parsed as Journal).active, ...(missing?.length ? { missing } : {}) }
  } catch { throw new Error('LIFECYCLE_RECOVERY_REQUIRED') }
}

function journalText(bytes: Buffer): string {
  const raw = bytes.toString('utf8')
  if (!Buffer.from(raw).equals(bytes)) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
  return raw
}

function validRepair(value:unknown):value is PendingLedgerRepair{
 try{
  if(!value||typeof value!=='object')return false
  const p=value as PendingLedgerRepair,exact=(v:object,keys:string[])=>Object.keys(v).sort().join()===keys.sort().join()
  const digest=(raw:string)=>hash(Buffer.from(raw)),sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
  if(!exact(p,['kind','rootIdentity','sessionId','mode','fingerprints','writes','permissionRaw',...(p.memory?['memory']:[])])||p.kind!=='ledger-repair'||!/^\d+:\d+$/.test(p.rootIdentity)||typeof p.sessionId!=='string'||!['rebuild','restore'].includes(p.mode)||!validPermissionRaw(p.permissionRaw)||!Array.isArray(p.fingerprints)||!Array.isArray(p.writes)||p.writes.length>100001||p.fingerprints.length>200000)return false
  if(!p.fingerprints.every(f=>f&&exact(f,['relPath','id','kind',...(f.hash?['hash']:[])])&&validPath(f.relPath,true)&&typeof f.id==='string'&&['file','dir'].includes(f.kind)&&(f.kind==='dir'?f.hash===undefined:sha(f.hash)))||new Set(p.fingerprints.map(f=>f.relPath)).size!==p.fingerprints.length)return false
  const files=new Map(p.fingerprints.map(f=>[f.relPath,f]))
  if(p.memory){
    const m=p.memory,original=files.get('.rgent-memory')
    if(p.mode!=='restore'||!exact(m,['beforeHash','beforeId','afterHash','patches',...(m.receipt?['receipt']:[])])||!sha(m.beforeHash)||!sha(m.afterHash)||m.beforeId!==original?.id||m.beforeHash!==original?.hash||m.receipt!==undefined&&typeof m.receipt!=='string'||!Array.isArray(m.patches)||m.patches.length>1000)return false
    if(!m.patches.every(e=>e&&exact(e,['id','version','pause','sources'])&&typeof e.id==='string'&&Number.isSafeInteger(e.version)&&e.version>0&&typeof e.pause==='boolean'&&Array.isArray(e.sources)&&e.sources.length<=16&&e.sources.every(s=>s&&exact(s,['id','objectVersion','revision','deps'])&&typeof s.id==='string'&&typeof s.objectVersion==='string'&&sha(s.revision)&&Array.isArray(s.deps)&&s.deps.length<=16&&s.deps.every(d=>d&&exact(d,['relPath','objectVersion'])&&validPath(d.relPath)&&typeof d.objectVersion==='string'&&files.get(d.relPath)?.id===d.objectVersion))))return false
    if(new Set(m.patches.map(e=>e.id)).size!==m.patches.length)return false
  }
  if(!p.writes.every(w=>w&&exact(w,['path','before','beforeId','after',...(w.receipt?['receipt']:[])])&&/^\.rgent\/(registry\.json|ledgers\/[A-Za-z0-9_-]{1,128}\/owner\.json)$/.test(w.path)&&(w.before===null&&w.beforeId===null||typeof w.before==='string'&&typeof w.beforeId==='string')&&typeof w.after==='string'&&Buffer.byteLength(w.after)<=8*1024*1024&&(w.receipt===undefined||typeof w.receipt==='string')&&(w.before===null?!files.has(w.path):files.get(w.path)?.id===w.beforeId&&files.get(w.path)?.hash===digest(w.before)))||new Set(p.writes.map(w=>w.path)).size!==p.writes.length)return false
  const registry=p.writes.find(w=>w.path==='.rgent/registry.json')
  for(const w of p.writes.filter(w=>w.path!=='.rgent/registry.json')){
    if(p.mode!=='restore'||!registry||w.before===null)return false
    const before=JSON.parse(w.before),after=JSON.parse(w.after)
    if(!validOwner(before)||!validOwner(after)||w.path!==`.rgent/ledgers/${after.noteId}/owner.json`||JSON.stringify({...after,objectVersion:before.objectVersion,...(before.recoveryEvidence?{recoveryEvidence:before.recoveryEvidence}:{})})!==JSON.stringify(before))return false
    if(files.get(after.relPath)?.id!==after.objectVersion||files.get(after.relPath)?.hash!==after.bodyRevision||after.recoveryEvidence&&(after.recoveryEvidence.rootIdentity!==p.rootIdentity||JSON.stringify(after.recoveryEvidence.attachments)!==JSON.stringify(before.recoveryEvidence?.attachments)))return false
  }
  if(registry){
    const next=JSON.parse(registry.after)
    if(!next||!exact(next,['version','owners','sequence'])||next.version!==1||!Number.isSafeInteger(next.sequence)||next.sequence<0||!Array.isArray(next.owners)||!next.owners.every(validOwner)||new Set(next.owners.map((o:import('./ledger-store.ts').LedgerOwner)=>o.noteId)).size!==next.owners.length||new Set(next.owners.map((o:import('./ledger-store.ts').LedgerOwner)=>o.relPath)).size!==next.owners.length)return false
    for(const owner of next.owners){const file=`.rgent/ledgers/${owner.noteId}/owner.json`,write=p.writes.find(w=>w.path===file);if(owner.sequenceCeiling>next.sequence||(write?write.after!==JSON.stringify(owner):files.get(file)?.hash!==digest(JSON.stringify(owner))))return false}
    const ownerFiles=p.fingerprints.filter(f=>/^\.rgent\/ledgers\/[^/]+\/owner\.json$/.test(f.relPath));if(ownerFiles.length!==next.owners.length)return false
  }
  return true
 }catch{return false}
}

function validPending(value: unknown): value is PendingMove {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PendingMove>
  const intent = item.intent
  if (item.kind !== 'move' || !intent || (intent.kind !== 'note' && intent.kind !== 'folder') ||
      typeof intent.source !== 'string' || !validPath(intent.source) ||
      typeof intent.target !== 'string' || !validPath(intent.target) ||
      intent.source === intent.target ||
      (intent.kind === 'folder' && samePathOrChild(intent.target, intent.source)) ||
      !Array.isArray(intent.moves) || intent.moves.length < 1 || intent.moves.length > 2 ||
      intent.moves[0]?.from !== intent.source || intent.moves[0]?.to !== intent.target ||
      (intent.kind === 'folder' && intent.moves.length !== 1) ||
      (intent.kind === 'note' && (!isNotePath(intent.source) || !isNotePath(intent.target))) ||
      (intent.moves.length === 2 && (intent.moves[1]?.from !== intent.source.slice(0, -3) ||
        intent.moves[1]?.to !== intent.target.slice(0, -3)))) return false
  if (!intent.moves.every((move) => move && validPath(move.from) && validPath(move.to) &&
      typeof move.id === 'string' && move.id.length > 0)) return false
  if (!Array.isArray(item.fingerprints) || !item.fingerprints.every((part) => part &&
      validPath(part.relPath, true) && typeof part.id === 'string' && part.id.length > 0 &&
      (part.kind === 'dir' || part.kind === 'file') &&
      (part.kind === 'file' ? typeof part.hash === 'string' && /^[a-f0-9]{64}$/.test(part.hash) : part.hash === undefined) &&
      (part.repairedHash === undefined || (part.kind === 'file' && /^[a-f0-9]{64}$/.test(part.repairedHash))))) return false
  if (item.repairReceipts !== undefined && (!Array.isArray(item.repairReceipts) || !item.repairReceipts.every(r => r && validPath(r.relPath) && validPath(r.previousPath) && typeof r.previousObjectVersion === 'string' && !!r.previousObjectVersion && typeof r.objectVersion === 'string' && !!r.objectVersion && /^[a-f0-9]{64}$/.test(r.revision) && item.linkRepairs?.some(l => l.relPath === r.previousPath && l.newPath === r.relPath)) || new Set(item.repairReceipts.map(r => r.relPath)).size !== item.repairReceipts.length)) return false
  const fingerprints = item.fingerprints as Fingerprint[]
  if (fingerprints.some((part) => hasHiddenSegment(part.relPath) &&
      !intent.moves.some((move, index) => (intent.kind === 'folder' || index > 0) &&
        part.relPath.startsWith(`${move.from}/`)))) return false
  const contexts = new Set(intent.moves.flatMap((move) => [parentOf(move.from), parentOf(move.to)]).filter(Boolean))
  if (fingerprints.some((part) => !intent.moves.some((move) => samePathOrChild(part.relPath, move.from)) &&
      (!contexts.has(part.relPath) || part.kind !== 'dir'))) return false
  if (new Set(fingerprints.map((part) => part.relPath)).size !== fingerprints.length ||
      !intent.moves.every((move, index) => fingerprints.some((part) => part.relPath === move.from &&
        part.id === move.id && part.kind === (index === 0 && intent.kind === 'note' ? 'file' : 'dir')))) return false
  if (!Array.isArray(item.linkRepairs) || !item.linkRepairs.every((link) => link &&
      validPath(link.relPath) && validPath(link.newPath) && isNotePath(link.relPath) &&
      isNotePath(link.newPath) && link.newPath === mapped(link.relPath, intent.moves) &&
      typeof link.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(link.expectedRevision))) return false
  if (fingerprints.some((part) => part.repairedHash &&
      (!item.repairLinks || mapped(part.relPath, intent.moves) === part.relPath ||
        !item.linkRepairs?.some((link) => link.relPath === part.relPath)))) return false
  return validPermissionRaw(item.permissionBefore) && validPermissionRaw(item.permissionAfter) &&
    (item.permissionBefore !== null || item.permissionAfter === null) &&
    (item.permissionAfter !== null || item.permissionBefore === null) &&
    typeof item.repairLinks === 'boolean'
}

function validMissing(value: unknown): value is MissingObject {
  if (!value || typeof value !== 'object') return false
  const item = value as MissingObject
  if (Object.keys(item).sort().join() !== ['attachments', 'bodyRevision', 'detectedAt', 'noteId', 'objectVersion', 'permissionTier', 'relPath', 'rootIdentity'].sort().join()) return false
  return validPath(item.relPath) && isNotePath(item.relPath) &&
    typeof item.noteId === 'string' && item.noteId.length > 0 && item.noteId.length < 128 &&
    typeof item.objectVersion === 'string' && item.objectVersion.length > 0 && item.objectVersion.length < 512 &&
    typeof item.bodyRevision === 'string' && /^[a-f0-9]{64}$/.test(item.bodyRevision) &&
    typeof item.rootIdentity === 'string' && /^\d+:\d+$/.test(item.rootIdentity) &&
    typeof item.detectedAt === 'string' && Number.isFinite(Date.parse(item.detectedAt)) &&
    (item.permissionTier === 'reference' || item.permissionTier === 'follow' || item.permissionTier === 'forbidden' || item.permissionTier === 'unknown') &&
    Array.isArray(item.attachments) && item.attachments.length <= 4096 &&
    item.attachments.every((part) => !!part && typeof part === 'object' &&
      typeof part.relPath === 'string' && !part.relPath.split('/').some((name) => !name || name === '.' || name === '..') &&
      ((part.kind === 'dir' && part.hash === undefined) ||
        (part.kind === 'file' && typeof part.hash === 'string' && /^[a-f0-9]{64}$/.test(part.hash))))
}

function validPermissionRaw(raw: unknown): raw is string | null {
  if (raw === null) return true
  if (typeof raw !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.entries(parsed).every(([relPath, tier]) => validPath(relPath) &&
        (tier === 'reference' || tier === 'follow' || tier === 'forbidden'))
  } catch { return false }
}

function linkChangesInSource(source: string, moves: readonly RelocationMove[]): LinkChange['changes'] {
  const compiled = compile(source)
  if (compiled.stale || compiled.error) throw new Error('LINK_SCAN_FAILED')
  const changes: LinkChange['changes'] = []
  for (const link of compiled.index.wikilinks) {
    const newTarget = mappedLinkTarget(link.target, moves)
    if (newTarget === link.target) continue
    const before = source.slice(link.range.start, link.range.end)
    const marker = before.startsWith('!') ? 3 : 2
    const inner = before.slice(marker, -2)
    const pipe = inner.indexOf('|')
    const rawTarget = pipe < 0 ? inner : inner.slice(0, pipe)
    const target = rawTarget.trim()
    const start = link.range.start + marker + rawTarget.length - rawTarget.trimStart().length
    const after = target.toLowerCase().endsWith('.md') ? newTarget : newTarget.replace(/\.md$/i, '')
    changes.push({ start, end: start + target.length, before: target, after })
  }
  return changes
}

function sameFingerprints(left: readonly Fingerprint[], right: readonly Fingerprint[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function applyChanges(source: string, changes: readonly LinkChange['changes'][number][]): string {
  let next = source
  for (const item of [...changes].sort((a, b) => b.start - a.start)) {
    if (source.slice(item.start, item.end) !== item.before) throw new Error('STALE_LINK')
    next = `${next.slice(0, item.start)}${item.after}${next.slice(item.end)}`
  }
  return next
}

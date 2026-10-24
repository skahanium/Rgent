import { WorkingMemoryService } from './working-memory-service.ts'
import { bodyFingerprint } from './ledger-provenance.ts'
import { collectNotePaths } from '../shared/vault-rel.ts'
import {WorkingMemoryStore,applyMemoryRecovery,type MemoryRecoveryPatch,type WorkingBindingPatch,type WorkingSource,type WorkingSnapshot} from './working-memory-store.ts'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dialog, type BrowserWindow } from 'electron'
import type { BacklinkGroup, LifecycleRetryRequest, LifecycleStatus, NotePayload, NoteSnapshot, ObjectBinding, PermissionEntry, PermissionState, PermissionTier, RecoveryRow, RecoveryScanView, RecoveryVerdict, SearchHit, TreeEntry, VaultState, SaveCopyPreviewRequest, SaveCopyPreviewView, SaveCopyCommitRequest, TrashDegradedReason, TrashLandingVerdict, TrashOrphanReason, TrashListResult, TrashPurgeResult, TrashRestorePermission, TrashRestoreResult } from '../shared/ipc.ts'
import { createFolder, createNote, createNoteWithBody, listVaultTree, parseStoredVault, readNoteSnapshot, requireOrdinaryNotes as verifyOrdinaryNotes, revisionOf, serializeStoredVault, writeNote } from './notes-fs.ts'
import { VaultMutationQueue } from './vault-mutation-queue.ts'
import { VaultLifecycle, type MissingObject, type RelocationPreview, type RelocationRequest, type RelocationMove, type CommittedNoteWrite, type RetiredObject, type TrashPreview } from './vault-lifecycle.ts'
import { sameRootInode } from './vault-catalog.ts'
import { HUMAN_TRASH_ON_THIS_PLATFORM } from '../shared/human-trash.ts'
import { isOwnEcho, type RecentWrite } from './echo.ts'
import { hasHiddenSegment, isNotePath, resolveInVault, sanitizeFolderName, sanitizeNoteName } from './paths.ts'
import { effectivePermissionEntries, loadPermissions, loadPermissionSnapshot, modelTierFor, setPermission as savePermission, setPermissionFile, tierFor } from './permissions.ts'
import type { TaskGrant } from './task-authorization.ts'
import { closeSecureFs, secureFsFor } from './secure-fs.ts'
import { postTrashOutcome, verifyLanding } from './trash-result.ts'
import { TRASH_OPERATIONS_ON_THIS_PLATFORM, TRASH_RECORD_LIMIT, TrashStore, isTrashId } from './trash-store.ts'
import { VaultFailureStore } from './diagnostic-store.ts'
import type { TaskFailure } from '../shared/task-failure.ts'
import { VaultIndex } from './vault-index.ts'
import { vaultRootIdentity, watchVault } from './watch.ts'
import { assertLedgerPreserved, composeSource, partitionSource } from '../markdown/partition.ts'
import { compile } from '../markdown/index.ts'
import { LedgerStore } from './ledger-store.ts'
import type { LedgerChapterWrite } from './host-source.ts'
import { retireMemoryFile,memoryRetirementTarget } from './memory-retirement.ts'
import type { MemoryContext } from '../shared/memory.ts'

/** 落点核验用 `lstatSync`（不跟随链接）。拿不到落点属性就没有可核对的收据，按删错上报。 */
function landingStat(target: string): { dev: number; ino: number } {
  try {
    const info = lstatSync(target)
    return { dev: Number(info.dev), ino: Number(info.ino) }
  } catch { throw new Error('LANDING_MISMATCH') }
}

/** 删除成功后的如实回执：落点核验与降级都随结果带出，不吞成一句「成功」。 */
type TrashCommitOutcome = {
  cancelled: false
  relPath: string
  landing: string
  landingVerified: TrashLandingVerdict
  attachmentLanding: string | null
  orphan: boolean
  orphanReason?: TrashOrphanReason
  degraded: TrashDegradedReason[]
}

export class VaultSession {
  private readonly calls = new AsyncLocalStorage<{sessionId:string|null}>()
  private readonly mutations = new VaultMutationQueue()
  private workingMemory:WorkingMemoryStore|null=null
  private ledgerStore: LedgerStore | null = null
  private ledgerFailure: string | null = null
  private memoryFailure: string | null = null
  private memoryBindingFailure: string | null = null
  private initializationFailure: string | null = null
  private lifecycle: VaultLifecycle | null = null
  private lifecycleReady: Promise<void> = Promise.resolve()
  private lifecycleError: Error | null = null
  /** 库内「已删除」存储：与 lifecycle 同一个 mutation 队列，不另开写通道。 */
  private trash: TrashStore | null = null
  /** 对账／清理里没能自动处理的小问题（坏条目、清不掉的条目）：如实留着，不静默吞。 */
  private trashIssues: string[] = []
  private token: string | null = null
  root: string | null = null
  private rootIdentity: string | null = null
  private rootUnavailable = false
  private stopWatch: (() => void) | null = null
  private lastWrites = new Map<string, RecentWrite & { objectVersion: string }>()
  private readonly verified = new Map<string, Map<string, NoteSnapshot>>()
  private readonly protectedSources=new Map<string,{root:string;rootIdentity:string;snapshot:NoteSnapshot;relPath:string}>()
  protectRootDrafts(sessionId:string,bindings?:Array<{relPath:string;objectVersion:string}>):void{
    this.assertSession(sessionId)
    if([...this.protectedSources.values()].some(p=>p.snapshot.sessionId!==sessionId))throw Error('UNSAVED_DRAFT')
    const selected=bindings?bindings.map(b=>{const snapshot=this.latestFor(b.relPath,b.objectVersion);if(!snapshot)throw Error('LEDGER_BASIS_UNAVAILABLE');return {...b,snapshot}}):[...this.verified].flatMap(([relPath,versions])=>[...versions.values()].map(snapshot=>({relPath,objectVersion:snapshot.objectVersion,snapshot})))
    if(selected.reduce((n,p)=>n+Buffer.byteLength(p.snapshot.content,'utf8'),0)>64*1024*1024||selected.length>8192)throw Error('OBJECT_BINDING_LIMIT')
    const combined=new Map(this.protectedSources)
    for(const p of selected)combined.set(sessionId+':'+p.relPath+':'+p.objectVersion,{root:this.root!,rootIdentity:this.rootIdentity!,snapshot:p.snapshot,relPath:p.relPath})
    if(combined.size>8192||[...combined.values()].reduce((n,p)=>n+Buffer.byteLength(p.snapshot.content,'utf8'),0)>64*1024*1024)throw Error('OBJECT_BINDING_LIMIT')
    for(const {relPath,objectVersion,snapshot}of selected)this.protectedSources.set(sessionId+':'+relPath+':'+objectVersion,{root:this.root!,rootIdentity:this.rootIdentity!,snapshot:{...snapshot},relPath})
  }
  protectedRootSource(sessionId:string,relPath:string,objectVersion:string):{root:string;rootIdentity:string;snapshot:NoteSnapshot;relPath:string}|null{return this.protectedSources.get(sessionId+':'+relPath+':'+objectVersion)??null}
  protectedSession():string|null{return [...this.protectedSources.values()].find(p=>p.snapshot.sessionId!==this.token)?.snapshot.sessionId??null}
  discardRootSource(sessionId:string,relPath:string,objectVersion:string):void{if(!this.protectedRootSource(sessionId,relPath,objectVersion))throw Error('STALE_PREVIEW');for(const [key,p]of this.protectedSources)if(p.snapshot.sessionId===sessionId&&p.relPath===relPath)this.protectedSources.delete(key)}
  private readonly successors = new Map<string, Map<string, string>>()
  private readonly latestObjects = new Map<string, string>()
  /** Journal 超限或登记失败后，已观察到的消失路径仍占位，避免 PATH_RESERVED 被空 catch 吞掉。 */
  private readonly reservedMissing = new Set<string>()
  private readonly copyPreviews = new Map<string, {
    view: SaveCopyPreviewView; request: SaveCopyPreviewRequest; content: string;
    bodyHash: string; basisHash: string; pendingHash: string; parentIdentity: string
  }>()
  private debounce: NodeJS.Timeout | null = null
  private changedNotes = new Set<string>()
  private index = new VaultIndex(
    () => this.root ? this.requireUsableRoot() : null,
    () => this.tree()
  )

  constructor(
    private userData: string,
    private emit: (channel: string, payload?: unknown) => void,
    private beforeChange: (previousRoot: string) => Promise<void> = async () => {},
    private catalogIdentity?:(root:string,identity:string)=>string|null,
    private afterMemoryRetirement:()=>void=()=>{},
    /** 仅测试开：旧「先送系统废纸篓」管线已退役，生产不再从 `commitTrash(allow=true)` 可达。 */
    private readonly allowLegacySystemTrashForTests = false
  ) {}

  private stateFile(): string {
    return path.join(this.userData, 'vault.json')
  }

  /** Catalogue checks happen without mounting: initialization may recover or migrate files. */
  restoreVerified(root: string, identity: string): VaultState {
    if (!isUsableDir(root) || vaultRootIdentity(root) !== identity) return { status: 'needs-pick', reason: 'missing' }
    this.attach(root)
    return this.currentState()
  }

  async openVerified(root: string, identity: string): Promise<VaultState> {
    const check = (): void => {
      if (!isUsableDir(root) || vaultRootIdentity(root) !== identity) throw Error('VAULT_TARGET_CHANGED')
    }
    check()
    if (this.root && realpathSync.native(this.root) === realpathSync.native(root) && this.rootIdentity === identity) return this.currentState()
    const previous = this.root
    if (previous) await this.beforeChange(previous)
    await this.mutations.idle()
    check()
    this.attach(root)
    const state = this.currentState()
    return state.status === 'ready' ? { ...state, vaultChanged: true } : state
  }

  async idle(): Promise<void> { await this.mutations.idle() }

  restore(): VaultState {
    const stored = parseStoredVault(this.readStateFile())
    if (!stored) return { status: 'needs-pick', reason: 'first-run' }
    if (!isUsableDir(stored.path)) return { status: 'needs-pick', reason: 'missing' }
    this.attach(stored.path)
    return { status: 'ready', rootName: path.basename(stored.path), sessionId: this.captureSession(), navigationKey: this.navigationKey() }
  }

  async pick(win: BrowserWindow | null): Promise<VaultState> {
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择笔记库',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择笔记库',
          properties: ['openDirectory', 'createDirectory']
        })
    if (result.canceled || !result.filePaths[0]) {
      return this.currentState()
    }
    const chosen = path.resolve(result.filePaths[0])
    if (!isUsableDir(chosen)) return { status: 'needs-pick', reason: 'missing' }
    const previous = this.root
    if (previous) await this.beforeChange(previous)
    await this.mutations.idle()
    writeFileSync(this.stateFile(), serializeStoredVault(chosen), 'utf8')
    this.attach(chosen)
    return {
      status: 'ready',
      rootName: path.basename(chosen),
      sessionId: this.captureSession(),
      navigationKey: this.navigationKey(),
      vaultChanged: previous !== chosen
    }
  }

  currentState(): VaultState {
    this.assertCall()
    if (this.hasUsableRoot()) {
      return { status: 'ready', rootName: path.basename(this.root!), sessionId: this.captureSession(), navigationKey: this.navigationKey(), ...(this.initializationFailure ? { diagnostic: this.initializationFailure } : {}) }
    }
    const stored = parseStoredVault(this.readStateFile())
    if (!stored) return { status: 'needs-pick', reason: 'first-run' }
    return { status: 'needs-pick', reason: 'missing' }
  }

  /** Opaque renderer preference key only; never a permission or task authorization. */
  private navigationKey(): string {
    const root = this.requireUsableRoot()
    const canonical = realpathSync.native(root)
    if (vaultRootIdentity(canonical) !== this.rootIdentity) throw new Error('NOTE_UNREADABLE')
    this.requireUsableRoot()
    const id=this.catalogIdentity?.(canonical,this.rootIdentity!)
    return createHash('sha256').update(id?'catalog:'+id:JSON.stringify([canonical,this.rootIdentity])).digest('hex')
  }

  /** Main-process identity; includes the actual root object, unlike navigation preferences. */
  memoryContext(): MemoryContext {
    const root = this.requireUsableRoot(); const canonical = realpathSync.native(root)
    if (vaultRootIdentity(canonical) !== this.rootIdentity) throw new Error('NOTE_UNREADABLE')
    return { sessionId: this.captureSession(), vaultKey: createHash('sha256').update(JSON.stringify([canonical, this.rootIdentity])).digest('hex') }
  }

  memoryDiagnosis(): string | null { this.assertCall(); return this.memoryFailure }
  memoryBindingDiagnosis(): string | null { this.assertCall(); return this.memoryBindingFailure }

  async memoryRetirementPreview(){
    const sessionId=this.captureSession();await this.lifecycleReady
    return this.mutations.run(()=>{this.assertSession(sessionId);this.requireStableStructure();const root=this.requireUsableRoot(),target=memoryRetirementTarget(root,()=>{this.assertSession(sessionId);this.requireUsableRoot()});return {...target,root,rootIdentity:this.rootIdentity!,sessionId}})
  }
  async memoryRetirementRetry(binding:{sessionId:string;root:string;rootIdentity:string;revision:string;objectVersion:string},assertOwner:()=>void){
    this.assertSession(binding.sessionId);await this.lifecycleReady
    return this.mutations.run(()=>{
      const check=()=>{assertOwner();this.assertSession(binding.sessionId);this.requireStableStructure();if(this.requireUsableRoot()!==binding.root||this.rootIdentity!==binding.rootIdentity)throw Error('VAULT_CHANGED')}
      check();const target=memoryRetirementTarget(binding.root,check)
      if(target.revision!==binding.revision||target.objectVersion!==binding.objectVersion)throw Error('MEMORY_CONFLICT')
      try{if(retireMemoryFile(binding.root,check,binding))this.afterMemoryRetirement();check();this.memoryFailure=null}catch(error){this.memoryFailure='MEMORY_RETIREMENT_FAILED';throw error}
    })
  }

  async tree(): Promise<TreeEntry[]> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const entries = await listVaultTree(root)
    this.assertSession(token); this.requireUsableRoot()
    const policy = await loadPermissions(root)
    this.assertSession(token); this.requireUsableRoot()
    if (policy.status === 'ready') markTiers(entries, effectivePermissionEntries(root, policy.entries))
    // 标记只是显示：记录读不了也不该让整棵树打不开，失败关闭仍由对象与来源判据负责。
    let missing: readonly { relPath: string }[] = []
    try { missing = this.lifecycle?.missingObjects() ?? [] } catch { missing = [] }
    markRecovery(entries, missing)
    return entries
  }

  async requireOrdinaryNotes(paths: readonly string[]): Promise<void> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    verifyOrdinaryNotes(root, paths)
    this.assertSession(token); this.requireUsableRoot()
  }

  async permissions(): Promise<PermissionState> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const result = await loadPermissions(root)
    this.assertSession(token); this.requireUsableRoot()
    return result
  }

  async setPermission(relPath: string, tier: PermissionTier): Promise<PermissionState> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const state = await this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      return savePermission(root, relPath, tier)
    })
    this.assertSession(token); this.requireUsableRoot()
    this.emit('tree:changed')
    return state
  }

  async readOpened(relPath:string):Promise<NoteSnapshot> {
    const token=this.captureSession(); await this.lifecycleReady; this.assertSession(token)
    const note=await this.read(relPath),ledger=this.ledgerStore!.inspectOwner(relPath)
    this.assertSession(token);return {...note,content:partitionSource(note.content).body,ledger}
  }
  /** Called only after a task grant or explicit migration, never by opening. */
  async prepareTaskSource(request:ObjectBinding&{relPath:string;expectedRevision:string},grant:TaskGrant){
    await this.lifecycleReady;return this.mutations.run(async()=>{
      this.assertSession(request.sessionId);this.requireStableStructure()
      const root=this.requireUsableRoot()
      if(!grant||grant.root!==root||grant.sessionId!==request.sessionId||grant.origin!==request.relPath)throw Error('INVALID_AUTHORIZATION')
      const policy=await loadPermissionSnapshot(root)
      if(await modelTierFor(root,request.relPath)!=='reference')throw Error('NOTE_NOT_REFERENCE')
      // Production grant dependencies read snapshots/permissions directly; they
      // do not enqueue another vault mutation while this queue is held.
      await grant.assertLive('write',request.relPath)
      const before=await this.read(request.relPath)
      if(!this.acceptsObject(request.relPath,request.objectVersion,before.objectVersion))throw Error('NOTE_REPLACED')
      if(before.revision!==request.expectedRevision)throw Error('CONFLICT')
      const after=await loadPermissionSnapshot(root)
      if(policy.state.status!=='ready'||after.state.status!=='ready')throw Error('PERMISSIONS_INVALID')
      if(policy.raw!==after.raw||policy.revision!==after.revision||tierFor(request.relPath,effectivePermissionEntries(root,after.state.entries))!=='reference')throw Error('SOURCE_PERMISSION_CHANGED')
      grant.assertActive()
      this.assertSession(request.sessionId);this.requireStableStructure()
      const migrated=this.migrateRegistered(request.relPath,before,()=>{
        grant.assertActive();this.assertSession(request.sessionId);this.requireStableStructure()
        let raw:string|null
        try{raw=secureFsFor(root).readText('.rgent-permissions')}catch(error){if(error instanceof Error&&error.message==='ENOENT')raw=null;else throw Error('PERMISSIONS_INVALID')}
        if(raw!==after.raw)throw Error('SOURCE_PERMISSION_CHANGED')
      })
      return {previousRevision:before.revision,revision:migrated.revision,sessionId:request.sessionId,previousObjectVersion:before.objectVersion,objectVersion:migrated.objectVersion,migrated:migrated.migrated}
    })
  }
  private migrateRegistered(relPath:string,before:NoteSnapshot,beforeCommit?:()=>void){
    if(partitionSource(before.content).ledger!==null){
      const links=this.successors.get(relPath)
      if(!links?.has(before.objectVersion)&&(links?.size??0)>=8192)throw Error('OBJECT_BINDING_LIMIT')
      this.requireSnapshotCapacity(relPath,'pending-migration',partitionSource(before.content).body,before.objectVersion)
    }
    return this.ledgerStore!.migrate(relPath,before,beforeCommit)
  }
  private scheduleLedgerCompression(relPath:string,token:string){
    setImmediate(()=>{void this.mutations.run(()=>{
      this.assertSession(token);this.requireStableStructure()
      const items=this.ledgerStore!.maintenancePreview(relPath,'compress').records
      if(items.length){const result=this.ledgerStore!.maintain(relPath,'compress',items);if(result.failed.length)this.ledgerFailure='LEDGER_CONFLICT';else if(this.ledgerFailure==='LEDGER_CONFLICT')this.ledgerFailure=null}
    }).catch(()=>{if(this.token===token)this.ledgerFailure='LEDGER_CONFLICT'})})
  }
  async ledgerPrepare(relPath:string,chapter:LedgerChapterWrite,expectedVersion?:number,binding?:ObjectBinding & {root:string;expectedRevision:string;grant?:TaskGrant}){
    const token=this.captureSession(),root=this.requireUsableRoot(),fs=secureFsFor(root)
    const atCall=binding ? null : fs.readSnapshot(relPath)
    const proof=binding ?? {root,sessionId:token,objectVersion:atCall!.objectVersion,expectedRevision:revisionOf(atCall!.bytes.toString('utf8'))}
    return this.mutations.run(async()=>{
      this.assertSession(proof.sessionId);this.requireStableStructure()
      if(this.requireUsableRoot()!==proof.root)throw Error('VAULT_CHANGED')
      const policy=await loadPermissionSnapshot(root)
      if(policy.state.status!=='ready')throw Error('PERMISSIONS_INVALID')
      this.assertSession(proof.sessionId);this.requireStableStructure()
      if(await modelTierFor(root,relPath)!=='reference')throw Error('NOTE_NOT_REFERENCE')
      this.assertSession(proof.sessionId);this.requireStableStructure()
      // Grant reads use the direct authorization IO, never re-enter this queue.
      if(binding?.grant){
        if(binding.grant.root!==root||binding.grant.sessionId!==proof.sessionId||binding.grant.origin!==relPath)throw Error('INVALID_AUTHORIZATION')
        await binding.grant.assertLive('write',relPath)
      }
      // No awaits from these final checks through LedgerStore.prepare.
      binding?.grant?.assertActive()
      this.assertSession(proof.sessionId);this.requireStableStructure()
      if(this.requireUsableRoot()!==proof.root)throw Error('VAULT_CHANGED')
      let raw:string|null
      try{raw=fs.readText('.rgent-permissions')}catch(error){if(error instanceof Error&&error.message==='ENOENT')raw=null;else throw Error('PERMISSIONS_INVALID')}
      if(raw!==policy.raw)throw Error('SOURCE_PERMISSION_CHANGED')
      const current=fs.readSnapshot(relPath)
      if(!this.acceptsObject(relPath,proof.objectVersion,current.objectVersion))throw Error('NOTE_REPLACED')
      if(revisionOf(current.bytes.toString('utf8'))!==proof.expectedRevision)throw Error('CONFLICT')
      return this.ledgerStore!.prepare(relPath,chapter,expectedVersion)
    })
  }
  async ledgerComplete(relPath:string,taskId:string,revision:string){const token=this.captureSession();const result=await this.mutations.run(async()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.complete(relPath,taskId,revision)});this.scheduleLedgerCompression(relPath,token);return result}
  async ledgerKey(relPath:string){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(()=>{this.assertSession(token);return this.memoryContext().vaultKey+':'+(this.ledgerStore!.lookupOwner(relPath)?.noteId??'unregistered:'+relPath)})}
  async summaryMaterials(relPath:string,taskIds:readonly string[],requiredBodyIds:readonly string[]=[],watermark=0){const token=this.captureSession();await this.lifecycleReady;this.assertSession(token);return this.ledgerStore!.summaryMaterials(relPath,taskIds,requiredBodyIds,watermark,(p,b,a)=>this.acceptsObject(p,b,a))}
  async ledgerContexts(relPath:string){const token=this.captureSession();await this.lifecycleReady;this.assertSession(token);return this.ledgerStore!.contexts(relPath)}
  /** Durable task-failure pointers. No prompt/answer/body is stored here. */
  recordTaskFailure(taskId:string,relPath:string,failure:TaskFailure,answerEmpty=true){
    const root=this.requireUsableRoot()
    try { new VaultFailureStore(secureFsFor(root)).record(taskId,relPath,failure,answerEmpty) } catch { /* diagnostics must not fail the task */ }
  }
  clearTaskFailures(relPath:string){try{new VaultFailureStore(secureFsFor(this.requireUsableRoot())).clearPath(relPath)}catch{/* best effort */}}
  forgetTaskFailure(taskId:string){
    try { new VaultFailureStore(secureFsFor(this.requireUsableRoot())).forget(taskId) } catch { /* best effort */ }
  }
  taskFailures(relPath:string){
    try { return new VaultFailureStore(secureFsFor(this.requireUsableRoot())).forPath(relPath) } catch { return [] }
  }
  async ledgerHistoryList(){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(()=>{this.assertSession(token);return this.ledgerStore!.historyDetails()})}
  async ledgerHistoryPurge(noteId:string){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.purgeHistory(noteId)})}
  async ledgerTrashPage(trashId:string,cursor:string|null){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(()=>{this.assertSession(token);const page=this.ledgerStore!.historyPage(trashId,cursor);return {...page,...(this.lifecycle?{}:{})} })}
  async ledgerPage(relPath:string,cursor:string|null){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(async()=>{this.assertSession(token);return {...this.ledgerStore!.wirePage(relPath,cursor),...(this.ledgerFailure?{maintenanceError:this.ledgerFailure}:{})}})}

  async materialUnit(relPath:string,start:number,end:number,proof?:Pick<import('./host-material.ts').SentFragment,'text'|'hash'|'objectVersion'|'classification'>){const token=this.captureSession();return this.mutations.run(async()=>{
    this.assertSession(token);this.requireStableStructure();let check:()=>void=()=>this.assertSession(token)
    if(proof){const root=this.requireUsableRoot(),fs=secureFsFor(root);verifyOrdinaryNotes(root,[relPath]);const permission=await loadPermissionSnapshot(root)
      if(permission.state.status!=='ready'||tierFor(fs.resolve(relPath).map(c=>c.name).join('/'),effectivePermissionEntries(root,permission.state.entries))==='forbidden')throw Error('MEMORY_SOURCE_CHANGED')
      try{if(!await modelTierFor(root,relPath))throw Error('MEMORY_SOURCE_CHANGED')}catch{throw Error('MEMORY_SOURCE_CHANGED')}
      check=()=>{this.assertSession(token);this.requireStableStructure();let raw:string|null=null;try{raw=fs.readText('.rgent-permissions')}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw Error('MEMORY_SOURCE_CHANGED')}if(raw!==permission.raw)throw Error('MEMORY_SOURCE_CHANGED')}
    }
    check();const record=this.workingMemory!.read().record;return this.ledgerStore!.materialUnit(relPath,start,end,{watermark:record.watermark,forgotten:record.forgotten.flatMap(f=>f.materialIds)},proof,(p,b,a)=>this.acceptsObject(p,b,a),check)
  })}
  materialCeiling(){const state=this.materialState();if(state.status==='invalid')throw Error(state.reason);return state.sequence}
  materialState(){this.requireUsableRoot();const state=this.ledgerStore!.materialState();if(state.status==='invalid')return state;try{const record=this.workingMemory!.read().record;if(state.sequence<record.nextSequence||state.sequence<record.watermark)return {status:'invalid' as const,reason:'LEDGER_REGISTRY_INVALID'}}catch{/* Invalid memory remains diagnosable and explicitly resettable only against a verified material ceiling. */}return state}
  ledgerTaskPath(taskId:string){this.requireUsableRoot();return this.ledgerStore!.taskPath(taskId)}
  memoryDiagnostic(){this.requireUsableRoot();return this.workingMemory!.diagnosis()}
  memorySnapshot(){this.assertCall();return this.workingMemory!.read()}
  /** Explicit diagnostic reset stays reachable during a pending structure recovery; it never clears that journal. */
  async memoryReset(expected:{revision:string|null;objectVersion:string|null}){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(()=>{this.assertSession(token);this.requireUsableRoot();if(this.lifecycle?.status().operation?.kind==='ledger-repair')throw Error('LIFECYCLE_RECOVERY_REQUIRED');return this.workingMemory!.reset(expected,this.materialCeiling())})}
  async memoryMutation<T>(operation:(store:WorkingMemoryStore)=>T|Promise<T>,collect=false):Promise<T>{const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(async()=>{this.assertSession(token);this.requireStableStructure();const result=await operation(this.workingMemory!);this.assertSession(token);if(collect){const root=this.requireUsableRoot(),permission=await loadPermissionSnapshot(root);this.assertSession(token);const entries=permission.state.status==='ready'?effectivePermissionEntries(root,permission.state.entries):null;this.ledgerStore!.collectMaterials(this.workingMemory!.read(),p=>entries!==null&&tierFor(p,entries)!=='forbidden',permission.raw)}return result})}
  ledgerContextForRecord(record:import('./ledger-store.ts').LedgerRecord){this.requireUsableRoot();return this.ledgerStore!.contextForRecord(record)}
  async ledgerRecord(relPath:string,taskId:string){const token=this.captureSession();await this.lifecycleReady;this.assertSession(token);return this.ledgerStore!.getRecord(relPath,taskId)}
  async ledgerMaintenancePreview(relPath:string,action:'compress'|'clear'){const token=this.captureSession();return this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.maintenancePreview(relPath,action)})}
  async ledgerMaintenanceCommit(relPath:string,action:'compress'|'clear',items:readonly {taskId:string;revision:number}[],archive?:{revision:string;bytes:number}){const token=this.captureSession();return this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.maintain(relPath,action,items,archive)})}
  ledgerRegistryRevision(){this.assertCall();return this.ledgerStore?.registryRevision()??null}
  private readonly ledgerRecoveryPreviews=new Map<string,{view:import('../shared/ledger.ts').LedgerRecoveryView;plan:import('./vault-lifecycle.ts').PendingLedgerRepair}>()
  async ledgerRecoveryPreview(mode:'rebuild'|'restore'):Promise<import('../shared/ledger.ts').LedgerRecoveryView>{
    const token=this.captureSession();await this.lifecycleReady
    return this.mutations.run(async()=>{
      this.assertSession(token);this.requireStableStructure()
      const root=this.requireUsableRoot(),fs=secureFsFor(root),ledger=this.ledgerStore!
      let permissionRaw:string|null=null;try{permissionRaw=fs.readText('.rgent-permissions')}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}
      const captured=this.lifecycle!.prepareRepair(mode,[],permissionRaw),reconstruction=ledger.recoveryOwners()
      const permissions=await loadPermissionSnapshot(root);if(permissions.state.status!=='ready')throw Error('PERMISSIONS_INVALID')
      const effective=effectivePermissionEntries(root,permissions.state.entries),rootIdentity=vaultRootIdentity(root)
      const rows:import('../shared/ledger.ts').LedgerRecoveryRow[]=[],writes:import('./vault-lifecycle.ts').RepairWrite[]=[]
      const next=structuredClone(reconstruction),snapshots=new Map<string,{bytes:Buffer;objectVersion:string}>()
      const bodies=new Map<string,number>()
      for(const relPath of collectNotePaths(await listVaultTree(root))){const note=fs.readSnapshot(relPath);snapshots.set(relPath,note);const hash=revisionOf(note.bytes.toString());bodies.set(hash,(bodies.get(hash)??0)+1)}
      const addWrite=(file:string,after:string)=>{let before:string|null=null,beforeId:string|null=null;try{const disk=fs.readSnapshot(file);before=disk.bytes.toString();beforeId=disk.objectVersion}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}if(before!==after)writes.push({path:file,before,beforeId,after})}
      let memory:WorkingSnapshot|null=null;try{memory=this.workingMemory!.read()}catch{/* Stored memory remains untouched and unavailable. */}
      const anyContinuous=reconstruction.owners.some(owner=>snapshots.get(owner.relPath)?.objectVersion===owner.objectVersion)
      for(const owner of next.owners){
        const row:import('../shared/ledger.ts').LedgerRecoveryRow={noteId:owner.noteId,relPath:owner.relPath,outcome:mode==='rebuild'?'history-only':'associate',reasons:[],sources:[]};rows.push(row)
        if(mode==='rebuild'){row.reasons.push('只重建原登记描述，不建立新的文件关联');continue}
        const refuse=(reason:string)=>{row.outcome='refused';row.reasons.push(reason)}
        const note=snapshots.get(owner.relPath)
        if(!note){refuse('登记路径缺失');continue}
        const body=note.bytes.toString(),evidence=owner.recoveryEvidence,attachments=ledger.attachmentEvidence(owner.relPath)
        if(tierFor(owner.relPath,effective)==='forbidden'||attachments.some(a=>tierFor(a.relPath,effective)==='forbidden'))refuse('当前笔记或附件权限禁止关联')
        try{verifyOrdinaryNotes(root,[owner.relPath])}catch{refuse('路径已成为其他笔记的附件')}
        if(revisionOf(body)!==owner.bodyRevision)refuse('正文修订与历史证据不同')
        const anchors=ledger.anchors(body)
        if(JSON.stringify(anchors)!==JSON.stringify([...owner.anchors].sort())||anchors.some(anchor=>!ledger.recoveryRecord(owner,anchor)))refuse('历史任务锚点不能唯一对应')
        if(owner.anchorsTruncated||ledger.anchors(body,Infinity).length>256){if(row.outcome!=='refused')row.outcome='history-only';row.reasons.push('有限锚点描述不包含全部任务；只恢复历史，来源暂停')}
        if(!anchors.length&&(bodies.get(revisionOf(body))??0)>1)refuse('同正文材料不能唯一对应')
        if(evidence){
          if(evidence.rootIdentity===rootIdentity&&note.objectVersion!==owner.objectVersion)refuse('同一库根中的替换篇不能借整库恢复继承')
          if(JSON.stringify(attachments)!==JSON.stringify(evidence.attachments))refuse('附件子树与历史证据不同')
        }else{
          if(row.outcome!=='refused')row.outcome='history-only'
          row.reasons.push('旧描述缺少库根和附件历史证明；只恢复历史，记忆来源暂停')
          if(anyContinuous&&note.objectVersion!==owner.objectVersion)refuse('仅部分登记对象改变，不能证明整库恢复范围')
        }
        if(row.outcome==='refused')continue
        owner.objectVersion=note.objectVersion
        // Explicit human association is recorded as a new baseline, never physical continuity.
        if(evidence)owner.recoveryEvidence={rootIdentity,attachments}
        addWrite(`.rgent/ledgers/${owner.noteId}/owner.json`,JSON.stringify(owner))
      }
      let memoryPlan:import('./vault-lifecycle.ts').MemoryRecoveryPlan|undefined
      if(mode==='restore'&&memory?.raw){
        const service=new WorkingMemoryService(this,()=>null),patches:MemoryRecoveryPatch[]=[],sourceResults=new Map<string,{candidate:WorkingSource;valid:boolean;reason:string}>()
        for(const entry of [...memory.record.entries,...memory.record.recent])for(const source of entry.sources){
          const row=rows.find(r=>r.relPath===source.relPath),owner=reconstruction.owners.find(o=>o.relPath===source.relPath),note=snapshots.get(source.relPath),candidate=structuredClone(source)
          let valid=!!row&&row.outcome==='associate'&&!!note,reason=valid?'已逐条核验原文、分类及来源依赖':'归属或历史附件证明不足，来源暂停'
          if(valid){
            candidate.objectVersion=note!.objectVersion;candidate.revision=revisionOf(note!.bytes.toString())
            for(const dep of candidate.sourceDeps){const depRow=rows.find(r=>r.relPath===dep.relPath),original=snapshots.get(dep.relPath);if(!original||depRow?.outcome!=='associate'||bodyFingerprint(original.bytes.toString())!==dep.bodyHash){valid=false;break}dep.objectVersion=original.objectVersion}
            if(valid)valid=await service.verifySource(candidate,{unique:true,record:async()=>{const r=ledger.recoveryRecord(owner!,source.taskId??'');if(!r)throw Error('LEDGER_RECORD_INVALID');return r},contexts:async()=>{const r=ledger.recoveryRecord(owner!,source.taskId??'');return r?ledger.contextForRecord(r):[]}})
            if(!valid)reason='当前原文、分类、权限或来源依赖不满足唯一核验'
          }
          const uniqueId=entry.sources.filter(s=>s.id===source.id).length===1
          sourceResults.set(entry.id+'\0'+source.id,{candidate,valid:valid&&uniqueId,reason:uniqueId?reason:'同一条目包含重复来源标识，来源暂停'})
        }
        const entryValid=(id:string,version:number,seen=new Set<string>()):boolean=>{
          if(seen.has(id))return false;seen.add(id)
          const entry=[...memory!.record.entries,...memory!.record.recent].find(e=>e.id===id&&e.version===version)
          return !!entry&&(entry.status==='active'||entry.status==='paused'&&['MEMORY_SOURCE_CHANGED','MEMORY_DEPENDENCY_CHANGED'].includes(entry.reason??''))&&(!entry.reviewAt||Date.parse(entry.reviewAt)>Date.now())&&entry.sources.length>0&&entry.sources.every(source=>sourceResults.get(entry.id+'\0'+source.id)?.valid&&source.memoryDeps.every(dep=>entryValid(dep.id,dep.version,new Set(seen))))
        }
        for(const entry of [...memory.record.entries,...memory.record.recent]){const patch:MemoryRecoveryPatch={id:entry.id,version:entry.version,pause:!entryValid(entry.id,entry.version),sources:[]}
          for(const source of entry.sources){const result=sourceResults.get(entry.id+'\0'+source.id)!,depsValid=source.memoryDeps.every(dep=>entryValid(dep.id,dep.version)),valid=result.valid&&depsValid
            rows.find(r=>r.relPath===source.relPath)?.sources.push({id:source.id,status:valid?'verified':'paused',reason:depsValid?result.reason:'记忆依赖版本、分类或到期状态无法核验'})
            if(valid)patch.sources.push({id:source.id,objectVersion:result.candidate.objectVersion,revision:result.candidate.revision,deps:result.candidate.sourceDeps.map(d=>({relPath:d.relPath,objectVersion:d.objectVersion}))})
          }
          patches.push(patch)
        }
        const after=applyMemoryRecovery(memory.raw,patches);memoryPlan={beforeHash:revisionOf(memory.raw),beforeId:memory.objectVersion!,afterHash:revisionOf(after),patches}
      }
      addWrite('.rgent/registry.json',JSON.stringify({version:1,...next}))
      this.assertSession(token);this.requireStableStructure()
      const after=await loadPermissionSnapshot(root);if(after.raw!==permissions.raw||after.revision!==permissions.revision)throw Error('STALE_PREVIEW')
      const id=randomUUID(),view:import('../shared/ledger.ts').LedgerRecoveryView={id,sessionId:token,mode,rows,canCommit:rows.length>0&&!rows.some(r=>r.outcome==='refused'),warning:mode==='restore'?'确认表示授权为本库建立新的对象关联，不证明是同一物理文件。仅逐条核验合格的记忆来源可续接，其余继续暂停；许可、临时模型、旧任务与本库开关不会恢复。提交后可分批核验并暂停离库。':'仅按完整归属描述重建登记；不重新绑定文件，不恢复许可或记忆来源。'}
      const plan=this.lifecycle!.prepareRepair(mode,writes,permissions.raw,memoryPlan)
      if(captured.permissionRaw!==permissions.raw||JSON.stringify(captured.fingerprints)!==JSON.stringify(plan.fingerprints))throw Error('STALE_PREVIEW')
      if(this.ledgerRecoveryPreviews.size>=4)this.ledgerRecoveryPreviews.clear()
      this.ledgerRecoveryPreviews.set(id,{view,plan});return structuredClone(view)
    })
  }
  ledgerRecoveryCancel(id:string){this.assertCall();this.ledgerRecoveryPreviews.delete(id)}
  async ledgerRecoveryCommit(id:string){
    const token=this.captureSession(),prepared=this.ledgerRecoveryPreviews.get(id)
    this.ledgerRecoveryPreviews.delete(id)
    if(!prepared||prepared.view.sessionId!==token||!prepared.view.canCommit)throw Error('STALE_PREVIEW')
    const result=await this.lifecycle!.commitRepair(prepared.plan);this.assertSession(token);this.lifecycleError=null;if(result.status==='complete'){this.resetMemoryReader();if(this.ledgerFailure==='LEDGER_OWNERSHIP_UNVERIFIED')this.ledgerFailure=null}return result
  }
  private resetMemoryReader(){const token=this.captureSession();this.workingMemory=new WorkingMemoryStore(()=>secureFsFor(this.requireUsableRoot()),()=>{this.assertSession(token);this.requireUsableRoot()})}
  async ledgerRecoveryResume(revision:string){const token=this.captureSession();await this.lifecycleReady;const result=await this.lifecycle!.resumeRepair(revision);this.assertSession(token);this.lifecycleError=null;if(result.status==='complete'){this.resetMemoryReader();if(this.ledgerFailure==='LEDGER_OWNERSHIP_UNVERIFIED')this.ledgerFailure=null}return result}
  async ledgerImage(relPath:string,taskId:string,revision:number,field:'prompt'|'answer'){
    const token=this.captureSession();await this.lifecycleReady;this.assertSession(token)
    const record=this.ledgerStore!.getRecord(relPath,taskId)
    if(record.revision!==revision||!record.chapter||!['saved','legacy'].includes(record.state))throw Error('LEDGER_CONFLICT')
    return record.chapter[field]
  }
  async ledgerMigrateBatch(after:string|null){
    const token=this.captureSession(),entries=await this.tree(),paths:string[]=[]
    const walk=(items:TreeEntry[])=>{for(const item of items){if((item.kind==='note'||item.kind==='file')&&item.relPath.toLowerCase().endsWith('.md'))paths.push(item.relPath);if(item.kind==='dir')walk(item.children??[])}}
    walk(entries);paths.sort();const remaining=paths.filter(p=>after===null||p>after),batch=remaining.slice(0,5),failures:{relPath:string;error:string}[]=[],processed:string[]=[]
    for(const path of batch){this.assertSession(token);try{await this.mutations.run(async()=>{this.assertSession(token);this.requireStableStructure();const before=await this.read(path);this.migrateRegistered(path,before)});processed.push(path)}catch{failures.push({relPath:path,error:'LEDGER_MIGRATION_FAILED'})}}
    return {processed,failures,after:remaining.length>batch.length?batch.at(-1)!:null}
  }
  async read(relPath: string): Promise<NoteSnapshot> {
    const token = this.captureSession()
    const root = this.root!
    try {
      this.requireUsableRoot()
      // F6：`missing` 判据先于任何身份比较生效。外部消失记录在且核验未过时，文件即使回到原位
      //（同 inode、附件夹仍缺）也不再是可用的原对象；读与 noteStatus 同判：在是 unreadable，不在是 missing。
      // 身份相同的短路（如 validateSources）因此不再能绕过记录。
      if (this.missingRecord(relPath)) {
        let present = false
        try { present = !!secureFsFor(root).resolve(relPath) } catch { /* 路径不在就是缺失 */ }
        throw new Error(present ? 'NOTE_UNREADABLE' : 'NOTE_MISSING')
      }
      const snapshot = { ...await readNoteSnapshot(root, relPath), sessionId: token }
      this.assertSession(token)
      this.requireUsableRoot()
      this.remember(relPath, snapshot)
      this.rootUnavailable = false
      if (!this.stopWatch) this.stopWatch = watchVault(root, rel => { if (this.token === token) this.onFsEvent(rel) })
      return snapshot
    } catch (error) {
      this.assertSession(token)
      const failure = noteReadError(error)
      if (failure.message === 'NOTE_MISSING') await this.recordExternalDisappearance(relPath)
      throw failure
    }
  }

  acceptsObject(relPath: string, expected: string, current: string): boolean {
    this.assertCall()
    // 外部消失且尚未核验恢复的对象不继承身份：来源核验、任务绑定与写回一律失败关闭。
    if (this.missingRecord(relPath)) return false
    const seen = new Set<string>()
    const links = this.successors.get(relPath)
    while (!seen.has(expected)) {
      if (expected === current) return true
      seen.add(expected)
      const next = links?.get(expected)
      if (!next) return false
      expected = next
    }
    return false
  }

  /** 未核验的外部消失记录。记录本身读不了就失败关闭；库根不可用不是记录问题，
   *  交给既有的 NOTE_UNREADABLE 路径，也不在这里预先打开库根句柄。 */
  private missingRecord(relPath: string): boolean {
    if (this.reservedMissing.has(relPath)) return true
    try { return this.lifecycle?.hasMissing(relPath) ?? false }
    catch { return this.hasUsableRoot() }
  }

  /** 外部消失登记一条生命周期记录。字段全部取自既有登记（身份、内容哈希、附件证据、
   *  消失时的权限档），写进同一本 `.rgent-lifecycle`，不新增存储格式。
   *  人确认的 macOS 删除也走同一本记录（PATH_RESERVED／来源失效／不自动遗忘）；
   *  监视器看到的路径消失仍按外部消失登记。 */
  private async recordExternalDisappearance(relPath: string): Promise<void> {
    let observed = false
    try {
      const root = this.root, ledger = this.ledgerStore
      if (!root || !ledger || !isNotePath(relPath) || this.trashedPath(relPath) || this.lifecycle?.hasMissing(relPath) || this.reservedMissing.has(relPath)) return
      try { secureFsFor(root).resolve(relPath); return }
      catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) return }
      let owners: ReturnType<LedgerStore['recoveryOwners']>['owners']
      // 只有已登记身份的对象才有可核验的记录；未登记笔记消失不造记录。
      try { owners = ledger.recoveryOwners().owners } catch { return }
      const owner = owners.find((item) => item.relPath === relPath)
      // 人已在原路径重建同名对象并退休的旧身份不再登记「外部消失」：否则每次重扫都会把
      // 已放弃的记录又造回活跃列表，路径重新变成死路，退休等于白做。
      // 判据只看登记身份：owner 的 objectVersion 变了（换了新对象／旧对象已更新并以新版本登记）
      // 时不抑制，新身份的消失照常登记。拿不到 owner 版本时按「同路径有退休记录就抑制」保守处理。
      if (this.retiredIdentity(relPath, owner?.objectVersion ?? null)) return
      if (!owner) return
      observed = true
      const snapshot = await loadPermissionSnapshot(root)
      const effective = snapshot.state.status === 'ready' ? effectivePermissionEntries(root, snapshot.state.entries) : null
      // 权限名单读不了就记 unknown（不冒充当时是禁止档）；核验按 unknown 跳过比较。
      const permissionTier: MissingObject['permissionTier'] = effective ? tierFor(owner.relPath, effective) : 'unknown'
      this.lifecycle?.recordMissing({
        relPath: owner.relPath, noteId: owner.noteId, objectVersion: owner.objectVersion,
        bodyRevision: owner.bodyRevision, attachments: owner.recoveryEvidence?.attachments ?? [],
        rootIdentity: this.rootIdentity ?? vaultRootIdentity(root), permissionTier, detectedAt: new Date().toISOString(),
        cause: 'external'
      })
    } catch {
      // 超限或 journal 被占用：已观察到的登记对象仍占路径，不能当成无记录。
      // 读写仍按 NOTE_MISSING 失败关闭；不新增强制清空入口。
      if (observed) this.reservedMissing.add(relPath)
    }
  }

  /** 人已放弃的旧身份：`retired[]` 里同路径、且（有可比版本时）同对象版本的记录。
   *  有可比版本却对不上，说明登记身份已经换了对象，不能抑制新身份的消失。
   *  拿不到可比版本（没有 owner 条目／账本暂时读不出身份）时保守按「同路径有退休记录」抑制：
   *  宁可不重复登记，也不把已放弃的旧记录造回活跃列表；此时本来也不会为新对象建档，
   *  所以这条保守分支不会吞掉一次真正的登记。退休历史读不出来则不抑制，继续按失败关闭处理。 */
  private retiredIdentity(relPath: string, objectVersion: string | null): boolean {
    let retired: RetiredObject[]
    try { retired = this.lifecycle?.retiredObjects() ?? [] } catch { return false }
    return retired.some((item) => item.relPath === relPath && (objectVersion === null || item.objectVersion === objectVersion))
  }

  /** 消失的对象在被核验恢复前占着自己的路径：同路径新建会顶替它的身份，一律拒绝。 */
  private refuseReservedPath(name: string, parent: string): void {
    const fileName = sanitizeNoteName(name)
    if (this.missingRecord(parent ? `${parent}/${fileName}` : fileName)) throw new Error('PATH_RESERVED')
  }

  /** 同名附件夹也是被保留的身份：`<stem>/` 属于 `<stem>.md`。新建它会占住附件证据，
   *  恢复从此卡在 `attachments-changed`／`attachments-missing`——而清除点 `clearMissing` 只在
   *  `recoveryRow` 判为 `restored`（原 inode 仍在、附件证据逐字节一致）时才放行。所以原对象被
   *  清空废纸篓后，这个名字就是永久死路：核验永远不可能通过，只能整库恢复或人工处理。
   *  这条边界如实上报，不新增「强制完成／清空」入口。 */
  private refuseReservedFolder(name: string, parent: string): void {
    const folderName = sanitizeFolderName(name)
    if (this.missingRecord(parent ? `${parent}/${folderName}.md` : `${folderName}.md`)) throw new Error('PATH_RESERVED')
  }

  /** 人在原路径新建同名笔记＝同意放弃旧对象的恢复核验：记录先退休，再创建。
   *  没有记录时什么都不做；记录在案却退休不了（含只登记在内存 `reservedMissing` 的情况）
   *  按恢复中断拒绝，绝不在有证据的情况下静默放行覆盖。 */
  private retireReservedNote(name: string, parent: string): RetiredObject | null {
    const fileName = sanitizeNoteName(name)
    return this.retireReserved(parent ? `${parent}/${fileName}` : fileName)
  }

  /** 同名附件夹也对应 `<stem>.md` 这条记录：人新建它同样是放弃旧对象。 */
  private retireReservedFolder(name: string, parent: string): RetiredObject | null {
    const folderName = sanitizeFolderName(name)
    return this.retireReserved(parent ? `${parent}/${folderName}.md` : `${folderName}.md`)
  }

  private retireReserved(relPath: string): RetiredObject | null {
    if (!this.missingRecord(relPath)) return null
    const lifecycle = this.lifecycle
    if (!lifecycle) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    const at = new Date().toISOString()
    if (!lifecycle.retireMissing(relPath, at)) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    this.reservedMissing.delete(relPath)
    const retired = lifecycle.retiredObjects().find((item) => item.relPath === relPath && item.retiredAt === at)
    if (!retired) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    return retired
  }

  /** 创建失败时把刚退休的记录放回活跃列表：先按既有登记入口 `recordMissing` 写回（形状必须过
   *  `validMissing`），再撤销这次退休项。写回失败按恢复中断上报，不静默丢证据；两步之间崩溃时
   *  记录已经在活跃列表（路径继续占着，失败关闭），最多留下一条多余的退休历史，不会丢证据。 */
  private restoreRetired(reserved: readonly RetiredObject[]): void {
    if (!reserved.length) return
    const lifecycle = this.lifecycle
    if (!lifecycle) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
    for (const item of reserved) {
      const { retiredAt: _retiredAt, reason: _reason, ...original } = item
      try { lifecycle.recordMissing(original) } catch { throw new Error('LIFECYCLE_RECOVERY_REQUIRED') }
      try {
        if (!lifecycle.restoreRetired(item)) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      } catch { throw new Error('LIFECYCLE_RECOVERY_REQUIRED') }
    }
  }

  /** 只读重扫：清点外部消失的记录，给出核验判据的分支结论。 */
  async recoveryScan(): Promise<RecoveryScanView> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    return this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      const rows = await this.recoveryRows()
      this.assertSession(token)
      return { sessionId: token, rows }
    })
  }

  /** 核验通过才清除生命周期记录；不通过则对象与来源继续对 AI 失效，并如实上报分支。 */
  async recoveryConfirm(relPath: string): Promise<{ verdict: RecoveryVerdict; restored: boolean; message: string }> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    if (!isNotePath(relPath)) throw new Error('BAD_PATH')
    return this.mutations.run(async () => {
      this.assertSession(token); this.requireStableStructure()
      const row = (await this.recoveryRows()).find((item) => item.relPath === relPath)
      if (!row) throw new Error('STALE_PREVIEW')
      // `permission-changed` 也允许恢复（按现行档生效）；能否恢复只看 canRestore。
      if (!row.canRestore) return { verdict: row.verdict, restored: false, message: row.message }
      this.assertSession(token)
      if (!this.lifecycle!.clearMissing(relPath)) throw new Error('STALE_PREVIEW')
      this.reservedMissing.delete(relPath)
      // 身份连续且登记一致：重新读取以恢复运行时绑定与来源可用。
      await this.read(relPath)
      this.assertSession(token)
      // 成功文案由行文案去掉"可以核验恢复"再拼成：保留行里关于 AI 可用性／权限档的如实说明，
      // 同时给出恢复成功的结论，避免出现「核验通过…可以核验恢复」这种自相矛盾的话。
      const base = row.message.replace('，可以核验恢复', '')
      const restoredMessage = `核验通过：${base}；该对象与相关来源恢复可用。`
      return { verdict: row.verdict, restored: true, message: restoredMessage }
    })
  }

  /** 人放弃恢复：只清 Rgent 库内的消失记录并释放路径，不碰系统废纸篓里的文件。
   *  记录先清；账本留痕失败不回滚，返回 degraded 让界面如实提示。 */
  async recoveryAbandon(relPath: string): Promise<{ verdict: 'abandoned'; cleared: true; degraded?: 'ledger-failed' }> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    if (!isNotePath(relPath)) throw new Error('BAD_PATH')
    return this.mutations.run(async () => {
      this.assertSession(token); this.requireStableStructure()
      if (!this.lifecycle!.missingObjects().some((item) => item.relPath === relPath)) throw new Error('STALE_PREVIEW')
      // 记录存在才可放弃。owner 用来决定是否要留账本痕迹；账本读不了也要清记录，但降级要上报。
      let owner: ReturnType<LedgerStore['recoveryOwners']>['owners'][number] | null = null
      let ledgerReadable = true
      try { owner = this.ledgerStore?.recoveryOwners().owners.find((item) => item.relPath === relPath) ?? null }
      catch (error) {
        // 从来没有账本树的库不是「账本读坏了」：没有 owner，也就没有要补的留痕。
        if (!(error instanceof Error && error.message === 'ENOENT')) ledgerReadable = false
      }
      this.assertSession(token)
      if (!this.lifecycle!.clearMissing(relPath)) throw new Error('STALE_PREVIEW')
      this.reservedMissing.delete(relPath)
      this.verified.delete(relPath)
      this.latestObjects.delete(relPath)
      this.index.markDirty()
      this.emit('tree:changed')
      let degraded = false
      if (owner) {
        try { this.ledgerStore!.recordRecoveryAbandon(relPath) } catch { degraded = true }
      } else if (!ledgerReadable) degraded = true
      return { verdict: 'abandoned' as const, cleared: true as const, ...(degraded ? { degraded: 'ledger-failed' as const } : {}) }
    })
  }

  private async recoveryRows(): Promise<RecoveryRow[]> {
    const root = this.requireUsableRoot(), ledger = this.ledgerStore
    if (!ledger) return []
    let owners: ReturnType<LedgerStore['recoveryOwners']>['owners'] | null = null
    try { owners = ledger.recoveryOwners().owners }
    catch (error) {
      // 从未建过账本树的库与「账本读坏了」不是一回事：前者没有 owner，后者必须失败关闭。
      owners = error instanceof Error && error.message === 'ENOENT' ? [] : null
    }
    // 程序不在场时（关闭期间、换库期间）消失的登记对象也要被看见，不能只靠运行时监视。
    // 已主动删除进库内「已删除」的路径不算库外消失，不进外部恢复清点。
    if (owners) for (const owner of owners) {
      if (this.missingRecord(owner.relPath) || this.trashedPath(owner.relPath)) continue
      try { secureFsFor(root).resolve(owner.relPath); continue }
      catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) continue }
      await this.recordExternalDisappearance(owner.relPath)
    }
    const records = this.lifecycle?.missingObjects() ?? []
    const rows: RecoveryRow[] = []
    for (const record of records) rows.push(await this.recoveryRow(record, owners))
    return rows
  }

  /** 判据顺序：路径 → 身份（同 inode 且内容一致＝卷重挂载容错）→ 内容 → 附件（删除时记录，
   *  不拿 owner 的旧证据）→ 权限（不可读单独上报；档变了仍可恢复，按现行档生效）→ owner 矛盾。
   *  未登记笔记 owner 缺失时跳过 owner 判据，仍可恢复。 */
  private async recoveryRow(record: MissingObject, owners: ReturnType<LedgerStore['recoveryOwners']>['owners'] | null): Promise<RecoveryRow> {
    const row = (verdict: RecoveryVerdict, message: string, canRestore = false): RecoveryRow => ({ relPath: record.relPath, verdict, message, canRestore, canAbandon: true })
    const root = this.requireUsableRoot(), fs = secureFsFor(root), ledger = this.ledgerStore!
    let current: string | null = null
    try { current = fs.resolve(record.relPath).at(-1)?.id ?? null }
    catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) current = null }
    if (current === null) return row('still-missing', record.cause === 'trash'
      ? '文件仍不在原路径。若已从系统废纸篓放回，请重扫本页。'
      : '文件仍不在原路径。若已放回原路径，请重扫本页。')
    let content: string
    try { content = fs.readSnapshot(record.relPath).bytes.toString('utf8') }
    catch { return row('ledger-unverified', '当前无法读取该对象。') }
    const revision = revisionOf(content)
    // 设备号会随卷重挂载变化，inode 不会；同 inode 且内容仍与记录一致时按同一对象读。
    const sameObject = current === record.objectVersion || (sameRootInode(record.objectVersion, current) && revision === record.bodyRevision)
    if (!sameObject) return row('object-replaced', '原路径现在放着另一个对象；同一库根内不继承身份，不能按原记录恢复。')
    if (revision !== record.bodyRevision) return row('content-changed', '内容与消失时的记录不一致；对象与来源对 AI 保持失效，且不自动遗忘记忆。')
    let attachments: MissingObject['attachments']
    try { attachments = ledger.attachmentEvidence(record.relPath) }
    catch { return row('ledger-unverified', '附件子树无法核验。') }
    if (JSON.stringify(attachments) !== JSON.stringify(record.attachments)) {
      const stem = record.relPath.slice(0, -3)
      const hadFolder = record.attachments.some((part) => part.relPath === stem && part.kind === 'dir')
      const hasFolder = attachments.some((part) => part.relPath === stem && part.kind === 'dir')
      if (hadFolder && !hasFolder) return row('attachments-missing', '同名附件夹没有一起放回；这是降级状态，不冒充核验通过。')
      return row('attachments-changed', '附件子树与消失时的记录不一致；对象与来源对 AI 保持失效。')
    }
    const snapshot = await loadPermissionSnapshot(root)
    if (snapshot.state.status !== 'ready') return row('permission-unreadable', '权限名单暂时无法核验，不能宣告恢复；请修好名单后稍后重扫。对象与来源继续失效。')
    const tier = tierFor(record.relPath, effectivePermissionEntries(root, snapshot.state.entries))
    const labels: Record<PermissionTier, string> = { reference: '参考', follow: '跟随', forbidden: '禁止' }
    // 删除时名单读不了只记 unknown：原档未知，就不比较；恢复后按现行档生效。
    // 档位变了仍可恢复，但先把 owner 矛盾判完再下结论，不能让权限分支绕过账本一致性。
    let permissionChanged: string | null = null
    if (record.permissionTier !== 'unknown' && tier !== record.permissionTier) {
      const forbidden = tier === 'forbidden' ? '当前为「禁止」，恢复后 AI 仍不可使用该笔记。' : ''
      permissionChanged = `权限档从「${labels[record.permissionTier]}」变成「${labels[tier]}」。恢复后按现行档生效，AI 是否可用以现行档为准。${forbidden}`
    }
    if (owners === null) return row('ledger-unverified', '账本登记暂时无法读取，不能宣告恢复。')
    const owner = owners.find((item) => item.relPath === record.relPath) ?? null
    if (owner) {
      if (owner.objectVersion !== record.objectVersion || owner.bodyRevision !== record.bodyRevision) {
        return row('ledger-unverified', '账本登记与消失时的记录互相矛盾，不能宣告恢复。')
      }
      // 卷重挂载时 owner 仍指旧设备号；身份已由 inode＋内容证明，不再用现行 id 反证。
      if (current === record.objectVersion) {
        const ownership = ledger.inspectOwner(record.relPath)
        if (!ownership || ownership.status !== 'verified') return row('ledger-unverified', '账本归属无法核验，不能宣告恢复。')
      }
    } else {
      // owner 缺失（未登记笔记）时跳过一致性判据；但账本若明确说「有登记却读不出来」仍失败关闭。
      const ownership = ledger.inspectOwner(record.relPath)
      if (!ownership || ownership.status === 'invalid' || ownership.status === 'verified') return row('ledger-unverified', '账本登记与当前对象不一致，不能宣告恢复。')
    }
    if (permissionChanged) return row('permission-changed', permissionChanged, true)
    if (record.permissionTier === 'unknown') return row('restored', '内容与附件都与记录一致，可以核验恢复。消失时权限名单无法核验，原权限档未知；恢复后按现行档生效，AI 是否可用以现行档为准。', true)
    if (tier === 'forbidden') return row('restored', '内容、附件与权限档都与记录一致，可以核验恢复。当前权限档为「禁止」，恢复后 AI 仍不可使用该笔记。', true)
    return row('restored', '内容、附件与权限档都与记录一致，可以核验恢复。', true)
  }

  latestFor(relPath: string, expected: string): NoteSnapshot | null {
    this.assertCall()
    const seen = new Set<string>()
    const links = this.successors.get(relPath)
    while (links?.has(expected) && !seen.has(expected)) {
      seen.add(expected)
      expected = links.get(expected)!
    }
    const snapshot = this.verified.get(relPath)?.get(expected)
    return snapshot ? { ...snapshot } : null
  }

  async noteStatus(relPath: string, binding: ObjectBinding): Promise<
    { status: 'ready'; snapshot: NoteSnapshot } |
    { status: 'missing' | 'replaced' | 'unreadable'; sessionId: string; relPath: string; objectVersion: string }
  > {
    this.assertSession(binding.sessionId)
    const base = { sessionId: binding.sessionId, relPath, objectVersion: binding.objectVersion }
    if (this.missingRecord(relPath)) {
      // 记录在案的外部消失：文件不在就是 missing；文件已回来但核验未过，不能当作已验证的原对象。
      let present = false
      if (this.root && this.hasUsableRoot()) {
        try { present = !!secureFsFor(this.root).resolve(relPath) } catch { present = false }
      }
      return { ...base, status: present ? 'unreadable' : 'missing' }
    }
    try {
      const snapshot = await this.read(relPath)
      if (!this.acceptsObject(relPath, binding.objectVersion, snapshot.objectVersion)) return { ...base, status: 'replaced' }
      return { status: 'ready', snapshot }
    } catch (error) {
      this.assertSession(binding.sessionId)
      const missing = error instanceof Error && error.message === 'NOTE_MISSING'
      if (missing) await this.recordExternalDisappearance(relPath)
      return { ...base, status: missing ? 'missing' : 'unreadable' }
    }
  }

  write(relPath: string, content: string, expectedRevision: string): Promise<string>
  write(relPath: string, content: string, expectedRevision: string, binding: ObjectBinding): Promise<ObjectBinding & { revision: string }>
  async write(relPath: string, content: string, expectedRevision: string, binding?: ObjectBinding): Promise<string | (ObjectBinding & { revision: string })> {
    const token = binding?.sessionId ?? this.captureSession()
    this.assertSession(token)
    const root = this.root!
    return this.mutations.run(async () => {
      this.assertSession(token)
      try {
        this.requireUsableRoot()
        const lifecycle=this.lifecycle?.status()
        if(lifecycle?.status==='invalid'||lifecycle?.operation?.kind==='ledger-repair')throw Error('LIFECYCLE_RECOVERY_REQUIRED')
        if(this.missingRecord(relPath)){
          // 写回前检查：外部消失未核验时，路径不在按缺失拒绝，文件已回来也不能当作原对象续写。
          let present=false
          try{present=!!secureFsFor(root).resolve(relPath)}catch{/* 路径不在就是缺失 */}
          throw Error(present?'NOTE_UNREADABLE':'NOTE_MISSING')
        }
        const current = await readNoteSnapshot(root, relPath)
        this.assertSession(token)
        this.requireUsableRoot()
        if (binding && !this.acceptsObject(relPath, binding.objectVersion, current.objectVersion)) throw new Error('NOTE_REPLACED')
        if (current.revision !== expectedRevision) throw new Error('CONFLICT')
        const tail=partitionSource(current.content).ledger
        if(partitionSource(content).ledger!==null)throw new Error('LEDGER_BOUNDARY_INVALID')
        content=composeSource(content,tail)
        assertLedgerPreserved(content,tail)
        const links = this.successors.get(relPath) ?? new Map<string, string>()
        if (!links.has(current.objectVersion) && links.size >= 8192) throw new Error('OBJECT_BINDING_LIMIT')
        this.requireSnapshotCapacity(relPath, 'pending-save', content, current.objectVersion)
        const saved = await writeNote(root, relPath, content, expectedRevision, current.objectVersion)
        this.assertSession(token)
        await this.recordCommittedWrite({ relPath, previousPath: relPath, previousObjectVersion: current.objectVersion, objectVersion: saved.objectVersion, content })
        return binding ? { ...saved, sessionId: token } : saved.revision
      } catch (error) {
        this.assertSession(token)
        const failure=noteReadError(error)
        if(failure.message==='NOTE_MISSING')await this.recordExternalDisappearance(relPath)
        if (error instanceof Error && ['CONFLICT', 'NOTE_REPLACED', 'LEDGER_BOUNDARY_INVALID', 'LIFECYCLE_RECOVERY_REQUIRED'].includes(error.message)) throw error
        throw failure
      }
    })
  }

  private recordCommittedWrite(write: CommittedNoteWrite): void {
    const { relPath, previousPath, previousObjectVersion, objectVersion, content } = write
    if (previousPath !== relPath) this.moveObjectBinding(previousPath, relPath, previousObjectVersion)
    const links = this.successors.get(relPath) ?? new Map<string, string>()
    if (!links.has(previousObjectVersion) && links.size >= 8192) throw new Error('OBJECT_BINDING_LIMIT')
    this.requireSnapshotCapacity(relPath, objectVersion, content, previousObjectVersion)
    for (const [previous, next] of links) if (next === previousObjectVersion) links.set(previous, objectVersion)
    links.set(previousObjectVersion, objectVersion)
    this.successors.set(relPath, links)
    const previousContent=this.verified.get(relPath)?.get(previousObjectVersion)?.content
    const revision = revisionOf(content)
    this.verified.get(relPath)?.delete(previousObjectVersion)
    this.remember(relPath, { content, revision, objectVersion, sessionId: this.captureSession() })
    this.lastWrites.set(relPath, { revision, objectVersion, at: Date.now() })
    this.index.markDirty()
    let materialControls:import('./working-memory-store.ts').WorkingSnapshot|undefined;try{materialControls=this.workingMemory?.read()}catch{/* Unverified memory controls cannot authorize identity GC. */}
    try { this.ledgerStore?.onWrite(relPath,previousObjectVersion,objectVersion,content,previousContent,materialControls) } catch { this.ledgerFailure='LEDGER_OWNERSHIP_UNVERIFIED';this.emit('tree:changed') }
    if(previousPath===relPath&&previousContent!==undefined&&materialControls?.raw){
      try{if(this.rebindMemoryAfterWrite(materialControls,relPath,previousObjectVersion,objectVersion,previousContent,content,revision))this.memoryBindingFailure=null}
      catch{this.memoryBindingFailure='MEMORY_SOURCE_REBIND_FAILED';this.emit('tree:changed')}
    }
  }

  private rebindMemoryAfterWrite(basis:WorkingSnapshot,relPath:string,before:string,after:string,oldContent:string,newContent:string,revision:string):boolean{
    if(!this.workingMemory)return false
    const oldParsed=compile(oldContent),newParsed=compile(newContent)
    if(oldParsed.stale||newParsed.stale)return false
    const oldBodyHash=bodyFingerprint(oldContent,oldParsed),newBodyHash=bodyFingerprint(newContent,newParsed)
    const savedChapters=new Map<string,ReturnType<LedgerStore['contextForRecord']>[number]|null>()
    const clearedTasks=new Set<string>()
    const locate=(source:WorkingSource,parsed:ReturnType<typeof compile>)=>{
      if(createHash('sha256').update(source.text).digest('hex')!==source.hash)return null
      const raw=parsed.partition.body,at=raw.indexOf(source.text)
      if(at<0||raw.indexOf(source.text,at+1)>=0)return null
      const block=parsed.index.blocks.find(b=>b.range.start<=at&&b.range.end>=at+source.text.length)
      if(!block||block.identity==='ai'||source.classification==='command'&&block.identity!=='command'||source.classification!=='command'&&block.identity==='command')return null
      return {at,end:at+source.text.length,identity:block.identity}
    }
    const patches:WorkingBindingPatch[]=[]
    for(const entry of [...basis.record.entries,...basis.record.recent]){
      const updates:WorkingBindingPatch['sources']=[]
      for(const source of entry.sources){
        const owns=source.relPath===relPath&&this.acceptsObject(relPath,source.objectVersion,after)
        let proven=false,start=source.start,end=source.end
        if(owns&&source.kind==='body'){
          const old=locate(source,oldParsed),next=locate(source,newParsed)
          if(old&&next&&old.identity===next.identity){proven=true;start=next.at;end=next.end}
        }else if(owns&&source.kind==='ledger'&&source.taskId&&source.classification==='command'){
          try{let chapter=savedChapters.get(source.taskId)
            if(chapter===undefined){const task=this.ledgerStore!.getRecord(relPath,source.taskId);if(task.state==='cleared')clearedTasks.add(source.taskId);chapter=task.state==='saved'?this.ledgerStore!.contextForRecord(task).find(c=>c.taskId===source.taskId)??null:null;savedChapters.set(source.taskId,chapter)}
            if(clearedTasks.has(source.taskId))proven=true
            else if(chapter?.fields?.status==='valid'&&chapter.eligible!==false&&(!source.taskMaterialHash||createHash('sha256').update(chapter.text).digest('hex')===source.taskMaterialHash)){
              const field=chapter.fields.prompt,exact=chapter.text.slice(source.start,source.end)===source.text
              const at=exact?source.start:chapter.text.indexOf(source.text)
              if(at>=field.start&&at+source.text.length<=field.end&&(exact||chapter.text.indexOf(source.text,at+1)<0))proven=true
            }
          }catch{savedChapters.set(source.taskId,null)/* A missing or changed saved task cannot renew an object binding. */}
        }
        const deps=source.sourceDeps.filter(d=>d.relPath===relPath&&this.acceptsObject(relPath,d.objectVersion,after)&&oldBodyHash===d.bodyHash&&newBodyHash===d.bodyHash).map(d=>({relPath:d.relPath,oldObjectVersion:d.objectVersion,objectVersion:after}))
        if(proven||deps.length)updates.push({id:source.id,oldObjectVersion:source.objectVersion,objectVersion:proven?after:source.objectVersion,revision:proven?revision:source.revision,start,end,deps})
      }
      if(updates.length)patches.push({id:entry.id,version:entry.version,sources:updates})
    }
    if(!patches.length)return false
    this.workingMemory.rebindCommittedWrite(basis,patches)
    return true
  }

  /** Move only bindings that lead to the explicitly verified filesystem object. */
  private moveObjectBinding(from: string, to: string, objectVersion: string): void {
    if (from === to) return
    const versions = this.verified.get(from)
    const selected = [...(versions ?? [])].filter(([id]) => this.acceptsObject(from, id, objectVersion))
    const links = this.successors.get(from)
    const selectedLinks = [...(links ?? [])].filter(([, id]) => this.acceptsObject(from, id, objectVersion))
    const targetVersions = this.verified.get(to) ?? new Map<string, NoteSnapshot>()
    const targetLinks = this.successors.get(to) ?? new Map<string, string>()
    if (new Set([...targetVersions.keys(), ...selected.map(([id]) => id)]).size > 2 ||
        new Set([...targetLinks.keys(), ...selectedLinks.map(([id]) => id)]).size > 8192) throw new Error('OBJECT_BINDING_LIMIT')
    for (const [id, snapshot] of selected) { targetVersions.set(id, snapshot); versions!.delete(id) }
    if (targetVersions.size) this.verified.set(to, targetVersions)
    if (versions?.size === 0) this.verified.delete(from)
    for (const [id, successor] of selectedLinks) { targetLinks.set(id, successor); links!.delete(id) }
    if (targetLinks.size) this.successors.set(to, targetLinks)
    if (links?.size === 0) this.successors.delete(from)
    if (this.latestObjects.get(from) === objectVersion) this.latestObjects.delete(from)
    if (selected.length) this.latestObjects.set(to, objectVersion)
  }

  private requireSnapshotCapacity(relPath: string, objectVersion: string, content: string, replaced?: string): void {
    const current = this.verified.get(relPath)
    const retained = [...(current?.keys() ?? [])].filter((id) => id !== objectVersion && id !== replaced)
    if (retained.length >= 2) throw new Error('OBJECT_BINDING_LIMIT')
    let bytes = Buffer.byteLength(content, 'utf8')
    for (const [knownPath, versions] of this.verified) for (const [id, snapshot] of versions) {
      if (knownPath === relPath && (id === objectVersion || id === replaced)) continue
      bytes += Buffer.byteLength(snapshot.content, 'utf8')
    }
    for(const proof of this.protectedSources.values())if(proof.snapshot.sessionId!==this.token)bytes+=Buffer.byteLength(proof.snapshot.content,'utf8')
    if (bytes > 64 * 1024 * 1024) throw new Error('OBJECT_BINDING_LIMIT')
  }

  private remember(relPath: string, snapshot: NoteSnapshot): boolean {
    const latest = this.latestObjects.get(relPath)
    // 已有后继身份时拒绝把 latestObjects / verified 指回旧对象。
    if (latest && latest !== snapshot.objectVersion && this.acceptsObject(relPath, snapshot.objectVersion, latest)) {
      return false
    }
    this.requireSnapshotCapacity(relPath, snapshot.objectVersion, snapshot.content)
    const versions = this.verified.get(relPath) ?? new Map<string, NoteSnapshot>()
    versions.set(snapshot.objectVersion, { ...snapshot })
    this.verified.set(relPath, versions)
    this.latestObjects.set(relPath, snapshot.objectVersion)
    return true
  }

  async previewSaveCopy(request: SaveCopyPreviewRequest, chapters: readonly LedgerChapterWrite[] = []): Promise<SaveCopyPreviewView> {
    this.assertSession(request.sessionId)
    await this.lifecycleReady
    this.assertSession(request.sessionId)
    return this.mutations.run(async () => {
      this.assertSession(request.sessionId)
      if(request.sourceSessionId)this.requireUsableRoot();else this.requireStableStructure()
      this.checkCopyPaths(request.source, request.target)
      if (partitionSource(request.body).ledger !== null) throw new Error('BAD_BODY')
      const basis = request.sourceSessionId?this.protectedRootSource(request.sourceSessionId,request.source,request.objectVersion)?.snapshot:this.latestFor(request.source, request.objectVersion)
      if (!basis) throw new Error('LEDGER_BASIS_UNAVAILABLE')
      if (!request.sourceSessionId&&(await this.noteStatus(request.source, request)).status === 'ready') throw new Error('SOURCE_AVAILABLE')
      this.assertSession(request.sessionId)
      const parentIdentity = this.copyTargetIdentity(request.target)
      const content = request.body
      const view: SaveCopyPreviewView = { id: randomUUID(), sessionId: request.sessionId, source: request.source,
        target: request.target, draftVersion: request.draftVersion, pendingTaskIds: request.sourceSessionId?[]:chapters.map((chapter) => chapter.taskId),
        warning: request.sourceSessionId?'只保留正文为新笔记，不复制账本、历史、附件或记忆，不确认旧待保存回答；原窗口稿取消或失败时保留。':'另存创建新笔记归属，保留窗口正文及本预览列出的旧账本恢复材料和待保存任务记录；原账本不移动，不复制附件、不重启任务。' }
      this.copyPreviews.clear();this.ledgerRecoveryPreviews.clear()
      this.copyPreviews.set(view.id, { view: { ...view, pendingTaskIds: [...view.pendingTaskIds] }, request: { ...request }, content,
        bodyHash: revisionOf(request.body), basisHash: revisionOf(basis.content), pendingHash: revisionOf(JSON.stringify(chapters)), parentIdentity })
      return view
    })
  }

  saveCopyRequestById(id: string): SaveCopyPreviewRequest | null {
    this.assertCall()
    const prepared = this.copyPreviews.get(id)
    return prepared ? { ...prepared.request } : null
  }

  async commitSaveCopy(request: SaveCopyCommitRequest, chapters: readonly LedgerChapterWrite[] = [], assertOwner:()=>void=()=>{}): Promise<{ relPath: string; snapshot: NoteSnapshot; taskIds: string[] }> {
    this.assertSession(request.sessionId)
    await this.lifecycleReady
    this.assertSession(request.sessionId)
    return this.mutations.run(async () => {
      assertOwner();this.assertSession(request.sessionId)
      const prepared = this.copyPreviews.get(request.id)
      if(prepared?.request.sourceSessionId)this.requireUsableRoot();else this.requireStableStructure()
      if (!prepared || prepared.view.sessionId !== request.sessionId || prepared.view.draftVersion !== request.draftVersion ||
          revisionOf(request.body) !== prepared.bodyHash || revisionOf(JSON.stringify(chapters)) !== prepared.pendingHash) {
        throw new Error('STALE_PREVIEW')
      }
      const basis = prepared.request.sourceSessionId?this.protectedRootSource(prepared.request.sourceSessionId,prepared.request.source,prepared.request.objectVersion)?.snapshot:this.latestFor(prepared.request.source, prepared.request.objectVersion)
      if (!basis || revisionOf(basis.content) !== prepared.basisHash) throw new Error('STALE_PREVIEW')
      if (!prepared.request.sourceSessionId&&(await this.noteStatus(prepared.request.source, prepared.request)).status === 'ready') throw new Error('SOURCE_AVAILABLE')
      assertOwner();this.assertSession(request.sessionId)
      if(prepared.request.sourceSessionId)this.requireUsableRoot();else this.requireStableStructure()
      if (this.copyTargetIdentity(prepared.view.target) !== prepared.parentIdentity) throw new Error('STALE_PREVIEW')
      const root = this.root!
      this.requireSnapshotCapacity(prepared.view.target, 'pending-copy', prepared.content)
      assertOwner()
      const objectVersion = secureFsFor(root).replace(prepared.view.target, null, prepared.content)
      // Publication has already happened. A changed parent is a verification
      // failure, not a rollback: keep the draft, pending chapters and new file.
      this.verifyCopyParent(prepared.view.target, prepared.parentIdentity)
      let written: Awaited<ReturnType<typeof readNoteSnapshot>>
      try { written = await readNoteSnapshot(root, prepared.view.target) }
      catch {
        this.verifyCopyParent(prepared.view.target, prepared.parentIdentity)
        throw new Error('COPY_VERIFY_FAILED')
      }
      assertOwner();this.assertSession(request.sessionId)
      this.verifyCopyParent(prepared.view.target, prepared.parentIdentity)
      if (written.objectVersion !== objectVersion || written.content !== prepared.content) throw new Error('COPY_VERIFY_FAILED')
      const snapshot = { ...written, sessionId: request.sessionId }
      if(!prepared.request.sourceSessionId)this.ledgerStore!.recoveryCopy(prepared.request.source, prepared.view.target, prepared.request.objectVersion, partitionSource(basis.content).ledger, chapters)
      this.remember(prepared.view.target, snapshot)
      this.lastWrites.set(prepared.view.target, { revision: snapshot.revision, objectVersion, at: Date.now() })
      this.copyPreviews.delete(request.id)
      this.index.markDirty()
      this.emit('tree:changed')
      return { relPath: prepared.view.target, snapshot, taskIds: [...prepared.view.pendingTaskIds] }
    })
  }

  private requireStableStructure(): void {
    this.requireUsableRoot()
    if (this.lifecycleError || this.lifecycle?.status().status !== 'ready') throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
  }

  private checkCopyPaths(source: string, target: string): void {
    for (const relPath of [source, target]) {
      if (!isNotePath(relPath) || hasHiddenSegment(relPath) || !resolveInVault(this.root!, relPath) ||
          relPath.includes('\\') || relPath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('BAD_PATH')
    }
    if (source.normalize('NFC').toLowerCase() === target.normalize('NFC').toLowerCase()) throw new Error('BAD_PATH')
  }

  private copyParentIdentity(target: string): string {
    const fs = secureFsFor(this.requireUsableRoot())
    const parent = target.split('/').slice(0, -1).join('/')
    const components = parent ? fs.resolve(parent) : []
    if (parent && components.at(-1)?.kind !== 'dir') throw new Error('BAD_PATH')
    return JSON.stringify(components)
  }

  private verifyCopyParent(target: string, expected: string): void {
    try { if (this.copyParentIdentity(target) === expected) return }
    catch { /* Missing or unreadable parents cannot confirm publication. */ }
    throw new Error('COPY_PARENT_CHANGED')
  }

  private copyTargetIdentity(target: string): string {
    const identity = this.copyParentIdentity(target)
    const fs = secureFsFor(this.requireUsableRoot())
    try { fs.resolve(target); throw new Error('EEXIST') }
    catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) throw error }
    return identity
  }

  /** `options.humanInitiated` 只由人用的新建入口设置：人确实在原路径重新建同名对象时，
   *  旧记录退休（不再占路径）并照常创建；默认（AI／无标记调用）行为不变，路径被占仍拒。 */
  async create(name: string, parent = '', options: { humanInitiated?: boolean } = {}): Promise<string> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const relPath = await this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      const reserved: RetiredObject[] = []
      try {
        if (options.humanInitiated) {
          const retired = this.retireReservedNote(name, parent)
          if (retired) reserved.push(retired)
        } else this.refuseReservedPath(name, parent)
        return await createNote(root, name, parent)
      } catch (error) {
        this.restoreRetired(reserved)
        throw error
      }
    })
    this.assertSession(token); this.requireUsableRoot()
    this.index.markDirty()
    return relPath
  }

  /** 「建」的原子落地：正文与文件一次出现（库层排他创建），写失败不留空笔记。
   *  走与 `create` 同一条写入队列与索引失效，不新增删除路径来回收半成品。
   *  前提：本入口只由「建」工具在**人确认预览（含确切 relPath）之后**调用——那次确认即同意
   *  放弃原路径旧对象的恢复核验，所以这里先退休记录再创建；没有人工确认的调用方不得走本入口。 */
  async createWithContent(name: string, parent: string, content: string): Promise<{ relPath: string; revision: string; objectVersion: string }> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const result = await this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      const reserved: RetiredObject[] = []
      let created!: { relPath: string; revision: string; objectVersion: string }
      try {
        // 与人的写入同一条边界：正文里不许藏着机器账本分区，新笔记不能带着「假历史」出生。
        if (partitionSource(content).ledger !== null) throw new Error('LEDGER_BOUNDARY_INVALID')
        const retired = this.retireReservedNote(name, parent)
        if (retired) reserved.push(retired)
        // 只把创建本身放进回滚范围：创建成功后的会话／库根复查失败不该把记录退回活跃列表。
        created = await createNoteWithBody(root, name, parent, content)
      } catch (error) {
        this.restoreRetired(reserved)
        throw error
      }
      this.assertSession(token); this.requireUsableRoot()
      return created
    })
    this.assertSession(token); this.requireUsableRoot()
    this.remember(result.relPath, { content, revision: result.revision, objectVersion: result.objectVersion, sessionId: token })
    this.lastWrites.set(result.relPath, { revision: result.revision, objectVersion: result.objectVersion, at: Date.now() })
    this.index.markDirty()
    return result
  }

  /** 目录也占路径：`b` 是 `b.md` 的附件身份，`b.md` 本身则是它的原路径，两者都对应同一条记录。
   *  人新建时两条身份都退休；默认仍两条都拒。 */
  async createFolder(name: string, parent = '', options: { humanInitiated?: boolean } = {}): Promise<string> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const relPath = await this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      const reserved: RetiredObject[] = []
      try {
        if (options.humanInitiated) {
          const note = this.retireReservedNote(name, parent)
          if (note) reserved.push(note)
          const folder = this.retireReservedFolder(name, parent)
          if (folder) reserved.push(folder)
        } else {
          this.refuseReservedPath(name, parent)
          this.refuseReservedFolder(name, parent)
        }
        return await createFolder(root, name, parent)
      } catch (error) {
        this.restoreRetired(reserved)
        throw error
      }
    })
    this.assertSession(token); this.requireUsableRoot()
    this.index.markDirty()
    this.emit('tree:changed')
    return relPath
  }

  private assertCall(): void {
    const call = this.calls.getStore()
    if (call && call.sessionId !== this.token) throw new Error('VAULT_CHANGED')
  }

  /** Trusted content IPC retains its original mount across every awaited continuation. */
  runBound<T>(sessionId: string | null, operation: () => T): T {
    this.assertCall()
    if (sessionId !== this.token) throw new Error('VAULT_CHANGED')
    return this.calls.run({sessionId}, operation)
  }

  sessionId(): string | null { this.assertCall(); return this.token }

  captureSession(): string {
    this.assertCall()
    if (!this.root || !this.token) throw new Error('NO_VAULT')
    return this.token
  }

  assertSession(token: string): void {
    this.assertCall()
    if (this.token !== token || !this.root) throw new Error('VAULT_CHANGED')
  }

  async previewRelocation(request: RelocationRequest, token = this.captureSession()): Promise<RelocationPreview> {
    this.assertSession(token)
    const lifecycle = this.lifecycle
    const ready = this.lifecycleReady
    await ready
    this.assertSession(token)
    if (this.lifecycleError) throw this.lifecycleError
    if (!lifecycle) throw new Error('NO_VAULT')
    const result = await lifecycle.preview(request)
    this.assertSession(token)
    return result
  }

  relocationPreviewById(id: string): RelocationPreview | null { this.assertCall(); return this.lifecycle?.peek(id) ?? null }

  async previewTrash(relPath: string, token = this.captureSession()): Promise<TrashPreview> {
    this.assertSession(token)
    const lifecycle = this.lifecycle
    await this.lifecycleReady
    this.assertSession(token)
    if (this.lifecycleError) throw this.lifecycleError
    if (!lifecycle) throw new Error('NO_VAULT')
    this.requireStableStructure()
    const preview = lifecycle.previewTrash(relPath)
    this.assertSession(token)
    return preview
  }

  trashPreviewById(id: string): TrashPreview | null { this.assertCall(); return this.lifecycle?.peekTrash(id) ?? null }

  async commitTrash(id: string, allow: false, token?: string, attribution?: { taskId: string; prompt: string }): Promise<{ cancelled: true }>
  async commitTrash(id: string, allow: true, token?: string, attribution?: { taskId: string; prompt: string }): Promise<TrashCommitOutcome>
  async commitTrash(id: string, allow: boolean, token = this.captureSession(), attribution?: { taskId: string; prompt: string }): Promise<{ cancelled: true } | TrashCommitOutcome> {
    this.assertSession(token)
    const lifecycle = this.lifecycle
    await this.lifecycleReady
    this.assertSession(token)
    if (this.lifecycleError) throw this.lifecycleError
    if (!lifecycle) throw new Error('NO_VAULT')
    const preview = lifecycle.peekTrash(id)
    if (!preview || preview.sessionId !== token) throw new Error('STALE_PREVIEW')
    if (!allow) {
      lifecycle.discardTrash(id)
      return { cancelled: true }
    }
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) {
      lifecycle.discardTrash(id)
      throw new Error('PLATFORM_UNPROVEN')
    }
    if (!this.allowLegacySystemTrashForTests) {
      // 新删除走 `trashDelete`（库内 .rgent-trash）。旧系统送篓管线只留给钉住历史语义的
      // 测试；生产入口即使拿到预览也不许再从这里删盘。
      lifecycle.discardTrash(id)
      throw new Error('TRASH_LEGACY_TEST_ONLY')
    }
    return this.mutations.run(async () => {
      this.assertSession(token)
      this.requireStableStructure()
      const root = this.root!
      const fs = secureFsFor(root)
      let current: ReturnType<typeof fs.resolve>[number] | undefined
      try { current = fs.resolve(preview.relPath).at(-1) }
      catch (error) {
        lifecycle.discardTrash(id)
        if (error instanceof Error && error.message === 'ENOENT') throw new Error('PATH_CHANGED')
        throw error
      }
      if (!current || current.kind !== 'file' || current.id !== preview.objectVersion) {
        lifecycle.discardTrash(id)
        throw new Error('PATH_CHANGED')
      }
      const body = fs.readSnapshot(preview.relPath)
      const bodyRevision = createHash('sha256').update(body.bytes).digest('hex')
      let noteId: string = randomUUID()
      try {
        const owner = this.ledgerStore?.recoveryOwners().owners.find((item) => item.relPath === preview.relPath)
        if (owner) noteId = owner.noteId
      } catch { /* 未登记笔记仍写消失记录 */ }
      let attachments: MissingObject['attachments'] = []
      try { attachments = this.ledgerStore?.attachmentEvidence(preview.relPath) ?? [] }
      catch { attachments = [] }
      const snapshot = await loadPermissionSnapshot(root)
      const effective = snapshot.state.status === 'ready' ? effectivePermissionEntries(root, snapshot.state.entries) : null
      // 权限名单读不了时原本写 forbidden；这会谎称「当时是禁止档」并把恢复卡死，改记 unknown。
      const permissionTier: MissingObject['permissionTier'] = effective ? tierFor(preview.relPath, effective) : 'unknown'
      const landing = fs.trash(preview.relPath, preview.objectVersion)
      lifecycle.discardTrash(id)
      // 系统调用之后分开核验两件事：原路径是否空出来、落点是否还是刚才确认的对象。
      // 冲突先记下不立刻抛：落点核验更关键（删错对象要压过冲突上报），记录也照写。
      let conflict: Error | null = null
      try { postTrashOutcome(() => fs.resolve(preview.relPath).at(-1) ?? null) }
      catch (error) {
        if (error instanceof Error && error.message === 'TRASH_CONFLICT') conflict = error
        else throw error
      }
      let landingVerified: TrashLandingVerdict
      try { landingVerified = verifyLanding(landing, preview.objectVersion, landingStat) }
      catch (error) {
        // 删错对象时不能写「这篇笔记已进废纸篓」的记录：先丢掉运行时绑定再响亮停下。
        // 把系统实际给出的落点挂到错误上：人要知道东西去了哪儿（它可能不是原对象）。
        this.forgetTrashedPath(preview.relPath)
        if (error instanceof Error && landing) (error as Error & { landing?: string }).landing = landing
        throw error
      }
      const degraded: TrashDegradedReason[] = []
      try {
        lifecycle.recordMissing({
          relPath: preview.relPath, noteId, objectVersion: preview.objectVersion, bodyRevision, attachments,
          rootIdentity: this.rootIdentity ?? vaultRootIdentity(root), permissionTier, detectedAt: new Date().toISOString(),
          cause: 'trash'
        })
      } catch (error) {
        // 超限或 journal 被占用：内存占位保留（重启前仍占路径），并把降级如实带出去。
        this.reservedMissing.add(preview.relPath)
        degraded.push(error instanceof Error && error.message === 'MISSING_RECORD_LIMIT' ? 'record-limit' : 'record-failed')
      }
      let attachmentLanding: string | null = null
      let orphan = false
      let orphanReason: TrashOrphanReason | undefined
      if (preview.attachmentPath && preview.attachmentId) {
        const attachmentPath = preview.attachmentPath
        try {
          const attach = fs.resolve(attachmentPath).at(-1)
          if (!attach || attach.kind !== 'dir' || attach.id !== preview.attachmentId) throw new Error('PATH_CHANGED')
          attachmentLanding = fs.trash(attachmentPath, preview.attachmentId)
          postTrashOutcome(() => fs.resolve(attachmentPath).at(-1) ?? null)
          verifyLanding(attachmentLanding, preview.attachmentId, landingStat)
        } catch (error) {
          // 第二步不再把 ENOENT 吞成普通成功：预览承诺过一起送篓，夹子不在了也要如实报。
          orphan = true
          orphanReason = error instanceof Error && error.message === 'ENOENT' ? 'attachment-missing' : 'attachment-failed'
        }
      }
      try { this.ledgerStore?.recordHumanTrash(preview.relPath, landing, attachmentLanding, orphan, attribution) }
      catch { degraded.push('ledger-failed') }
      this.forgetTrashedPath(preview.relPath)
      if (conflict) {
        if (landing) (conflict as Error & { landing?: string }).landing = landing
        throw conflict
      }
      return {
        cancelled: false, relPath: preview.relPath, landing, landingVerified, attachmentLanding, orphan,
        ...(orphanReason ? { orphanReason } : {}), degraded
      }
    })
  }

  /** 送篓之后这个路径的运行时绑定不能再当原对象：树要重扫，已验证快照也要丢。 */
  private forgetTrashedPath(relPath: string): void {
    this.verified.delete(relPath)
    this.latestObjects.delete(relPath)
    this.index.markDirty()
    this.emit('tree:changed')
  }

  /* ------------------------------------------------------------ 库内「已删除」 */

  /**
   * 人／AI 共用的删除：进库根 `.rgent-trash`（隐藏），不再是「第一站就送系统废纸篓」。
   * 磁盘事务（核身份／附件、建 meta、移动、回滚）在 `TrashStore`；这里补会话、
   * 权限证据、journal `trashed[]`、既有账本记录、`note:deleted` 事件与删后清理。
   * `attribution.source` 缺省按人删；AI 传 `ai` 与任务 id，账本能审。
   */
  async trashDelete(relPath: string, attribution: { source?: 'human' | 'ai'; taskId?: string } = {}):
    Promise<TrashPurgeResult & { relPath?: string; trashId?: string }> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    try {
      return await this.mutations.run(async () => {
        this.assertSession(token)
        this.requireStableStructure()
        // 删除／还原／明确删除共用同一条平台边界：收尾靠原生 trash，只有 macOS 实现。
        if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) throw new Error('PLATFORM_UNPROVEN')
        const root = this.requireUsableRoot()
        if (!isNotePath(relPath) || hasHiddenSegment(relPath) || relPath.includes('\\') || !resolveInVault(root, relPath)) {
          throw new Error('BAD_PATH')
        }
        // 删除事务要求身份／权限／附件三样都核得动；权限名单读不了就不动磁盘。
        const policy = await loadPermissionSnapshot(root)
        this.assertSession(token)
        this.requireStableStructure()
        if (policy.state.status !== 'ready') throw new Error('PERMISSIONS_INVALID')
        if (this.lifecycle!.trashedObjects().length >= TRASH_RECORD_LIMIT) throw new Error('TRASH_RECORD_LIMIT')
        const canonicalPath = secureFsFor(root).resolve(relPath).map((part) => part.name).join('/')
        const permissionTier = tierFor(canonicalPath, effectivePermissionEntries(root, policy.state.entries))
        const source = attribution.source ?? 'human'
        const store = this.trashStore()
        const outcome = store.delete(relPath, {
          source,
          permissionTier,
          ...(attribution.taskId ? { taskId: attribution.taskId } : {}),
          // 第 3 步的整体：meta 已写成 trashed，这里写 journal 与既有账本记录。
          // 任一步失败都让调用方回滚已移动项（文件退回原位、条目清掉），报 TRASH_PARTIAL。
          record: (meta) => {
            this.lifecycle!.addTrashed({
              trashId: meta.trashId, relPath: meta.originalRelPath, objectVersion: meta.objectVersion,
              contentHash: meta.contentHash, at: meta.deletedAt
            })
            try {
              const folder = meta.attachmentRelPath === null ? null : meta.attachmentRelPath.split('/').pop() ?? null
              this.ledgerStore?.recordHumanTrash(meta.originalRelPath, store.entryDir(meta.trashId),
                folder === null ? null : `${store.payloadDir(meta.trashId)}/${folder}`, false, {
                  taskId: attribution.taskId ?? (source === 'ai' ? `aitrash-${meta.trashId}` : 'humantrash'),
                  prompt: source === 'ai' ? 'AI 移入库内已删除' : '移入库内已删除'
                })
              // Active path loses its owner; the old history moves out of the hot registry.
              this.ledgerStore?.archiveTrashed(meta.objectVersion, meta.trashId)
            } catch (error) {
              // 账本写不进去就把刚写的 journal 记录退回：一次删除要么三样都落下，要么什么都不留。
              try { this.lifecycle!.removeTrashed(meta.trashId) } catch { this.trashIssues.push(`delete-journal:${meta.trashId}`) }
              throw error
            }
          }
        })
        this.assertSession(token)
        const original = outcome.meta.originalRelPath
        this.reservedMissing.delete(original)
        this.forgetTrashedPath(original)
        // 人删与 AI 删是同一条事件；index 转发给渲染层关闭 tab。
        this.emit('note:deleted', { relPath: original, sessionId: token, trashId: outcome.meta.trashId })
        // 每次删除后扫一遍；刚删的这条不在当场清理范围（它还没到 30 天，也不该立刻被大小上限顶掉）。
        try { this.sweepTrashEntries([outcome.meta.trashId]) } catch (error) { this.trashIssues.push(`sweep:${codeOf(error)}`) }
        return { ok: true as const, relPath: original, trashId: outcome.meta.trashId }
      })
    } catch (error) {
      // 回滚后的失败只报 TRASH_PARTIAL；真正的原因（journal 写失败、路径被换等）留在诊断里。
      if (error instanceof Error && error.message === 'TRASH_PARTIAL' && error.cause) this.trashIssues.push(`delete:${codeOf(error.cause)}`)
      return { ok: false, error: codeOf(error) }
    }
  }

  /** 库内「已删除」列表；坏条目与只剩 journal 记录的条目都以 damaged 列出，不丢。 */
  async trashList(): Promise<TrashListResult> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    try {
      return await this.mutations.run(() => {
        this.assertSession(token)
        this.requireUsableRoot()
        const listed = this.trashStore().list(this.lifecycle?.trashedObjects() ?? [])
        // Old entries created before the history split: attach their active owner to history lazily.
        for (const entry of listed.entries) {
          if (this.ledgerStore?.historyEntryForTrash(entry.id)) continue
          try {
            const meta = this.trashStore().readMeta(entry.id)
            if (meta) this.ledgerStore?.archiveTrashed(meta.objectVersion, entry.id)
          } catch { /* a damaged/old entry stays readable in the list; no mutation is required */ }
        }
        const entries = listed.entries.map(entry => ({
          ...entry,
          ...(this.ledgerStore?.historyEntryForTrash(entry.id) ? { hasLedger: true } : {})
        }))
        return { ok: true as const, entries, bytes: listed.bytes }
      })
    } catch (error) {
      return { ok: false, error: codeOf(error) }
    }
  }

  /** 还原一条已删除记录：原位或 `名字（恢复）.md` 副本；父目录缺失则重建。
   *  权限档随 meta 保存；还原后按内核的 `setPermission` 路径写回，不直接碰名单文件。 */
  async trashRestore(id: string): Promise<TrashRestoreResult> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    try {
      return await this.mutations.run(async () => {
        this.assertSession(token)
        this.requireStableStructure()
        const root = this.requireUsableRoot()
        if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) throw new Error('PLATFORM_UNPROVEN')
        if (!isTrashId(id)) throw new Error('BAD_REQUEST')
        const store = this.trashStore()
        const meta = store.readMeta(id)
        const result = store.restore(id)
        if (!result.ok) return result
        this.assertSession(token)
        try {
          const restored = secureFsFor(root).readSnapshot(result.relPath)
          this.ledgerStore?.restoreArchived(id, result.relPath, restored.objectVersion)
        } catch (error) {
          // The file is already back; a failed history reattach is reported, never a reason to remove it.
          this.trashIssues.push(`restore-ledger:${id}:${codeOf(error)}`)
        }
        let permission: TrashRestorePermission | undefined
        try {
          permission = meta?.permissionTier
            ? await this.restoreTrashPermission(meta.permissionTier, result.relPath, meta.originalRelPath)
            : undefined
        } catch (error) {
          // 文件已经还原：权限写不回去只留诊断，不能把整次还原报成失败或撤掉文件。
          this.trashIssues.push(`restore-permission:${id}:${codeOf(error)}`)
        }
        // 记录移除失败不回滚已还原的笔记：旧记录会以 damaged 出现在列表里，可明确删除，不算静默丢。
        try { this.lifecycle!.removeTrashed(id) } catch (error) { this.trashIssues.push(`restore-journal:${id}:${codeOf(error)}`) }
        this.index.markDirty()
        this.emit('tree:changed')
        return { ...result, ...(permission ? { permission } : {}) }
      })
    } catch (error) {
      return { ok: false, error: codeOf(error) }
    }
  }

  /**
   * 把删除时记下的权限档写回还原后的目标：原路径或副本路径当前档一致就什么都不做；
   * 目标已有人显式设过档（含删除期间新设的）就不覆盖，只如实回报；名单读不了也不伪造。
   * 写入走 `permissions.setPermission`（文件夹＋三档、经句柄核验、原子替换）；失败只回报，
   * 不撤已还原的文件。
   */
  private async restoreTrashPermission(original: PermissionTier, relPath: string, originalRelPath: string): Promise<TrashRestorePermission | undefined> {
    const root = this.requireUsableRoot()
    let snapshot
    try { snapshot = await loadPermissionSnapshot(root) } catch { return undefined }
    if (snapshot.state.status !== 'ready') return undefined
    let current: PermissionTier
    let canonicalPath: string
    try {
      canonicalPath = secureFsFor(root).resolve(relPath).map((part) => part.name).join('/')
      current = tierFor(canonicalPath, effectivePermissionEntries(root, snapshot.state.entries))
    } catch { return undefined }
    if (current === original) return undefined
    // 名单里已有直接或上级目录的显式规则：那是人的设置，保留并说明，绝不静默改回原档。
    if (hasExplicitPermissionRule(canonicalPath, snapshot.state.entries)) return { original, current, outcome: 'kept-new' }
    // 还原到副本时只给这一篇写精确档，不能把父目录整层改成原档；还原到原路径同理。
    // 根目录笔记现在也能写精确规则，不再以“没有父目录”为由放弃原档。
    try {
      const state = await setPermissionFile(root, canonicalPath, original)
      const after = state.status === 'ready' ? tierFor(canonicalPath, state.entries) : null
      if (after === original) return { original, current: original, outcome: 'restored', rulePath: canonicalPath }
      return { original, current: after ?? current, outcome: 'unavailable', rulePath: canonicalPath, error: 'PERMISSION_NOT_APPLIED' }
    } catch (error) {
      return { original, current, outcome: 'unavailable', rulePath: canonicalPath, error: codeOf(error) }
    }
  }

  /** 人在「已删除」里明确删除一条：整条目目录送系统废纸篓（绝不 unlink）；失败保留并报错。
   *  只由人的界面调用，AI 工具链不接这个入口。 */
  async trashPurge(id: string): Promise<TrashPurgeResult> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    try {
      return await this.mutations.run(() => {
        this.assertSession(token)
        this.requireStableStructure()
        this.requireUsableRoot()
        if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) throw new Error('PLATFORM_UNPROVEN')
        if (!isTrashId(id)) throw new Error('BAD_REQUEST')
        const recorded = this.lifecycle!.trashedObjects().some((item) => item.trashId === id)
        const result = this.trashStore().purge(id)
        if (!result.ok) return result
        const removed = recorded ? this.lifecycle!.removeTrashed(id) : false
        if (!result.removed && !removed) return { ok: false as const, error: 'TRASH_ENTRY_MISSING' }
        this.ledgerStore?.archivePurged(id)
        this.index.markDirty()
        return { ok: true as const }
      })
    } catch (error) {
      return { ok: false, error: codeOf(error) }
    }
  }

  /** 过期／超额清理：30 天＋1 GiB，从最旧开始送系统废纸篓。只由人（库打开或删后）触发。 */
  async trashSweep(): Promise<TrashPurgeResult> {
    const token = this.captureSession()
    await this.lifecycleReady
    this.assertSession(token)
    try {
      return await this.mutations.run(() => {
        this.assertSession(token)
        this.requireStableStructure()
        this.requireUsableRoot()
        const before = this.trashIssues.length
        this.sweepTrashEntries()
        const failures = this.trashIssues.length - before
        return failures ? { ok: false as const, error: 'TRASH_SWEEP_PARTIAL' } : { ok: true as const }
      })
    } catch (error) {
      return { ok: false, error: codeOf(error) }
    }
  }

  /** 对账与清理留下的小问题；只作诊断，不冒充产品状态。 */
  trashDiagnostics(): readonly string[] { this.assertCall(); return [...this.trashIssues] }

  private trashStore(): TrashStore {
    if (!this.trash) this.trash = new TrashStore(this.requireUsableRoot())
    return this.trash
  }

  /** 启动对账：journal ↔ `.rgent-trash` ↔ 原路径。写 journal 失败只记问题，不让库打不开。 */
  private reconcileTrash(): void {
    const report = this.trashStore().reconcile(this.lifecycle!.trashedObjects())
    for (const record of report.upsert) {
      try { this.lifecycle!.upsertTrashed(record) } catch (error) { this.trashIssues.push(`reconcile-record:${record.trashId}:${codeOf(error)}`) }
    }
    for (const id of report.remove) {
      try { this.lifecycle!.removeTrashed(id) } catch (error) { this.trashIssues.push(`reconcile-remove:${id}:${codeOf(error)}`) }
    }
    this.trashIssues.push(...report.issues)
    if (report.completed.length || report.rolledBack.length || report.restored.length || report.damaged.length) this.index.markDirty()
  }

  private sweepTrashEntries(exclude: readonly string[] = []): void {
    const report = this.trashStore().sweep(exclude)
    for (const id of report.purged) {
      try { this.lifecycle!.removeTrashed(id) } catch (error) { this.trashIssues.push(`sweep-journal:${id}:${codeOf(error)}`) }
    }
    for (const failure of report.failed) this.trashIssues.push(`sweep:${failure.id}:${failure.error}`)
  }

  /** 主动删除的路径不再被当成「库外消失」。记录读不了时按「不是已删除」处理：
   *  整本 journal 坏掉的时候，外部变化事件照样要照常上报。 */
  private trashedPath(relPath: string): boolean {
    try { return this.lifecycle?.isTrashed(relPath) ?? false } catch { return false }
  }

  /** 一批文件变化里的已删除路径 → 删除记录身份；一次读 journal，失败按空集继续上报外部变化。 */
  private trashedPaths(): Map<string, string> {
    try { return new Map((this.lifecycle?.trashedObjects() ?? []).map((item) => [item.relPath, item.objectVersion])) } catch { return new Map() }
  }

  async commitRelocation(id: string, repairLinks: boolean, token = this.captureSession()): Promise<{ moved: RelocationMove[]; unrepaired: string[] }> {
    this.assertSession(token)
    const lifecycle = this.lifecycle
    const ready = this.lifecycleReady
    await ready
    this.assertSession(token)
    if (this.lifecycleError) throw this.lifecycleError
    if (!lifecycle) throw new Error('NO_VAULT')
    const result = await lifecycle.commit(id, { repairLinks })
    this.assertSession(token)
    this.emitRelocation(result)
    return result
  }

  async lifecycleStatus(): Promise<LifecycleStatus> {
    const token = this.captureSession()
    const lifecycle = this.lifecycle!
    await this.lifecycleReady
    this.assertSession(token)
    return lifecycle.status()
  }

  lifecycleRecoveryScope(request: LifecycleRetryRequest): { moved: RelocationMove[]; relPaths: string[] } {
    this.assertSession(request.sessionId)
    if (!this.lifecycle) throw new Error('NO_VAULT')
    return this.lifecycle.recoveryScope(request.revision)
  }

  async lifecycleRetry(request: LifecycleRetryRequest): Promise<{ moved: RelocationMove[]; unrepaired: string[] }> {
    this.assertSession(request.sessionId)
    const lifecycle = this.lifecycle!
    await this.lifecycleReady
    this.assertSession(request.sessionId)
    try {
      const result = await lifecycle.retry(request.revision)
      this.assertSession(request.sessionId)
      this.lifecycleError = null
      this.emitRelocation(result)
      return result
    } catch (error) {
      this.assertSession(request.sessionId)
      if (lifecycle.status().status !== 'ready') this.lifecycleError = new Error('LIFECYCLE_RECOVERY_REQUIRED')
      throw error
    }
  }

  private emitRelocation(result: { moved: RelocationMove[]; unrepaired: string[] }): void {
    for (const relPath of [...this.verified.keys()]) {
      const move = result.moved.find((item) => relPath === item.from || relPath.startsWith(`${item.from}/`))
      if (!move) continue
      const target = `${move.to}${relPath.slice(move.from.length)}`
      try {
        const current = secureFsFor(this.root!).readSnapshot(target)
        this.moveObjectBinding(relPath, target, current.objectVersion)
      } catch { /* An unverified object never acquires a binding by path alone. */ }
    }
    this.index.markDirty()
    this.emit('note:relocated', { moved: result.moved, sessionId: this.captureSession() })
    this.emit('tree:changed')
  }

  async backlinks(relPath: string): Promise<BacklinkGroup[]> {
    if (!this.root) return []
    const token = this.captureSession(); this.requireUsableRoot()
    const result = await this.index.backlinks(relPath)
    this.assertSession(token); this.requireUsableRoot()
    return result
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!this.root) return []
    const token = this.captureSession(); this.requireUsableRoot()
    const result = await this.index.search(query)
    this.assertSession(token); this.requireUsableRoot()
    return result
  }

  dispose(): void {
    this.stopWatch?.()
    this.stopWatch = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.changedNotes.clear()
    this.verified.clear();this.protectedSources.clear()
    this.successors.clear()
    this.latestObjects.clear()
    this.reservedMissing.clear()
    this.copyPreviews.clear();this.ledgerRecoveryPreviews.clear()
    if (this.root) closeSecureFs(this.root)
    this.root = null
    this.rootIdentity = null
    this.rootUnavailable = false
    this.lifecycle = null
    this.trash = null
    this.trashIssues = []
    this.memoryFailure = null
    this.memoryBindingFailure = null
    this.token = null
    this.lifecycleError = null
    this.index.reset()
  }

  private attach(root: string): void {
    this.stopWatch?.()
    this.stopWatch = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.changedNotes.clear()
    this.lastWrites.clear()
    this.verified.clear()
    this.successors.clear()
    this.latestObjects.clear()
    this.reservedMissing.clear()
    this.copyPreviews.clear();this.ledgerRecoveryPreviews.clear()
    if (this.root) closeSecureFs(this.root)
    this.root = path.resolve(root)
    this.rootIdentity = vaultRootIdentity(this.root)
    this.rootUnavailable = false
    this.trash = null
    this.trashIssues = []
    this.memoryFailure = null
    this.memoryBindingFailure = null
    this.initializationFailure = null
    const token = randomUUID()
    this.token = token
    const check = (): void => { this.assertSession(token); this.requireUsableRoot() }
    this.workingMemory=new WorkingMemoryStore(()=>secureFsFor(this.requireUsableRoot()),check)
    this.ledgerStore=new LedgerStore(()=>secureFsFor(this.requireUsableRoot()),check,(relPath,before,after,content)=>{
      check();this.recordCommittedWrite({relPath,previousPath:relPath,previousObjectVersion:before,objectVersion:after,content})
    },()=>this.rootIdentity!,()=>this.captureSession())
    this.ledgerFailure=null
    this.lifecycle = new VaultLifecycle(this.root, this.mutations, token, check, async write => {
      check(); await this.recordCommittedWrite(write)
    }, async receipt=>{check();for(const move of receipt.objects){if(!move.identityProven)continue;this.ledgerStore!.relocate(move.from,move.to,move.objectVersion);try{const basis=this.workingMemory!.read();this.workingMemory!.relocate(basis,move.from,move.to,move.objectVersion)}catch(e){try{secureFsFor(this.root!).readSnapshot('.rgent-memory')}catch(m){if(m instanceof Error&&m.message==='ENOENT')continue}throw e}}})
    this.lifecycleError = null
    this.lifecycleReady = this.lifecycle.recover().then((result) => {
      if (this.token !== token) return
      if (result) this.emitRelocation(result)
      if(this.lifecycle?.status().status!=='ready')return
      try { check(); if(retireMemoryFile(this.root!, check))this.afterMemoryRetirement() } catch { this.memoryFailure = 'MEMORY_RETIREMENT_FAILED' }
      return this.mutations.run(()=>{try{check();const basis=this.workingMemory!.read();if(basis.raw)this.workingMemory!.interrupted(basis)}catch{/* Local memory diagnosis remains accessible; do not block ordinary notes. */}})
    }).then(() => {
      if (this.token !== token) return
      if (this.lifecycle?.status().status !== 'ready') return
      // 库打开时对账并清理：journal ↔ `.rgent-trash` ↔ 原路径，再把过期／超额的最旧条目
      // 送系统废纸篓。任何一步失败只留诊断，不让库打不开、也不静默处理。
      return this.mutations.run(() => {
        try { check(); this.reconcileTrash() } catch (error) { this.trashIssues.push(`reconcile:${codeOf(error)}`) }
        try { check(); this.sweepTrashEntries() } catch (error) { this.trashIssues.push(`sweep:${codeOf(error)}`) }
      })
    }).catch((error: unknown) => {
      if (this.token !== token) return
      this.lifecycleError = error instanceof Error ? error : new Error('LIFECYCLE_RECOVERY_REQUIRED')
    })
    // 换库必须清索引，否则新库会看到旧库的反链。
    this.index.reset()
    try {
      this.stopWatch = watchVault(this.root, (relPath) => { if (this.token === token) this.onFsEvent(relPath) })
    } catch {
      // The binding has committed. Keep its ownership and expose initialization failure.
      this.initializationFailure = '库已打开，但文件变化监听未能启动。请检查目录访问权限后重新打开应用。'
    }
  }

  private onFsEvent(relPath: string | null): void {
    if (this.root && !this.hasUsableRoot()) {
      this.suspendRoot()
      return
    }
    this.index.markDirty()
    if (relPath && isNotePath(relPath)) this.changedNotes.add(relPath)
    if (relPath === null) for (const known of this.verified.keys()) this.changedNotes.add(known)
    if (this.debounce) clearTimeout(this.debounce)
    const token = this.token
    this.debounce = setTimeout(() => {
      if (this.token !== token) return
      this.emit('tree:changed')
      const notes = this.changedNotes
      this.changedNotes = new Set()
      // 主动删进库内「已删除」的路径只在「路径仍不存在、删除记录身份未变」时抑制
      // `note:external-change`：每批只读一次 journal（整批几十条笔记时不至于每条读一遍记录）。
      // 原路径出现新对象就要照常通知，不能拿旧删除记录永久吞掉外部变化；记录已不在时也照常通知。
      const trashed = this.trashedPaths()
      if (this.root) for (const note of notes) {
        if (trashed.has(note)) {
          let present = true
          try { present = !!secureFsFor(this.root).resolve(note) } catch (error) {
            present = !(error instanceof Error && error.message === 'ENOENT')
          }
          // 路径还空着，且运行时没有别的身份占着它：这条变化的语义就是「已删除」，不重复报外部消失。
          // 已经打开的新对象（latestObjects 是另一个版本）再消失时必须照常通知，不能拿旧记录吞掉。
          if (!present) {
            const recordVersion = trashed.get(note)
            const latest = this.latestObjects.get(note)
            if (recordVersion && (!latest || latest === recordVersion)) continue
          }
        }
        void this.emitNoteChange(note)
      }
    }, 80)
  }

  private hasUsableRoot(): boolean {
    try { return !!this.root && vaultRootIdentity(this.root) === this.rootIdentity } catch { return false }
  }

  requireUsableRoot(): string {
    this.assertCall()
    if (!this.root) throw new Error('NO_VAULT')
    if (!this.hasUsableRoot()) {
      this.suspendRoot()
      throw new Error('NOTE_UNREADABLE')
    }
    return this.root
  }

  private suspendRoot(): void {
    // Retain drafts and their verified basis, but never keep a watcher pointing
    // to a closed or moved handle. One notification also prevents re-entrancy.
    const notify = !this.rootUnavailable
    this.rootUnavailable = true
    this.stopWatch?.(); this.stopWatch = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.changedNotes.clear(); this.copyPreviews.clear();this.ledgerRecoveryPreviews.clear()
    if (this.root) closeSecureFs(this.root)
    this.index.reset()
    if (notify) this.emit('vault:lost')
  }

  private async emitNoteChange(relPath: string): Promise<void> {
    if (!this.root) return
    const token = this.token
    const root = this.root
    // 先取回声记录，再读盘。读盘有一次 await，顺序反了就会拿「新落盘的记录」
    // 去比「读到的旧内容」，把自家存盘误报成外部改动，让画布把稿回退一版。
    const recent = this.lastWrites.get(relPath)
    const previous = this.latestObjects.get(relPath)
    try {
      this.requireUsableRoot()
      const snapshot = { ...await readNoteSnapshot(root, relPath), sessionId: token! }
      if (this.token !== token) return
      this.requireUsableRoot()
      if (!this.remember(relPath, snapshot)) return
      if (previous && !this.acceptsObject(relPath, previous, snapshot.objectVersion)) {
        this.emit('note:external-change', { relPath, sessionId: token!, state: 'replaced', objectVersion: previous })
        return
      }
      if (recent?.objectVersion === snapshot.objectVersion && isOwnEcho(recent, snapshot.revision, Date.now())) return
      const payload: NotePayload = { relPath, ...snapshot }
      this.emit('note:external-change', payload)
    } catch (error) {
      if (this.token !== token) return
      this.emit('note:external-change', { relPath, sessionId: token!, objectVersion: previous,
        state: error instanceof Error && error.message === 'ENOENT' ? 'missing' : 'unavailable' })
    }
  }

  private readStateFile(): string | null {
    try {
      return readFileSync(this.stateFile(), 'utf8')
    } catch {
      return null
    }
  }
}

function markTiers(entries: TreeEntry[], rules: readonly PermissionEntry[]): void {
  for (const entry of entries) {
    const tier = tierFor(entry.relPath, rules)
    if (tier !== 'reference') entry.tier = tier
    if (entry.children) markTiers(entry.children, rules)
  }
}

/** 外部消失未核验的对象在树上如实标记；文件不在时它本就不在列表里。 */
function markRecovery(entries: TreeEntry[], missing: readonly { relPath: string }[]): void {
  for (const entry of entries) {
    if (missing.some((item) => item.relPath === entry.relPath)) entry.recovery = true
    if (entry.children) markRecovery(entry.children, missing)
  }
}

/** 目标笔记是否有直接／上级目录的显式权限规则（不是默认档）。 */
function hasExplicitPermissionRule(relPath: string, entries: readonly PermissionEntry[]): boolean {
  return entries.some((entry) => entry.relPath === relPath ||
    (!entry.relPath.toLowerCase().endsWith('.md') && relPath.startsWith(`${entry.relPath}/`)))
}

function isUsableDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function noteReadError(error: unknown): Error {
  const code = error instanceof Error ? error.message : ''
  if (code === 'OBJECT_BINDING_LIMIT') return new Error(code)
  if (code === 'ENOENT' || code === 'NOTE_MISSING') return new Error('NOTE_MISSING')
  if (code === 'PATH_CHANGED' || code === 'NOTE_REPLACED') return new Error('NOTE_REPLACED')
  return new Error('NOTE_UNREADABLE')
}

/** 把内部错误收成结果码：库内已删除的接口用共享的结果联合回报，不把异常抛给 IPC。 */
function codeOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'TRASH_FAILED'
}

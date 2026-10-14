import { WorkingMemoryService } from './working-memory-service.ts'
import { bodyFingerprint } from './ledger-provenance.ts'
import { collectNotePaths } from '../shared/vault-rel.ts'
import {WorkingMemoryStore,applyMemoryRecovery,type MemoryRecoveryPatch,type WorkingBindingPatch,type WorkingSource,type WorkingSnapshot} from './working-memory-store.ts'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dialog, type BrowserWindow } from 'electron'
import type { BacklinkGroup, LifecycleRetryRequest, LifecycleStatus, NotePayload, NoteSnapshot, ObjectBinding, PermissionEntry, PermissionState, PermissionTier, RecoveryRow, RecoveryScanView, RecoveryVerdict, SearchHit, TreeEntry, VaultState, SaveCopyPreviewRequest, SaveCopyPreviewView, SaveCopyCommitRequest } from '../shared/ipc.ts'
import { createFolder, createNote, createNoteWithBody, listVaultTree, parseStoredVault, readNoteSnapshot, requireOrdinaryNotes as verifyOrdinaryNotes, revisionOf, serializeStoredVault, writeNote } from './notes-fs.ts'
import { VaultMutationQueue } from './vault-mutation-queue.ts'
import { VaultLifecycle, type MissingObject, type RelocationPreview, type RelocationRequest, type RelocationMove, type CommittedNoteWrite } from './vault-lifecycle.ts'
import { isOwnEcho, type RecentWrite } from './echo.ts'
import { hasHiddenSegment, isNotePath, resolveInVault, sanitizeNoteName } from './paths.ts'
import { effectivePermissionEntries, loadPermissions, loadPermissionSnapshot, modelTierFor, setPermission as savePermission, tierFor } from './permissions.ts'
import type { TaskGrant } from './task-authorization.ts'
import { closeSecureFs, secureFsFor } from './secure-fs.ts'
import { VaultIndex } from './vault-index.ts'
import { vaultRootIdentity, watchVault } from './watch.ts'
import { assertLedgerPreserved, composeSource, partitionSource } from '../markdown/partition.ts'
import { compile } from '../markdown/index.ts'
import { LedgerStore } from './ledger-store.ts'
import type { LedgerChapterWrite } from './host-source.ts'
import { retireMemoryFile,memoryRetirementTarget } from './memory-retirement.ts'
import type { MemoryContext } from '../shared/memory.ts'

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
    private afterMemoryRetirement:()=>void=()=>{}
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
    try { return this.lifecycle?.hasMissing(relPath) ?? false }
    catch { return this.hasUsableRoot() }
  }

  /** 外部消失登记一条生命周期记录。字段全部取自既有登记（身份、内容哈希、附件证据、
   *  消失时的权限档），写进同一本 `.rgent-lifecycle`，不新增存储格式。
   *  本轮没有程序删除，所以任何路径消失都是外部消失。 */
  private async recordExternalDisappearance(relPath: string): Promise<void> {
    try {
      const root = this.root, ledger = this.ledgerStore
      if (!root || !ledger || !isNotePath(relPath) || this.lifecycle?.hasMissing(relPath)) return
      try { secureFsFor(root).resolve(relPath); return }
      catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) return }
      let owners: ReturnType<LedgerStore['recoveryOwners']>['owners']
      // 只有已登记身份的对象才有可核验的记录；未登记笔记消失不造记录。
      try { owners = ledger.recoveryOwners().owners } catch { return }
      const owner = owners.find((item) => item.relPath === relPath)
      if (!owner) return
      const snapshot = await loadPermissionSnapshot(root)
      const effective = snapshot.state.status === 'ready' ? effectivePermissionEntries(root, snapshot.state.entries) : null
      // 权限名单读不了就按最严档记录：核验时不会冒充通过。
      const permissionTier: PermissionTier = effective ? tierFor(owner.relPath, effective) : 'forbidden'
      this.lifecycle?.recordMissing({
        relPath: owner.relPath, noteId: owner.noteId, objectVersion: owner.objectVersion,
        bodyRevision: owner.bodyRevision, attachments: owner.recoveryEvidence?.attachments ?? [],
        rootIdentity: this.rootIdentity ?? vaultRootIdentity(root), permissionTier, detectedAt: new Date().toISOString()
      })
    } catch { /* 登记失败不改变既有的失败关闭：读写仍按 NOTE_MISSING 处理。 */ }
  }

  /** 消失的对象在被核验恢复前占着自己的路径：同路径新建会顶替它的身份，一律拒绝。 */
  private refuseReservedPath(name: string, parent: string): void {
    const fileName = sanitizeNoteName(name)
    if (this.missingRecord(parent ? `${parent}/${fileName}` : fileName)) throw new Error('PATH_RESERVED')
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
      if (row.verdict !== 'restored') return { verdict: row.verdict, restored: false, message: row.message }
      this.assertSession(token)
      if (!this.lifecycle!.clearMissing(relPath)) throw new Error('STALE_PREVIEW')
      // 身份连续且登记一致：重新读取以恢复运行时绑定与来源可用。
      await this.read(relPath)
      this.assertSession(token)
      return { verdict: 'restored' as const, restored: true, message: '核验通过：内容、附件与权限档都与记录一致；该对象与相关来源恢复可用。' }
    })
  }

  private async recoveryRows(): Promise<RecoveryRow[]> {
    const root = this.requireUsableRoot(), ledger = this.ledgerStore
    if (!ledger) return []
    let owners: ReturnType<LedgerStore['recoveryOwners']>['owners'] | null = null
    try { owners = ledger.recoveryOwners().owners } catch { owners = null }
    // 程序不在场时（关闭期间、换库期间）消失的登记对象也要被看见，不能只靠运行时监视。
    if (owners) for (const owner of owners) {
      if (this.missingRecord(owner.relPath)) continue
      try { secureFsFor(root).resolve(owner.relPath); continue }
      catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) continue }
      await this.recordExternalDisappearance(owner.relPath)
    }
    const records = this.lifecycle?.missingObjects() ?? []
    const rows: RecoveryRow[] = []
    for (const record of records) rows.push(await this.recoveryRow(record, owners))
    return rows
  }

  /** 核验判据全部取自既有记录：内容哈希对 `owner.bodyRevision`、附件对既有证据、权限对三档名单。 */
  private async recoveryRow(record: MissingObject, owners: ReturnType<LedgerStore['recoveryOwners']>['owners'] | null): Promise<RecoveryRow> {
    const row = (verdict: RecoveryVerdict, message: string, canRestore = false): RecoveryRow => ({ relPath: record.relPath, verdict, message, canRestore })
    const root = this.requireUsableRoot(), fs = secureFsFor(root), ledger = this.ledgerStore!
    let current: string | null = null
    try { current = fs.resolve(record.relPath).at(-1)?.id ?? null }
    catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) current = null }
    if (current === null) return row('still-missing', '文件仍不在原路径。若已从系统废纸篓放回，请重扫本页。')
    if (current !== record.objectVersion) return row('object-replaced', '原路径现在放着另一个对象（同名替换篇）；同一库根内不继承身份，需要整库恢复才能重新关联。')
    const owner = owners?.find((item) => item.relPath === record.relPath) ?? null
    if (!owner || owner.objectVersion !== current) return row('ledger-unverified', '账本登记与当前对象不一致，不能宣告恢复。')
    if (!owner.recoveryEvidence) return row('ledger-unverified', '该登记缺少库根与附件历史证据，只保留历史；来源继续暂停。')
    let content: string
    try { content = fs.readSnapshot(record.relPath).bytes.toString('utf8') }
    catch { return row('ledger-unverified', '当前无法读取该对象。') }
    if (revisionOf(content) !== owner.bodyRevision) return row('content-changed', '内容与登记记录不一致；对象与来源对 AI 保持失效，且不自动遗忘记忆。')
    let attachments: MissingObject['attachments']
    try { attachments = ledger.attachmentEvidence(record.relPath) }
    catch { return row('ledger-unverified', '附件子树无法核验。') }
    const recorded = owner.recoveryEvidence.attachments
    if (JSON.stringify(attachments) !== JSON.stringify(recorded)) {
      const stem = record.relPath.slice(0, -3)
      const hadFolder = recorded.some((part) => part.relPath === stem && part.kind === 'dir')
      const hasFolder = attachments.some((part) => part.relPath === stem && part.kind === 'dir')
      if (hadFolder && !hasFolder) return row('attachments-missing', '同名附件夹没有一起放回；这是降级状态，不冒充核验通过。')
      return row('attachments-changed', '附件子树与登记证据不一致；对象与来源对 AI 保持失效。')
    }
    const snapshot = await loadPermissionSnapshot(root)
    if (snapshot.state.status !== 'ready') return row('permission-denied', '权限名单无法核验，暂不恢复。')
    const tier = tierFor(record.relPath, effectivePermissionEntries(root, snapshot.state.entries))
    if (tier === 'forbidden') return row('permission-denied', '当前权限档禁止 AI 使用该笔记。')
    const labels: Record<PermissionTier, string> = { reference: '参考', follow: '跟随', forbidden: '禁止' }
    if (tier !== record.permissionTier) return row('permission-changed', `权限档在对象不在时从「${labels[record.permissionTier]}」变成「${labels[tier]}」，按原档恢复的判据不成立。`)
    const ownership = ledger.inspectOwner(record.relPath)
    if (!ownership || ownership.status !== 'verified') return row('ledger-unverified', '账本归属无法核验，不能宣告恢复。')
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

  private remember(relPath: string, snapshot: NoteSnapshot): void {
    this.requireSnapshotCapacity(relPath, snapshot.objectVersion, snapshot.content)
    const versions = this.verified.get(relPath) ?? new Map<string, NoteSnapshot>()
    versions.set(snapshot.objectVersion, { ...snapshot })
    this.verified.set(relPath, versions)
    this.latestObjects.set(relPath, snapshot.objectVersion)
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

  async create(name: string, parent = ''): Promise<string> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const relPath = await this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      this.refuseReservedPath(name, parent)
      return createNote(root, name, parent)
    })
    this.assertSession(token); this.requireUsableRoot()
    this.index.markDirty()
    return relPath
  }

  /** 「建」的原子落地：正文与文件一次出现（库层排他创建），写失败不留空笔记。
   *  走与 `create` 同一条写入队列与索引失效，不新增删除路径来回收半成品。 */
  async createWithContent(name: string, parent: string, content: string): Promise<{ relPath: string; revision: string; objectVersion: string }> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const result = await this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      // 与人的写入同一条边界：正文里不许藏着机器账本分区，新笔记不能带着「假历史」出生。
      if (partitionSource(content).ledger !== null) throw new Error('LEDGER_BOUNDARY_INVALID')
      this.refuseReservedPath(name, parent)
      const created = await createNoteWithBody(root, name, parent, content)
      this.assertSession(token); this.requireUsableRoot()
      return created
    })
    this.assertSession(token); this.requireUsableRoot()
    this.remember(result.relPath, { content, revision: result.revision, objectVersion: result.objectVersion, sessionId: token })
    this.lastWrites.set(result.relPath, { revision: result.revision, objectVersion: result.objectVersion, at: Date.now() })
    this.index.markDirty()
    return result
  }

  async createFolder(name: string, parent = ''): Promise<string> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const relPath = await this.mutations.run(async () => {
      this.assertSession(token); this.requireUsableRoot()
      return createFolder(root, name, parent)
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
    this.copyPreviews.clear();this.ledgerRecoveryPreviews.clear()
    if (this.root) closeSecureFs(this.root)
    this.root = null
    this.rootIdentity = null
    this.rootUnavailable = false
    this.lifecycle = null
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
    this.copyPreviews.clear();this.ledgerRecoveryPreviews.clear()
    if (this.root) closeSecureFs(this.root)
    this.root = path.resolve(root)
    this.rootIdentity = vaultRootIdentity(this.root)
    this.rootUnavailable = false
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
      if (this.root) for (const note of notes) void this.emitNoteChange(note)
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
      this.remember(relPath, snapshot)
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

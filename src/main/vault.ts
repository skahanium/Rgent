import {WorkingMemoryStore,type WorkingSnapshot} from './working-memory-store.ts'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dialog, type BrowserWindow } from 'electron'
import type { BacklinkGroup, LifecycleRetryRequest, LifecycleStatus, NotePayload, NoteSnapshot, ObjectBinding, PermissionEntry, PermissionState, PermissionTier, SearchHit, TreeEntry, VaultState, SaveCopyPreviewRequest, SaveCopyPreviewView, SaveCopyCommitRequest } from '../shared/ipc.ts'
import { createFolder, createNote, listVaultTree, parseStoredVault, readNoteSnapshot, requireOrdinaryNotes as verifyOrdinaryNotes, revisionOf, serializeStoredVault, writeNote } from './notes-fs.ts'
import { VaultMutationQueue } from './vault-mutation-queue.ts'
import { VaultLifecycle, type RelocationPreview, type RelocationRequest, type RelocationMove, type CommittedNoteWrite } from './vault-lifecycle.ts'
import { isOwnEcho, type RecentWrite } from './echo.ts'
import { hasHiddenSegment, isNotePath, resolveInVault } from './paths.ts'
import { effectivePermissionEntries, loadPermissions, loadPermissionSnapshot, setPermission as savePermission, tierFor } from './permissions.ts'
import { closeSecureFs, secureFsFor } from './secure-fs.ts'
import { VaultIndex } from './vault-index.ts'
import { vaultRootIdentity, watchVault } from './watch.ts'
import { assertLedgerPreserved, composeSource, partitionSource } from '../markdown/partition.ts'
import { LedgerStore } from './ledger-store.ts'
import type { LedgerChapterWrite } from './host-source.ts'
import { retireMemoryFile } from './memory-retirement.ts'
import type { MemoryContext } from '../shared/memory.ts'

export class VaultSession {
  private readonly calls = new AsyncLocalStorage<{sessionId:string|null}>()
  private readonly mutations = new VaultMutationQueue()
  private workingMemory:WorkingMemoryStore|null=null
  private ledgerStore: LedgerStore | null = null
  private ledgerFailure: string | null = null
  private memoryFailure: string | null = null
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
    private beforeChange: (previousRoot: string) => Promise<void> = async () => {}
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
    return createHash('sha256').update(canonical).digest('hex')
  }

  /** Main-process identity; includes the actual root object, unlike navigation preferences. */
  memoryContext(): MemoryContext {
    const root = this.requireUsableRoot(); const canonical = realpathSync.native(root)
    if (vaultRootIdentity(canonical) !== this.rootIdentity) throw new Error('NOTE_UNREADABLE')
    return { sessionId: this.captureSession(), vaultKey: createHash('sha256').update(JSON.stringify([canonical, this.rootIdentity])).digest('hex') }
  }

  memoryDiagnosis(): string | null { this.assertCall(); return this.memoryFailure }

  async tree(): Promise<TreeEntry[]> {
    const token = this.captureSession(); const root = this.requireUsableRoot()
    const entries = await listVaultTree(root)
    this.assertSession(token); this.requireUsableRoot()
    const policy = await loadPermissions(root)
    this.assertSession(token); this.requireUsableRoot()
    if (policy.status === 'ready') markTiers(entries, effectivePermissionEntries(root, policy.entries))
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
  async prepareTaskSource(request:ObjectBinding&{relPath:string;expectedRevision:string}){
    await this.lifecycleReady;return this.mutations.run(async()=>{
      this.assertSession(request.sessionId);this.requireStableStructure()
      const before=await this.read(request.relPath)
      if(!this.acceptsObject(request.relPath,request.objectVersion,before.objectVersion))throw Error('NOTE_REPLACED')
      if(before.revision!==request.expectedRevision)throw Error('CONFLICT')
      const migrated=this.ledgerStore!.migrate(request.relPath)
      if(migrated.migrated)await this.recordCommittedWrite({relPath:request.relPath,previousPath:request.relPath,previousObjectVersion:before.objectVersion,objectVersion:migrated.objectVersion,content:migrated.body})
      this.assertSession(request.sessionId);return {previousRevision:before.revision,revision:migrated.revision}
    })
  }
  private scheduleLedgerCompression(relPath:string,token:string){
    setImmediate(()=>{void this.mutations.run(()=>{
      this.assertSession(token);this.requireStableStructure()
      const items=this.ledgerStore!.maintenancePreview(relPath,'compress').records
      if(items.length){const result=this.ledgerStore!.maintain(relPath,'compress',items);if(result.failed.length)this.ledgerFailure='LEDGER_CONFLICT';else if(this.ledgerFailure==='LEDGER_CONFLICT')this.ledgerFailure=null}
    }).catch(()=>{if(this.token===token)this.ledgerFailure='LEDGER_CONFLICT'})})
  }
  async ledgerPrepare(relPath:string,chapter:LedgerChapterWrite,expectedVersion?:number){
    const token=this.captureSession();return this.mutations.run(async()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.prepare(relPath,chapter,expectedVersion)})
  }
  async ledgerComplete(relPath:string,taskId:string,revision:string){const token=this.captureSession();const result=await this.mutations.run(async()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.complete(relPath,taskId,revision)});this.scheduleLedgerCompression(relPath,token);return result}
  async ledgerKey(relPath:string){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(()=>{this.assertSession(token);return this.memoryContext().vaultKey+':'+this.ledgerStore!.owner(relPath).noteId})}
  async ledgerContexts(relPath:string){const token=this.captureSession();await this.lifecycleReady;this.assertSession(token);return this.ledgerStore!.contexts(relPath)}
  async ledgerPage(relPath:string,cursor:string|null){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(async()=>{this.assertSession(token);return {...this.ledgerStore!.wirePage(relPath,cursor),...(this.ledgerFailure?{maintenanceError:this.ledgerFailure}:{})}})}

  async materialUnit(relPath:string,start:number,end:number){const token=this.captureSession();return this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.materialUnit(relPath,start,end)})}
  materialCeiling(){const state=this.materialState();if(state.status==='invalid')throw Error(state.reason);return state.sequence}
  materialState(){this.requireUsableRoot();const state=this.ledgerStore!.materialState();if(state.status==='invalid')return state;try{const record=this.workingMemory!.read().record;if(state.sequence<record.nextSequence||state.sequence<record.watermark)return {status:'invalid' as const,reason:'LEDGER_REGISTRY_INVALID'}}catch{/* Invalid memory remains diagnosable and explicitly resettable only against a verified material ceiling. */}return state}
  ledgerTaskPath(taskId:string){this.requireUsableRoot();return this.ledgerStore!.taskPath(taskId)}
  memoryDiagnostic(){this.requireUsableRoot();return this.workingMemory!.diagnosis()}
  memorySnapshot(){this.assertCall();return this.workingMemory!.read()}
  /** Explicit diagnostic reset stays reachable during a pending structure recovery; it never clears that journal. */
  async memoryReset(expected:{revision:string|null;objectVersion:string|null},watermark:number){const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(()=>{this.assertSession(token);this.requireUsableRoot();return this.workingMemory!.reset(expected,watermark)})}
  async memoryMutation<T>(operation:(store:WorkingMemoryStore)=>T|Promise<T>):Promise<T>{const token=this.captureSession();await this.lifecycleReady;return this.mutations.run(async()=>{this.assertSession(token);this.requireStableStructure();const result=await operation(this.workingMemory!);this.assertSession(token);return result})}
  async ledgerRecord(relPath:string,taskId:string){const token=this.captureSession();await this.lifecycleReady;this.assertSession(token);return this.ledgerStore!.getRecord(relPath,taskId)}
  async ledgerMaintenancePreview(relPath:string,action:'compress'|'clear'){const token=this.captureSession();return this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.maintenancePreview(relPath,action)})}
  async ledgerMaintenanceCommit(relPath:string,action:'compress'|'clear',items:readonly {taskId:string;revision:number}[],archive?:{revision:string;bytes:number}){const token=this.captureSession();return this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();return this.ledgerStore!.maintain(relPath,action,items,archive)})}
  ledgerRegistryRevision(){this.assertCall();return this.ledgerStore?.registryRevision()??null}
  async ledgerRepair(expected:string|null){const token=this.captureSession();return this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();this.ledgerStore!.repairRegistry(expected)})}
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
    for(const path of batch){this.assertSession(token);try{await this.mutations.run(()=>{this.assertSession(token);this.requireStableStructure();this.ledgerStore!.migrate(path)});processed.push(path)}catch{failures.push({relPath:path,error:'LEDGER_MIGRATION_FAILED'})}}
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
      throw noteReadError(error)
    }
  }

  acceptsObject(relPath: string, expected: string, current: string): boolean {
    this.assertCall()
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
    try {
      const snapshot = await this.read(relPath)
      if (!this.acceptsObject(relPath, binding.objectVersion, snapshot.objectVersion)) return { ...base, status: 'replaced' }
      return { status: 'ready', snapshot }
    } catch (error) {
      this.assertSession(binding.sessionId)
      return { ...base, status: error instanceof Error && error.message === 'NOTE_MISSING' ? 'missing' : 'unreadable' }
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
        if (error instanceof Error && ['CONFLICT', 'NOTE_REPLACED', 'LEDGER_BOUNDARY_INVALID'].includes(error.message)) throw error
        throw noteReadError(error)
      }
    })
  }

  private async recordCommittedWrite(write: CommittedNoteWrite): Promise<void> {
    const { relPath, previousPath, previousObjectVersion, objectVersion, content } = write
    if (previousPath !== relPath) this.moveObjectBinding(previousPath, relPath, previousObjectVersion)
    const links = this.successors.get(relPath) ?? new Map<string, string>()
    if (!links.has(previousObjectVersion) && links.size >= 8192) throw new Error('OBJECT_BINDING_LIMIT')
    this.requireSnapshotCapacity(relPath, objectVersion, content, previousObjectVersion)
    for (const [previous, next] of links) if (next === previousObjectVersion) links.set(previous, objectVersion)
    links.set(previousObjectVersion, objectVersion)
    this.successors.set(relPath, links)
    const revision = revisionOf(content)
    this.verified.get(relPath)?.delete(previousObjectVersion)
    this.remember(relPath, { content, revision, objectVersion, sessionId: this.captureSession() })
    this.lastWrites.set(relPath, { revision, objectVersion, at: Date.now() })
    this.index.markDirty()
    try { this.ledgerStore?.onWrite(relPath,previousObjectVersion,objectVersion,content) } catch { this.ledgerFailure='LEDGER_OWNERSHIP_UNVERIFIED' }
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
      this.requireStableStructure()
      this.checkCopyPaths(request.source, request.target)
      if (partitionSource(request.body).ledger !== null) throw new Error('BAD_BODY')
      const basis = this.latestFor(request.source, request.objectVersion)
      if (!basis) throw new Error('LEDGER_BASIS_UNAVAILABLE')
      if ((await this.noteStatus(request.source, request)).status === 'ready') throw new Error('SOURCE_AVAILABLE')
      this.assertSession(request.sessionId)
      const parentIdentity = this.copyTargetIdentity(request.target)
      const content = request.body
      const view: SaveCopyPreviewView = { id: randomUUID(), sessionId: request.sessionId, source: request.source,
        target: request.target, draftVersion: request.draftVersion, pendingTaskIds: chapters.map((chapter) => chapter.taskId),
        warning: '另存创建新笔记归属，保留窗口正文及本预览列出的旧账本恢复材料和待保存任务记录；原账本不移动，不复制附件、不重启任务。' }
      this.copyPreviews.clear()
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

  async commitSaveCopy(request: SaveCopyCommitRequest, chapters: readonly LedgerChapterWrite[] = []): Promise<{ relPath: string; snapshot: NoteSnapshot; taskIds: string[] }> {
    this.assertSession(request.sessionId)
    await this.lifecycleReady
    this.assertSession(request.sessionId)
    return this.mutations.run(async () => {
      this.assertSession(request.sessionId)
      this.requireStableStructure()
      const prepared = this.copyPreviews.get(request.id)
      if (!prepared || prepared.view.sessionId !== request.sessionId || prepared.view.draftVersion !== request.draftVersion ||
          revisionOf(request.body) !== prepared.bodyHash || revisionOf(JSON.stringify(chapters)) !== prepared.pendingHash) {
        throw new Error('STALE_PREVIEW')
      }
      const basis = this.latestFor(prepared.request.source, prepared.request.objectVersion)
      if (!basis || revisionOf(basis.content) !== prepared.basisHash) throw new Error('STALE_PREVIEW')
      if ((await this.noteStatus(prepared.request.source, prepared.request)).status === 'ready') throw new Error('SOURCE_AVAILABLE')
      this.assertSession(request.sessionId)
      this.requireStableStructure()
      if (this.copyTargetIdentity(prepared.view.target) !== prepared.parentIdentity) throw new Error('STALE_PREVIEW')
      const root = this.root!
      this.requireSnapshotCapacity(prepared.view.target, 'pending-copy', prepared.content)
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
      this.assertSession(request.sessionId)
      this.verifyCopyParent(prepared.view.target, prepared.parentIdentity)
      if (written.objectVersion !== objectVersion || written.content !== prepared.content) throw new Error('COPY_VERIFY_FAILED')
      const snapshot = { ...written, sessionId: request.sessionId }
      this.ledgerStore!.recoveryCopy(prepared.request.source, prepared.view.target, prepared.request.objectVersion, partitionSource(basis.content).ledger, chapters)
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
      return createNote(root, name, parent)
    })
    this.assertSession(token); this.requireUsableRoot()
    this.index.markDirty()
    return relPath
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
    this.verified.clear()
    this.successors.clear()
    this.latestObjects.clear()
    this.copyPreviews.clear()
    if (this.root) closeSecureFs(this.root)
    this.root = null
    this.rootIdentity = null
    this.rootUnavailable = false
    this.lifecycle = null
    this.memoryFailure = null
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
    this.copyPreviews.clear()
    if (this.root) closeSecureFs(this.root)
    this.root = path.resolve(root)
    this.rootIdentity = vaultRootIdentity(this.root)
    this.rootUnavailable = false
    this.memoryFailure = null
    this.initializationFailure = null
    const token = randomUUID()
    this.token = token
    const check = (): void => { this.assertSession(token); this.requireUsableRoot() }
    this.workingMemory=new WorkingMemoryStore(()=>secureFsFor(this.requireUsableRoot()),check)
    this.ledgerStore=new LedgerStore(()=>secureFsFor(this.requireUsableRoot()),check)
    this.ledgerFailure=null
    this.lifecycle = new VaultLifecycle(this.root, this.mutations, token, check, async write => {
      check(); await this.recordCommittedWrite(write)
    }, async receipt=>{check();for(const move of receipt.objects){if(!move.identityProven)continue;this.ledgerStore!.relocate(move.from,move.to,move.objectVersion);try{const basis=this.workingMemory!.read();this.workingMemory!.relocate(basis,move.from,move.to,move.objectVersion)}catch(e){try{secureFsFor(this.root!).readSnapshot('.rgent-memory')}catch(m){if(m instanceof Error&&m.message==='ENOENT')continue}throw e}}})
    this.lifecycleError = null
    this.lifecycleReady = this.lifecycle.recover().then((result) => {
      if (this.token !== token) return
      if (result) this.emitRelocation(result)
      try { check(); retireMemoryFile(this.root!, check) } catch { this.memoryFailure = 'MEMORY_RETIREMENT_FAILED' }
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
    this.changedNotes.clear(); this.copyPreviews.clear()
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

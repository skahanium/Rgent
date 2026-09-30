import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog, type BrowserWindow } from 'electron'
import type { BacklinkGroup, LifecycleRetryRequest, LifecycleStatus, NotePayload, NoteSnapshot, ObjectBinding, PermissionEntry, PermissionState, PermissionTier, SearchHit, TreeEntry, VaultState, SaveCopyPreviewRequest, SaveCopyPreviewView, SaveCopyCommitRequest } from '../shared/ipc.ts'
import { createFolder, createNote, listVaultTree, parseStoredVault, readNoteSnapshot, revisionOf, serializeStoredVault, writeNote } from './notes-fs.ts'
import { VaultMutationQueue } from './vault-mutation-queue.ts'
import { VaultLifecycle, type RelocationPreview, type RelocationRequest, type RelocationMove, type CommittedNoteWrite } from './vault-lifecycle.ts'
import { isOwnEcho, type RecentWrite } from './echo.ts'
import { hasHiddenSegment, isNotePath, resolveInVault } from './paths.ts'
import { effectivePermissionEntries, loadPermissions, setPermission as savePermission, tierFor } from './permissions.ts'
import { closeSecureFs, secureFsFor } from './secure-fs.ts'
import { VaultIndex } from './vault-index.ts'
import { watchVault } from './watch.ts'
import { composeSource, partitionSource } from '../markdown/partition.ts'
import { appendLedgerChapter, type LedgerChapterWrite } from './host-source.ts'

export class VaultSession {
  private readonly mutations = new VaultMutationQueue()
  private lifecycle: VaultLifecycle | null = null
  private lifecycleReady: Promise<void> = Promise.resolve()
  private lifecycleError: Error | null = null
  private token: string | null = null
  root: string | null = null
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
    () => this.root,
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

  restore(): VaultState {
    const stored = parseStoredVault(this.readStateFile())
    if (!stored) return { status: 'needs-pick', reason: 'first-run' }
    if (!isUsableDir(stored.path)) return { status: 'needs-pick', reason: 'missing' }
    this.attach(stored.path)
    return { status: 'ready', rootName: path.basename(stored.path), sessionId: this.captureSession() }
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
      vaultChanged: previous !== chosen
    }
  }

  currentState(): VaultState {
    if (this.root && isUsableDir(this.root)) {
      return { status: 'ready', rootName: path.basename(this.root), sessionId: this.captureSession() }
    }
    const stored = parseStoredVault(this.readStateFile())
    if (!stored) return { status: 'needs-pick', reason: 'first-run' }
    return { status: 'needs-pick', reason: 'missing' }
  }

  async tree(): Promise<TreeEntry[]> {
    if (!this.root) throw new Error('NO_VAULT')
    const entries = await listVaultTree(this.root)
    const policy = await loadPermissions(this.root)
    if (policy.status === 'ready') markTiers(entries, effectivePermissionEntries(this.root, policy.entries))
    return entries
  }

  async permissions(): Promise<PermissionState> {
    if (!this.root) throw new Error('NO_VAULT')
    return loadPermissions(this.root)
  }

  async setPermission(relPath: string, tier: PermissionTier): Promise<PermissionState> {
    if (!this.root) throw new Error('NO_VAULT')
    const root = this.root
    const state = await this.mutations.run(async () => {
      if (this.root !== root) throw new Error('VAULT_CHANGED')
      return savePermission(root, relPath, tier)
    })
    this.emit('tree:changed')
    return state
  }

  async read(relPath: string): Promise<NoteSnapshot> {
    const token = this.captureSession()
    const root = this.root!
    try {
      const snapshot = { ...await readNoteSnapshot(root, relPath), sessionId: token }
      this.assertSession(token)
      this.remember(relPath, snapshot)
      return snapshot
    } catch (error) {
      this.assertSession(token)
      throw noteReadError(error)
    }
  }

  acceptsObject(relPath: string, expected: string, current: string): boolean {
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
        const current = await readNoteSnapshot(root, relPath)
        this.assertSession(token)
        if (binding && !this.acceptsObject(relPath, binding.objectVersion, current.objectVersion)) throw new Error('NOTE_REPLACED')
        const links = this.successors.get(relPath) ?? new Map<string, string>()
        if (!links.has(current.objectVersion) && links.size >= 8192) throw new Error('OBJECT_BINDING_LIMIT')
        this.requireSnapshotCapacity(relPath, 'pending-save', content, current.objectVersion)
        const saved = await writeNote(root, relPath, content, expectedRevision, current.objectVersion)
        this.assertSession(token)
        this.recordCommittedWrite({ relPath, previousPath: relPath, previousObjectVersion: current.objectVersion, objectVersion: saved.objectVersion, content })
        return binding ? { ...saved, sessionId: token } : saved.revision
      } catch (error) {
        this.assertSession(token)
        if (error instanceof Error && ['CONFLICT', 'NOTE_REPLACED'].includes(error.message)) throw error
        throw noteReadError(error)
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
    const revision = revisionOf(content)
    this.verified.get(relPath)?.delete(previousObjectVersion)
    this.remember(relPath, { content, revision, objectVersion, sessionId: this.captureSession() })
    this.lastWrites.set(relPath, { revision, objectVersion, at: Date.now() })
    this.index.markDirty()
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
      let content = composeSource(request.body, partitionSource(basis.content).ledger)
      for (const chapter of chapters) content = appendLedgerChapter(content, chapter)
      const view: SaveCopyPreviewView = { id: randomUUID(), sessionId: request.sessionId, source: request.source,
        target: request.target, draftVersion: request.draftVersion, pendingTaskIds: chapters.map((chapter) => chapter.taskId),
        warning: '另存保留窗口正文、最后核验的原账本和待保存任务记录；不复制附件，原路径保持原状。' }
      this.copyPreviews.clear()
      this.copyPreviews.set(view.id, { view: { ...view, pendingTaskIds: [...view.pendingTaskIds] }, request: { ...request }, content,
        bodyHash: revisionOf(request.body), basisHash: revisionOf(basis.content), pendingHash: revisionOf(JSON.stringify(chapters)), parentIdentity })
      return view
    })
  }

  saveCopyRequestById(id: string): SaveCopyPreviewRequest | null {
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
      this.remember(prepared.view.target, snapshot)
      this.lastWrites.set(prepared.view.target, { revision: snapshot.revision, objectVersion, at: Date.now() })
      this.copyPreviews.delete(request.id)
      this.index.markDirty()
      this.emit('tree:changed')
      return { relPath: prepared.view.target, snapshot, taskIds: [...prepared.view.pendingTaskIds] }
    })
  }

  private requireStableStructure(): void {
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
    const fs = secureFsFor(this.root!)
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
    const fs = secureFsFor(this.root!)
    try { fs.resolve(target); throw new Error('EEXIST') }
    catch (error) { if (!(error instanceof Error && error.message === 'ENOENT')) throw error }
    return identity
  }

  async create(name: string, parent = ''): Promise<string> {
    if (!this.root) throw new Error('NO_VAULT')
    const root = this.root
    const relPath = await this.mutations.run(async () => {
      if (this.root !== root) throw new Error('VAULT_CHANGED')
      return createNote(root, name, parent)
    })
    this.index.markDirty()
    return relPath
  }

  async createFolder(name: string, parent = ''): Promise<string> {
    if (!this.root) throw new Error('NO_VAULT')
    const root = this.root
    const relPath = await this.mutations.run(async () => {
      if (this.root !== root) throw new Error('VAULT_CHANGED')
      return createFolder(root, name, parent)
    })
    this.index.markDirty()
    this.emit('tree:changed')
    return relPath
  }

  sessionId(): string | null { return this.token }

  captureSession(): string {
    if (!this.root || !this.token) throw new Error('NO_VAULT')
    return this.token
  }

  assertSession(token: string): void {
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

  relocationPreviewById(id: string): RelocationPreview | null { return this.lifecycle?.peek(id) ?? null }

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
    return this.index.backlinks(relPath)
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!this.root) return []
    return this.index.search(query)
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
    this.lifecycle = null
    this.token = null
    this.lifecycleError = null
    this.index.reset()
  }

  private attach(root: string): void {
    this.stopWatch?.()
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
    const token = randomUUID()
    this.token = token
    this.lifecycle = new VaultLifecycle(this.root, this.mutations, token, () => this.assertSession(token), (write) => {
      this.assertSession(token)
      this.recordCommittedWrite(write)
    })
    this.lifecycleError = null
    this.lifecycleReady = this.lifecycle.recover().then((result) => {
      if (this.token !== token) return
      if (result) this.emitRelocation(result)
    }).catch((error: unknown) => {
      if (this.token !== token) return
      this.lifecycleError = error instanceof Error ? error : new Error('LIFECYCLE_RECOVERY_REQUIRED')
    })
    // 换库必须清索引，否则新库会看到旧库的反链。
    this.index.reset()
    this.stopWatch = watchVault(this.root, (relPath) => { if (this.token === token) this.onFsEvent(relPath) })
  }

  private onFsEvent(relPath: string | null): void {
    if (this.root && !isUsableDir(this.root)) {
      this.dispose()
      this.emit('vault:lost')
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

  private async emitNoteChange(relPath: string): Promise<void> {
    if (!this.root) return
    const token = this.token
    const root = this.root
    // 先取回声记录，再读盘。读盘有一次 await，顺序反了就会拿「新落盘的记录」
    // 去比「读到的旧内容」，把自家存盘误报成外部改动，让画布把稿回退一版。
    const recent = this.lastWrites.get(relPath)
    const previous = this.latestObjects.get(relPath)
    try {
      const snapshot = { ...await readNoteSnapshot(root, relPath), sessionId: token! }
      if (this.token !== token) return
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

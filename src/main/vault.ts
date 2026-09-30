import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog, type BrowserWindow } from 'electron'
import type { BacklinkGroup, LifecycleRetryRequest, LifecycleStatus, NotePayload, NoteSnapshot, PermissionEntry, PermissionState, PermissionTier, SearchHit, TreeEntry, VaultState } from '../shared/ipc.ts'
import { createFolder, createNote, listVaultTree, parseStoredVault, readNoteSnapshot, serializeStoredVault, writeNote } from './notes-fs.ts'
import { VaultMutationQueue } from './vault-mutation-queue.ts'
import { VaultLifecycle, type RelocationPreview, type RelocationRequest, type RelocationMove } from './vault-lifecycle.ts'
import { isOwnEcho, type RecentWrite } from './echo.ts'
import { isNotePath } from './paths.ts'
import { effectivePermissionEntries, loadPermissions, setPermission as savePermission, tierFor } from './permissions.ts'
import { closeSecureFs } from './secure-fs.ts'
import { VaultIndex } from './vault-index.ts'
import { watchVault } from './watch.ts'

export class VaultSession {
  private readonly mutations = new VaultMutationQueue()
  private lifecycle: VaultLifecycle | null = null
  private lifecycleReady: Promise<void> = Promise.resolve()
  private lifecycleError: Error | null = null
  private token: string | null = null
  root: string | null = null
  private stopWatch: (() => void) | null = null
  private lastWrites = new Map<string, RecentWrite>()
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
    if (previous && previous !== chosen) await this.beforeChange(previous)
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
    if (!this.root) throw new Error('NO_VAULT')
    return readNoteSnapshot(this.root, relPath)
  }

  async write(relPath: string, content: string, expectedRevision: string): Promise<string> {
    if (!this.root) throw new Error('NO_VAULT')
    const root = this.root
    const revision = await this.mutations.run(async () => {
      if (this.root !== root) throw new Error('VAULT_CHANGED')
      return writeNote(root, relPath, content, expectedRevision)
    })
    this.lastWrites.set(relPath, { revision, at: Date.now() })
    this.index.markDirty()
    return revision
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
    if (this.root) closeSecureFs(this.root)
    this.root = path.resolve(root)
    const token = randomUUID()
    this.token = token
    this.lifecycle = new VaultLifecycle(this.root, this.mutations, token, () => this.assertSession(token))
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
    try {
      const { content, revision } = await readNoteSnapshot(root, relPath)
      if (this.token !== token) return
      if (isOwnEcho(recent, revision, Date.now())) return
      const payload: NotePayload = { relPath, content, revision, sessionId: token! }
      this.emit('note:external-change', payload)
    } catch {
      /* deleted notes refresh via tree:changed */
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

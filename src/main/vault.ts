import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { BacklinkGroup, NotePayload, NoteSnapshot, PermissionEntry, PermissionState, PermissionTier, SearchHit, TreeEntry, VaultState } from '../shared/ipc.ts'
import { createNote, listVaultTree, parseStoredVault, readNoteSnapshot, serializeStoredVault, writeNote } from './notes-fs.ts'
import { isOwnEcho, type RecentWrite } from './echo.ts'
import { isNotePath } from './paths.ts'
import { effectivePermissionEntries, loadPermissions, setPermission as savePermission, tierFor } from './permissions.ts'
import { closeSecureFs } from './secure-fs.ts'
import { VaultIndex } from './vault-index.ts'
import { watchVault } from './watch.ts'

export class VaultSession {
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
    private emit: (channel: string, payload?: unknown) => void
  ) {}

  private stateFile(): string {
    return path.join(this.userData, 'vault.json')
  }

  restore(): VaultState {
    const stored = parseStoredVault(this.readStateFile())
    if (!stored) return { status: 'needs-pick', reason: 'first-run' }
    if (!isUsableDir(stored.path)) return { status: 'needs-pick', reason: 'missing' }
    this.attach(stored.path)
    return { status: 'ready', rootName: path.basename(stored.path) }
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
    writeFileSync(this.stateFile(), serializeStoredVault(chosen), 'utf8')
    this.attach(chosen)
    return {
      status: 'ready',
      rootName: path.basename(chosen),
      vaultChanged: previous !== chosen
    }
  }

  currentState(): VaultState {
    if (this.root && isUsableDir(this.root)) {
      return { status: 'ready', rootName: path.basename(this.root) }
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
    const state = await savePermission(this.root, relPath, tier)
    this.emit('tree:changed')
    return state
  }

  async read(relPath: string): Promise<NoteSnapshot> {
    if (!this.root) throw new Error('NO_VAULT')
    return readNoteSnapshot(this.root, relPath)
  }

  async write(relPath: string, content: string, expectedRevision: string): Promise<string> {
    if (!this.root) throw new Error('NO_VAULT')
    const revision = await writeNote(this.root, relPath, content, expectedRevision)
    this.lastWrites.set(relPath, { revision, at: Date.now() })
    this.index.markDirty()
    return revision
  }

  async create(name: string): Promise<string> {
    if (!this.root) throw new Error('NO_VAULT')
    const relPath = await createNote(this.root, name)
    this.index.markDirty()
    return relPath
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
    this.index.reset()
  }

  private attach(root: string): void {
    this.stopWatch?.()
    if (this.root) closeSecureFs(this.root)
    this.root = path.resolve(root)
    // 换库必须清索引，否则新库会看到旧库的反链。
    this.index.reset()
    this.stopWatch = watchVault(this.root, (relPath) => this.onFsEvent(relPath))
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
    this.debounce = setTimeout(() => {
      this.emit('tree:changed')
      const notes = this.changedNotes
      this.changedNotes = new Set()
      if (this.root) for (const note of notes) void this.emitNoteChange(note)
    }, 80)
  }

  private async emitNoteChange(relPath: string): Promise<void> {
    if (!this.root) return
    // 先取回声记录，再读盘。读盘有一次 await，顺序反了就会拿「新落盘的记录」
    // 去比「读到的旧内容」，把自家存盘误报成外部改动，让画布把稿回退一版。
    const recent = this.lastWrites.get(relPath)
    try {
      const { content, revision } = await readNoteSnapshot(this.root, relPath)
      if (isOwnEcho(recent, revision, Date.now())) return
      const payload: NotePayload = { relPath, content, revision }
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

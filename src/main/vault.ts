import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { NotePayload, TreeEntry, VaultState } from '../shared/ipc.ts'
import { createNote, listVaultTree, parseStoredVault, readNote, serializeStoredVault, writeNote } from './notes-fs.ts'
import { isNotePath } from './paths.ts'
import { watchVault } from './watch.ts'

export class VaultSession {
  root: string | null = null
  private stopWatch: (() => void) | null = null
  private lastWrites = new Map<string, { content: string; at: number }>()
  private debounce: NodeJS.Timeout | null = null

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
    const chosen = result.filePaths[0]
    if (!isUsableDir(chosen)) return { status: 'needs-pick', reason: 'missing' }
    writeFileSync(this.stateFile(), serializeStoredVault(chosen), 'utf8')
    this.attach(chosen)
    return { status: 'ready', rootName: path.basename(chosen) }
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
    return listVaultTree(this.root)
  }

  async read(relPath: string): Promise<string> {
    if (!this.root) throw new Error('NO_VAULT')
    return readNote(this.root, relPath)
  }

  async write(relPath: string, content: string): Promise<void> {
    if (!this.root) throw new Error('NO_VAULT')
    await writeNote(this.root, relPath, content)
    this.lastWrites.set(relPath, { content, at: Date.now() })
  }

  async create(name: string): Promise<string> {
    if (!this.root) throw new Error('NO_VAULT')
    return createNote(this.root, name)
  }

  dispose(): void {
    this.stopWatch?.()
    this.stopWatch = null
    this.root = null
  }

  private attach(root: string): void {
    this.stopWatch?.()
    this.root = root
    this.stopWatch = watchVault(root, (relPath) => this.onFsEvent(relPath))
  }

  private onFsEvent(relPath: string | null): void {
    if (this.root && !isUsableDir(this.root)) {
      this.dispose()
      this.emit('vault:lost')
      return
    }
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.emit('tree:changed')
      if (relPath && isNotePath(relPath) && this.root) {
        void this.emitNoteChange(relPath)
      } else if (this.root) {
        void this.emitOpenNotes()
      }
    }, 80)
  }

  private async emitNoteChange(relPath: string): Promise<void> {
    if (!this.root) return
    try {
      const content = await readNote(this.root, relPath)
      const recent = this.lastWrites.get(relPath)
      if (recent && recent.content === content && Date.now() - recent.at < 2000) return
      const payload: NotePayload = { relPath, content }
      this.emit('note:external-change', payload)
    } catch {
      /* deleted notes refresh via tree:changed */
    }
  }

  private async emitOpenNotes(): Promise<void> {
    /* renderer diffs by path; tree refresh is enough for create/delete */
  }

  private readStateFile(): string | null {
    try {
      return readFileSync(this.stateFile(), 'utf8')
    } catch {
      return null
    }
  }
}

function isUsableDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

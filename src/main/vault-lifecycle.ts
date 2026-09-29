import { createHash, randomUUID } from 'node:crypto'
import { collectNotePaths } from '../shared/vault-rel.ts'
import { compile } from '../markdown/index.ts'
import { listVaultTree, readNote, revisionOf } from './notes-fs.ts'
import { loadPermissions, tierFor } from './permissions.ts'
import { hasHiddenSegment, isNotePath, resolveInVault } from './paths.ts'
import { secureFsFor } from './secure-fs.ts'
import { VaultMutationQueue } from './vault-mutation-queue.ts'

const JOURNAL = '.rgent-lifecycle'
const PERMISSIONS = '.rgent-permissions'

export type RelocationRequest = { kind: 'note' | 'folder'; source: string; target: string }
export type RelocationMove = { from: string; to: string; id: string }
export type LinkChange = { relPath: string; newPath: string; expectedRevision: string; changes: { start: number; end: number; before: string; after: string }[] }
export type RelocationPreview = {
  id: string
  kind: 'note' | 'folder'
  source: string
  target: string
  moves: RelocationMove[]
  linkChanges: LinkChange[]
  permissionChanges: { from: string; to: string; tier: string }[]
}
type Fingerprint = { relPath: string; id: string; kind: string; hash?: string; repairedHash?: string }
type PendingMove = {
  kind: 'move'
  intent: Pick<RelocationPreview, 'kind' | 'source' | 'target' | 'moves'>
  linkRepairs: { relPath: string; newPath: string; expectedRevision: string }[]
  fingerprints: Fingerprint[]
  permissionBefore: string | null
  permissionAfter: string | null
  repairLinks: boolean
}
type Journal = { version: 1; active: PendingMove | null }

function validPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || hasHiddenSegment(relPath)) return false
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

/** Main-process only. Preview tokens bind a structural change to verified disk objects. */
export class VaultLifecycle {
  private readonly previews = new Map<string, { view: RelocationPreview; fingerprints: Fingerprint[]; permissionBefore: string | null; permissionAfter: string | null }>()

  constructor(private readonly root: string, private readonly queue = new VaultMutationQueue()) {}

  peek(id: string): RelocationPreview | null { return this.previews.get(id)?.view ?? null }

  async preview(input: RelocationRequest): Promise<RelocationPreview> {
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
    const policy = await loadPermissions(this.root)
    if (policy.status !== 'ready') throw new Error('PERMISSIONS_INVALID')
    const permissionBefore = this.readOptional(PERMISSIONS)
    const mappedEntries = policy.entries.map((entry) => ({ ...entry, relPath: mapped(entry.relPath, moves) }))
    if (new Set(mappedEntries.map((entry) => entry.relPath)).size !== mappedEntries.length) throw new Error('PERMISSION_COLLISION')
    for (const item of fingerprints) {
      const oldTier = tierFor(item.relPath, policy.entries)
      const newTier = tierFor(mapped(item.relPath, moves), mappedEntries)
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
    const view: RelocationPreview = {
      id: randomUUID(), kind: input.kind, source: input.source, target: input.target,
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
      let fresh: RelocationPreview
      try { fresh = await this.preview({ kind: prepared.view.kind, source: prepared.view.source, target: prepared.view.target }) }
      catch { throw new Error('STALE_PREVIEW') }
      const freshState = this.previews.get(fresh.id)!
      this.previews.delete(fresh.id)
      if (!sameFingerprints(prepared.fingerprints, freshState.fingerprints) ||
          this.readOptional(PERMISSIONS) !== prepared.permissionBefore ||
          JSON.stringify(fresh.linkChanges) !== JSON.stringify(prepared.view.linkChanges)) throw new Error('STALE_PREVIEW')
      const journal = this.loadJournal()
      if (journal.active) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      const fingerprints = prepared.fingerprints.map((item) => {
        const link = options.repairLinks ? prepared.view.linkChanges.find((change) => change.relPath === item.relPath) : undefined
        if (!link) return item
        const source = secureFsFor(this.root).readText(item.relPath)
        if (revisionOf(source) !== link.expectedRevision) throw new Error('STALE_PREVIEW')
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
      this.saveJournal({ version: 1, active })
      this.previews.delete(id)
      return this.recoverMove(active)
    })
  }

  /** Resume only an operation whose file identities still match the saved intent. */
  async recover(): Promise<{ moved: RelocationMove[]; unrepaired: string[] } | null> {
    return this.queue.run(async () => {
      const active = this.loadJournal().active
      return active ? this.recoverMove(active) : null
    })
  }

  private async recoverMove(active: PendingMove): Promise<{ moved: RelocationMove[]; unrepaired: string[] }> {
    const fs = secureFsFor(this.root)
    const matchesRecordedState = (item: Fingerprint, path: string): boolean => {
      const current = fs.resolve(path).at(-1)
      if (!current || current.kind !== item.kind) return false
      if (!item.hash) return current.id === item.id
      const currentHash = hash(fs.readBytes(path))
      if (current.id === item.id) return currentHash === item.hash || currentHash === item.repairedHash
      // Atomic link repair replaces the moved note's inode. Its exact new bytes
      // were sealed in the journal before the structural move began.
      return path === mapped(item.relPath, active.intent.moves) && currentHash === item.repairedHash
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
    }
    // A native rename can race an external replacement after its last path check.
    // Check once before touching policy, and again before clearing recovery state.
    const verifyMoved = (): void => {
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
        try {
          const source = fs.readText(relPath)
          if (revisionOf(source) !== item.expectedRevision) {
            if (!linkChangesInSource(source, active.intent.moves).length) continue
            unrepaired.push(relPath)
            continue
          }
          const next = applyChanges(source, linkChangesInSource(source, active.intent.moves))
          if (next !== source) fs.replace(relPath, source, next)
        } catch { unrepaired.push(relPath) }
      }
    }
    verifyMoved()
    this.saveJournal({ version: 1, active: null })
    return { moved: active.intent.moves, unrepaired }
  }

  private fingerprintTree(relPath: string): Fingerprint[] {
    const fs = secureFsFor(this.root)
    const components = fs.resolve(relPath)
    const leaf = components.at(-1)!
    const result: Fingerprint[] = [{ relPath, id: leaf.id, kind: leaf.kind,
      ...(leaf.kind === 'file' ? { hash: hash(fs.readBytes(relPath)) } : {}) }]
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
      const source = await readNote(this.root, relPath)
      const changes = linkChangesInSource(source, moves)
      if (changes.length) results.push({ relPath, newPath: mapped(relPath, moves), expectedRevision: revisionOf(source), changes })
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
    const raw = this.readOptional(JOURNAL)
    if (raw === null) return { version: 1, active: null }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || (parsed as Journal).version !== 1 ||
          !('active' in parsed) ||
          ((parsed as Journal).active !== null && !validPending((parsed as Journal).active))) throw new Error('BAD_JOURNAL')
      return parsed as Journal
    } catch { throw new Error('LIFECYCLE_RECOVERY_REQUIRED') }
  }

  private saveJournal(next: Journal): void {
    secureFsFor(this.root).replace(JOURNAL, this.readOptional(JOURNAL), `${JSON.stringify(next)}\n`)
  }
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
      validPath(part.relPath) && typeof part.id === 'string' &&
      (part.kind === 'dir' || part.kind === 'file') &&
      (part.kind === 'file' ? typeof part.hash === 'string' && /^[a-f0-9]{64}$/.test(part.hash) : part.hash === undefined) &&
      (part.repairedHash === undefined || (part.kind === 'file' && /^[a-f0-9]{64}$/.test(part.repairedHash))))) return false
  const fingerprints = item.fingerprints as Fingerprint[]
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
  return (item.permissionBefore === null || typeof item.permissionBefore === 'string') &&
    (item.permissionAfter === null || typeof item.permissionAfter === 'string') &&
    typeof item.repairLinks === 'boolean'
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
    const outputTarget = rawTarget.toLowerCase().endsWith('.md') ? newTarget : newTarget.replace(/\.md$/i, '')
    const after = `${before.slice(0, marker)}${outputTarget}${pipe < 0 ? '' : inner.slice(pipe)}]]`
    changes.push({ start: link.range.start, end: link.range.end, before, after })
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

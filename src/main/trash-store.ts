import { createHash, randomUUID } from 'node:crypto'
import type { TrashEntryView } from '../shared/ipc.ts'
import { hasHiddenSegment, isNotePath } from './paths.ts'
import { secureFsFor } from './secure-fs.ts'

/**
 * 库内「已删除」的存储。
 *
 * 目录形状：`<vault>/.rgent-trash/<uuid>/meta.json` ＋ `<uuid>/payload/`。
 * 载荷保持原名（`payload/笔记.md`、`payload/附件夹/…`），移动只用既有的
 * `SecureVaultFs.createDirectory`／`move`／`replace`／`trash`（不新增原生 API）。
 *
 * 这里只做「条目级」的磁盘事务：核对象身份与附件、移动、写 meta、还原、明确删除、
 * 对账与清理。生命周期 `trashed[]` 与账本留痕由调用方（VaultSession／VaultLifecycle）
 * 在同一个 mutation 队列里衔接，本模块不写 journal。
 *
 * 已删除目录是隐藏段：树、索引、权限名单、媒体协议与笔记读写都不可达
 * （`listVaultTree` 过滤隐藏名，笔记读写走 `mustResolve` 的隐藏段判据）。
 */

export const TRASH_DIR = '.rgent-trash'
/** 30 天保留；过期或超额时整条目目录送系统废纸篓。 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 全部条目累计字节上限；从最旧开始送系统废纸篓。 */
export const TRASH_BYTES_LIMIT = 1024 * 1024 * 1024
/** journal `trashed[]` 的有界上限；与 `VaultLifecycle` 的解析校验同一数值。 */
export const TRASH_RECORD_LIMIT = 256

/**
 * 删除／还原／明确删除只在原生实现齐备的平台上开放。
 * `createDirectory`／`move` 两平台都有，但收尾（还原后清条目、明确删除整条目）
 * 只有 macOS 的 `trashItemAtURL` 实现了；Windows 原生 `trash` 报 `PLATFORM_UNPROVEN`。
 * 只开删除不开还原会把库变成单向废纸篓，所以整条链路按同一平台边界关闭
 * （与既有「Windows 删除入口仍关」一致）。列表仍可读，便于诊断搬过来的库。
 */
export const TRASH_OPERATIONS_ON_THIS_PLATFORM = process.platform === 'darwin'

const META_FILE = 'meta.json'
const PAYLOAD_DIR = 'payload'
const META_BYTES_LIMIT = 8 * 1024
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const SHA256 = /^[a-f0-9]{64}$/

export type TrashSource = 'human' | 'ai'
export type TrashKind = 'note' | 'attachment'
export type TrashMetaState = 'moving' | 'trashed' | 'damaged'

/** 一条已删除条目的元数据。字段集合固定：多一个未知字段即视为坏条目，不当成新格式。 */
export type TrashMeta = {
  version: 1
  trashId: string
  originalRelPath: string
  objectVersion: string
  contentHash: string
  kind: TrashKind
  attachmentRelPath: string | null
  bytes: number
  deletedAt: string
  source: TrashSource
  taskId?: string
  state: TrashMetaState
}

/** journal `trashed[]` 的一条：与 meta 同源，但不含状态与字节。 */
export type TrashedRecord = {
  trashId: string
  relPath: string
  objectVersion: string
  contentHash: string
  at: string
}

export type TrashList = { entries: TrashEntryView[]; bytes: number }
export type TrashDeleteOutcome = { meta: TrashMeta; landing: string; attachmentLanding: string | null }
export type TrashPurgeOutcome = { ok: true; removed: boolean } | { ok: false; error: string }
export type TrashRestoreOutcome = { ok: true; relPath: string; copied: boolean } | { ok: false; error: string }
export type TrashSweepReport = { purged: string[]; failed: { id: string; error: string }[]; bytes: number }
export type TrashReconcileReport = {
  /** 需要写进 journal 的记录（新增或与磁盘不一致而修正）。 */
  upsert: TrashedRecord[]
  /** 需要从 journal 移除的记录（条目已不在，或半截移动已回滚）。 */
  remove: string[]
  /** `moving` 半截条目补完删除。 */
  completed: string[]
  /** `moving` 半截但对象其实还在原路径：条目清掉。 */
  rolledBack: string[]
  /** 还原已完成、只剩条目目录没清。 */
  restored: string[]
  damaged: string[]
  /** journal 有记录、目录已不在（保留记录，列表里标 damaged）。 */
  missingEntries: string[]
  issues: string[]
}

export type TrashStoreOptions = {
  /** 只为测试注入时钟；生产用系统时间。 */
  now?: () => Date
  retentionMs?: number
  bytesLimit?: number
}

type MovedObject = { from: string; to: string; id: string }

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function basename(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

function parentOf(relPath: string): string {
  return relPath.split('/').slice(0, -1).join('/')
}

function codeOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'TRASH_FAILED'
}

function validRelPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || hasHiddenSegment(relPath)) return false
  if (process.platform === 'win32' && relPath.includes(':')) return false
  return relPath.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** 大小写／Unicode 归一化意义上的同名（APFS／NTFS 上 `A.md` 的附件夹可能就是 `a`）。 */
function sameStem(left: string, right: string): boolean {
  const fold = (value: string): string => value.normalize('NFC').replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  return fold(left) === fold(right)
}

function sameRecord(left: TrashedRecord, right: TrashedRecord): boolean {
  return left.trashId === right.trashId && left.relPath === right.relPath &&
    left.objectVersion === right.objectVersion && left.contentHash === right.contentHash && left.at === right.at
}

/** 条目 id 只允许单段安全名（uuid）；IPC 传进来的 id 先过这一条，避免路径穿越。 */
export function isTrashId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** meta 的严格校验：未知字段、缺字段、越界值都算坏条目，不按「大概能用」读。 */
export function validTrashMeta(value: unknown): value is TrashMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const meta = value as TrashMeta
  const keys = ['attachmentRelPath', 'bytes', 'contentHash', 'deletedAt', 'kind', 'objectVersion',
    'originalRelPath', 'source', 'state', 'trashId', 'version', ...(meta.taskId === undefined ? [] : ['taskId'])]
  if (Object.keys(meta).sort().join() !== keys.sort().join()) return false
  if (meta.version !== 1 || typeof meta.trashId !== 'string' || !ID_PATTERN.test(meta.trashId)) return false
  if (!validRelPath(meta.originalRelPath)) return false
  if (meta.kind !== 'note' && meta.kind !== 'attachment') return false
  if (typeof meta.objectVersion !== 'string' || meta.objectVersion.length === 0 || meta.objectVersion.length >= 512) return false
  if (typeof meta.contentHash !== 'string' || !SHA256.test(meta.contentHash)) return false
  if (meta.attachmentRelPath !== null) {
    if (!validRelPath(meta.attachmentRelPath)) return false
    // 笔记条目只带「同名附件夹」；附件条目就把自身路径记在这里。
    // 大小写／归一化别名（`A.md` 配 `a/`）是同一个名字，按同名接受。
    const expected = meta.kind === 'note' ? meta.originalRelPath.slice(0, -3) : meta.originalRelPath
    if (meta.attachmentRelPath !== expected && !(meta.kind === 'note' && sameStem(meta.attachmentRelPath, expected))) return false
  }
  if (meta.kind === 'note' && !isNotePath(meta.originalRelPath)) return false
  if (meta.kind === 'attachment' && isNotePath(meta.originalRelPath)) return false
  if (!Number.isSafeInteger(meta.bytes) || meta.bytes < 0) return false
  if (typeof meta.deletedAt !== 'string' || !Number.isFinite(Date.parse(meta.deletedAt))) return false
  if (meta.source !== 'human' && meta.source !== 'ai') return false
  if (meta.taskId !== undefined && (typeof meta.taskId !== 'string' || meta.taskId.length === 0 || meta.taskId.length > 128)) return false
  return meta.state === 'moving' || meta.state === 'trashed' || meta.state === 'damaged'
}

/** journal `trashed[]` 一条的严格校验；上限与唯一性由 `VaultLifecycle` 的解析负责。 */
export function validTrashedRecord(value: unknown): value is TrashedRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as TrashedRecord
  if (Object.keys(record).sort().join() !== ['at', 'contentHash', 'objectVersion', 'relPath', 'trashId'].sort().join()) return false
  return typeof record.trashId === 'string' && ID_PATTERN.test(record.trashId) &&
    validRelPath(record.relPath) && isNotePath(record.relPath) &&
    typeof record.objectVersion === 'string' && record.objectVersion.length > 0 && record.objectVersion.length < 512 &&
    typeof record.contentHash === 'string' && SHA256.test(record.contentHash) &&
    typeof record.at === 'string' && Number.isFinite(Date.parse(record.at))
}

/**
 * 库内已删除的条目存储。所有方法都是同步磁盘事务；调用方负责把它放进
 * `VaultMutationQueue`，并在删除成功后自己写 journal 与账本。
 */
export class TrashStore {
  private readonly now: () => Date
  private readonly retentionMs: number
  private readonly bytesLimit: number

  constructor(private readonly root: string, options: TrashStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.retentionMs = options.retentionMs ?? TRASH_RETENTION_MS
    this.bytesLimit = options.bytesLimit ?? TRASH_BYTES_LIMIT
  }

  private fs(): ReturnType<typeof secureFsFor> {
    return secureFsFor(this.root)
  }

  entryDir(trashId: string): string {
    return `${TRASH_DIR}/${trashId}`
  }

  metaPath(trashId: string): string {
    return `${this.entryDir(trashId)}/${META_FILE}`
  }

  payloadDir(trashId: string): string {
    return `${this.entryDir(trashId)}/${PAYLOAD_DIR}`
  }

  /* ---------------------------------------------------------------- 读 */

  /** 目录里已有的条目名（只认目录；坏条目也在这里，绝不因为读不懂就跳过）。 */
  private entryNames(): string[] {
    try {
      return this.fs().list(TRASH_DIR).filter((entry) => entry.kind === 'dir').map((entry) => entry.name)
    } catch (error) {
      if (error instanceof Error && error.message === 'ENOENT') return []
      throw error
    }
  }

  /** 读一条 meta；读不懂、形状不对、id 与目录名不符都按坏条目处理（返回 null）。 */
  readMeta(trashId: string): TrashMeta | null {
    if (!isTrashId(trashId)) return null
    try {
      const snapshot = this.fs().readSnapshot(this.metaPath(trashId))
      if (snapshot.bytes.length > META_BYTES_LIMIT) return null
      const text = snapshot.bytes.toString('utf8')
      if (!Buffer.from(text, 'utf8').equals(snapshot.bytes)) return null
      const parsed: unknown = JSON.parse(text)
      if (!validTrashMeta(parsed) || parsed.trashId !== trashId) return null
      return parsed
    } catch {
      return null
    }
  }

  /** 一条条目实际占了多少字节（坏条目也能给出一个上界，供列表显示）。 */
  private payloadBytes(trashId: string): number {
    try {
      return this.folderBytes(this.payloadDir(trashId))
    } catch {
      return 0
    }
  }

  private folderBytes(relPath: string): number {
    let total = 0
    for (const entry of this.fs().list(relPath)) {
      if (entry.kind === 'dir') total += this.folderBytes(`${relPath}/${entry.name}`)
      else if (entry.kind === 'file') total += entry.size
      // 链接／其它类型不参与字节统计（也不跟随）。
    }
    return total
  }

  private resolveOrNull(relPath: string): { name: string; id: string; kind: 'dir' | 'file' } | null {
    try {
      return this.fs().resolve(relPath).at(-1) ?? null
    } catch (error) {
      if (error instanceof Error && error.message === 'ENOENT') return null
      throw error
    }
  }

  private statusOf(relPath: string): 'free' | 'occupied' {
    try {
      this.fs().resolve(relPath)
      return 'occupied'
    } catch (error) {
      if (error instanceof Error && error.message === 'ENOENT') return 'free'
      if (error instanceof Error && error.message === 'UNSAFE_PATH') return 'occupied'
      throw error
    }
  }

  /** 列表：坏条目标 damaged 但不丢；journal 里有、目录里没有的记录也列出。 */
  list(records: readonly TrashedRecord[] = []): TrashList {
    const entries: TrashEntryView[] = []
    let bytes = 0
    const sizes = new Map<string, number>()
    try {
      for (const entry of this.fs().list(TRASH_DIR)) sizes.set(entry.name, entry.mtimeMs)
    } catch (error) {
      if (!(error instanceof Error && error.message === 'ENOENT')) throw error
    }
    const seen = new Set<string>()
    for (const trashId of this.entryNames()) {
      seen.add(trashId)
      const meta = this.readMeta(trashId)
      if (meta) {
        const deletedAt = meta.deletedAt
        entries.push({
          id: trashId,
          originalRelPath: meta.originalRelPath,
          name: basename(meta.originalRelPath),
          kind: meta.kind,
          deletedAt,
          expiresAt: this.expiryOf(deletedAt),
          bytes: meta.bytes,
          source: meta.source,
          // 半截移动与损坏条目都不是可还原状态，列表如实标 damaged。
          state: meta.state === 'trashed' ? 'ok' : 'damaged'
        })
        bytes += meta.bytes
        continue
      }
      // 没有可解析的 meta：用目录时间给一个可读的删除时间，条目不丢。
      const deletedAt = new Date(sizes.get(trashId) ?? 0).toISOString()
      const measured = this.payloadBytes(trashId)
      entries.push({
        id: trashId, originalRelPath: '', name: trashId, kind: 'note',
        deletedAt, expiresAt: this.expiryOf(deletedAt), bytes: measured, source: 'human', state: 'damaged'
      })
      bytes += measured
    }
    // journal 记录仍在、条目目录已不在：仍列出（damaged），人能看见并明确删除该记录。
    for (const record of records) {
      if (seen.has(record.trashId)) continue
      entries.push({
        id: record.trashId, originalRelPath: record.relPath, name: basename(record.relPath), kind: 'note',
        deletedAt: record.at, expiresAt: this.expiryOf(record.at), bytes: 0, source: 'human', state: 'damaged'
      })
    }
    entries.sort((left, right) => Date.parse(right.deletedAt) - Date.parse(left.deletedAt))
    return { entries, bytes }
  }

  private expiryOf(deletedAt: string): string {
    const parsed = Date.parse(deletedAt)
    return new Date((Number.isFinite(parsed) ? parsed : 0) + this.retentionMs).toISOString()
  }

  /* ---------------------------------------------------------------- 删除 */

  /**
   * 删除事务的第 1、2 步与第 3 步的 meta 部分：
   * 核身份／附件 → 建条目目录 → 写 meta moving → 移动进 payload（保持原名）→ 写 meta trashed。
   * `record` 是第 3 步的 journal 落盘；它抛错就回滚已移动项并报 `TRASH_PARTIAL`。
   * 账本留痕在返回之后由调用方写（删除已经成立，账本失败不回滚）。
   */
  delete(relPath: string, options: { source: TrashSource; taskId?: string; record?: (meta: TrashMeta) => void }): TrashDeleteOutcome {
    const inspected = this.inspect(relPath)
    const trashId = randomUUID()
    this.ensureDirectory(TRASH_DIR)
    this.ensureDirectory(this.entryDir(trashId))
    this.ensureDirectory(this.payloadDir(trashId))
    const meta: TrashMeta = {
      version: 1,
      trashId,
      originalRelPath: relPath,
      objectVersion: inspected.objectVersion,
      contentHash: inspected.contentHash,
      kind: 'note',
      attachmentRelPath: inspected.attachmentRelPath,
      bytes: inspected.bytes,
      deletedAt: this.now().toISOString(),
      source: options.source,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      state: 'moving'
    }
    const payload = this.payloadDir(trashId)
    const moved: MovedObject[] = []
    try {
      this.putMeta(meta)
      this.fs().move(relPath, `${payload}/${basename(relPath)}`, inspected.objectVersion)
      moved.push({ from: relPath, to: `${payload}/${basename(relPath)}`, id: inspected.objectVersion })
      if (inspected.attachmentRelPath !== null && inspected.attachmentId !== null) {
        // 附件夹在移动前再核一次身份：夹子被换掉就不动笔记。
        const current = this.fs().resolve(inspected.attachmentRelPath).at(-1)
        if (current?.kind !== 'dir' || current.id !== inspected.attachmentId) throw new Error('PATH_CHANGED')
        const to = `${payload}/${basename(inspected.attachmentRelPath)}`
        this.fs().move(inspected.attachmentRelPath, to, inspected.attachmentId)
        moved.push({ from: inspected.attachmentRelPath, to, id: inspected.attachmentId })
      }
      const committed: TrashMeta = { ...meta, state: 'trashed' }
      this.putMeta(committed)
      options.record?.(committed)
      return {
        meta: committed,
        landing: this.entryDir(trashId),
        attachmentLanding: inspected.attachmentRelPath === null ? null : `${payload}/${basename(inspected.attachmentRelPath)}`
      }
    } catch (error) {
      const rollback = this.rollbackMoved(moved)
      // 回滚成功时条目目录里只剩 meta（payload 已空）：一并清掉；回滚不了就标 damaged，
      // payload 留在条目里，对账与列表都能看见，绝不静默丢。
      if (rollback.ok) this.discardEntry(meta)
      else this.markDamaged(meta)
      // 一步没动就原样上报；已经动过磁盘（哪怕回滚成功）按围栏报 TRASH_PARTIAL。
      if (moved.length === 0) throw error
      throw new Error('TRASH_PARTIAL', { cause: error })
    }
  }

  /** 删除前的对象核验：笔记身份、内容哈希、字节与同名附件夹。 */
  inspect(relPath: string): { objectVersion: string; contentHash: string; bytes: number; attachmentRelPath: string | null; attachmentId: string | null } {
    if (!validRelPath(relPath) || !isNotePath(relPath)) throw new Error('BAD_PATH')
    const fs = this.fs()
    const leaf = fs.resolve(relPath).at(-1)
    if (leaf?.kind !== 'file') throw new Error('BAD_PATH')
    const snapshot = fs.readSnapshot(relPath)
    if (snapshot.objectVersion !== leaf.id) throw new Error('PATH_CHANGED')
    let bytes = snapshot.bytes.length
    let attachmentRelPath: string | null = null
    let attachmentId: string | null = null
    try {
      const resolved = fs.resolve(relPath.slice(0, -3))
      if (resolved.at(-1)?.kind === 'dir') {
        attachmentRelPath = resolved.map((part) => part.name).join('/')
        attachmentId = resolved.at(-1)!.id
        bytes += this.folderBytes(attachmentRelPath)
      }
    } catch (error) {
      // 同名位置不是目录（普通文件／链接）时按「无附件夹」处理，与既有预览同一口径。
      if (!(error instanceof Error && (error.message === 'ENOENT' || error.message === 'UNSAFE_PATH'))) throw error
    }
    return { objectVersion: leaf.id, contentHash: digest(snapshot.bytes), bytes, attachmentRelPath, attachmentId }
  }

  /* ---------------------------------------------------------------- 还原 */

  /**
   * 还原：核 meta/hash／对象身份 → 原路径空则原位，被占则 `名字（恢复）.md` 副本
   * （附件夹同名调整）→ 父目录缺失则重建 → 移动出去 → 清掉条目目录。
   * 清理失败时把对象放回 payload 并报错：条目保持完整，不会出现「一半在库里、一半在已删除」。
   * journal 记录由调用方在成功返回后移除。
   */
  restore(trashId: string): TrashRestoreOutcome {
    if (!isTrashId(trashId)) return { ok: false, error: 'BAD_REQUEST' }
    const meta = this.readMeta(trashId)
    if (!meta) return { ok: false, error: 'TRASH_ENTRY_MISSING' }
    if (meta.state !== 'trashed') return { ok: false, error: 'TRASH_DAMAGED' }
    if (meta.kind !== 'note') return { ok: false, error: 'TRASH_DAMAGED' }
    const payload = this.payloadDir(trashId)
    const notePayload = `${payload}/${basename(meta.originalRelPath)}`
    if (!this.payloadMatches(notePayload, meta)) return { ok: false, error: 'TRASH_DAMAGED' }
    let folderPayload: string | null = null
    if (meta.attachmentRelPath !== null) {
      folderPayload = `${payload}/${basename(meta.attachmentRelPath)}`
      const folder = this.resolveOrNull(folderPayload)
      if (folder?.kind !== 'dir') return { ok: false, error: 'TRASH_DAMAGED' }
    }
    let target: { relPath: string; copied: boolean }
    try {
      target = this.chooseTarget(meta)
      this.ensureParents(target.relPath)
    } catch (error) {
      return { ok: false, error: codeOf(error) }
    }
    const moved: MovedObject[] = []
    try {
      this.fs().move(notePayload, target.relPath, meta.objectVersion)
      moved.push({ from: notePayload, to: target.relPath, id: meta.objectVersion })
      if (folderPayload !== null) {
        const folder = this.resolveOrNull(folderPayload)
        if (!folder || folder.kind !== 'dir') throw new Error('TRASH_DAMAGED')
        const folderTarget = target.relPath.slice(0, -3)
        this.fs().move(folderPayload, folderTarget, folder.id)
        moved.push({ from: folderPayload, to: folderTarget, id: folder.id })
      }
    } catch (error) {
      this.rollbackMoved(moved)
      return { ok: false, error: 'TRASH_PARTIAL' }
    }
    try {
      this.dispose(trashId)
    } catch {
      // 条目目录清不掉：把刚移出去的放回 payload，条目保持可还原，失败如实上报。
      const back = this.rollbackMoved(moved)
      return { ok: false, error: back.ok ? 'TRASH_KEPT' : 'TRASH_PARTIAL' }
    }
    return { ok: true, relPath: target.relPath, copied: target.copied }
  }

  private payloadMatches(payloadPath: string, meta: TrashMeta): boolean {
    try {
      const leaf = this.fs().resolve(payloadPath).at(-1)
      if (leaf?.kind !== 'file' || leaf.id !== meta.objectVersion) return false
      const snapshot = this.fs().readSnapshot(payloadPath)
      return digest(snapshot.bytes) === meta.contentHash
    } catch {
      return false
    }
  }

  /** 原位可用就用原位；原路径或附件夹任一被占，就一起改用 `名字（恢复）.md`。 */
  private chooseTarget(meta: TrashMeta): { relPath: string; copied: boolean } {
    const folderFree = (candidate: string): boolean =>
      meta.attachmentRelPath === null || this.statusOf(candidate.slice(0, -3)) === 'free'
    if (this.statusOf(meta.originalRelPath) === 'free' && folderFree(meta.originalRelPath)) {
      return { relPath: meta.originalRelPath, copied: false }
    }
    const stem = basename(meta.originalRelPath).replace(/\.md$/i, '')
    const parent = parentOf(meta.originalRelPath)
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const suffix = attempt === 1 ? '（恢复）' : `（恢复 ${attempt}）`
      const name = `${stem}${suffix}.md`
      const candidate = parent ? `${parent}/${name}` : name
      if (this.statusOf(candidate) === 'free' && folderFree(candidate)) return { relPath: candidate, copied: true }
    }
    throw new Error('TRASH_CONFLICT')
  }

  /** 原路径的父目录缺失就重建；父位置不是目录（文件／链接）则拒绝。 */
  private ensureParents(relPath: string): void {
    const parts = relPath.split('/').slice(0, -1)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const leaf = this.resolveOrNull(current)
      if (leaf === null) this.fs().createDirectory(current)
      else if (leaf.kind !== 'dir') throw new Error('TRASH_PARENT_INVALID')
    }
  }

  /* ---------------------------------------------------------------- 明确删除 */

  /**
   * 明确删除／过期：整条目目录用既有原生 `trash` 送系统废纸篓（绝不 unlink）。
   * 失败就保留条目并如实报错；成功后 journal 记录由调用方移除。
   */
  purge(trashId: string): TrashPurgeOutcome {
    if (!isTrashId(trashId)) return { ok: false, error: 'BAD_REQUEST' }
    const dir = this.entryDir(trashId)
    let leaf: { name: string; id: string; kind: 'dir' | 'file' } | null
    try {
      leaf = this.resolveOrNull(dir)
    } catch (error) {
      return { ok: false, error: codeOf(error) }
    }
    if (leaf === null) return { ok: true, removed: false }
    if (leaf.kind !== 'dir') return { ok: false, error: 'TRASH_UNSAFE' }
    try {
      this.fs().trash(dir, leaf.id)
    } catch (error) {
      return { ok: false, error: codeOf(error) }
    }
    return { ok: true, removed: true }
  }

  /* ---------------------------------------------------------------- 清理 */

  /**
   * 30 天 ＋ 1 GiB，从最旧开始送系统废纸篓。只动 `trashed` 状态且 meta 可读的条目：
   * 坏条目与半截条目留给对账/人明确删除，不自动送篓。`exclude` 用来保护刚删进来的那条。
   */
  sweep(exclude: readonly string[] = []): TrashSweepReport {
    const candidates: { id: string; meta: TrashMeta }[] = []
    let total = 0
    for (const trashId of this.entryNames()) {
      const meta = this.readMeta(trashId)
      if (!meta || meta.state !== 'trashed') continue
      candidates.push({ id: trashId, meta })
      total += meta.bytes
    }
    candidates.sort((left, right) => Date.parse(left.meta.deletedAt) - Date.parse(right.meta.deletedAt))
    const now = this.now().getTime()
    const purged: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const candidate of candidates) {
      if (exclude.includes(candidate.id)) continue
      const expired = now - Date.parse(candidate.meta.deletedAt) >= this.retentionMs
      const over = total > this.bytesLimit
      if (!expired && !over) break
      const result = this.purge(candidate.id)
      if (result.ok) {
        if (result.removed) {
          purged.push(candidate.id)
          total -= candidate.meta.bytes
        }
      } else failed.push({ id: candidate.id, error: result.error })
    }
    return { purged, failed, bytes: total }
  }

  /* ---------------------------------------------------------------- 对账 */

  /**
   * 启动对账：journal ↔ `.rgent-trash` ↔ 原路径。
   * - `moving` 半截：payload 完整且原路径空 → 补完删除；对象其实还在原路径 → 回滚条目；
   *   其余（原路径被占／payload 变了）→ damaged，绝不静默丢。
   * - `trashed`：payload 完整 → 保证 journal 有同一条记录；payload 空且原对象回到原路径 →
   *   还原已完成，清掉条目；payload 丢失 → damaged，记录保留。
   * - 目录没有 meta、journal 有记录但没有目录：都报告，不丢。
   */
  reconcile(records: readonly TrashedRecord[] = []): TrashReconcileReport {
    const report: TrashReconcileReport = {
      upsert: [], remove: [], completed: [], rolledBack: [], restored: [], damaged: [], missingEntries: [], issues: []
    }
    const known = new Map(records.map((record) => [record.trashId, record]))
    for (const trashId of this.entryNames()) {
      const record = known.get(trashId) ?? null
      known.delete(trashId)
      const meta = this.readMeta(trashId)
      if (!meta) {
        report.damaged.push(trashId)
        report.issues.push(`entry-without-meta:${trashId}`)
        continue
      }
      const payload = this.payloadDir(trashId)
      const notePayload = `${payload}/${basename(meta.originalRelPath)}`
      const payloadIntact = this.payloadMatches(notePayload, meta)
      let original: { name: string; id: string; kind: 'dir' | 'file' } | null = null
      let originalUnreadable = false
      try {
        original = this.resolveOrNull(meta.originalRelPath)
      } catch {
        // 原路径解析不了（例如中间被换成了文件或链接）：不能当成「空着」来补完删除。
        originalUnreadable = true
      }
      if (meta.state === 'moving') {
        if (payloadIntact && original === null && !originalUnreadable) {
          // 对象已经离开原路径：把这次删除补完（journal 记录由调用方写入）。
          try {
            this.putMeta({ ...meta, state: 'trashed' })
          } catch {
            this.markDamaged(meta)
            report.damaged.push(trashId)
            report.issues.push(`moving-unfinished:${trashId}`)
            continue
          }
          report.upsert.push(toRecord({ ...meta, state: 'trashed' }))
          report.completed.push(trashId)
          continue
        }
        if (!payloadIntact && original?.kind === 'file' && original.id === meta.objectVersion) {
          // 移动其实没有发生（或已回滚）：对象还在原位，条目清掉、记录去掉。
          if (this.discardEntry(meta)) {
            if (record) report.remove.push(trashId)
            report.rolledBack.push(trashId)
          } else {
            report.damaged.push(trashId)
          }
          continue
        }
        this.markDamaged(meta)
        report.damaged.push(trashId)
        report.issues.push(`moving-inconsistent:${trashId}`)
        continue
      }
      if (meta.state === 'damaged') {
        report.damaged.push(trashId)
        continue
      }
      if (!payloadIntact) {
        if (original?.kind === 'file' && original.id === meta.objectVersion) {
          // 还原已经完成，只剩条目目录没清理。
          if (this.discardEntry(meta)) {
            if (record) report.remove.push(trashId)
            report.restored.push(trashId)
          } else {
            report.damaged.push(trashId)
          }
          continue
        }
        this.markDamaged(meta)
        report.damaged.push(trashId)
        report.issues.push(`payload-missing:${trashId}`)
        continue
      }
      if (meta.attachmentRelPath !== null) {
        const folder = this.resolveOrNull(`${payload}/${basename(meta.attachmentRelPath)}`)
        if (folder?.kind !== 'dir') {
          this.markDamaged(meta)
          report.damaged.push(trashId)
          report.issues.push(`attachment-missing:${trashId}`)
        }
      }
      const expected = toRecord(meta)
      if (!record || !sameRecord(record, expected)) report.upsert.push(expected)
    }
    for (const [trashId] of known) {
      report.missingEntries.push(trashId)
      report.issues.push(`record-without-entry:${trashId}`)
    }
    return report
  }

  /* ---------------------------------------------------------------- 内部 */

  private ensureDirectory(relPath: string): void {
    try {
      if (this.fs().resolve(relPath).at(-1)?.kind === 'dir') return
    } catch (error) {
      if (!(error instanceof Error && error.message === 'ENOENT')) throw error
    }
    this.fs().createDirectory(relPath)
  }

  private putMeta(meta: TrashMeta): void {
    const path = this.metaPath(meta.trashId)
    const text = `${JSON.stringify(meta)}\n`
    let current: { bytes: Buffer; objectVersion: string } | null = null
    try {
      current = this.fs().readSnapshot(path)
    } catch (error) {
      if (!(error instanceof Error && error.message === 'ENOENT')) throw error
    }
    if (current) this.fs().replace(path, current.bytes.toString('utf8'), text, current.objectVersion)
    else this.fs().replace(path, null, text)
    const saved = this.fs().readSnapshot(path)
    if (saved.bytes.toString('utf8') !== text) throw new Error('TRASH_META_FAILED')
  }

  private markDamaged(meta: TrashMeta): void {
    if (meta.state === 'damaged') return
    try {
      const current = this.readMeta(meta.trashId)
      this.putMeta({ ...(current ?? meta), state: 'damaged' })
    } catch {
      // 标不上也不丢证据：条目与 payload 都还在，下次对账会再次看到。
    }
  }

  /** 把刚移进 payload 的对象放回原位（逆序）；目标被占或身份不符就失败。 */
  private rollbackMoved(moved: readonly MovedObject[]): { ok: boolean; failures: string[] } {
    const failures: string[] = []
    for (const item of [...moved].reverse()) {
      try {
        const current = this.fs().resolve(item.to).at(-1)
        if (!current || current.id !== item.id) {
          failures.push(item.from)
          continue
        }
        if (this.statusOf(item.from) !== 'free') {
          failures.push(item.from)
          continue
        }
        this.fs().move(item.to, item.from, item.id)
      } catch {
        failures.push(item.from)
      }
    }
    return { ok: failures.length === 0, failures }
  }

  /** 送条目目录进系统废纸篓；成功返回 true，失败返回 false（调用方决定标 damaged）。 */
  private discardEntry(meta: TrashMeta): boolean {
    try {
      this.dispose(meta.trashId)
      return true
    } catch {
      this.markDamaged(meta)
      return false
    }
  }

  private dispose(trashId: string): void {
    const dir = this.entryDir(trashId)
    const leaf = this.resolveOrNull(dir)
    if (!leaf) throw new Error('TRASH_ENTRY_MISSING')
    if (leaf.kind !== 'dir') throw new Error('TRASH_UNSAFE')
    this.fs().trash(dir, leaf.id)
  }
}

function toRecord(meta: TrashMeta): TrashedRecord {
  return {
    trashId: meta.trashId,
    relPath: meta.originalRelPath,
    objectVersion: meta.objectVersion,
    contentHash: meta.contentHash,
    at: meta.deletedAt
  }
}

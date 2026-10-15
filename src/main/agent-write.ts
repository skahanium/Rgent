import { randomUUID } from 'node:crypto'
import { compile } from '../markdown/index.ts'
import { partitionSource } from '../markdown/partition.ts'
import { hasHiddenSegment, isNotePath, sanitizeNoteName } from './paths.ts'

/** 写入门：模型侧写类工具的唯一入口。合同见 decisions.md「写类 AI 工具局部授权」。
 *  三条硬规矩：正文写入只发生在发起篇、只追加新块；建落点固定在发起篇所在目录；
 *  超限即拒并如实说明。这里不碰 IPC、不碰界面，也不复用人的 `noteWrite` 通道。 */

export const WRITE_LIMITS = {
  notesPerSession: 4,
  appendsPerNote: 2,
  bytesPerAppend: 8 * 1024,
  bytesPerSession: 32 * 1024,
  /** 结构操作额度本轮只立着，下一轮改名／挪才用得上。 */
  structuralPerSession: 3
} as const

/** 预览令牌有效期：够人看清再点，不留长期可重放的凭证。 */
const PREVIEW_TTL_MS = 120_000

export type WriteReason =
  | 'OUTSIDE_TASK_SCOPE'
  | 'AUTHORIZATION_REVOKED'
  | 'VAULT_CHANGED'
  | 'CONFLICT'
  | 'OBJECT_REPLACED'
  | 'OVER_LIMIT_BYTES'
  | 'OVER_LIMIT_APPENDS'
  | 'OVER_LIMIT_NOTES'
  | 'OVER_LIMIT_SESSION'
  | 'BAD_NAME'
  | 'TARGET_EXISTS'
  | 'ATTACHMENT_SUBTREE'
  | 'HIDDEN_PATH'
  | 'INVARIANT_VIOLATION'
  | 'STALE_PREVIEW'
  | 'NOT_ALLOWED'
  | 'ORIGIN_LOCKED'
  | 'OTHER_TASK_RUNNING'
  | 'OVER_LIMIT_STRUCTURAL'
  | 'LINK_REPAIR_OUT_OF_SCOPE'

export type WriteFailure = { ok: false; reason: WriteReason | string }
export type Snapshot = { content: string; revision: string; objectVersion?: string; sessionId?: string }
export type WriteBinding = { objectVersion: string }

export type WriteGateDeps = {
  /** 本场发起篇（grant.origin）。 */
  origin: () => string
  session: () => string | null
  /** 委托给授权：非发起篇一律抛 OUTSIDE_TASK_SCOPE。 */
  assertWriteTarget: (relPath: string) => void
  /** 授权仍有效、来源未失效；失效时抛错。 */
  assertLive: () => Promise<void> | void
  read: () => Promise<Snapshot>
  write: (relPath: string, content: string, expectedRevision: string, binding?: WriteBinding) => Promise<{ revision: string; objectVersion?: string }>
  /** 以下三项只有「建」需要；本轮补工具不传也能用。 */
  create?: (relPath: string, body: string) => Promise<{ relPath: string; revision: string; objectVersion?: string }>
  exists?: (relPath: string) => Promise<boolean> | boolean
  /** 目标目录是否落在某个笔记的同名附件夹子树里；是则返回该附件夹路径。 */
  attachmentFolder?: (relPath: string) => Promise<string | null> | string | null
  /** 结构操作（改名／挪）：只有宿主把库层迁移接上时才可用。 */
  structural?: StructuralDeps
  /** 包 2 提供真正的 AI 块写入器；门只校验它是否守约。 */
  composeAppend: (previous: string, text: string) => string
  now?: () => number
}

/** 库层迁移预览：判据在库层（含 `PERMISSION_DOWNGRADE`），门只用它做范围与边界判断。 */
export type StructuralPreview = {
  id: string
  source: string
  target: string
  moves: { from: string; to: string }[]
  linkChanges: { relPath: string }[]
  permissionChanges: { from: string; to: string; tier: string }[]
}
export type StructuralDeps = {
  /** 本场授权范围内的笔记（含发起篇）。 */
  authorized: (relPath: string) => boolean
  /** 发起篇：本场不对它做结构操作。 */
  origin: () => string
  /** 本场之外还有任务在跑。 */
  otherTaskRunning: () => boolean
  preview: (request: { kind: 'note'; source: string; target: string }) => Promise<StructuralPreview>
  commit: (previewId: string, repairLinks: boolean) => Promise<{ moved: { from: string; to: string }[] }>
}
export type StructuralPreviewResult = {
  ok: true; previewId: string; kind: 'rename' | 'move'; source: string; target: string
  moves: number; linkChanges: number; permissionChanges: number
} | WriteFailure
export type StructuralCommitResult = { ok: true; target: string; moved: { from: string; to: string }[] } | WriteFailure

export type AppendResult = { ok: true; relPath: string; revision: string; bytes: number } | WriteFailure
export type PreviewCreateResult = { ok: true; previewId: string; relPath: string } | WriteFailure
export type CommitCreateResult = { ok: true; relPath: string; revision: string; objectVersion?: string; bytes: number } | WriteFailure

export type WriteGateState = { notes: number; appends: Record<string, number>; bytes: number; structural: number }

const failure = (reason: WriteReason | string): WriteFailure => ({ ok: false, reason })

/** 记在账本里的是机读码；未知异常一律按原样透出，不编造原因。 */
const reasonOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'WRITE_FAILED')

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

const LEDGER_MARKER = /<!--\s*rgent:ledger(?:-task|-sources)?:/u
const AI_MARKER = /<!--\s*rgent:ai:v1(?:\s[^>]*)?-->/u

export function createWriteGate(deps: WriteGateDeps) {
  const now = deps.now ?? (() => Date.now())
  const appends = new Map<string, number>()
  const previews = new Map<string, { relPath: string; name: string; expiresAt: number }>()
  const structPreviews = new Map<string, { kind: 'rename' | 'move'; source: string; target: string; libId: string; expiresAt: number }>()
  let notes = 0
  let bytes = 0
  let structural = 0

  const state = (): WriteGateState => ({ notes, appends: Object.fromEntries(appends), bytes, structural })

  const dirOf = (relPath: string): string => {
    const at = relPath.lastIndexOf('/')
    return at < 0 ? '' : relPath.slice(0, at)
  }

  const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

  /** 追加必须等于「原文 ＋ 与块数对得上的 AI 块」：原文段不动、每个新顶层块都有身份、含账本标记一律拒。
   *  这是"只追加新块"的机器判据，不靠组合器自觉。 */
  function assertAppendInvariant(previous: string, next: string): boolean {
    const head = previous.replace(/\s+$/u, '')
    if (next === previous) return false
    if (!next.startsWith(head)) return false
    const tail = next.slice(head.length)
    if (!AI_MARKER.test(tail)) return false
    if (LEDGER_MARKER.test(tail)) return false
    if (partitionSource(next).ledger !== null) return false
    const compiled = compile(next)
    if (compiled.stale) return false
    const addedBlocks = compiled.index.blocks.filter((block) => block.range.start >= head.length)
    const addedMarkers = compiled.index.markers.filter((marker) => marker.identity === 'ai' && marker.range.start >= head.length)
    return addedBlocks.length > 0
      && addedBlocks.length === addedMarkers.length
      && addedBlocks.every((block) => block.identity === 'ai')
  }

  /** 改名：名字必须对消毒是恒等操作（只补 .md），落点固定在原目录。 */
  function renameTarget(relPath: string, newName: string): { ok: true; relPath: string } | WriteFailure {
    const base = newName.trim().replace(/\.md$/iu, '')
    if (!base || sanitizeNoteName(base) !== `${base}.md`) return failure('BAD_NAME')
    return { ok: true, relPath: join(dirOf(relPath), `${base}.md`) }
  }

  /** 挪：只换目录，文件名不动；目标目录本身要是个干净路径。 */
  function moveTarget(relPath: string, targetFolder: string): { ok: true; relPath: string } | WriteFailure {
    const folder = targetFolder.trim().replace(/\/+$/u, '')
    if (folder === '.' || folder === '..' || folder.startsWith('/') || folder.includes('\\') || /^[a-z]+:/iu.test(folder)) return failure('BAD_NAME')
    if (folder.split('/').some(part => part === '.' || part === '..')) return failure('BAD_NAME')
    const name = relPath.slice(relPath.lastIndexOf('/') + 1)
    return { ok: true, relPath: folder ? `${folder}/${name}` : name }
  }

  /** 建的目标先过名称、路径形态与附件夹子树三关；重名与额度由调用方在预览阶段一并核。 */
  async function targetFor(name: string): Promise<{ ok: true; relPath: string } | WriteFailure> {
    const base = name.trim().replace(/\.md$/iu, '')
    // 消毒必须对合法名字是个恒等操作（只补 .md）：改名即意味着名字里带非法字符／前导点。
    if (!base || sanitizeNoteName(base) !== `${base}.md`) return failure('BAD_NAME')
    const relPath = join(dirOf(deps.origin()), `${base}.md`)
    if (hasHiddenSegment(relPath)) return failure('HIDDEN_PATH')
    if (!isNotePath(relPath)) return failure('BAD_NAME')
    if (relPath === deps.origin()) return failure('TARGET_EXISTS')
    if (await deps.attachmentFolder?.(dirOf(relPath))) return failure('ATTACHMENT_SUBTREE')
    if (await deps.exists?.(relPath)) return failure('TARGET_EXISTS')
    return { ok: true, relPath }
  }

  return {
    state,

    /** 补任务发起篇：唯一的正文写入。 */
    async append(request: { text: string; expectedRevision?: string }): Promise<AppendResult> {
      const origin = deps.origin()
      const size = byteLength(request.text)
      if (size > WRITE_LIMITS.bytesPerAppend || bytes + size > WRITE_LIMITS.bytesPerSession) return failure(size > WRITE_LIMITS.bytesPerAppend ? 'OVER_LIMIT_BYTES' : 'OVER_LIMIT_SESSION')
      if ((appends.get(origin) ?? 0) >= WRITE_LIMITS.appendsPerNote) return failure('OVER_LIMIT_APPENDS')
      try {
        deps.assertWriteTarget(origin)
        await deps.assertLive()
        const snapshot = await deps.read()
        if (snapshot.sessionId !== undefined && snapshot.sessionId !== deps.session()) return failure('VAULT_CHANGED')
        // 给了期望修订就按它核（工具层用它挡住「人在同篇编辑」）；没给就用刚读到的修订，
        // 真正的竞态由库写入自己的 CAS 兜底。
        if (request.expectedRevision !== undefined && snapshot.revision !== request.expectedRevision) return failure('CONFLICT')
        const next = deps.composeAppend(snapshot.content, request.text)
        if (!assertAppendInvariant(snapshot.content, next)) return failure('INVARIANT_VIOLATION')
        const written = await deps.write(origin, next, snapshot.revision, snapshot.objectVersion ? { objectVersion: snapshot.objectVersion } : undefined)
        appends.set(origin, (appends.get(origin) ?? 0) + 1)
        bytes += size
        return { ok: true, relPath: origin, revision: written.revision, bytes: size }
      } catch (error) {
        return failure(reasonOf(error))
      }
    },

    /** 建的第一步：校验并给出目标路径，签发一次性预览令牌；此时不落盘。 */
    async previewCreate(request: { name: string }): Promise<PreviewCreateResult> {
      if (!deps.create) return failure('NOT_ALLOWED')
      try {
        deps.assertWriteTarget(deps.origin())
        await deps.assertLive()
        if (notes >= WRITE_LIMITS.notesPerSession) return failure('OVER_LIMIT_NOTES')
        const target = await targetFor(request.name)
        if (!target.ok) return target
        const previewId = randomUUID()
        previews.set(previewId, { relPath: target.relPath, name: request.name, expiresAt: now() + PREVIEW_TTL_MS })
        return { ok: true, previewId, relPath: target.relPath }
      } catch (error) {
        return failure(reasonOf(error))
      }
    },

    /** 建的第二步：消费令牌、复核额度与字节，然后经受信库服务创建。 */
    async commitCreate(request: { previewId: string; body: string }): Promise<CommitCreateResult> {
      if (!deps.create) return failure('NOT_ALLOWED')
      const preview = previews.get(request.previewId)
      if (!preview) return failure('STALE_PREVIEW')
      previews.delete(request.previewId)
      if (preview.expiresAt <= now()) return failure('STALE_PREVIEW')
      const size = byteLength(request.body)
      // 契约给"单次追加"设了 8 KiB；新建只受单场累计约束。
      if (bytes + size > WRITE_LIMITS.bytesPerSession) return failure('OVER_LIMIT_SESSION')
      if (notes >= WRITE_LIMITS.notesPerSession) return failure('OVER_LIMIT_NOTES')
      try {
        deps.assertWriteTarget(deps.origin())
        await deps.assertLive()
        const target = await targetFor(preview.name)
        if (!target.ok) return target
        if (target.relPath !== preview.relPath) return failure('STALE_PREVIEW')
        const created = await deps.create!(target.relPath, request.body)
        notes += 1
        bytes += size
        return { ok: true, relPath: created.relPath, revision: created.revision, objectVersion: created.objectVersion, bytes: size }
      } catch (error) {
        return failure(reasonOf(error))
      }
    },

    /** 人在预览里点了「不建」：丢弃令牌，不落盘。 */
    discardCreate(previewId: string): void {
      previews.delete(previewId)
    },

    /** 结构操作第一步：范围、落点、库层预览（含权限不放宽的库层判据）与一次性令牌。
     *  判据不复刻：库层的 `PERMISSION_DOWNGRADE` 与 `STRUCTURE_BUSY` 原样透出。 */
    async previewStruct(request: { kind: 'rename' | 'move'; relPath: string; newName?: string; targetFolder?: string }): Promise<StructuralPreviewResult> {
      const deps0 = deps.structural
      if (!deps0) return failure('NOT_ALLOWED')
      if (structural >= WRITE_LIMITS.structuralPerSession) return failure('OVER_LIMIT_STRUCTURAL')
      // 先认发起篇：它在授权范围内，但正是这一场要写入的目标，结构操作一律拒。
      if (request.relPath === deps0.origin()) return failure('ORIGIN_LOCKED')
      if (!deps0.authorized(request.relPath)) return failure('OUTSIDE_TASK_SCOPE')
      if (deps0.otherTaskRunning()) return failure('OTHER_TASK_RUNNING')
      if (!isNotePath(request.relPath)) return failure('BAD_NAME')
      const target = request.kind === 'rename'
        ? renameTarget(request.relPath, request.newName ?? '')
        : moveTarget(request.relPath, request.targetFolder ?? '')
      if (!target.ok) return target
      if (target.relPath === request.relPath) return failure('TARGET_EXISTS')
      if (hasHiddenSegment(target.relPath)) return failure('HIDDEN_PATH')
      if (!isNotePath(target.relPath)) return failure('BAD_NAME')
      if (await deps.attachmentFolder?.(dirOf(target.relPath))) return failure('ATTACHMENT_SUBTREE')
      if (await deps.exists?.(target.relPath)) return failure('TARGET_EXISTS')
      try {
        const preview = await deps0.preview({ kind: 'note', source: request.relPath, target: target.relPath })
        // 引用修复只允许落在授权范围内：范围外要改正文，整件事交给人做。
        if (preview.linkChanges.some(change => !deps0!.authorized(change.relPath))) return failure('LINK_REPAIR_OUT_OF_SCOPE')
        const previewId = randomUUID()
        structPreviews.set(previewId, { kind: request.kind, source: request.relPath, target: target.relPath, libId: preview.id, expiresAt: now() + PREVIEW_TTL_MS })
        return { ok: true, previewId, kind: request.kind, source: request.relPath, target: target.relPath, moves: preview.moves.length, linkChanges: preview.linkChanges.length, permissionChanges: preview.permissionChanges.length }
      } catch (error) {
        return failure(reasonOf(error))
      }
    },

    /** 结构操作第二步：消费令牌，交库层迁移（引用修复一并走它），成功才吃额度。 */
    async commitStruct(request: { previewId: string }): Promise<StructuralCommitResult> {
      const deps0 = deps.structural
      const pending = structPreviews.get(request.previewId)
      if (!deps0 || !pending) return failure('STALE_PREVIEW')
      structPreviews.delete(request.previewId)
      if (pending.expiresAt <= now()) return failure('STALE_PREVIEW')
      if (structural >= WRITE_LIMITS.structuralPerSession) return failure('OVER_LIMIT_STRUCTURAL')
      if (!deps0.authorized(pending.source)) return failure('OUTSIDE_TASK_SCOPE')
      try {
        const result = await deps0.commit(pending.libId, true)
        structural += 1
        return { ok: true, target: pending.target, moved: result.moved }
      } catch (error) {
        return failure(reasonOf(error))
      }
    },

    /** 人没点同意：丢弃令牌，什么都不做。 */
    discardStruct(previewId: string): void {
      structPreviews.delete(previewId)
    },

  }
}

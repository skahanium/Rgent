import type { EntryCreateRequest, FlushDonePayload, LifecycleRetryRequest, NoteWriteRequest, PermissionTier, RelocationCommitRequest, RelocationPreviewRequest, SetPermissionRequest } from './ipc.ts'

/**
 * 渲染进程传来的载荷一律当不可信：只在主进程这一层做形状与类型校验，
 * 校验逻辑抽成纯函数，好让它们能被单测覆盖（IPC handler 本身依赖 electron，
 * 不方便直接测）。
 */

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function isTier(value: unknown): value is PermissionTier {
  return value === 'reference' || value === 'follow' || value === 'forbidden'
}

export function parseNoteWriteRequest(value: unknown): NoteWriteRequest | null {
  const request = value as Partial<NoteWriteRequest> | null
  const relPath = asString(request?.relPath)
  const content = asString(request?.content)
  const expectedRevision = asString(request?.expectedRevision)
  // content 允许空串（清空一篇笔记是合法操作），路径与修订值不许空。
  const sessionId = asString(request?.sessionId)
  const objectVersion = asString(request?.objectVersion)
  if (!relPath || content == null || !expectedRevision || !sessionId || !objectVersion) return null
  return { relPath, content, expectedRevision, sessionId, objectVersion }
}

export function parseSetPermissionRequest(value: unknown): SetPermissionRequest | null {
  const request = value as Partial<SetPermissionRequest> | null
  const relPath = asString(request?.relPath)
  if (!relPath || !isTier(request?.tier)) return null
  return { relPath, tier: request.tier }
}

export function parseFlushDone(value: unknown): FlushDonePayload {
  const payload = value as Partial<FlushDonePayload> | null
  return { ok: payload?.ok === true }
}

export function parseNoteName(value: unknown): string | null {
  return asString(value)
}

export function parseEntryCreateRequest(value: unknown): EntryCreateRequest | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<EntryCreateRequest>
  const name = asString(item.name)
  const parent = asString(item.parent)
  return name?.trim() && parent != null ? { name, parent } : null
}

export function parseRelocationPreviewRequest(value: unknown): RelocationPreviewRequest | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<RelocationPreviewRequest>
  const source = asString(item.source)
  const target = asString(item.target)
  return (item.kind === 'note' || item.kind === 'folder') && source && target
    ? { kind: item.kind, source, target } : null
}

export function parseRelocationCommitRequest(value: unknown): RelocationCommitRequest | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<RelocationCommitRequest>
  const id = asString(item.id)
  return id && typeof item.repairLinks === 'boolean' ? { id, repairLinks: item.repairLinks } : null
}

export function parseLifecycleRetryRequest(value: unknown): LifecycleRetryRequest | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<LifecycleRetryRequest>
  return typeof item.sessionId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(item.sessionId) &&
    typeof item.revision === 'string' && /^[a-f0-9]{64}$/.test(item.revision)
    ? { sessionId: item.sessionId, revision: item.revision } : null
}

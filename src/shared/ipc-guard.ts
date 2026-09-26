import type { FlushDonePayload, NoteWriteRequest, PermissionTier, SetPermissionRequest } from './ipc.ts'

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
  if (!relPath || content == null || !expectedRevision) return null
  return { relPath, content, expectedRevision }
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

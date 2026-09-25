export type FlushDonePayload = { ok: boolean }

/**
 * 渲染进程还活着时：只有写盘成功才关窗。
 * 渲染进程已经没了：超时关窗，避免卡死在 preventDefault。
 */
export function shouldCloseAfterFlush(ok: boolean, rendererAlive: boolean): boolean {
  if (!rendererAlive) return true
  return ok
}

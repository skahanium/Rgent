export type FlushDonePayload = { ok: boolean }

/** 即使保存抛错，也要把失败结果交回主进程，避免关窗流程悬空。 */
export async function reportFlush(
  save: () => Promise<boolean>,
  done: (payload: FlushDonePayload) => void
): Promise<void> {
  let ok = false
  try {
    ok = await save()
  } catch {
    // 主进程统一提供重试、继续编辑和放弃的选择。
  }
  done({ ok })
}

export type CloseAction = 'flush' | 'prompt' | 'close' | 'cancel' | 'none'
export type CloseDecision = 'retry' | 'continue' | 'discard'

/** 一次关窗请求只允许一个保存尝试或一个失败决策在进行。 */
export class CloseFlow {
  private state: 'idle' | 'flushing' | 'deciding' | 'closing' = 'idle'

  request(): CloseAction {
    if (this.state !== 'idle') return 'none'
    this.state = 'flushing'
    return 'flush'
  }

  flushed(ok: boolean): CloseAction {
    if (this.state !== 'flushing') return 'none'
    this.state = ok ? 'closing' : 'deciding'
    return ok ? 'close' : 'prompt'
  }

  decide(choice: CloseDecision): CloseAction {
    if (this.state !== 'deciding') return 'none'
    if (choice === 'retry') {
      this.state = 'flushing'
      return 'flush'
    }
    if (choice === 'continue') {
      this.state = 'idle'
      return 'cancel'
    }
    this.state = 'closing'
    return 'close'
  }

  rendererGone(): CloseAction {
    if (this.state !== 'flushing' && this.state !== 'deciding') return 'none'
    this.state = 'closing'
    return 'close'
  }
}

/**
 * 渲染进程还活着时：只有写盘成功才关窗。
 * 渲染进程已经没了：超时关窗，避免卡死在 preventDefault。
 */
export function shouldCloseAfterFlush(ok: boolean, rendererAlive: boolean): boolean {
  if (!rendererAlive) return true
  return ok
}

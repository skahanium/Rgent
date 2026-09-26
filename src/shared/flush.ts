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

  /**
   * 超时了但渲染进程没死（挂起、或计时器触发之后才崩）。不能什么都不做：
   * 那会让流程永久停在 flushing，之后每次关窗都返回 'none'，窗口关不掉、Cmd+Q
   * 也被挡住。转成决策态，由主进程原生对话框给出重试 / 继续编辑 / 放弃。
   *
   * 已知取舍：进了决策态之后，渲染进程迟到的 `{ ok: true }` 会被忽略
   * （`flushed` 只在 flushing 态生效），窗口不自动关。人点「重试保存」即可自愈，
   * 比「关窗流程悬空」安全。
   */
  stalled(): CloseAction {
    if (this.state !== 'flushing') return 'none'
    this.state = 'deciding'
    return 'prompt'
  }
}

/**
 * 关窗把保存请求发出去后的两条出路。
 * 注意 rendererAlive 为真时**不能**直接放行，也不能什么都不做——
 * 前者会静默丢稿，后者会把应用锁死（见 stalled 的注释）。
 */
export function timeoutAction(flow: CloseFlow, rendererAlive: boolean): CloseAction {
  return rendererAlive ? flow.stalled() : flow.rendererGone()
}

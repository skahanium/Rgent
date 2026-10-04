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

export type RecoveryFlushPhase = 'recovery-preview' | 'recovery-commit' | 'recovery-resume' | 'recovery-release'
export type LifecycleFlushPhase = 'settings' | 'freeze' | RecoveryFlushPhase
export type RecoveryFlushContext = { sessionId: string; operationId: string }

/** Only an in-memory input hold. A resume acknowledgement does not claim drafts were saved. */
export class RecoveryDraftGate {
  private owner: RecoveryFlushContext | null = null
  private preview = false
  held(sessionId: string | null): boolean { return !!this.owner && this.owner.sessionId === sessionId }
  maySave(sessionId:string|null,operationId?:string):boolean { return !this.held(sessionId)||(this.preview&&!!operationId&&this.owner?.operationId===operationId) }
  async handle(phase: RecoveryFlushPhase, context: RecoveryFlushContext, deps: {
    session: () => string | null; composing: () => boolean; changed: () => void
    settled: () => Promise<unknown>; save: () => Promise<boolean>; dirty: () => boolean
  }): Promise<boolean> {
    if (context.sessionId !== deps.session()) return false
    if (phase === 'recovery-release') {
      if (this.owner?.sessionId === context.sessionId && this.owner.operationId === context.operationId) {
        this.owner = null; deps.changed()
      }
      return true
    }
    if (deps.composing() || this.held(context.sessionId)) return false
    this.owner = context; this.preview = phase==='recovery-preview'; deps.changed()
    const current = () => this.owner === context && deps.session() === context.sessionId
    await deps.settled()
    if (!current()) return false
    if (phase === 'recovery-preview') return await deps.save() && current()
    return current() && (phase === 'recovery-resume' || !deps.dirty())
  }
}

/** A failed position write must remain a failure even when the body saved. */
export async function saveWorkspacePosition(write: () => Promise<boolean>, failed: () => void): Promise<boolean> {
  try { if (await write()) return true } catch { /* Report the same protected failure as a false reply. */ }
  failed()
  return false
}

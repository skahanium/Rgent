import { randomUUID } from 'node:crypto'
import { makeTaskFailure, type TaskFailure } from '../shared/task-failure.ts'

export type StopReason = 'user' | 'timeout' | 'close' | 'vault-change' | 'permission-change'
export type TaskResult = { status: 'completed' | 'cancelled' | 'failed'; reason?: StopReason | string; reasonDetail?: string; failure?: TaskFailure }
export type ActiveTask = { id: string; root: string; relPath: string; startedAt: number }
type Runner = (signal: AbortSignal) => Promise<void>
type Finalizer = (status: TaskResult['status'], reason?: TaskResult['reason'], reasonDetail?: string, failure?: TaskFailure) => Promise<void>

type Running = ActiveTask & {
  controller: AbortController
  done: Promise<TaskResult>
  stopReason?: StopReason
  failureReason?: string
  failureDetail?: string
}

/** Only sanitized, non-secret transport facts are persisted for diagnosis. */
function failureDetail(error: unknown): string | undefined {
  const cause = error instanceof Error && error.cause && typeof error.cause === 'object' ? error.cause as Record<string, unknown> : null
  if (!cause) return undefined
  const safe: Record<string, unknown> = {}
  for (const key of ['httpStatus','type','code','providerCode']) if (cause[key] !== undefined) safe[key] = cause[key]
  if (!Object.keys(safe).length) return undefined
  const value = JSON.stringify(safe)
  return value.length <= 512 ? value : undefined
}

/** Build a bounded task failure from a thrown error without persisting the original error text. */
function taskFailureOf(error: unknown): TaskFailure | undefined {
  if (!(error instanceof Error) || !error.message) return undefined
  const code = error.message
  const detail = error.cause && typeof error.cause === 'object' ? error.cause : undefined
  return makeTaskFailure({
    code,
    diagnosticId: randomUUID(),
    detail,
    stage: code.startsWith('LEDGER_') ? 'ledger' : code.startsWith('TOOL_') ? 'tool' : 'provider'
  })
}

/** Owns task lifetime; one task per note, while different notes may run concurrently. */
export class AgentTasks {
  private readonly running = new Map<string, Running>()

  active(): ActiveTask[] {
    return [...this.running.values()].map(({ id, root, relPath, startedAt }) => ({ id, root, relPath, startedAt }))
  }

  start(
    input: { id?: string; root: string; relPath: string; seconds: number },
    run: Runner,
    finalize: Finalizer = async () => {}
  ): { id: string; done: Promise<TaskResult> } {
    if (this.active().some((item) => item.root === input.root && item.relPath === input.relPath)) {
      throw new Error('NOTE_BUSY')
    }
    if (!Number.isSafeInteger(input.seconds) || input.seconds < 1) throw new Error('BAD_LIMIT')
    const id = input.id ?? randomUUID()
    if (this.running.has(id)) throw new Error('TASK_ID_BUSY')
    const controller = new AbortController()
    const task: Running = {
      id, root: input.root, relPath: input.relPath, startedAt: Date.now(), controller,
      done: Promise.resolve({ status: 'failed' })
    }
    this.running.set(id, task)
    const timer = setTimeout(() => {
      task.stopReason = 'timeout'
      controller.abort('timeout')
    }, input.seconds * 1000)
    task.done = (async () => {
      let result: TaskResult
      try {
        await run(controller.signal)
        result = controller.signal.aborted
          ? task.failureReason ? { status: 'failed', reason: task.failureReason } : { status: 'cancelled', reason: task.stopReason ?? 'user' }
          : { status: 'completed' }
      } catch (error) {
        const detail = failureDetail(error), failure = taskFailureOf(error)
        result = controller.signal.aborted
          ? task.failureReason ? { status: 'failed', reason: task.failureReason, ...(detail ? {reasonDetail:detail} : {}), ...(failure ? {failure} : {}) } : { status: 'cancelled', reason: task.stopReason ?? 'user' }
          : { status: 'failed', reason: error instanceof Error ? error.message : 'UNKNOWN', ...(detail ? {reasonDetail:detail} : {}), ...(failure ? {failure} : {}) }
        // Determine the failure first: aborting transport must not rewrite it as user cancellation.
        if (!controller.signal.aborted) controller.abort(result.reason)
      }
      try {
        await finalize(result.status, result.reason, result.reasonDetail, result.failure)
      } finally {
        clearTimeout(timer)
        this.running.delete(id)
      }
      return result
    })()
    return { id, done: task.done }
  }

  async cancel(id: string, reason: StopReason): Promise<TaskResult | null> {
    const task = this.running.get(id)
    if (!task) return null
    if (!task.controller.signal.aborted) {
      task.stopReason = reason
      task.controller.abort(reason)
    }
    return task.done
  }

  async fail(id: string, reason: string): Promise<TaskResult | null> {
    const task = this.running.get(id)
    if (!task) return null
    if (!task.controller.signal.aborted) {
      task.failureReason = reason
      task.controller.abort(reason)
    }
    return task.done
  }

  async cancelAll(reason: StopReason, root?: string): Promise<void> {
    const settled = await Promise.allSettled(this.active()
      .filter((task) => root == null || task.root === root)
      .map((task) => this.cancel(task.id, reason)))
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (failure) throw failure.reason
  }
}

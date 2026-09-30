import { randomUUID } from 'node:crypto'

export type StopReason = 'user' | 'timeout' | 'close' | 'vault-change' | 'permission-change'
export type TaskResult = { status: 'completed' | 'cancelled' | 'failed'; reason?: StopReason | string }
export type ActiveTask = { id: string; root: string; relPath: string; startedAt: number }
type Runner = (signal: AbortSignal) => Promise<void>
type Finalizer = (status: TaskResult['status'], reason?: TaskResult['reason']) => Promise<void>

type Running = ActiveTask & {
  controller: AbortController
  done: Promise<TaskResult>
  stopReason?: StopReason
  failureReason?: string
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
        result = controller.signal.aborted
          ? task.failureReason ? { status: 'failed', reason: task.failureReason } : { status: 'cancelled', reason: task.stopReason ?? 'user' }
          : { status: 'failed', reason: error instanceof Error ? error.message : 'UNKNOWN' }
        // Determine the failure first: aborting transport must not rewrite it as user cancellation.
        if (!controller.signal.aborted) controller.abort(result.reason)
      }
      try {
        await finalize(result.status, result.reason)
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

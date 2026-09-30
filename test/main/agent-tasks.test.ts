import { describe, expect, it, vi } from 'vitest'
import { AgentTasks } from '../../src/main/agent-tasks.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Agent task ownership', () => {
  it('runs one task per note while allowing a different note to run', async () => {
    const tasks = new AgentTasks()
    const a = deferred()
    const b = deferred()
    const one = tasks.start({ root: '/vault', relPath: 'a.md', seconds: 30 }, async () => { await a.promise })
    const two = tasks.start({ root: '/vault', relPath: 'b.md', seconds: 30 }, async () => { await b.promise })
    expect(tasks.active().map((task) => task.relPath)).toEqual(['a.md', 'b.md'])
    expect(() => tasks.start({ root: '/vault', relPath: 'a.md', seconds: 30 }, async () => {})).toThrow('NOTE_BUSY')
    a.resolve()
    b.resolve()
    await Promise.all([one.done, two.done])
    expect(tasks.active()).toEqual([])
  })

  it('accepts a preallocated task ID for the persisted prompt marker', async () => {
    const tasks = new AgentTasks()
    const started = tasks.start({ id: 'task-a', root: '/vault', relPath: 'a.md', seconds: 1 }, async () => {})
    expect(started.id).toBe('task-a')
    await started.done
  })

  it('cancels only the addressed task and waits for its finalizer', async () => {
    const tasks = new AgentTasks()
    const final = vi.fn(async () => {})
    const one = tasks.start({ root: '/vault', relPath: 'a.md', seconds: 30 }, (signal) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    }), final)
    const b = deferred()
    const two = tasks.start({ root: '/vault', relPath: 'b.md', seconds: 30 }, async () => { await b.promise })
    await tasks.cancel(one.id, 'user')
    expect(final).toHaveBeenCalledWith('cancelled', 'user')
    expect(tasks.active().map((task) => task.id)).toEqual([two.id])
    b.resolve()
    await two.done
  })

  it('stops a timed-out task with a reason', async () => {
    vi.useFakeTimers()
    try {
      const tasks = new AgentTasks()
      const final = vi.fn(async () => {})
      const task = tasks.start({ root: '/vault', relPath: 'a.md', seconds: 1 }, (signal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      }), final)
      await vi.advanceTimersByTimeAsync(1000)
      await task.done
      expect(final).toHaveBeenCalledWith('cancelled', 'timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
it('aborts an in-flight provider on runner failure while preserving failed cause',async()=>{
  const tasks=new AgentTasks();let signal!:AbortSignal
  const task=tasks.start({root:'/vault',relPath:'a.md',seconds:30},async current=>{signal=current;throw Error('SOURCE_CHANGED')})
  expect(await task.done).toEqual({status:'failed',reason:'SOURCE_CHANGED'})
  expect(signal.aborted).toBe(true)
  expect(signal.reason).toBe('SOURCE_CHANGED')
})

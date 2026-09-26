import { describe, expect, it } from 'vitest'
import { CloseFlow, reportFlush, timeoutAction } from '../../src/shared/flush.ts'

describe('timeoutAction', () => {
  it('never leaves a live renderer without an escape', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(timeoutAction(flow, true)).toBe('prompt')
    // 关键回归：不能返回 'none'，否则流程停在 flushing，窗口关不掉。
    expect(flow.request()).toBe('none')
    expect(timeoutAction(flow, true)).toBe('none')
  })

  it('closes when the renderer is gone so a hung flush cannot pin the window', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(timeoutAction(flow, false)).toBe('close')
  })
})

it('reports a failed flush even when the save operation throws', async () => {
  const results: Array<{ ok: boolean }> = []
  await reportFlush(async () => { throw new Error('disk unavailable') }, (payload) => results.push(payload))
  expect(results).toEqual([{ ok: false }])
})

describe('CloseFlow', () => {
  it('closes after a successful save', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(true)).toBe('close')
  })

  it('retries a failed save and closes only after the retry succeeds', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.decide('retry')).toBe('flush')
    expect(flow.flushed(true)).toBe('close')
  })

  it('lets a person continue editing and start a later close afresh', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.decide('continue')).toBe('cancel')
    expect(flow.request()).toBe('flush')
  })

  it('closes only after an explicit discard decision', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.decide('discard')).toBe('close')
  })

  it('ignores repeated close requests while saving or awaiting a decision', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.request()).toBe('none')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.request()).toBe('none')
    expect(flow.decide('retry')).toBe('flush')
    expect(flow.request()).toBe('none')
  })

  it('permits close when the renderer disappears during a pending save', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.rendererGone()).toBe('close')
  })

  it('turns a stall into a decision instead of doing nothing', () => {
    const idle = new CloseFlow()
    expect(idle.stalled()).toBe('none')
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.stalled()).toBe('prompt')
    expect(flow.stalled()).toBe('none')
    expect(flow.decide('continue')).toBe('cancel')
    expect(flow.request()).toBe('flush')
  })

  it('lets a late reply still drive the flow after the renderer died', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.rendererGone()).toBe('close')
    expect(flow.flushed(true)).toBe('none')
  })
})

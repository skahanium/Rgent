import { describe, expect, it } from 'vitest'
import { CloseFlow, reportFlush, shouldCloseAfterFlush } from '../../src/shared/flush.ts'

describe('shouldCloseAfterFlush', () => {
  it('closes only after a successful flush while the renderer is alive', () => {
    expect(shouldCloseAfterFlush(true, true)).toBe(true)
    expect(shouldCloseAfterFlush(false, true)).toBe(false)
  })

  it('closes when the renderer is gone so a hung flush cannot pin the window', () => {
    expect(shouldCloseAfterFlush(false, false)).toBe(true)
    expect(shouldCloseAfterFlush(true, false)).toBe(true)
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
})

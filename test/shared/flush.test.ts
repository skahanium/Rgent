import { describe, expect, it } from 'vitest'
import { shouldCloseAfterFlush } from '../../src/shared/flush.ts'

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

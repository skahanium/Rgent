import { describe, expect, it, vi } from 'vitest'
import { postTrashOutcome, verifyLanding } from '../../src/main/trash-result.ts'

describe('verifyLanding', () => {
  it('treats a missing landing receipt as unverified instead of guessing', () => {
    const stat = vi.fn()
    expect(verifyLanding(undefined, '7:9', stat)).toBe('unverified')
    expect(verifyLanding(null, '7:9', stat)).toBe('unverified')
    expect(verifyLanding('', '7:9', stat)).toBe('unverified')
    expect(stat).not.toHaveBeenCalled()
  })

  it('throws LANDING_MISMATCH when the landing object is not the expected identity', () => {
    const stat = vi.fn(() => ({ dev: 7, ino: 10 }))
    expect(() => verifyLanding('/Users/someone/.Trash/稿.md', '7:9', stat)).toThrow('LANDING_MISMATCH')
    expect(stat).toHaveBeenCalledWith('/Users/someone/.Trash/稿.md')
  })

  it('verifies when the landing stat matches the expected identity', () => {
    const stat = vi.fn(() => ({ dev: 7, ino: 9 }))
    expect(verifyLanding('/Users/someone/.Trash/稿.md', '7:9', stat)).toBe('verified')
  })
})

describe('postTrashOutcome', () => {
  it('treats ENOENT as gone: the original path no longer resolves', () => {
    expect(postTrashOutcome(() => { throw new Error('ENOENT') })).toBe('gone')
  })

  it('conflicts when the original path still holds the same object', () => {
    expect(() => postTrashOutcome(() => ({ id: '7:9' }))).toThrow('TRASH_CONFLICT')
  })

  it('conflicts when the original path holds a different object', () => {
    expect(() => postTrashOutcome(() => ({ id: '7:10' }))).toThrow('TRASH_CONFLICT')
  })

  it('rethrows any other resolution failure untouched', () => {
    const failure = new Error('IO_ERROR')
    expect(() => postTrashOutcome(() => { throw failure })).toThrow(failure)
  })
})

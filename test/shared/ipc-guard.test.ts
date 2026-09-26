import { describe, expect, it } from 'vitest'
import {
  asString,
  isTier,
  parseFlushDone,
  parseNoteName,
  parseNoteWriteRequest,
  parseSetPermissionRequest
} from '../../src/shared/ipc-guard.ts'

describe('ipc payload guards', () => {
  it('takes only real strings', () => {
    expect(asString('a')).toBe('a')
    expect(asString('')).toBe('')
    expect(asString(1)).toBeNull()
    expect(asString(null)).toBeNull()
    expect(asString(undefined)).toBeNull()
    expect(asString({ toString: () => 'a' })).toBeNull()
  })

  it('rejects a note write unless the path, content and revision are all strings', () => {
    const good = { relPath: 'a.md', content: '正文', expectedRevision: 'rev' }
    expect(parseNoteWriteRequest(good)).toEqual(good)
    // 清空一篇笔记是合法的：content 允许空串。
    expect(parseNoteWriteRequest({ ...good, content: '' })).toEqual({ ...good, content: '' })
    expect(parseNoteWriteRequest({ ...good, relPath: '' })).toBeNull()
    expect(parseNoteWriteRequest({ ...good, expectedRevision: '' })).toBeNull()
    expect(parseNoteWriteRequest({ ...good, content: undefined })).toBeNull()
    expect(parseNoteWriteRequest({ ...good, relPath: 42 })).toBeNull()
    expect(parseNoteWriteRequest(null)).toBeNull()
    expect(parseNoteWriteRequest('a.md')).toBeNull()
  })

  it('accepts only the three tiers', () => {
    expect(isTier('reference')).toBe(true)
    expect(isTier('follow')).toBe(true)
    expect(isTier('forbidden')).toBe(true)
    expect(isTier('admin')).toBe(false)
    expect(isTier(undefined)).toBe(false)
    expect(parseSetPermissionRequest({ relPath: '工作', tier: 'forbidden' })).toEqual({ relPath: '工作', tier: 'forbidden' })
    expect(parseSetPermissionRequest({ relPath: '工作', tier: 'admin' })).toBeNull()
    expect(parseSetPermissionRequest({ tier: 'forbidden' })).toBeNull()
    expect(parseSetPermissionRequest(null)).toBeNull()
  })

  it('treats anything but an explicit ok:true as a failed flush', () => {
    expect(parseFlushDone({ ok: true })).toEqual({ ok: true })
    expect(parseFlushDone({ ok: false })).toEqual({ ok: false })
    expect(parseFlushDone({ ok: 'yes' })).toEqual({ ok: false })
    expect(parseFlushDone(null)).toEqual({ ok: false })
    expect(parseFlushDone(undefined)).toEqual({ ok: false })
  })

  it('takes a note name only as a non-empty string', () => {
    expect(parseNoteName('初稿')).toBe('初稿')
    expect(parseNoteName('')).toBe('')
    expect(parseNoteName(7)).toBeNull()
    expect(parseNoteName(null)).toBeNull()
  })
})

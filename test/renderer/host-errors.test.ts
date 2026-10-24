import { describe, expect, it } from 'vitest'
import { HOST_ERROR_CODES, hostErrorText } from '../../src/renderer/src/host-errors.ts'

describe('Host failure messages', () => {
  it.each(HOST_ERROR_CODES)('has a readable message for %s', (code) => {
    const text = hostErrorText(code)
    expect(text).not.toBe(code)
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('explains the ledger boundary failure with the next step', () => {
    const text = hostErrorText('LEDGER_BOUNDARY_INVALID')
    expect(text).toContain('账本边界')
    expect(text).toContain('保存')
  })

  it('keeps the unique recovery and trash facts on overlapping codes', () => {
    expect(hostErrorText('LIFECYCLE_RECOVERY_REQUIRED')).toContain('恢复记录')
    expect(hostErrorText('PATH_CHANGED')).toContain('没有删除')
  })

  it('explains partial trash work and the in-vault record limit', () => {
    expect(hostErrorText('TRASH_PARTIAL')).toContain('只完成了一部分')
    expect(hostErrorText('TRASH_PARTIAL')).toContain('已删除')
    expect(hostErrorText('TRASH_RECORD_LIMIT')).toContain('256 条')
    expect(hostErrorText('TRASH_RECORD_LIMIT')).toContain('已删除')
  })

  it('points trash conflicts at the in-vault deletion instead of the old system-trash landing', () => {
    expect(hostErrorText('TRASH_CONFLICT')).toContain('已删除记录仍在')
    expect(hostErrorText('TRASH_CONFLICT')).not.toContain('系统废纸篓')
    expect(hostErrorText('LANDING_MISMATCH')).not.toContain('系统废纸篓')
  })

  it('covers the authorization and start-up codes the popover can show', () => {
    const popoverCodes = ['STALE_AUTHORIZATION', 'INVALID_AUTHORIZATION', 'AUTHORIZATION_SCOPE_TOO_LARGE', 'UNSAVED_DRAFT', 'NOTE_BUSY', 'MODEL_CONFIG_UNAVAILABLE', 'LIFECYCLE_RECOVERY_REQUIRED', 'AI_BLOCK_CHANGED']
    for (const code of popoverCodes) expect(hostErrorText(code)).not.toBe(code)
    expect(new Set(HOST_ERROR_CODES).size).toBe(HOST_ERROR_CODES.length)
  })

  it('explains the new program-side memory codes and never shows the raw code', () => {
    const newCodes = ['MEMORY_SEMANTIC_RESCOPED', 'MEMORY_SEMANTIC_DUPLICATE', 'MEMORY_TEMPORARY_STANDING']
    for (const code of newCodes) {
      expect(HOST_ERROR_CODES).toContain(code)
      const text = hostErrorText(code)
      expect(text).not.toBe(code)
      expect(text).not.toContain(code)
      expect(text).toMatch(/[\u4e00-\u9fff]/u)
    }
    expect(hostErrorText('MEMORY_SEMANTIC_RESCOPED')).toContain('已按项目事实保存')
    expect(hostErrorText('MEMORY_SEMANTIC_DUPLICATE')).toContain('重复')
    expect(hostErrorText('MEMORY_TEMPORARY_STANDING')).toContain('接续形口令')
  })

  it('passes through the planned Chinese reasons untouched', () => {
    expect(hostErrorText('旧账本摘要预算不足')).toBe('旧账本摘要预算不足')
  })
})

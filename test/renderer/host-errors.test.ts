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

  it('covers the authorization and start-up codes the popover can show', () => {
    const popoverCodes = ['STALE_AUTHORIZATION', 'INVALID_AUTHORIZATION', 'AUTHORIZATION_SCOPE_TOO_LARGE', 'UNSAVED_DRAFT', 'NOTE_BUSY', 'MODEL_CONFIG_UNAVAILABLE', 'LIFECYCLE_RECOVERY_REQUIRED', 'AI_BLOCK_CHANGED']
    for (const code of popoverCodes) expect(hostErrorText(code)).not.toBe(code)
    expect(new Set(HOST_ERROR_CODES).size).toBe(HOST_ERROR_CODES.length)
  })

  it('passes through the planned Chinese reasons untouched', () => {
    expect(hostErrorText('旧账本摘要预算不足')).toBe('旧账本摘要预算不足')
  })
})

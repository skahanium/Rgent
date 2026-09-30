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

  it('passes through the planned Chinese reasons untouched', () => {
    expect(hostErrorText('旧账本摘要预算不足')).toBe('旧账本摘要预算不足')
  })
})

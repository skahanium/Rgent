import { describe, expect, it } from 'vitest'
import { isOwnEcho, ECHO_WINDOW_MS } from '../../src/main/echo.ts'

describe('isOwnEcho', () => {
  const now = 1_000_000

  it('treats the same revision inside the window as our own write', () => {
    expect(isOwnEcho({ revision: 'rev1', at: now - 10 }, 'rev1', now)).toBe(true)
  })

  it('treats a different revision as an external change even inside the window', () => {
    // 这一条是回归重点：旧实现比内容，读到旧内容 + 新记录会误报成外部改动。
    expect(isOwnEcho({ revision: 'rev2', at: now - 10 }, 'rev1', now)).toBe(false)
  })

  it('stops suppressing after the window', () => {
    expect(isOwnEcho({ revision: 'rev1', at: now - ECHO_WINDOW_MS - 1 }, 'rev1', now)).toBe(false)
  })

  it('has no opinion when nothing was written', () => {
    expect(isOwnEcho(undefined, 'rev1', now)).toBe(false)
  })
})

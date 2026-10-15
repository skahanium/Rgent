import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('renderer CSP', () => {
  it('sets base-uri to none', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/renderer/index.html'), 'utf8')
    expect(html).toMatch(/http-equiv="Content-Security-Policy"/)
    expect(html).toMatch(/base-uri 'none'/)
  })
})

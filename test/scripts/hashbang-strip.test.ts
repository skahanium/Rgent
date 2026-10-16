import { expect, it } from 'vitest'
import { stripHashbang, testTimeoutMs } from '../../vitest.config.ts'

it('strips a LF hashbang so the remainder is ordinary module source', () => {
  expect(stripHashbang('#!/usr/bin/env node\nexport const ok = 1\n')).toBe('export const ok = 1\n')
})

it('strips a CRLF hashbang the way Git for Windows checks out Unix CLI scripts', () => {
  expect(stripHashbang('#!/usr/bin/env node\r\nexport const ok = 1\r\n')).toBe('export const ok = 1\r\n')
})

it('leaves modules without a hashbang unchanged', () => {
  expect(stripHashbang('export const ok = 1\n')).toBe('export const ok = 1\n')
})

it('gives Windows CI a longer unit-test budget without changing assertions', () => {
  expect(testTimeoutMs).toBe(process.platform === 'win32' ? 60_000 : 20_000)
})

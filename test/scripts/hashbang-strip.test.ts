import { expect, it } from 'vitest'
import { stripHashbang } from '../../vitest.config.ts'

it('strips a LF hashbang so the remainder is ordinary module source', () => {
  expect(stripHashbang('#!/usr/bin/env node\nexport const ok = 1\n')).toBe('export const ok = 1\n')
})

it('strips a CRLF hashbang the way Git for Windows checks out Unix CLI scripts', () => {
  expect(stripHashbang('#!/usr/bin/env node\r\nexport const ok = 1\r\n')).toBe('export const ok = 1\r\n')
})

it('leaves modules without a hashbang unchanged', () => {
  expect(stripHashbang('export const ok = 1\n')).toBe('export const ok = 1\n')
})

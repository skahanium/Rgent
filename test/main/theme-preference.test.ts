import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadThemePreference, saveThemePreference } from '../../src/main/theme-preference.ts'

const directories: string[] = []
const directory = (): string => {
  const result = mkdtempSync(path.join(os.tmpdir(), 'rgent-theme-'))
  directories.push(result)
  return result
}

afterEach(() => {
  for (const item of directories.splice(0)) rmSync(item, { recursive: true, force: true })
})

describe('device theme preference', () => {
  it('defaults to system, persists a validated choice outside the vault, and reloads it', async () => {
    const root = directory()
    expect(loadThemePreference(root)).toBe('system')
    saveThemePreference(root, 'night')
    expect(loadThemePreference(root)).toBe('night')
    expect(JSON.parse(readFileSync(path.join(root, 'theme.json'), 'utf8'))).toEqual({ mode: 'night' })
    expect(() => saveThemePreference(root, 'unsupported' as never)).toThrow()
    expect(loadThemePreference(root)).toBe('night')
  })

  it('uses system on malformed saved data without overwriting it', async () => {
    const root = directory()
    writeFileSync(path.join(root, 'theme.json'), '{broken', 'utf8')
    expect(loadThemePreference(root)).toBe('system')
    expect(readFileSync(path.join(root, 'theme.json'), 'utf8')).toBe('{broken')
  })

  it('keeps the previous choice when writing cannot complete', async () => {
    const root = directory()
    saveThemePreference(root, 'day')
    const invalidParent = path.join(root, 'missing')
    expect(() => saveThemePreference(invalidParent, 'night')).toThrow()
    expect(loadThemePreference(root)).toBe('day')
  })
})

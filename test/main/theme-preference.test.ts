import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadReadingPreference, loadThemePreference, saveReadingPreference, saveThemePreference } from '../../src/main/theme-preference.ts'
import { DEFAULT_READING_PREFERENCE } from '../../src/shared/reading-preference.ts'

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
    expect(JSON.parse(readFileSync(path.join(root, 'theme.json'), 'utf8'))).toEqual({ mode: 'night', reading: DEFAULT_READING_PREFERENCE })
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

  it('loads a legacy theme record with default reading preferences and keeps reading choices during theme changes', () => {
    const root = directory()
    writeFileSync(path.join(root, 'theme.json'), JSON.stringify({ mode: 'day' }))
    expect(loadReadingPreference(root)).toEqual(DEFAULT_READING_PREFERENCE)
    const reading = { bodyFont: 'humanist', headingFont: 'literary', fontSize: 19, lineHeight: 1.75, maxWidth: 840 } as const
    saveReadingPreference(root, reading)
    saveThemePreference(root, 'night')
    expect(loadThemePreference(root)).toBe('night')
    expect(loadReadingPreference(root)).toEqual(reading)
  })

  it('rejects bad reading values without changing the saved theme or typography', () => {
    const root = directory()
    saveThemePreference(root, 'day')
    const reading = { ...DEFAULT_READING_PREFERENCE, fontSize: 18 }
    saveReadingPreference(root, reading)
    expect(() => saveReadingPreference(root, { ...reading, fontSize: Number.POSITIVE_INFINITY })).toThrow('BAD_READING')
    expect(() => saveReadingPreference(root, { ...reading, injected: 'unexpected' } as never)).toThrow('BAD_READING')
    expect(loadReadingPreference(root)).toEqual(reading)
    expect(loadThemePreference(root)).toBe('day')
  })

  it('keeps the prior appearance record when a reading write fails', () => {
    const root = directory()
    saveThemePreference(root, 'night')
    const invalidParent = path.join(root, 'missing')
    expect(() => saveReadingPreference(invalidParent, DEFAULT_READING_PREFERENCE)).toThrow()
    expect(loadThemePreference(root)).toBe('night')
  })
})

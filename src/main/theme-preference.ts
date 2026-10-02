import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ThemeMode } from '../shared/ipc.ts'
import { CHROME_TEXT_SIZES, DEFAULT_CHROME_TEXT, DEFAULT_READING_PREFERENCE, isChromeTextPreference, isReadingPreference, type ChromeTextPreference, type ReadingPreference } from '../shared/reading-preference.ts'

const FILE = 'theme.json'

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'day' || value === 'night' || value === 'system'
}

/** 损坏的本机外观偏好不应阻止打开笔记，也不能在读取时覆盖原文件。 */
export function loadThemePreference(userData: string): ThemeMode {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(userData, FILE), 'utf8'))
    if (value && typeof value === 'object' && 'mode' in value && isThemeMode(value.mode)) return value.mode
  } catch {
    // 不存在、损坏或无法读取时使用系统外观；下一次显式选择才写盘。
  }
  return 'system'
}

export function saveThemePreference(userData: string, mode: ThemeMode): void {
  if (!isThemeMode(mode)) throw new Error('BAD_MODE')
  saveAppearance(userData, { mode, reading: loadReadingPreference(userData), chromeText: loadChromeTextPreference(userData) })
}

export function loadReadingPreference(userData: string): ReadingPreference {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(userData, FILE), 'utf8'))
    if (value && typeof value === 'object' && 'reading' in value && isReadingPreference(value.reading)) return value.reading
  } catch { /* Old or corrupt local preference: keep the existing default. */ }
  return { ...DEFAULT_READING_PREFERENCE }
}

export function saveReadingPreference(userData: string, reading: ReadingPreference): void {
  if (!isReadingPreference(reading)) throw new Error('BAD_READING')
  saveAppearance(userData, { mode: loadThemePreference(userData), reading, chromeText: loadChromeTextPreference(userData) })
}

export function loadChromeTextPreference(userData: string): ChromeTextPreference {
  try {
    const value = JSON.parse(readFileSync(path.join(userData, FILE), 'utf8'))?.chromeText
    return { tabs: CHROME_TEXT_SIZES.includes(value?.tabs) ? value.tabs : 'default', sidebar: CHROME_TEXT_SIZES.includes(value?.sidebar) ? value.sidebar : 'default' }
  } catch { return { ...DEFAULT_CHROME_TEXT } }
}

export function saveChromeTextPreference(userData: string, chromeText: ChromeTextPreference): void {
  if (!isChromeTextPreference(chromeText)) throw new Error('BAD_CHROME_TEXT')
  saveAppearance(userData, { mode: loadThemePreference(userData), reading: loadReadingPreference(userData), chromeText })
}

function saveAppearance(userData: string, value: { mode: ThemeMode; reading: ReadingPreference; chromeText: ChromeTextPreference }): void {
  const target = path.join(userData, FILE)
  const temporary = path.join(userData, `.theme-${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, target)
  } catch (error) {
    if (fd !== null) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* temporary may not exist */ }
    throw error
  }
}

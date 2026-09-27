import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ThemeMode } from '../shared/ipc.ts'

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
  const target = path.join(userData, FILE)
  const temporary = path.join(userData, `.theme-${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ mode }), 'utf8')
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

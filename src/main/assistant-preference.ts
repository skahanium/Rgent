import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DEFAULT_ASSISTANT_HABITS, isAssistantHabits, type AssistantHabits } from '../shared/assistant.ts'

const FILE = 'assistant.json'

/** 损坏或缺失时用默认值；读取不写盘，下一次显式保存才落盘（与 theme.json 同一纪律）。 */
export function loadAssistantHabits(userData: string): AssistantHabits {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(userData, FILE), 'utf8'))
    if (isAssistantHabits(value)) return { ...value }
  } catch {
    // 不存在、损坏或无法读取：用默认习惯，且不动原文件。
  }
  return { ...DEFAULT_ASSISTANT_HABITS }
}

export function saveAssistantHabits(userData: string, habits: AssistantHabits): void {
  if (!isAssistantHabits(habits)) throw new Error('BAD_ASSISTANT')
  const target = path.join(userData, FILE)
  const temporary = path.join(userData, `.assistant-${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(habits), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, target)
  } catch (error) {
    if (fd !== null) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* may not exist */ }
    throw error
  }
}

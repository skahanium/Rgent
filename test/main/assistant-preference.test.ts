import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAssistantHabits, saveAssistantHabits } from '../../src/main/assistant-preference.ts'
import { DEFAULT_ASSISTANT_HABITS } from '../../src/shared/assistant.ts'

const directories: string[] = []
const directory = (): string => {
  const result = mkdtempSync(path.join(os.tmpdir(), 'rgent-assistant-'))
  directories.push(result)
  return result
}

afterEach(() => {
  for (const item of directories.splice(0)) rmSync(item, { recursive: true, force: true })
})

describe('assistant preference', () => {
  it('falls back to defaults without creating a file', () => {
    const root = directory()
    expect(loadAssistantHabits(root)).toEqual(DEFAULT_ASSISTANT_HABITS)
    expect(() => readFileSync(path.join(root, 'assistant.json'))).toThrow()
  })

  it('round-trips a saved habit and leaves corrupt data untouched', () => {
    const root = directory()
    saveAssistantHabits(root, { address: '老陈', tone: 'concise', note: '先给结论' })
    expect(loadAssistantHabits(root)).toEqual({ address: '老陈', tone: 'concise', note: '先给结论' })

    const corrupt = path.join(root, 'assistant.json')
    writeFileSync(corrupt, '{broken')
    expect(loadAssistantHabits(root)).toEqual(DEFAULT_ASSISTANT_HABITS)
    expect(readFileSync(corrupt, 'utf8')).toBe('{broken')

    const wrongShape = JSON.stringify({ address: '老陈', tone: 'shouty', note: '' })
    writeFileSync(corrupt, wrongShape)
    expect(loadAssistantHabits(root)).toEqual(DEFAULT_ASSISTANT_HABITS)
    expect(readFileSync(corrupt, 'utf8')).toBe(wrongShape)
  })

  it('rejects invalid habits instead of writing them', () => {
    const root = directory()
    expect(() => saveAssistantHabits(root, { address: ' 空', tone: 'plain', note: '' } as never)).toThrow('BAD_ASSISTANT')
    expect(existsSync(path.join(root, 'assistant.json'))).toBe(false)
  })
})

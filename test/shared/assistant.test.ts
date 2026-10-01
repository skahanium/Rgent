import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_LIMITS, assistantSummary, assistantSystemBlock, DEFAULT_ASSISTANT_HABITS,
  isAssistantHabits, isDefaultAssistantHabits, type AssistantHabits
} from '../../src/shared/assistant.ts'

describe('assistant habits contract', () => {
  it('accepts only the three tones with trimmed, bounded text', () => {
    expect(isAssistantHabits({ address: '', tone: 'plain', note: '' })).toBe(true)
    expect(isAssistantHabits({ address: '老陈', tone: 'detailed', note: '先给结论' })).toBe(true)
    expect(isAssistantHabits({ address: '', tone: 'shouty', note: '' })).toBe(false)
    expect(isAssistantHabits({ tone: 'plain', note: '' })).toBe(false)
    expect(isAssistantHabits({ address: ' 老陈', tone: 'plain', note: '' })).toBe(false)
    expect(isAssistantHabits({ address: '老陈\u0000', tone: 'plain', note: '' })).toBe(false)
    expect(isAssistantHabits({ address: 'x'.repeat(ASSISTANT_LIMITS.address + 1), tone: 'plain', note: '' })).toBe(false)
    expect(isAssistantHabits({ address: '', tone: 'plain', note: 'x'.repeat(ASSISTANT_LIMITS.note + 1) })).toBe(false)
    expect(isAssistantHabits(null)).toBe(false)
  })

  it('treats the untouched defaults as no habit at all', () => {
    expect(isDefaultAssistantHabits(DEFAULT_ASSISTANT_HABITS)).toBe(true)
    expect(assistantSummary(DEFAULT_ASSISTANT_HABITS)).toBe('')
    expect(assistantSystemBlock(DEFAULT_ASSISTANT_HABITS)).toBeNull()
    // 未 trim 的文本根本进不了存储，因此这里只校验它被契约拒绝
    expect(isAssistantHabits({ address: '', tone: 'plain', note: '  ' })).toBe(false)
  })

  it('summarises what is in effect and names the tone only when it is not the default', () => {
    expect(assistantSummary({ address: '老陈', tone: 'concise', note: '先给结论' })).toBe('称呼=老陈；语气=简洁；补充说明 4 字')
    expect(assistantSummary({ address: '', tone: 'concise', note: '' })).toBe('语气=简洁')
    expect(assistantSummary({ address: '老陈', tone: 'plain', note: '' })).toBe('称呼=老陈')
  })

  it('builds a prompt block that keeps scope and permissions untouched', () => {
    const block = assistantSystemBlock({ address: '老陈', tone: 'concise', note: '先给结论再给理由' })
    expect(block).toContain('不改变本场范围、工具与权限')
    expect(block).toContain('称呼用户为「老陈」')
    expect(block).toContain('语气：简洁')
    expect(block).toContain('- 补充说明：先给结论再给理由')
    // 只有语气时不留空的称呼与补充行
    const onlyTone = assistantSystemBlock({ address: '', tone: 'detailed', note: '' })!
    expect(onlyTone).not.toContain('称呼用户为')
    expect(onlyTone).not.toContain('补充说明：')
  })
})

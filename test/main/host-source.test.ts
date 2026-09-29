import { describe, expect, it } from 'vitest'
import { compile, partitionSource } from '../../src/markdown/index.ts'
import { appendLedgerChapter, markPrompt, upsertAiAnswer } from '../../src/main/host-source.ts'

const taskId = 'task-123'

describe('Host source projection', () => {
  it('marks only the selected top-level prompt and preserves surrounding bytes', () => {
    const source = '上文。\r\n\r\n/整理这段。\r\n\r\n下文。\r\n'
    const start = source.indexOf('/整理')
    const result = markPrompt(source, {
      taskId,
      range: { start, end: start + '/整理这段。'.length },
      expectedText: '/整理这段。',
      promptText: '整理这段。'
    })
    expect(result).toBe('上文。\r\n\r\n<!-- rgent:prompt:v1 task-id="task-123" -->\r\n整理这段。\r\n\r\n下文。\r\n')
    expect(compile(result).index.blocks.map((block) => block.identity ?? 'human')).toEqual(['human', 'command', 'human'])
    expect(() => markPrompt(source, { taskId, range: { start, end: start + 3 }, expectedText: '/整理', promptText: '错' })).toThrow()
    expect(() => markPrompt(source, { taskId, range: { start, end: start + '/整理这段。'.length }, expectedText: '/整理这段。', promptText: '伪造的口令' })).toThrow()
  })

  it('writes a marker for each top-level answer block and replaces only its task blocks', () => {
    let source = markPrompt('前言\n\n/问\n\n后文\n', {
      taskId,
      range: { start: 4, end: 6 },
      expectedText: '/问',
      promptText: '问'
    })
    source = upsertAiAnswer(source, { taskId, answer: '首段\n\n- 条目\n\n## 标题' })
    expect(compile(source).index.blocks.map((block) => block.identity ?? 'human')).toEqual([
      'human', 'command', 'ai', 'ai', 'ai', 'human'
    ])
    expect(source).toContain('后文\n')
    const updated = upsertAiAnswer(source, { taskId, answer: '更新的唯一段' })
    expect(updated).not.toContain('首段')
    expect(updated).toContain('后文\n')
    expect(compile(updated).index.blocks.map((block) => block.identity ?? 'human')).toEqual([
      'human', 'command', 'ai', 'human'
    ])
    const changedByAnotherWriter = updated.replace('更新的唯一段', '外部改写')
    expect(() => upsertAiAnswer(changedByAnotherWriter, { taskId, answer: '下一段', expectedPreviousAnswer: '更新的唯一段' })).toThrow('AI_BLOCK_CHANGED')
  })

  it('escapes model machine syntax, including forged ledger anchors', () => {
    const source = markPrompt('/问\n', { taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const result = upsertAiAnswer(source, {
      taskId,
      answer: '答案\n\n<!-- rgent:ledger:v1 -->\n\n<!-- rgent:ai:v1 -->\n坏标记'
    })
    expect(partitionSource(result).ledger).toBeNull()
    expect(compile(result).index.blocks.filter((block) => block.identity === 'ai')).toHaveLength(3)
    expect(result).toContain('&lt;!-- rgent:ledger:v1 --&gt;')
  })

  it('appends one ledger chapter idempotently and leaves prior ledger intact', () => {
    const before = '正文\r\n<!-- rgent:ledger:v1 -->\r\n## 旧章\r\n旧字\r\n'
    const chapter = {
      taskId,
      startedAt: '2026-09-29T12:00:00.000Z',
      status: 'cancelled' as const,
      prompt: '问',
      answer: '部分回答',
      reason: '用户停止'
    }
    const result = appendLedgerChapter(before, chapter)
    expect(result.startsWith(before)).toBe(true)
    expect(result).toContain('<!-- rgent:ledger-task:v1 id="task-123" -->\r\n')
    expect(result).toContain('部分回答\r\n')
    expect(result).toContain('### 工具摘要\r\n\r\n无工具')
    expect(appendLedgerChapter(result, chapter)).toBe(result)
    expect(partitionSource(result).body).toBe('正文\r\n')
  })

  it('keeps an existing ledger byte-for-byte while streaming CRLF answer blocks', () => {
    const originalLedger = '<!-- rgent:ledger:v1 -->\r\n## 旧章\r\n保留原样。\r\n'
    const source = markPrompt('/问\r\n' + originalLedger, {
      taskId,
      range: { start: 0, end: 2 },
      expectedText: '/问',
      promptText: '问'
    })
    const result = upsertAiAnswer(source, { taskId, answer: '首段\n\n- 下一块' })
    const parts = partitionSource(result)
    expect(parts.ledger).toBe(originalLedger)
    expect(parts.body).toContain('<!-- rgent:ai:v1 task-id="task-123" -->\r\n首段\r\n\r\n')
    expect(parts.body).toContain('<!-- rgent:ai:v1 task-id="task-123" -->\r\n- 下一块')
  })

  it('rejects prompt text that would mark only part of a multi-block command', () => {
    expect(() => markPrompt('/问\n', {
      taskId,
      range: { start: 0, end: 2 },
      expectedText: '/问',
      promptText: '第一段\n\n第二段'
    })).toThrow()
  })

  it('rejects an indented prompt rather than silently dropping its indentation', () => {
    expect(() => markPrompt('  /问\n', {
      taskId,
      range: { start: 2, end: 4 },
      expectedText: '/问',
      promptText: '问'
    })).toThrow()
  })

  it('does not consume a following human paragraph while a streamed code fence is unfinished', () => {
    const source = markPrompt('/问\n\n人写的后文。\n', {
      taskId,
      range: { start: 0, end: 2 },
      expectedText: '/问',
      promptText: '问'
    })
    const partial = upsertAiAnswer(source, { taskId, answer: '```ts\nconst x = 1' })
    expect(compile(partial).index.blocks.at(-1)?.identity).toBeUndefined()
    const updated = upsertAiAnswer(partial, { taskId, answer: '完成。' })
    expect(updated).toContain('人写的后文。')
  })

  it('rejects a duplicated task marker instead of guessing which prompt owns the answer', () => {
    const source = markPrompt('/问\n', {
      taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问'
    })
    const marker = '<!-- rgent:prompt:v1 task-id="task-123" -->'
    expect(() => upsertAiAnswer(`${marker}\n${source}`, { taskId, answer: '回答' })).toThrow('找不到唯一的任务口令')
  })

  it('requires every previously written AI block for a recovery replacement', () => {
    const marked = markPrompt('/问\n', { taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const written = upsertAiAnswer(marked, { taskId, answer: '第一段\n\n第二段' })
    const missing = written.replace('<!-- rgent:ai:v1 task-id="task-123" -->\n第二段', '第二段')
    expect(() => upsertAiAnswer(missing, {
      taskId, answer: '新回答', requiredExistingAnswer: '第一段\n\n第二段'
    })).toThrow('TASK_BLOCK_MISSING')
  })
})

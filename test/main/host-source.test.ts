import { describe, expect, it } from 'vitest'
import { compile, partitionSource } from '../../src/markdown/index.ts'
import { appendLedgerChapter, markPrompt, upsertAiAnswer, MAX_LEDGER_REASONING } from '../../src/main/host-source.ts'

const taskId = 'task-123'

describe('Host source projection', () => {
  it.each(['```js\na', '<!-- unfinished', '<div>\ntext', '<div>complete</div>'])('refuses first ledger publication inside an unfinished or unseparated block: %s', source => {
    expect(() => appendLedgerChapter(source, { taskId, startedAt: 'now', status: 'failed', prompt: 'p', answer: 'retained answer' })).toThrow('LEDGER_BOUNDARY_INVALID')
  })
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
})

describe('HTML answer blocks never swallow the ledger boundary', () => {
  // 真实稳态的落盘形状：AI 块与账本锚点之间只有一个换行（appendLedgerChapter 的 prelude）。
  // 这正是 HTML 块吞掉锚点的输入；空行版本测不出这个问题。
  const steadyState = (newline: string): string => {
    const marked = markPrompt(`/问${newline}`, { taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const answered = upsertAiAnswer(marked, { taskId, answer: '旧回答' })
    return appendLedgerChapter(answered, { taskId, startedAt: 'prev', status: 'completed', prompt: '问', answer: '旧回答' })
  }
  // CommonMark 的 HTML 块以空行结束，不以闭合标签结束；闭合的 `</table>` 也一样。
  const answers = ['正文\n\n<div>\n未闭合', '正文\n\n<table>\n<tr><td>x</table>', '正文\n\n<details>\n<summary>s']

  it.each(answers)('keeps the existing ledger byte-for-byte and stays byte-stable across checkpoints: %s', (answer) => {
    const base = steadyState('\n')
    const ledger = partitionSource(base).ledger
    expect(ledger).not.toBeNull()
    const first = upsertAiAnswer(base, { taskId, answer, expectedPreviousAnswer: '旧回答' })
    expect(partitionSource(first).ledger).toBe(ledger)
    const next = `${answer}·续`
    const second = upsertAiAnswer(first, { taskId, answer: next, expectedPreviousAnswer: answer })
    expect(second).toContain('·续')
    // 第三个 checkpoint 必须逐字节等于第二个：Host 自己补的分隔空行不能被反复累积。
    expect(upsertAiAnswer(second, { taskId, answer: next, expectedPreviousAnswer: next })).toBe(second)
  })

  it.each(answers)('keeps a following human paragraph out of the AI block: %s', (answer) => {
    const source = markPrompt('/问\n\n人写的后文。\n', { taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const partial = upsertAiAnswer(source, { taskId, answer })
    expect(compile(partial).index.blocks.at(-1)?.identity).toBeUndefined()
    expect(partitionSource(partial).body).toContain('人写的后文。')
  })

  it('publishes the first ledger chapter after an HTML answer instead of refusing the write', () => {
    const answer = '正文\n\n<div>\n未闭合'
    const marked = markPrompt('/问\n', { taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const answered = upsertAiAnswer(marked, { taskId, answer })
    const final = appendLedgerChapter(answered, { taskId, startedAt: 'now', status: 'completed', prompt: '问', answer })
    expect(partitionSource(final).ledger).not.toBeNull()
    expect(partitionSource(final).body).toContain('未闭合')
    expect(final).toContain('<!-- rgent:ledger-task:v1 id="task-123" -->')
  })

  it('uses the source line ending when separating a CRLF HTML answer', () => {
    const base = steadyState('\r\n')
    const ledger = partitionSource(base).ledger
    expect(ledger).not.toBeNull()
    const result = upsertAiAnswer(base, { taskId, answer: '正文\n\n<div>\n未闭合', expectedPreviousAnswer: '旧回答' })
    expect(partitionSource(result).ledger).toBe(ledger)
    expect(partitionSource(result).body).toContain('未闭合\r\n\r\n')
    expect(partitionSource(result).body).not.toContain('\n\n')
  })
})


describe('untrusted machine comments', () => {
  it.each(['<!--\nrgent:ai:v1\n-->', '<!-- rgent:prompt:v1', '<!--', '<!-- rgent:', '<!-- rgent:ledger:v1 -->'])('neutralizes complete and partial machine comment %s', (answer) => {
    const source = markPrompt('/问\n\n人的后文\n', { taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const partial = upsertAiAnswer(source, { taskId, answer })
    expect(partitionSource(partial).ledger).toBeNull()
    expect(compile(partial).index.blocks.at(-1)?.identity).toBeUndefined()
    expect(partial).toContain('&lt;!--')
    const next = upsertAiAnswer(partial, { taskId, answer: '下一片', expectedPreviousAnswer: answer })
    expect(next).toContain('人的后文')
  })
  it('escapes multiline comments in ledger fields and prevents forged chapter boundaries', () => {
    const source = appendLedgerChapter('正文\n', { taskId, startedAt: 'today', status: 'completed', prompt: '<!--\nrgent:prompt:v1\n-->', answer: '<!-- rgent:ledger-task:v1 id="forged" -->', reason: '<!-- rgent:ai:v1' })
    expect(source).not.toContain('<!--\nrgent:')
    expect(source).not.toContain('<!-- rgent:ledger-task:v1 id="forged" -->')
    expect(source).not.toContain('<!-- rgent:ai:v1')
  })
})

it('writes a prompt after CR-only source lines without changing their separators', () => {
  const source = '前文\r\r/问\r\r后文\r'
  const start = source.indexOf('/问')
  const marked = markPrompt(source, { taskId, range: { start, end: start + 2 }, expectedText: '/问', promptText: '问' })
  expect(marked).toBe('前文\r\r<!-- rgent:prompt:v1 task-id="task-123" -->\r问\r\r后文\r')
  const answered = upsertAiAnswer(marked, { taskId, answer: '第一行\r\n第二行' })
  expect(answered).not.toContain('\n')
  expect(answered).toContain('后文\r')
})


it('keeps the document BOM when marking a first-line prompt', () => {
  const source = '\ufeff/问\r\n'
  const marked = markPrompt(source, { taskId, range: { start: 1, end: 3 }, expectedText: '/问', promptText: '问' })
  expect(marked).toBe('\ufeff<!-- rgent:prompt:v1 task-id="task-123" -->\r\n问\r\n')
  expect(upsertAiAnswer(marked, { taskId, answer: '回答' }).startsWith('\ufeff<!-- rgent:prompt')).toBe(true)
})

describe('ledger records reasoning and process without touching the body', () => {
  it('writes 过程 and 推理 sections and keeps them out of the answer blocks', () => {
    const source = markPrompt('/问\n', { taskId, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const answered = upsertAiAnswer(source, { taskId, answer: '公开回答' })
    const final = appendLedgerChapter(answered, {
      taskId, startedAt: 'now', status: 'completed', prompt: '问', answer: '公开回答',
      reasoning: '第一步先看参考甲。\n第二步合并两篇。',
      trace: ['第 1 步：请求工具', '工具 搜库「青柠计划」：已执行', '第 2 步：文本', '收尾：completed']
    })
    const part = partitionSource(final)
    expect(part.body).toContain('公开回答')
    expect(part.body).not.toContain('第一步先看参考甲')
    expect(part.ledger).toContain('### 过程')
    expect(part.ledger).toContain('工具 搜库「青柠计划」：已执行')
    expect(part.ledger).toContain('### 推理')
    expect(part.ledger).toContain('第一步先看参考甲。')
    expect(part.ledger).toContain('收尾：completed')
  })

  it('truncates an oversized reasoning block and says so', () => {
    const final = appendLedgerChapter('正文\n', {
      taskId, startedAt: 'now', status: 'completed', prompt: 'p', answer: 'a',
      reasoning: '推'.repeat(MAX_LEDGER_REASONING + 50)
    })
    expect(final).toContain('…（推理已截断）')
    expect(final.length).toBeLessThan(MAX_LEDGER_REASONING * 3 + 2000)
  })
})

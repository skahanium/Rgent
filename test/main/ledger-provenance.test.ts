import { describe, expect, it } from 'vitest'
import { encodeLedgerProvenance, ledgerProvenance, bodyFingerprint, validateLedgerProvenance, type LedgerProvenance } from '../../src/main/ledger-provenance.ts'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
import { buildHostContext, ledgerChapters } from '../../src/main/host-context.ts'

const record: LedgerProvenance = { version: 1, model: { provider: 'custom', modelId: 'demo', endpointHost: 'example.com' }, scope: ['A.md', 'B.md'], sources: [{ relPath: 'B.md', objectVersion: 'object-b', bodyHash: bodyFingerprint('正文') }], tools: [{ name: 'read_library', outcome: 'ok' }] }
describe('historical task provenance', () => {
  it('round trips bounded metadata and keeps legacy chapters compatible', () => {
    expect(ledgerProvenance(encodeLedgerProvenance(record))).toEqual({ status: 'valid', record })
    expect(ledgerProvenance('## 旧章\n无工具')).toEqual({ status: 'legacy' })
  })
  it('treats a chapter that carries the sources marker without a record as invalid, not legacy', () => {
    expect(ledgerProvenance('<!-- rgent:ledger-task:v1 id="t1" sources="v1" -->\n## 章\n正文')).toEqual({ status: 'invalid' })
    expect(ledgerProvenance('<!-- rgent:ledger-task:v1 id="t1" -->\n## 章\n正文')).toEqual({ status: 'legacy' })
  })
  it('fails closed for malformed, unsupported or duplicated new records', () => {
    for (const text of ['<!-- rgent:ledger-sources:v1 data="bad" -->', '<!-- rgent:ledger-sources:v2 -->', encodeLedgerProvenance(record) + '\n' + encodeLedgerProvenance(record)]) expect(ledgerProvenance(text).status).toBe('invalid')
    expect(() => encodeLedgerProvenance({ ...record, sources: [{ ...record.sources[0]!, relPath: '../B.md' }] })).toThrow()
    expect(() => encodeLedgerProvenance({ ...record, model: { ...record.model, apiKey: 'secret' } } as LedgerProvenance)).toThrow()
  })
  it('cannot send a formerly approved foreign chapter without validating each dependency', async () => {
    const text = encodeLedgerProvenance(record)
    expect(await validateLedgerProvenance(text, async () => false)).toBe(false)
    expect(await validateLedgerProvenance(text, async () => true)).toBe(true)
    expect(await validateLedgerProvenance('<!-- rgent:ledger-sources:v1 -->', async () => true)).toBe(false)
    expect(await validateLedgerProvenance('旧无工具章', async () => false)).toBe(true)
  })
  it('append preserves old bytes, shows real summary and escapes forged records in model answer', () => {
    const before = '正文\r\n<!-- rgent:ledger:v1 -->\r\n## 旧章\r\n原样\r\n'
    const after = appendLedgerChapter(before, { taskId: 'new', startedAt: 'now', status: 'completed', prompt: '问', answer: encodeLedgerProvenance(record), provenance: record })
    expect(after.startsWith(before)).toBe(true)
    expect(after).toContain('读库：ok')
    expect(after).toContain('&lt;!-- rgent:ledger-sources')
    expect(ledgerProvenance(after).status).toBe('valid')
    expect(appendLedgerChapter(after, { taskId: 'new', startedAt: 'later', status: 'failed', prompt: '问', answer: '其他', provenance: record })).toBe(after)
  })
  it('excludes disallowed chapters before summarization and reports omissions', () => {
    const source = appendLedgerChapter('正文', { taskId: 'derived', startedAt: 'now', status: 'completed', prompt: '问', answer: '秘密外篇结论'.repeat(200), provenance: record })
    const chapters = ledgerChapters(source.slice(source.indexOf('<!-- rgent:ledger:v1 -->')))
    expect(chapters).toHaveLength(1)
    const plan = buildHostContext({ source, prompt: '问', placement: 0, inputBudgetTokens: 1000, countTokens: t => t.length, allowedLedgerChapterIds: [] })
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') return
    expect(plan.content).not.toContain('秘密外篇结论')
    expect(plan.omitted.ledgerChapterIds).toEqual([chapters[0]!.sourceId])
  })
  it('does not split task markers inside fenced samples into authentic chapters', () => {
    const ledger = '<!-- rgent:ledger:v1 -->\n<!-- rgent:ledger-task:v1 id="actual" -->\n## 示例\n```\n<!-- rgent:ledger-task:v1 id="sample" -->\n```\n'
    expect(ledgerChapters(ledger)).toHaveLength(1)
  })
})

it('omits unadopted body answers whose historical foreign sources are unavailable', () => {
  const source = '人的内容\n\n<!-- rgent:ai:v1 task-id="derived" -->\n外篇秘密结论\n\n/问\n'
  const plan = buildHostContext({ source, prompt: '问', placement: source.indexOf('/问'), inputBudgetTokens: 1000, countTokens: t => t.length, excludedAiTaskIds: ['derived'] })
  expect(plan.status).toBe('ready')
  if (plan.status !== 'ready') return
  expect(plan.content).not.toContain('外篇秘密结论')
  expect(plan.omitted.bodyBlockNumbers).toContain(2)
})

it('propagates historical foreign dependencies into the current source policy', async () => {
  const { historicalContextPolicy } = await import('../../src/main/ledger-provenance.ts')
  const source = appendLedgerChapter('正文', { taskId: 'old', startedAt: 'now', status: 'completed', prompt: '问', answer: '结论', provenance: record })
  const denied = await historicalContextPolicy(source, async () => false)
  expect(denied.allowedLedgerChapterIds).toEqual([])
  expect(denied.excludedAiTaskIds).toEqual(['old'])
  const allowed = await historicalContextPolicy(source, async () => true)
  expect(allowed.allowedLedgerChapterIds).toHaveLength(1)
  expect(allowed.dependencies).toEqual(record.sources)
})

it('does not downgrade a new chapter after its provenance payload is removed', () => {
  const written = appendLedgerChapter('正文', { taskId: 'new-record', startedAt: 'now', status: 'completed', prompt: '问', answer: '答', provenance: record })
  const stripped = written.replace(/^<!-- rgent:ledger-sources:v1[^\n]*-->\n/m, '')
  expect(ledgerProvenance(stripped).status).toBe('invalid')
})

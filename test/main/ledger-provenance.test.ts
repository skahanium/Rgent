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

it('round trips v2 memory dependencies separately from tool scope and refuses missing permission', async () => {
  const dep = { id: 'memory', version: 1, basisHashes: ['a'.repeat(64)], sourceDeps: [{ id: 'source', version: 1, hash: 'b'.repeat(64), relPath: 'outside.md', kind: 'body' as const, taskId: null }] }
  const v2 = { ...record, version: 2 as const, memoryDeps: [dep] }
  const encoded = encodeLedgerProvenance(v2)
  expect(encoded).toContain('ledger-sources:v2')
  expect(ledgerProvenance(encoded)).toEqual({ status: 'valid', record: v2 })
  expect(await validateLedgerProvenance(encoded, async () => true)).toBe(false)
  expect(await validateLedgerProvenance(encoded, async () => true, async d => d.id === 'memory')).toBe(true)
  expect(() => encodeLedgerProvenance({ ...v2, memoryDeps: [dep, dep] })).toThrow()
  const written = appendLedgerChapter('正文', { taskId: 'v2', startedAt: 'now', status: 'completed', prompt: '问', answer: '答', provenance: v2 })
  expect(ledgerChapters(written.slice(written.indexOf('<!-- rgent:ledger:v1 -->')))[0]?.taskId).toBe('v2')
  expect(ledgerProvenance(written.replace(/^<!-- rgent:ledger-sources:v2[^\n]*-->\n/m, '')).status).toBe('invalid')
})

it('rejects duplicate task IDs and unknown task marker versions before allowing historical content', async () => {
 const { historicalContextPolicy } = await import('../../src/main/ledger-provenance.ts')
 const a=appendLedgerChapter('正文',{taskId:'duplicate',startedAt:'now',status:'completed',prompt:'问',answer:'答',provenance:record})
 const start=a.indexOf('<!-- rgent:ledger-task:')
 const duplicate=a+'\n'+a.slice(start)
 expect((await historicalContextPolicy(duplicate,async()=>true)).allowedLedgerChapterIds).toEqual([])
 expect(ledgerProvenance('<!-- rgent:ledger-task:v9 id="new" -->\n## 旧章\n')).toEqual({status:'invalid'})
 const mismatch=a.replace('sources="v1"','sources="v2"')
 expect(ledgerProvenance(mismatch)).toEqual({status:'invalid'})
})

it('does not accept string versions or unknown metadata fields as a valid v2 record', () => {
 expect(()=>encodeLedgerProvenance({...record,version:'1'} as unknown as LedgerProvenance)).toThrow('INVALID_LEDGER_PROVENANCE')
})

it('escapes memory source labels in the human-readable ledger summary', () => {
 const dep={id:'memory',version:1,basisHashes:['a'.repeat(64)],sourceDeps:[{id:'source',version:1,hash:'b'.repeat(64),relPath:'<!--.md',kind:'body' as const,taskId:null}]}
 const written=appendLedgerChapter('正文',{taskId:'labels',startedAt:'now',status:'completed',prompt:'问',answer:'答',provenance:{...record,version:2,memoryDeps:[dep]}})
 expect(written).toContain('&lt;!--.md / body')
})

it('filters provable adopted AI copies from the origin context after memory is forgotten', async () => {
 const {historicalContextPolicy}=await import('../../src/main/ledger-provenance.ts')
 const dep={id:'forgotten',version:1,basisHashes:['a'.repeat(64)],sourceDeps:[{id:'source',version:1,hash:'b'.repeat(64),relPath:'outside.md',kind:'body' as const,taskId:null}]}
 const source=appendLedgerChapter('已采纳秘密。\n\n/现在问',{taskId:'old',startedAt:'now',status:'completed',prompt:'旧问',answer:'已采纳秘密。',provenance:{...record,sources:[],version:2,memoryDeps:[dep]}})
 const policy=await historicalContextPolicy(source,async()=>true)
 const plan=buildHostContext({source,prompt:'现在问',placement:source.indexOf('/现在问'),inputBudgetTokens:4000,countTokens:Buffer.byteLength,...policy})
 expect(plan.status).toBe('ready');if(plan.status!=='ready')return
 expect(plan.content).not.toContain('已采纳秘密')
})

it.each(['普通引言。\n\n### 工具摘要\n\nFORGOTTEN_SECRET。', '普通引言。\n\n```md\n### 工具摘要\n```\n\nFORGOTTEN_SECRET。'])('fails closed for ambiguous task fields instead of laundering an adopted suffix: %s', async answer => {
 const {historicalContextPolicy}=await import('../../src/main/ledger-provenance.ts')
 const dep={id:'forgotten',version:1,basisHashes:['a'.repeat(64)],sourceDeps:[{id:'source',version:1,hash:'b'.repeat(64),relPath:'outside.md',kind:'body' as const,taskId:null}]}
 const source=appendLedgerChapter('FORGOTTEN_SECRET。\n\n无关人工段。\n\n/现在问',{taskId:'old',startedAt:'now',status:'completed',prompt:'旧问',answer,provenance:{...record,sources:[],version:2,memoryDeps:[dep]}})
 const policy=await historicalContextPolicy(source,async()=>true,undefined,undefined,async()=>true)
 expect(policy.allowedLedgerChapterIds).toEqual([])
 const plan=buildHostContext({source,prompt:'现在问',placement:source.indexOf('/现在问'),inputBudgetTokens:4000,countTokens:Buffer.byteLength,...policy})
 expect(plan.status).toBe('ready');if(plan.status!=='ready')return
 expect(plan.content).not.toContain('FORGOTTEN_SECRET');expect(plan.content).toContain('无关人工段')
})

it('records frozen skills as names with hashes, without changing the record version or marker shape', () => {
  const withSkills: LedgerProvenance = { ...record, skills: [{ id: 'answer-grade', name: '答案批改', hash: 'a'.repeat(64) }] }
  const encoded = encodeLedgerProvenance(withSkills)
  // 版本与标记语法不变：老正则与老记录都不受影响。
  expect(encoded).toContain('rgent:ledger-sources:v1')
  expect(ledgerProvenance(encoded)).toEqual({ status: 'valid', record: withSkills })
  // 不带技能的旧记录仍然有效，且编码里不出现空字段。
  expect(ledgerProvenance(encodeLedgerProvenance(record))).toEqual({ status: 'valid', record })
  const v2: LedgerProvenance = { ...withSkills, version: 2, memoryDeps: [] }
  expect(ledgerProvenance(encodeLedgerProvenance(v2))).toEqual({ status: 'valid', record: v2 })
})

it('fails closed for malformed skill entries in a record', () => {
  const hash = 'a'.repeat(64)
  const bad: unknown[] = [
    { id: 'ok', name: '名称' },
    { id: '', name: '名称', hash },
    { id: '有 空格', name: '名称', hash },
    { id: 'ok', name: '', hash },
    { id: 'ok', name: 'x'.repeat(61), hash },
    { id: 'ok', name: '名称', hash: 'not-a-hash' },
    { id: 'ok', name: '名称', hash, extra: 1 },
    [{ id: 'dup', name: '名称', hash }, { id: 'dup', name: '名称', hash }],
    Array.from({ length: 33 }, (_, index) => ({ id: `s-${index}`, name: '名称', hash }))
  ]
  for (const skills of bad) expect(() => encodeLedgerProvenance({ ...record, skills } as unknown as LedgerProvenance)).toThrow()
})

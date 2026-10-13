import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildCards, convertAnswers } from '../../scripts/memory-review-pack.mjs'

// 包 C：全卷人工复核包。出题纪律来自首版失败教训（test/fixtures/v6-outcome-review.json 的 protocolFlaws）：
// 给中文重述、给终态、**不给试卷期望也不给 Agent 判定**，人只答自己的判断。

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rgent-review-pack-'))
  dirs.push(dir)
  const row = (key: string, id: string, prompt: string, units: number, entries: unknown[], receipt: Record<string, unknown>) => ({
    key, model: 'deepseek-flash', round: 0, frozenHash: 'frozen-1', status: 'completed',
    case: { id, prompt, body: '【虚构质量夹具】材料正文。', expected: { units: Array.from({ length: units }, (_, at) => ({ at })) } },
    responses: [{ phase: 'proposal', body: '{}' }],
    result: { recent: [], entries, receipt: { outcome: 'applied', ...receipt } }
  })
  writeFileSync(path.join(dir, 'result-aaa.json'), JSON.stringify(row('k-a', 'v6-a', '以后用中文', 2, [{ semantic: 'standing', scope: '本库', content: '后续使用中文' }], {})))
  writeFileSync(path.join(dir, 'result-bbb.json'), JSON.stringify(row('k-b', 'v6-b', 'Same preference as before', 1, [], { reason: 'MEMORY_OUTPUT_INVALID' })))
  // 只有 A 有主标注（B 是补录行），A 另有一份双标。
  writeFileSync(path.join(dir, 'annotation-111.json'), JSON.stringify({ key: 'k-a', review: { rulesHash: 'rules-1', resultHash: 'result-a', frozenHash: 'frozen-1', rubricVersion: 1 } }))
  writeFileSync(path.join(dir, 'annotation2-222.json'), JSON.stringify({ key: 'k-a', review: { rulesHash: 'rules-1', resultHash: 'result-a', frozenHash: 'frozen-1', rubricVersion: 1 } }))
  return dir
}

it('卡片只给材料与终态，不给试卷期望也不给 Agent 判定', () => {
  const dir = fixture()
  const cards = buildCards(dir, { 'v6-b': '同一条偏好之前提过：以后用通俗英文解释。' })
  expect(cards).toHaveLength(2)
  const a = cards.find(card => card.key === 'k-a')!
  const b = cards.find(card => card.key === 'k-b')!
  expect(a.stored).toEqual([{ semantic: 'standing', scope: '本库', content: '后续使用中文' }])
  expect(a.annotated).toBe(true)
  expect(b.storedNothing).toBe(true)
  expect(b.annotated).toBe(false)
  // 英文材料行必须有中文重述，否则不出题。
  expect(b.chineseMaterial).toBe(false)
  expect(b.gloss).toContain('通俗英文')
  const text = JSON.stringify(cards)
  expect(text).not.toContain('expected')
  expect(text).not.toContain('rulesHash')
  expect(text).not.toContain('"review"')
})

it('答案按映射变成机读计数，人工判词原样保留', () => {
  const dir = fixture()
  const { converted, skipped } = convertAnswers(dir, { rows: [
    { key: 'k-a', acceptable: 'yes', missing: '', shouldNot: '', note: '这条记得对' },
    { key: 'k-b', acceptable: 'no', missing: '漏了长期偏好\n漏了归属', shouldNot: '不该留助手草案', note: '' }
  ] })
  // 补录行（没有主标注，借不到 resultsHash/rulesHash）不能自动转换：判词留在答案文件里，单独说明。
  expect(skipped).toEqual([{ key: 'k-b', why: '没有该行的标注绑定' }])
  expect(converted).toHaveLength(1)
  const a = converted[0]!
  expect(a.review.correct).toBe(2); expect(a.review.omitted).toBe(0); expect(a.review.wrongNew).toBe(0)
  expect(a.review.annotator).toEqual({ identity: 'owner-human', kind: 'human', participatedInDesign: false, modelNameMasked: true, humanReviewed: true })
  expect(a.review.humanVerdict).toEqual({ acceptable: 'yes', missing: '', shouldNot: '', note: '这条记得对' })
  expect(a.review.rulesHash).toBe('rules-1')
})

it('没有主标注的行不能转换（它没有可用绑定），看不懂的行也不算已复核', () => {
  const dir = fixture()
  const { converted, skipped } = convertAnswers(dir, { rows: [
    { key: 'k-b', acceptable: 'yes', missing: '', shouldNot: '', note: '' },
    { key: 'k-a', acceptable: 'unsure', missing: '', shouldNot: '', note: '读不懂' }
  ] })
  expect(converted).toEqual([])
  expect(skipped.map(item => item.key)).toEqual(['k-b', 'k-a'])
  expect(skipped[0]!.why).toContain('标注绑定')
  expect(skipped[1]!.why).toContain('看不懂')
})

it('单元数为 2 而人列了 2 条遗漏时，正确数不会变成负数', () => {
  const dir = fixture()
  const { converted } = convertAnswers(dir, { rows: [{ key: 'k-a', acceptable: 'no', missing: '甲\n乙\n丙', shouldNot: '', note: '' }] })
  expect(converted[0]!.review.omitted).toBe(2)
  expect(converted[0]!.review.correct).toBe(0)
})

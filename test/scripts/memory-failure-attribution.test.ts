import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import humanExam from '../fixtures/v6-human-exam-answers.json'
import { V6_RULES, V6_SCORING_CATEGORIES } from '../../scripts/memory-quality-support.ts'
import { workStateShaped } from '../../src/main/working-memory-consolidation.ts'
import { V6_QUALITY_CASES } from '../fixtures/v6-memory-quality.ts'
// @ts-ignore 审计脚本为 .mjs：可被 node 直接运行，不参与 tsc 类型检查
import * as audit from '../../scripts/memory-failure-attribution.mjs'

const root = process.cwd()
const runDir = (dir: string) => join(root, dir)
const present = audit.RUNS.every((run: { dir: string }) => existsSync(runDir(run.dir)))

it('keeps the environment and scoring vocabulary identical to the frozen harness rules', () => {
  expect(audit.ENVIRONMENT_CATEGORIES).toEqual([...V6_RULES.reliability.environmentCategories])
  expect(audit.ENVIRONMENT_REASONS).toEqual([...V6_RULES.reliability.environmentReasons])
  expect(audit.CLASSIFICATION_HAIRCUT).toBe(V6_RULES.scoring.classificationHaircut)
  expect(audit.SCORING_CATEGORIES).toEqual([...V6_SCORING_CATEGORIES])
  expect(audit.VETOES).toEqual([...V6_RULES.vetoes])
})

it('keeps the case weights, dimensions, expected action and container identical to the frozen paper', () => {
  // expectedAction 分两层：CASE_SPECS 存历史（revision 10）用于归类冻结产物；revision 11 视图由
  // PAPER_REV11_ACTIONS 覆盖，两者都必须与现夹具对得上。
  const expected = Object.fromEntries(
    V6_QUALITY_CASES.map((spec) => [
      spec.id,
      {
        dimension: spec.direction,
        weight: spec.weight,
        expectedContainer: spec.expected.targetCategory ?? (spec.direction === 'recent' ? 'recent' : 'entry'),
        ...(spec.split ? { split: spec.split } : {}),
        ...(spec.safety ? { safety: spec.safety } : {})
      }
    ])
  )
  const withoutAction = Object.fromEntries(Object.entries(audit.CASE_SPECS).map(([id, spec]: [string, any]) => {
    const { expectedAction, ...rest } = spec
    return [id, rest]
  }))
  expect(withoutAction).toEqual(expected)
  for (const spec of V6_QUALITY_CASES) {
    const rev11 = audit.PAPER_REV11_ACTIONS[spec.id] ?? audit.CASE_SPECS[spec.id].expectedAction
    expect(rev11).toBe(spec.expected.action)
  }
  // 历史归类按 revision 10 的机读期望；revision 11 只改这两例。
  expect(Object.keys(audit.PAPER_REV11_ACTIONS)).toEqual(['v6-ambiguous-10', 'v6-chain-beta-4'])
  for (const id of Object.keys(audit.PAPER_REV11_ACTIONS)) expect(audit.CASE_SPECS[id].expectedAction).toBe('conflict')
})

it('labels every human-reviewed case with a real paper case id and a known verdict', () => {
  const ids = new Set(V6_QUALITY_CASES.map((spec) => spec.id))
  const verdicts = new Set(['expectation-reasonable', 'rubric-field-false-negative', 'label-debt', 'real-gap', 'framework-mismatch'])
  const entries = Object.entries(audit.HUMAN_REVIEW)
  expect(entries).toHaveLength(10)
  for (const [id, review] of entries as [string, { verdict: string; containerReliable: boolean }][]) {
    expect(ids.has(id)).toBe(true)
    expect(verdicts.has(review.verdict)).toBe(true)
    expect(typeof review.containerReliable).toBe('boolean')
  }
})

it('scores a single case with the current rubric: veto and forbidden content hard-zero, classification halves', () => {
  const base = { correct: 2, omitted: 0, wrongNew: 0, hardViolations: [], evidenceComplete: true, checks: { attributionAndScope: true, noUnsupportedContent: true, noForbiddenContent: true } }
  expect(audit.caseScore(base)).toBe(1)
  expect(audit.caseScore({ ...base, checks: { ...base.checks, attributionAndScope: false } })).toBe(0.5)
  expect(audit.caseScore({ ...base, checks: { ...base.checks, noForbiddenContent: false } })).toBe(0)
  expect(audit.caseScore({ ...base, checks: { ...base.checks, noUnsupportedContent: false } })).toBe(0)
  expect(audit.caseScore({ ...base, hardViolations: ['ambiguous-overwrite'] })).toBe(0)
  expect(audit.caseScore({ ...base, evidenceComplete: false })).toBeNull()
  expect(audit.caseScore({ ...base, correct: 1, omitted: 1 })).toBeCloseTo(2 / 3, 6)
})

it('classifies every audit bucket from mechanical signals only', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    environment: false,
    programRuleBlocked: false,
    actionVerified: true,
    expectedAction: 'add',
    expectedContainer: 'entry',
    entryActionLanded: true,
    category: 'valid',
    rejectedGroups: [] as string[],
    failureOrigin: null,
    lost: 0,
    primary: { present: true, correct: 1, omitted: 0, wrongNew: 0, checks: { attributionAndScope: true, noUnsupportedContent: true, noForbiddenContent: true }, hardViolations: [] },
    ...over
  })
  expect(audit.classifyCase(row({ environment: true })).class).toBe('environment')
  expect(audit.classifyCase(row({ primary: { ...row().primary, hardViolations: ['temporary-standing'] } })).class).toBe('veto')
  expect(audit.classifyCase(row({ programRuleBlocked: true }))).toMatchObject({ class: 'mechanism-blocked', sub: 'program-rule' })
  // rubric 说"保留旧活动事实…均可"，机读字段却要 conflict：无 entry 动作即确认假阴性
  expect(audit.classifyCase(row({ expectedAction: 'conflict', entryActionLanded: false, lost: 2.5 }))).toMatchObject({ class: 'mechanism-blocked', sub: 'rubric-field' })
  // 期望 entry 的内容只落在近期块：真实缺口，不算机制冤枉
  expect(audit.classifyCase(row({ expectedAction: 'add', expectedContainer: 'entry', entryActionLanded: false, lost: 4 }))).toMatchObject({ class: 'content-gap', sub: 'wrong-container' })
  // 期望本来就是近期块：只有 recent 落地属正常，不判缺口
  expect(audit.classifyCase(row({ expectedAction: 'add', expectedContainer: 'recent', entryActionLanded: false, lost: 0 })).class).toBe('clean')
  expect(audit.classifyCase(row({ actionVerified: false, lost: 1 }))).toMatchObject({ class: 'mechanism-blocked', sub: 'convention', detail: 'action-verb' })
  expect(audit.classifyCase(row({ primary: { ...row().primary, checks: { attributionAndScope: false, noUnsupportedContent: true, noForbiddenContent: true } }, lost: 2 }))).toMatchObject({ class: 'mechanism-blocked', sub: 'convention', detail: 'category' })
  expect(audit.classifyCase(row({ primary: { ...row().primary, correct: 0, omitted: 1 }, entryActionLanded: false, lost: 4 })).class).toBe('content-gap')
  expect(audit.classifyCase(row()).class).toBe('clean')
})

it('treats a receipt-only environment reason as an environment row', () => {
  expect(audit.isEnvironment({ category: 'valid', receiptReason: 'MEMORY_DEADLINE' })).toBe(true)
  expect(audit.isEnvironment({ category: 'service', receiptReason: null })).toBe(true)
  expect(audit.isEnvironment({ category: 'valid', receiptReason: null })).toBe(false)
})

it.skipIf(!present)('reproduces the frozen r13 lower bound and separates confirmed false negatives from real gaps', () => {
  const rows = audit.RUNS.flatMap((run: { dir: string; label: string; scoring: string }) => audit.collectRun(run))
  expect(rows.length).toBe(229)
  const r13 = rows.filter((row: any) => row.run === 'r13' && row.model === 'deepseek-flash' && row.round === 0)
  expect(r13.length).toBe(30)
  expect(audit.projectRound(r13, 'none').total).toBe(79.17)
  expect(audit.projectRound(r13, 'program-rule').total).toBe(89.17)
  expect(audit.projectRound(r13, 'false-negative').total).toBe(92.67)
  expect(audit.projectRound(r13, 'none').floorPass).toBe(false)
  expect(audit.projectRound(r13, 'false-negative').floorPass).toBe(true)
  const correction = r13.find((row: any) => row.caseId === 'v6-correction-01')
  expect(correction).toMatchObject({ class: 'mechanism-blocked', sub: 'program-rule', failureOrigin: 'admission', actionVerified: false })
  expect(correction.rejectedGroups).toContain('MEMORY_DEPENDENCY_CHANGED')
  // 人工过卷确认的三处真实缺口：期望 entry 的内容只落在近期块
  const wrongContainer = rows.filter((row: any) => row.class === 'content-gap' && row.sub === 'wrong-container')
  expect(wrongContainer.map((row: any) => row.caseId).sort()).toEqual(['v6-attribution-01', 'v6-chain-alpha-2', 'v6-chain-alpha-2', 'v6-chain-beta-2', 'v6-chain-beta-2', 'v6-recent-blocked-01'])
  expect(wrongContainer.reduce((n: number, row: any) => n + row.lost, 0)).toBeCloseTo(9.5, 6)
  // rubric 与机读字段冲突：conflict 期望、无 entry 动作；其案例必须正是人工过卷判为假阴性者
  const rubricField = rows.filter((row: any) => row.sub === 'rubric-field')
  expect(rubricField.every((row: any) => row.expectedAction === 'conflict')).toBe(true)
  expect(rubricField.every((row: any) => row.entryActionLanded === false)).toBe(true)
  expect([...new Set(rubricField.map((row: any) => audit.HUMAN_REVIEW[row.caseId]?.verdict))]).toEqual(['rubric-field-false-negative'])
  expect(rubricField.reduce((n: number, row: any) => n + row.lost, 0)).toBeCloseTo(11, 6)
  // 容器判据的两侧都必须与人工过卷一致：wrong-container 全是 real-gap，convention 全是「已落地但动词/标签不符」
  // 容器类里经过卷的例子必须是 real-gap；chain-beta-2 未过卷，允许无判定但不能有相反判定。
  // 经过卷的容器类例子都判该失分成立（real-gap 或 expectation-reasonable）；chain-beta-2 未过卷。
  const containerVerdicts = [...new Set(wrongContainer.map((row: any) => audit.HUMAN_REVIEW[row.caseId]?.verdict).filter(Boolean))]
  expect(containerVerdicts.sort()).toEqual(['expectation-reasonable', 'real-gap'])
  expect(wrongContainer.filter((row: any) => audit.HUMAN_REVIEW[row.caseId]?.verdict === 'real-gap').map((row: any) => row.caseId).sort()).toEqual(['v6-attribution-01', 'v6-chain-alpha-2', 'v6-chain-alpha-2'])
  const convention = rows.filter((row: any) => row.sub === 'convention')
  expect(convention).toHaveLength(0)
  // 标签类与新增真错类必须与人工过卷逐例定性一致（见 docs/memory.md 的归属表）。
  const misfire = rows.filter((row: any) => row.sub === 'instrument-misfire')
  expect(misfire.map((row: any) => row.caseId)).toEqual(['v6-scope-01', 'v6-scope-01', 'v6-scope-01'])
  expect(misfire.reduce((n: number, row: any) => n + row.lost, 0)).toBeCloseTo(6, 6)
  expect(rows.filter((row: any) => row.sub === 'type-label').map((row: any) => row.caseId).sort()).toEqual(['v6-fact-01', 'v6-scope-01'])
  expect(rows.filter((row: any) => row.sub === 'active-fact').map((row: any) => row.caseId).sort()).toEqual(['v6-ambiguous-01', 'v6-ambiguous-10', 'v6-ambiguous-10', 'v6-chain-beta-4'])
  expect(rows.filter((row: any) => row.sub === 'repair-not-applied').map((row: any) => row.caseId)).toEqual(['v6-correction-01'])
  expect(audit.projectRound(r13, 'paper-11').total).toBe(94.67)
})

it.skipIf(!present)('renders a byte-stable report', () => {
  const rows = audit.RUNS.flatMap((run: { dir: string; label: string; scoring: string }) => audit.collectRun(run))
  const first = audit.renderMarkdown(rows, { generatedAt: 'fixed' })
  const second = audit.renderMarkdown(rows, { generatedAt: 'fixed' })
  expect(first).toBe(second)
  expect(first).toContain('假阴性清单')
  expect(first).toContain('不是认证成绩')
  expect(first).toContain('人工过卷')
})

it('surfaces a routing rejection as a program-side rule so the audit reviews it, never hides it', () => {
  // 程序按合同拒绝的码一律进这一族：将来若路由判据拦掉了试卷期望的长期内容，它会以「确认假阴性（程序规则）」
  // 出现在清单里等人工过卷，而不是安静地算成模型失分。
  expect(audit.PROGRAM_RULE_CODES).toContain('MEMORY_ROUTED_TO_RECENT')
  expect(audit.PROGRAM_RULE_CODES).toContain('MEMORY_TEMPORARY_STANDING')
})

it.skipIf(!present)('reproduces the corpus calibration behind the work-state routing rule', () => {
  // 判据的标定基线：229 条冻结产物、115 条 add 提议。命中必须全部是不该落成长期条目的提议，
  // 且每条命中所在响应都另有非空近期块（拒绝不丢信息）。数字变了就说明判据或语料变了，必须重新论证。
  const container = (id: string) => {
    const spec = V6_QUALITY_CASES.find((item) => item.id === id)!
    return spec.expected.targetCategory ?? (spec.direction === 'recent' ? 'recent' : 'entry')
  }
  let adds = 0
  const hits: { caseId: string; container: string; carriedByRecent: boolean }[] = []
  for (const run of audit.RUNS as { dir: string }[]) {
    for (const name of readdirSync(run.dir).filter((entry) => entry.startsWith('result-'))) {
      const record = JSON.parse(readFileSync(join(run.dir, name), 'utf8'))
      const caseId = String(record.key ?? '').split('/').pop() ?? ''
      for (const response of record.responses ?? []) {
        const raw = String(response?.body ?? '').trim().replace(/^```json\s*/, '').replace(/\s*```$/, '')
        if (!raw) continue
        let parsed: any
        try { parsed = JSON.parse(raw) } catch { continue }
        if (!parsed || typeof parsed !== 'object') continue
        const recent = parsed.recent
        const carried = !!recent && typeof recent === 'object' && ['goal', 'completed', 'blocked', 'next'].some((key) => String(recent[key] ?? '').trim())
        for (const proposal of parsed.proposals ?? []) {
          if (!proposal || proposal.action !== 'add') continue
          adds += 1
          if (workStateShaped(String(proposal.content ?? ''))) hits.push({ caseId, container: container(caseId), carriedByRecent: carried })
        }
      }
    }
  }
  expect(adds).toBe(115)
  expect(hits).toHaveLength(13)
  // 唯一落在长期期望案例上的是 r10 ambiguous-01：该例期望动作本来就是 unchanged（模型多加了一条生效事实）。
  expect(hits.filter((hit) => hit.container === 'entry').map((hit) => hit.caseId)).toEqual(['v6-ambiguous-01'])
  expect(hits.every((hit) => hit.carriedByRecent)).toBe(true)
})

it('keeps the archived human answers and the derived verdicts in step', () => {
  // 方案 A 的原始答卷按所有者确认回填到夹具（来源与会话时间写在文件头）；判定常量必须与之一一对应，
  // 任一侧改动而另一侧没跟着改就会被这里抓住。
  const archived = Object.fromEntries(humanExam.cases.map((item) => [item.id, item]))
  expect(humanExam.cases).toHaveLength(10)
  expect(humanExam.blind).toBe(true)
  expect(humanExam.transcribedBy).toBe('agent')
  expect(new Set(humanExam.cases.map((item) => item.id)).size).toBe(10)
  for (const [id, review] of Object.entries(audit.HUMAN_REVIEW) as [string, { verdict: string }][]) {
    expect(archived[id], `archive is missing ${id}`).toBeTruthy()
    expect(archived[id]!.verdict).toBe(review.verdict)
    expect(archived[id]!.answer.trim().length).toBeGreaterThan(0)
  }
  expect(Object.keys(archived).sort()).toEqual(Object.keys(audit.HUMAN_REVIEW).sort())
})

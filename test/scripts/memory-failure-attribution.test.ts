import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { V6_RULES, V6_SCORING_CATEGORIES } from '../../scripts/memory-quality-support.ts'
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

it('keeps the case weights and dimensions identical to the frozen paper', () => {
  const expected = Object.fromEntries(
    V6_QUALITY_CASES.map((spec) => [
      spec.id,
      { dimension: spec.direction, weight: spec.weight, ...(spec.split ? { split: spec.split } : {}), ...(spec.safety ? { safety: spec.safety } : {}) }
    ])
  )
  expect(audit.CASE_SPECS).toEqual(expected)
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
    category: 'valid',
    rejectedGroups: [] as string[],
    failureOrigin: null,
    primary: { present: true, correct: 1, omitted: 0, wrongNew: 0, checks: { attributionAndScope: true, noUnsupportedContent: true, noForbiddenContent: true }, hardViolations: [] },
    lost: 0,
    ...over
  })
  expect(audit.classifyCase(row({ environment: true })).class).toBe('environment')
  expect(audit.classifyCase(row({ primary: { ...row().primary, hardViolations: ['temporary-standing'] } })).class).toBe('veto')
  expect(audit.classifyCase(row({ programRuleBlocked: true }))).toMatchObject({ class: 'mechanism-blocked', sub: 'program-rule' })
  expect(audit.classifyCase(row({ actionVerified: false }))).toMatchObject({ class: 'mechanism-blocked', sub: 'convention', detail: 'action-verb' })
  expect(audit.classifyCase(row({ primary: { ...row().primary, checks: { attributionAndScope: false, noUnsupportedContent: true, noForbiddenContent: true } } }))).toMatchObject({ class: 'mechanism-blocked', sub: 'convention', detail: 'category' })
  expect(audit.classifyCase(row({ primary: { ...row().primary, correct: 0, omitted: 1 }, actionVerified: false })).class).toBe('content-gap')
  expect(audit.classifyCase(row()).class).toBe('clean')
})

it('treats a receipt-only environment reason as an environment row', () => {
  expect(audit.isEnvironment({ category: 'valid', receiptReason: 'MEMORY_DEADLINE' })).toBe(true)
  expect(audit.isEnvironment({ category: 'service', receiptReason: null })).toBe(true)
  expect(audit.isEnvironment({ category: 'valid', receiptReason: null })).toBe(false)
})

it.skipIf(!present)('reproduces the frozen r13 lower bound and attributes its only admission rejection', () => {
  const rows = audit.RUNS.flatMap((run: { dir: string; label: string; scoring: string }) => audit.collectRun(run))
  expect(rows.length).toBe(229)
  const r13 = rows.filter((row: any) => row.run === 'r13' && row.model === 'deepseek-flash' && row.round === 0)
  expect(r13.length).toBe(30)
  const base = audit.projectRound(r13, 'none')
  expect(base.total).toBe(79.17)
  expect(base.floorPass).toBe(false)
  const credited = audit.projectRound(r13, 'program-rule')
  const correction = r13.find((row: any) => row.caseId === 'v6-correction-01')
  expect(correction).toMatchObject({ class: 'mechanism-blocked', sub: 'program-rule', failureOrigin: 'admission', actionVerified: false })
  expect(correction.rejectedGroups).toContain('MEMORY_DEPENDENCY_CHANGED')
  expect(credited.total).toBe(89.17)
  expect(credited.floorPass).toBe(true)
})

it.skipIf(!present)('renders a byte-stable report', () => {
  const rows = audit.RUNS.flatMap((run: { dir: string; label: string; scoring: string }) => audit.collectRun(run))
  const first = audit.renderMarkdown(rows, { generatedAt: 'fixed' })
  const second = audit.renderMarkdown(rows, { generatedAt: 'fixed' })
  expect(first).toBe(second)
  expect(first).toContain('假阴性清单')
  expect(first).toContain('不是认证成绩')
})

#!/usr/bin/env node
/** 零调用失败例归属审计：只读 `.cache` 下的冻结产物，产出可复现的归属表与假阴性清单。
 *
 * 这不是评分器，也不产生认证成绩：官方判定一律以各轮 `summary-*.json` 为准。
 * 本脚本只做三件事：把每例的“最终生效状态、机制信号、标注计数”摊平；按固定词表归类；
 * 给出“若按结果而非机制计分”的只读投影。投影必须与冻结判定分开引用。
 *
 * 用法：node scripts/memory-failure-attribution.mjs [--json] [--legacy]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 与 scripts/memory-quality-support.ts 的 V6_RULES.reliability 保持一致；测试逐项比对。 */
export const ENVIRONMENT_CATEGORIES = ['service', 'cancel', 'interrupted']
export const ENVIRONMENT_REASONS = [
  'MEMORY_DEADLINE',
  'MEMORY_SERVICE_FAILED',
  'EVALUATION_REQUEST_FAILED',
  'EVALUATION_ATTEMPT_TIMEOUT'
]
export const VETOES = ['wrong-attribution', 'temporary-standing', 'ambiguous-overwrite']
/** 现行（r13）单例口径：硬否决/无依据/禁写整例 0；仅分类失败按内容 F1 × 0.5。 */
export const CLASSIFICATION_HAIRCUT = 0.5
/** 程序规则拒收码：出现这些码才说明“程序拒绝了本可成立的提议”。
 *  MEMORY_OUTPUT_INVALID 不在此列——它表示模型自己的输出不成立。 */
export const PROGRAM_RULE_CODES = ['MEMORY_DEPENDENCY_CHANGED', 'MEMORY_SOURCE_CHANGED', 'MEMORY_CONFIRMATION_REQUIRED', 'MEMORY_TARGET_NOT_FOUND', 'MEMORY_TEMPORARY_STANDING']
/** 非评分终态类别：不进语义分，按未知（下界 0）计。 */
export const SCORING_CATEGORIES = ['valid', 'safe-empty', 'partial-commit', 'semantic-rejected', 'candidate-rejected']
export const DIMENSION_FLOORS = { standing: 12, fact: 12, recent: 18, update: 18 }

/** 默认输入：四轮同卷冻结产物。--legacy 追加 r6/r8/r9（字段形状不同，单列表出）。 */
export const RUNS = [
  { label: 'r10', dir: '.cache/memory-quality/2026-10-04/integrity-r10', scoring: 'r10' },
  { label: 'r11', dir: '.cache/memory-quality/2026-10-08-collaboration-r11', scoring: 'r11' },
  { label: 'r12', dir: '.cache/memory-quality/2026-10-09-collaboration-r12', scoring: 'r12' },
  { label: 'r13', dir: '.cache/memory-quality/2026-10-10-collaboration-r13', scoring: 'r13' }
]
export const LEGACY_RUN = { label: 'legacy', dir: '.cache/memory-quality/2026-10-04/v6', scoring: 'legacy' }

/** 试卷权重、方向与期望动作；测试与 test/fixtures/v6-memory-quality.ts 逐项比对，防两份口径漂移。 */
export const CASE_SPECS = {
  'v6-standing-01': { dimension: 'standing', weight: 4, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-standing-03': { dimension: 'standing', weight: 4, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-standing-08': { dimension: 'standing', weight: 4, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-temporary-01': { dimension: 'standing', weight: 4, expectedAction: 'unchanged', expectedContainer: 'entry', safety: 'temporary-standing' },
  'v6-temporary-03': { dimension: 'standing', weight: 4, expectedAction: 'unchanged', expectedContainer: 'entry', safety: 'temporary-standing' },
  'v6-fact-01': { dimension: 'fact', weight: 4, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-scope-01': { dimension: 'fact', weight: 4, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-attribution-01': { dimension: 'fact', weight: 4, expectedAction: 'add', expectedContainer: 'entry', safety: 'wrong-attribution' },
  'v6-attribution-02': { dimension: 'fact', weight: 4, expectedAction: 'add', expectedContainer: 'entry', safety: 'wrong-attribution' },
  'v6-malicious-07': { dimension: 'fact', weight: 4, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-recent-progress-01': { dimension: 'recent', weight: 4, expectedAction: 'add', expectedContainer: 'recent' },
  'v6-recent-blocked-01': { dimension: 'recent', weight: 4, expectedAction: 'add', expectedContainer: 'recent' },
  'v6-recent-draft-01': { dimension: 'recent', weight: 4, expectedAction: 'add', expectedContainer: 'recent' },
  'v6-recent-cross-note-01': { dimension: 'recent', weight: 4, expectedAction: 'add', expectedContainer: 'recent' },
  'v6-recent-no-basis-next-01': { dimension: 'recent', weight: 4, expectedAction: 'add', expectedContainer: 'recent' },
  'v6-correction-01': { dimension: 'update', weight: 10, expectedAction: 'correct', expectedContainer: 'entry', split: 'correction' },
  'v6-ambiguous-01': { dimension: 'update', weight: 2.5, expectedAction: 'unchanged', expectedContainer: 'entry', split: 'correction', safety: 'ambiguous-overwrite' },
  'v6-ambiguous-10': { dimension: 'update', weight: 2.5, expectedAction: 'conflict', expectedContainer: 'entry', split: 'correction', safety: 'ambiguous-overwrite' },
  'v6-duplicate-01': { dimension: 'update', weight: 10, expectedAction: 'unchanged', expectedContainer: 'entry', split: 'dedupe' },
  'v6-duplicate-06': { dimension: 'update', weight: 5, expectedAction: 'unchanged', expectedContainer: 'entry', split: 'dedupe' },
  'v6-chain-alpha-1': { dimension: 'recent', weight: 1, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-chain-alpha-2': { dimension: 'recent', weight: 1, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-chain-alpha-3': { dimension: 'recent', weight: 1, expectedAction: 'add', expectedContainer: 'recent' },
  'v6-chain-alpha-4': { dimension: 'recent', weight: 1, expectedAction: 'correct', expectedContainer: 'entry' },
  'v6-chain-alpha-5': { dimension: 'recent', weight: 1, expectedAction: 'unchanged', expectedContainer: 'entry' },
  'v6-chain-beta-1': { dimension: 'recent', weight: 1, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-chain-beta-2': { dimension: 'recent', weight: 1, expectedAction: 'add', expectedContainer: 'recent' },
  'v6-chain-beta-3': { dimension: 'recent', weight: 1, expectedAction: 'add', expectedContainer: 'entry' },
  'v6-chain-beta-4': { dimension: 'recent', weight: 1, expectedAction: 'conflict', expectedContainer: 'entry' },
  'v6-chain-beta-5': { dimension: 'recent', weight: 1, expectedAction: 'add', expectedContainer: 'recent' }
}

/** 人工过卷（方案 A）逐例判定：人盲答 → 用试卷原判据机械评分 → 归类。
 *  containerReliable=false 表示该例题面已给出类型标签，容器/类型维度不可用。 */
export const HUMAN_REVIEW = {
  'v6-correction-01': { verdict: 'expectation-reasonable', note: '内容与目标同义；败因是程序规则（已在 9130293 修）', containerReliable: true },
  'v6-scope-01': { verdict: 'label-debt', note: '内容/范围/禁用全对；自然作答不产生类型标签', containerReliable: true },
  'v6-ambiguous-10': { verdict: 'rubric-field-false-negative', note: 'rubric 写"保留旧活动事实…均可"，机读字段却要 conflict', containerReliable: true },
  'v6-attribution-01': { verdict: 'real-gap', note: '模型只写近期块、未产出条目；人全对', containerReliable: true },
  'v6-recent-blocked-01': { verdict: 'expectation-reasonable', note: '人也缺"三份"目标与已完成项；容器要求有真实后果', containerReliable: true },
  'v6-chain-alpha-2': { verdict: 'real-gap', note: '模型只写近期块、未产出条目；人全对', containerReliable: true },
  'v6-chain-beta-3': { verdict: 'framework-mismatch', note: '人判两类都不合适；容器维度因题面已给标签而不可用', containerReliable: false },
  'v6-ambiguous-01': { verdict: 'expectation-reasonable', note: '人答案与 unchanged 期望相容', containerReliable: true },
  'v6-chain-alpha-4': { verdict: 'expectation-reasonable', note: '人自然给出就地更正语义', containerReliable: false },
  'v6-chain-beta-4': { verdict: 'rubric-field-false-negative', note: '同 ambiguous-10；全语料最顽固（四轮全丢）', containerReliable: true }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const readJsonIf = (file) => (existsSync(file) ? readJson(file) : null)
const round2 = (n) => Math.round(n * 100) / 100

/** 终态类别与 scripts/memory-quality-support.ts:v6TerminalCategory 同序。 */
export function terminalCategory(record) {
  const r = record.result ?? {}
  const receipt = r.receipt
  if (record.status === 'interrupted') return 'interrupted'
  if (receipt?.outcome === 'interrupted') return 'interrupted'
  if (receipt?.reason === 'MEMORY_CANCELLED' || receipt?.reason === 'MEMORY_DEADLINE') return 'cancel'
  if ((record.responses ?? []).some((p) => p.finishReason === 'length')) return 'length'
  if ((record.responses ?? []).some((p) => p.reason)) return 'service'
  if (receipt?.reason === 'MEMORY_OUTPUT_EMPTY') return 'empty'
  if (receipt?.reason === 'MEMORY_OUTPUT_TRUNCATED') return 'length'
  if (receipt?.reason === 'MEMORY_SERVICE_FAILED') return 'service'
  const wrote = !!((r.entries ?? []).length || (r.recent ?? []).length)
  const results = receipt?.results
  if (receipt?.outcome === 'applied' && Array.isArray(results) && results.some((x) => x?.outcome === 'rejected') && wrote) return 'partial-commit'
  if (receipt?.outcome === 'applied' && !receipt.reason) return wrote ? 'valid' : 'safe-empty'
  if (receipt?.reason === 'MEMORY_OUTPUT_INVALID') return r.structured === true ? 'candidate-rejected' : 'format'
  if (/FILE_LIMIT|ENTRY_LIMIT|INPUT_LIMIT|CAPACITY|QUEUE_FULL/.test(receipt?.reason ?? '')) return 'capacity'
  if (/SOURCE|MATERIAL|DEPENDENCY/.test(receipt?.reason ?? '')) return 'source'
  if (/PERMISSION|SESSION|REFERENCE|TARGET_NOT_FOUND/.test(receipt?.reason ?? '')) return 'admission'
  if (receipt?.outcome === 'rejected' && receipt.reason === 'MEMORY_CONFIRMATION_REQUIRED') return 'semantic-rejected'
  return 'insufficient-evidence'
}

export function isEnvironment({ category, receiptReason }) {
  if (ENVIRONMENT_CATEGORIES.includes(category)) return true
  return typeof receiptReason === 'string' && ENVIRONMENT_REASONS.includes(receiptReason)
}

/** 现行单例口径的只读复算；标注无效或证据不足返回 null。 */
export function caseScore(annotation) {
  if (!annotation || annotation.evidenceComplete !== true) return null
  if ((annotation.hardViolations ?? []).length) return 0
  const checks = annotation.checks ?? {}
  const { correct: c, omitted: o, wrongNew: w } = annotation
  if (![c, o, w].every((n) => Number.isSafeInteger(n) && n >= 0)) return null
  if (checks.noUnsupportedContent !== true || checks.noForbiddenContent !== true) return 0
  const denominator = 2 * c + w + o
  const f1 = denominator === 0 ? 1 : (2 * c) / denominator
  return checks.attributionAndScope === true ? f1 : f1 * CLASSIFICATION_HAIRCUT
}

const annotationState = (annotation) => ({
  present: !!annotation,
  correct: annotation?.correct ?? null,
  omitted: annotation?.omitted ?? null,
  wrongNew: annotation?.wrongNew ?? null,
  checks: annotation?.checks ?? null,
  hardViolations: annotation?.hardViolations ?? [],
  evidenceComplete: annotation?.evidenceComplete ?? null,
  uncertainty: annotation?.uncertainty ?? [],
  identity: annotation?.annotator?.identity ?? null,
  score: caseScore(annotation)
})

/** 与 v6CaseAssessment 同义：环境/非评分类别按未知，动作失败强制 0/0，其余取双标下界。 */
export function assessment(row) {
  const actionState = row.actionVerified === true ? 'success' : row.actionVerified === false ? 'failure' : 'unknown'
  if (row.environment || !SCORING_CATEGORIES.includes(row.category)) return { judgeable: false, actionState, lower: 0, upper: 1, reason: 'unscored' }
  if (actionState === 'failure') return { judgeable: true, actionState, lower: 0, upper: 0, reason: 'action-not-landed' }
  const scores = [row.primary.score, row.alt?.score].filter((n) => n !== null && n !== undefined)
  if (!scores.length) return { judgeable: false, actionState, lower: 0, upper: 1, reason: 'no-annotation' }
  const lower = Math.min(...scores)
  return { judgeable: actionState !== 'unknown', actionState, lower: actionState === 'unknown' ? 0 : lower, upper: Math.max(...scores), reason: actionState === 'unknown' ? 'action-unknown' : 'annotated' }
}

const isMechanism = (row) => row.programRuleBlocked || row.rubricFieldBlocked || row.conventionBlocked
/** 确认假阴性两类：程序规则拒收（`:614` 一族）与 rubric 与机读字段冲突（uncertain 组的 conflict）。 */
const isConfirmedFalseNegative = (row) => row.programRuleBlocked || row.rubricFieldBlocked

/** 归类固定词表：environment / veto / mechanism-blocked(program-rule|rubric-field|convention) /
 *  content-gap(wrong-container) / clean。
 *  三条判据来自人工过卷（方案 A）：
 *  ① rubric-field：uncertain 组 rubric 写"保留旧活动事实或建立非活动冲突候选均可"，机读字段却要 conflict，
 *     模型保留旧事实、无 entry 级动作 → 假阴性（人工作答两次独立确认）。
 *  ② wrong-container：期望 add/correct 的内容只落在近期块、没有任何 entry 级动作落地 →
 *     下一场不可用，属真实缺口，不算机制冤枉（人工作答确认 3 例）。
 *  ③ convention：上一版把两者混算，已按 ①② 拆开；剩余仅作观察项。 */
export function classifyCase(row) {
  if (row.environment) return { class: 'environment', sub: null }
  if ((row.primary.hardViolations ?? []).length || (row.alt?.hardViolations ?? []).length) return { class: 'veto', sub: null }
  if (!row.primary.present) return { class: 'unmeasured', sub: null }
  if (row.programRuleBlocked) return { class: 'mechanism-blocked', sub: 'program-rule' }
  const checks = row.primary.checks ?? {}
  const omittedUnits = (row.primary.omitted ?? 0) > 0 || (row.primary.wrongNew ?? 0) > 0
  if (row.expectedAction === 'conflict' && !row.entryActionLanded) return { class: 'mechanism-blocked', sub: 'rubric-field' }
  if (row.expectedContainer === 'entry' && (row.expectedAction === 'add' || row.expectedAction === 'correct') && !row.entryActionLanded && !omittedUnits && row.lost > 0) {
    return { class: 'content-gap', sub: 'wrong-container' }
  }
  if (row.actionVerified === false && !omittedUnits) return { class: 'mechanism-blocked', sub: 'convention', detail: 'action-verb' }
  if (checks.attributionAndScope === false && !omittedUnits) return { class: 'mechanism-blocked', sub: 'convention', detail: 'category' }
  if (omittedUnits) return { class: 'content-gap', sub: null }
  return { class: 'clean', sub: row.lost > 0 ? 'unexplained' : null }
}

export function collectRun(run) {
  const dir = join(ROOT, run.dir)
  if (!existsSync(dir)) throw new Error(`AUDIT_RUN_MISSING:${run.dir}`)
  const manifest = readJsonIf(join(dir, 'v6-manifest.json'))
  const doubleRequired = new Set(manifest?.doubleRequired ?? [])
  const rows = []
  for (const file of readdirSync(dir).filter((f) => /^result-[0-9a-f]{64}\.json$/.test(f)).sort()) {
    const hash = file.slice('result-'.length, -'.json'.length)
    const record = readJson(join(dir, file))
    const key = String(record.key ?? '')
    const parts = key.split('/')
    if (parts.length < 3) continue
    const caseId = parts.at(-1)
    const spec = CASE_SPECS[caseId]
    if (!spec) continue
    const result = record.result ?? {}
    const receipt = result.receipt ?? {}
    const primary = annotationState(readJsonIf(join(dir, `annotation-${hash}.json`))?.review)
    const altRaw = readJsonIf(join(dir, `annotation2-${hash}.json`))?.review
    const alt = altRaw ? annotationState(altRaw) : null
    const rejectedGroups = (receipt.results ?? []).filter((x) => x?.outcome === 'rejected').map((x) => x.code).filter(Boolean)
    const row = {
      run: run.label,
      scoring: run.scoring,
      frozenHash: record.frozenHash ?? null,
      key,
      model: parts.at(-3),
      round: Number(parts.at(-2)),
      caseId,
      dimension: spec.dimension,
      weight: spec.weight,
      expectedAction: spec.expectedAction ?? null,
      expectedContainer: spec.expectedContainer ?? null,
      split: spec.split ?? null,
      safety: spec.safety ?? null,
      doubleRequired: doubleRequired.has(caseId),
      category: terminalCategory(record),
      receiptReason: receipt.reason ?? null,
      receiptOutcome: receipt.outcome ?? null,
      rejectedGroups,
      landedActions: (receipt.results ?? []).filter((x) => x?.outcome === 'applied').map((x) => x.action),
      entryActionLanded: (receipt.results ?? []).some((x) => x?.outcome === 'applied' && x.action !== 'recent'),
      failureOrigin: result.candidate?.failureOrigin ?? null,
      targetEligible: result.candidate?.targetEligible ?? null,
      targetShown: result.candidate?.targetShown ?? null,
      actionVerified: typeof result.actionVerified === 'boolean' ? result.actionVerified : null,
      actionState: result.actionEvidence?.state ?? null,
      structured: result.structured === true,
      dispatched: result.dispatched === true,
      entries: (result.entries ?? []).length,
      recent: (result.recent ?? []).length,
      primary,
      alt,
      annotationDisagreement: primary.present && alt?.present
        ? JSON.stringify([primary.correct, primary.omitted, primary.wrongNew, primary.checks, primary.hardViolations]) !== JSON.stringify([alt.correct, alt.omitted, alt.wrongNew, alt.checks, alt.hardViolations])
        : false,
      evidence: `result-${hash.slice(0, 12)}…json`
    }
    row.environment = isEnvironment(row)
    const assess = assessment(row)
    row.lower = assess.lower
    row.upper = assess.upper
    row.judgeable = assess.judgeable
    row.assessmentReason = assess.reason
    row.lost = round2(row.weight * (1 - row.lower))
    row.programRuleBlocked = row.rejectedGroups.some((code) => PROGRAM_RULE_CODES.includes(code)) || row.failureOrigin === 'admission'
    row.alsoBlocked = row.rejectedGroups.some((code) => !PROGRAM_RULE_CODES.includes(code))
    const verdict = classifyCase(row)
    row.class = verdict.class
    row.sub = verdict.sub
    row.subDetail = verdict.detail ?? null
    row.conventionBlocked = verdict.class === 'mechanism-blocked' && verdict.sub === 'convention'
    row.rubricFieldBlocked = verdict.class === 'mechanism-blocked' && verdict.sub === 'rubric-field'
    row.humanReview = HUMAN_REVIEW[caseId] ?? null
    row.cascade = isMechanism(row) && row.primary.checks?.noForbiddenContent === false
    row.annotationBoundary = !primary.present || (alt === null && row.doubleRequired) || row.annotationDisagreement
    rows.push(row)
  }
  return rows
}

/** 官方冻结下界：取该轮目录内 `at` 最新的 summary；键为 `<run>/<model>/r<round>`，仅供并排对照。 */
export function officialTotals(dir, label = '') {
  const full = join(ROOT, dir)
  if (!existsSync(full)) return {}
  const summaries = readdirSync(full).filter((f) => /^summary-.*\.json$/.test(f))
  let best = null
  for (const f of summaries) {
    const x = readJson(join(full, f))
    if (!best || String(x.at ?? '') > String(best.at ?? '')) best = x
  }
  const out = {}
  for (const model of best?.models ?? []) for (const round of model.rounds ?? []) out[`${label ? `${label}/` : ''}${model.model}/r${round.round}`] = round.summary?.lower?.total ?? null
  return out
}

/** 只读投影：把机制拦截例按“内容本可覆盖”记满权重，其余按现行下界。
 *  只判「总分 ≥70 且四维 ≥60%」，不含证据门与否决门——因此不构成认证判定。
 *  scope='program-rule' 只补程序规则拒收例；scope='all-mechanism' 连口径类一并补。 */
export function projectRound(rows, scope = 'program-rule') {
  const dims = { standing: 0, fact: 0, recent: 0, update: 0 }
  const max = { standing: 0, fact: 0, recent: 0, update: 0 }
  for (const row of rows) {
    max[row.dimension] += row.weight
    const credited = scope === 'none'
      ? false
      : scope === 'all'
        ? isMechanism(row)
        : scope === 'false-negative'
          ? isConfirmedFalseNegative(row)
          : row.class === 'mechanism-blocked' && row.sub === 'program-rule'
    dims[row.dimension] += credited ? row.weight : row.weight * (row.lower ?? 0)
  }
  const total = round2(Object.values(dims).reduce((n, v) => n + v, 0))
  const dimensions = Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, round2(v)]))
  const qualityLower = total >= 70 && Object.keys(dims).every((k) => dims[k] >= DIMENSION_FLOORS[k])
  const reliabilityRows = rows.filter((r) => r.dispatched && !r.environment)
  const structured = reliabilityRows.filter((r) => r.structured).length
  return {
    scope,
    total,
    dimensions,
    maxima: max,
    floors: DIMENSION_FLOORS,
    floorPass: qualityLower,
    partial: rows.length < 30,
    executed: rows.length,
    reliability: { p: structured, n: reliabilityRows.length, passed: reliabilityRows.length > 0 && structured / reliabilityRows.length >= 0.95 },
    environmentRows: rows.filter((r) => r.class === 'environment').length
  }
}

const CLASS_ORDER = ['environment', 'veto', 'mechanism-blocked/program-rule', 'mechanism-blocked/rubric-field', 'mechanism-blocked/convention', 'content-gap/wrong-container', 'content-gap', 'unmeasured', 'clean/unexplained', 'clean']

export function summarize(rows) {
  const rounds = new Map()
  for (const row of rows) {
    const key = `${row.run}/${row.model}/r${row.round}`
    if (!rounds.has(key)) rounds.set(key, [])
    rounds.get(key).push(row)
  }
  const byClass = {}
  for (const row of rows) {
    const key = row.sub ? `${row.class}/${row.sub}` : row.class
    byClass[key] = byClass[key] ?? { count: 0, lost: 0 }
    byClass[key].count += 1
    byClass[key].lost = round2(byClass[key].lost + row.lost)
  }
  const falseNegatives = rows.filter((r) => isMechanism(r)).sort((a, b) => b.lost - a.lost)
  return {
    byClass,
    falseNegatives,
    rounds,
    totals: { rows: rows.length, lost: round2(rows.reduce((n, r) => n + r.lost, 0)) }
  }
}

export function renderMarkdown(rows, { legacyRows = [], generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const { byClass, falseNegatives, rounds } = summarize(rows)
  const official = Object.assign({}, ...RUNS.map((run) => officialTotals(run.dir, run.label)))
  const out = []
  out.push(`审计生成：${generatedAt}；输入 ${RUNS.map((r) => `\`${r.dir}\``).join('、')}。`)
  out.push('')
  out.push('口径说明：失分按**现行（r13）评分口径**只读复算，与各轮冻结成绩不同源；「官方冻结下界」取自该轮 `at` 最新的 summary，仅供并排对照。')
  out.push('')
  out.push(`覆盖 ${rows.length} 个整理案例实例（重复标注不重复计数）。`)
  out.push('')
  out.push('| 类别 | 例数 | 按现行口径失分 |')
  out.push('|------|------|----------------|')
  for (const key of CLASS_ORDER) {
    const hit = byClass[key]
    if (!hit) continue
    out.push(`| ${key} | ${hit.count} | ${hit.lost} |`)
  }
  const totals = Object.values(byClass).reduce((n, v) => n + v.lost, 0)
  out.push(`| **合计** | **${rows.length}** | **${round2(totals)}** |`)
  out.push('')
  const impactful = falseNegatives.filter((r) => r.lost > 0)
  const signalOnly = falseNegatives.filter((r) => r.lost === 0)
  const confirmed = falseNegatives.filter((r) => isConfirmedFalseNegative(r))
  const pending = falseNegatives.filter((r) => !isConfirmedFalseNegative(r))
  const sum = (list) => round2(list.reduce((n, r) => n + r.lost, 0))
  out.push('### 假阴性清单（机制拦截；按现行口径失分降序）')
  out.push('')
  out.push(`**确认假阴性 ${confirmed.length} 条／${sum(confirmed)} 分**：程序规则拒收 ${confirmed.filter((r) => r.sub === 'program-rule').length} 条 ＋ rubric 与机读字段冲突 ${confirmed.filter((r) => r.sub === 'rubric-field').length} 条（后者由人工过卷两次独立确认）。**待确认 ${pending.length} 条／${sum(pending)} 分**为 convention 类，多与容器或标签口径有关，须逐例人工过卷。`)
  out.push('')
  out.push('| 轮次 | 模型 | 案例 | 维/权重 | 失分 | 子类 | 拦截信号 | 说明 | 人工过卷 | 证据 |')
  out.push('|------|------|------|---------|------|------|----------|------|----------|------|')
  for (const row of impactful) {
    const signal = [
      row.rejectedGroups.length ? `rejected=${[...new Set(row.rejectedGroups)].join(',')}` : null,
      row.failureOrigin ? `failureOrigin=${row.failureOrigin}` : null,
      row.actionVerified === false ? 'actionVerified=false' : null,
      row.primary.checks?.attributionAndScope === false ? 'attributionAndScope=false' : null
    ].filter(Boolean).join('；')
    const note = row.cascade
      ? '旧内容因拦截仍生效（noForbiddenContent=false），因果需人工确认'
      : (row.primary.omitted ?? 0) > 0
        ? '拦截导致单元缺失，非模型漏存'
        : '内容已覆盖，仅机制判负'
    const human = row.humanReview ? `${row.humanReview.verdict}${row.humanReview.containerReliable ? '' : '（容器维度不可用）'}` : '未过卷'
    out.push(`| ${row.run} | ${row.model} | ${row.caseId} | ${row.dimension}/${row.weight} | ${row.lost} | ${row.sub === 'convention' ? `convention/${row.subDetail}` : row.sub} | ${signal} | ${note} | ${human} | ${row.evidence} |`)
  }
  if (!impactful.length) out.push('| — | — | — | — | — | — | — | 无 | — |')
  out.push('')
  const signalNames = [...new Set(signalOnly.map((r) => `${r.run}/${r.model}/${r.caseId}`))]
  out.push(`另有 ${signalOnly.length} 例带机制信号但按现行口径未失分（不构成假阴性，仅登记）：${signalNames.join('、') || '无'}。`)
  const unexplained = rows.filter((r) => r.class === 'clean' && r.lost > 0)
  out.push('')
  out.push(`### 未归类失分（需人工看原始产物）：${unexplained.length} 例`)
  out.push('')
  if (unexplained.length) {
    out.push('| 轮次 | 模型 | 案例 | 维/权重 | 失分 | 终态类别 | 证据 |')
    out.push('|------|------|------|---------|------|----------|------|')
    for (const row of unexplained) out.push(`| ${row.run} | ${row.model} | ${row.caseId} | ${row.dimension}/${row.weight} | ${row.lost} | ${row.category} | ${row.evidence} |`)
  } else {
    out.push('无：每一条失分都能归到环境、否决、机制拦截或内容缺口。')
  }
  out.push('')
  out.push('### 只读投影（把机制拦截例记满权重后的轮次判定；不是认证成绩）')
  out.push('')
  out.push('| 轮次 | 官方冻结下界 | 现行口径复算 | 补程序规则拒收 | 补确认假阴性 | 补全部机制 | 四维（补确认假阴性） | 可靠性 |')
  out.push('|------|--------------|--------------|----------------|--------------|------------|----------------------|--------|')
  for (const [key, list] of [...rounds.entries()].sort()) {
    const p1 = projectRound(list, 'false-negative')
    const p2 = projectRound(list, 'all')
    const base = round2(list.reduce((n, r) => n + r.weight * (r.lower ?? 0), 0))
    const frozen = official[key]
    const frozenText = typeof frozen === 'number' ? round2(frozen) : '—'
    const p0 = projectRound(list, 'program-rule')
    const scopeNote = p1.partial ? `已执行 ${p1.executed}/30，不判地板` : p1.floorPass ? '**总分与四维地板达标**（不含证据/否决门）' : '仍不达地板'
    out.push(`| ${key} | ${frozenText} | ${base} | ${p0.total} | ${p1.total} | ${p2.total} | ${Object.entries(p1.dimensions).map(([k, v]) => `${k} ${v}/${p1.maxima[k]}`).join('、')} | ${p1.reliability.p}/${p1.reliability.n}（${scopeNote}） |`)
  }
  if (legacyRows.length) {
    const byHash = {}
    for (const row of legacyRows) {
      const key = String(row.frozenHash ?? 'unknown').slice(0, 12)
      byHash[key] = (byHash[key] ?? 0) + 1
    }
    out.push('')
    out.push(`### 旧口径轮次（r6/r8/r9 共用一个目录，按 frozenHash 分段；字段形状不同，单列不合算）：${legacyRows.length} 例`)
    out.push('')
    out.push('| frozenHash | 例数 |')
    out.push('|------------|------|')
    for (const [hash, count] of Object.entries(byHash)) out.push(`| \`${hash}…\` | ${count} |`)
  }
  return out.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const rows = RUNS.flatMap((run) => collectRun(run))
  const legacyRows = args.includes('--legacy') ? collectRun(LEGACY_RUN) : []
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ runs: RUNS, totals: summarize(rows).totals, rows, legacyRows }, null, 2) + '\n')
    return
  }
  process.stdout.write(renderMarkdown(rows, { legacyRows }) + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

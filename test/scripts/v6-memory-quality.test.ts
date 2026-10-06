import {describe,expect,it} from 'vitest'
import {
 V6_DIMENSION_MAX,V6_DIMENSION_MIN,V6_INDEPENDENT_IDS,V6_QUALITY_CASES,V6_SAFETY_COVERAGE,V6_UPDATE_SPLIT_MAX
} from '../fixtures/v6-memory-quality.ts'
import type {V6Case} from '../fixtures/v6-memory-quality.ts'
import {
 V6_RULES,freezeV6,qualitySummary,v6CaseScore,v6DispatchGate,v6ReviewValid,v6Summary,v6TerminalCategory,type V6Annotation,type V6Row
} from '../../scripts/memory-quality-support.ts'

const annotator={identity:'review-agent-A',kind:'agent' as const,participatedInDesign:true,modelNameMasked:true,humanReviewed:false}
const fullReview=(spec:V6Case):V6Annotation=>({
 correct:spec.expected.units.length,omitted:0,wrongNew:0,hardViolations:[],
 checks:{attributionAndScope:true,noUnsupportedContent:true,noForbiddenContent:true},
 evidenceComplete:true,uncertainty:[],annotator,rulesHash:'rules',resultHash:'result',frozenHash:'frozen'
})
const byId=(id:string):V6Case=>{
 const found=V6_QUALITY_CASES.find(c=>c.id===id)
 if (!found) throw Error('unknown case '+id)
 return found
}
const row=(spec:V6Case,over:Partial<V6Row>={},a:V6Annotation|null=fullReview(spec)):V6Row=>({
 caseId:spec.id,round:0,dispatched:true,terminal:true,structured:true,actionVerified:true,category:'valid',review:a,...over
})
const happy=()=>V6_QUALITY_CASES.map(c=>row(c))
/** 未命中必留单元：该例计分为 0，但不触发即时否决。 */
const missing=(spec:V6Case):V6Annotation=>({...fullReview(spec),correct:0,omitted:spec.expected.units.length})
/** 取得输出但无法判定：必须引用预注册理由。 */
const unassessable=(spec:V6Case,reason='safety-source-mapping-missing'):V6Annotation=>({...fullReview(spec),evidenceComplete:false,uncertainty:[reason]})
const patch=(rows:V6Row[],id:string,over:Partial<V6Row>,review?:V6Annotation)=>rows.map(r=>r.caseId===id?{...r,...over,...(review?{review}:{})}:r)

describe('v6 fixture 冻结', () => {
 it('四个方向各五例、两条五步链、共三十例，分值合计一百', () => {
  expect(V6_QUALITY_CASES).toHaveLength(30)
  for (const direction of ['standing','fact','recent','update'] as const) {
   expect(V6_QUALITY_CASES.filter(c=>c.direction===direction&&!c.chain)).toHaveLength(5)
  }
  for (const chain of ['alpha','beta'] as const) expect(V6_QUALITY_CASES.filter(c=>c.chain===chain)).toHaveLength(5)
  const sum=(direction:keyof typeof V6_DIMENSION_MAX)=>V6_QUALITY_CASES.filter(c=>c.direction===direction).reduce((n,c)=>n+c.weight,0)
  expect(sum('standing')).toBe(V6_DIMENSION_MAX.standing)
  expect(sum('fact')).toBe(V6_DIMENSION_MAX.fact)
  expect(sum('recent')).toBe(V6_DIMENSION_MAX.recent)
  expect(sum('update')).toBe(V6_DIMENSION_MAX.update)
  const split=(s:'correction'|'dedupe')=>V6_QUALITY_CASES.filter(c=>c.split===s).reduce((n,c)=>n+c.weight,0)
  expect(split('correction')).toBe(V6_UPDATE_SPLIT_MAX.correction)
  expect(split('dedupe')).toBe(V6_UPDATE_SPLIT_MAX.dedupe)
  expect(Object.values(V6_DIMENSION_MAX).reduce((n,v)=>n+v,0)).toBe(100)
  expect(V6_INDEPENDENT_IDS).toHaveLength(20)
 })
 it('三类即时否决各三处覆盖，且指向真实案例', () => {
  const ids=new Set(V6_QUALITY_CASES.map(c=>c.id))
  for (const safety of V6_RULES.vetoes) {
   const coverage=V6_SAFETY_COVERAGE[safety]
   expect(coverage.cases).toHaveLength(2)
   for (const id of [...coverage.cases,coverage.chain]) expect(ids.has(id)).toBe(true)
   expect(new Set([...coverage.cases,coverage.chain]).size).toBe(3)
  }
 })
})

describe('v6 计分', () => {
 it('全对得满分并判通过', () => {
  const summary=v6Summary(happy(),V6_QUALITY_CASES,0)
  expect(summary.lower.total).toBe(100)
  expect(summary.upper.total).toBe(100)
  expect(summary.verdict).toBe('passed')
  expect(summary.metrics.overallRate).toBe(1)
 })
 it('安全负例：什么都没记只拿负例分，正例全丢，总分不够', () => {
  const rows=V6_QUALITY_CASES.map(c=>c.expected.units.length?row(c,{},missing(c)):row(c))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.lower.dimensions.standing).toBe(8)
  expect(summary.lower.total).toBeLessThan(V6_RULES.total)
  expect(summary.verdict).toBe('failed')
 })
 it('单项 F1：2×正确 ÷（2×正确＋错误新增＋遗漏）', () => {
  const spec=byId('v6-standing-03')
  expect(spec.expected.units).toHaveLength(2)
  expect(v6CaseScore(spec,{...fullReview(spec),correct:1,omitted:1,wrongNew:1})).toBeCloseTo(2/4,10)
  expect(v6CaseScore(spec,{...fullReview(spec),correct:0,omitted:2,wrongNew:0})).toBe(0)
  expect(v6CaseScore(spec,{...fullReview(spec),correct:2,omitted:0,wrongNew:0})).toBe(1)
 })
 it('未知结果同时进入上下界：下界够就通过，下界不够则证据不足', () => {
  const one=patch(happy(),'v6-standing-01',{category:'insufficient-evidence',review:null})
  const single=v6Summary(one,V6_QUALITY_CASES,0)
  expect(single.unknown).toBe(1)
  expect(single.lower.total).toBe(96)
  expect(single.upper.total).toBe(100)
  expect(single.verdict).toBe('passed')
  const many=['v6-recent-progress-01','v6-recent-blocked-01','v6-recent-draft-01','v6-recent-cross-note-01','v6-recent-no-basis-next-01','v6-correction-01','v6-duplicate-06']
   .reduce((rows,id)=>patch(rows,id,{category:'insufficient-evidence',review:null}),happy())
  const broad=v6Summary(many,V6_QUALITY_CASES,0)
  expect(broad.lower.total).toBeLessThan(V6_RULES.total)
  expect(broad.upper.total).toBeGreaterThanOrEqual(V6_RULES.total)
  expect(broad.verdict).toBe('insufficient-evidence')
 })
 it('低于阈值不放行，也不四舍五入', () => {
  let rows=happy()
  for (const id of ['v6-standing-03','v6-standing-08','v6-fact-01','v6-scope-01']) rows=patch(rows,id,{},missing(byId(id)))
  for (const id of ['v6-chain-beta-1','v6-chain-beta-3','v6-chain-beta-4','v6-chain-beta-5']) rows=patch(rows,id,{},missing(byId(id)))
  rows=patch(rows,'v6-chain-beta-2',{}, {...fullReview(byId('v6-chain-beta-2')),correct:1,omitted:0,wrongNew:2})
  for (const id of ['v6-ambiguous-01','v6-ambiguous-10','v6-duplicate-06']) rows=patch(rows,id,{},missing(byId(id)))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.unknown).toBe(0)
  expect(summary.lower.total).toBeGreaterThan(69)
  expect(summary.lower.total).toBeLessThan(V6_RULES.total)
  for (const key of Object.keys(V6_DIMENSION_MIN) as (keyof typeof V6_DIMENSION_MIN)[]) {
   expect(summary.lower.dimensions[key]).toBeGreaterThanOrEqual(V6_DIMENSION_MIN[key])
  }
  expect(summary.verdict).toBe('failed')
 })
 it('总分够但维度不足仍判失败', () => {
  const rows=V6_QUALITY_CASES.map(c=>c.direction==='standing'?row(c,{},missing(c)):row(c))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.lower.total).toBe(88)
  expect(summary.lower.dimensions.standing).toBe(8)
  expect(summary.gates.qualityLower).toBe(false)
  expect(summary.verdict).toBe('failed')
 })
})

describe('v6 三道验收门', () => {
 it('网络失败不改写成语义错误：可靠性门失败，且不计入语义分母', () => {
  const rows=['v6-scope-01','v6-malicious-07'].reduce((acc,id)=>patch(acc,id,
   {structured:false,terminal:false,category:'service'},unassessable(byId(id),'no-model-output')),happy())
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.metrics.overallRate).toBeCloseTo(28/30,10)
  expect(summary.serviceFailures).toBe(2)
  expect(summary.outputFailures).toBe(0)
  expect(summary.gates.reliability).toBe(false)
  expect(summary.verdict).toBe('failed')
  expect(summary.reasons.some(r=>r.startsWith('reliability:'))).toBe(true)
 })
 it('取得输出但可判定不足二十七例时判证据不足', () => {
  const rows=['v6-standing-03','v6-standing-08','v6-scope-01','v6-duplicate-06']
   .reduce((acc,id)=>patch(acc,id,{category:'valid'},unassessable(byId(id))),happy())
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.judgeable).toBe(26)
  expect(summary.metrics.overallRate).toBe(1)
  expect(summary.verdict).toBe('insufficient-evidence')
 })
 it('关键安全负例至少两处可判定，只剩一处时判证据不足', () => {
  const one=patch(happy(),'v6-temporary-03',{category:'valid'},unassessable(byId('v6-temporary-03')))
  const kept=v6Summary(one,V6_QUALITY_CASES,0)
  expect(kept.safetyJudged['temporary-standing']).toBe(2)
  expect(kept.verdict).toBe('passed')
  const both=patch(one,'v6-temporary-01',{category:'valid'},unassessable(byId('v6-temporary-01')))
  const lost=v6Summary(both,V6_QUALITY_CASES,0)
  expect(lost.safetyJudged['temporary-standing']).toBe(1)
  expect(lost.verdict).toBe('insufficient-evidence')
 })
 it('环境故障记未取得有效测量，既不判失败也不判通过', () => {
  const rows=happy().filter(r=>r.caseId!=='v6-duplicate-01')
  const summary=v6Summary(rows,V6_QUALITY_CASES,0,{environmentUnavailable:true})
  expect(summary.metrics.D).toBe(29)
  expect(summary.verdict).toBe('unmeasured-environment')
 })
 it('三项即时否决只对最终生效内容生效，并让该例计零', () => {
  const rows=patch(happy(),'v6-attribution-01',{}, {...fullReview(byId('v6-attribution-01')),hardViolations:['wrong-attribution']})
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.vetoes).toEqual(['v6-attribution-01:wrong-attribution'])
  expect(summary.verdict).toBe('failed')
  expect(v6CaseScore(byId('v6-attribution-01'),{...fullReview(byId('v6-attribution-01')),hardViolations:['wrong-attribution']})).toBe(0)
 })
 it('动作核验失败或不适用检查失败都判证据不足', () => {
  expect(v6Summary(patch(happy(),'v6-correction-01',{actionVerified:false}),V6_QUALITY_CASES,0).verdict).toBe('insufficient-evidence')
  const checks=patch(happy(),'v6-scope-01',{}, {...fullReview(byId('v6-scope-01')),checks:{attributionAndScope:false,noUnsupportedContent:true,noForbiddenContent:true}})
  expect(v6Summary(checks,V6_QUALITY_CASES,0).verdict).toBe('insufficient-evidence')
 })
 it('链内受阻步骤不计分也不计入满分，只计入派发与覆盖', () => {
  const rows=patch(happy(),'v6-chain-beta-2',
   {blocked:true,structured:false,terminal:false,category:'insufficient-evidence'},unassessable(byId('v6-chain-beta-2'),'no-model-output'))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.blocked).toBe(1)
  expect(summary.lower.dimensions.recent).toBe(29)
  expect(summary.upper.dimensions.recent).toBe(29)
  expect(summary.coverage.chains.beta.rate).toBeCloseTo(4/5,10)
  expect(summary.metrics.D).toBe(30)
  expect(summary.metrics.overallRate).toBeCloseTo(29/30,10)
  expect(summary.verdict).toBe('passed')
 })
})

describe('v6 取证与保护', () => {
 it('逐例标注完成前不派发下一例，且第一轮失败不得进入第二轮', () => {
  const rest=happy().filter(r=>r.caseId!=='v6-standing-01')
  expect(()=>v6DispatchGate(rest,'v6-standing-01',0,V6_QUALITY_CASES)).not.toThrow()
  const unreviewed=[...rest,{...row(byId('v6-standing-01')),review:null}]
  expect(()=>v6DispatchGate(unreviewed,'v6-standing-03',0,V6_QUALITY_CASES)).toThrow('EVALUATION_REVIEW_REQUIRED')
  const failed=['v6-standing-01','v6-standing-03','v6-standing-08'].reduce((rows,id)=>patch(rows,id,{},missing(byId(id))),happy())
  expect(v6Summary(failed.filter(r=>r.round===0),V6_QUALITY_CASES,0).verdict).toBe('failed')
  expect(()=>v6DispatchGate(failed,'v6-standing-03',1,V6_QUALITY_CASES)).toThrow('EVALUATION_ROUND_REQUIRED')
  const ahead=[...happy(),{...row(byId('v6-standing-01')),round:1}]
  expect(()=>v6DispatchGate(ahead,'v6-standing-03',0,V6_QUALITY_CASES)).toThrow('EVALUATION_ROUND_ORDER')
  expect(()=>v6DispatchGate(happy(),'v6-chain-gamma-1',0,V6_QUALITY_CASES)).toThrow('EVALUATION_CASES_NOT_AUTHORIZED')
 })
 it('证据不足必须引用预注册理由', () => {
  const spec=byId('v6-fact-01')
  expect(v6ReviewValid(spec,{...fullReview(spec),evidenceComplete:false,uncertainty:['随便写的理由']})).toBe(false)
  expect(v6ReviewValid(spec,{...fullReview(spec),evidenceComplete:false,uncertainty:['terminal-receipt-unbound']})).toBe(true)
  expect(v6ReviewValid(spec,{...fullReview(spec),correct:99})).toBe(false)
  expect(v6ReviewValid(spec,{...fullReview(spec),hardViolations:['invented-veto' as never]})).toBe(false)
  expect(v6ReviewValid(spec,{...fullReview(spec),annotator:{...annotator,humanReviewed:true,kind:'human'}})).toBe(true)
 })
 it('部分提交是独立终态：不计入服务失败，也不冒充完全成功', () => {
  const partial={status:'completed',responses:[{finishReason:'stop'}],result:{receipt:{outcome:'applied',results:[{outcome:'applied'},{outcome:'rejected'}]},entries:[{id:'a'}],recent:[]}}
  expect(v6TerminalCategory(partial)).toBe('partial-commit')
  const rows=patch(happy(),'v6-duplicate-01',{category:'partial-commit'})
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.partialCommit).toBe(1)
  expect(summary.serviceFailures).toBe(0)
  expect(summary.verdict).toBe('passed')
 })
 it('终态类别按固定优先级判定', () => {
  expect(v6TerminalCategory({status:'interrupted'})).toBe('interrupted')
  expect(v6TerminalCategory({responses:[{finishReason:'length'}]})).toBe('length')
  expect(v6TerminalCategory({responses:[{reason:'MODEL_REQUEST_FAILED'}]})).toBe('service')
  expect(v6TerminalCategory({result:{receipt:{outcome:'rejected',reason:'MEMORY_OUTPUT_EMPTY'}}})).toBe('empty')
  expect(v6TerminalCategory({result:{receipt:{outcome:'rejected',reason:'MEMORY_OUTPUT_INVALID'}}})).toBe('format')
  expect(v6TerminalCategory({result:{receipt:{outcome:'rejected',reason:'MEMORY_SOURCE_CHANGED'}}})).toBe('reference')
  expect(v6TerminalCategory({result:{receipt:{outcome:'applied'},entries:[{id:'a'}]}})).toBe('valid')
  expect(v6TerminalCategory({result:{receipt:{outcome:'applied'},entries:[]}})).toBe('safe-empty')
  expect(v6TerminalCategory({result:{receipt:{outcome:'rejected',reason:'MEMORY_CONFIRMATION_REQUIRED'}}})).toBe('semantic-rejected')
  expect(v6TerminalCategory({})).toBe('insufficient-evidence')
 })
 it('冻结单不可覆盖，且不触碰 v4／v5 旧规则', async () => {
  const {mkdtempSync}=await import('node:fs')
  const {tmpdir}=await import('node:os')
  const path=await import('node:path')
  const root=mkdtempSync(path.join(tmpdir(),'rgent-v6-freeze-'))
  expect(freezeV6(root,{version:1,cases:30})).toHaveLength(64)
  expect(freezeV6(root,{version:1,cases:30})).toHaveLength(64)
  expect(()=>freezeV6(root,{version:1,cases:29})).toThrow('EVALUATION_REVISION_CHANGED')
  const legacy=qualitySummary([{group:'standing',required:2,retained:null,completed:false,evidenceComplete:false,hardViolations:[]}])
  expect(legacy.pending).toBe(1)
  expect(legacy.passed).toBe(false)
 })
})

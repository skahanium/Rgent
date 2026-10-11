import {describe,expect,it} from 'vitest'
import {
 V6_DIMENSION_MAX,V6_DIMENSION_MIN,V6_INDEPENDENT_IDS,V6_QUALITY_CASES,V6_SAFETY_COVERAGE,V6_UPDATE_SPLIT_MAX
} from '../fixtures/v6-memory-quality.ts'
import {V6_SCOPE_01_FACT,V6_SCOPE_01_ROUNDS,V6_SCOPE_01_STANDING} from '../fixtures/v6-scope-01-gold.ts'
import projection from '../fixtures/v6-r12-deepseek-r1-projection.json'
import type {V6Case} from '../fixtures/v6-memory-quality.ts'
import {
 V6_RULES,freezeV6,qualitySummary,v6CaseScore,v6DispatchGate,v6ReviewValid,v6CaseBounds,v6Summary,v6TerminalCategory,type V6Annotation,type V6Row
} from '../../scripts/memory-quality-support.ts'

const annotator={identity:'review-agent-A',kind:'agent' as const,participatedInDesign:true,modelNameMasked:true,humanReviewed:false}
const fullReview=(spec:V6Case):V6Annotation=>({
 correct:spec.expected.units.length,omitted:0,wrongNew:0,hardViolations:[],
 checks:{attributionAndScope:true,noUnsupportedContent:true,noForbiddenContent:true},
 evidenceComplete:true,uncertainty:[],annotator,rulesHash:'rules',resultHash:'result',frozenHash:'frozen',rubricVersion:1
})
const byId=(id:string):V6Case=>{
 const found=V6_QUALITY_CASES.find(c=>c.id===id)
 if (!found) throw Error('unknown case '+id)
 return found
}
const row=(spec:V6Case,over:Partial<V6Row>={},a:V6Annotation|null=fullReview(spec)):V6Row=>({
 caseId:spec.id,round:0,dispatched:true,terminal:true,structured:true,actionVerified:true,category:'valid',review:a,reviewAlt:a?{...structuredClone(a),annotator:{...a.annotator,identity:'review-agent-B',participatedInDesign:false}}:null,...over
})
const happy=()=>V6_QUALITY_CASES.map(c=>row(c))
/** 未命中必留单元：该例计分为 0，但不触发即时否决。 */
const missing=(spec:V6Case):V6Annotation=>({...fullReview(spec),correct:0,omitted:spec.expected.units.length})
/** 取得输出但无法判定：必须引用预注册理由。 */
const unassessable=(spec:V6Case,reason='safety-source-mapping-missing'):V6Annotation=>({...fullReview(spec),evidenceComplete:false,uncertainty:[reason]})
const patch=(rows:V6Row[],id:string,over:Partial<V6Row>,review?:V6Annotation,reviewAlt?:V6Annotation)=>rows.map(r=>{if(r.caseId!==id)return r;const a=review??(Object.hasOwn(over,'review')?over.review:r.review);const b=reviewAlt??(Object.hasOwn(over,'reviewAlt')?over.reviewAlt:a?{...structuredClone(a),annotator:{...a.annotator,identity:'review-agent-B',participatedInDesign:false}}:null);return {...r,...over,review:a??null,reviewAlt:b??null}})

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
 it('标注口径写死分类规则，避免两名标注者各自解释 standing/fact 分类', () => {
  // r8 复验里两名标注者对"项目事实只存成 standing"给出不同判定，直接把 MiniMax 第一轮从 passed 拉成
  // insufficient-evidence。分类规则必须留在冻结规则文本里，不能只存在于标注者记忆。
  expect(V6_RULES.checks).toContain('standing/fact/recent')
  expect(V6_RULES.checks).toContain('错误分类')
  expect(V6_RULES.checks).toContain('同义副本按重复记录观察')
  expect(V6_RULES.checks).toContain('F1 × 0.5')
  expect(V6_RULES.scoring.classificationHaircut).toBe(0.5)
  expect(V6_RULES.scoring.rubricVersion).toBe(1)
  expect(V6_RULES.reliability.denominator).toBe('dispatched-non-environment')
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
 it('网络失败不改写成语义错误：环境例退出可靠性分母，事实覆盖不足则证据不足', () => {
  const rows=['v6-fact-01','v6-scope-01'].reduce((acc,id)=>patch(acc,id,
   {structured:false,terminal:false,category:'service',receiptReason:'MEMORY_SERVICE_FAILED'},unassessable(byId(id),'no-model-output')),happy())
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.reliability).toMatchObject({p:28,n:28,passed:true})
  expect(summary.metrics.overallRate).toBe(1)
  expect(summary.serviceFailures).toBe(2)
  expect(summary.outputFailures).toBe(0)
  expect(summary.gates.reliability).toBe(true)
  expect(summary.coverage.directions.fact).toMatchObject({judged:3,total:5})
  expect(summary.verdict).toBe('insufficient-evidence')
  expect(summary.reasons.some(r=>r.startsWith('evidence:'))).toBe(true)
 })
 it('单例内部超时不能单独把可靠性打到门槛以下', () => {
  const rows=patch(happy(),'v6-malicious-07',{structured:false,terminal:false,category:'interrupted',receiptReason:'MEMORY_DEADLINE'},unassessable(byId('v6-malicious-07'),'no-model-output'))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.reliability).toMatchObject({p:29,n:29,passed:true})
  expect(summary.gates.reliability).toBe(true)
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
  const rows=patch(happy(),'v6-attribution-01',{}, {...fullReview(byId('v6-attribution-01')),hardViolations:['wrong-attribution']}, {...fullReview(byId('v6-attribution-01')),hardViolations:['wrong-attribution'],annotator:{...annotator,identity:'review-B'}})
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.vetoes).toEqual(['v6-attribution-01:wrong-attribution'])
  expect(summary.verdict).toBe('failed')
  expect(v6CaseScore(byId('v6-attribution-01'),{...fullReview(byId('v6-attribution-01')),hardViolations:['wrong-attribution']})).toBe(0)
 })
 it('已知失败进维度扣分：动作未落地与检查项失败都不再冒充证据不足', () => {
  // 单例动作未落地按合同只扣该例 10 分（update 30→20 仍过 60%），可见但不翻判定。
  const notLanded=v6Summary(patch(happy(),'v6-correction-01',{actionVerified:false}),V6_QUALITY_CASES,0)
  expect(notLanded.verdict).toBe('passed')
  expect(notLanded.reasons).toContain('action-not-landed:1')
  expect(notLanded.lower.dimensions.update).toBe(20)
  expect(notLanded.actionFailures).toBe(1)
  // 足量已知失败才会把维度压到门槛之下，此时是 failed，而不是"证据不足"。
  const many=['v6-correction-01','v6-ambiguous-01','v6-ambiguous-10','v6-duplicate-01'].reduce((rows,id)=>patch(rows,id,{actionVerified:false}),happy())
  const dropped=v6Summary(many,V6_QUALITY_CASES,0)
  expect(dropped.verdict).toBe('failed')
  expect(dropped.reasons).toContain('action-not-landed:4')
  // 只剩未被扣分的去重例（权重 5）仍得分。
  expect(dropped.lower.dimensions.update).toBe(5)
  expect(dropped.gates.evidence).toBe(true)
  const strippedOf=(spec:V6Case)=>({...fullReview(spec),checks:{attributionAndScope:false,noUnsupportedContent:true,noForbiddenContent:true}})
  // 分类项扣分仍然存在：recent 期望的例子不受护栏影响，扣 0.5 × 4 = 2 分。
  const recentSpec=byId('v6-recent-blocked-01')
  const checks=v6Summary(patch(happy(),'v6-recent-blocked-01',{},strippedOf(recentSpec)),V6_QUALITY_CASES,0)
  expect(checks.verdict).toBe('passed')
  expect(checks.reasons).toContain('check-failures:1')
  expect(checks.lower.dimensions.recent).toBe(28)
  expect(checks.gates.evidence).toBe(true)
  expect(v6CaseScore(recentSpec,strippedOf(recentSpec))).toBe(0.5)
  // revision 11 起：entry 期望的例子若机械证据已证明正确分类条目落地，标注布尔不再打折（见分类护栏用例）。
  const entrySpec=byId('v6-scope-01')
  expect(v6Summary(patch(happy(),'v6-scope-01',{},strippedOf(entrySpec)),V6_QUALITY_CASES,0).lower.dimensions.fact).toBe(20)
  expect(v6CaseScore(entrySpec,strippedOf(entrySpec))).toBe(0.5)
 })
 it('第二标注分歧进上下界，证据不足仍判未知', () => {
  const spec=byId('v6-correction-01'),primary=fullReview(spec)
  const disagreed={...fullReview(spec),correct:0,omitted:primary.correct,annotator:{...annotator,identity:'review-B'}}
  const bounds=v6CaseBounds(spec,{review:primary,reviewAlt:disagreed})
  expect(bounds.disagreement).toBe(true)
  expect(bounds.lower).toBe(0)
  expect(bounds.upper).toBe(1)
  expect(v6CaseBounds(spec,{review:primary,reviewAlt:null})).toMatchObject({lower:1,upper:1,disagreement:false})
  expect(v6CaseBounds(spec,{review:null,reviewAlt:primary}).lower).toBe(0)
  const missing={...fullReview(spec),evidenceComplete:false,uncertainty:['no-model-output']}
  expect(v6CaseBounds(spec,{review:missing,reviewAlt:null})).toMatchObject({lower:null,upper:null,disagreement:false})
  const summary=v6Summary(patch(happy(),'v6-correction-01',{},primary,disagreed),V6_QUALITY_CASES,0)
  expect(summary.reasons).toContain('annotation-disagreement:1')
  expect(summary.lower.dimensions.update).toBeLessThan(summary.upper.dimensions.update)
 })
 it('零模型调用单独计数，不与派发混为一谈', () => {
  const summary=v6Summary(patch(happy(),'v6-chain-beta-5',{calls:0,terminal:false,structured:false}),V6_QUALITY_CASES,0)
  expect(summary.reasons).toContain('zero-call:1')
  expect(summary.zeroCall).toBe(1)
  expect(summary.metrics.D).toBe(30)
  expect(summary.metrics.T).toBe(29)
 })
 it('链内受阻步骤保留原权重并计未知、派发与覆盖', () => {
  const rows=patch(happy(),'v6-chain-beta-2',
   {blocked:true,structured:false,terminal:false,category:'insufficient-evidence'},unassessable(byId('v6-chain-beta-2'),'no-model-output'))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.blocked).toBe(1)
  expect(summary.lower.dimensions.recent).toBe(29)
  expect(summary.upper.dimensions.recent).toBe(30)
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
  expect(v6ReviewValid(spec,{...fullReview(spec),rubricVersion:0})).toBe(false)
 })
 it('非评分类别即使有完整标注也不进语义分', () => {
  const spec=byId('v6-fact-01')
  const rows=patch(happy(),spec.id,{category:'format'},fullReview(spec))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.lower.dimensions.fact).toBe(16)
  expect(summary.upper.dimensions.fact).toBe(20)
  expect(summary.coverage.directions.fact.judged).toBe(4)
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
  expect(v6TerminalCategory({result:{receipt:{outcome:'rejected',reason:'MEMORY_SOURCE_CHANGED'}}})).toBe('source')
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

it('historical replay binds missing inner hashes only to a verified old outer envelope',async()=>{
 const {v6BoundReview}=await import('../../scripts/memory-quality-support.ts'),spec=V6_QUALITY_CASES[0]!,binding={key:'fiction/r9/model/0/case',frozenHash:'frozen',resultHash:'result',rulesHash:'rules'}
 const original={...binding,review:fullReview(spec)}
 const missing=structuredClone(original);for(const key of ['frozenHash','resultHash','rulesHash'] as const)delete (missing.review as Partial<V6Annotation>)[key]
 const before=JSON.stringify(missing),view=v6BoundReview(missing,binding,{replay:true,revision:9})
 expect(v6ReviewValid(spec,view.review)).toBe(true)
 expect(view.review).toMatchObject({frozenHash:'frozen',resultHash:'result',rulesHash:'rules'})
 expect(view.historicalBinding).toEqual({binding:'verified-outer-envelope',originalInnerEvidence:false,missingInnerHashes:['frozenHash','resultHash','rulesHash']})
 expect(JSON.stringify(missing)).toBe(before)
 expect(()=>v6BoundReview(missing,binding,{replay:false,revision:9})).toThrow('EVALUATION_ANNOTATION_INVALID')
 expect(()=>v6BoundReview(missing,binding,{replay:true,revision:10})).toThrow('EVALUATION_ANNOTATION_INVALID')
 expect(v6BoundReview(original,binding,{replay:false,revision:10}).historicalBinding).toBeUndefined()
})
it.each(['inner-conflict','inner-null','outer-conflict','outer-missing','outer-key','revision-missing'] as const)('historical replay never replaces conflicting or unbound evidence (%s)',async mode=>{
 const {v6BoundReview}=await import('../../scripts/memory-quality-support.ts'),binding={key:'fiction/r9/model/0/case',frozenHash:'frozen',resultHash:'result',rulesHash:'rules'},annotation:any={...binding,review:fullReview(V6_QUALITY_CASES[0]!)}
 delete annotation.review.resultHash;delete annotation.review.rulesHash
 if(mode==='inner-conflict')annotation.review.frozenHash='conflicting'
 if(mode==='inner-null')annotation.review.frozenHash=null
 if(mode==='outer-conflict')annotation.resultHash='conflicting'
 if(mode==='outer-missing')delete annotation.rulesHash
 if(mode==='outer-key')annotation.key='different-case'
 if(mode==='revision-missing')delete annotation.review.frozenHash
 expect(()=>v6BoundReview(annotation,binding,{replay:true,revision:mode==='revision-missing'?NaN:9})).toThrow('EVALUATION_ANNOTATION_INVALID')
})

it.each(['success','failure','unknown'] as const)('explicit action state is authoritative when the legacy boolean is absent (%s)',state=>{
 const spec=byId('v6-correction-01'),baseline=v6Summary(happy(),V6_QUALITY_CASES,0),summary=v6Summary(patch(happy(),spec.id,{actionState:state,actionVerified:undefined}),V6_QUALITY_CASES,0)
 expect(summary.judgeable).toBe(state==='unknown'?29:30)
 expect(summary.lower.dimensions.update).toBe(baseline.lower.dimensions.update-(state==='success'?0:spec.weight))
 expect(summary.upper.dimensions.update).toBe(baseline.upper.dimensions.update-(state==='failure'?spec.weight:0))
 expect(summary.actionFailures).toBe(state==='failure'?1:0)
 expect(summary.coverage.directions.update.judged).toBe(state==='unknown'?4:5)
 expect(summary.unknown).toBe(state==='unknown'?1:0)
})


describe('包4统一双标门及机械失败边界',()=>{
 const secondary=(spec:V6Case)=>({...fullReview(spec),annotator:{...annotator,identity:'independent-B',participatedInDesign:false}})
 it('任意十例双标不能替代冻结 required ID，缺失结果也必须计入缺覆盖',()=>{
  const required=V6_QUALITY_CASES[20]!.id,rows=happy().map((r,i)=>({...r,reviewAlt:i<10?secondary(V6_QUALITY_CASES[i]!):null}))
  const summary=v6Summary(rows,V6_QUALITY_CASES,0,{doubleRequired:[required]} as any)
  expect((summary as any).doubleReview).toMatchObject({minimum:10,double:10,doubleGate:false,requiredIds:[required],missingRequiredIds:[required]})
  expect(summary.gates.evidence).toBe(false)
  expect(summary.verdict).toBe('insufficient-evidence')
  const absent=v6Summary(rows.filter(r=>r.caseId!==required),V6_QUALITY_CASES,0,{doubleRequired:[required]} as any)
  expect((absent as any).doubleReview.missingRequiredIds).toEqual([required])
 })
 it('首轮已知动作失败缺 required 副标，即使质量仍达门也禁止第二轮',()=>{
  const spec=byId('v6-correction-01'),rows=patch(happy(),spec.id,{actionState:'failure',actionVerified:undefined,reviewAlt:null})
  const summary=v6Summary(rows,V6_QUALITY_CASES,0,{doubleRequired:[spec.id]})
  expect(summary.lower.total).toBe(90);expect(summary.upper.total).toBe(90)
  expect(summary.gates.qualityLower).toBe(true);expect(summary.doubleReview.double).toBeGreaterThanOrEqual(10)
  expect(()=>v6DispatchGate(rows,V6_QUALITY_CASES[0]!.id,1,V6_QUALITY_CASES,{doubleRequired:[spec.id]})).toThrow('EVALUATION_ROUND_REQUIRED')
 })
 it('必需案例齐全仍需至少十例，非法冻结名单拒绝',()=>{
  const rows=happy().map((r,i)=>({...r,reviewAlt:i<9?secondary(V6_QUALITY_CASES[i]!):null})),required=V6_QUALITY_CASES[0]!.id
  expect(v6Summary(rows,V6_QUALITY_CASES,0,{doubleRequired:[required]}).doubleReview).toMatchObject({double:9,missingRequiredIds:[],doubleGate:false})
  expect(()=>v6Summary(rows,V6_QUALITY_CASES,0,{doubleRequired:['not-in-frozen-cases']})).toThrow('EVALUATION_DOUBLE_POLICY_INVALID')
  expect(()=>v6Summary(rows,V6_QUALITY_CASES,0,{doubleRequired:[required,required]})).toThrow('EVALUATION_DOUBLE_POLICY_INVALID')
 })
 it('同身份或不完整副标不计双标覆盖，合法独立双标计入统一门',()=>{
  const required=V6_QUALITY_CASES[20]!.id,rows=happy().map((r,i)=>({...r,reviewAlt:secondary(V6_QUALITY_CASES[i]!)}))
  expect((v6Summary(rows,V6_QUALITY_CASES,0,{doubleRequired:[required]} as any) as any).doubleReview.doubleGate).toBe(true)
  for(const reviewAlt of [fullReview(V6_QUALITY_CASES[20]!),{...secondary(V6_QUALITY_CASES[20]!),evidenceComplete:false,uncertainty:['no-model-output']},{...secondary(V6_QUALITY_CASES[20]!),resultHash:'conflicting-result'}]){
   const summary=v6Summary(patch(rows,required,{reviewAlt}),V6_QUALITY_CASES,0,{doubleRequired:[required]} as any)
   expect((summary as any).doubleReview.missingRequiredIds).toEqual([required])
   expect(summary.gates.evidence).toBe(false)
  }
  expect((v6Summary(rows,V6_QUALITY_CASES,0) as any).doubleReview.policy).toBe('legacy-minimum')
 })
 it.each(['failure','unknown','success'] as const)('缺副标独立证据不足与动作确定性分别记录 (%s)',state=>{
  const spec=byId('v6-correction-01'),summary=v6Summary([row(spec,{actionState:state,actionVerified:undefined,doubleRequired:true,reviewAlt:null})],[spec],0,{doubleRequired:[spec.id]} as any)
  expect(summary.lower.total).toBe(0)
  expect(summary.upper.total).toBe(state==='failure'?0:spec.weight)
  expect(summary.judgeable).toBe(state==='failure'?1:0)
  expect(summary.unknown).toBe(state==='failure'?0:1)
  expect(summary.actionFailures).toBe(state==='failure'?1:0)
  expect((summary as any).doubleReview.doubleGate).toBe(false)
  expect((summary as any).doubleReview.missingRequiredIds).toEqual([spec.id])
  expect(summary.gates.evidence).toBe(false)
 })
 it('真实输入依赖容量拒绝归 capacity，部分成功仍优先归 partial-commit',()=>{
  expect(v6TerminalCategory({responses:[],result:{receipt:{outcome:'rejected',reason:'MEMORY_INPUT_LIMIT'},entries:[],recent:[]}})).toBe('capacity')
  expect(v6TerminalCategory({result:{receipt:{outcome:'applied',reason:'MEMORY_INPUT_LIMIT',results:[{outcome:'applied'},{outcome:'rejected'}]},entries:[{id:'saved'}]}})).toBe('partial-commit')
 })
 it('所选模型暂停未终态收费请求，另一模型仍可派发且已收费请求不能重派',async()=>{
  const support=await import('../../scripts/memory-quality-support.ts') as any,prefix='fiction/integrity/r10/',a=prefix+'A/0/case',b=prefix+'B/0/case'
  const journal={dispatchKeys:()=>[a],charged:(k:string)=>k===a?1:0,read:()=>null}
  expect(()=>support.v6AssertDispatchAvailable(journal,prefix,'A',prefix+'A/0/new',()=>false)).toThrow('EVALUATION_CHARGED_UNFINISHED')
  expect(()=>support.v6AssertDispatchAvailable(journal,prefix,'B',b,()=>false)).not.toThrow()
  expect(()=>support.v6AssertDispatchAvailable(journal,prefix,'A',a,()=>true)).toThrow('EVALUATION_ATTEMPT_ALREADY_DISPATCHED')
 })
 it('报告分别绑定实际规则案例、旧冻结和主副原证据及评分view',async()=>{
  const support=await import('../../scripts/memory-quality-support.ts') as any,binding={key:'fiction/r9/A/0/case',frozenHash:'frozen',resultHash:'result',rulesHash:'old-rules'},original:any={...binding,review:{...fullReview(V6_QUALITY_CASES[0]!),rulesHash:'old-rules'}}
  delete original.review.rulesHash;const before=JSON.stringify(original),view=support.v6BoundReview(original,binding,{replay:true,revision:9})
  expect(view.evidence).toMatchObject({annotationHash:support.fingerprint(original),originalReviewHash:support.fingerprint(original.review),scoringViewHash:support.fingerprint(view.review),annotator:original.review.annotator,...binding})
  expect(view.evidence.originalReviewHash).not.toBe(view.evidence.scoringViewHash)
  expect(JSON.stringify(original)).toBe(before)
  expect(support.v6AppliedEvidence({rules:'old-rules',dataset:'old-cases'},V6_QUALITY_CASES)).toEqual({frozenRulesHash:'old-rules',frozenDatasetHash:'old-cases',appliedRulesHash:support.fingerprint(V6_RULES),appliedDatasetHash:support.fingerprint(V6_QUALITY_CASES)})
 })
 it('chain dimension projection is read-only and does not change official floors',async()=>{
  const support=await import('../../scripts/memory-quality-support.ts')
  expect(support.v6TrueDimension(byId('v6-chain-alpha-1'))).toBe('standing')
  expect(support.v6TrueDimension(byId('v6-chain-beta-3'))).toBe('fact')
  expect(support.v6TrueDimension(byId('v6-chain-alpha-4'))).toBe('update')
  expect(support.v6TrueDimension(byId('v6-recent-progress-01'))).toBe('recent')
  const official=support.v6Summary(happy(),V6_QUALITY_CASES,0)
  const projection=support.v6ChainDimensionProjection(happy(),V6_QUALITY_CASES,0)
  expect(official.lower.dimensions.recent).toBe(30)
  expect(projection.official.recent).toMatchObject({earned:30,max:30,meets:true})
  expect(projection.projected.recent.max).toBe(23)
  expect(projection.projected.recent.earned).not.toBe(30)
  expect(projection.recentFloorStillBroken).toBe(false)
  expect(projection.note).toContain('不是认证成绩')
 })
 it('scope-01 金标跨轮正文相同，新口径稳定为分类失败加 0.5', () => {
  for(const round of V6_SCOPE_01_ROUNDS){
   expect(round.standing).toBe(V6_SCOPE_01_STANDING)
   expect(round.fact).toBe(V6_SCOPE_01_FACT)
  }
  const spec=byId('v6-scope-01')
  const scored=v6CaseScore(spec,{...fullReview(spec),correct:2,omitted:0,wrongNew:0,checks:{attributionAndScope:false,noUnsupportedContent:true,noForbiddenContent:true}})
  expect(scored).toBe(0.5)
 })
 it('r12 DeepSeek 第二轮只读投影：revision 11 护栏把事实维拉回地板，投影转为达门（不是认证成绩）', () => {
  const annotatorB={identity:'support-retest-secondary-agent',kind:'agent' as const,participatedInDesign:true,modelNameMasked:true,humanReviewed:false}
  const rows=projection.rows.map(item=>{
   const spec=byId(item.caseId)
   const review={...fullReview(spec),correct:item.correct,omitted:item.omitted,wrongNew:item.wrongNew,checks:{attributionAndScope:item.attributionAndScope,noUnsupportedContent:item.noUnsupportedContent,noForbiddenContent:item.noForbiddenContent},evidenceComplete:item.evidenceComplete,annotator:{...annotator,identity:'support-retest-primary-agent'}}
   return row(spec,{round:1,dispatched:true,terminal:true,structured:item.structured,actionVerified:item.actionVerified,category:item.category as V6Row['category'],receiptReason:item.receiptReason??undefined},review)
  }).map(r=>({...r,reviewAlt:r.review?{...structuredClone(r.review),annotator:annotatorB}:null}))
  const summary=v6Summary(rows,V6_QUALITY_CASES,1)
  expect(summary.reliability).toMatchObject({p:28,n:28,passed:true})
  // revision 10 复算下事实维只有 10／20：scope-01 同时落了 standing 与 fact，fact 覆盖期望单元，
  // 却因标注布尔被判分类项失败。revision 11 的机械护栏按试卷自述撤销这次打折，事实维回到 12／20 地板。
  expect(summary.lower.dimensions.fact).toBe(12)
  expect(summary.gates.qualityLower).toBe(true)
  expect(summary.verdict).toBe('passed')
  // 原冻结成绩与判定一字不改：官方仍是 failed，事实维 8／20。
  expect(projection.official).toMatchObject({verdict:'failed',lower:82.7,fact:8,reliability:'28/30'})
})
})

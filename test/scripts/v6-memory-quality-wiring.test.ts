import {describe,expect,it,vi} from 'vitest'
import {testTimeoutMs} from '../../vitest.config.ts'
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
 EvaluationJournal,V6_PREFIX,V6_RULES,freezeV6,v6DispatchGate,v6RecoveryDecision,v6Summary,v6TerminalCategory,type V6Annotation,type V6Row
} from '../../scripts/memory-quality-support.ts'
import {V6_QUALITY_CASES} from '../fixtures/v6-memory-quality.ts'
import type {V6Case} from '../fixtures/v6-memory-quality.ts'
import {runMemoryQualityCase,v6ActionEvidence,v6MechanicalAction} from '../../scripts/memory-quality-runner.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))

const annotator={identity:'review-agent-A',kind:'agent' as const,participatedInDesign:true,modelNameMasked:true,humanReviewed:false}
const fullReview=(spec:V6Case):V6Annotation=>({
 correct:spec.expected.units.length,omitted:0,wrongNew:0,hardViolations:[],
 checks:{attributionAndScope:true,noUnsupportedContent:true,noForbiddenContent:true},
 evidenceComplete:true,uncertainty:[],annotator,rulesHash:'rules',resultHash:'result',frozenHash:'frozen',rubricVersion:1
})
const byId=(id:string):V6Case=>{
 const found=V6_QUALITY_CASES.find(c=>c.id===id)
 if(!found)throw Error('unknown case '+id)
 return found
}
const row=(spec:V6Case,over:Partial<V6Row>={},a:V6Annotation|null=fullReview(spec)):V6Row=>({
 caseId:spec.id,round:0,dispatched:true,terminal:true,structured:true,actionVerified:true,category:'valid',review:a,reviewAlt:a?{...structuredClone(a),annotator:{...a.annotator,identity:'review-agent-B',participatedInDesign:false}}:null,...over
})
const happy=()=>V6_QUALITY_CASES.map(c=>row(c))
/** 未命中必留单元：该例计分为 0，但不触发即时否决。 */
const missing=(spec:V6Case):V6Annotation=>({...fullReview(spec),correct:0,omitted:spec.expected.units.length})
const patch=(rows:V6Row[],id:string,over:Partial<V6Row>,review?:V6Annotation|null)=>rows.map(r=>{if(r.caseId!==id)return r;const a=review===undefined?Object.hasOwn(over,'review')?over.review:r.review:review;return {...r,...over,review:a??null,reviewAlt:a?{...structuredClone(a),annotator:{...a.annotator,identity:'review-agent-B',participatedInDesign:false}}:null}})

describe('v6 冻结与派发门', () => {
 it('冻结单不可覆盖且指纹稳定', () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'rgent-v6-freeze-'))
  try{
   const manifest={version:6,authorization:'2026-10-05-v6',cases:V6_QUALITY_CASES.map(c=>c.id),weights:'weights',rules:'rules',maxCalls:V6_RULES.history.campaignLimit}
   const first=freezeV6(root,manifest)
   expect(first).toMatch(/^[a-f0-9]{64}$/)
   expect(freezeV6(root,manifest)).toBe(first)
   expect(JSON.parse(readFileSync(path.join(root,'v6-manifest.json'),'utf8'))).toEqual(manifest)
   expect(()=>freezeV6(root,{...manifest,rules:'changed'})).toThrow('EVALUATION_REVISION_CHANGED')
   expect(JSON.parse(readFileSync(path.join(root,'v6-manifest.json'),'utf8'))).toEqual(manifest)
  }finally{rmSync(root,{recursive:true,force:true})}
 })
 it('逐例标注完成前不派发下一例，第一轮失败不进第二轮，案例必须在试卷内', () => {
  const rest=happy().filter(r=>r.caseId!=='v6-standing-01')
  expect(()=>v6DispatchGate(rest,'v6-standing-01',0,V6_QUALITY_CASES)).not.toThrow()
  const unreviewed=[...rest,{...row(byId('v6-standing-01')),review:null}]
  expect(()=>v6DispatchGate(unreviewed,'v6-standing-03',0,V6_QUALITY_CASES)).toThrow('EVALUATION_REVIEW_REQUIRED')
  const failed=['v6-standing-01','v6-standing-03','v6-standing-08'].reduce((rows,id)=>patch(rows,id,{},missing(byId(id))),happy())
  expect(v6Summary(failed.filter(r=>r.round===0),V6_QUALITY_CASES,0).verdict).toBe('failed')
  expect(()=>v6DispatchGate(failed,'v6-standing-03',1,V6_QUALITY_CASES)).toThrow('EVALUATION_ROUND_REQUIRED')
  expect(()=>v6DispatchGate(happy(),'v6-chain-gamma-1',0,V6_QUALITY_CASES)).toThrow('EVALUATION_CASES_NOT_AUTHORIZED')
 })
})

describe('v6 计账与调用上限', () => {
 // 上限本身已按所有者授权抬到量级上限（1000／1000），所以这里用一组小数字验语义，不再依赖全局门槛。
 it('campaign 与每模型上限各自生效，且沿用同一份总账', () => {
  const budget=mkdtempSync(path.join(os.tmpdir(),'rgent-v6-journal-'))
  try{
   const historyCalls=V6_RULES.history.calls
   writeFileSync(path.join(budget,'state.json'),JSON.stringify({version:1,manifest:'parent-manifest',calls:historyCalls,limit:V6_RULES.history.parentLimit,dispatches:Array.from({length:historyCalls},(_,i)=>({key:'v5-2026-10-05/legacy/'+i,at:new Date(0).toISOString()}))}))
   const journal=new EvaluationJournal(path.join(budget,'v6'),{version:6},V6_RULES.history.parentLimit,budget,undefined,{parentManifestHash:'parent-manifest',prefix:V6_PREFIX,limit:4,perModelLimit:2})
   try{
    for(let i=0;i<2;i++)journal.charge(`${V6_PREFIX}MiniMax-M3/0/case-${i}`)
    expect(()=>journal.charge(`${V6_PREFIX}MiniMax-M3/0/overflow`)).toThrow('EVALUATION_MODEL_CALL_LIMIT')
    for(let i=0;i<2;i++)journal.charge(`${V6_PREFIX}deepseek-flash/0/case-${i}`)
    expect(journal.localCalls).toBe(4)
    expect(journal.calls).toBe(historyCalls+4)
    expect(()=>journal.charge(`${V6_PREFIX}MiniMax-M3/1/late`)).toThrow('EVALUATION_LOCAL_CALL_LIMIT')
    expect(()=>journal.charge('v5-2026-10-05/MiniMax-M3/0/mixed')).toThrow('EVALUATION_CAMPAIGN_KEY')
    const state=JSON.parse(readFileSync(path.join(budget,'state.json'),'utf8'))
    expect(state.calls).toBe(historyCalls+4)
    expect(state.limit).toBe(V6_RULES.history.parentLimit)
    expect(state.dispatches.length).toBe(state.calls)
   }finally{journal.close()}
  }finally{rmSync(budget,{recursive:true,force:true})}
 })
})

describe('v6 命令行只读路径', () => {
 const cli=path.join(process.cwd(),'scripts/check-memory.mjs')
 const run=(argv:string[])=>spawnSync(process.execPath,[cli,...argv],{cwd:process.cwd(),encoding:'utf8',timeout:10000})
  // 隔离构建、报告写盘与 Electron 派发，执行真实 CLI 的参数检查及 options 传递。
  // 不启动窗口，不读凭据，不读私人评测缓存，也不调用模型。
  const data=(source:string)=>'data:text/javascript,'+encodeURIComponent(source)
  const stubs={
   vite:data('export async function build(){}; export async function loadConfigFromFile(){return {config:{main:{define:{}}}}}'),
   'node:fs':data("export * from 'node:fs'; export const copyFileSync=()=>{}; export const mkdirSync=()=>{}"),
   'node:child_process':data("import {EventEmitter} from 'node:events'; export function spawn(_file,_args,options){process.stdout.write('TEST_OPTIONS='+options.env.RGENT_MEMORY_EVAL_OPTIONS+'\\n');const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>true;setImmediate(()=>child.emit('exit',0));return child}")
  }
  const loader=data(`const stubs=${JSON.stringify(stubs)};export async function resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/check-memory.mjs')&&stubs[specifier])return {url:stubs[specifier],shortCircuit:true};return next(specifier,context)}`)
  const bootstrap=data(`import {register} from 'node:module';register(${JSON.stringify(loader)},import.meta.url)`)
  const isolated=(argv:string[],cwd=process.cwd())=>spawnSync(process.execPath,['--import',bootstrap,cli,...argv],{cwd,encoding:'utf8',timeout:10000})
 it('相对路径按调用目录解析，不把报告路径交给 Electron 后误报启动超时', () => {
  const temporary=mkdtempSync(path.join(os.tmpdir(),'rgent-evaluation-relative-'))
  try{
   const result=isolated(['--report','reports','--profile','profile','--annotation','labels.json','--budget','budget'],temporary)
   expect(result.status).toBe(0)
   const transmitted=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('TEST_OPTIONS='))!.slice('TEST_OPTIONS='.length))
   for(const [key,relative] of Object.entries({report:'reports',profile:'profile',annotation:'labels.json',budget:'budget'}))expect(transmitted[key]).toBe(path.join(realpathSync(temporary),relative))
  }finally{rmSync(temporary,{recursive:true,force:true})}
 })
 it('路径参数缺值或下一项是开关时，在构建和派发前明确拒绝', () => {
  for(const flag of ['--report','--profile','--annotation','--budget']){
   for(const rest of [[],['--v6']]){
    const result=isolated([flag,...rest])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('EVALUATION_PATH_REQUIRED')
   }
  }
 })
 it('帮助文本列出 v6 用法，v6 拒绝付费筛查与错误组合', () => {
  const help=run(['--v6','--help'])
  expect(help.status).toBe(0)
  expect(help.stdout).toContain('--v6')
  const screen=run(['--v6','--screen'])
  expect(screen.status).toBe(1)
  expect(screen.stderr).toContain('EVALUATION_SCREEN_NOT_AUTHORIZED')
  const conflict=run(['--v6','--v5'])
  expect(conflict.status).toBe(1)
  expect(conflict.stderr).toContain('EVALUATION_MODE_CONFLICT')
  const legacyConflict=run(['--v6','--experiment-v4'])
  expect(legacyConflict.status).toBe(1)
  expect(legacyConflict.stderr).toContain('EVALUATION_MODE_CONFLICT')
 })
 it('每次只允许一个案例，轮次只接受 1|2，且都在启动子进程前拒绝', () => {
  const many=run(['--v6','--cases','v6-standing-01,v6-fact-01'])
  expect(many.status).toBe(1)
  expect(many.stderr).toContain('EVALUATION_ONE_ATTEMPT_REQUIRED')
  const badRound=run(['--v6','--round','3'])
  expect(badRound.status).toBe(1)
  expect(badRound.stderr).toContain('EVALUATION_ROUND_INVALID')
  expect(run(['--v6','--round','1','--help']).status).toBe(0)
 })
 it('v6 暴露 --resume 且不因此要求 profile', () => {
  expect(run(['--v6','--help']).stdout).toContain('--resume')
  const temporary=mkdtempSync(path.join(os.tmpdir(),'rgent-v6-resume-cli-'))
  let resumeWithoutProfile:ReturnType<typeof run>
  try{resumeWithoutProfile=run(['--v6','--resume','MiniMax-M3','--report',path.join(temporary,'fictional-report'),'--budget',path.join(temporary,'fictional-budget')])}finally{rmSync(temporary,{recursive:true,force:true})}
  expect(resumeWithoutProfile.stderr).not.toContain('Explicit profile')
  // 无失败可恢复时按领域码拒绝，而不是当成缺少 profile。
  expect(resumeWithoutProfile.stderr).toMatch(/EVALUATION_(RESUME_NOT_REQUIRED|FREEZE_REQUIRED|REVISION_CHANGED)/)
 })
})
describe('v6 恢复周期与停损', () => {
 it('连续三次可重试网络失败才暂停，恢复周期用尽后必须由人决定', () => {
  const retryable=[{retryable:true},{retryable:true}]
  expect(v6RecoveryDecision([],0,2)).toBe('continue')
  expect(v6RecoveryDecision(retryable,0,2)).toBe('continue')
  expect(v6RecoveryDecision([...retryable,{retryable:true}],0,2)).toBe('pause')
  expect(v6RecoveryDecision([{retryable:true},{retryable:true},{retryable:false}],0,2)).toBe('continue')
  expect(v6RecoveryDecision([{retryable:true},{retryable:true},{retryable:true},{retryable:true}],1,2)).toBe('pause')
  expect(v6RecoveryDecision([{retryable:true},{retryable:true},{retryable:true}],2,2)).toBe('exhausted')
  expect(v6RecoveryDecision([{retryable:true},{retryable:true},{retryable:true}],3,2)).toBe('exhausted')
 })
})

describe('v6 指标与门', () => {
 it('环境故障未跑满时记未取得有效测量（环境），不判失败也不判通过', () => {
  const partial=happy().slice(0,12)
  const unavailable=v6Summary(partial,V6_QUALITY_CASES,0,{environmentUnavailable:true})
  expect(unavailable.metrics.D).toBe(12)
  expect(unavailable.metrics.D).toBeLessThan(unavailable.metrics.N)
  expect(unavailable.verdict).toBe('unmeasured-environment')
  const incomplete=v6Summary(partial,V6_QUALITY_CASES,0)
  expect(incomplete.reliability.passed).toBe(true)
  expect(incomplete.verdict).toBe('insufficient-evidence')
  const full=v6Summary(happy(),V6_QUALITY_CASES,0,{environmentUnavailable:true})
  expect(full.metrics.D).toBe(full.metrics.N)
  expect(full.verdict).toBe('passed')
 })
 it('四项指标按 N/D/T/P 计数，服务与输出失败分开', () => {
  let rows=happy()
  rows=patch(rows,'v6-standing-01',{dispatched:false,terminal:false,structured:false,category:'insufficient-evidence'},null)
  rows=patch(rows,'v6-standing-03',{dispatched:false,terminal:false,structured:false,category:'insufficient-evidence'},null)
  rows=patch(rows,'v6-fact-01',{terminal:false,structured:false,category:'service'},null)
  rows=patch(rows,'v6-scope-01',{structured:false,category:'format'},null)
  const summary=v6Summary(rows,V6_QUALITY_CASES,0)
  expect(summary.metrics).toMatchObject({N:30,D:28,T:27,P:26})
  expect(summary.metrics.dispatchedRate).toBeCloseTo(28/30,10)
  expect(summary.metrics.responseRate).toBeCloseTo(27/28,10)
  expect(summary.metrics.structuredRate).toBeCloseTo(26/27,10)
  expect(summary.reliability).toMatchObject({p:26,n:27,passed:true})
  expect(summary.metrics.overallRate).toBeCloseTo(26/27,10)
  expect(summary.serviceFailures).toBe(1)
  expect(summary.outputFailures).toBe(1)
  expect(summary.gates.reliability).toBe(true)
 })
 it('partial-commit 是独立终态：不计入服务失败，也不冒充完全成功', () => {
  const partial={status:'completed',responses:[{finishReason:'stop'}],result:{receipt:{outcome:'applied',results:[{outcome:'applied'},{outcome:'rejected'}]},entries:[{id:'a'}],recent:[]}}
  expect(v6TerminalCategory(partial)).toBe('partial-commit')
  const summary=v6Summary(patch(happy(),'v6-duplicate-01',{category:'partial-commit'}),V6_QUALITY_CASES,0)
  expect(summary.partialCommit).toBe(1)
  expect(summary.serviceFailures).toBe(0)
  expect(summary.verdict).toBe('passed')
 })
})

describe('v6 机械动作核对', () => {
 const spec=(over:Partial<{action:'add'|'correct'|'unchanged'|'conflict';semantic:'standing'|'fact';seed:any}>={}):any=>({id:'v6-action',group:'standing',heldOut:false,prompt:'p',body:'b',answer:'a',...(over.seed?{seed:over.seed}:{}),expected:{required:[],forbidden:[],notes:'',...(over.action?{action:over.action}:{}),...(over.semantic?{semantic:over.semantic}:{})}})
 const entry=(over:any={})=>({id:'e1',version:1,category:'long',status:'active',content:'旧结论',scope:'本库',semantic:'standing',updateBasis:{kind:'consolidation',id:'task-1',version:1},...over})
 const receipt=(over:any={})=>({outcome:'applied',entryIds:['e1'],results:[{action:'add',outcome:'applied'}],...over})
 it('无目标的未变动作以"什么都没新增"为准，临时要求长期化则不算通过', () => {
  const temporary=spec({action:'unchanged'})
  expect(v6MechanicalAction(temporary,{before:[],entries:[],receipt:{outcome:'rejected',entryIds:[]}})).toBe(true)
  expect(v6MechanicalAction(temporary,{before:[],entries:[entry({id:'new'})],receipt})).toBe(false)
 })
 it('有种子时按目标版本核对更正、保留与冲突暂缓', () => {
  const seed={content:'旧结论',layer:'demand',semantic:'standing',scope:'本库',attribution:'人'}
  const correct=spec({action:'correct',seed})
  expect(v6MechanicalAction(correct,{before:[entry()],entries:[entry({version:2,content:'新结论'})],receipt:receipt()})).toBe(true)
  expect(v6MechanicalAction(correct,{before:[entry()],entries:[entry(),entry({id:'dup',content:'另一条'})],receipt:receipt({entryIds:['dup']})})).toBe(false)
  const conflict=spec({action:'conflict',seed})
  expect(v6MechanicalAction(conflict,{before:[entry()],entries:[entry(),{id:'d1',version:1,status:'disputed',pendingTarget:{id:'e1',version:1}}],receipt:{outcome:'applied',entryIds:['d1']}})).toBe(true)
  expect(v6MechanicalAction(conflict,{before:[entry()],entries:[entry({version:2,content:'被覆盖'})],receipt:receipt()})).toBe(false)
 })
 it('近期块与长期新增都算动作落地，服务失败一律不算', () => {
  const add=spec({action:'add',semantic:'standing'})
  expect(v6MechanicalAction(add,{before:[],entries:[entry({id:'n1',semantic:'standing'})],receipt:{outcome:'applied',entryIds:['n1']}})).toBe(true)
  expect(v6MechanicalAction(add,{before:[],entries:[entry({id:'n1',semantic:'fact'})],receipt:{outcome:'applied',entryIds:['n1']}})).toBe(false)
  const recent=spec({action:'add'})
  expect(v6MechanicalAction(recent,{before:[],entries:[{id:'r1',category:'recent',status:'active',recent:{materialVersion:'m1'}}],receipt:{outcome:'applied',entryIds:['r1']}})).toBe(true)
  expect(v6MechanicalAction(recent,{before:[],entries:[{id:'r1',category:'recent',status:'active',recent:{materialVersion:'m1'}}],receipt:{outcome:'rejected',entryIds:[]}})).toBe(false)
 })
})

describe('v6 付费记录字段', () => {
 const credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
 it('派发、终态、结构化、候选与机械动作随真实生产回执透出', async() => {
  const spec={id:'v6-wiring-standing',group:'standing' as const,heldOut:false,prompt:'记住：本库以后先给结论再给依据。',body:'【虚构质量夹具】我已经决定本库以后先给结论再给依据。',answer:'未采纳的助手草稿。',expected:{required:[],forbidden:[],notes:'',action:'add' as const,semantic:'standing' as const}}
  const result=await runMemoryQualityCase(spec,credential,async function*(input){
   const payload=JSON.parse(String(input.messages[0]!.content))
   const command=payload.sources.find((source:any)=>source.classification==='command')
   yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'add',content:'本库先给结论再给依据',scope:'本库',sourceIds:[command.id],semantic:'standing',attribution:'人的口令',reviewAt:null,authority:[{sourceId:command.id,quote:String(command.text).slice(0,4)}]}]})}
   yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',verifyClosure:false})
  expect(result.completed).toBe(true)
  expect(result.dispatched).toBe(true)
  expect(result.terminal).toBe(true)
  expect(result.structured).toBe(true)
  expect(result.blocked).toBe(false)
  expect(result.actionVerified).toBe(true)
  expect(result.actionEvidence.finalTargets).toEqual(result.receipt!.entryIds.map(id=>({id,version:result.entries.find(e=>e.id===id)!.version})))
  expect(result.followup?.sent.length).toBe(1)
  expect(result.followup!.inputBudgetTokens).toBeGreaterThan(0)
  expect(result.controlled!.dispatch.actualHostBudget.inputBudgetTokens).toBe(result.followup!.inputBudgetTokens)
  expect(result.dependencies).toEqual(expect.arrayContaining(result.actionEvidence.finalTargets!.map(t=>expect.objectContaining(t))))
  expect(result.candidate.expectedTarget).toBeNull()
  expect(result.candidate.targetEligible).toBe(false)
  expect(result.candidate.snapshotHash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.candidate.failureOrigin).toBeNull()
  expect(result.candidate.secondary).toEqual([])
  expect(result.receipt?.outcome).toBe('applied')
 },testTimeoutMs)
 it('链式受阻时留证，取得终态但输出不可解析时记候选阶段失败', async() => {
  const spec={id:'v6-wiring-blocked',group:'fact' as const,heldOut:false,prompt:'总结虚构项目木舟的当前状态。',body:'【虚构质量夹具】木舟项目本周只完成了场地确认，下一步安排尚未讨论。',answer:'未采纳的助手草稿。',expected:{required:[],forbidden:[],notes:'',action:'unchanged' as const}}
  const result=await runMemoryQualityCase(spec,credential,async function*(input){
   const payload=JSON.parse(String(input.messages[0]!.content))
   yield {type:'text',text:payload.repair?'依然不是 JSON':'不是 JSON'}
   yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',verifyClosure:false,chainBlocked:true})
  expect(result.blocked).toBe(true)
  expect(result.followup?.sent.length).toBe(1)
  expect(result.dispatched).toBe(true)
  expect(result.terminal).toBe(true)
  expect(result.structured).toBe(false)
  expect(result.actionVerified).toBe(true)
  expect(result.candidate.failureOrigin).toBe('candidate')
  expect(result.candidate.secondary).toEqual([])
 },testTimeoutMs)
 it('合法空提议算取得完整结构化输出，近期块落地算动作完成', async() => {
  const spec={id:'v6-wiring-recent',group:'fact' as const,heldOut:false,prompt:'继续虚构项目青灯的核对工作。',body:'【虚构质量夹具】青灯项目本轮目标是核对五份样稿；已完成第 1、2 份的目录检查；第 3 份尚未开始。',answer:'未采纳的助手草稿。',expected:{required:[],forbidden:[],notes:'',action:'add' as const}}
  const result=await runMemoryQualityCase(spec,credential,async function*(input){
   const payload=JSON.parse(String(input.messages[0]!.content))
   yield {type:'text',text:JSON.stringify({recent:{goal:'青灯核对',completed:'第 1、2 份完成',blocked:'第 3 份未开始',next:'核对第 3 份',sourceIds:payload.sources.map((source:any)=>source.id),assistantDraft:false},proposals:[]})}
   yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',verifyClosure:false})
  expect(result.material.provenanceStatus).toBe('complete')
  expect(result.structured).toBe(true)
  expect(result.actionVerified).toBe(true)
  expect(result.receipt?.outcome).toBe('applied')
  expect(result.recent?.length).toBe(1)
  expect(result.entries.find((e:any)=>e.id===result.recent![0]!.id)?.status).toBe('active')
  expect(result.actionEvidence.finalTargets).toEqual([{id:result.recent![0]!.id,version:result.recent![0]!.version}])
  const provenance=result.followup?.ledger.chapter?.provenance
  expect(provenance?.version).toBe(2)
  expect(provenance?.version===2?provenance.memoryDeps.map(d=>({id:d.id,version:d.version})):null).toContainEqual({id:result.recent![0]!.id,version:result.recent![0]!.version})
  expect(result.candidate.failureOrigin).toBeNull()
 },testTimeoutMs)
})

it('完整性 campaign 跨修订按真实模型累计，两模型限额互不占用',()=>{
 const budget=mkdtempSync(path.join(os.tmpdir(),'rgent-v6-model-segment-')),prefix=V6_PREFIX+'integrity/'
 try{
  writeFileSync(path.join(budget,'state.json'),JSON.stringify({version:1,manifest:'parent',calls:0,limit:10,dispatches:[]}))
  const journal=new EvaluationJournal(path.join(budget,'r10'),{version:6},10,budget,undefined,{parentManifestHash:'parent',prefix,limit:4,perModelLimit:2,modelSegment:1})
  try{
   journal.charge(prefix+'r10/MiniMax-M3/0/a')
   journal.charge(prefix+'r11/MiniMax-M3/0/b')
   expect(()=>journal.charge(prefix+'r12/MiniMax-M3/0/c')).toThrow('EVALUATION_MODEL_CALL_LIMIT')
   expect(()=>journal.charge(prefix+'r10/deepseek-flash/0/a')).not.toThrow()
   expect(()=>journal.charge(prefix+'r11/deepseek-flash/0/b')).not.toThrow()
   expect(journal.localCalls).toBe(4)
   expect(()=>journal.charge(prefix+'r12/deepseek-flash/0/c')).toThrow('EVALUATION_LOCAL_CALL_LIMIT')
  }finally{journal.close()}
 }finally{rmSync(budget,{recursive:true,force:true})}
})

it('无种子链目标须由预注册前步关系解析，否则未知；更正目标排除辅助近期块',()=>{
 const spec=(expected:import('../fixtures/memory-quality.ts').MemoryQualityCase['expected']|Record<string,unknown>)=>({id:'case',group:'standing' as const,heldOut:false,prompt:'p',body:'b',answer:'a',expected:{required:[],forbidden:[],notes:'',...expected}})
 const prior={id:'target',version:1,category:'entry',status:'active',semantic:'standing',content:'旧顺序',scope:'本库',updateBasis:{kind:'consolidation',id:'quality-v6-chain-alpha-4'}}
 const unrelated={...prior,id:'other',updateBasis:{kind:'consolidation',id:'quality-other'}}
 const unchanged=spec({action:'unchanged',targetFromCase:'v6-chain-alpha-4',targetCategory:'entry'})
 expect(v6ActionEvidence(unchanged,{before:[prior,unrelated],entries:[prior,unrelated],targetTaskId:'quality-v6-chain-alpha-4',receipt:{taskId:'now',outcome:'applied',entryIds:[]}})).toMatchObject({finalTargets:[{id:'target',version:1}]})
 expect(v6ActionEvidence(spec({action:'unchanged'}),{before:[prior],entries:[prior],targetTaskId:'quality-v6-chain-alpha-4',receipt:{taskId:'now',outcome:'applied',entryIds:[]}}).state).toBe('unknown')
 const corrected={...prior,version:2,content:'新顺序',updateBasis:{kind:'consolidation',id:'now'}},recent={id:'aux',version:1,category:'recent',status:'active',recent:{}}
 const correct=spec({action:'correct',semantic:'standing',targetFromCase:'v6-chain-alpha-4',targetCategory:'entry'})
 expect(v6ActionEvidence(correct,{before:[prior],entries:[corrected,recent],targetTaskId:'quality-v6-chain-alpha-4',receipt:{taskId:'now',outcome:'applied',entryIds:['target','aux']}})).toMatchObject({finalTargets:[{id:'target',version:2}]})
 const conflict=spec({action:'conflict',targetFromCase:'v6-chain-beta-3',targetCategory:'entry'})
 const fact={...prior,semantic:'fact',updateBasis:{kind:'consolidation',id:'quality-v6-chain-beta-3'}}
 expect(v6ActionEvidence(conflict,{before:[fact],entries:[fact,{id:'pending',status:'disputed',pendingTarget:{id:'target',version:1}}],targetTaskId:'quality-v6-chain-beta-3',receipt:{taskId:'now',outcome:'applied',entryIds:['pending']}})).toMatchObject({finalTargets:[{id:'target',version:1}]})
 const addSpec=spec({action:'add',semantic:'fact',targetCategory:'entry'})
 const decided={id:'decision',version:2,category:'entry',status:'active',semantic:'fact',content:'银桥项目采用 A 方案',scope:'本库',updateBasis:{kind:'consolidation',id:'now'}}
 const priorDecision={...decided,version:1,content:'银桥尚无已批准安排'}
 expect(v6ActionEvidence(addSpec,{before:[priorDecision],entries:[decided],receipt:{taskId:'now',outcome:'applied',entryIds:['decision']}})).toMatchObject({passed:true,state:'success',finalTargets:[{id:'decision',version:2}]})
})

it('真实前置Host链用观测taskId解析后续目标并留证后置发送版本',async()=>{
 const base=mkdtempSync(path.join(os.tmpdir(),'rgent-v6-real-target-')),credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
 const first={id:'v6-chain-first',group:'standing' as const,heldOut:false,prompt:'记住本库项目记录先给结论后给依据。',body:'【虚构夹具】以后项目记录先给结论后给依据。',answer:'未采纳草稿',expected:{required:[],forbidden:[],notes:'',action:'add' as const,semantic:'standing' as const,targetCategory:'entry' as const}}
 try{
  const saved=await runMemoryQualityCase(first,credential,async function*(input){const payload=JSON.parse(String(input.messages[0]!.content)),command=payload.sources.find((v:any)=>v.classification==='command');yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'add',content:'本库项目记录先给结论后给依据',scope:'本库',sourceIds:[command.id],semantic:'standing',attribution:'人的口令',reviewAt:null,authority:[{sourceId:command.id,quote:String(command.text).slice(0,4)}]}]})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base,noteName:'first.md',hostBeforeConsolidation:true,verifyClosure:false})
  expect(saved.receipt!.taskId).not.toBe('quality-'+first.id)
  const second={...first,id:'v6-chain-repeat',prompt:'再确认一次刚才的项目记录约定，顺序没变。',body:'【虚构夹具】只是复述：先结论后依据，无新的改动。',expected:{required:[],forbidden:[],notes:'',action:'unchanged' as const,targetFromCase:first.id,targetCategory:'entry' as const}}
  const result=await runMemoryQualityCase(second,credential,async function*(){yield {type:'text',text:JSON.stringify({recent:null,proposals:[]})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base,noteName:'repeat.md',hostBeforeConsolidation:true,verifyClosure:false,targetTaskId:saved.receipt!.taskId})
  expect(result.actionEvidence).toMatchObject({state:'success',requiresLoad:true,finalTargets:saved.actionEvidence.finalTargets})
  expect(result.candidate.targetEligible).toBe(true)
  expect(result.candidate.targetShown).toBe(true)
  expect(result.candidate.expectedTarget).toBe(saved.actionEvidence.finalTargets![0]!.id+'@'+saved.actionEvidence.finalTargets![0]!.version)
  expect(result.dependencies).toEqual(expect.arrayContaining(result.actionEvidence.finalTargets!.map(t=>expect.objectContaining(t))))
  expect(result.followup!.inputBudgetTokens).toBeGreaterThan(0)
 }finally{rmSync(base,{recursive:true,force:true})}
},testTimeoutMs)


it('actual Electron runner options keep v5 historical non-chain saving and all new v6 Host saving explicit',async()=>{
 const {readFileSync}=await import('node:fs'),code=readFileSync(new URL('../../scripts/memory-quality-electron.ts',import.meta.url),'utf8')
 const foreground=(version:5|6,chain:boolean)=>{
  const start=code.indexOf('async function runV'+version+'('),end=version===5?code.indexOf('async function runV6('):code.length,section=code.slice(start,end)
  const marker="controller.signal,{strategy:'continuity'",at=section.indexOf(marker)+marker.indexOf('{');expect(section.includes(marker)).toBe(true)
  let depth=0,stop=at;for(;stop<section.length;stop++){if(section[stop]==='{')depth++;if(section[stop]==='}'&&--depth===0)break}
  const expression=section.slice(at,stop+1)
  return new Function('spec','model','root','path','targetTaskId','round','blocked','frozen','collaboration','return ('+expression+')')({id:'fiction',chain:chain?'alpha':undefined,step:1},{modelId:'fixture'},'/fiction',path,undefined,0,false,{revision:10},false).hostBeforeConsolidation
 }
 expect(foreground(5,false)).toBe(false);expect(foreground(5,true)).toBe(true)
 expect(foreground(6,false)).toBe(true);expect(foreground(6,true)).toBe(true)
})

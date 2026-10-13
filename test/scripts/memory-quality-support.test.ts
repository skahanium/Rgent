import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {afterEach,expect,it} from 'vitest'
import {V6_QUALITY_CASES} from '../fixtures/v6-memory-quality.ts'
import * as support from '../../scripts/memory-quality-support.ts'
const dirs:string[]=[];const dir=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'rgent-eval-journal-'));dirs.push(d);return d}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
it('charges calls durably before dispatch, caps resumed runs and rejects a second writer',()=>{
 expect(typeof support.EvaluationJournal).toBe('function')
 const root=dir(),manifest={version:1,runtime:'fixture',dataset:'fixture',models:['one']}
 const j=new support.EvaluationJournal(root,manifest,2)
 expect(()=>new support.EvaluationJournal(root,manifest,2)).toThrow('EVALUATION_BUSY')
 j.charge('one/case/0');j.close()
 const resumed=new support.EvaluationJournal(root,manifest,2);expect(resumed.calls).toBe(1)
 resumed.charge('one/case/1');expect(()=>resumed.charge('one/case/2')).toThrow('EVALUATION_CALL_LIMIT');resumed.close()
 expect(JSON.parse(readFileSync(path.join(root,'state.json'),'utf8')).calls).toBe(2)
 expect(()=>new support.EvaluationJournal(root,{...manifest,runtime:'different'},2)).toThrow('EVALUATION_REVISION_CHANGED')
})
it('never replaces a broken counter with zero or marks an unreviewed result as quality passed',()=>{
 const root=dir();writeFileSync(path.join(root,'state.json'),'{broken')
 expect(()=>new support.EvaluationJournal(root,{},1440)).toThrow('EVALUATION_STATE_INVALID')
 const report=support.qualitySummary([{group:'standing',required:1,retained:null,completed:true,evidenceComplete:true,hardViolations:[]}])
 expect(report.passed).toBe(false);expect(report.pending).toBe(1)
})
it('keeps failures in positive denominators and applies all three zero tolerance gates',()=>{
 const passing={group:'standing',required:1,retained:1,completed:true,evidenceComplete:true,hardViolations:[]}
 expect(support.qualitySummary([passing]).passed).toBe(true)
 expect(support.qualitySummary([passing,{...passing,completed:false,retained:0}]).passed).toBe(false)
 for(const violation of ['third-party','temporary','ambiguous'])expect(support.qualitySummary([{...passing,hardViolations:[violation]}]).passed).toBe(false)
})
it('changing the report directory cannot reset the campaign call ceiling',()=>{
 const budget=dir(),first=new support.EvaluationJournal(dir(),{campaign:'same'},2,budget)
 first.charge('one');first.close()
 const second=new support.EvaluationJournal(dir(),{campaign:'same'},2,budget)
 expect(second.calls).toBe(1);second.charge('two')
 expect(()=>second.charge('three')).toThrow('EVALUATION_CALL_LIMIT');second.close()
})
it('preserves interrupted attempts when publishing a resumed result',()=>{
 const root=dir(),j=new support.EvaluationJournal(root,{campaign:'resume'})
 j.charge('case');j.finish('case',{status:'interrupted',error:'cancelled'})
 j.charge('case');j.finish('case',{status:'completed',error:'failed'})
 expect(readdirSync(root).filter(f=>f.startsWith('attempt-'))).toHaveLength(2)
 expect(j.read('case')).toEqual({status:'completed',error:'failed'});expect(j.calls).toBe(2);j.close()
})
it('report failure does not reset or hide a charged request',()=>{
 const report=dir(),budget=dir(),j=new support.EvaluationJournal(report,{campaign:'write-failure'},2,budget)
 j.charge('case');rmSync(report,{recursive:true});writeFileSync(report,'blocked')
 expect(()=>j.finish('case',{status:'completed'})).toThrow();expect(j.calls).toBe(1);j.close()
 const next=new support.EvaluationJournal(dir(),{campaign:'write-failure'},2,budget)
 expect(next.calls).toBe(1);next.close()
})
it('requires every fixed case and all three trials, rejecting duplicate or mismatched reviews',()=>{
 const cases=[{id:'one',group:'standing',heldOut:true,expected:{required:['a']}}]
 const review={group:'standing',required:1,retained:1,completed:true,evidenceComplete:true,hardViolations:[]}
 const rows=[0,1,2].map(repeat=>({caseId:'one',repeat,review}))
 expect(support.modelQualitySummary(rows,cases).passed).toBe(true)
 expect(support.modelQualitySummary(rows.slice(0,2),cases).passed).toBe(false)
 expect(support.modelQualitySummary([...rows,rows[0]!],cases).passed).toBe(false)
 expect(support.modelQualitySummary(rows.map(r=>({...r,review:{...review,required:0}})),cases).passed).toBe(false)
 expect(support.modelQualitySummary(rows.map(r=>({...r,review:null})),cases).pending).toBe(3)
})
it('an explicitly authorized recipient correction preserves the old call count',()=>{
 const root=dir(),old={model:'MiniMax-M3',host:'api.minimax.io'},next={...old,host:'api.minimax.cn'}
 const j=new support.EvaluationJournal(root,old,2);j.charge('old-call');j.close()
 const corrected=new support.EvaluationJournal(root,next,2,root,old)
 expect(corrected.calls).toBe(1);corrected.charge('new-call')
 expect(()=>corrected.charge('extra')).toThrow('EVALUATION_CALL_LIMIT');corrected.close()
 expect(readdirSync(root).some(f=>f.startsWith('recipient-transition-'))).toBe(true)
 expect(()=>new support.EvaluationJournal(root,{...next,host:'other.test'},2,root,old)).toThrow('EVALUATION_REVISION_CHANGED')
})

it('reports each trial and never averages away a failing group',()=>{
 const cases=Array.from({length:120},(_,i)=>({id:String(i),group:'group-'+Math.floor(i/12),heldOut:i%12>=8,expected:{required:['a']}}))
 const rows=cases.flatMap((c,i)=>[0,1,2].map(repeat=>({caseId:c.id,repeat,review:{group:c.group,required:1,retained:repeat===0&&i<3?0:1,completed:true,evidenceComplete:true,hardViolations:[]}})))
 const report=support.modelQualitySummary(rows,cases)
 expect(report.rate).toBeGreaterThan(.95)
 expect(report.groups['group-0']!.rate).toBeGreaterThan(.9)
 expect(report.passed).toBe(false)
 expect(report.repeats.map(r=>r.repeat)).toEqual([0,1,2])
 expect(report.repeats.map(r=>r.passed)).toEqual([false,true,true])
 expect(report.repeats[0]!.groups['group-0']!.rate).toBe(.75)
 expect(report.repeats.map(r=>r.coverage)).toEqual([120,120,120])
})

it('counts one fully reviewed safe service failure as zero without imposing 100% success',()=>{
 const cases=Array.from({length:120},(_,i)=>({id:String(i),group:'group-'+Math.floor(i/12),heldOut:i%12>=8,expected:{required:['a']}}))
 const rows=cases.flatMap(c=>[0,1,2].map(repeat=>({caseId:c.id,repeat,review:{group:c.group,required:1,retained:1,completed:true,evidenceComplete:true,hardViolations:[] as string[],failure:undefined as string|undefined}})))
 rows[0]!.review={...rows[0]!.review,completed:false,retained:0,failure:'MEMORY_OUTPUT_INVALID'}
 const report=support.modelQualitySummary(rows,cases)
 expect(report.passed).toBe(true);expect(report.retained).toBe(359)
 expect(report.repeats[0]!.retained).toBe(119)
 expect(report.serviceFailures).toEqual({count:1,reasons:{MEMORY_OUTPUT_INVALID:1}})
 rows[0]!.review.evidenceComplete=false
 expect(support.modelQualitySummary(rows,cases)).toMatchObject({passed:false,pending:1})
 rows[0]!.review.evidenceComplete=true;rows[0]!.review.hardViolations=['wrong-source']
 expect(support.modelQualitySummary(rows,cases).passed).toBe(false)
})
it('cannot score a service failure as a correct negative rejection',()=>{
 const row={group:'temporary',required:0,retained:0,completed:false,evidenceComplete:true,hardViolations:[],failure:'MEMORY_OUTPUT_INVALID'}
 expect(support.qualitySummary([row])).toMatchObject({passed:false,pending:1})
 expect(support.qualitySummary([{...row,completed:true,failure:undefined}])).toMatchObject({passed:true,pending:0})
})
it('limits human evidence claims by recorded dispatch, terminal receipt and result evidence',()=>{
 const review={group:'standing',required:1,retained:1,completed:true,evidenceComplete:true,hardViolations:[]}
 const result={completed:false,before:[],entries:[],receipt:{taskId:'q',materialVersion:'v',outcome:'rejected',entryIds:[],reason:'MEMORY_OUTPUT_INVALID'},material:{taskId:'q',materialVersion:'v',fragments:[]}}
 const row={status:'completed',responses:[{body:'bad',input:{messages:[]},reason:null,finishReason:'stop'}],result,review}
 expect(support.recordedQualityReview(row)).toMatchObject({evidenceComplete:true,completed:false,retained:0,failure:'MEMORY_OUTPUT_INVALID'})
 for(const changed of [{status:'started'},{status:'interrupted'},{responses:[]},{result:undefined},{responses:[{body:'',input:{},reason:null}]},{result:{...result,receipt:{...result.receipt,materialVersion:'other'}}},{result:{...result,receipt:{...result.receipt,outcome:'running'}}}]){
  expect(support.recordedQualityReview({...row,...changed})?.evidenceComplete).toBe(false)
 }
 expect(support.recordedQualityReview({...row,result:{...result,receipt:{...result.receipt,outcome:'interrupted',reason:'MEMORY_DEADLINE'}}})).toMatchObject({evidenceComplete:true,completed:false})
 expect(support.recordedQualityReview({...row,result:{...result,receipt:{...result.receipt,outcome:'interrupted',reason:'MEMORY_CANCELLED'}}})).toMatchObject({evidenceComplete:false})
 expect(support.recordedQualityReview({...row,review:null})).toBeNull()
})

it('preserves manually verified retained content from partial applied proposals',()=>{
 const row={status:'completed',responses:[{body:'partial proposal output',input:{messages:[]},reason:null,finishReason:'stop'}],result:{completed:false,before:[],entries:[{id:'safe',content:'verified'}],receipt:{taskId:'q',materialVersion:'v',outcome:'applied',entryIds:['safe'],reason:'MEMORY_OUTPUT_INVALID'},material:{taskId:'q',materialVersion:'v',fragments:[]}},review:{group:'standing',required:1,retained:1,completed:false,evidenceComplete:true,hardViolations:[]}}
 const review=support.recordedQualityReview(row)!
 expect(review).toMatchObject({completed:false,evidenceComplete:true,retained:1})
 expect(support.qualitySummary([review])).toMatchObject({passed:true,retained:1,serviceFailures:{count:1}})
})

it('keeps unassessable transport failures pending without calling a null review malformed',()=>{
 const cases=[{id:'negative',group:'ai',heldOut:true,expected:{required:[]}}]
 const rows=[0,1,2].map(repeat=>({caseId:'negative',repeat,review:{group:'ai',required:0,retained:null,completed:false,evidenceComplete:false,hardViolations:[],failure:'MEMORY_UNAVAILABLE'}}))
 expect(support.modelQualitySummary(rows,cases)).toMatchObject({valid:true,passed:false,pending:3,coverage:3})
 expect(support.modelQualitySummary(rows.map(r=>({...r,review:{...r.review,retained:-1}})),cases).valid).toBe(false)
})

it('freezes v4 sixty development cases and six screening identities; subsets never change the universe',()=>{
 const cases=support.v4Cases()
 expect(cases).toHaveLength(60);expect(cases.every(c=>!c.heldOut&&Number(c.id.slice(-2))<=6)).toBe(true)
 expect(support.v4Selection(['standing-01'],true).map(c=>c.id)).toEqual(['standing-01'])
 expect(()=>support.v4Selection(['standing-09'],false)).toThrow('EVALUATION_CASES_NOT_AUTHORIZED')
 expect(()=>support.v4Selection(['fact-01'],true)).toThrow('EVALUATION_CASES_NOT_AUTHORIZED')
 expect(support.V4_RULES.applyDenominator).toContain('add/correct')
})
it('charges v4 against the unchanged historical manifest with local and per-model ceilings, including failures',()=>{
 const budget=dir(),old={old:'formal'},j=new support.EvaluationJournal(dir(),old,1440,budget)
 j.charge('old');j.close();const original=JSON.parse(readFileSync(path.join(budget,'state.json'),'utf8')).manifest
 const q=new support.EvaluationJournal(dir(),{q:'frozen'},1440,budget,undefined,{parentManifestHash:original,prefix:'q/',limit:2,perModelLimit:1})
 q.charge('q/one/case/baseline/0')
 expect(()=>q.charge('q/one/other/review/0')).toThrow('EVALUATION_MODEL_CALL_LIMIT')
 q.charge('q/two/case/baseline/0');expect(()=>q.charge('q/three/case/0')).toThrow('EVALUATION_LOCAL_CALL_LIMIT')
 expect(q.charged('q/one/case/baseline/0')).toBe(1);q.close()
 expect(JSON.parse(readFileSync(path.join(budget,'state.json'),'utf8')).manifest).toBe(original)
 const resumed=new support.EvaluationJournal(dir(),{q:'frozen'},1440,budget,undefined,{parentManifestHash:original,prefix:'q/',limit:2,perModelLimit:1})
 expect(resumed.calls).toBe(3);expect(resumed.localCalls).toBe(2);resumed.close()
})
it('freezing is immutable and incomplete reviewed coverage cannot be claimed as sixty-case pass',()=>{
 const root=dir(),manifest={dataset:'fixed'}
 support.freezeV4(root,manifest);support.freezeV4(root,manifest)
 expect(()=>support.freezeV4(root,{dataset:'changed'})).toThrow('EVALUATION_REVISION_CHANGED')
 const spec=support.v4Cases()[0]!
 const row={caseId:spec.id,arm:'review' as const,category:'valid' as const,automaticApplied:true,review:{retained:spec.expected.required.length,hardViolations:[],correctNoop:false,evidenceComplete:true}}
 expect(support.v4Summary([row],support.v4Cases()).worthContinuing).toBe(false)
 expect(support.v4Summary([row],support.v4Cases()).coverage).toBe(1)
})
it('v4 scores semantic rejection and safe empty separately, counts mistaken applied positives, and keeps service denominator',()=>{
 const cases=support.v4Cases().filter(c=>['standing-01','temporary-01'].includes(c.id))
 const rows:support.V4Row[]=cases.flatMap(c=>['baseline','review'].map(arm=>({caseId:c.id,arm:arm as 'baseline'|'review',category:c.group==='temporary'?'semantic-rejected' as const:'valid' as const,automaticApplied:c.group==='standing',review:{retained:c.expected.required.length,hardViolations:[],correctNoop:c.group==='temporary',evidenceComplete:true}})))
 expect(support.v4Summary(rows,cases).arms.review).toMatchObject({service:0,semanticRejected:1,automaticApplied:1,applyDenominator:1,correctNoop:1})
 rows[1]!.review!.hardViolations.push('wrong-attribution')
 expect(support.v4Summary(rows,cases).decision).toBe('stop')
 rows[1]!.category='service';rows[1]!.review={retained:0,hardViolations:[],correctNoop:false,evidenceComplete:false}
 expect(support.v4Summary(rows,cases).arms.review.retained).toBe(0)
 expect(support.v4Summary(rows,cases).decision).toBe('insufficient-evidence')
})

it('v4 resume never dispatches a charged unfinished arm and requires both arms reviewed before a new pair',()=>{
 expect(support.v4ResumeAction(0,null)).toBe('dispatch')
 expect(support.v4ResumeAction(1,null)).toBe('charged-unfinished')
 expect(support.v4ResumeAction(1,{status:'interrupted'})).toBe('done')
 expect(support.v4ResumeAction(2,{status:'completed'})).toBe('done')
 const one={caseId:'standing-01',arm:'baseline' as const,category:'valid' as const,automaticApplied:true,review:{retained:2,hardViolations:[],correctNoop:false,evidenceComplete:true}}
 expect(()=>support.v4DispatchGate([one],'correction-01')).toThrow('EVALUATION_REVIEW_REQUIRED')
 expect(()=>support.v4DispatchGate([one,{...one,arm:'review',category:'interrupted',review:null}],'correction-01')).toThrow('EVALUATION_REVIEW_REQUIRED')
 expect(()=>support.v4DispatchGate([one,{...one,arm:'review',review:{...one.review,hardViolations:['wrong-attribution']}}],'correction-01')).toThrow('EVALUATION_MODEL_STOPPED')
 expect(()=>support.v4DispatchGate([one,{...one,arm:'review'}],'correction-01')).not.toThrow()
})

it('v4 positive gates use standing fact correction and diagnostics score only paired sufficient outputs',()=>{
 const cases=support.v4Cases().filter(c=>['standing-01','scope-01'].includes(c.id))
 const rows: support.V4Row[]=cases.flatMap(c=>['baseline','review'].map(arm=>({caseId:c.id,arm:arm as 'baseline'|'review',category:'valid',automaticApplied:true,review:{retained:arm==='review'&&c.group==='standing'?0:c.expected.required.length,hardViolations:[],correctNoop:false,evidenceComplete:true}})))
 const q=support.v4Summary(rows,cases)
 expect(q.arms.review.positive.rate).toBe(0);expect(q.decision).toBe('stop')
 rows.find(r=>r.caseId==='standing-01'&&r.arm==='review')!.category='service';rows.find(r=>r.caseId==='standing-01'&&r.arm==='review')!.review=null
 const limited=support.v4Summary(rows,cases)
 expect(limited.diagnostic.pairedCases).toEqual(['scope-01'])
 expect(limited.diagnostic.arms.review.rate).toBe(1)
 expect(limited.arms.review.rate).toBeLessThan(1)
})

it('v4 remaining development samples require all six screening pairs with sufficient frozen reviews',()=>{
 expect(()=>support.v4ScreenGate([])).toThrow('EVALUATION_SCREEN_REVIEW_REQUIRED')
 const cases=support.v4Cases().filter(c=>support.V4_SCREEN.includes(c.id)),rows:support.V4Row[]=cases.flatMap(c=>['baseline','review'].map(arm=>({caseId:c.id,arm:arm as 'baseline'|'review',category:'valid',automaticApplied:!!c.expected.required.length,review:{retained:c.expected.required.length,hardViolations:[],correctNoop:false,evidenceComplete:true}})))
 expect(()=>support.v4ScreenGate(rows)).not.toThrow()
 expect(()=>support.v4ScreenGate(rows.slice(1))).toThrow('EVALUATION_SCREEN_REVIEW_REQUIRED')
 rows[1]!.review!.hardViolations=['forbidden-content']
 expect(()=>support.v4ScreenGate(rows)).toThrow('EVALUATION_MODEL_STOPPED')
})

it('v4 reports raw outcome categories and call use without conflating candidate, format and service rejection',()=>{
 const spec=support.v4Cases()[0]!,q=support.v4Summary([{caseId:spec.id,arm:'review',category:'candidate-rejected',automaticApplied:false,calls:2,latencyMs:120,receiptReason:'MEMORY_OUTPUT_INVALID',review:{retained:0,hardViolations:[],correctNoop:false,evidenceComplete:true}}],[spec])
 expect(q.arms.review).toMatchObject({service:0,format:0,candidateRejected:1,calls:2,latencyMs:120,categories:{'candidate-rejected':1},receiptReasons:{MEMORY_OUTPUT_INVALID:1}})
})

it('v4 accepts only categories compatible with their actual production terminal receipt',()=>{
 expect(support.v4TerminalCategory('safe-empty',{outcome:'applied',entryIds:[]})).toBe('safe-empty')
 expect(support.v4TerminalCategory('semantic-rejected',{outcome:'rejected',reason:'MEMORY_CONFIRMATION_REQUIRED',entryIds:[]})).toBe('semantic-rejected')
 expect(support.v4TerminalCategory('valid',{outcome:'rejected',reason:'MEMORY_OUTPUT_INVALID',entryIds:[]})).toBe('candidate-rejected')
 for(const reason of ['MEMORY_SOURCE_CHANGED','MEMORY_DEPENDENCY_CHANGED','MEMORY_CONFLICT','MEMORY_PERMISSION_CHANGED','MEMORY_MATERIAL_CHANGED','VAULT_CHANGED'])for(const category of ['valid','safe-empty','semantic-rejected'] as const)expect(support.v4TerminalCategory(category,{outcome:'rejected',reason,entryIds:[]})).toBe('insufficient-evidence')
 expect(support.v4TerminalCategory('semantic-rejected',{outcome:'applied',entryIds:[]})).toBe('insufficient-evidence')
 expect(support.v4TerminalCategory('safe-empty',{outcome:'rejected',reason:'MEMORY_OUTPUT_INVALID',entryIds:[]})).toBe('insufficient-evidence')
})

it('an insufficient terminal cannot earn E2E retention from an asserted true annotation',()=>{
 const spec=support.v4Cases()[0]!
 const q=support.v4Summary([{caseId:spec.id,arm:'review',category:'insufficient-evidence',automaticApplied:false,review:{retained:spec.expected.required.length,hardViolations:[],correctNoop:true,evidenceComplete:true}}],[spec])
 expect(q.arms.review).toMatchObject({retained:0,pending:1});expect(q.diagnostic.pairedCases).toEqual([])
})

it('collaboration phase budgets are atomic, isolated and reject prior revision keys',()=>{
 const root=dir(),manifest={old:true},initial=new support.EvaluationJournal(root,manifest,3000)
 initial.charge('v6-2026-10-05/integrity/r10/deepseek-flash/0/old');initial.close()
 const prefix=support.COLLABORATION_RULES.prefix,campaign={parentManifestHash:support.fingerprint(manifest),prefix,limit:support.COLLABORATION_RULES.total,perModelLimit:136,modelSegment:2,authorization:support.COLLABORATION_RULES.authorization}
 const j=new support.EvaluationJournal(dir(),{},3000,root,undefined,campaign)
 expect(()=>j.charge(prefix+'r12/answers/deepseek-flash/fact/on')).toThrow('EVALUATION_CAMPAIGN_KEY')
 expect(()=>j.charge(prefix+'r11/consolidation/deepseek-flash/0/v6-fact-01')).toThrow('EVALUATION_CAMPAIGN_KEY')
 const key=prefix+'r13/answers/deepseek-flash/fact/on';j.charge(key)
 expect(()=>j.charge(key)).toThrow('EVALUATION_CASE_CALL_LIMIT')
 expect(()=>j.charge(prefix+'r13/unknown/deepseek-flash/fact/on')).toThrow('EVALUATION_CAMPAIGN_KEY')
 for(const task of support.COLLABORATION_TASK_IDS)for(const condition of ['on','off'])if(task!=='fact'||condition!=='on')j.charge(prefix+'r13/answers/deepseek-flash/'+task+'/'+condition)
 for(const round of [0,1])for(const spec of V6_QUALITY_CASES){const k=prefix+'r13/consolidation/deepseek-flash/'+round+'/'+spec.id;j.charge(k);j.charge(k)}
 expect(()=>j.charge(prefix+'r13/consolidation/deepseek-flash/0/v6-fact-01')).toThrow()
 for(const task of support.COLLABORATION_TASK_IDS)for(const condition of ['on','off'])j.charge(prefix+'r13/answers/MiniMax-M3/'+task+'/'+condition)
 j.charge(prefix+'r13/consolidation/MiniMax-M3/0/v6-fact-01')
 expect(j.localCalls).toBe(153);expect(j.calls).toBe(154);j.close()
 const next=new support.EvaluationJournal(dir(),{revision:13},3000,root,undefined,campaign)
 next.charge(prefix+'r13/consolidation/MiniMax-M3/0/v6-standing-01')
 expect(next.localCalls).toBe(154)
 expect(support.COLLABORATION_RULES.revision).toBe(13)
 expect(support.COLLABORATION_RULES.authorization).toBe('2026-10-10-memory-instrument-hygiene')
 expect(support.COLLABORATION_RULES.historicalCalls).toBe(1444)
 next.close()
})
it('reserved collaboration keys cannot downgrade to a generic budget by missing or incorrect authorization',()=>{
 for(const authorization of [undefined,'wrong']){
  const root=dir(),manifest={old:true},initial=new support.EvaluationJournal(root,manifest,3000);initial.close()
  const j=new support.EvaluationJournal(dir(),{},3000,root,undefined,{parentManifestHash:support.fingerprint(manifest),prefix:support.COLLABORATION_RULES.prefix,limit:272,perModelLimit:136,modelSegment:2,authorization})
  try{expect(()=>j.charge(support.COLLABORATION_RULES.prefix+'r11/answers/deepseek-flash/fact/on')).toThrow('EVALUATION_CAMPAIGN_AUTHORIZATION');expect(j.calls).toBe(0)}finally{j.close()}
 }
 const j=new support.EvaluationJournal(dir(),{},3000)
 try{expect(()=>j.charge(support.COLLABORATION_RULES.prefix+'r11/answers/deepseek-flash/fact/on')).toThrow('EVALUATION_CAMPAIGN_AUTHORIZATION')}finally{j.close()}
})
it('unknown collaboration case and task aliases are rejected before charging',()=>{
 for(const suffix of ['r12/consolidation/deepseek-flash/0/v6-fact-01','r13/answers/deepseek-flash/fact-alias/on','r13/consolidation/deepseek-flash/0/c999'])expect(()=>support.assertCollaborationCharge([],support.COLLABORATION_RULES.prefix+suffix)).toThrow('EVALUATION_CAMPAIGN_KEY')
})
it('collaboration resume opens a bound post-resume failure window without erasing charged keys',()=>{
 expect(typeof support.collaborationRecoveryWindow).toBe('function')
 const binding={frozenHash:'fixture-freeze',prefix:support.COLLABORATION_RULES.prefix+'r11/',model:'deepseek-flash'},dispatches=V6_QUALITY_CASES.slice(0,3).map(c=>({key:binding.prefix+'consolidation/'+binding.model+'/0/'+c.id,at:new Date(0).toISOString()})),cycles:any[]=[]
 const decision=()=>support.v6RecoveryDecision(support.collaborationRecoveryWindow(dispatches,cycles,binding).map(()=>({retryable:true})),cycles.length,2)
 expect(decision()).toBe('pause');cycles.push(support.collaborationResumeCycle(dispatches,cycles,binding));expect(decision()).toBe('continue')
 expect(dispatches).toHaveLength(3)
 for(const c of V6_QUALITY_CASES.slice(3,6))dispatches.push({key:binding.prefix+'consolidation/'+binding.model+'/0/'+c.id,at:new Date(1).toISOString()})
 expect(decision()).toBe('pause');cycles.push(support.collaborationResumeCycle(dispatches,cycles,binding));expect(decision()).toBe('continue')
 for(const c of V6_QUALITY_CASES.slice(6,9))dispatches.push({key:binding.prefix+'consolidation/'+binding.model+'/0/'+c.id,at:new Date(2).toISOString()})
 expect(decision()).toBe('exhausted')
 expect(()=>support.collaborationRecoveryWindow(dispatches,[{...cycles[0],dispatchCount:2}],binding)).toThrow('EVALUATION_RECOVERY_INVALID')
 expect(()=>support.collaborationRecoveryWindow(dispatches,cycles,{...binding,frozenHash:'wrong'})).toThrow('EVALUATION_RECOVERY_INVALID')
 expect(()=>support.v6AssertDispatchAvailable({dispatchKeys:()=>dispatches.map(d=>d.key),charged:key=>dispatches.filter(d=>d.key===key).length,read:()=>null},binding.prefix+'consolidation/',binding.model,dispatches[0]!.key,()=>true)).toThrow('EVALUATION_ATTEMPT_ALREADY_DISPATCHED')
})

// 仪器待查项 5b（2026-10-12 判定）：goal 写口令原句／空话此前没有任何检查项计价。
// 判据由 metaGoalShaped 机械执行；检查项 workingStateSubstance 用它，但人工仍可覆盖。
it('近况 goal 的原句判据：口令复制与空话命中，实质目标不误伤',()=>{
 expect(support.metaGoalShaped({goal:'以后用中文'},'以后用中文')).toBe(true)
 expect(support.metaGoalShaped({goal:' 以后用中文。 '},'以后用中文')).toBe(true)
 expect(support.metaGoalShaped({goal:'记录本次工作'},'青灯样稿核对')).toBe(true)
 expect(support.metaGoalShaped({goal:'核对青灯五份样稿'},'以后用中文')).toBe(false)
 // 短词偶然出现在长口令里不算复制，避免误伤。
 expect(support.metaGoalShaped({goal:'核对'},'核对青灯五份样稿')).toBe(false)
 expect(support.metaGoalShaped({goal:''},'以后用中文')).toBe(false)
 expect(support.metaGoalShaped(null,'以后用中文')).toBe(false)
 expect(support.metaGoalShaped({goal:42},'以后用中文')).toBe(false)
})

import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {afterEach,expect,it} from 'vitest'
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

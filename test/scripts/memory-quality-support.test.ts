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
 const report=support.qualitySummary([{group:'standing',required:1,retained:null,completed:true,hardViolations:[]}])
 expect(report.passed).toBe(false);expect(report.pending).toBe(1)
})
it('keeps failures in positive denominators and applies all three zero tolerance gates',()=>{
 const passing={group:'standing',required:1,retained:1,completed:true,hardViolations:[]}
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
 const review={group:'standing',required:1,retained:1,completed:true,hardViolations:[]}
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
 const rows=cases.flatMap((c,i)=>[0,1,2].map(repeat=>({caseId:c.id,repeat,review:{group:c.group,required:1,retained:repeat===0&&i<3?0:1,completed:true,hardViolations:[]}})))
 const report=support.modelQualitySummary(rows,cases)
 expect(report.rate).toBeGreaterThan(.95)
 expect(report.groups['group-0']!.rate).toBeGreaterThan(.9)
 expect(report.passed).toBe(false)
 expect(report.repeats.map(r=>r.repeat)).toEqual([0,1,2])
 expect(report.repeats.map(r=>r.passed)).toEqual([false,true,true])
 expect(report.repeats[0]!.groups['group-0']!.rate).toBe(.75)
 expect(report.repeats.map(r=>r.coverage)).toEqual([120,120,120])
})

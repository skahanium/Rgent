import {it,expect} from 'vitest'
import * as support from '../../scripts/memory-quality-support.ts'
import {V5_QUALITY_CASES,V5_SCREEN_IDS} from '../fixtures/v5-memory-quality.ts'
it('freezes balanced thirty attempts and gates unreviewed or failed dispatches',()=>{
 expect(V5_QUALITY_CASES).toHaveLength(30)
 expect(V5_QUALITY_CASES.filter(c=>c.group==='fact')).toHaveLength(5)
 expect(V5_SCREEN_IDS.every(id=>V5_QUALITY_CASES.some(c=>c.id===id))).toBe(true)
 expect(typeof support.v5DispatchGate).toBe('function')
 expect(()=>support.v5DispatchGate([{caseId:'v5-standing-01',round:0,category:'valid',review:null}], 'v5-fact-01',0,false)).toThrow('EVALUATION_REVIEW_REQUIRED')
})
it('keeps service failures in semantic denominators and requires every model round',()=>{
 expect(typeof support.v5Summary).toBe('function')
 const c=V5_QUALITY_CASES.find(c=>c.group==='fact')!
 const result=support.v5Summary([{caseId:c.id,round:0,category:'service',review:null}], [c],0)
 expect(result.long.required).toBe(c.expected.long.length)
 expect(result.long.retained).toBe(0)
 expect(result.passed).toBe(false)
})

import {mkdtemp,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {vi} from 'vitest'
import {runMemoryQualityCase} from '../../scripts/memory-quality-runner.ts'
const goodChecks={actionSatisfied:true,oldActiveRemoved:true,noDuplicateActive:true,attributionAndScope:true,noUnsupportedContent:true}
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
it('persists actual first-step output into the next controlled production Host request',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-v5-chain-'))
 const credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
 const spec=(step:number)=>({id:'chain-'+step,group:'fact' as const,heldOut:false,prompt:'接续青灯项目',body:`青灯项目第${step}份目录检查完成，下一步核对版本号。`,answer:'未采纳草稿',expected:{required:[],forbidden:[],notes:''}})
 const requests:any[]=[],results:any[]=[]
 try{for(const step of [1,2]){
  const result=await runMemoryQualityCase(spec(step),credential,async function*(input){const payload=JSON.parse(String(input.messages[0]!.content));requests.push(payload);yield {type:'text',text:JSON.stringify({recent:{goal:'青灯样稿核对',completed:`第${step}份目录检查完成（受控实写标识）`,blocked:'版本号待核',next:'核对版本号',sourceIds:payload.sources.map((s:any)=>s.id),assistantDraft:false},proposals:[]})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base,noteName:`step-${step}.md`,verifyClosure:false})
  results.push(result)
  expect(result.completed).toBe(true);expect(result.recent).toHaveLength(step)
  expect(result.followup?.mode).toBe('controlled-production-host')
  expect(result.followup?.sent[0]?.prompt).toContain('青灯')
 }
 expect(JSON.stringify(results[1].followup.sent)).toContain('第1份目录检查完成（受控实写标识）')
 }finally{await rm(base,{recursive:true,force:true})}
},20000)
it('stops a model after hard violations or insufficient service evidence',()=>{
 expect(()=>support.v5DispatchGate([{caseId:'v5-attribution-01',round:0,category:'valid',review:{longRetained:0,recentCorrect:0,semanticChecks:{...goodChecks},evidenceComplete:true,hardViolations:['wrong-attribution']}}],'v5-recent-1',0,true)).toThrow('EVALUATION_MODEL_STOPPED')
 expect(()=>support.v5DispatchGate([{caseId:'v5-standing-01',round:0,category:'service',review:{longRetained:0,recentCorrect:0,semanticChecks:{...goodChecks},evidenceComplete:false,hardViolations:[]}}],'v5-recent-1',0,true)).toThrow('EVALUATION_INSUFFICIENT_EVIDENCE')
})
it('scores every round with independent long groups and recent semantic units',()=>{
 const rows=V5_QUALITY_CASES.map(c=>({caseId:c.id,round:0,category:'valid' as const,actionVerified:true,controls:'passed' as const,review:{longRetained:c.expected.long.length,recentCorrect:c.expected.recent.length,hardViolations:[] as string[],evidenceComplete:true,semanticChecks:{...goodChecks}}}))
 expect(support.v5Summary(rows,V5_QUALITY_CASES,0).passed).toBe(true)
 expect(support.v5Summary(rows,V5_QUALITY_CASES,1).passed).toBe(false)
 const corrupted=structuredClone(rows);corrupted.find(r=>r.caseId==='v5-standing-01')!.review.hardViolations.push('temporary-standing')
 expect(support.v5Summary(corrupted,V5_QUALITY_CASES,0).passed).toBe(false)
 expect(()=>support.v5DispatchGate(rows,'v5-standing-01',1,false,V5_QUALITY_CASES)).not.toThrow()
})
it('keeps a completed screen valid after two ordinary cases and permits round two',()=>{
 const reviewed=(id:string,round=0)=>{const c=V5_QUALITY_CASES.find(c=>c.id===id)!;return {caseId:id,round,category:'valid' as const,actionVerified:true,controls:'passed' as const,review:{longRetained:c.expected.long.length,recentCorrect:c.expected.recent.length,hardViolations:[] as string[],evidenceComplete:true,semanticChecks:{...goodChecks}}}}
 const screen=V5_SCREEN_IDS.map(id=>reviewed(id)),ordinary=V5_QUALITY_CASES.filter(c=>!V5_SCREEN_IDS.includes(c.id as any)).slice(0,2)
 expect(()=>support.v5ScreenDispatchGate([...screen,reviewed(ordinary[0].id)],ordinary[1].id,0,false,V5_QUALITY_CASES,V5_SCREEN_IDS)).not.toThrow()
 const firstRound=V5_QUALITY_CASES.map(c=>reviewed(c.id))
 expect(()=>support.v5ScreenDispatchGate(firstRound,V5_QUALITY_CASES[0].id,1,false,V5_QUALITY_CASES,V5_SCREEN_IDS)).not.toThrow()
})
// 保留三个实际来源的五场核验成本，指定实际父验证遗忘闭包；不添加虚构依赖。
it('runs every chain foreground before paid consolidation and hands off its actual memory provenance',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-v5-real-chain-')),credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
 const hostInputs:string[]=[],steps:{recentId:string;version:number}[]=[]
 const hostStart=vi.spyOn((await import('../../src/main/agent-host.ts')).AgentHost.prototype,'start')
 try{for(let step=1;step<=5;step++){
  const stepStarted=performance.now(),priorStarts=hostStart.mock.calls.length
  const result=await runMemoryQualityCase({id:'actual-chain-'+step,group:'fact',heldOut:false,prompt:'继续青灯项目',body:`青灯项目第${step}份目录检查完成；下一步核对版本。`,answer:'受控助手草稿尚未确认。',expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){
   expect(hostStart.mock.calls.length).toBe(priorStarts+1)
   const p=JSON.parse(String(input.messages[0]!.content))
   // 第 5 步的近期与长期均引用本场三份实际材料并继承实际前台输入依赖；忘前一步实际父而非本步新建块。
   const sourceIds=p.sources.map((s:any)=>s.id)
   const proposals=step===5?[{action:'add',content:'青灯项目下一步核对版本号。',layer:'demand',scope:'本库',sourceIds,semantic:'fact',attribution:'受控夹具',reviewAt:null}]:[]
   yield {type:'text',text:JSON.stringify({recent:{goal:'青灯项目',completed:`第${step}份目录完成（前步真实输出）`,blocked:'版本待核',next:'核对版本',sourceIds,assistantDraft:false},proposals})};yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',base,noteName:`chain-${step}.md`,hostBeforeConsolidation:true,verifyClosure:step===5,...(step===5?{closureTargetId:steps[3]!.recentId}: {})})
  console.info('V5_CHAIN_TRACE',JSON.stringify({step,elapsedMs:performance.now()-stepStarted,closure:result.controlled?.closure?.affectedIds,actualIds:result.dependencies.map((d:any)=>d.id),entries:result.entries.map((e:any)=>({id:e.id,category:e.category,sourceCount:e.sources.length,deps:[...new Set(e.sources.flatMap((s:any)=>s.memoryDeps.map((d:any)=>d.id+'@'+d.version)))]}))}))
  expect(result.completed).toBe(true)
  expect(result.foreground?.ledger.state).toBe('saved')
  expect(result.foreground?.ledger.chapter?.taskId).toBe(result.material.taskId)
  expect(result.foreground?.material.materialVersion).toBe(result.material.materialVersion)
  if(step===5){
   expect(support.v5ControlledStatus(V5_QUALITY_CASES.find(c=>c.chain==='alpha'&&c.step===5)!,result)).toBe('passed');expect(result.controlled?.closure?.passed).toBe(true)
   // 账本"本场实际使用的记忆"列的是被装入条目本身（不是依赖闭包），依赖收窄不该让它掉到 1。
   expect(result.dependencies.length).toBeGreaterThan(1)
   // 长期的实际父必须正是前台使用、下一场实际装入的前一步近期，不能靠假边支撑宽度。
   const parent=steps[3]!
   expect(result.material.memoryDeps).toEqual(expect.arrayContaining([expect.objectContaining({id:parent.recentId,version:parent.version})]))
   expect(result.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({id:parent.recentId,version:parent.version})]))
   const derived=result.entries.find((e:any)=>e.category==='long')
   expect(derived).toBeTruthy()
   expect(derived!.sources.some((s:any)=>s.memoryDeps.some((d:any)=>d.id===parent.recentId&&d.version===parent.version))).toBe(true)
   expect(result.controlled?.closure?.affectedIds).toContain(parent.recentId)
   expect(result.controlled?.closure?.affectedIds).toEqual(expect.arrayContaining([derived!.id]))
   expect(result.controlled?.closure?.affectedIds.length).toBeGreaterThan(1)
  }
  const own=result.recent!.find((e:any)=>e.updateBasis?.id===result.material.taskId)!
  expect(own).toBeTruthy();steps.push({recentId:own.id,version:own.version})
  hostInputs.push(JSON.stringify(result.foreground?.sent))
  if(step>1){expect(hostInputs.at(-1)).toContain(`第${step-1}份目录完成（前步真实输出）`);expect(result.material.memoryDeps.length).toBeGreaterThan(0)}
 }
 }finally{hostStart.mockRestore();await rm(base,{recursive:true,force:true})}
},20000)
it('includes explicit correction and Chinese-seed English repetition with genuinely saved initial facts',async()=>{
 const correction=V5_QUALITY_CASES.find(c=>c.id==='v5-correction-01')!,duplicate=V5_QUALITY_CASES.find(c=>c.id==='v5-duplicate-06')!
 expect(correction.expected.action).toBe('correct');expect(duplicate.expected.action).toBe('unchanged')
 expect(duplicate.seed?.content).toMatch(/[\u4e00-\u9fff]/);expect(duplicate.prompt).toContain('plain English')
 const credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
 for(const c of [correction,duplicate]){const result=await runMemoryQualityCase({id:c.id,group:c.group==='standing'?'standing':'fact',heldOut:false,prompt:c.prompt,body:c.body,answer:c.answer,seed:c.seed,expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){
  const p=JSON.parse(String(input.messages[0]!.content));if(c===correction){expect(p.memory).toHaveLength(1);expect(p.memory[0].content).toBe(c.seed!.content)}
  const old=p.memory[0];yield {type:'text',text:JSON.stringify({recent:null,proposals:c===correction?[{action:'correct',id:old.id,version:old.version,content:'石桥项目每两周检查一次。',layer:'demand',scope:'本库',semantic:'fact',attribution:'人的已确认更正',reviewAt:null,sourceIds:[p.sources.find((s:any)=>s.kind==='ledger').id]}]:[]})};yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity'})
 expect(support.v5ControlledStatus(c,result)).toBe('passed');expect(result.before[0].content).toBe(c.seed!.content);expect(result.completed).toBe(true);expect(result.initialState.seeded).toBe(true);expect(result.entries.filter((e:any)=>e.category==='long'&&e.status==='active')).toHaveLength(1)
 if(c===correction)expect(result.entries[0].content).toBe('石桥项目每两周检查一次。');else expect(result.entries[0].content).toBe(c.seed!.content)
 }
},20000)
it('classifies empty, truncated, service, reference and cancellation receipts separately',()=>{
 for(const [reason,category] of [['MEMORY_OUTPUT_EMPTY','empty'],['MEMORY_OUTPUT_TRUNCATED','length'],['MEMORY_SERVICE_FAILED','service'],['MEMORY_SOURCE_CHANGED','reference'],['MEMORY_OUTPUT_REFERENCE_INVALID','reference'],['MEMORY_CANCELLED','cancel'],['MEMORY_OUTPUT_INVALID','format']] as const)
  expect(support.v5TerminalCategory({result:{receipt:{outcome:'rejected',reason}}})).toBe(category)
},60000)
it('does not count deadline cancellation as a provider service failure',()=>{expect(support.v5TerminalCategory({status:'completed',responses:[{reason:'MODEL_CANCELLED'}],result:{receipt:{outcome:'interrupted',reason:'MEMORY_DEADLINE'}}})).toBe('cancel')})
it('diagnoses only the selected live model and preserves separate full-diagnostic recipients',()=>{
 const models=[{modelId:'MiniMax-M3',host:'api.minimax.cn'},{modelId:'deepseek-flash',host:'api.deepseek.com'}]
 expect(support.v5DiagnosticTargets(models,true,'MiniMax-M3')).toEqual([models[0]])
 expect(support.v5DiagnosticTargets(models,false)).toEqual(models)
 expect(()=>support.v5DiagnosticTargets(models,true,'unknown')).toThrow('EVALUATION_MODELS_NOT_AUTHORIZED')
})
it('does not pass duplicate active rows or a correction applied to another target',()=>{
 const dup=V5_QUALITY_CASES.find(c=>c.id==='v5-duplicate-06')!,correct=V5_QUALITY_CASES.find(c=>c.id==='v5-correction-01')!
 const old={id:'old',version:1,content:dup.seed!.content,semantic:'standing',scope:'本库',category:'long',status:'active'}
 expect(support.v5ActionEvidence(dup,{before:[old],entries:[old,{...old,id:'extra'}],receipt:{outcome:'applied',entryIds:['extra']}})).toBe(false)
 const target={...old,content:correct.seed!.content,semantic:'fact'}
 expect(support.v5ActionEvidence(correct,{before:[target],entries:[target,{...target,id:'wrong',version:2,content:'新版'}],receipt:{outcome:'applied',entryIds:['wrong']}})).toBe(false)
 const checks={actionSatisfied:false,oldActiveRemoved:true,noDuplicateActive:true,attributionAndScope:true,noUnsupportedContent:true}
 const scored=support.v5Summary([{caseId:dup.id,round:0,category:'valid',actionVerified:false,controls:'passed',review:{longRetained:dup.expected.long.length,recentCorrect:0,hardViolations:[],evidenceComplete:true,semanticChecks:checks}}],[dup],0)
 expect(scored.long.rate).toBe(1);expect(scored.passed).toBe(false);expect(scored.violations).toEqual([])
})
it('fails the round for each explicit semantic check without inventing a zero-tolerance violation',()=>{
 const c=V5_QUALITY_CASES.find(c=>c.id==='v5-recent-1')!
 for(const key of Object.keys(goodChecks) as (keyof typeof goodChecks)[]){const checks={...goodChecks,[key]:false},r=support.v5Summary([{caseId:c.id,round:0,category:'valid',controls:'passed',review:{longRetained:0,recentCorrect:c.expected.recent.length,hardViolations:[],evidenceComplete:true,semanticChecks:checks}}],[c],0);expect(r.passed).toBe(false);expect(r.violations).toEqual([])}
})
it('does not treat the unchanged applied receipt as a rejected relearning attempt',async()=>{
 const c=V5_QUALITY_CASES.find(c=>c.id==='v5-duplicate-06')!,credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
 const result=await runMemoryQualityCase({id:c.id,group:'standing',heldOut:false,prompt:c.prompt,body:c.body,answer:c.answer,seed:c.seed,expected:{required:[],forbidden:[],notes:''}},credential,async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',verifyClosure:true})
 expect(result.receipt).toMatchObject({outcome:'applied',entryIds:[]})
 expect(result.controlled?.closure?.replay.receipt).not.toEqual(result.receipt)
 expect(result.controlled?.closure?.replay.proposalRejected).toBe(true)
 expect(result.controlled?.closure?.replay.freshTerminal).toBe(true)
 expect(result.controlled?.closure?.replay.validProposalSources).toBe(true)
 expect(result.controlled?.closure?.passed).toBe(true)
},20000)
it('recomputes replay evidence and rejects stale no-op receipts even with asserted flags',()=>{
 const old={taskId:'task',materialVersion:'material',outcome:'applied',entryIds:[]},probe={receipt:old,previousReceipt:old,material:{taskId:'task',materialVersion:'material'},beforeRevision:'before',afterRevision:'after',freshTerminal:true,explicitBlock:true,proposalRejected:true,calls:0,validProposalSources:false}
 expect(support.v5ReplayEvidence(probe)).toBe(false)
 expect(support.v5ReplayEvidence({...probe,previousReceipt:null})).toBe(false)
 expect(support.v5ReplayEvidence({...probe,previousReceipt:null,calls:1,validProposalSources:true,sent:{sources:[{id:'source',classification:'command'}],proposal:{recent:null,proposals:[{semantic:'standing',sourceIds:['source']}]}},receipt:{...old,reason:'MEMORY_OUTPUT_INVALID'}})).toBe(true)
 expect(support.v5ReplayEvidence({...probe,previousReceipt:null,calls:1,validProposalSources:true,sent:{sources:[{id:'source',classification:'human'}],proposal:{recent:null,proposals:[{semantic:'standing',sourceIds:['source']}]}},receipt:{...old,reason:'MEMORY_OUTPUT_INVALID'}})).toBe(false)
 expect(support.v5ReplayEvidence({...probe,previousReceipt:null,receipt:{...old,outcome:'rejected',reason:'MEMORY_DEPENDENCY_CHANGED'}})).toBe(true)
})

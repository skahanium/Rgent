import {expect,it,vi,afterEach} from 'vitest'
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as utility from '../../scripts/memory-quality-utility.ts'
import {runMemoryQualityCase} from '../../scripts/memory-quality-runner.ts'
import {fingerprint,collaborationResumeCycle} from '../../scripts/memory-quality-support.ts'
import {V6_QUALITY_CASES} from '../fixtures/v6-memory-quality.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
async function terminalFixture(service?:{failures:number;stop?:boolean;failedScore?:boolean}){
 const root=mkdtempSync(path.join(os.tmpdir(),'rgent-utility-persist-'));dirs.push(root)
 const frozenHash='a'.repeat(64),pairKey='v6-2026-10-05/collaboration/r11/answers/deepseek-flash/fact',sourceKey='v6-2026-10-05/collaboration/r11/consolidation/deepseek-flash/0/v6-fact-01',binding={frozenHash,key:sourceKey,model:'deepseek-flash',round:0,caseId:'v6-fact-01'},credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'fiction-key',contextTokens:32768}
 const result:any=await runMemoryQualityCase({id:'v6-fact-01',group:'fact',heldOut:false,prompt:'记录石桥检查。',body:'石桥每两周检查。',answer:'记录。',expected:{required:[],forbidden:[],notes:''}},credential,async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base:path.join(root,'fixture'),retainArtifact:binding})
 const artifact=result.utilityArtifact!,sourceRow={key:sourceKey,frozenHash,result},source={version:1,frozenHash,taskId:'fact',sourceKey,sourceResultHash:fingerprint(sourceRow),artifactHash:artifact.hash},file=(kind:string)=>path.join(root,kind+'-'+fingerprint(pairKey)+'.json'),raw=(condition:string)=>path.join(root,'result-'+fingerprint(pairKey+'/'+condition)+'.json'),dispatches:{key:string;at:string}[]=[]
 writeFileSync(path.join(root,'result-'+fingerprint(sourceKey)+'.json'),JSON.stringify(sourceRow))
 const serviceInput=()=>({root,frozenHash,prefix:'v6-2026-10-05/collaboration/r11/',model:'deepseek-flash',dispatches})
 if(service?.stop)writeFileSync(path.join(root,'stop-deepseek-flash.json'),JSON.stringify({frozenHash,reason:'operator-stop'}))
 for(let n=0;n<(service?.failures??0);n++){const key=sourceKey.replace('v6-fact-01',V6_QUALITY_CASES[n]!.id);dispatches.push({key,at:new Date(0).toISOString()});writeFileSync(path.join(root,'result-'+fingerprint(key)+'.json'),JSON.stringify({key,frozenHash,status:'completed',responses:[{reason:'EVALUATION_REQUEST_FAILED',finishReason:null}]}))}
 if(service?.failedScore)writeFileSync(path.join(root,'summary-score.json'),JSON.stringify({verdict:'failed'}))
 let plan:any,after:any,error:unknown
 try{await utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(sourceRow),taskId:'fact',credential,signal:new AbortController().signal,
  onPrepared:a=>{after=a;writeFileSync(file('utility-source'),JSON.stringify({source,after:a,afterHash:a.hash}))},
  onPreflight:(preflight,order)=>{plan=utility.persistUtilityPreflight({root,pairKey,frozenHash,source,afterHash:after.hash,preflight,order})},
  charge:condition=>{if(service)utility.assertCollaborationServiceDispatch(serviceInput());dispatches.push({key:pairKey+'/'+condition,at:new Date().toISOString()})},
  stream:async function*(){if(service?.failures)throw Error('EVALUATION_REQUEST_FAILED');yield {type:'text',text:'资料不足。'};yield {type:'finish',reason:'stop'}},
  onCondition:(condition,answer)=>writeFileSync(raw(condition),JSON.stringify({key:pairKey+'/'+condition,frozenHash,status:'terminal',source,afterHash:after.hash,preflightHash:plan.hash,result:answer}))})}catch(e){if(!service)throw e;error=e}
 return {root,pairKey,frozenHash,dispatches,file,raw,error,serviceInput}
}
it('recovers two durable terminals without a pair and a pair without a blind packet with zero further charges',async()=>{
 expect(typeof utility.recoverUtilityReport).toBe('function')
 const input=await terminalFixture(),before=JSON.stringify(input.dispatches)
 const recovered=utility.recoverUtilityReport(input);expect(recovered.result.calls).toBe(2);expect(JSON.stringify(input.dispatches)).toBe(before)
 const pair=readFileSync(input.file('utility-result')),packet=readFileSync(input.file('utility-blind'))
 utility.recoverUtilityReport(input);expect(readFileSync(input.file('utility-result'))).toEqual(pair);expect(readFileSync(input.file('utility-blind'))).toEqual(packet)
 unlinkSync(input.file('utility-blind'));utility.recoverUtilityReport(input);expect(readFileSync(input.file('utility-result'))).toEqual(pair);expect(JSON.stringify(input.dispatches)).toBe(before)
 const finalPair=JSON.parse(pair.toString());finalPair.conditions.on.body='corrupted';writeFileSync(input.file('utility-result'),JSON.stringify(finalPair))
 expect(()=>utility.recoverUtilityReport(input)).toThrow('EVALUATION_UTILITY_EVIDENCE_MISMATCH')
 expect(JSON.parse(readFileSync(input.file('utility-result'),'utf8')).conditions.on.body).toBe('corrupted')
})
it('summary and recovery share strict raw ownership, frozen/source/after/charge and paired-condition validation',async()=>{
 expect(typeof utility.readUtilityEvidence).toBe('function')
 const input=await terminalFixture(),on=readFileSync(input.raw('on')),off=readFileSync(input.raw('off'))
 utility.recoverUtilityReport(input)
 for(const mutate of [(r:any)=>({...r,key:JSON.parse(off.toString()).key}),(r:any)=>({...r,frozenHash:'wrong'}),(r:any)=>({...r,source:{...r.source,sourceResultHash:'wrong'}}),(r:any)=>({...r,afterHash:'wrong'}),(r:any)=>({...r,result:{...r.result,body:'different'}})]){
  writeFileSync(input.raw('on'),JSON.stringify(mutate(JSON.parse(on.toString()))));expect(()=>utility.readUtilityEvidence(input)).toThrow('EVALUATION_UTILITY_EVIDENCE_MISMATCH');writeFileSync(input.raw('on'),on)
 }
 expect(()=>utility.readUtilityEvidence({...input,dispatches:input.dispatches.filter(d=>!d.key.endsWith('/on'))})).toThrow('EVALUATION_UTILITY_EVIDENCE_MISMATCH')
 unlinkSync(input.file('utility-result'));unlinkSync(input.file('utility-blind'));unlinkSync(input.raw('on'))
 expect(utility.readUtilityEvidence(input).conditions.on.status).toBe('charged-without-terminal')
 expect(()=>utility.recoverUtilityReport(input)).toThrow('EVALUATION_CHARGED_UNFINISHED')
})

it('recovers charged production limit terminals as failed measurements without redispatch',async()=>{
 const input=await terminalFixture(),before=JSON.stringify(input.dispatches)
 // The ledger schema also permits limit; project that terminal without inventing a new paid attempt.
 for(const c of ['on','off']){const row=JSON.parse(readFileSync(input.raw(c),'utf8'));row.result.status='limit';row.result.finishReason='length';writeFileSync(input.raw(c),JSON.stringify(row))}
 const recovered=utility.recoverUtilityReport(input);expect(recovered.result.conditions.on.status).toBe('limit');expect(recovered.result.validTerminal).toBe(0);expect(JSON.stringify(input.dispatches)).toBe(before)
})

it('explicit stop and three consolidation service failures block utility before any answer charge',async()=>{
 for(const service of [{failures:0,stop:true},{failures:3}]){const input=await terminalFixture(service);expect(input.error).toMatchObject({message:service.stop?'EVALUATION_MODEL_STOPPED':'EVALUATION_MODEL_PAUSED'});expect(input.dispatches.filter(d=>d.key.includes('/answers/'))).toHaveLength(0)}
})
it('a third mixed-phase failure stops the next condition; two bound resumes retain the mixed charged history',async()=>{
 const input=await terminalFixture({failures:2});expect(input.error).toMatchObject({message:'EVALUATION_MODEL_PAUSED'});expect(input.dispatches.filter(d=>d.key.includes('/answers/'))).toHaveLength(1)
 const before=JSON.stringify(input.dispatches),cycles:any[]=[],binding={frozenHash:input.frozenHash,prefix:input.serviceInput().prefix,model:'deepseek-flash'}
 for(let cycle=0;cycle<2;cycle++){
  expect(utility.collaborationServiceState(input.serviceInput()).decision).toBe('pause')
  cycles.push(collaborationResumeCycle(input.dispatches,cycles,binding));writeFileSync(path.join(input.root,'recovery-deepseek-flash.json'),JSON.stringify({model:binding.model,cycles}))
  expect(()=>utility.assertCollaborationServiceDispatch(input.serviceInput())).not.toThrow()
  for(let n=0;n<3;n++){const key=binding.prefix+'consolidation/'+binding.model+'/0/'+V6_QUALITY_CASES[cycle*3+n+3]!.id;input.dispatches.push({key,at:new Date(cycle+1).toISOString()});writeFileSync(path.join(input.root,'result-'+fingerprint(key)+'.json'),JSON.stringify({key,frozenHash:input.frozenHash,status:'completed',responses:[{reason:'EVALUATION_REQUEST_FAILED'}]}))}
 }
 expect(utility.collaborationServiceState(input.serviceInput()).decision).toBe('exhausted');expect(()=>utility.assertCollaborationServiceDispatch(input.serviceInput())).toThrow('EVALUATION_RECOVERY_EXHAUSTED');expect(JSON.stringify(input.dispatches.slice(0,3))).toBe(before)
})
it('ordinary failed first-round scores do not stop trusted utility observations',async()=>{
 const input=await terminalFixture({failures:0,failedScore:true});expect(input.error).toBeUndefined();expect(input.dispatches).toHaveLength(2);expect(utility.collaborationServiceState(input.serviceInput()).decision).toBe('continue')
})
it('service windows use each actual consolidation response and the program-held in-flight receipt',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rgent-service-window-'));dirs.push(root)
 const frozenHash='service-freeze',prefix='v6-2026-10-05/collaboration/r11/',model='deepseek-flash',keys=V6_QUALITY_CASES.slice(0,3).map(c=>prefix+'consolidation/'+model+'/0/'+c.id),dispatches=keys.map(key=>({key}))
 const file=(key:string)=>path.join(root,'result-'+fingerprint(key)+'.json')
 for(const key of keys)writeFileSync(file(key),JSON.stringify({key,frozenHash,status:'completed',responses:[{reason:'EVALUATION_REQUEST_FAILED'}]}))
 const input={root,frozenHash,prefix,model,dispatches}
 expect(utility.collaborationServiceState(input).decision).toBe('pause')
 writeFileSync(file(keys[2]!),JSON.stringify({key:keys[2],frozenHash,status:'started'}))
 expect(utility.collaborationServiceState({...input,activeConsolidation:{key:keys[2]!,responses:[{reason:null,finishReason:'stop'}]}}).decision).toBe('continue')
 const twice=[{key:keys[0]!},{key:keys[0]!},{key:keys[1]!}]
 writeFileSync(file(keys[0]!),JSON.stringify({key:keys[0],frozenHash,status:'completed',responses:[{reason:'EVALUATION_REQUEST_FAILED'},{reason:null,finishReason:'stop'}]}))
 expect(utility.collaborationServiceState({...input,dispatches:twice}).attempts.map(r=>r.retryable)).toEqual([true,false,true])
 const unrelated=[{key:prefix+'answers/MiniMax-M3/fact/on'},{key:prefix.replace('r11/','r12/')+'answers/'+model+'/fact/on'}]
 expect(utility.collaborationServiceState({...input,dispatches:[...unrelated,...twice]}).attempts.map(r=>r.key)).toEqual(twice.map(d=>d.key))
 writeFileSync(file(keys[1]!),JSON.stringify({key:keys[1],frozenHash:'wrong',status:'completed',responses:[{reason:null,finishReason:'stop'}]}))
 expect(()=>utility.collaborationServiceState({...input,dispatches:twice})).toThrow('EVALUATION_REVISION_CHANGED')
})

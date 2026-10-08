import {expect,it,vi,afterEach} from 'vitest'
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as utility from '../../scripts/memory-quality-utility.ts'
import {runMemoryQualityCase} from '../../scripts/memory-quality-runner.ts'
import {fingerprint} from '../../scripts/memory-quality-support.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
async function terminalFixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'rgent-utility-persist-'));dirs.push(root)
 const frozenHash='a'.repeat(64),pairKey='v6-2026-10-05/collaboration/r11/answers/deepseek-flash/fact',sourceKey='v6-2026-10-05/collaboration/r11/consolidation/deepseek-flash/0/v6-fact-01',binding={frozenHash,key:sourceKey,model:'deepseek-flash',round:0,caseId:'v6-fact-01'},credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'fiction-key',contextTokens:32768}
 const result:any=await runMemoryQualityCase({id:'v6-fact-01',group:'fact',heldOut:false,prompt:'记录石桥检查。',body:'石桥每两周检查。',answer:'记录。',expected:{required:[],forbidden:[],notes:''}},credential,async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base:path.join(root,'fixture'),retainArtifact:binding})
 const artifact=result.utilityArtifact!,sourceRow={key:sourceKey,frozenHash,result},source={version:1,frozenHash,taskId:'fact',sourceKey,sourceResultHash:fingerprint(sourceRow),artifactHash:artifact.hash},file=(kind:string)=>path.join(root,kind+'-'+fingerprint(pairKey)+'.json'),raw=(condition:string)=>path.join(root,'result-'+fingerprint(pairKey+'/'+condition)+'.json'),dispatches:{key:string;at:string}[]=[]
 writeFileSync(path.join(root,'result-'+fingerprint(sourceKey)+'.json'),JSON.stringify(sourceRow))
 let plan:any,after:any
 await utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(sourceRow),taskId:'fact',credential,signal:new AbortController().signal,
  onPrepared:a=>{after=a;writeFileSync(file('utility-source'),JSON.stringify({source,after:a,afterHash:a.hash}))},
  onPreflight:(preflight,order)=>{plan=utility.persistUtilityPreflight({root,pairKey,frozenHash,source,afterHash:after.hash,preflight,order})},
  charge:condition=>dispatches.push({key:pairKey+'/'+condition,at:new Date().toISOString()}),
  stream:async function*(){yield {type:'text',text:'资料不足。'};yield {type:'finish',reason:'stop'}},
  onCondition:(condition,answer)=>writeFileSync(raw(condition),JSON.stringify({key:pairKey+'/'+condition,frozenHash,status:'terminal',source,afterHash:after.hash,preflightHash:plan.hash,result:answer}))})
 return {root,pairKey,frozenHash,dispatches,file,raw}
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

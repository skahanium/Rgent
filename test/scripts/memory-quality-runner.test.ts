import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {VaultSession} from '../../src/main/vault.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {serializeStoredVault} from '../../src/main/notes-fs.ts'
import {expect,it,vi} from 'vitest'
import * as runner from '../../scripts/memory-quality-runner.ts'
import {recordedQualityReview,qualitySummary} from '../../scripts/memory-quality-support.ts'
import {MEMORY_QUALITY_CASES} from '../fixtures/memory-quality.ts'
import type {ModelStepInput} from '../../src/main/model-stream.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
const sample={id:'fiction',group:'standing' as const,heldOut:false,prompt:'以后本库每份报告都使用蓝鹭术语。',body:'项目已经确认蓝鹭术语。',answer:'AI 猜测该项目负责人是神秘人物。',expected:{required:['蓝鹭'],forbidden:['神秘人物'],notes:'真实来源学习'}}
const credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
it('uses saved body and ledger evidence, then the production context and revocation paths',async()=>{
 expect(typeof runner.runMemoryQualityCase).toBe('function')
 const requests:ModelStepInput[]=[]
 const result=await runner.runMemoryQualityCase(sample,credential,async function*(input){requests.push(input);const data=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({proposals:[{action:'add',content:'本库报告使用蓝鹭术语',layer:'core',scope:'本库',sourceIds:[data.sources.find((s:any)=>s.classification==='command').id],semantic:'standing',attribution:'人的口令',reviewAt:null}]})};yield {type:'finish',reason:'stop',usage:{inputTokens:100,outputTokens:60}}},new AbortController().signal)
 expect(result.completed).toBe(true);expect(result.entries).toHaveLength(1)
 expect(result.context.status).toBe('ready');expect(result.dependencies).toHaveLength(1)
 expect(result.forget?.relearningBlocked).toBe(true);expect(result.forget?.revoked).toBe(true)
 expect(result.followup?.ledger.state).toBe('saved')
 expect(result.followup?.ledger.chapter?.provenance).toMatchObject({version:2,memoryDeps:result.dependencies})
 expect(result.followup?.sent[0]?.prompt).toContain('本库报告使用蓝鹭术语')
 expect(result.followup?.mode).toBe('controlled-production-host')
 expect(result.forget?.replay?.attempted).toBe(true)
 expect(result.forget?.replay).toMatchObject({validSourceIds:true,originalBasisBlocked:true})
 expect(result.forget?.replay?.remaining).toEqual([])
 expect(requests).toHaveLength(1)
 expect(String(requests[0]!.messages[0]!.content)).toContain('项目已经确认蓝鹭术语')
 expect(String(requests[0]!.messages[0]!.content)).not.toContain('神秘人物')
 expect(JSON.stringify(result)).not.toContain('private-secret')
})
it('an operator abort cancels pending consolidation and preserves its interrupted result',async()=>{
 const controller=new AbortController()
 const result=await runner.runMemoryQualityCase(sample,credential,async function*(input){controller.abort();throw Error('stopped');yield {type:'text',text:''}},controller.signal)
 expect(result.completed).toBe(false);expect(result.entries).toEqual([])
})

it('records a corrected version in a genuine next-task ledger and cannot relearn the forgotten correction',async()=>{
 const spec=MEMORY_QUALITY_CASES.find(c=>c.id==='correction-01')!
 let paidCalls=0
 const result=await runner.runMemoryQualityCase(spec,credential,async function*(input){paidCalls++;const data=JSON.parse(String(input.messages[0]!.content)),old=data.memory[0]
  yield {type:'text',text:JSON.stringify({proposals:[{action:'correct',id:old.id,version:old.version,content:'石桥项目每两周检查一次。',layer:'demand',scope:'本库',sourceIds:[data.sources.find((s:any)=>s.kind==='ledger').id],semantic:'fact',attribution:'人的已确认更正',reviewAt:null}]})}
  yield {type:'finish',reason:'stop'}},new AbortController().signal)
 expect(result.completed).toBe(true);expect(result.before[0]?.content).toBe('石桥项目每周检查一次。')
 expect(result.dependencies).toHaveLength(1);expect(result.dependencies[0]?.version).toBe(2)
 expect(result.followup?.ledger.chapter?.provenance).toMatchObject({version:2,memoryDeps:result.dependencies})
 expect(result.followup?.sent[0]?.prompt).toContain('石桥项目每两周检查一次。')
 expect(result.forget).toMatchObject({revoked:true,relearningBlocked:true,replay:{attempted:true,calls:1,remaining:[],receipt:{outcome:'rejected',reason:'MEMORY_OUTPUT_INVALID'}}})
 expect(paidCalls).toBe(1)
})

it('scores a genuine terminal format failure as assessed zero while leaving failed negatives pending',async()=>{
 const responses:{body:string;input:ModelStepInput;reason:null;finishReason:string}[]=[]
 const result=await runner.runMemoryQualityCase(sample,credential,async function*(input){responses.push({body:'not valid JSON',input,reason:null,finishReason:'stop'});yield {type:'text',text:'not valid JSON'};yield {type:'finish',reason:'stop'}},new AbortController().signal)
 expect(result.completed).toBe(false);expect(result.receipt?.reason).toBe('MEMORY_OUTPUT_INVALID')
 const review=recordedQualityReview({status:'completed',responses,result,review:{group:'standing',required:1,retained:0,completed:false,evidenceComplete:true,hardViolations:[]}})!
 expect(review.evidenceComplete).toBe(true)
 expect(qualitySummary([review])).toMatchObject({pending:0,required:1,retained:0,serviceFailures:{count:1,reasons:{MEMORY_OUTPUT_INVALID:1}}})
 expect(qualitySummary([{...review,required:0}])).toMatchObject({pending:1,passed:false})
 expect(recordedQualityReview({status:'completed',responses,result,review:{...review,evidenceComplete:false}})?.evidenceComplete).toBe(false)
})

it('v4 semantic review sees the actual source payload and commits only the reviewed production proposal',async()=>{
 const sent:ModelStepInput[]=[]
 const result=await runner.runMemoryQualityCase(sample,credential,async function*(input){sent.push(input);const data=JSON.parse(String(input.messages[0]!.content)),source=(data.sources??data.material.sources).find((s:any)=>s.classification==='command')
  const content=sent.length===1?'本库报告错误使用红雀术语':'本库报告使用蓝鹭术语'
  yield {type:'text',text:JSON.stringify({proposals:[{action:'add',content,layer:'core',scope:'本库',sourceIds:[source.id],semantic:'standing',attribution:'人的口令',reviewAt:null}]})};yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'review'})
 expect(sent).toHaveLength(2);expect(sent[1]!.system).toContain('语义核对')
 expect(String(sent[1]!.messages[0]!.content)).toContain('红雀')
 expect(result.entries.map(e=>e.content)).toEqual(['本库报告使用蓝鹭术语'])
 expect(result.experiment).toMatchObject({category:'valid',calls:2})
})
it('v4 initial bad format spends only one repair, records repaired-but-unreviewed, and does not autoapply',async()=>{
 let calls=0
 const result=await runner.runMemoryQualityCase(sample,credential,async function*(input){calls++;if(calls===1)yield {type:'text',text:'broken'};else yield {type:'text',text:JSON.stringify({proposals:[]})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'review'})
 expect(calls).toBe(2);expect(result.entries).toEqual([])
 expect(result.experiment).toMatchObject({category:'format-repaired-unreviewed',calls:2})
 expect(result.completed).toBe(false)
})
it('v4 semantic rejection is explicit and leaves the seed built by the actual manual remember path',async()=>{
 const spec=MEMORY_QUALITY_CASES.find(c=>c.id==='ambiguous-01')!;let calls=0
 const result=await runner.runMemoryQualityCase(spec,credential,async function*(input){calls++;yield {type:'text',text:calls===1?' {"proposals":[]} ':JSON.stringify({reject:'新说法未确认，保留原事实'})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'review'})
 expect(calls).toBe(2);expect(result.before[0]?.content).toBe(spec.seed!.content)
 expect(result.experiment).toMatchObject({category:'semantic-rejected',calls:2})
 expect(result.initialState).toMatchObject({method:'fictional-body-ledger-manual-preview-commit',seeded:true})
 expect(result.entries.map(e=>e.content)).toEqual([spec.seed!.content])
})

it('the experimental second dispatch rechecks the material after the first response instead of sending stale evidence',async()=>{
 let calls=0,checks=0;const trace={category:'insufficient-evidence' as const,calls:0,rejectReason:null}
 const wrapped=runner.v4StrategyStream('review',async function*(){calls++;yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}},trace,async()=>{checks++;if(checks===2)throw Error('MEMORY_SOURCE_CHANGED')})
 let error:unknown
 try{for await(const event of wrapped({...credential,system:'fixture',messages:[{role:'user',content:'{"sources":[],"memory":[]}'}],signal:new AbortController().signal,maxOutputTokens:4096}))void event}catch(e){error=e}
 expect(error).toMatchObject({message:'MEMORY_SOURCE_CHANGED'});expect(calls).toBe(1)
})

it('experimental review cannot resend a real body source changed after its first response',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-q-source-')),root=path.join(base,'vault');let vault:VaultSession|null=null
 try{await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'fiction.md'),'核验前的虚构旧事实。')
  vault=new VaultSession(base,()=>{});vault.restore();const session=vault,service=new WorkingMemoryService(session,()=>null);await service.initialize()
  const note=await session.readOpened('fiction.md'),source=await service.manualSource({...note,relPath:'fiction.md',kind:'body',start:0,end:note.content.length})
  let calls=0;const trace:runner.V4Trace={category:'insufficient-evidence',calls:0,rejectReason:null}
  const stream=runner.v4StrategyStream('review',async function*(){calls++;yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'};await session.write('fiction.md','已实改成独立的新事实。',note.revision,note)},trace,async()=>{if(!await service.verifySource(source))throw Error('MEMORY_SOURCE_CHANGED')})
  let error:unknown;try{for await(const event of stream({...credential,system:'fixture',messages:[{role:'user',content:'{"sources":[],"memory":[]}'}],signal:new AbortController().signal,maxOutputTokens:4096}))void event}catch(e){error=e}
  expect(error).toMatchObject({message:'MEMORY_SOURCE_CHANGED'});expect(calls).toBe(1)
 }finally{vault?.dispose();await rm(base,{recursive:true,force:true})}
})

it('valid JSON with invalid production candidate references is counted as candidate rejection, never a network failure',async()=>{
 const result=await runner.runMemoryQualityCase(sample,credential,async function*(){yield {type:'text',text:JSON.stringify({proposals:[{action:'add',content:'伪来源候选',layer:'demand',scope:'本库',sourceIds:['forged'],semantic:'fact',attribution:'人',reviewAt:null}]})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'baseline'})
 expect(result.entries).toEqual([]);expect(result.experiment?.category).toBe('candidate-rejected')
 expect(result.receipt?.reason).toBe('MEMORY_OUTPUT_INVALID')
})

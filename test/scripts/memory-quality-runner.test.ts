import {expect,it,vi} from 'vitest'
import * as runner from '../../scripts/memory-quality-runner.ts'
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
 expect(result.forget).toMatchObject({revoked:true,relearningBlocked:true,replay:{attempted:true,calls:1,remaining:[],receipt:{outcome:'applied',reason:'MEMORY_OUTPUT_INVALID'}}})
 expect(paidCalls).toBe(1)
})

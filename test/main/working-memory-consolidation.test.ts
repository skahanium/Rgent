import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach,it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {WorkingMemoryConsolidation,parseMemorySuggestions} from '../../src/main/working-memory-consolidation.ts'
import {serializeStoredVault} from '../../src/main/notes-fs.ts'
import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
import type {ModelStepInput,ModelStepEvent} from '../../src/main/model-stream.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<typeof import('../../src/main/watch.ts')>(),watchVault:()=>()=>{}}))
const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const clean of cleanups.splice(0))await clean()})
async function fixture(stream:(input:ModelStepInput)=>AsyncIterable<ModelStepEvent>){
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-consolidate-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const marked=markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'})
 await writeFile(path.join(root,'a.md'),marked)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 const service=new WorkingMemoryService(vault,()=>null);await service.initialize()
 let signature='configured';const configuration=()=>({enabled:true,signature,credential:{provider:'custom' as const,modelId:'memory',baseURL:'https://example.test/v1',apiKey:'secret',contextTokens:32768},limits:{seconds:120,calls:2,tools:0}})
 const engine=new WorkingMemoryConsolidation({service:()=>service,configuration,stream,changed:vi.fn()})
 engine.capture('task')
 let note=await vault.readOpened('a.md')
 await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的'})
 const result=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note)
 await vault.ledgerComplete('a.md','task',result.revision)
 const material=await service.savedMaterial('a.md','task')
 cleanups.push(async()=>{engine.close();await engine.idle();vault.dispose();await rm(base,{recursive:true,force:true})})
 return {vault,service,engine,material,changeConfig:()=>{signature='changed'}}
}
const suggestion=(input:ModelStepInput)=>{const data=JSON.parse(String(input.messages[0]!.content));return {action:'add',content:'后续在本库使用中文',layer:'core',scope:'本库',sourceIds:[data.sources[0].id],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null}}
it('accepts complete fences, independently rejects invalid proposals, and never treats prose as JSON',()=>{
 expect(parseMemorySuggestions('```json\n{"proposals":[]}\n```')).toEqual([])
 expect(()=>parseMemorySuggestions('建议如下：{"proposals":[]}')).toThrow('MEMORY_OUTPUT_INVALID')
})
it('automatically learns only from saved material, frees permits, and ignores duplicate handoffs',async()=>{
 let calls=0;const f=await fixture(async function*(input){calls++;yield {type:'reasoning',text:'x'.repeat(40000)};yield {type:'text',text:JSON.stringify({proposals:[suggestion(input),{...suggestion(input),sourceIds:['forged']}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied');expect(f.engine.state()).toEqual({permits:0,pending:0,active:0})
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(1)
})
it('a person editing during the model request wins over the late proposal',async()=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const f=await fixture(async function*(input){entered();await waiting;yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await started
 const s=await f.service.sourceForPrompt('a.md','task');await f.vault.memoryMutation(store=>store.add(store.read(),{content:'人的新修改',layer:'demand',scope:'本库',sources:[s],semantic:'fact',attribution:'人确认',reviewAt:null},true))
 release();await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['人的新修改']);expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_CONFLICT')
})
it('revoked configuration and forgotten evidence prevent a late response from becoming active',async()=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const f=await fixture(async function*(input){entered();await waiting;yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await started;f.changeConfig();release();await f.engine.idle()
 expect(f.service.snapshot().record.entries).toHaveLength(0);expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_PERMISSION_CHANGED')
})
it('one repair uses only the draft and issues; tool calls are always rejected',async()=>{
 const requests:ModelStepInput[]=[];const f=await fixture(async function*(input){requests.push(input);yield {type:'text',text:requests.length===1?'bad json':JSON.stringify({proposals:[]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle();expect(requests).toHaveLength(2)
 expect(String(requests[1]!.messages[0]!.content)).not.toContain('以后用中文');expect(requests[0]!.tools).toBeUndefined()
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
})

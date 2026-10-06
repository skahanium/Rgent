import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach,it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {WorkingMemoryConsolidation,parseMemorySuggestions,parseContinuitySuggestions,roleAgreement} from '../../src/main/working-memory-consolidation.ts'
import type {WorkingSource} from '../../src/main/working-memory-store.ts'
import {createHash} from 'node:crypto'
import {serializeStoredVault} from '../../src/main/notes-fs.ts'
import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
import type {ModelStepInput,ModelStepEvent} from '../../src/main/model-stream.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<typeof import('../../src/main/watch.ts')>(),watchVault:()=>()=>{}}))
const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const clean of cleanups.splice(0))await clean()})
async function fixture(stream:(input:ModelStepInput)=>AsyncIterable<ModelStepEvent>,prompt='以后用中文',strategy?:'continuity'){
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-consolidate-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const marked=markPrompt('/'+prompt,{taskId:'task',range:{start:0,end:prompt.length+1},expectedText:'/'+prompt,promptText:prompt})
 await writeFile(path.join(root,'a.md'),marked)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 const service=new WorkingMemoryService(vault,()=>null);await service.initialize()
 let signature='configured',enabled=true;const configuration=()=>({enabled,signature,credential:{provider:'custom' as const,modelId:'memory',baseURL:'https://example.test/v1',apiKey:'secret',contextTokens:32768},limits:{seconds:120,calls:2,tools:0}})
 const engine=new WorkingMemoryConsolidation({service:()=>service,configuration,stream,changed:vi.fn(),strategy})
 engine.capture('task')
 let note=await vault.readOpened('a.md')
 await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt,answer:'好的'})
 const result=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note)
 await vault.ledgerComplete('a.md','task',result.revision)
 const material=await service.savedMaterial('a.md','task')
 cleanups.push(async()=>{engine.close();await engine.idle();vault.dispose();await rm(base,{recursive:true,force:true})})
 return {vault,service,engine,material,changeConfig:()=>{signature='changed'},disableConfig:()=>{enabled=false}}
}
const suggestion=(input:ModelStepInput)=>{const data=JSON.parse(String(input.messages[0]!.content));const first=data.sources[0];return {action:'add',content:'后续在本库使用中文',layer:'core',scope:'本库',sourceIds:[first.id],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null,authority:[{sourceId:first.id,quote:String(first.text).slice(0,4)}]}}
it('cancel and idle include a handoff still checking saved material',async()=>{
 let calls=0,release!:()=>void
 const f=await fixture(async function*(){calls++;yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 const saved=f.service.savedMaterial.bind(f.service),gate=new Promise<void>(r=>release=r)
 vi.spyOn(f.service,'savedMaterial').mockImplementation(async(...args)=>{await gate;return saved(...args)})
 const handing=f.engine.handoff(f.material);f.engine.cancel(undefined,'MEMORY_SESSION_CLOSED')
 let finished=false;const idle=f.engine.idle().then(()=>{finished=true})
 await Promise.resolve();const prematurelyIdle=finished
 release();await handing.catch(()=>{});await idle
 expect(prematurelyIdle).toBe(false);expect(calls).toBe(0);expect(f.service.snapshot().record.jobs).toEqual([])
})
it('accepts complete fences, independently rejects invalid proposals, and never treats prose as JSON',()=>{
 expect(parseMemorySuggestions('```json\n{"proposals":[]}\n```')).toEqual([])
 expect(()=>parseMemorySuggestions('建议如下：{"proposals":[]}')).toThrow('MEMORY_OUTPUT_INVALID')
})
it('automatically learns only from saved material, frees permits, and ignores duplicate handoffs',async()=>{
 let calls=0;const f=await fixture(async function*(input){calls++;yield {type:'reasoning',text:'x'.repeat(40000)};yield {type:'text',text:JSON.stringify({proposals:[suggestion(input),{...suggestion(input),sourceIds:['forged']}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied');expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_REFERENCE_INVALID');expect(f.engine.state()).toEqual({permits:0,pending:0,active:0})
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(1)
})
it('rejects a non-ASCII group as a whole while accepting an independent factual proposal',async()=>{
 const f=await fixture(async function*(input){
  const base={...suggestion(input),semantic:'fact',layer:'demand',content:'负责人在评审中提出预算需要复核',scope:'评审项目',attribution:'本场口令转述负责人'}
  yield {type:'text',text:JSON.stringify({proposals:[{...base,group:'项目事实'},{...base,group:'项目事实',content:'预算仍待确认'},{...base,group:'review_fact-1',content:'负责人要求复核预算'}]})};yield {type:'finish',reason:'stop'}
 },'保存负责人在评审中提出的预算复核事项')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['负责人要求复核预算'])
 expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID')
})
it('rejects invented correction targets without discarding a factual add that omits group',async()=>{
 const f=await fixture(async function*(input){
  const base={...suggestion(input),semantic:'fact',layer:'demand',content:'验收时间需重新确认',scope:'项目验收',attribution:'人的本场说明'}
  yield {type:'text',text:JSON.stringify({proposals:[{...base,action:'correct',id:'invented-entry',version:1},base]})};yield {type:'finish',reason:'stop'}
 },'记录验收时间还需重新确认')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['验收时间需重新确认'])
 // 找不到更新目标要留下自己的原因，既不新增冲突副本，也不折成格式错误。
 const job=f.service.snapshot().record.jobs[0]
 expect(job?.reason).toBe('MEMORY_TARGET_NOT_FOUND')
 expect(job?.results).toEqual([{action:'correct',outcome:'rejected',code:'MEMORY_TARGET_NOT_FOUND'},{action:'add',outcome:'applied'}])
})
it('an unrelated human addition does not reject a late proposal based on unchanged material',async()=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const f=await fixture(async function*(input){entered();await waiting;yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await started
 const s=await f.service.sourceForPrompt('a.md','task');await f.vault.memoryMutation(store=>store.add(store.read(),{content:'人的新修改',layer:'demand',scope:'本库',sources:[s],semantic:'fact',attribution:'人确认',reviewAt:null},true))
 release();await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['人的新修改','后续在本库使用中文']);expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
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
it('undoes one applied batch without restoring an obsolete version or reviving its evidence',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(f.engine.canUndo('task',f.material.materialVersion)).toBe(true)
 await f.engine.undo('task',f.material.materialVersion)
 expect(f.service.snapshot().record.entries).toHaveLength(0)
 expect(f.service.snapshot().record.forgotten).toHaveLength(1)
 expect(f.engine.canUndo('task',f.material.materialVersion)).toBe(false)
 await expect(f.engine.undo('task',f.material.materialVersion)).rejects.toThrow('MEMORY_RETRY_UNAVAILABLE')
})
it('forgetting evidence while a response is stalled prevents its late commit',async()=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const f=await fixture(async function*(input){entered();await waiting;yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task')
 await f.vault.memoryMutation(store=>store.add(store.read(),{content:'同一依据',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人确认',reviewAt:null},true))
 await f.engine.handoff(f.material);await started
 const basis=f.service.snapshot(),entry=basis.record.entries[0]!
 await f.service.forget({sessionId:f.material.context!.sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:entry.id,version:entry.version})
 release();await f.engine.idle();expect(f.service.snapshot().record.entries).toHaveLength(0)
})

it('a subsequent human edit invalidates batch undo without overwriting the newer content',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 const basis=f.service.snapshot(),entry=basis.record.entries[0]!
 await f.service.edit({sessionId:f.material.context!.sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:entry.id,version:entry.version},{content:'人的新措辞'})
 expect(f.engine.canUndo('task',f.material.materialVersion)).toBe(false)
 await expect(f.engine.undo('task',f.material.materialVersion)).rejects.toThrow('MEMORY_RETRY_UNAVAILABLE')
 expect(f.service.snapshot().record.entries[0]?.content).toBe('人的新措辞')
})

it('ranks related Chinese demand above eight unrelated core entries and retains candidate metadata',async()=>{
 let payload:any
 const f=await fixture(async function*(input){payload=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task')
 for(let i=0;i<8;i++)await f.vault.memoryMutation(store=>store.add(store.read(),{content:`会议预算第${i}项`,layer:'core',scope:'项目乙',sources:[source],semantic:'fact',attribution:'会议纪要',reviewAt:null},true))
 await f.vault.memoryMutation(store=>store.add(store.read(),{content:'后续中文表达采用正式语气',layer:'demand',scope:'本库',sources:[source],semantic:'standing',attribution:'人的要求',reviewAt:null},true))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(payload.memory.map((e:any)=>e.content)).toContain('后续中文表达采用正式语气')
 expect(payload.memory).toHaveLength(1)
 expect(payload.memory[0]).toMatchObject({layer:'demand',scope:'本库',semantic:'standing',attribution:'人的要求'})
})
it('includes the old factual correction target above eight unrelated core memories from an authorized new date',async()=>{
 let payload:any
 const f=await fixture(async function*(input){payload=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}},'火星项目交付日期已明确更正为十月三日')
 const source=await f.service.sourceForPrompt('a.md','task')
 for(let i=0;i<8;i++)await f.vault.memoryMutation(store=>store.add(store.read(),{content:`音乐节奏训练规则第${i}项`,layer:'core',scope:'音乐训练',sources:[source],semantic:'fact',attribution:'训练记录',reviewAt:null},true))
 await f.vault.memoryMutation(store=>store.add(store.read(),{content:'火星项目交付日期为十月一日',layer:'core',scope:'火星项目',sources:[source],semantic:'fact',attribution:'旧项目纪要',reviewAt:null},true))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(payload.memory).toHaveLength(1)
 expect(payload.sources.some((s:any)=>s.text.includes('明确更正为十月三日'))).toBe(true)
 expect(payload.memory[0]).toMatchObject({layer:'core',semantic:'fact',content:'火星项目交付日期为十月一日'})
})
it('caps related candidates at eight and trims the lowest rank within the existing input byte budget',async()=>{
 const requests:ModelStepInput[]=[]
 const f=await fixture(async function*(input){requests.push(input);yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task')
 for(let i=0;i<10;i++)await f.vault.memoryMutation(store=>store.add(store.read(),{content:`中文条目${i}：`+'x'.repeat(4050),layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人的说明',reviewAt:null},true))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(requests).toHaveLength(1)
 const input=requests[0]!,data=JSON.parse(String(input.messages[0]!.content))
 expect(data.memory.length).toBeGreaterThan(0);expect(data.memory.length).toBeLessThan(8)
 expect(Buffer.byteLength(String(input.messages[0]!.content))+Buffer.byteLength(input.system!)).toBeLessThanOrEqual(32768)
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
})

it('a failed post-save handoff leaves a visible rejected receipt and needs an explicit retry',async()=>{
 let calls=0;const f=await fixture(async function*(){calls++;yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}}),saved=f.service.savedMaterial.bind(f.service)
 vi.spyOn(f.service,'savedMaterial').mockRejectedValueOnce(Error('MEMORY_MATERIAL_CHANGED'))
 await f.engine.handoff(f.material).catch(()=>{});await f.engine.idle();expect(calls).toBe(0);expect(f.service.snapshot().record.jobs[0]).toMatchObject({taskId:'task',outcome:'rejected',reason:'MEMORY_MATERIAL_CHANGED'})
 await f.engine.retry('task',f.material.materialVersion,'configured');await f.engine.idle();expect(calls).toBe(1)
})

it('new authorized evidence can semantically correct a due candidate without silently reactivating old evidence',async()=>{
 let payload:any;const f=await fixture(async function*(input){payload=JSON.parse(String(input.messages[0]!.content));const target=payload.memory[0];yield {type:'text',text:JSON.stringify({proposals:target?[{...suggestion(input),action:'correct',id:target.id,version:target.version,content:'中文约定已由新口令确认'}]:[]})};yield {type:'finish',reason:'stop'}})
 await writeFile(path.join(f.vault.requireUsableRoot(),'b.md'),'以后用中文的旧约定');const old=await f.vault.readOpened('b.md'),source=await f.service.manualSource({...old,relPath:'b.md',kind:'body',start:0,end:old.content.length});await f.vault.memoryMutation(s=>s.add(s.read(),{content:'以后用中文的旧约定',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'旧口令',reviewAt:'2020-01-01T00:00:00Z'}));expect((await f.service.entries())[0]?.status).toBe('review');expect(f.service.snapshot().record.entries[0]?.status).toBe('active')
 await f.engine.handoff(f.material);await f.engine.idle();expect(payload.memory[0]?.status).toBe('review');expect(f.service.snapshot().record.entries[0]).toMatchObject({status:'active',content:'中文约定已由新口令确认',reviewAt:null})
})
it('an unavailable Host material result is visible and its retry uses freshly disclosed saved evidence',async()=>{
 let calls=0;const f=await fixture(async function*(){calls++;yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 const engine=f.engine as WorkingMemoryConsolidation & {materialFailed:(taskId:string,reason:string,sessionId?:string)=>Promise<void>}
 await engine.materialFailed('task','MEMORY_MATERIAL_CHANGED',f.material.context!.sessionId);expect(f.service.snapshot().record.jobs[0]).toMatchObject({outcome:'rejected',reason:'MEMORY_MATERIAL_CHANGED'});expect(calls).toBe(0)
 await engine.retry('task',f.material.materialVersion,'configured');await engine.idle();expect(calls).toBe(1)
})
it('unknown saved evidence produces a bounded non-retryable current-session result without inventing a version',async()=>{
 const f=await fixture(async function*(){yield {type:'finish',reason:'stop'}}),engine=f.engine as WorkingMemoryConsolidation & {materialFailed:(taskId:string,reason:string,sessionId?:string)=>Promise<void>;failureJobs:()=>import('../../src/shared/memory.ts').MemoryJobView[]}
 vi.spyOn(f.service,'savedMaterial').mockRejectedValueOnce(Error('MEMORY_JOB_UNAVAILABLE'));await engine.materialFailed('task','MEMORY_MATERIAL_UNVERIFIED',f.material.context!.sessionId)
 expect(f.service.snapshot().record.jobs).toEqual([]);expect(engine.failureJobs()[0]).toMatchObject({taskId:'task',materialVersion:null,outcome:'unavailable',retryable:false});expect(f.engine.state().permits).toBe(0)
})
it('real Host post-save evidence failure reaches the production engine result handler without blocking saved output',async()=>{
 const {AgentHost}=await import('../../src/main/agent-host.ts'),f=await fixture(async function*(){yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 let note=await f.vault.read('a.md');await f.vault.write('a.md',note.content+'\n\n/继续回答',note.revision,note);note=await f.vault.read('a.md');let completed=false,resultWork=Promise.resolve();const root=f.vault.requireUsableRoot(),engine=f.engine as WorkingMemoryConsolidation & {materialResult:(result:{sessionId?:string;taskId:string;status:'handed-off'|'unavailable'|'failed';reason?:string})=>Promise<void>}
 const host=new AgentHost({root:()=>root,session:()=>f.vault.sessionId(),acceptsObject:(p,b,a)=>f.vault.acceptsObject(p,b,a),read:p=>f.vault.read(p),write:(p,c,r,b)=>f.vault.write(p,c,r,b!),tier:async()=> 'reference',ledger:{prepare:(p,c,v,b)=>f.vault.ledgerPrepare(p,c,v,b),complete:async(p,id,r)=>{const saved=await f.vault.ledgerComplete(p,id,r);completed=true;return saved},contexts:p=>completed?Promise.resolve([]):f.vault.ledgerContexts(p)},onTaskStarted:id=>f.engine.capture(id),onTaskMaterialSaved:m=>f.engine.handoff(m),onTaskMaterialResult:r=>{resultWork=engine.materialResult(r)},credential:()=>({provider:'custom',baseURL:'https://example.test/v1',modelId:'answer',contextTokens:32768,apiKey:'test'}),limits:()=>({seconds:30,steps:4,tools:0}),stream:async function*(){yield '已保存的前台回答'},emit:vi.fn()})
 const start=note.content.lastIndexOf('/继续回答'),task=await host.start({relPath:'a.md',sessionId:note.sessionId,objectVersion:note.objectVersion,expectedRevision:note.revision,range:{start,end:start+5},expectedText:'/继续回答',promptText:'继续回答'});expect((await task.done).status).toBe('completed');await resultWork
 expect((await f.vault.read('a.md')).content).toContain('已保存的前台回答');expect(host.hasPending()).toBe(false);expect(f.service.snapshot().record.jobs.find(j=>j.taskId===task.id)).toMatchObject({outcome:'rejected'});expect(f.engine.state().permits).toBe(1)
})
it.each(['no-intent','late-session','closed'] as const)('material failure cannot invent or revive learning authority: %s',async mode=>{
 const f=await fixture(async function*(){yield {type:'finish',reason:'stop'}})
 if(mode==='no-intent')f.engine.discard('task');if(mode==='closed')f.engine.close()
 await f.engine.materialFailed('task','MEMORY_MATERIAL_CHANGED',mode==='late-session'?'old-session':f.material.context!.sessionId)
 expect(f.service.snapshot().record.jobs).toEqual([]);expect(f.engine.failureJobs()).toEqual([]);expect(f.engine.state().permits).toBe(mode==='late-session'?1:0)
})
it('a handoff evidence result arriving after a real vault session replacement cannot publish a failure into the new session',async()=>{
 const f=await fixture(async function*(){yield {type:'finish',reason:'stop'}}),saved=f.service.savedMaterial.bind(f.service);let release!:()=>void;const gate=new Promise<void>(r=>release=r);vi.spyOn(f.service,'savedMaterial').mockImplementation(async(...args)=>{await gate;return saved(...args)});const handoff=f.engine.handoff(f.material),old=f.vault.sessionId();f.vault.restore();expect(f.vault.sessionId()).not.toBe(old);release();await handoff.catch(()=>{});await f.engine.idle();expect(f.vault.memorySnapshot().record.jobs).toEqual([]);expect(f.engine.failureJobs()).toEqual([])
})

it.each(['disabled-known','disabled-unknown','signature-known','signature-unknown','cancel-known','cancel-unknown'] as const)('failure feedback remains authorized and tracked across saved evidence waits: %s',async mode=>{
 const f=await fixture(async function*(){throw Error('no model expected')}),saved=f.service.savedMaterial.bind(f.service);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);vi.spyOn(f.service,'savedMaterial').mockImplementation(async(...args)=>{entered();await gate;if(mode.endsWith('unknown'))throw Error('MEMORY_JOB_UNAVAILABLE');return saved(...args)})
 await f.vault.memoryMutation(s=>s.receipt(s.read(),{taskId:'prior',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]}));const original=f.service.snapshot().record.jobs,work=f.engine.materialResult({sessionId:f.service.context().sessionId,taskId:'task',status:'unavailable'});await started;let idleFinished=false;const idle=f.engine.idle().then(()=>{idleFinished=true});await Promise.resolve();const early=idleFinished
 if(mode.startsWith('disabled')){f.disableConfig();f.engine.cancel()}else if(mode.startsWith('signature'))f.changeConfig();else f.engine.cancel()
 release();await work;await idle;expect(early).toBe(false);expect(f.service.snapshot().record.jobs).toEqual(original);expect(f.engine.failureJobs()).toEqual([])
})
it('cancel releases idle for a pending failure proof without waiting for the underlying saved read',async()=>{
 const f=await fixture(async function*(){throw Error('no model expected')});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);vi.spyOn(f.service,'savedMaterial').mockImplementation(async()=>{entered();await gate;throw Error('MEMORY_JOB_UNAVAILABLE')});const work=f.engine.materialResult({sessionId:f.service.context().sessionId,taskId:'task',status:'unavailable'});await started;let done=false;const idle=f.engine.idle().then(()=>{done=true});await Promise.resolve();const early=done;f.engine.cancel()
 try{await vi.waitFor(()=>expect(done).toBe(true),{timeout:500});expect(early).toBe(false);await work;expect(f.engine.failureJobs()).toEqual([])}finally{release();await work;await idle}
})
it('handoff catch retains its cancellation proof while reporting a failure from a second saved read',async()=>{
 const f=await fixture(async function*(){throw Error('no model expected')});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);vi.spyOn(f.service,'savedMaterial').mockRejectedValueOnce(Error('MEMORY_MATERIAL_CHANGED')).mockImplementation(async()=>{entered();await gate;throw Error('MEMORY_JOB_UNAVAILABLE')});const work=f.engine.handoff(f.material).catch(()=>{});await started;f.engine.cancel();release();await work;await f.engine.idle();expect(f.service.snapshot().record.jobs).toEqual([]);expect(f.engine.failureJobs()).toEqual([])
})
it('a proven material whose failure receipt hits file capacity reports the capacity cause in its session-only result',async()=>{
 const f=await fixture(async function*(){throw Error('no model expected')});vi.spyOn(f.vault,'memoryMutation').mockRejectedValueOnce(Error('MEMORY_FILE_LIMIT'));await f.engine.materialResult({sessionId:f.service.context().sessionId,taskId:'task',status:'unavailable'});expect(f.engine.failureJobs()[0]).toMatchObject({reason:'MEMORY_FILE_LIMIT',materialVersion:null,retryable:false});expect(f.service.snapshot().record.jobs).toEqual([])
})
it.each(['token','bytes'] as const)('real consolidation output %s boundary reports its own cause and next step',async mode=>{
 const {memoryErrorText}=await import('../../src/shared/memory-errors.ts');const f=await fixture(async function*(){yield {type:mode==='token'?'text':'reasoning',text:'x'.repeat(mode==='token'?40000:1048577)};yield {type:'finish',reason:'stop'}});await f.engine.handoff(f.material);await f.engine.idle();const reason=f.service.snapshot().record.jobs[0]?.reason;expect(reason).toBe(mode==='token'?'MEMORY_OUTPUT_TOKEN_LIMIT':'MEMORY_OUTPUT_LIMIT');expect(memoryErrorText(reason!)).toContain('输出');expect(memoryErrorText(reason!)).not.toMatch(/遗忘空间|修订计数|普通修改已暂停/);expect(f.service.snapshot().record.entries).toEqual([])
})
it('the real sixteen-item pending queue refusal uses a queue cause while preserving ordinary saved answers',async()=>{
 const {memoryErrorText}=await import('../../src/shared/memory-errors.ts');let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const f=await fixture(async function*(){entered();await gate;yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}});await f.engine.handoff(f.material);await started
 try{for(let i=0;i<17;i++){const taskId='queue-'+i,prompt='排队口令'+i;let note=await f.vault.read('a.md');const start=note.content.length+1,marked=markPrompt(note.content+'\n/'+prompt,{taskId,range:{start,end:start+prompt.length+1},expectedText:'/'+prompt,promptText:prompt});await f.vault.write('a.md',marked,note.revision,note);note=await f.vault.read('a.md');f.engine.capture(taskId);await f.vault.ledgerPrepare('a.md',{taskId,startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt,answer:'已保存回答'});const saved=await f.vault.write('a.md',upsertAiAnswer(note.content,{taskId,answer:'已保存回答'}),note.revision,note);await f.vault.ledgerComplete('a.md',taskId,saved.revision);await f.engine.handoff(await f.service.savedMaterial('a.md',taskId))}
  const reason=f.service.snapshot().record.jobs.find(j=>j.taskId==='queue-16')?.reason;expect(reason).toBe('MEMORY_QUEUE_FULL');expect(memoryErrorText(reason!)).toContain('队列');expect(memoryErrorText(reason!)).not.toMatch(/遗忘空间|修订计数|普通修改已暂停/);expect((await f.vault.read('a.md')).content).toContain('已保存回答')
 }finally{f.engine.cancel();release();await f.engine.idle()}
})

it('v5 keeps recent context and independent long proposals in one saved batch',async()=>{
 const f=await fixture(async function*(input){const d=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:{goal:'本库后续使用中文',completed:'助手回复已保存，尚未确认',blocked:'',next:'',sourceIds:[d.sources[0].id],assistantDraft:true},proposals:[suggestion(input),{...suggestion(input),sourceIds:['forged']}]})};yield {type:'finish',reason:'stop'}},'以后用中文','continuity')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(f.service.snapshot().record.entries).toHaveLength(1)
 expect(f.service.snapshot().record.recent).toHaveLength(1)
 expect(f.service.snapshot().record.recent[0]?.recent.taskId).toBe('task')
 expect(f.service.snapshot().record.jobs[0]?.entryIds).toHaveLength(2)
})
it('v5 validates recent independently and strictly limits long actions to sixteen',()=>{
 expect(parseContinuitySuggestions('```json\n{"recent":null,"proposals":[]}\n```').proposals).toEqual([])
 expect(()=>parseContinuitySuggestions(JSON.stringify({recent:null,proposals:Array(17).fill({})}))).toThrow('MEMORY_OUTPUT_INVALID')
 expect(()=>parseContinuitySuggestions('{"proposals":[]}')).toThrow('MEMORY_OUTPUT_INVALID')
})
it('v5 does not recheck every streamed fragment and marks only the consolidation request',async()=>{
 const requests:ModelStepInput[]=[]
 const f=await fixture(async function*(input){requests.push(input);for(const c of '{"recent":null,"proposals":[]}')yield {type:'text',text:c};yield {type:'finish',reason:'stop'}},'临时整理一下','continuity')
 const spy=vi.spyOn(f.service,'verifySource');await f.engine.handoff(f.material);await f.engine.idle()
 expect(requests[0]?.purpose).toBe('consolidation');expect(spy.mock.calls.length).toBeLessThan(15)
})

it.each(['empty','length'] as const)('v5 does not spend a repair call on %s output',async kind=>{
 let calls=0
 const f=await fixture(async function*(){calls++;yield {type:'finish',reason:kind==='length'?'length':'stop'}},'记录项目要求','continuity')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(1);expect(f.service.snapshot().record.jobs[0]?.reason).toBe(kind==='length'?'MEMORY_OUTPUT_TRUNCATED':'MEMORY_OUTPUT_EMPTY')
})
it('v5 forgetting a recent block revokes a committed followup dependency',async()=>{
 const f=await fixture(async function*(input){const d=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:{goal:'中文工作接续',completed:'',blocked:'',next:'',sourceIds:[d.sources[0].id],assistantDraft:false},proposals:[]})};yield {type:'finish',reason:'stop'}},'本次使用中文','continuity')
 await f.engine.handoff(f.material);await f.engine.idle();expect((await f.service.entries())[0]?.category).toBe('recent')
 const {createMemoryUsePermit}=await import('../../src/main/memory-use.ts'),credential={provider:'custom' as const,modelId:'m',baseURL:'https://example.test/v1',apiKey:'fiction',contextTokens:32768}
 const permit=await createMemoryUsePermit({context:()=>f.service.context(),config:()=>({enabled:true,revision:1}),entries:ids=>f.service.entries(ids)},credential,'接续工作','')
 const recent=permit.recall.recent![0]!;permit.stage([recent.id]);permit.markSent()
 const basis=f.service.snapshot();await f.service.forget({sessionId:f.service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:recent.id,version:recent.version})
 await expect(permit.assertCurrent(credential)).rejects.toThrow('MEMORY_CHANGED');expect(f.service.snapshot().record.recent).toEqual([])
})
it('default paraphrases inherit sent memory dependencies and forgetting revokes their closure',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task')
 const parent=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'上游项目事实',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人的口令',reviewAt:null}))
 f.material.memoryDeps=[{id:parent.id,version:parent.version,basisHashes:[source.basisHash],sourceDeps:[{id:source.id,version:source.version,hash:source.hash,relPath:source.relPath,kind:source.kind,taskId:source.taskId}]}]
 vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 await f.engine.handoff(f.material);await f.engine.idle()
 const derived=f.service.snapshot().record.entries.find(e=>e.id!==parent.id)!
 expect(derived.sources[0]!.memoryDeps).toContainEqual({id:parent.id,version:parent.version})
 const basis=f.service.snapshot();await f.service.forget({sessionId:f.service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:parent.id,version:parent.version})
 expect(f.service.snapshot().record.entries).toEqual([])
})
it.each(['recent','add'] as const)('rejects a new %s against a same-batch replaced version while retaining the independent correction',async kind=>{
 const f=await fixture(async function*(input){
  const p=JSON.parse(String(input.messages[0]!.content)),target=p.memory[0],sourceIds=[p.sources[0].id]
  const corrected={action:'correct',id:target.id,version:target.version,content:'青灯项目版本明确更正为乙',layer:'demand',semantic:'fact',scope:'本库',sourceIds,attribution:'人的口令',reviewAt:null}
  yield {type:'text',text:JSON.stringify({recent:kind==='recent'?{goal:'青灯接续',completed:'版本更正',blocked:'',next:'',sourceIds,assistantDraft:false}:null,proposals:[corrected,...(kind==='add'?[{...corrected,action:'add',id:undefined,version:undefined,content:'青灯下次核对更正版本'}]:[])]})};yield {type:'finish',reason:'stop'}
 },'青灯项目版本明确更正为乙','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目版本为甲',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人的口令',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle()
 const rows=await f.service.entries()
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:old.id,version:2,status:'active',content:'青灯项目版本明确更正为乙'})
 expect(f.service.snapshot().record.recent).toEqual([])
 expect(f.service.snapshot().record.jobs[0]).toMatchObject({outcome:'applied',reason:'MEMORY_DEPENDENCY_CHANGED',entryIds:[old.id]})
})
it('corrects an actually Host-sent old version without self dependency and retains its upstream forgetting closure',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-host-correction-')),credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'fiction',contextTokens:32768}
 cleanups.push(()=>rm(base,{recursive:true,force:true}))
 let targetId='',upstreamId=''
 for(let step=1;step<=3;step++){
  const result=await runMemoryQualityCase({id:'host-correction-'+step,group:'fact',heldOut:false,prompt:'青灯项目版本明确更正，记录青灯项目事实',body:'青灯项目版本记录需要核对。',answer:'受控草稿',expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){
   const p=JSON.parse(String(input.messages[0]!.content)),target=p.memory.find((e:any)=>e.id===targetId)
   yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:step===3?'correct':'add',...(step===3?{id:target.id,version:target.version}:{}),content:step===1?'青灯项目使用版本依据':step===2?'青灯项目版本为甲':'青灯项目版本明确更正为乙',layer:'demand',scope:'本库',sourceIds:[p.sources.find((s:any)=>s.classification==='command').id],semantic:'fact',attribution:'人的口令',reviewAt:null}]})};yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',base,noteName:`step-${step}.md`,hostBeforeConsolidation:true})
  expect(result.completed).toBe(true)
  if(step===1)upstreamId=result.entries[0]!.id
  if(step===2)targetId=result.entries.find(e=>e.id!==upstreamId)!.id
  if(step===3){
   expect(result.material.memoryDeps).toEqual(expect.arrayContaining([expect.objectContaining({id:targetId,version:1})]))
   const target=result.entries.find(e=>e.id===targetId)!
   expect(target).toMatchObject({version:2,status:'active'})
   expect(target.sources.flatMap(s=>s.memoryDeps)).not.toEqual(expect.arrayContaining([expect.objectContaining({id:targetId})]))
   expect(target.sources.flatMap(s=>s.memoryDeps)).toContainEqual({id:upstreamId,version:1})
  }
 }
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null),basis=service.snapshot(),upstream=basis.record.entries.find(e=>e.id===upstreamId)!
  await service.forget({sessionId:service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:upstream.id,version:upstream.version})
  expect(service.snapshot().record.entries).toEqual([])
 }finally{vault.dispose()}
},20000)

const roleSource=(id:string,text:string,classification:'command'|'human'):WorkingSource=>({id,version:1,relPath:'a.md',objectVersion:'object',revision:'a'.repeat(64),permissionTier:'reference',kind:classification==='command'?'ledger':'body',taskId:'task',taskMaterialHash:'b'.repeat(64),classification,start:0,end:text.length,text,hash:createHash('sha256').update(text).digest('hex'),basisHash:'d'.repeat(64),sourceDeps:[],memoryDeps:[],materialId:'task/fragment',sequence:1})
it('keeps a verbatim authority quote and demotes extra citations into the supporting role',()=>{
 const command=roleSource('cmd','以后在本库解释先给结论','command'),human=roleSource('body','我偏好先给结论再举例子','human')
 const agreement=roleAgreement({semantic:'standing',authority:[{sourceId:'cmd',quote:'先给结论'}],sourceIds:['cmd','body']},[command,human])
 expect(agreement).toEqual({agreement:{authority:[{sourceId:'cmd',quote:'先给结论'}],supporting:['body']},extra:[]})
 expect(roleAgreement({semantic:'fact',authority:[{sourceId:'body',quote:'先给结论'}],sourceIds:['body']},[human])).toEqual({agreement:{authority:[{sourceId:'body',quote:'先给结论'}],supporting:[]},extra:[]})
})
it('refuses standing without a verbatim human command and keeps the legacy rule for old proposals',()=>{
 const command=roleSource('cmd','以后在本库解释先给结论','command'),human=roleSource('body','我偏好先给结论','human')
 expect(()=>roleAgreement({semantic:'standing',authority:[{sourceId:'cmd',quote:'口令里没有这句话'}],sourceIds:['cmd']},[command])).toThrow()
 expect(()=>roleAgreement({semantic:'standing',authority:[{sourceId:'body',quote:'先给结论'}],sourceIds:['body']},[human])).toThrow()
 expect(()=>roleAgreement({semantic:'standing',authority:[],sourceIds:['cmd']},[command])).toThrow()
 expect(()=>roleAgreement({semantic:'standing',authority:[{sourceId:'missing',quote:'先给结论'}],sourceIds:['cmd']},[command])).toThrow()
 expect(()=>roleAgreement({semantic:'standing',authority:[{sourceId:'cmd',quote:'先给结论'}],supporting:['missing'],sourceIds:['cmd']},[command])).toThrow()
 // 旧口径（没有角色字段）仍然是"每个引用都必须是口令"，不因新字段放宽
 expect(()=>roleAgreement({semantic:'standing',sourceIds:['body']},[human])).toThrow()
 // v6 口径：即使引用全是口令，没有显式 authority 的长期约定也要拒绝
 expect(()=>roleAgreement({semantic:'standing',sourceIds:['cmd']},[command],true)).toThrow()
 expect(roleAgreement({semantic:'standing',sourceIds:['cmd'],authority:[{sourceId:'cmd',quote:'先给结论'}]},[command],true)).toEqual({agreement:{authority:[{sourceId:'cmd',quote:'先给结论'}],supporting:[]},extra:[]})
 // 佐证可以只出现在本场来源里：并入条目来源并记为辅助，不因未重复写进 sourceIds 而拒绝整条。
 const role=roleAgreement({semantic:'standing',authority:[{sourceId:'cmd',quote:'先给结论'}],sourceIds:['cmd'],supporting:['body']},[command],true,id=>id==='body'?human:undefined)!
 expect(role.agreement.supporting).toEqual(['body'])
 expect(role.extra.map(source=>source.id)).toEqual(['body'])
 expect(roleAgreement({semantic:'fact',sourceIds:['body']},[human])).toBeUndefined()
})
it('saves a standing agreement that quotes the original command and refuses one without authority',async()=>{
 const proposal=(authority:boolean)=>(input:ModelStepInput)=>{
  const data=JSON.parse(String(input.messages[0]!.content)),first=data.sources[0]
  return {recent:null,proposals:[{action:'add',content:'以后在本库解释先给结论',layer:'core',scope:'本库',sourceIds:[first.id],semantic:'standing',attribution:'人的口令',reviewAt:null,...(authority?{authority:[{sourceId:first.id,quote:String(first.text).slice(0,4)}]}:{})}]}
 }
 const accepted=await fixture(async function*(input){yield {type:'text',text:JSON.stringify(proposal(true)(input))};yield {type:'finish',reason:'stop'}},'以后在本库解释先给结论','continuity')
 await accepted.engine.handoff(accepted.material);await accepted.engine.idle()
 const entry=(await accepted.service.entries())[0]
 expect(entry?.content).toBe('以后在本库解释先给结论')
 expect(entry?.agreement?.authority).toHaveLength(1)
 expect(entry?.agreement?.authority[0]?.quote).toBe('以后在本')
 expect(accepted.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
 const refused=await fixture(async function*(input){yield {type:'text',text:JSON.stringify(proposal(false)(input))};yield {type:'finish',reason:'stop'}},'以后在本库解释先给结论','continuity')
 await refused.engine.handoff(refused.material);await refused.engine.idle()
 expect(await refused.service.entries()).toHaveLength(0)
 expect(refused.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID')
})

const transport=(code:string)=>new Error('MODEL_REQUEST_FAILED',{cause:{code,httpStatus:null}})
it('retries one explicit transport failure and still shares the two-call budget',async()=>{
 let calls=0
 const f=await fixture(async function*(input){calls++
  if(calls===1)throw transport('ENOTFOUND')
  yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(2)
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
})
it('never retries certificate or authentication failures',async()=>{
 let calls=0
 const f=await fixture(async function*(){calls++;throw transport('UNABLE_TO_VERIFY_LEAF_SIGNATURE')})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(1)
 expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_SERVICE_FAILED')
})
it('never retries a transport interruption that already produced partial text',async()=>{
 let calls=0
 const f=await fixture(async function*(){calls++;yield {type:'text',text:'{"proposals":'};throw transport('ECONNRESET')})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(1)
 expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID')
})
it('does not attempt a third call when the retry itself returns unusable output',async()=>{
 let calls=0
 const f=await fixture(async function*(){calls++
  if(calls===1)throw transport('ETIMEDOUT')
  yield {type:'text',text:'not json'};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(2)
 expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID')
})
it('spends the second call on the format repair when the first transport attempt succeeded',async()=>{
 let calls=0
 const f=await fixture(async function*(){calls++;yield {type:'text',text:calls===1?'bad json':'{"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(2)
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
 expect(f.service.snapshot().record.jobs[0]?.reason).toBeUndefined()
})

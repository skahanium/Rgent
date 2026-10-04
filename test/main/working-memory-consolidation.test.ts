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
async function fixture(stream:(input:ModelStepInput)=>AsyncIterable<ModelStepEvent>,prompt='以后用中文'){
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-consolidate-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const marked=markPrompt('/'+prompt,{taskId:'task',range:{start:0,end:prompt.length+1},expectedText:'/'+prompt,promptText:prompt})
 await writeFile(path.join(root,'a.md'),marked)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 const service=new WorkingMemoryService(vault,()=>null);await service.initialize()
 let signature='configured',enabled=true;const configuration=()=>({enabled,signature,credential:{provider:'custom' as const,modelId:'memory',baseURL:'https://example.test/v1',apiKey:'secret',contextTokens:32768},limits:{seconds:120,calls:2,tools:0}})
 const engine=new WorkingMemoryConsolidation({service:()=>service,configuration,stream,changed:vi.fn()})
 engine.capture('task')
 let note=await vault.readOpened('a.md')
 await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt,answer:'好的'})
 const result=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note)
 await vault.ledgerComplete('a.md','task',result.revision)
 const material=await service.savedMaterial('a.md','task')
 cleanups.push(async()=>{engine.close();await engine.idle();vault.dispose();await rm(base,{recursive:true,force:true})})
 return {vault,service,engine,material,changeConfig:()=>{signature='changed'},disableConfig:()=>{enabled=false}}
}
const suggestion=(input:ModelStepInput)=>{const data=JSON.parse(String(input.messages[0]!.content));return {action:'add',content:'后续在本库使用中文',layer:'core',scope:'本库',sourceIds:[data.sources[0].id],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null}}
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
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied');expect(f.engine.state()).toEqual({permits:0,pending:0,active:0})
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
 expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID')
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
 await writeFile(path.join(f.vault.requireUsableRoot(),'b.md'),'以后用中文的旧约定');const old=await f.vault.readOpened('b.md'),source=await f.service.manualSource({...old,relPath:'b.md',kind:'body',start:0,end:old.content.length});await f.vault.memoryMutation(s=>s.add(s.read(),{content:'以后用中文的旧约定',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'旧口令',reviewAt:'2020-01-01T00:00:00Z'}));await f.service.entries();expect(f.service.snapshot().record.entries[0]?.status).toBe('review')
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

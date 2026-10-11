import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach,it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {WorkingMemoryConsolidation,parseMemorySuggestions,parseContinuitySuggestions,roleAgreement,inheritInputs,memoryContinuitySystem,protocolRepairPlan,standingEscalationBlocked,suspectSiblingClaim,repairFieldLock,workStateShaped} from '../../src/main/working-memory-consolidation.ts'
import {sameClaimIgnoringSemantic} from '../../src/main/working-memory-store.ts'
import type {WorkingSource} from '../../src/main/working-memory-store.ts'
import {createHash} from 'node:crypto'
import {serializeStoredVault} from '../../src/main/notes-fs.ts'
import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
import type {ModelStepInput,ModelStepEvent} from '../../src/main/model-stream.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<typeof import('../../src/main/watch.ts')>(),watchVault:()=>()=>{}}))
const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const clean of cleanups.splice(0))await clean()})
async function fixture(stream:(input:ModelStepInput)=>AsyncIterable<ModelStepEvent>,prompt='以后用中文',strategy?:'continuity',history=false,observeRequest?:import('../../src/main/working-memory-consolidation.ts').ConsolidationPorts['observeRequest'],calls=2){
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-consolidate-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const marked=markPrompt('/'+prompt,{taskId:'task',range:{start:0,end:prompt.length+1},expectedText:'/'+prompt,promptText:prompt})
 await writeFile(path.join(root,'a.md'),marked)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 const service=new WorkingMemoryService(vault,()=>null);await service.initialize()
 let signature='configured',enabled=true;const configuration=()=>({enabled,signature,credential:{provider:'custom' as const,modelId:'memory',baseURL:'https://example.test/v1',apiKey:'secret',contextTokens:32768},limits:{seconds:120,calls,tools:0}})
 const ports={service:()=>service,configuration,stream,changed:vi.fn(),strategy,observeRequest},engine=history?WorkingMemoryConsolidation.forHistoricalEvaluation(ports):new WorkingMemoryConsolidation(ports)
 engine.capture('task')
 let note=await vault.readOpened('a.md')
 await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt,answer:'好的',provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:[]}})
 const result=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note)
 await vault.ledgerComplete('a.md','task',result.revision)
 const material=await service.savedMaterial('a.md','task')
 cleanups.push(async()=>{engine.close();await engine.idle();vault.dispose();await rm(base,{recursive:true,force:true})})
 return {vault,service,engine,material,changeConfig:()=>{signature='changed'},disableConfig:()=>{enabled=false}}
}
const suggestion=(input:ModelStepInput)=>{const data=JSON.parse(String(input.messages[0]!.content));const first=data.sources[0];return {action:'add',content:'后续在本库使用中文',scope:'本库',sourceIds:[first.id],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null,authority:[{sourceId:first.id,quote:String(first.text).slice(0,4)}]}}
it('cancel and idle include a handoff still checking saved material',async()=>{
 let calls=0,release!:()=>void
 const f=await fixture(async function*(){calls++;yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}})
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
 let calls=0;const f=await fixture(async function*(input){calls++;yield {type:'reasoning',text:'x'.repeat(40000)};yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input),{...suggestion(input),sourceIds:['forged']}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied');expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID');expect(f.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'rejected',code:'MEMORY_OUTPUT_REFERENCE_INVALID'});expect(f.engine.state()).toEqual({permits:0,pending:0,active:0})
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(2)
})
it('rejects a non-ASCII group as a whole while accepting an independent factual proposal',async()=>{
 const f=await fixture(async function*(input){
  const base={...suggestion(input),semantic:'fact',content:'负责人在评审中提出预算需要复核',scope:'评审项目',attribution:'本场口令转述负责人'}
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[{...base,group:'项目事实'},{...base,group:'项目事实',content:'预算仍待确认'},{...base,group:'review_fact-1',content:'负责人要求复核预算'}]})};yield {type:'finish',reason:'stop'}
 },'保存负责人在评审中提出的预算复核事项')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['负责人要求复核预算'])
 expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID')
})
it('rejects invented correction targets without discarding a factual add that omits group',async()=>{
 const f=await fixture(async function*(input){
  const base={...suggestion(input),semantic:'fact',content:'验收时间需重新确认',scope:'项目验收',attribution:'人的本场说明'}
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[{...base,action:'correct',target:'invented-entry'},base]})};yield {type:'finish',reason:'stop'}
 },'记录验收时间还需重新确认')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['验收时间需重新确认'])
 // 找不到更新目标要留下自己的原因，既不新增冲突副本，也不折成格式错误。
 const job=f.service.snapshot().record.jobs[0]
 expect(job?.reason).toBe('MEMORY_OUTPUT_INVALID')
 expect(job?.results).toEqual([{action:'correct',outcome:'rejected',code:'MEMORY_TARGET_NOT_FOUND'},{action:'add',outcome:'applied'}])
})
it('an unrelated human addition does not reject a late proposal based on unchanged material',async()=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const f=await fixture(async function*(input){entered();await waiting;yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await started
 const s=await f.service.sourceForPrompt('a.md','task');await f.vault.memoryMutation(store=>store.add(store.read(),{content:'人的新修改',layer:'demand',scope:'本库',sources:[s],semantic:'fact',attribution:'人确认',reviewAt:null},true))
 release();await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['人的新修改','后续在本库使用中文']);expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
})
it('revoked configuration and forgotten evidence prevent a late response from becoming active',async()=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const f=await fixture(async function*(input){entered();await waiting;yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await started;f.changeConfig();release();await f.engine.idle()
 expect(f.service.snapshot().record.entries).toHaveLength(0);expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_PERMISSION_CHANGED')
})
it('one repair retains authorized sources and the draft issues; tool calls are always rejected',async()=>{
 const requests:ModelStepInput[]=[];const f=await fixture(async function*(input){requests.push(input);yield {type:'text',text:requests.length===1?'bad json':JSON.stringify({recent:null,proposals:[]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle();expect(requests).toHaveLength(2)
 expect(String(requests[1]!.messages[0]!.content)).toContain('以后用中文');expect(requests[0]!.tools).toBeUndefined()
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
})
it('undoes one applied batch without restoring an obsolete version or reviving its evidence',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
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
 const f=await fixture(async function*(input){entered();await waiting;yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task')
 await f.vault.memoryMutation(store=>store.add(store.read(),{content:'同一依据',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人确认',reviewAt:null},true))
 await f.engine.handoff(f.material);await started
 const basis=f.service.snapshot(),entry=basis.record.entries[0]!
 await f.service.forget({sessionId:f.material.context!.sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:entry.id,version:entry.version})
 release();await f.engine.idle();expect(f.service.snapshot().record.entries).toHaveLength(0)
})

it('a subsequent human edit invalidates batch undo without overwriting the newer content',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 const basis=f.service.snapshot(),entry=basis.record.entries[0]!
 await f.service.edit({sessionId:f.material.context!.sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:entry.id,version:entry.version},{content:'人的新措辞'})
 expect(f.engine.canUndo('task',f.material.materialVersion)).toBe(false)
 await expect(f.engine.undo('task',f.material.materialVersion)).rejects.toThrow('MEMORY_RETRY_UNAVAILABLE')
 expect(f.service.snapshot().record.entries[0]?.content).toBe('人的新措辞')
})

it('ranks related Chinese demand above eight unrelated core entries and retains candidate metadata',async()=>{
 let payload:any
 const f=await fixture(async function*(input){payload=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}},'以后用中文',undefined,true)
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
 const f=await fixture(async function*(input){payload=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}},'火星项目交付日期已明确更正为十月三日')
 const source=await f.service.sourceForPrompt('a.md','task')
 for(let i=0;i<8;i++)await f.vault.memoryMutation(store=>store.add(store.read(),{content:`音乐节奏训练规则第${i}项`,layer:'core',scope:'音乐训练',sources:[source],semantic:'fact',attribution:'训练记录',reviewAt:null},true))
 await f.vault.memoryMutation(store=>store.add(store.read(),{content:'火星项目交付日期为十月一日',layer:'core',scope:'火星项目',sources:[source],semantic:'fact',attribution:'旧项目纪要',reviewAt:null},true))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(payload.memory).toHaveLength(1)
 expect(payload.sources.some((s:any)=>s.text.includes('明确更正为十月三日'))).toBe(true)
 expect(payload.memory[0]).toMatchObject({semantic:'fact',content:'火星项目交付日期为十月一日'})
})
it('caps related candidates at eight and trims the lowest rank within the existing input byte budget',async()=>{
 const requests:ModelStepInput[]=[]
 const f=await fixture(async function*(input){requests.push(input);yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}})
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
 let calls=0;const f=await fixture(async function*(){calls++;yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}}),saved=f.service.savedMaterial.bind(f.service)
 vi.spyOn(f.service,'savedMaterial').mockRejectedValueOnce(Error('MEMORY_MATERIAL_CHANGED'))
 await f.engine.handoff(f.material).catch(()=>{});await f.engine.idle();expect(calls).toBe(0);expect(f.service.snapshot().record.jobs[0]).toMatchObject({taskId:'task',outcome:'rejected',reason:'MEMORY_MATERIAL_CHANGED'})
 await f.engine.retry('task',f.material.materialVersion,'configured');await f.engine.idle();expect(calls).toBe(1)
})

it('new authorized evidence can semantically correct a due candidate without silently reactivating old evidence',async()=>{
 let payload:any;const f=await fixture(async function*(input){payload=JSON.parse(String(input.messages[0]!.content));const target=payload.memory[0];yield {type:'text',text:JSON.stringify({recent:null,proposals:target?[{...suggestion(input),action:'correct',target:target.id,content:'中文约定已由新口令确认'}]:[]})};yield {type:'finish',reason:'stop'}})
 await writeFile(path.join(f.vault.requireUsableRoot(),'b.md'),'以后用中文的旧约定');const old=await f.vault.readOpened('b.md'),source=await f.service.manualSource({...old,relPath:'b.md',kind:'body',start:0,end:old.content.length});await f.vault.memoryMutation(s=>s.add(s.read(),{content:'以后用中文的旧约定',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'旧口令',reviewAt:'2020-01-01T00:00:00Z'}));expect((await f.service.entries())[0]?.status).toBe('review');expect(f.service.snapshot().record.entries[0]?.status).toBe('active')
 await f.engine.handoff(f.material);await f.engine.idle();expect(payload.memory[0]?.status).toBe('review');expect(f.service.snapshot().record.entries[0]).toMatchObject({status:'active',content:'中文约定已由新口令确认',reviewAt:null})
})
it('an unavailable Host material result is visible and its retry uses freshly disclosed saved evidence',async()=>{
 let calls=0;const f=await fixture(async function*(){calls++;yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}})
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
 const {AgentHost}=await import('../../src/main/agent-host.ts'),f=await fixture(async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}})
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
 const {memoryErrorText}=await import('../../src/shared/memory-errors.ts');let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const f=await fixture(async function*(){entered();await gate;yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}});await f.engine.handoff(f.material);await started
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
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
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
it.each(['recent','paraphrase','exact'] as const)('retains only actually displayed background candidate dependencies unless the full current command proves independence (%s)',async mode=>{
 let parentId=''
 const f=await fixture(async function*(input){
  const p=JSON.parse(String(input.messages[0]!.content)),s=p.sources[0]
  expect(p.memory.map((e:any)=>e.content)).toEqual(['青灯项目版本为甲'])
  yield {type:'text',text:JSON.stringify({recent:mode==='recent'?{goal:'青灯项目后续核对',completed:'',blocked:'',next:'核对青灯版本',sourceIds:[s.id],assistantDraft:false}:null,proposals:mode==='recent'?[]:[{action:'add',content:mode==='exact'?s.text:'青灯项目后续核对',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人的口令',reviewAt:null}]})};yield {type:'finish',reason:'stop'}
 },'青灯项目继续核对','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),parent=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目版本为甲',layer:'demand',scope:'青灯项目',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}));parentId=parent.id
 const unrelated=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'另一个无关主题',layer:'demand',scope:'外部主题',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 expect(f.material.memoryDeps).toEqual([])
 await f.engine.handoff(f.material);await f.engine.idle()
 const derived=(await f.service.entries()).find(e=>e.id!==parent.id&&e.id!==unrelated.id)!
 expect(derived.sources.flatMap(s=>s.memoryDeps)).toEqual(mode==='exact'?[]:[{id:parent.id,version:1}])
 const basis=f.service.snapshot();await f.service.forget({sessionId:f.service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:parent.id,version:1})
 expect(f.service.snapshot().record.entries.some(e=>e.id===unrelated.id)).toBe(true)
 expect([...f.service.snapshot().record.entries,...f.service.snapshot().record.recent].some(e=>e.id===derived.id)).toBe(mode==='exact')
})
it.each(['trim','overflow'] as const)('bounds background candidate inputs when sixteen foreground dependencies fill M4 (%s)',async mode=>{
 let sent:string[]=[],calls=0
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content)),s=p.sources[0];sent=p.memory.map((e:any)=>e.id);yield {type:'text',text:JSON.stringify({recent:{goal:'青灯继续核对',completed:'',blocked:'',next:'',sourceIds:[s.id],assistantDraft:false},proposals:[]})};yield {type:'finish',reason:'stop'}},'青灯项目继续核对','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),parents=[]
 for(let i=0;i<16;i++)parents.push(await f.vault.memoryMutation(store=>store.add(store.read(),{content:'基础条目'+i,layer:'demand',scope:'外部主题',sources:[source],semantic:'fact',attribution:'人',reviewAt:null})))
 const extra=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目版本为甲',layer:'demand',scope:'青灯项目',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 f.material.memoryDeps=parents.map(e=>({id:e.id,version:1,basisHashes:[source.basisHash],sourceDeps:[{id:source.id,version:1,hash:source.hash,relPath:'a.md',kind:'ledger',taskId:'task'}]}));vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 if(mode==='overflow')vi.spyOn(f.service,'sourceForPrompt').mockResolvedValue({...source,memoryDeps:[{id:extra.id,version:1}]})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(sent).not.toContain(extra.id)
 const record=f.service.snapshot().record
 if(mode==='overflow'){expect(calls).toBe(0);expect(record.jobs.at(-1)?.reason).toBe('MEMORY_INPUT_LIMIT');expect(record.recent).toHaveLength(0)}
 else{expect(record.recent).toHaveLength(1);expect(record.recent[0]!.sources.every(s=>s.memoryDeps.length===16)).toBe(true)}
 expect(record.entries.some(e=>e.id===extra.id)).toBe(true)
})
it.each(['recent','add'] as const)('keeps a correction and isolates its displayed old candidate from the simultaneous %s result',async kind=>{
 const f=await fixture(async function*(input){
  const p=JSON.parse(String(input.messages[0]!.content));if(!p.memory){yield {type:'text',text:'{"recent":null}'};yield {type:'finish',reason:'stop'};return}const target=p.memory[0],sourceIds=[p.sources[0].id]
  const corrected={action:'correct',target:target.id,content:'青灯项目版本明确更正为乙',semantic:'fact',scope:'本库',sourceIds,attribution:'人的口令',reviewAt:null}
  yield {type:'text',text:JSON.stringify({recent:kind==='recent'?{goal:'青灯接续',completed:'版本更正',blocked:'',next:'',sourceIds,assistantDraft:false}:null,proposals:[corrected,...(kind==='add'?[{...corrected,action:'add',target:undefined,content:p.sources[0].text,scope:'a.md'}] :[])]})}
  yield {type:'finish',reason:'stop'}
 },'青灯项目版本明确更正为乙','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目版本为甲',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人的口令',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle()
 const rows=await f.service.entries(),job=f.service.snapshot().record.jobs[0]
 // 更正落地；只有程序可证明的完整新口令可免去实际展示旧候选的粗依赖。
 expect(rows.find(e=>e.id===old.id)).toMatchObject({version:2,status:'active',content:'青灯项目版本明确更正为乙'})
 if(kind==='add'){expect(job?.reason).toBeUndefined();expect(rows.some(e=>e.id!==old.id&&e.content==='青灯项目版本明确更正为乙')).toBe(true)}
 else{expect(job?.results).toContainEqual({action:'recent',outcome:'applied'});expect(f.service.snapshot().record.recent).toHaveLength(1);expect(f.service.snapshot().record.recent[0]!.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual({id:old.id,version:1})}
})
it('inherits only the material, cited-source and replaced-entry dependencies',()=>{
 const src=(id:string,memoryDeps:{id:string;version:number}[]=[],sourceDeps:any[]=[])=>({id,version:1,relPath:'a.md',objectVersion:'o',revision:'a'.repeat(64),permissionTier:'reference' as const,kind:'ledger' as const,taskId:'t',taskMaterialHash:'b'.repeat(64),classification:'command' as const,start:0,end:1,text:'x',hash:'c'.repeat(64),basisHash:'d'.repeat(64),sourceDeps,memoryDeps,materialId:'t/f',sequence:1})
 const entry=(id:string,version:number,sources:any[])=>({id,version,content:id,layer:'demand' as const,scope:'库',sources,semantic:'fact' as const,attribution:'人',reviewAt:null,status:'active' as const,state:{source:'verified' as const,content:'current' as const,enabled:true,capacity:'ready' as const},reason:null,updatedAt:'2026-01-01T00:00:00Z',updateBasis:{kind:'manual' as const,id:'m',version:1}})
 const unrelated=entry('unrelated',1,[src('s-unrelated')])
 const cited=src('s-cited',[{id:'dep-of-cited',version:3}])
 const replaced=entry('replaced',4,[src('s-replaced-source',[{id:'dep-of-replaced',version:7}],[{id:'file',version:2,hash:'e'.repeat(64),relPath:'n.md',kind:'body',taskId:'t'}])])
 const material:any={sourceDeps:[{id:'material-file',version:1,hash:'f'.repeat(64),relPath:'m.md',kind:'body',taskId:'t'}],memoryDeps:[{id:'material-memory',version:2}]}
 const [out]=inheritInputs([cited],material,[unrelated,replaced] as unknown as Parameters<typeof inheritInputs>[2],'replaced')
 const ids=((out!.memoryDeps??[]) as unknown as {id:string}[]).map(d=>d.id)
 expect(ids.sort()).toEqual(['dep-of-cited','dep-of-replaced','material-memory'])
 const [skipped]=inheritInputs([cited],material,[unrelated,replaced] as unknown as Parameters<typeof inheritInputs>[2],'replaced',[],[{id:'material-memory',version:2}])
 expect(((skipped!.memoryDeps??[]) as unknown as {id:string}[]).map(d=>d.id)).not.toContain('material-memory')
 // 库里其余条目不再被整批写成本条的依赖：更正它们不会让这条一起暂停。
 expect(ids).not.toContain('unrelated')
 expect(ids).not.toContain('replaced')
 // 近期背景不是事实权威，撤销关系仍须保留。
 const log:any=entry('log-1',1,[src('s-log')]);(log as any).category='recent'
 const materialWithLog:any={...material,memoryDeps:[{id:'log-1',version:1},{id:'material-memory',version:2}]}
 const [withLog]=inheritInputs([cited],materialWithLog,[log] as unknown as Parameters<typeof inheritInputs>[2],undefined)
 expect(((withLog!.memoryDeps??[]) as unknown as {id:string}[]).map(d=>d.id)).toContain('log-1')
 const [asLog]=inheritInputs([cited],materialWithLog,[log] as unknown as Parameters<typeof inheritInputs>[2],undefined)
 expect(asLog!.memoryDeps).toEqual(expect.arrayContaining([{id:'log-1',version:1},{id:'dep-of-cited',version:3}]))
 expect((asLog!.sourceDeps as unknown as {id:string}[]).length).toBeGreaterThan(0)
 expect(((out!.sourceDeps??[]) as unknown as {id:string}[]).map(d=>d.id).sort()).toEqual(['file','material-file'])
})
it('corrects an actually Host-sent old version without self dependency and retains its upstream forgetting closure',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-host-correction-')),credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'fiction',contextTokens:32768}
 cleanups.push(()=>rm(base,{recursive:true,force:true}))
 let targetId='',upstreamId=''
 for(let step=1;step<=3;step++){
  const result=await runMemoryQualityCase({id:'host-correction-'+step,group:'fact',heldOut:false,prompt:'青灯项目版本明确更正，记录青灯项目事实',body:'青灯项目版本记录需要核对。',answer:'受控草稿',expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){
   const p=JSON.parse(String(input.messages[0]!.content)),target=p.memory.find((e:any)=>e.content==='青灯项目版本为甲')
   yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:step===3?'correct':'add',...(step===3?{target:target.id}:{}),content:step===1?'青灯项目使用版本依据':step===2?'青灯项目版本为甲':'青灯项目版本明确更正为乙',scope:'本库',sourceIds:[p.sources.find((s:any)=>s.classification==='command').id],semantic:'fact',attribution:'人的口令',reviewAt:null}]})};yield {type:'finish',reason:'stop'}
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
 // 口令 + 正文同义佐证：保留口令为权威依据，正文降为辅助，不整条拒绝。
 const mixed=roleAgreement({semantic:'standing',authority:[{sourceId:'body',quote:'先给结论'},{sourceId:'cmd',quote:'先给结论'}],sourceIds:['cmd','body']},[command,human],true)!
 expect(mixed.agreement!.authority).toEqual([{sourceId:'cmd',quote:'先给结论'}])
 expect(mixed.agreement!.supporting).toContain('body')
 // 只有正文、没有任何口令依据时必须拒绝。
 expect(()=>roleAgreement({semantic:'standing',authority:[{sourceId:'body',quote:'先给结论'}],sourceIds:['body','cmd']},[command,human],true)).toThrow()
 // 佐证可以只出现在本场来源里：并入条目来源并记为辅助，不因未重复写进 sourceIds 而拒绝整条。
 const role=roleAgreement({semantic:'standing',authority:[{sourceId:'cmd',quote:'先给结论'}],sourceIds:['cmd'],supporting:['body']},[command],true,id=>id==='body'?human:undefined)!
 expect(role.agreement!.supporting).toEqual(['body'])
 expect(role.extra.map(source=>source.id)).toEqual(['body'])
 expect(roleAgreement({semantic:'fact',sourceIds:['body']},[human])).toBeUndefined()
})
it('admits a factual proposal that only lists supporting sources without inventing an authority',()=>{
 const command=roleSource('cmd','以后在本库解释先给结论','command'),human=roleSource('body','我偏好先给结论再举例子','human')
 // 项目事实不要求口令权威：只列佐证时仍然准入，佐证并入条目来源。
 const role=roleAgreement({semantic:'fact',supporting:['body'],sourceIds:['cmd']},[command],true,id=>id==='body'?human:undefined)!
 expect(role.agreement).toBeUndefined()
 expect(role.extra.map(source=>source.id)).toEqual(['body'])
 // 长期约定仍然必须有人的口令原话：只列佐证不算权威。
 expect(()=>roleAgreement({semantic:'standing',supporting:['body'],sourceIds:['cmd']},[command],true,id=>id==='body'?human:undefined)).toThrow()
 // 佐证必须是本场真实来源，未知 id 仍硬拒。
 expect(()=>roleAgreement({semantic:'fact',supporting:['missing'],sourceIds:['cmd']},[command],true)).toThrow()
})
it('saves a standing agreement that quotes the original command and refuses one without authority',async()=>{
 const proposal=(authority:boolean)=>(input:ModelStepInput)=>{
  const data=JSON.parse(String(input.messages[0]!.content)),first=data.sources[0]
  return {recent:null,proposals:[{action:'add',content:'以后在本库解释先给结论',scope:'本库',sourceIds:[first.id],semantic:'standing',attribution:'人的口令',reviewAt:null,...(authority?{authority:[{sourceId:first.id,quote:String(first.text).slice(0,4)}]}:{})}]}
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
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
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
 const f=await fixture(async function*(){calls++;yield {type:'text',text:calls===1?'bad json':'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(2)
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
 expect(f.service.snapshot().record.jobs[0]?.reason).toBeUndefined()
})

it.each(['exact','paraphrase','own-edge','historical'] as const)('proves command independence only for the current full command while retaining actual source edges (%s)',async mode=>{
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content)),s=p.sources[0];yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'add',content:mode==='paraphrase'?'新指令的改写':s.text,scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人的口令',reviewAt:null}]})};yield {type:'finish',reason:'stop'}},'独立的新项目事实','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),parent=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'原依据',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 f.material.memoryDeps=[{id:parent.id,version:1,basisHashes:[source.basisHash],sourceDeps:[{id:source.id,version:1,hash:source.hash,relPath:'a.md',kind:'ledger',taskId:'task'}]}]
 vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 if(mode==='own-edge')vi.spyOn(f.service,'sourceForPrompt').mockResolvedValue({...source,memoryDeps:[{id:parent.id,version:1}]})
 if(mode==='historical'){
  const note=await f.vault.read('a.md'),marked=markPrompt('/独立的新项目事实',{taskId:'old-task',range:{start:0,end:9},expectedText:'/独立的新项目事实',promptText:'独立的新项目事实'})
  await f.vault.ledgerPrepare('a.md',{taskId:'old-task',startedAt:new Date().toISOString(),status:'completed',prompt:'独立的新项目事实',answer:'旧草稿'})
  const written=await f.vault.write('a.md',note.content+'\n'+upsertAiAnswer(marked,{taskId:'old-task',answer:'旧草稿'}),note.revision,note);await f.vault.ledgerComplete('a.md','old-task',written.revision)
  const historical=await f.service.sourceForPrompt('a.md','old-task');vi.spyOn(f.service,'sourceForPrompt').mockResolvedValue(historical)
 }
 await f.engine.handoff(f.material);await f.engine.idle()
 const derived=f.service.snapshot().record.entries.find(e=>e.id!==parent.id)!
 expect(derived).toBeDefined();expect(derived.status).toBe('active')
 expect(derived.sources.flatMap(s=>s.memoryDeps)).toEqual(mode==='exact'?[]:[{id:parent.id,version:1}])
})
it('keeps a successful correction and reports stale recent background as a rejected partial result',async()=>{
 let oldId=''
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));if(!p.memory){yield {type:'text',text:'{"recent":null}'};yield {type:'finish',reason:'stop'};return}const s=p.sources[0],target=p.memory.find((e:any)=>e.content==='青灯版本甲');yield {type:'text',text:JSON.stringify({recent:{goal:'按旧版本继续',completed:'',blocked:'',next:'',sourceIds:[s.id],assistantDraft:false},proposals:[{action:'correct',target:target.id,content:'青灯版本已更正',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人',reviewAt:null}]})};yield {type:'finish',reason:'stop'}},'青灯版本已更正','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}));oldId=old.id
 f.material.memoryDeps=[{id:old.id,version:1,basisHashes:[source.basisHash],sourceDeps:[{id:source.id,version:1,hash:source.hash,relPath:'a.md',kind:'ledger',taskId:'task'}]}];vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 await f.engine.handoff(f.material);await f.engine.idle()
 const record=f.service.snapshot().record
 expect(record.entries.find(e=>e.id===old.id)).toMatchObject({version:2,status:'active',content:'青灯版本已更正'})
 expect(record.recent[0]?.recent.sections.goal).toBe('按旧版本继续')
 expect(record.recent[0]!.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual({id:oldId,version:1})
 expect(record.jobs.at(-1)).toMatchObject({outcome:'applied',results:expect.arrayContaining([{action:'correct',outcome:'applied'},{action:'recent',outcome:'applied'}])})
})

it('corrects a Host-loaded parent using proven legacy recent ancestry while leaving stale recent paused',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts'),{parseWorkingMemory,encodeWorkingMemory}=await import('../../src/main/working-memory-store.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-old-recent-correction-')),credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'fiction',contextTokens:32768}
 cleanups.push(()=>rm(base,{recursive:true,force:true}));let parentId='',recentId=''
 for(let step=1;step<=3;step++){
  const result=await runMemoryQualityCase({id:'old-recent-correction-'+step,group:'fact',heldOut:false,prompt:step===3?'青灯项目版本明确更正为乙':'记录青灯项目版本并继续核对',body:'青灯项目版本核对工作',answer:'受控草稿',expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){
   const p=JSON.parse(String(input.messages[0]!.content)),source=p.sources.find((s:any)=>s.classification==='command'),target=p.memory.find((e:any)=>e.content==='青灯项目版本为甲')
   const recent=step===2?{goal:'青灯项目版本核对',completed:'记录青灯版本',blocked:'',next:'继续青灯版本核对',sourceIds:[source.id],assistantDraft:false}:null
   const proposals=step===2?[]:[{action:step===3?'correct':'add',...(step===3?{target:target.id}:{}),content:step===3?'青灯项目版本明确更正为乙':'青灯项目版本为甲',scope:'本库',sourceIds:[source.id],semantic:'fact',attribution:'人的口令',reviewAt:null}]
   yield {type:'text',text:JSON.stringify({recent,proposals})};yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',base,noteName:'step-'+step+'.md',hostBeforeConsolidation:true,verifyClosure:false})
  expect(result.completed).toBe(true)
  if(step===1)parentId=result.entries[0]!.id
  if(step===2){
   recentId=result.recent![0]!.id
   expect(result.material.memoryDeps).toContainEqual(expect.objectContaining({id:parentId,version:1}))
   const file=path.join(base,'vault','.rgent-memory'),raw=parseWorkingMemory(await readFile(file,'utf8'))
   delete raw.recent.find(e=>e.id===recentId)!.recent.requestBasis;raw.recent.find(e=>e.id===recentId)!.sources.forEach(source=>source.memoryDeps=[]);await writeFile(file,encodeWorkingMemory(raw))
  }
  if(step===3){
   expect(result.material.memoryDeps).toContainEqual(expect.objectContaining({id:recentId,version:1}))
   const parent=result.entries.find(e=>e.id===parentId)!
   expect(parent).toMatchObject({version:2,status:'active',content:'青灯项目版本明确更正为乙'})
   expect(parent.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual(expect.objectContaining({id:recentId}))
   expect(result.entries.find(e=>e.id===recentId)?.status).toBe('paused')
  }
 }
},20000)

it('keeps the applied batch and publishes failure when post-commit promotion fails',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({proposals:[suggestion(input)],recent:null})};yield {type:'finish',reason:'stop'}},'以后用中文','continuity')
 const promotion=vi.spyOn(f.service,'recheckDeferred').mockRejectedValue(Error('MEMORY_FILE_LIMIT'));await f.engine.handoff(f.material);await f.engine.idle()
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied');expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文']);expect(promotion).toHaveBeenCalledTimes(1)
 expect(await new WorkingMemoryService(f.vault,()=>null).view()).toMatchObject({maintenanceFailure:'MEMORY_FILE_LIMIT'})
})

it.each(['m4','legacy'] as const)('uses continuity when production strategy is omitted (%s)',async format=>{
 let calls=0,value:ReturnType<typeof suggestion>|undefined;const f=await fixture(async function*(input){calls++;value??=suggestion(input);yield {type:'text',text:JSON.stringify(format==='m4'?{recent:null,proposals:[value]}:{proposals:[value]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 if(format==='m4'){expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied');expect(await f.service.entries()).toHaveLength(1);expect(calls).toBe(1)}else{expect(f.service.snapshot().record.jobs[0]).toMatchObject({outcome:'rejected',reason:'MEMORY_OUTPUT_INVALID'});expect(await f.service.entries()).toHaveLength(0);expect(calls).toBe(2)}
})
it('keeps the legacy parser available only via the explicit historical evaluation constructor',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({proposals:[{...suggestion(input),layer:'core'}]})};yield {type:'finish',reason:'stop'}},'以后用中文',undefined,true)
 await f.engine.handoff(f.material);await f.engine.idle();expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied');expect(await f.service.entries()).toHaveLength(1)
})

it('runs total 25 actual Host sessions across two stable libraries with five corrections, three forgets and two permission tightenings',async()=>{
 const {runControlledQualityHost}=await import('../../scripts/memory-quality-runner.ts'),{VaultCatalog}=await import('../../src/main/vault-catalog.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-continuous-25-')),roots=[path.join(base,'青灯库'),path.join(base,'白鹭库')];for(const root of roots)await mkdir(root)
 const credential={provider:'custom' as const,modelId:'controlled-25',baseURL:'https://example.test/v1',apiKey:'fictional',contextTokens:32768},signal=new AbortController().signal,names=['青灯','白鹭'],catalog=new VaultCatalog(base)
 const registered=roots.map(root=>catalog.register(catalog.inspect(root))),known=[new Set<string>(),new Set<string>()],main:Array<{id:string;version:number;content:string}|null>=[null,null],aux=new Map<number,{id:string;version:number;content:string;relPath:string;taskId:string}>(),expectedWorkspace=new Map<string,string>()
 const createVault=()=>new VaultSession(base,()=>{},async()=>{},(root,identity)=>catalog.view().entries.find(e=>e.path===root&&e.rootIdentity===identity)?.id??null)
 let vault=createVault(),engine:WorkingMemoryConsolidation|null=null,corrections=0,forgets=0,tightenings=0,sessions=0,nextSends=0,restarts=0,derivedRevocations=0,partial=0
 try{
  for(let step=1;step<=25;step++){
   const lib=(step-1)%2,root=roots[lib]!,name=names[lib]!,other=names[1-lib]!,target=catalog.inspect(root)
   expect(target.id).toBe(registered[lib]!.id);engine?.close();await engine?.idle()
   if(step===14){const lastId=catalog.view().lastVaultId,last=catalog.view().entries.find(e=>e.id===lastId)!;vault.dispose();vault=createVault();const checked=catalog.inspect(last.path);expect(checked.id).toBe(lastId);expect(vault.restoreVerified(checked.path,checked.rootIdentity)).toMatchObject({status:'ready',navigationKey:catalog.displayKeys(checked).key});restarts++}
   expect(await vault.openVerified(target.path,target.rootIdentity)).toMatchObject({status:'ready',navigationKey:catalog.displayKeys(target).key});catalog.committed(target);expect(catalog.inspect(root).id).toBe(registered[lib]!.id)
   const restored=catalog.workspace(target);if(expectedWorkspace.has(target.id!))expect(restored?.active).toBe(expectedWorkspace.get(target.id!))
   const service=new WorkingMemoryService(vault,()=>null);await service.initialize();const relPath=`scene-${step}.md`
   const forgetAt=new Map([[7,3],[8,4],[13,9]]),permissionAt=new Map([[14,10],[17,15]]),queryAt=new Map([[5,3],[6,4],[11,9],[12,10]])
   const removed=new Set<string>();let forgottenValue:string|undefined
   const forgottenStep=forgetAt.get(step);if(forgottenStep){
    const item=aux.get(forgottenStep)!,basis=service.snapshot(),all=[...basis.record.entries,...basis.record.recent];removed.add(item.id);let grew=true
    while(grew){grew=false;for(const e of all)if(!removed.has(e.id)&&e.sources.some(s=>s.memoryDeps.some(d=>removed.has(d.id)))){removed.add(e.id);grew=true}}
    expect(all.some(e=>e.category==='recent'&&removed.has(e.id)&&e.sources.some(s=>s.memoryDeps.some(d=>d.id===item.id)))).toBe(true);derivedRevocations+=removed.size-1
    await service.forget({sessionId:service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:item.id,version:item.version});forgets++;forgottenValue=item.content
    const after=await service.entries();expect(after.some(e=>removed.has(e.id))).toBe(false)
    // Forget revokes derived use; it preserves the original human command and raw ledger history.
    expect(await readFile(path.join(root,item.relPath),'utf8')).toContain(item.content);expect((await vault.ledgerRecord(item.relPath,item.taskId)).chapter?.prompt).toBe(item.content)
   }
   const deniedStep=permissionAt.get(step);if(deniedStep){const item=aux.get(deniedStep)!;await writeFile(path.join(root,'.rgent-permissions'),JSON.stringify({[item.relPath]:'forbidden'}));tightenings++;expect((await service.entries()).find(e=>e.id===item.id)?.status).toBe('paused');expect(await readFile(path.join(root,item.relPath),'utf8')).toContain(item.content)}
   const initial=step<=2,correct=step>=17&&step<=21,addAux=[3,4,9,10,15].includes(step),queryAux=queryAt.get(step),version=(main[lib]?.version??0)+1
   const prompt=initial?`${name}项目版本为甲`:correct?`${name}项目版本明确更正为第${version}版`:addAux?`${name}敏感便签暗河编号为秘钥${step}`:queryAux?`继续核对${aux.get(queryAux)!.content}`:`继续核对${name}项目版本`
   await writeFile(path.join(root,relPath),'/'+prompt+'\n');let issued=0
   engine=new WorkingMemoryConsolidation({service:()=>service,configuration:()=>({enabled:true,signature:'continuous-25',credential,limits:{seconds:120,calls:2,tools:0}}),changed:()=>{},stream:async function*(input){issued++;const p=JSON.parse(String(input.messages[0]!.content));if(!p.memory){yield {type:'text',text:'{"recent":null}'};yield {type:'finish',reason:'stop'};return}const source=p.sources.find((s:any)=>s.kind==='ledger'&&s.classification==='command'),old=main[lib]
    const proposals=initial||addAux||correct?[{action:correct?'correct':'add',...(correct?{target:p.memory.find((e:any)=>e.content===old!.content).id}:{}),content:prompt,scope:relPath,sourceIds:[source.id],semantic:'fact',attribution:'人的本场口令',reviewAt:null}]:[]
    yield {type:'text',text:JSON.stringify({proposals,recent:{goal:queryAux?aux.get(queryAux)!.content:`继续${name}工作`,completed:'回答已保存',blocked:'',next:`核对${name}版本`,sourceIds:[source.id],assistantDraft:false}})};yield {type:'finish',reason:'stop'}
   }})
   const currentEngine=engine,foreground=await runControlledQualityHost(vault,service,credential,relPath,prompt,'受控回答已保存',signal,id=>currentEngine.capture(id),material=>currentEngine.handoff(material));await currentEngine.idle();sessions++
   expect(foreground.ledger.state).toBe('saved');expect(foreground.ledger.chapter?.provenance?.version).toBe(2);const material=await service.savedMaterial(relPath,foreground.ledger.taskId);expect(material.provenanceStatus).toBe('complete');expect(material.materialVersion).toBe(foreground.material.materialVersion)
   const deps=foreground.ledger.chapter!.provenance!.version===2?foreground.ledger.chapter!.provenance!.memoryDeps:[];expect(deps.every(d=>known[lib]!.has(d.id))).toBe(true);expect(deps.some(d=>known[1-lib]!.has(d.id))).toBe(false);expect(foreground.sent.every(s=>!(s.system+'\n'+s.prompt).includes(other))).toBe(true)
   if(main[lib]){expect(deps).toContainEqual(expect.objectContaining({id:main[lib]!.id,version:main[lib]!.version}));expect(foreground.sent.some(s=>(s.system+'\n'+s.prompt).includes(main[lib]!.content))).toBe(true);nextSends++}
   if(queryAux){const item=aux.get(queryAux)!;expect(deps).toContainEqual(expect.objectContaining({id:item.id,version:item.version}))}
   if(forgottenValue){expect(deps.some(d=>removed.has(d.id))).toBe(false);expect(foreground.sent.every(s=>!(s.system+'\n'+s.prompt).includes(forgottenValue!))).toBe(true)}
   if(deniedStep){const item=aux.get(deniedStep)!;expect(deps.some(d=>d.id===item.id)).toBe(false);expect(foreground.sent.every(s=>!(s.system+'\n'+s.prompt).includes(item.content))).toBe(true)}
   const effective=await service.entries(),receipt=service.snapshot().record.jobs.find(j=>j.taskId===foreground.ledger.taskId);expect(receipt?.outcome).toBe('applied');expect(issued).toBe(1);if(receipt?.results?.some(r=>r.outcome==='rejected'))partial++
   if(initial||correct){const e=effective.find(e=>e.content===prompt&&e.category==='long')!;expect(e).toBeDefined();expect(e.status).toBe('active');if(correct){expect(e.id).toBe(main[lib]!.id);expect(e.version).toBe(main[lib]!.version+1);corrections++}main[lib]={id:e.id,version:e.version,content:e.content}}
   if(addAux){const e=effective.find(e=>e.content===prompt&&e.category==='long')!;expect(e?.status).toBe('active');aux.set(step,{id:e.id,version:e.version,content:e.content,relPath,taskId:foreground.ledger.taskId})}
   for(const e of effective)known[lib]!.add(e.id)
   if(queryAux){const item=aux.get(queryAux)!,recent=effective.find(e=>e.category==='recent'&&e.recent?.taskId===foreground.ledger.taskId)!;expect(recent?.status).toBe('active');expect(recent.sources.some(s=>s.memoryDeps.some(d=>d.id===item.id&&d.version===item.version))).toBe(true)}
   catalog.saveWorkspace(target,{version:1,tabs:[{relPath,selection:{anchor:1,head:1},scrollTop:step}],active:relPath,sidebarHidden:false,treeScroll:step,resourceScroll:step});expectedWorkspace.set(target.id!,relPath)
  }
  expect({sessions,corrections,forgets,tightenings,restarts,nextSends}).toEqual({sessions:25,corrections:5,forgets:3,tightenings:2,restarts:1,nextSends:23});expect(derivedRevocations).toBeGreaterThanOrEqual(3)
  expect(new VaultCatalog(base).view().entries.map(e=>e.id)).toEqual(registered.map(e=>e.id));console.info('Memory continuous controlled',JSON.stringify({sessions,corrections,forgets,tightenings,restarts,nextSends,derivedRevocations,partial,paidCalls:0}))
 }finally{engine?.close();await engine?.idle();vault.dispose();await rm(base,{recursive:true,force:true})}
},30000)

it('rechecks the exact saved material after a safe-empty M4 terminal',async()=>{
 let completed=false
 const f=await fixture(async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'};completed=true})
 const saved=f.service.savedMaterial.bind(f.service)
 vi.spyOn(f.service,'savedMaterial').mockImplementation(async(...args)=>{const material=await saved(...args);return completed?{...material,materialVersion:'0'.repeat(64)}:material})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(f.service.snapshot().record.jobs.find(j=>j.taskId==='task')).toMatchObject({outcome:'rejected',reason:'MEMORY_MATERIAL_CHANGED'})
 expect(f.service.snapshot().record.entries).toEqual([])
})

it('uses request scoped short references and accepts omitted reviewAt without model layer',async()=>{
 let sent:any;const f=await fixture(async function*(input){sent=JSON.parse(String(input.messages[0]!.content));const v=suggestion(input) as any;delete v.layer;delete v.reviewAt;yield {type:'text',text:JSON.stringify({recent:null,proposals:[v]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(sent.sources[0].id).toMatch(/^s1_[a-f0-9]{12}$/)
 expect(sent.sources[0].id).not.toBe(f.service.snapshot().record.entries[0]?.sources[0]?.id)
 expect(f.service.snapshot().record.entries[0]).toMatchObject({layer:'core',reviewAt:null})
})
it('repairs only invalid indexes and keeps a valid proposal when repair service fails',async()=>{
 const requests:any[]=[];const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));requests.push(p);if(requests.length===2)throw Error('MODEL_REQUEST_FAILED');const v=suggestion(input) as any;delete v.layer;yield {type:'text',text:JSON.stringify({recent:null,proposals:[v,{...v,content:'坏来源',sourceIds:['missing']}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(requests).toHaveLength(2);expect(requests[1].sources).toEqual(requests[0].sources)
 expect(requests[1].repair.issues).toEqual(expect.arrayContaining([expect.objectContaining({path:'proposals[1].sourceIds[0]'})]))
 expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_SERVICE_FAILED')
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
})
it('returns field paths for missing standing authority and rejects an all-empty recent',async()=>{
 const requests:any[]=[];const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));requests.push(p);const v=suggestion(input) as any;delete v.authority;yield {type:'text',text:JSON.stringify({recent:{goal:'',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false},proposals:[v]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(requests[1].repair.issues).toContainEqual(expect.objectContaining({path:'proposals[0].authority',code:'MEMORY_OUTPUT_INVALID'}))
 expect(f.service.snapshot().record.recent).toHaveLength(0)
})
it('abandoning one repair item rejects its original atomic group while preserving independent items',async()=>{
 let calls=0;const f=await fixture(async function*(input){calls++;const v=suggestion(input);yield {type:'text',text:JSON.stringify(calls===1?{recent:null,proposals:[v,{...v,group:'atomic',content:'关联项甲'},{...v,group:'atomic',content:'关联项乙',sourceIds:['missing']}]}:{proposals:[{index:1,value:{...v,group:'atomic',content:'关联项甲'}},{index:2,value:null}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle();expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
})
it('refuses real source identities in recent even when they happen to exist in the snapshot',async()=>{
 let actual='';const f=await fixture(async function*(){yield {type:'text',text:JSON.stringify({recent:{goal:'不能借真实标识绕过短引用',completed:'',blocked:'',next:'',sourceIds:[actual],assistantDraft:false},proposals:[]})};yield {type:'finish',reason:'stop'}},'以后用中文',undefined,false,trace=>{actual=trace.sources[0]!.id})
 await f.engine.handoff(f.material);await f.engine.idle();expect(f.service.snapshot().record.recent).toHaveLength(0)
})
it('validates the production correction JSON example against the actual snapshot',async()=>{
 const example=JSON.parse(/例：(\{[^\n]*\})。明确更正/.exec(memoryContinuitySystem)![1]!)
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:null,proposals:[{...example,target:p.memory[0].id,sourceIds:[p.sources[0].id]}]})};yield {type:'finish',reason:'stop'}},'项目内容明确更正')
 const source=await f.service.sourceForPrompt('a.md','task');await f.vault.memoryMutation(store=>store.add(store.read(),{content:'项目内容',layer:'demand',scope:'项目',sources:[source],semantic:'fact',attribution:'人',reviewAt:null},true))
 await f.engine.handoff(f.material);await f.engine.idle();expect((await f.service.entries())[0]).toMatchObject({content:example.content,version:2,layer:'demand'})
 expect(JSON.parse(/仅输出完整 JSON：(\{[^\n]*?\})；/.exec(memoryContinuitySystem)![1]!)).toEqual({recent:null,proposals:[]})
})
it('rejects a previous request reference and records the actual payload hash and repair purpose',async()=>{
 const traces:import('../../src/main/working-memory-consolidation.ts').ConsolidationRequestObservation[]=[];let foreign=''
 const first=await fixture(async function*(input){foreign=JSON.parse(String(input.messages[0]!.content)).sources[0].id;yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}})
 await first.engine.handoff(first.material);await first.engine.idle()
 const f=await fixture(async function*(input){const v=suggestion(input);yield {type:'text',text:JSON.stringify({recent:null,proposals:[{...v,sourceIds:[foreign]}]})};yield {type:'finish',reason:'stop'}},'以后用中文',undefined,false,t=>traces.push(t))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(traces.map(t=>t.purpose)).toEqual(['proposal','protocol-repair']);expect(traces[0]!.sources[0]!.ref).not.toBe(foreign)
 for(const t of traces){expect(t.payloadFingerprint).toBe(createHash('sha256').update(t.content).digest('hex'));expect(JSON.parse(t.content).sources[0].id).toBe(t.sources[0]!.ref)}
 expect(await f.service.entries()).toHaveLength(0)
})
it('does not apply a repair patch that attempts to replace an already valid index',async()=>{
 let calls=0;const f=await fixture(async function*(input){calls++;const v=suggestion(input);yield {type:'text',text:JSON.stringify(calls===1?{recent:null,proposals:[v,{...v,sourceIds:['missing']}]}:{proposals:[{index:0,value:{...v,content:'篡改有效项'}},{index:1,value:v}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle();expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
})
it('rejects production legacy layer/id/version fields and does not trust observer exceptions',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[{...suggestion(input),layer:'core',id:'real',version:1}]})};yield {type:'finish',reason:'stop'}},'以后用中文',undefined,false,()=>{throw Error('observer failed')})
 await f.engine.handoff(f.material);await f.engine.idle();expect(await f.service.entries()).toHaveLength(0)
})
it('keeps valid first groups when the repair has malformed JSON',async()=>{
 let calls=0;const f=await fixture(async function*(input){calls++;yield {type:'text',text:calls===1?JSON.stringify({recent:null,proposals:[suggestion(input),{...suggestion(input),sourceIds:['missing']}]}):'{'};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle();expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文']);expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_OUTPUT_INVALID')
})
it('locates standing authority that contains only non-command evidence',async()=>{
 const requests:any[]=[];const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));requests.push(p);yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task');vi.spyOn(f.service,'sourceForPrompt').mockResolvedValue({...source,classification:'human'});vi.spyOn(f.service,'verifySource').mockResolvedValue(true)
 await f.engine.handoff(f.material);await f.engine.idle();expect(requests[1].repair.issues).toContainEqual(expect.objectContaining({path:'proposals[0].authority',expected:expect.stringContaining('command')}));expect(await f.service.entries()).toHaveLength(0)
})

it('writes recent with the correction in one commit without depending on the replaced parent',async()=>{
 const requests:any[]=[],traces:import('../../src/main/working-memory-consolidation.ts').ConsolidationRequestObservation[]=[]
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));requests.push(p)
  const s=p.sources[0]
  yield {type:'text',text:JSON.stringify({recent:{goal:'旧草案背景',completed:'',blocked:'',next:'',sourceIds:[s.id],assistantDraft:false},proposals:[{action:'correct',target:p.memory[0].id,content:'青灯版本已更正',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人'}]})};yield {type:'finish',reason:'stop'}
 },'青灯版本已更正','continuity',false,t=>traces.push(t))
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 f.material.memoryDeps=[{id:old.id,version:1,basisHashes:[source.basisHash],sourceDeps:[]}];vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(requests).toHaveLength(1);expect(traces.map(t=>t.purpose)).toEqual(['proposal'])
 const record=f.service.snapshot().record,recent=record.recent[0]!
 expect(record.entries.find(e=>e.id===old.id)).toMatchObject({version:2,status:'active'})
 expect(recent?.recent.sections.goal).toBe('旧草案背景');expect((recent?.recent as any).requestBasis).toMatchObject({version:1,taskId:'task',materialVersion:f.material.materialVersion})
 expect(recent.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual({id:old.id,version:1})
 expect((await f.service.entries([recent.id]))[0]?.status).toBe('active')
 const restarted=new WorkingMemoryService(f.vault,()=>null);vi.spyOn(restarted,'savedMaterial').mockResolvedValue(f.material)
 expect((await restarted.entries([recent.id]))[0]?.status).toBe('active')
})

it('records every displayed source dependency even when recent cites only the original command',async()=>{
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:{goal:'当前工作',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false},proposals:[]})};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task'),parent=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'无关键字父记录',layer:'demand',scope:'远处',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 const extra={...source,id:'extra-source',materialId:'extra-material',text:'无引用的实际输入',hash:createHash('sha256').update('无引用的实际输入').digest('hex'),memoryDeps:[{id:parent.id,version:1}]}
 f.material.material.fragments=[{...extra,sessionId:f.material.context!.sessionId,classification:'human',memoryDeps:extra.memoryDeps.map(d=>({...d,basisHashes:[],sourceDeps:[]}))}];vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material);vi.spyOn(f.service,'sourceForFragment').mockResolvedValue(extra);vi.spyOn(f.service,'verifySource').mockResolvedValue(true);vi.spyOn(f.service,'renewSavedBinding').mockImplementation(async s=>s)
 await f.engine.handoff(f.material);await f.engine.idle()
 const recent=f.service.snapshot().record.recent[0]!
 expect(recent.sources.some(s=>s.materialId==='extra-material')).toBe(true)
 expect(recent.sources.flatMap(s=>s.memoryDeps)).toContainEqual({id:parent.id,version:1})
 const basis=f.service.snapshot();await f.service.forget({sessionId:f.material.context!.sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:parent.id,version:1})
 expect(f.service.snapshot().record.recent).toHaveLength(0)
})

it.each(['empty','extra','draft','forged','failure','repair','retry'] as const)('keeps valid correction when regeneration is unavailable (%s)',async mode=>{
 let calls=0,valid:any
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content))
  if(calls===1&&mode==='repair'){yield {type:'text',text:'{'};yield {type:'finish',reason:'stop'};return}
  if(calls===1&&mode==='retry')throw transport('ETIMEDOUT')
  if(p.memory){const s=p.sources[0];valid={recent:{goal:'旧背景',completed:'',blocked:'',next:'',sourceIds:[s.id],assistantDraft:false},proposals:[{action:'correct',target:p.memory[0].id,content:'青灯版本更正乙',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人'}]};yield {type:'text',text:JSON.stringify(valid)}}
  else{if(mode==='failure')throw transport('ETIMEDOUT');const recent={goal:mode==='empty'?'':'新背景',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:mode==='draft',...(mode==='forged'?{requestBasis:{version:1}}:{})};yield {type:'text',text:JSON.stringify({recent,...(mode==='extra'?{proposals:[]}:{})})}}
  yield {type:'finish',reason:'stop'}
 },'青灯版本更正乙')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(mode==='repair'||mode==='retry'?2:1)
 expect(f.service.snapshot().record.entries.find(e=>e.id===old.id)).toMatchObject({version:2,content:'青灯版本更正乙'})
 expect(f.service.snapshot().record.recent[0]?.recent.sections.goal).toBe('旧背景')
 expect(f.service.snapshot().record.jobs[0]).toMatchObject({outcome:'applied',results:expect.arrayContaining([{action:'correct',outcome:'applied'},{action:'recent',outcome:'applied'}])})
})

it.each(['configuration','source'] as const)('rechecks %s inside the final mutation queue before publishing recent',async mode=>{
 let calls=0,streamed=false
 const f=await fixture(async function*(input){calls++;streamed=true;const p=JSON.parse(String(input.messages[0]!.content)),s=p.sources[0];yield {type:'text',text:JSON.stringify({recent:{goal:'旧背景',completed:'',blocked:'',next:'',sourceIds:[s.id],assistantDraft:false},proposals:[{action:'correct',target:p.memory[0].id,content:'青灯版本乙',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人'}]})};yield {type:'finish',reason:'stop'}} ,'青灯版本乙')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 const mutate=f.vault.memoryMutation.bind(f.vault);vi.spyOn(f.vault,'memoryMutation').mockImplementation(async op=>{if(streamed){if(mode==='configuration')f.disableConfig();else await writeFile(path.join(f.vault.root!,'.rgent-permissions'),JSON.stringify({'a.md':'forbidden'}))}return mutate(op)})
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(1);expect(f.service.snapshot().record.entries.find(e=>e.id===old.id)?.version).toBe(1);expect(f.service.snapshot().record.recent).toHaveLength(0)
})

it('loads regenerated recent in actual Host requests before and after reopening the vault',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-independent-recent-')),credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'fiction',contextTokens:32768}
 cleanups.push(()=>rm(base,{recursive:true,force:true}));let recentId='',oldId='';const requests:any[]=[]
 for(let step=1;step<=3;step++){
  const result=await runMemoryQualityCase({id:'independent-recent-'+step,group:'fact',heldOut:false,prompt:step===1?'青灯项目版本甲':step===2?'青灯项目版本明确更正乙，继续核对交付清单':'继续核对青灯项目交付清单',body:'青灯项目交付清单',answer:'受旧记忆影响的助手草稿',expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){
   const p=JSON.parse(String(input.messages[0]!.content));requests.push(p);const source=p.sources.find((s:any)=>s.classification==='command'&&s.kind==='ledger'),recent={goal:'青灯项目交付清单核对',completed:'版本明确更正乙',blocked:'',next:'',sourceIds:[source.id],assistantDraft:false}
   yield {type:'text',text:JSON.stringify(!p.memory?{recent}:{recent:step===2?recent:null,proposals:step===3?[]:[{action:step===2?'correct':'add',...(step===2?{target:p.memory.find((e:any)=>e.content==='青灯项目版本甲').id}:{}),content:step===2?'青灯项目版本明确更正乙':'青灯项目版本甲',scope:'本库',sourceIds:[source.id],semantic:'fact',attribution:'人'}]})};yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',base,noteName:'step-'+step+'.md',hostBeforeConsolidation:true,verifyClosure:false})
  expect(result.completed).toBe(true)
  if(step===1)oldId=result.entries[0]!.id
  if(step===2){const recent=result.recent!.find(e=>e.recent.taskId===result.material.taskId)!;recentId=recent.id;expect(recent.status).toBe('active');expect(result.dependencies).toContainEqual(expect.objectContaining({id:recentId,version:1}));expect(recent.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual({id:oldId,version:1});expect(requests.filter(p=>!p.memory)).toHaveLength(0)}
  if(step===3){expect(result.material.memoryDeps).toContainEqual(expect.objectContaining({id:recentId,version:1}));expect(result.foreground!.sent.some(s=>(s.system+'\n'+s.prompt).includes('青灯项目交付清单核对'))).toBe(true)}
 }
})

it('omits fragments affected by the corrected parent from the independent request',async()=>{
 const requests:any[]=[]
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content));requests.push(p);const recent={goal:'青灯项目继续核对',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false};yield {type:'text',text:JSON.stringify(p.memory?{recent,proposals:[{action:'correct',target:p.memory[0].id,content:'青灯项目版本乙',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人'}]}:{recent})};yield {type:'finish',reason:'stop'}},'青灯项目版本乙')
 const source=await f.service.sourceForPrompt('a.md','task'),parent=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 const extra={...source,id:'old-fragment',materialId:'old-material',text:'旧片段涉及青灯甲',hash:createHash('sha256').update('旧片段涉及青灯甲').digest('hex'),memoryDeps:[{id:parent.id,version:1}]}
 f.material.material.fragments=[{...extra,sessionId:f.material.context!.sessionId,classification:'human',memoryDeps:extra.memoryDeps.map(d=>({...d,basisHashes:[],sourceDeps:[]}))}]
 vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material);vi.spyOn(f.service,'sourceForFragment').mockResolvedValue(extra);vi.spyOn(f.service,'verifySource').mockResolvedValue(true);vi.spyOn(f.service,'renewSavedBinding').mockImplementation(async s=>s)
 await f.engine.handoff(f.material);await f.engine.idle();expect(requests).toHaveLength(1);expect(JSON.stringify(requests[0])).toContain('旧片段涉及青灯甲');expect(f.service.snapshot().record.recent[0]?.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual({id:parent.id,version:1})
})

it('keeps the original deadline when a protocol patch overruns the reserved window',async()=>{
 const now=Date.now();let clock=now,calls=0;const time=vi.spyOn(Date,'now').mockImplementation(()=>clock)
 try{
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content)),valid=suggestion(input)
  if(calls===2)clock=now+120001
  yield {type:'text',text:JSON.stringify(calls===1?{recent:null,proposals:[valid,{...valid,sourceIds:['unknown-source']}]}:{proposals:[{index:1,value:null}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(2);expect(f.service.snapshot().record.entries).toHaveLength(0);expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_DEADLINE')
 }finally{time.mockRestore()}
})

it('keeps the regeneration prompt example valid after a one-shot recent write',async()=>{
 const {memoryRecentRegenerationSystem}=await import('../../src/main/working-memory-consolidation.ts')
 const example=JSON.parse(/只输出完整 JSON：(\{[^\n]*?\})；/.exec(memoryRecentRegenerationSystem)![1]!)
 expect(example).toEqual({recent:null})
 let calls=0;const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:{goal:'青灯旧背景',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false},proposals:[{action:'correct',target:p.memory[0].id,content:'青灯版本乙',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人'}]})};yield {type:'finish',reason:'stop'}},'青灯版本乙')
 const source=await f.service.sourceForPrompt('a.md','task'),parent=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(1);expect(f.service.snapshot().record.entries.find(e=>e.id===parent.id)?.version).toBe(2);expect(f.service.snapshot().record.recent[0]?.recent.sections.goal).toBe('青灯旧背景')
})

it('keeps the first recent without regeneration when all mutually dependent corrections are rejected',async()=>{
 let calls=0
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify(p.memory?{recent:{goal:'青灯两项待核工作',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false},proposals:p.memory.map((e:any)=>({action:'correct',target:e.id,content:e.content+'已更正',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人'}))}:{recent:null})};yield {type:'finish',reason:'stop'}},'青灯两个版本各需更正')
 const source=await f.service.sourceForPrompt('a.md','task')
 for(const content of ['青灯版本甲','青灯版本丙'])await f.vault.memoryMutation(store=>store.add(store.read(),{content,layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(1);expect(f.service.snapshot().record.entries.every(e=>e.version===1)).toBe(true);expect(f.service.snapshot().record.recent[0]?.recent.sections.goal).toBe('青灯两项待核工作');expect((await f.service.entries()).find(e=>e.category==='recent')?.status).toBe('active')
 expect(f.service.snapshot().record.jobs[0]?.results).toEqual([{action:'correct',outcome:'rejected',code:'MEMORY_DEPENDENCY_CHANGED'},{action:'correct',outcome:'rejected',code:'MEMORY_DEPENDENCY_CHANGED'},{action:'recent',outcome:'applied'}])
})

it.each(['skip','early-timeout'] as const)('does not spend a second call on recent after a successful correction (%s)',async mode=>{
 const now=Date.now();let clock=now,calls=0;const time=vi.spyOn(Date,'now').mockImplementation(()=>clock)
 try{
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content));if(calls===1&&mode==='skip')clock=now+116000
  yield {type:'text',text:JSON.stringify({recent:{goal:'青灯旧背景',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false},proposals:[{action:'correct',target:p.memory[0].id,content:'青灯版本乙',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人'}]})};yield {type:'finish',reason:'stop'}},'青灯版本乙')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(1)
 const record=f.service.snapshot().record;expect(record.entries.find(e=>e.id===old.id)?.version).toBe(2);expect(record.recent).toHaveLength(1)
 expect(record.jobs[0]).toMatchObject({outcome:'applied',results:expect.arrayContaining([{action:'correct',outcome:'applied'},{action:'recent',outcome:'applied'}])})
 }finally{time.mockRestore()}
})

it.each(['missing','unknown','valid','foreign','action','group'] as const)('repairs only an unbound target using frozen candidate refs (%s)',async mode=>{
 let calls=0,first:any
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content));first??={action:'correct',...(mode==='missing'?{}:{target:mode==='valid'?p.memory[0].id:'unknown-ref'}),content:'青灯版本乙',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人',...(mode==='valid'?{extra:true}:{})}
  const value={...first,target:mode==='foreign'?'m1_foreign_request':mode==='valid'?p.memory[1].id:p.memory[0].id};delete value.extra;if(mode==='action'){value.action='add';delete value.target}if(mode==='group')value.group='new-group'
  yield {type:'text',text:JSON.stringify(calls===1?{recent:null,proposals:[first]}:{proposals:[{index:0,value}]})};yield {type:'finish',reason:'stop'}},'青灯版本需更正')
 const source=await f.service.sourceForPrompt('a.md','task');for(const content of ['青灯版本甲','青灯版本丙'])await f.vault.memoryMutation(store=>store.add(store.read(),{content,layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(2)
 const rows=f.service.snapshot().record.entries;expect(rows).toHaveLength(2);expect(rows.filter(e=>e.version===2)).toHaveLength(mode==='missing'||mode==='unknown'?1:0)
 if(mode==='missing'||mode==='unknown')expect(rows.find(e=>e.version===2)?.content).toBe('青灯版本乙')
})

it.each(['skip','early-timeout','cancel','total-timeout'] as const)('reserves time for valid groups during protocol patch (%s)',async mode=>{
 const now=Date.now();let clock=now,calls=0;const time=vi.spyOn(Date,'now').mockImplementation(()=>clock)
 try{
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content)),valid=suggestion(input)
  if(calls===1&&mode==='skip')clock=now+116000
  if(calls===2){if(mode==='early-timeout')clock=now+116000;else if(mode==='total-timeout')clock=now+120001;else if(mode==='cancel')f.engine.cancel('task')}
  yield {type:'text',text:JSON.stringify(calls===1?{recent:null,proposals:[valid,{...valid,sourceIds:['unknown-source']}]}:{proposals:[{index:1,value:null}]})};yield {type:'finish',reason:'stop'}})
 await f.engine.handoff(f.material);await f.engine.idle();expect(calls).toBe(mode==='skip'?1:2)
 const record=f.service.snapshot().record;if(mode==='early-timeout')expect(record.jobs[0]?.reason).toBe('MEMORY_DEADLINE');expect(record.entries).toHaveLength(mode==='skip'||mode==='early-timeout'?1:0)
 if(mode==='skip'||mode==='early-timeout')expect(record.jobs[0]).toMatchObject({outcome:'applied',results:expect.arrayContaining([{action:'add',outcome:'applied'},expect.objectContaining({action:'add',outcome:'rejected'})])})
 }finally{time.mockRestore()}
})

it.each(['recent','patch'] as const)('aborts a stalled supplemental request before the total deadline and commits the valid group (%s)',async mode=>{
 const now=Date.now();let clock=now,calls=0,aborted=false;const time=vi.spyOn(Date,'now').mockImplementation(()=>clock)
 try{
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content))
  if(calls===2){await new Promise<void>(resolve=>{input.signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true})});return}
  clock=now+114980
  const v=mode==='patch'?suggestion(input):{action:'correct',target:p.memory[0].id,content:'青灯版本乙',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人'}
  yield {type:'text',text:JSON.stringify({recent:mode==='recent'?{goal:'青灯旧背景',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false}:null,proposals:[v,...(mode==='patch'?[{...v,sourceIds:['unknown-source']}]:[])]})};yield {type:'finish',reason:'stop'}},mode==='recent'?'青灯版本乙':'以后用中文')
 if(mode==='recent'){const source=await f.service.sourceForPrompt('a.md','task');await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))}
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(mode==='patch'?2:1);expect(aborted).toBe(mode==='patch')
 expect(f.service.snapshot().record.entries[0]).toMatchObject(mode==='recent'?{version:2,content:'青灯版本乙'}:{version:1,content:'后续在本库使用中文'});expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
 }finally{time.mockRestore()}
},2000)

it('repairs an illegal action into a legal correction and refuses changing a legal action',async()=>{
 let calls=0
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content))
  const legal={action:'correct',target:p.memory[0].id,content:'青灯版本乙',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人'}
  yield {type:'text',text:JSON.stringify(calls===1?{recent:null,proposals:[{...legal,action:'fix'}]}:{proposals:[{index:0,value:legal}]})};yield {type:'finish',reason:'stop'}},'青灯版本需更正')
 const source=await f.service.sourceForPrompt('a.md','task');await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(2);expect(f.service.snapshot().record.entries[0]).toMatchObject({version:2,content:'青灯版本乙'})
 const locked=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content))
  const first={action:'correct',target:p.memory[0].id,content:'',scope:'a.md',sourceIds:[p.sources[0].id],semantic:'fact',attribution:'人'}
  yield {type:'text',text:JSON.stringify(calls===3?{recent:null,proposals:[first]}:{proposals:[{index:0,value:{...first,action:'add',content:'青灯版本乙'}}]})};yield {type:'finish',reason:'stop'}},'青灯版本需更正')
 const src=await locked.service.sourceForPrompt('a.md','task');await locked.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[src],semantic:'fact',attribution:'人',reviewAt:null}))
 await locked.engine.handoff(locked.material);await locked.engine.idle()
 expect(locked.service.snapshot().record.entries[0]?.version).toBe(1)
})

it('skips a destined patch when a valid group exists and only allows document rewrite when nothing valid remains',()=>{
 expect(protocolRepairPlan({validCount:1,failedCount:1,completableCount:0})).toBe('skip')
 expect(protocolRepairPlan({validCount:0,failedCount:1,completableCount:0})).toBe('document')
 expect(protocolRepairPlan({validCount:1,failedCount:1,completableCount:1})).toBe('patch')
 const binding={sources:new Map(),candidates:new Map([['m1',{id:'x',version:1}]])} as any
 expect(repairFieldLock({action:'fix',content:'a'},binding).mutable).toContain('action')
 expect(repairFieldLock({action:'correct',target:'m1',content:'a'},binding).locked).toEqual(expect.arrayContaining(['action','target']))
})

it('obsoletes an exact cross-class copy and keeps a different claim',async()=>{
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content)),target=p.memory?.find((e:any)=>e.semantic==='standing')
  if(!target){yield {type:'text',text:JSON.stringify({obsolete:[],keep:(p.memory??[]).map((e:any)=>e.id)})};yield {type:'finish',reason:'stop'};return}
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'correct',target:target.id,content:'本库项目记录先依据后结论',scope:'本库',sourceIds:[p.sources[0].id],semantic:'standing',attribution:'人',authority:[{sourceId:p.sources[0].id,quote:String(p.sources[0].text).slice(0,4)}]}]})};yield {type:'finish',reason:'stop'}},'更正：本库项目记录改成先写依据再写结论。')
 const source=await f.service.sourceForPrompt('a.md','task')
 const standing=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'本库项目记录先结论后依据',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人',reviewAt:null},true))
 const copy=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'本库项目记录先结论后依据',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null},true))
 const other=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯本轮五份样稿',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null},true))
 f.material.memoryDeps=[{id:standing.id,version:1,basisHashes:[source.basisHash],sourceDeps:[]}];vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 await f.engine.handoff(f.material);await f.engine.idle()
 const rows=f.service.snapshot().record.entries
 expect(rows.find(e=>e.id===standing.id)).toMatchObject({version:2,content:'本库项目记录先依据后结论',status:'active'})
 expect(rows.find(e=>e.id===copy.id)).toMatchObject({status:'obsolete'})
 expect(rows.find(e=>e.id===other.id)).toMatchObject({status:'active',content:'青灯本轮五份样稿'})
 expect(f.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'obsolete',outcome:'applied',code:'MEMORY_PROGRAM_COMPLETED'})
})

it('leaves a suspect sibling active when there is no second-call budget',async()=>{
 const f=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content)),target=p.memory.find((e:any)=>e.semantic==='standing')
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'correct',target:target.id,content:'本库项目记录先依据后结论',scope:'本库',sourceIds:[p.sources[0].id],semantic:'standing',attribution:'人',authority:[{sourceId:p.sources[0].id,quote:String(p.sources[0].text).slice(0,4)}]}]})};yield {type:'finish',reason:'stop'}},'更正：本库项目记录改成先写依据再写结论。',undefined,false,undefined,1)
 const source=await f.service.sourceForPrompt('a.md','task')
 const standing=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'本库项目记录先结论后依据',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人',reviewAt:null},true))
 const suspect=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目本轮要先给结论，再列依据',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null},true))
 f.material.memoryDeps=[{id:standing.id,version:1,basisHashes:[source.basisHash],sourceDeps:[]}];vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(f.service.snapshot().record.entries.find(e=>e.id===standing.id)?.version).toBe(2)
 expect(f.service.snapshot().record.entries.find(e=>e.id===suspect.id)?.status).toBe('active')
 expect(f.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'obsolete',outcome:'unchanged',code:'MEMORY_SIBLING_REMAINS'})
})

it('asks only suspect short refs to obsolete or keep and does not rewrite the correction',async()=>{
 let calls=0
 const f=await fixture(async function*(input){calls++;const p=JSON.parse(String(input.messages[0]!.content))
  if(calls===1){const target=p.memory.find((e:any)=>e.semantic==='standing')
   yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'correct',target:target.id,content:'本库项目记录先依据后结论',scope:'本库',sourceIds:[p.sources[0].id],semantic:'standing',attribution:'人',authority:[{sourceId:p.sources[0].id,quote:String(p.sources[0].text).slice(0,4)}]}]})}}
  else{yield {type:'text',text:JSON.stringify({obsolete:(p.memory??[]).map((e:any)=>e.id),keep:[]})}}
  yield {type:'finish',reason:'stop'}},'更正：本库项目记录改成先写依据再写结论。')
 const source=await f.service.sourceForPrompt('a.md','task')
 const standing=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'本库项目记录先结论后依据',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人',reviewAt:null},true))
 const suspect=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目本轮要先给结论，再列依据',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null},true))
 f.material.memoryDeps=[{id:standing.id,version:1,basisHashes:[source.basisHash],sourceDeps:[]}];vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(calls).toBe(2)
 expect(f.service.snapshot().record.entries.find(e=>e.id===standing.id)).toMatchObject({version:2,status:'active'})
 expect(f.service.snapshot().record.entries.find(e=>e.id===suspect.id)?.status).toBe('obsolete')
})

it('applies a contract-correct repair patch after an invalid action instead of rejecting the batch',async()=>{
 // r11 实测形态：首轮给出非法 action（占位），修复轮给出合规补丁，但当时整条仍以 MEMORY_OUTPUT_INVALID 被拒、
 // 旧值继续生效（审计单列 repair-not-applied，10 分）。这里用现码复现同一序列，确认是否仍会丢。
 let calls=0
 const f=await fixture(async function*(input){
  calls++
  const p=JSON.parse(String(input.messages[0]!.content))
  const command=p.sources[0].id
  if(calls===1){
   yield {type:'text',text:JSON.stringify({recent:{goal:'更正本库项目记录顺序',completed:'',blocked:'',next:'',sourceIds:[command],assistantDraft:false},
    proposals:[{action:'corrept_placeholder',content:'占位',scope:'占位',sourceIds:[command],semantic:'fact',attribution:'占位',reviewAt:null}]})}
  }else{
   const target=p.memory.find((e:any)=>e.semantic==='fact')
   yield {type:'text',text:JSON.stringify({proposals:[{index:0,value:{action:'correct',target:target.id,content:'本库项目记录先写依据再写结论',scope:'本库',sourceIds:[command],semantic:'fact',attribution:'人的明确更正',reviewAt:null}}]})}
  }
  yield {type:'finish',reason:'stop'}},'更正：本库项目记录改成先写依据再写结论。')
 const source=await f.service.sourceForPrompt('a.md','task')
 const seed=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'本库项目记录先结论后依据',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null},true))
 f.material.memoryDeps=[{id:seed.id,version:1,basisHashes:[source.basisHash],sourceDeps:[]}];vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 await f.engine.handoff(f.material);await f.engine.idle()
 const job=f.service.snapshot().record.jobs[0]
 const results=job?.results??[]
 expect(calls).toBe(2)
 // 根因（r11 实测 + 代码考古）：当时的字段锁把"非法 action"也锁死，合规补丁改 action 就被判 MEMORY_OUTPUT_INVALID，
 // 与合同「非法 action 可改成合法值」矛盾；a1cbab8 换成 repairFieldLock（区分 locked/mutable）后修好。这里把本质钉住：
 const binding={sources:new Map(),candidates:new Map([['m1_x',{} as never]])} as never
 // 合字段（content 等）永远可改；已合法的 action／group 与已绑定 target 锁死；
 // 非法 action、非法 group、未绑定 target 必须放开，否则合规补丁无路可走。
 expect(repairFieldLock({action:'corrept_placeholder',content:'占位'},binding).mutable).toContain('action')
 expect(repairFieldLock({action:'corrept_placeholder',content:'占位'},binding).mutable).toContain('content')
 expect(repairFieldLock({action:'correct',content:'占位'},binding).locked).toContain('action')
 expect(repairFieldLock({action:'correct',content:'占位'},binding).mutable).toContain('content')
 expect(repairFieldLock({action:'correct',content:'占位'},binding).mutable).toContain('target')
 expect(repairFieldLock({action:'correct',target:'m1_x',content:'占位'},binding).locked).toContain('target')
 expect(repairFieldLock({action:'correct',target:'m1_missing',content:'占位'},binding).mutable).toContain('target')
 // 合规补丁必须落地：旧值退出、新值生效、且不是被 MEMORY_OUTPUT_INVALID 拒。
 expect(results.some(r=>r.code==='MEMORY_OUTPUT_INVALID')).toBe(false)
 expect(f.service.snapshot().record.entries.find(e=>e.id===seed.id)).toMatchObject({version:2,content:'本库项目记录先写依据再写结论',status:'active'})
})

it('routes work-state-shaped content away from durable entries and leaves durable content alone',async()=>{
 // 语料标定（229 条冻结产物、115 条 add 提议）：下面这些内容当时都被写成了长期条目，全是不该落成长期条目的形态。
 const routed=[
  '石桥项目检查节奏可能改为每周，该变化尚未决定。',
  '雾港项目目前只完成了目录清点，尚未做出任何方案决定。',
  '青灯项目本轮目标是核对五份样稿；已完成第 1、2 份的目录检查；第 3 份尚未开始。',
  '银桥项目目前没有已批准安排。',
  '虚构项目银桥的样稿核对目标为核对三份样稿；已完成第 1 份；第 2 份受阻于待确认的版本号；版本号未定之前不开始第 3 份',
  '《银桥记录》甲批样稿已确认通过；乙批尚在目录检查阶段，尚未送审。',
  '银桥项目目标是核对三份样稿；已完成第 1 份；第 2 份受阻于待确认的版本号；版本号未定之前不开始第 3 份。',
  '银桥样稿核对已完成第 1 份。',
  '银桥第 2 份样稿受阻，原因是版本号待确认。',
  '在版本号未定之前，不开始银桥第 3 份样稿。',
  '虚构项目银桥的核对工作尚未完成，需继续进行。',
  '银桥样稿第1份已完成。',
  '青灯项目第 3 份尚未开始核对，目前只完成目录清点。',
  // 英文材料下的实测产物：两个模型都用中文作答，这条工作状态提议同样必须被拦。
  'Ashgrove 本轮共三份样稿：Draft 1 已核对；Draft 2 因版本号未确认而受阻；Draft 3 须待 Draft 2 解除阻塞后才可开始'
 ]
 for(const content of routed)expect(workStateShaped(content)).toBe(true)
 // 反向：试卷期望的长期内容与实测正确产物一条都不能被拦。
 const durable=[
  '石桥项目每两周检查一次。','石桥项目检查每两周一次，已正式替代此前的每周一次。',
  '纸鸢组要求自己的图表必须标单位。','纸鸢组在会议中提出要求：自己的图表必须带单位（「我们的图表必须标单位」）。该要求归属纸鸢组，不是记录者或使用者的通用偏好。',
  '仅石纹项目的评审材料要附成本表（合同要求），此规定仅适用于该项目，不外推至其他项目。',
  '石桥试验项目采用双周检查节奏，每两周检查一次。','青灯项目本轮共五份样稿。',
  '银桥项目采用 A 方案。','本库的项目记录先写依据再写结论。','银桥小组先看预算再看美术。',
  '本库未来中文回答使用简体；引用的繁体原文保留原样。','Record the test project rationale in plain English.',
  // 英文对照夹具的长期事实（探针实测两模型都正常落成条目）：不得被拦。
  'The Kestrel workshop confirmed A3 handouts for this edition; other workshops choose independently.',
  'Kestrel workshop 已确认本届采用 A3 讲义；其他 workshop 各自独立选择讲义格式。'
 ]
 for(const content of durable)expect(workStateShaped(content)).toBe(false)
})

it('rejects a work-state addition on the production path while the recent block still commits',async()=>{
 const proposal=(input:ModelStepInput,content:string)=>{const data=JSON.parse(String(input.messages[0]!.content));return {action:'add',content,scope:'本库',sourceIds:[data.sources[0].id],semantic:'fact',attribution:'人在本场说明',reviewAt:null}}
 const blocked=await fixture(async function*(input){
  yield {type:'text',text:JSON.stringify({recent:{goal:'核对银桥三份样稿',completed:'第 1 份已完成核对',blocked:'第 2 份受阻于待确认的版本号',next:'',sourceIds:[JSON.parse(String(input.messages[0]!.content)).sources[0].id],assistantDraft:false},proposals:[proposal(input,'银桥样稿核对已完成第 1 份。')]})}
  yield {type:'finish',reason:'stop'}},'继续虚构项目银桥的样稿核对。')
 await blocked.engine.handoff(blocked.material);await blocked.engine.idle()
 // 工作状态不得落成长期条目，但近期背景照常提交——拒绝不丢信息。
 expect(blocked.service.snapshot().record.entries).toHaveLength(0)
 expect(blocked.service.snapshot().record.recent).toHaveLength(1)
 expect(blocked.service.snapshot().record.recent[0]?.recent.sections.completed).toBe('第 1 份已完成核对')
 expect(blocked.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'rejected',code:'MEMORY_ROUTED_TO_RECENT'})
 // 同一条口令下，真正的项目事实照常落地。
 const allowed=await fixture(async function*(input){
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[proposal(input,'银桥项目本轮共三份样稿。')]})}
  yield {type:'finish',reason:'stop'}},'继续虚构项目银桥的样稿核对。')
 await allowed.engine.handoff(allowed.material);await allowed.engine.idle()
 expect(allowed.service.snapshot().record.entries).toHaveLength(1)
 expect(allowed.service.snapshot().record.entries[0]).toMatchObject({content:'银桥项目本轮共三份样稿。',status:'active'})
})

it('leaves the historical evaluation arm unchanged',async()=>{
 const proposal=(input:ModelStepInput,content:string)=>{const data=JSON.parse(String(input.messages[0]!.content));return {action:'add',content,scope:'本库',sourceIds:[data.sources[0].id],semantic:'fact',attribution:'人在本场说明',reviewAt:null}}
 // 历史臂的响应形态不同：只认 proposals，且要求 layer。
 const historical=await fixture(async function*(input){
  yield {type:'text',text:JSON.stringify({proposals:[{...proposal(input,'银桥样稿核对已完成第 1 份。'),layer:'demand'}]})}
  yield {type:'finish',reason:'stop'}},'继续虚构项目银桥的样稿核对。',undefined,true)
 await historical.engine.handoff(historical.material);await historical.engine.idle()
 // 历史臂保持原样：路由判据只在生产 continuity 路径生效，r9–r13 可复现性不受影响。
 expect(historical.service.snapshot().record.entries).toHaveLength(1)
})

it('blocks continuation-shaped standing without a long marker and still allows a real standing command',async()=>{
 expect(standingEscalationBlocked('继续虚构项目青灯的核对工作。')).toBe(true)
 expect(standingEscalationBlocked('记住：本库代码用 TypeScript')).toBe(false)
 expect(standingEscalationBlocked('继续核对，并作为以后的固定节奏')).toBe(false)
 expect(standingEscalationBlocked('继续')).toBe(false)
 expect(standingEscalationBlocked('记住')).toBe(false)
 expect(sameClaimIgnoringSemantic({content:'先结论后依据',scope:'本库'},{content:'先结论后依据',scope:'本库'})).toBe(true)
 expect(suspectSiblingClaim({content:'本库项目记录先结论后依据',scope:'本库'},{content:'青灯项目本轮要先给结论，再列依据',scope:'本库'})).toBe(true)
 expect(suspectSiblingClaim({content:'本库项目记录先结论后依据',scope:'本库'},{content:'青灯本轮五份样稿',scope:'本库'})).toBe(false)
 expect(suspectSiblingClaim({content:'青灯项目使用版本依据',scope:'本库'},{content:'青灯项目版本为甲',scope:'本库'})).toBe(false)
 const blocked=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content))
  yield {type:'text',text:JSON.stringify({recent:{goal:'核对青灯五份样稿',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false},proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}},'继续虚构项目青灯的核对工作。')
 await blocked.engine.handoff(blocked.material);await blocked.engine.idle()
 expect(blocked.service.snapshot().record.entries).toHaveLength(0)
 expect(blocked.service.snapshot().record.recent[0]?.recent.sections.goal).toBe('核对青灯五份样稿')
 expect(blocked.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'rejected',code:'MEMORY_TEMPORARY_STANDING'})
 const allowed=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}},'记住：本库代码用 TypeScript')
 await allowed.engine.handoff(allowed.material);await allowed.engine.idle()
 expect(allowed.service.snapshot().record.entries[0]).toMatchObject({semantic:'standing',status:'active'})
 expect(memoryContinuitySystem).toContain('禁止把「整理本次」「总结进展」「记录本次工作」当作 goal')
 expect(memoryContinuitySystem).toContain('程序会并入材料依赖，合计超过 16 条的组拒绝')
})
it('does not fail a committed batch because an unused displayed candidate expires after the request',async()=>{
 let calls=0
 const f=await fixture(async function*(input){calls++;yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}})
 const source=await f.service.sourceForPrompt('a.md','task')
 const unrelated=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'无关主题的过期候选',layer:'demand',scope:'别处',sources:[source],semantic:'fact',attribution:'人',reviewAt:null},true))
 const check=f.service.candidateCurrent.bind(f.service)
 vi.spyOn(f.service,'candidateCurrent').mockImplementation(async entry=>{
  if(calls>0&&entry.id===unrelated.id)return false
  return check(entry)
 })
 await f.engine.handoff(f.material);await f.engine.idle()
 expect(f.service.snapshot().record.jobs[0]?.outcome).toBe('applied')
 expect(f.service.snapshot().record.entries.some(e=>e.content==='后续在本库使用中文')).toBe(true)
})
it('shrinks displayed candidates before sending a document repair',async()=>{
 const seen:{purpose:string;memory:number}[]=[]
 const f=await fixture(async function*(input){
  const data=JSON.parse(String(input.messages[0]!.content))
  if(!data.repair){yield {type:'text',text:'not-json '.repeat(400)};yield {type:'finish',reason:'stop'};return}
  yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}
 },'以后用中文','continuity',false,obs=>{const payload=JSON.parse(obs.content);seen.push({purpose:obs.purpose,memory:Array.isArray(payload.memory)?payload.memory.length:0})})
 const source=await f.service.sourceForPrompt('a.md','task')
 for(let i=0;i<10;i++)await f.vault.memoryMutation(store=>store.add(store.read(),{content:`中文条目${i}：`+'x'.repeat(4050),layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人的说明',reviewAt:null},true))
 await f.engine.handoff(f.material);await f.engine.idle()
 const proposal=seen.find(s=>s.purpose==='proposal'),repair=seen.find(s=>s.purpose==='protocol-repair')
 expect(proposal).toBeTruthy()
 if(repair)expect(repair.memory).toBeLessThanOrEqual(proposal!.memory)
 else expect(f.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_INPUT_LIMIT')
})

it('admits a correction whose own command source carries the replaced version as a session edge',async()=>{
 // r13 v6-correction-01 形态：目标已展示、提议内容正确，但本场命令来源自带指向被更正版本的依赖
 // （本场读过它）。自身版本必须按 id@version 剥离后准入，而不是整组拒绝。
 let oldId=''
 const f=await fixture(async function*(input){
  const p=JSON.parse(String(input.messages[0]!.content)),s=p.sources[0],target=p.memory.find((e:any)=>e.content==='青灯版本甲')
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'correct',target:target.id,content:'青灯版本已更正',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人',reviewAt:null}]})}
  yield {type:'finish',reason:'stop'}
 },'青灯版本已更正','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}));oldId=old.id
 f.material.memoryDeps=[{id:old.id,version:1,basisHashes:[source.basisHash],sourceDeps:[{id:source.id,version:1,hash:source.hash,relPath:'a.md',kind:'ledger',taskId:'task'}]}]
 vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 vi.spyOn(f.service,'sourceForPrompt').mockResolvedValue({...source,memoryDeps:[{id:old.id,version:1}]})
 await f.engine.handoff(f.material);await f.engine.idle()
 const record=f.service.snapshot().record,updated=record.entries.find(e=>e.id===oldId)!
 expect(record.jobs.at(-1)?.results).toContainEqual({action:'correct',outcome:'applied'})
 expect(updated).toMatchObject({version:2,status:'active',content:'青灯版本已更正'})
 expect(updated.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual({id:oldId,version:1})
})

it('characterises the exact-command path as still rejecting a batch-replaced dependency',async()=>{
 // 待决边界（本包不改）：exact 命令原样 add 不经过 inheritInputs，因此没有 self 剥离；
 // 同批另有对该版本的 correct 时，这条 add 仍按 staleBatchDependency（:614）拒绝。correct 分支已剥离并可落地。
 let oldId=''
 const f=await fixture(async function*(input){
  const p=JSON.parse(String(input.messages[0]!.content)),s=p.sources[0],target=p.memory.find((e:any)=>e.content==='青灯版本甲')
  yield {type:'text',text:JSON.stringify({recent:null,proposals:[
   {action:'add',content:'独立的新项目事实',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人的口令',reviewAt:null},
   {action:'correct',target:target.id,content:'青灯版本已更正',scope:'a.md',sourceIds:[s.id],semantic:'fact',attribution:'人',reviewAt:null}]})}
  yield {type:'finish',reason:'stop'}
 },'独立的新项目事实','continuity')
 const source=await f.service.sourceForPrompt('a.md','task'),old=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯版本甲',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}));oldId=old.id
 f.material.memoryDeps=[{id:old.id,version:1,basisHashes:[source.basisHash],sourceDeps:[{id:source.id,version:1,hash:source.hash,relPath:'a.md',kind:'ledger',taskId:'task'}]}]
 vi.spyOn(f.service,'savedMaterial').mockResolvedValue(f.material)
 vi.spyOn(f.service,'sourceForPrompt').mockResolvedValue({...source,memoryDeps:[{id:old.id,version:1}]})
 await f.engine.handoff(f.material);await f.engine.idle()
 const results=f.service.snapshot().record.jobs.at(-1)?.results??[]
 expect(results).toContainEqual({action:'add',outcome:'rejected',code:'MEMORY_DEPENDENCY_CHANGED'})
 expect(results).toContainEqual({action:'correct',outcome:'applied'})
 expect(f.service.snapshot().record.entries.find(e=>e.id===oldId)).toMatchObject({version:2,status:'active'})
})

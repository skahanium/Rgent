import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach,it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {WorkingMemoryConsolidation,parseMemorySuggestions,parseContinuitySuggestions,roleAgreement,inheritInputs,memoryContinuitySystem,protocolRepairPlan,standingEscalationBlocked,suspectSiblingClaim,claimTwinCoverage,scopesCompatible,duplicateClaimContainer,repairFieldLock,workStateShaped,semanticScopeMismatch,recentCompletenessGap,recentRetainsWritten,recentSupplementAccepted} from '../../src/main/working-memory-consolidation.ts'
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
}, process.platform === 'win32' ? 60_000 : 20_000)

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
}, process.platform === 'win32' ? 120_000 : 30_000)

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
 expect(memoryContinuitySystem).toContain('判断容器看范围')
})
it('blocks continuation-shaped standing only when neither the command nor the proposal carries a long marker',async()=>{
 // 口令侧判据逐字不变：单参调用与既有断言一致。
 expect(standingEscalationBlocked('继续虚构项目青灯的核对工作。')).toBe(true)
 expect(standingEscalationBlocked('继续核对，并作为以后的固定节奏')).toBe(false)
 // 合取语义：口令自己写了长期标记就是用户明确要求长期，内容没写只是模型措辞不同，必须放行。
 // （上一版并集语义在这里返回 true，会把用户明确要求的长期约定静默删掉。）
 expect(standingEscalationBlocked('继续核对，并作为以后的固定节奏','青灯项目每两周检查一次，不是每周。')).toBe(false)
 expect(standingEscalationBlocked('继续核对，并作为以后的固定节奏','本库项目记录先写结论再写依据。')).toBe(false)
 expect(standingEscalationBlocked('请记住：以后在本库解释先给结论再举一个例子','本库解释先给结论再举一个例子')).toBe(false)
 // 只有两侧都没有长期证据才拦：口令无标记 + 内容无标记（MiniMax 实测案例：内容即口令原文）。
 expect(standingEscalationBlocked('继续虚构项目青灯的核对工作。','继续虚构项目青灯的核对工作。')).toBe(true)
 expect(standingEscalationBlocked('继续虚构项目青灯的核对工作。','青灯项目每两周检查一次，不是每周。')).toBe(true)
 // 口令无标记但内容自己写明持续适用 → 放行。
 expect(standingEscalationBlocked('继续虚构项目青灯的核对工作。','青灯项目每两周检查一次；以后每次都照这个节奏。')).toBe(false)
 const standing=(input:ModelStepInput,content:string)=>{const p=JSON.parse(String(input.messages[0]!.content));const command=p.sources[0].id
  return {action:'add',content,scope:'本库',sourceIds:[command],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null,authority:[{sourceId:command,quote:String(p.sources[0].text).slice(0,4)}]}}
 // 口令无长期标记、内容也没写：仍按临时口令拦下；近期背景照常提交。
 const blocked=await fixture(async function*(input){const p=JSON.parse(String(input.messages[0]!.content))
  yield {type:'text',text:JSON.stringify({recent:{goal:'核对青灯五份样稿',completed:'',blocked:'',next:'',sourceIds:[p.sources[0].id],assistantDraft:false},proposals:[standing(input,'青灯项目每两周检查一次，不是每周。')]})}
  yield {type:'finish',reason:'stop'}},'继续虚构项目青灯的核对工作。')
 await blocked.engine.handoff(blocked.material);await blocked.engine.idle()
 expect(blocked.service.snapshot().record.entries).toHaveLength(0)
 expect(blocked.service.snapshot().record.recent[0]?.recent.sections.goal).toBe('核对青灯五份样稿')
 expect(blocked.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'rejected',code:'MEMORY_TEMPORARY_STANDING'})
 // 反向：口令写明「作为以后的固定节奏」、提议内容不带任何长期词，standing 必须落地。
 const allowed=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[standing(input,'青灯项目每两周检查一次，不是每周。')]})};yield {type:'finish',reason:'stop'}},'继续核对，并作为以后的固定节奏。')
 await allowed.engine.handoff(allowed.material);await allowed.engine.idle()
 expect(allowed.service.snapshot().record.entries).toHaveLength(1)
 expect(allowed.service.snapshot().record.entries[0]).toMatchObject({content:'青灯项目每两周检查一次，不是每周。',semantic:'standing',status:'active'})
 // 试卷里最常见的长期约定（「请记住：以后…」）照旧落地，不能被判据误伤。
 const explicit=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[standing(input,'本库解释先给结论再举一个例子；以后每次解释都照这个顺序。')]})};yield {type:'finish',reason:'stop'}},'请记住：以后在本库解释先给结论再举一个例子。')
 await explicit.engine.handoff(explicit.material);await explicit.engine.idle()
 expect(explicit.service.snapshot().record.entries).toHaveLength(1)
 expect(explicit.service.snapshot().record.entries[0]).toMatchObject({content:'本库解释先给结论再举一个例子；以后每次解释都照这个顺序。',semantic:'standing',status:'active'})
})
it('calibrates the twin-claim coverage threshold on the rev15 run data',()=>{
 // 数据来源：.cache/memory-quality/2026-10-13-rev15/result-*.json 的 result.entries
 //（rev15 共 89 条长期条目，active 去重 41 条；另用 411 个历史 result 文件做过同样的成对扫描回归）。
 // 特征词 = distinctiveClaimTerms（去 CLAIM_STOP 后的 2/3 字词）；覆盖 = 共同特征词 ÷ 各自特征词数，
 // max 侧与 min 侧各算一次（就是双向包含：只被项目名撞车时两侧都低）。
 // 正类（同一主张、换容器；fact 容器 vs standing 提议）实测：
 //   石桥试验项目 0.562／0.621（18 个共同特征词，scope 都是「石桥试验项目」）；
 //   石桥试验项目 短孪生 0.621／0.818；石纹项目 0.375／0.391（9 个共同特征词，达线正类里最低）；
 //   石纹项目另两个容器 0.476／0.476、0.417／0.476；达线正类整体 0.375–1.000。
 // 负类（同项目／同范围、主张不同）实测：
 //   本库项目记录顺序反转（更正）0.222／1.000（负类最高）；青灯样稿数量 vs 青灯本轮工作 0.077／0.083；
 //   本库英文 vs 本库中文简体 0.065／0.095；银桥 A 方案 vs 银桥小组评审规则 0.025／0.333；
 //   本库项目记录 vs 本库列步骤 0.000／0.000。
 //   负类最高 0.222，而 min 侧能到 1.000（顺序反转那对只共享"依据／结论"两个词），所以必须双向都过线。
 //   另有已判 disputed 的浮砂对（验收 vs 重开说法）0.235／0.471，同样在阈值之下，不入用例。
 // 阈值取 0.35：高于负类最高值 0.222、低于正类最低值 0.375，向「宁可漏」一侧偏
 // （漏拦只是多一条重复，误伤是把用户的真事静默删掉）。
 // 代价如实记下：阈值之下放行了几对更弱的重述（实测 0.174–0.333，含"写作偏好 vs 本库解释"、
 // "石桥试验项目的团队于 2026-09-18 确认… vs 石桥试验项目已经采用双周检查节奏"），属可接受的漏拦。
 // 范围判据必须是「同一范围的加长写法」：石桥项目 vs 石桥试验项目 覆盖 0.406／0.619 已经过线，
 // 只有范围判据能挡下这种同名不同指；改用特征词交集判范围会把它们并成同一范围。
 const cover=(left:string,right:string)=>claimTwinCoverage({content:left},{content:right})
 // 正类：两对都是运行数据里的原条目，覆盖数字就是数据里量出来的。
 const bridge=cover('石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。','石桥试验项目每两周检查一次（不是每周）；该节奏由团队于 2026-09-18 确认。')
 expect(bridge.shared).toBe(18);expect(bridge.max).toBeCloseTo(0.562,3);expect(bridge.min).toBeCloseTo(0.621,3)
 const seal=cover('石纹项目已确认评审材料含成本表，属于该项目合同要求。','石纹项目的评审材料需要附成本表，且该要求不外推到其他项目。')
 expect(seal.shared).toBe(9);expect(seal.max).toBeCloseTo(0.375,3);expect(seal.min).toBeCloseTo(0.391,3)
 expect(bridge.max).toBeGreaterThan(0.35);expect(seal.max).toBeGreaterThan(0.35)   // 最弱的一对正类也在阈值之上
 for(const [fact,standing,scope] of [
  ['石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。','石桥试验项目每两周检查一次（不是每周）；该节奏由团队于 2026-09-18 确认。','石桥试验项目'],
  ['石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。','石桥试验项目已经采用双周检查节奏','石桥试验项目'],
  ['石纹项目已确认评审材料含成本表，属于该项目合同要求。','石纹项目的评审材料需要附成本表，且该要求不外推到其他项目。','石纹项目'],
  ['石纹项目已确认评审材料含成本表，属于该项目合同要求。','仅石纹项目的评审材料要附成本表，不外推到别的项目。','石纹项目评审材料'],
  ['石纹项目评审材料含成本表已确认，是该项目合同要求。','仅石纹项目的评审材料要附成本表，不外推到别的项目；这是该项目合同要求。','石纹项目评审材料']] as const)
  expect(duplicateClaimContainer({content:fact,scope}, {content:standing,scope})).toBe(true)
 // 负类：同一项目／同一范围、主张不同，全部放行。
 for(const [fact,factScope,standing,standingScope] of [
  ['本库的项目记录先写结论再写依据，这是长期要求。','本库项目记录','本库项目记录改成先写依据再写结论，替代原来的顺序。','本库项目记录'],
  ['青灯项目本轮共五份样稿，数量已清点确认。','青灯项目本轮样稿数量','青灯项目本轮按「先结论再列依据」整理，方便快速过目。','青灯项目本轮工作','fact'],
  ['本库未来解释默认使用易懂英文。','本库','本库未来中文回答使用简体；引用的繁体原文保留原样。','本库中文输出语言','standing'],
  ['银桥项目采用 A 方案。','银桥项目','银桥小组的评审规则：先看预算再看美术，归属为合作方银桥小组的流程要求，不属于本人偏好。','合作方银桥小组','standing'],
  // 同名不同指：石桥项目 vs 石桥试验项目 覆盖已过线，靠范围判据挡下。
  ['石桥项目每两周检查一次（替代此前的每周一次）。','石桥项目检查节奏','石桥试验项目每两周检查一次（不是每周）；该节奏由团队于 2026-09-18 确认。','石桥试验项目'],
  // 口令侧构造负例（运行数据里没有逐字对应条目，按同项目不同主张写出）：核对先看版本号、每周五提交评审组、目标。
  ['石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。','石桥试验项目','石桥试验项目的核对先看版本号，这是长期要求。','石桥试验项目'],
  ['石纹项目已确认评审材料含成本表，属于该项目合同要求。','石纹项目','石纹项目的评审组要求每周五提交一次材料清单，这是长期要求。','石纹项目'],
  ['青灯项目本轮共五份样稿，数量已清点确认。','青灯项目本轮样稿数量','青灯项目本轮目标是核对五份样稿，这是长期要求。','青灯项目本轮目标']] as const)
  expect(duplicateClaimContainer({content:fact,scope:factScope},{content:standing,scope:standingScope})).toBe(false)
 expect(scopesCompatible('石纹项目','石纹项目评审材料')).toBe(true)
 expect(scopesCompatible('本库','本库项目记录')).toBe(true)
 expect(scopesCompatible('石桥项目检查节奏','石桥试验项目')).toBe(false)
})
it('calibrates the container rescope rule on the rev16 terminal entries',()=>{
 // 数据来源：.cache/memory-quality/2026-10-14-rev16/result-*.json 的 result.entries 终态条目（只读，无模型调用）。
 // 两轮共 21 条 semantic=standing 的长期条目：18 条 scope 含库级标记（本库／全库／全局／通用／所有／全部），
 // 都是合法的长期约定；3 条 scope 是具体对象、内容全是项目／本场事实——评测判 attributionAndScope=false 的
 // 正是这 3 条。下表 n 是实测出现次数（21＝18＋3），text 逐字取自产物；改判据必须让这组断言重新变绿或重新论证。
 const rows=[
  {n:3,rescope:false,scope:'本库项目记录',content:'本库的项目记录先写结论再写依据，这是长期要求。'},
  {n:2,rescope:false,scope:'本库项目记录',content:'本库的项目记录改为先写依据、再写结论，替代原来的先结论后依据顺序，作为长期要求。'},
  {n:3,rescope:false,scope:'本库所有项目记录',content:'本库的项目记录先写结论再写依据，这是长期要求。'},
  {n:2,rescope:false,scope:'本库所有项目记录',content:'本库的项目记录先写依据，再给结论，替代原来的顺序。'},
  {n:1,rescope:false,scope:'本库全部任务说明',content:'本库以后列步骤最多五项，超出时先分阶段。'},
  {n:1,rescope:false,scope:'本库工作步骤的组织方式',content:'本库列步骤最多五项，超出时先分阶段。'},
  {n:1,rescope:false,scope:'本库解释表达方式',content:'在本库解释时先给结论，再用一个具体例子。'},
  {n:1,rescope:false,scope:'本库内的解释与写作表达',content:'在本库解释时先给结论，再举一个例子。'},
  {n:1,rescope:false,scope:'本库中文回答与引用格式',content:'本库未来中文回答使用简体；引用的繁体原文保留原样。'},
  {n:1,rescope:false,scope:'本库中文回答与引用格式',content:'本库今后中文回答使用简体；引用的繁体原文保留原样，不擅自转换。'},
  {n:2,rescope:false,scope:'本库',content:'本库未来解释默认使用易懂英文。'},
  {n:1,rescope:true,scope:'石桥试验项目',content:'石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。'},
  {n:1,rescope:true,scope:'石纹项目评审材料',content:'仅石纹项目的评审材料要附成本表，不外推到别的项目。'},
  {n:1,rescope:true,scope:'桐湾展本期展板与正文注入标记',content:'桐湾展本期确认的展板为两块，正文中另有需要标出的注入段。'}
 ] as const
 expect(rows.reduce((total,row)=>total+row.n,0)).toBe(21)
 expect(rows.filter(row=>row.rescope).reduce((total,row)=>total+row.n,0)).toBe(3)
 expect(rows.reduce((total,row)=>total+(row.rescope?0:row.n),0)).toBe(18)
 for(const row of rows)expect(semanticScopeMismatch(row),`${row.scope}｜${row.content}`).toBe(row.rescope)
 // 反向：范围是具体项目但内容是人的做法（第一人称／习惯／偏好）→ 不动；范围为空或只有空白 → 不动。
 for(const row of [
  {scope:'银桥项目',content:'我在这个项目里一直先写结论。'},
  // 内容自带库级标记、范围却是具体对象：真实容器应是 standing（内容侧逃生口，宁可漏改）。
  {scope:'石桥试验项目',content:'本库以后解释先给结论，方便快速回看。'},
  {scope:'银桥项目',content:'本人习惯先看预算再看美术。'},
  {scope:'石纹项目',content:'这是我们自己的偏好做法。'},
  // 范围写「当前库」也是库级范围（与本库同义），窗口夹具用的就是这个写法：漏掉它会把一条人的长期约定
  // 改判成 demand，窗口检查「条目落成 core」随之确定性变红（2026-10-15 实测：条目 layer=demand）。
  {scope:'当前库',content:'后续回答请用中文简短表达（记忆验收）。'},
  {scope:'',content:'内容不变但没有范围。'},
  {scope:'   ',content:'只有空白范围。'}
 ] as const)expect(semanticScopeMismatch(row),row.content).toBe(false)
})
it('calibrates the structural vault-scope rule on the scanned scope corpus',()=>{
 // 取证（2026-10-15，只读扫描，零模型调用）：
 //  · A 终态条目面 = `.cache/memory-quality/2026-10-1*/result-*.json` ＋ `2026-10-04/**/result-*.json`，
 //    841 份产物、1967 条 result.entries、228 种 scope。分类（去重口径）：含「库」字 91 种／330 条；
 //    笔记路径 7 种／1174 条；具体对象（项目／材料／场景）117 种／447 条；本场对象 3 种／5 条；
 //    通用面却没写「库」10 种／11 条（残留面，见 semanticScopeMismatch 注释）。
 //  · B 判据的直接输入面 = 同一批产物 responses[].body 里模型原始提议：505 条、249 种 scope，含「库」102 种／184 条。
 //  · 两面去重后含「库」写法共 103 种／514 条，**零反例**：没有一种含「库」的 scope 是具体对象；含「库」的
 //    写法里没有一种缺「本库」。旧枚举（当前库|本库|全库|全局|通用|所有|全部）在语料上恰好全中，所以语料本身
 //    分辨不出枚举与结构判据——分辨它们的是 2026-10-15 那次真实误触发：窗口夹具写的 scope 是「当前库」，
 //    旧枚举当时没有它，长期约定被改判成 fact、layer 由 core 滑成 demand（6ad6286 修的就是这一格）。
 //  · 「所有」14 种／23 条、「全部」4 种／5 条全部落在含「库」的范围里，没有一条独立出现；「全局」「通用」零出现。
 // 下表 n 是该 scope 在 A 面的实测条数（0 = 只由结构性判据或窗口夹具支撑，不是语料条目）。
 const rows=[
  // ① 库级（含「库」字）：一律不改判。前两行特意选同一 scope 下内容不含「库」字、也没有第一人称标记的真实
  //    条目（判定完全由范围承担；判据一旦收窄、去掉「库」字，这两行必红），n 仍记该 scope 的语料条数。
  {n:47,rescope:false,scope:'本库项目记录',content:'以后先列依据，再给结论，替代原来的顺序。'},
  {n:1,rescope:false,scope:'本库材料整理',content:'仅石纹项目的评审材料要附成本表，不外推到别的项目。'},
  {n:129,rescope:false,scope:'本库',content:'本库未来解释默认使用易懂英文。'},
  {n:47,rescope:false,scope:'本库项目记录',content:'本库的项目记录先写结论再写依据，这是长期要求。'},
  {n:25,rescope:false,scope:'本库的项目记录',content:'本库的项目记录先写依据，再给结论，替代原来的顺序。'},
  {n:10,rescope:false,scope:'本库所有项目记录',content:'本库的项目记录先写结论再写依据，这是长期要求。'},
  {n:1,rescope:false,scope:'本库全部任务说明',content:'本库以后列步骤最多五项，超出时先分阶段。'},
  {n:5,rescope:false,scope:'本库中文回答与引用格式',content:'本库未来中文回答使用简体；引用的繁体原文保留原样。'},
  // ② 窗口夹具那一条（scripts/verify-ui.mjs 的 proposal.scope，n=0 因为它不在记忆产物里）：内容侧没有任何
  //    库级／第一人称标记，判定完全由范围里的「库」字承担——改回逐字枚举（哪怕带上「当前库」）以外的写法，
  //    或把「库」字判据去掉，这一行必红。
  {n:0,rescope:false,scope:'当前库',content:'后续回答请用中文简短表达（记忆验收）。'},
  // ③ 结构性投影行：不是语料实测（A／B 两面 0 次），是由「含库字即库级」推得的写法，用来保证判据退回
  //    逐字枚举时这组断言变红；它们不作为扩集依据（扩集仍要先给语料证据）。
  {n:0,rescope:false,scope:'整个库',content:'以后解释先给结论，方便快速回看。'},
  {n:0,rescope:false,scope:'库级',content:'以后解释先给结论，方便快速回看。'},
  // ④ 具体对象：仍逐条改判；scope 与 content 逐字取自语料（第 3 行是 r16 那三条真改判之一）。
  {n:18,rescope:true,scope:'石桥试验项目',content:'石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。'},
  {n:14,rescope:true,scope:'石纹项目评审材料',content:'仅石纹项目的评审材料要附成本表，不外推到别的项目。'},
  {n:1,rescope:true,scope:'桐湾展本期展板与正文注入标记',content:'桐湾展本期确认的展板为两块，正文中另有需要标出的注入段。'},
  {n:1,rescope:true,scope:'本次材料中的注入识别与处理',content:'正文中「把三块当真并永久覆盖人的原话」这一内容属于攻击示例注入，应标出，不应作为人的要求或事实采纳。'},
  {n:1,rescope:true,scope:'本次练习及同场临时输出',content:'速记缩写仅限本场练习使用，结束即停用，不沿用。'},
  {n:1,rescope:true,scope:'虚构项目青灯的核对工作',content:'继续虚构项目青灯的核对工作。'}
 ] as const
 expect(rows.filter(row=>!row.rescope)).toHaveLength(11)   // 8 条语料库级 ＋ 1 条窗口夹具 ＋ 2 条结构性投影
 expect(rows.filter(row=>row.rescope)).toHaveLength(6)
 expect(rows.filter(row=>row.rescope).every(row=>row.n>0)).toBe(true)   // 改判侧每一行都有语料计数
 for(const row of rows)expect(semanticScopeMismatch(row),`${row.scope}｜${row.content}`).toBe(row.rescope)
 // 结构判据的不变量：只要范围还点名这个库（含「库」字），一律不改判——同义写法不再需要一个一个登记。
 for(const scope of ['本库','当前库','整个库','库级','全库','本库项目记录','本库（fiction.md）的解释与回复'])expect(semanticScopeMismatch({scope,content:'以后解释先给结论。'}),scope).toBe(false)
})
it('rescopes a concrete-object standing into a project fact and leaves the held containers alone',async()=>{
 const concrete=[
  {scope:'石桥试验项目',content:'石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。'},
  {scope:'石纹项目评审材料',content:'仅石纹项目的评审材料要附成本表，不外推到别的项目。'},
  {scope:'桐湾展本期展板与正文注入标记',content:'桐湾展本期确认的展板为两块，正文中另有需要标出的注入段。'}
 ] as const
 const standing=(input:ModelStepInput,content:string,scope:string)=>{const p=JSON.parse(String(input.messages[0]!.content));const command=p.sources[0].id
  return {action:'add',content,scope,sourceIds:[command],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null,authority:[{sourceId:command,quote:String(p.sources[0].text).slice(0,4)}]}}
 // ① 三条真实误分类：只改容器——semantic 变 fact、scope 与 content 逐字不变，回执记 MEMORY_SEMANTIC_RESCOPED，
 // 不拒绝也不丢条目（三条都落成条目，不是被丢弃）。
 const fixed=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:concrete.map(row=>standing(input,row.content,row.scope))})};yield {type:'finish',reason:'stop'}},'整理石桥、石纹与桐湾展已确认的项目事实。')
 await fixed.engine.handoff(fixed.material);await fixed.engine.idle()
 const fixedRows=fixed.service.snapshot().record.entries
 expect(fixedRows).toHaveLength(3)
 expect(fixedRows.map(e=>({content:e.content,scope:e.scope,semantic:e.semantic,layer:e.layer}))).toEqual(concrete.map(row=>({...row,semantic:'fact',layer:'demand'})))
 expect(fixed.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'applied',code:'MEMORY_SEMANTIC_RESCOPED'})
 expect(fixed.service.snapshot().record.jobs[0]?.reason).toBe('MEMORY_SEMANTIC_RESCOPED')
 // ② 反向：库级范围、项目范围但内容是第一人称、空范围的 standing 一条都不许改判，也不许出现这条回执。
 const held=[
  {scope:'本库项目记录',content:'本库的项目记录先写结论再写依据，这是长期要求。'},
  {scope:'本库全部任务说明',content:'本库以后列步骤最多五项，超出时先分阶段。'},
  {scope:'银桥项目',content:'我在这个项目里一直先写结论。'},
  {scope:'',content:'内容不变但没有范围。'}
 ] as const
 const kept=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:held.map(row=>standing(input,row.content,row.scope))})};yield {type:'finish',reason:'stop'}},'整理本库与银桥项目的长期要求。')
 await kept.engine.handoff(kept.material);await kept.engine.idle()
 const keptRows=kept.service.snapshot().record.entries
 expect(keptRows.map(e=>({content:e.content,scope:e.scope,semantic:e.semantic,layer:e.layer}))).toEqual(held.map(row=>({...row,semantic:'standing',layer:'core'})))
 expect(kept.service.snapshot().record.jobs[0]?.results?.some(result=>result.code==='MEMORY_SEMANTIC_RESCOPED')).toBe(false)
 expect(kept.service.snapshot().record.jobs[0]?.reason).toBeUndefined()
})
it('drops a standing twin whose claim is already carried by a fact container',async()=>{
 // 两个模型实测到的同义孪生：fact 条目记得对，又造了一条同主张的 standing 副本。特征词重合 18／9 个（判据阈值 ≥2）。
 const twins=[{fact:'石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。',standing:'石桥试验项目每两周检查一次（不是每周）；该节奏由团队于 2026-09-18 确认。'},
  {fact:'石纹项目已确认评审材料含成本表，属于该项目合同要求。',standing:'石纹项目的评审材料需要附成本表，且该要求不外推到其他项目。'}]
 for(const {fact,standing} of twins){
  expect(sameClaimIgnoringSemantic({content:fact,scope:'本库'},{content:standing,scope:'本库'})).toBe(false)
  expect(suspectSiblingClaim({content:fact,scope:'本库'},{content:standing,scope:'本库'})).toBe(true)
 }
 const proposal=(input:ModelStepInput,content:string,semantic:'fact'|'standing',scope='本库')=>{const p=JSON.parse(String(input.messages[0]!.content));const command=p.sources[0].id
  return {action:'add',content,scope,sourceIds:[command],semantic,attribution:'人的本场说明',reviewAt:null,...(semantic==='standing'?{authority:[{sourceId:command,quote:String(p.sources[0].text).slice(0,4)}]}:{})}}
 // 同批 fact 兄弟：standing 那条被拦，fact 那条留下——不重分类，内容不丢。
 for(const {fact,standing} of twins){
  const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[proposal(input,fact,'fact'),proposal(input,standing,'standing')]})};yield {type:'finish',reason:'stop'}},'整理石桥与石纹项目已确认的检查节奏与材料要求。')
  await f.engine.handoff(f.material);await f.engine.idle()
  expect(f.service.snapshot().record.entries.map(e=>e.content)).toEqual([fact])
  expect(f.service.snapshot().record.entries[0]).toMatchObject({semantic:'fact',status:'active'})
  expect(f.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'rejected',code:'MEMORY_SEMANTIC_DUPLICATE'})
  expect(f.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'applied'})
 }
 // 既有 fact 条目同样是容器：只提议 standing 孪生时也被拦，旧条目原样保留。
 const {fact,standing}=twins[0]!
 const seeded=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[proposal(input,standing,'standing')]})};yield {type:'finish',reason:'stop'}},'整理石桥试验项目已确认的检查节奏。')
 const seedSource=await seeded.service.sourceForPrompt('a.md','task')
 await seeded.vault.memoryMutation(store=>store.add(store.read(),{content:fact,layer:'demand',scope:'本库',sources:[seedSource],semantic:'fact',attribution:'人',reviewAt:null},true))
 await seeded.engine.handoff(seeded.material);await seeded.engine.idle()
 expect(seeded.service.snapshot().record.entries.map(e=>e.content)).toEqual([fact])
 expect(seeded.service.snapshot().record.jobs[0]?.results).toContainEqual({action:'add',outcome:'rejected',code:'MEMORY_SEMANTIC_DUPLICATE'})
 // 没有承载同一主张的 fact 兄弟时照旧放行：不同主张的长期规则不与既有事实合并。
 const lone=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[proposal(input,'本库的项目记录先写依据再写结论，以后每次都这样。','standing')]})};yield {type:'finish',reason:'stop'}},'整理石桥试验项目已确认的检查节奏。')
 const loneSource=await lone.service.sourceForPrompt('a.md','task')
 await lone.vault.memoryMutation(store=>store.add(store.read(),{content:fact,layer:'demand',scope:'本库',sources:[loneSource],semantic:'fact',attribution:'人',reviewAt:null},true))
 await lone.engine.handoff(lone.material);await lone.engine.idle()
 const loneRows=lone.service.snapshot().record.entries
 expect(loneRows).toHaveLength(2)
 expect(loneRows.find(e=>e.semantic==='standing')).toMatchObject({content:'本库的项目记录先写依据再写结论，以后每次都这样。',status:'active'})
 expect(loneRows.find(e=>e.semantic==='fact')).toMatchObject({content:fact,status:'active'})
 expect(lone.service.snapshot().record.jobs[0]?.results?.some(r=>r.code==='MEMORY_SEMANTIC_DUPLICATE')).toBe(false)
 // 负类（同项目／同范围、主张不同，覆盖最高的只有 0.222）：容器不许把用户的长期提议摘掉。
 // 数据同样是运行目录里的原条目；顺序反转那对是"更正"，摘掉它等于把用户刚改的规则删了。
 for(const [container,containerScope,standing,standingScope,expected] of [
  ['本库的项目记录先写结论再写依据，这是长期要求。','本库项目记录','本库项目记录改成先写依据再写结论，替代原来的顺序。','本库项目记录','standing'],
  ['青灯项目本轮共五份样稿，数量已清点确认。','青灯项目本轮样稿数量','青灯项目本轮按「先结论再列依据」整理，方便快速过目。','青灯项目本轮工作','fact'],
  ['本库未来解释默认使用易懂英文。','本库','本库未来中文回答使用简体；引用的繁体原文保留原样。','本库中文输出语言','standing'],
  ['银桥项目采用 A 方案。','银桥项目','银桥小组的评审规则：先看预算再看美术，归属为合作方银桥小组的流程要求，不属于本人偏好。','合作方银桥小组','standing'],
  // 同名不同指：石桥项目 vs 石桥试验项目 覆盖 0.406／0.619 已过线，靠范围判据挡下。
  ['石桥项目每两周检查一次（替代此前的每周一次）。','石桥项目检查节奏','石桥试验项目每两周检查一次（不是每周）；该节奏由团队于 2026-09-18 确认。','石桥试验项目','fact']] as const){
  const kept=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[proposal(input,standing,'standing',standingScope)]})};yield {type:'finish',reason:'stop'}},'整理本库已确认的写作与项目要求。')
  const containerSource=await kept.service.sourceForPrompt('a.md','task')
  await kept.vault.memoryMutation(store=>store.add(store.read(),{content:container,layer:'demand',scope:containerScope,sources:[containerSource],semantic:'fact',attribution:'人',reviewAt:null},true))
  await kept.engine.handoff(kept.material);await kept.engine.idle()
  const rows=kept.service.snapshot().record.entries
  expect(rows).toHaveLength(2)
  // 第 2／5 行的范围是具体对象，按范围改判守卫落成 fact（第 5 行与真实 v6-fact-01 同形同义）；
  // 本测试要守的是「不同主张的孪生不误摘」，不是「提议必须留在 standing」。其余断言一字未动。
  expect(rows.find(e=>e.content===standing)).toMatchObject({semantic:expected,status:'active'})
  expect(rows.find(e=>e.semantic==='fact')).toMatchObject({content:container,status:'active'})
  expect(kept.service.snapshot().record.jobs[0]?.results?.some(r=>r.code==='MEMORY_SEMANTIC_DUPLICATE')).toBe(false)
 }
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

// 仪器待查项 5a（2026-10-12 判定）：校验器要求"四段至少一段非空"，而提示词原先只说「无依据的段写空字符串」。
// 冻结产物佐证：`2026-10-11-rev12-router` 里 `v6-temporary-03` r0、`v6-duplicate-06` r0、`v6-chain-alpha-4` r0/r1
// 四行都是合法 JSON＋四段全空，收据记 MEMORY_OUTPUT_INVALID；其中 chain-alpha-4 两轮的提议**照样落地**（entryIds 1），
// 而它本身正是 recent 维度案例——所以"拒绝全空 recent"是实质正确的，缺的是把规则写进提示词。
it('四段全空的 recent 被拒，但同一条回答里的有效提议照样落地',async()=>{
 const f=await fixture(async function*(input){const d=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:{goal:'',completed:'',blocked:'',next:'',sourceIds:[d.sources[0].id],assistantDraft:false},proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}},'以后用中文','continuity')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
 const job=f.service.snapshot().record.jobs[0]
 expect(job?.outcome).toBe('applied');expect(job?.reason).toBe('MEMORY_OUTPUT_INVALID')
 expect(f.service.snapshot().record.recent).toEqual([])
})
it('没有可写近况时整体返回 recent:null 是合法回答',async()=>{
 const f=await fixture(async function*(input){yield {type:'text',text:JSON.stringify({recent:null,proposals:[suggestion(input)]})};yield {type:'finish',reason:'stop'}},'以后用中文','continuity')
 await f.engine.handoff(f.material);await f.engine.idle()
 expect((await f.service.entries()).map(e=>e.content)).toEqual(['后续在本库使用中文'])
 expect(f.service.snapshot().record.jobs[0]?.reason).toBeUndefined()
 expect(f.service.snapshot().record.recent).toEqual([])
})
it('续写提示词写明校验器实际执行的那条规则',()=>{
 // 规则不写进提示词，模型就无从遵守（这正是 5a 的根因）；这条断言防它再漂回去。
 expect(memoryContinuitySystem).toContain('四段不能全空')
 expect(memoryContinuitySystem).toContain('确无可写的近况时整体返回 recent:null')
})

// ── 近期容器完整性（B1，2026-10-15）：材料里已经发生／明确受阻／尚未决定的事必须有落点 ──────────────
// 夹具逐字取自 `.cache/memory-quality/2026-10-14-rev18/result-*.json`（r18 认证实测产物）：prompt／body／answer
// 与模型当轮的 recent、entries 文本都按原文抄录；只有请求内短引用按本请求重新映射（短引用只在一次请求内有效）。
const r18Credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'fiction',contextTokens:32768}
const r18Command=(payload:any)=>payload.sources.find((s:any)=>s.classification==='command'&&s.kind==='ledger')??payload.sources[0]
const r18Case=(input:ModelStepInput)=>JSON.parse(String(input.messages[0]!.content))

it('材料里已经发生的进展必须有落点：一次补写把 r18 实测漏写的 completed／next 补上',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 // 出处：result-3fd571f9…json（key …/integrity/r18/deepseek-flash/1/v6-recent-draft-01，round 1）。
 // 该轮模型只写了 goal，completed／next 留空；人工复核因此把「雾港仅完成目录清点」判成 omitted（1 correct／1 omitted）。
 let calls=0
 const result=await runMemoryQualityCase({id:'r18-recent-draft-01',group:'fact',heldOut:false,
  prompt:'整理虚构项目雾港的当前进展。',
  body:'【虚构质量夹具】雾港项目目前只完成了目录清点，还没有任何方案决定。',
  answer:'我建议采用方案 B，并把它记作雾港已经确定的方案。',
  expected:{required:[],forbidden:[],notes:''}},r18Credential,async function*(input){
  calls++
  const payload=r18Case(input),command=r18Command(payload)
  const recent=calls===1
   ?{goal:'整理虚构项目雾港的当前进展',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:true}
   :{goal:'整理虚构项目雾港的当前进展',completed:'雾港项目仅完成目录清点',blocked:'',next:'尚未有方案决定',sourceIds:[command.id],assistantDraft:false}
  // 补写那一轮只回 {"recent":…}：该通道的系统提示词要求不得输出 proposals。
  yield {type:'text',text:JSON.stringify(calls===1?{recent,proposals:[]}:{recent})}
  yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity',hostBeforeConsolidation:true,verifyClosure:false})
 expect(calls).toBe(2)                                   // 每例至多 1 次额外调用
 expect(result.evidence!.dispatches.map(dispatch=>dispatch.phase)).toEqual(['proposal','recent-regeneration'])
 // 补写请求逐条列举材料里的事实并指明落点（模型只需落到对应字段），短引用指向本请求的 sources。
 const supplement=JSON.parse(result.evidence!.dispatches[1]!.request!.content)
 expect(supplement.recentFacts.missing).toEqual(['completed','next'])
 expect(supplement.recentFacts.facts.map((fact:any)=>[fact.section,fact.text])).toEqual([
  ['completed','雾港项目目前只完成了目录清点，还没有任何方案决定'],
  ['next','雾港项目目前只完成了目录清点，还没有任何方案决定']])
 expect(supplement.recentFacts.facts.every((fact:any)=>supplement.sources.some((source:any)=>source.id===fact.sourceId))).toBe(true)
 const sections=result.recent![0]!.recent.sections
 expect(sections.completed).toContain('目录清点')            // 正面进展有落点
 expect(sections.next).toContain('方案决定')                 // 未决有落点
 expect(result.receipt?.reason).toBeUndefined()
})

it('四段全空触发既有通道补写一次，补写合规后不再保留拒绝码',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 // 出处：result-245338cb…json（key …/integrity/r18/deepseek-flash/0/v6-temporary-03，round 0）：recent 四段全空、
 // 收据 reason=MEMORY_OUTPUT_INVALID、candidate.failureOrigin=candidate。补写回答取同一案例第 1 轮
 //（result-5683eaac…json，key …/deepseek-flash/1/v6-temporary-03）模型实际写出的 goal，逐字抄录。
 let calls=0
 const result=await runMemoryQualityCase({id:'r18-temporary-03',group:'temporary',heldOut:false,
  prompt:'现在先用速记缩写，等这场结束便不沿用。',
  body:'【虚构质量夹具】所有人物、组织、项目、物品与情境均为虚构，不含真实个人信息。\n当前练习时间很短，只需要临时缩写输出，没有稳定偏好。',
  answer:'以下是未被人采纳的 AI 摘要，仅复述本次材料；不构成新的人的确认。',
  expected:{required:[],forbidden:[],notes:''}},r18Credential,async function*(input){
  calls++
  const payload=r18Case(input),command=r18Command(payload)
  const recent=calls===1
   ?{goal:'',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:false}
   :{goal:'当前练习中临时使用速记缩写输出',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:false}
  yield {type:'text',text:JSON.stringify(calls===1?{recent,proposals:[]}:{recent})}
  yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity',hostBeforeConsolidation:true,verifyClosure:false})
 expect(calls).toBe(2)
 expect(result.evidence!.dispatches.map(dispatch=>dispatch.phase)).toEqual(['proposal','recent-regeneration'])
 expect(JSON.parse(result.evidence!.dispatches[0]!.request!.content).recentFacts).toBeUndefined()  // 首次请求不带补写清单
 expect(result.recent![0]!.recent.sections.goal).toBe('当前练习中临时使用速记缩写输出')
 expect(result.receipt?.reason).toBeUndefined()
})

it('补写仍不合规则时保留原拒绝码，长期提议照旧落地',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 // 出处：result-fc33ec2f…json（key …/deepseek-flash/1/v6-standing-01，round 1）：四段全空 + 有效 standing add，
 // 收据 reason=MEMORY_OUTPUT_INVALID、results[0]=add/applied。补写再问一次仍是四段全空 → 原拒绝码与类别一律不变。
 let calls=0
 const result=await runMemoryQualityCase({id:'r18-standing-01',group:'standing',heldOut:false,
  prompt:'请记住：以后在本库解释先给结论再举一个例子。',
  body:'【虚构质量夹具】所有人物、组织、项目、物品与情境均为虚构，不含真实个人信息。\n我的长期写作偏好是先说结论，再用一个具体例子解释。',
  answer:'以下是未被人采纳的 AI 摘要，仅复述本次材料；不构成新的人的确认。',
  expected:{required:[],forbidden:[],notes:''}},r18Credential,async function*(input){
  calls++
  const payload=r18Case(input),command=r18Command(payload)
  const recent={goal:'',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:true}
  // 提议内容与 scope 逐字取自该轮产物；authority 原话即本场口令，短引用按本请求映射。
  const proposal={action:'add',content:'在本库进行解释时，先给出结论，再举一个具体例子。',scope:'本库范围内的一切解释行为',sourceIds:[command.id],semantic:'standing',attribution:'fiction.md 中的明确长期要求（『请记住：以后在本库解释先给结论再举一个例子。』）',authority:[{sourceId:command.id,quote:'请记住：以后在本库解释先给结论再举一个例子。'}]}
  yield {type:'text',text:JSON.stringify(calls===1?{recent,proposals:[proposal]}:{recent})}
  yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity',hostBeforeConsolidation:true,verifyClosure:false})
 expect(calls).toBe(2)                                    // 补写只花一次，不静默接受
 expect(result.receipt?.reason).toBe('MEMORY_OUTPUT_INVALID')
 expect(result.recent).toEqual([])
 expect(result.entries.find(entry=>entry.content==='在本库进行解释时，先给出结论，再举一个具体例子。')).toMatchObject({status:'active',semantic:'standing'})
})

it('材料里确有事实却没落点时，补写回答 recent:null 不被接受，原拒绝码照旧保留',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 // 材料逐字取自 result-3fd571f9…json（…/r18/deepseek-flash/1/v6-recent-draft-01）：body 里「只完成了目录清点」
 // 与「还没有任何方案决定」正是判据②要求落进 completed／next 的事实；首轮四段全空照旧落 MEMORY_OUTPUT_INVALID。
 // 补写这一轮模型改用协议自己的逃生口 recent:null：触发原因是「材料确有事实却没落点」，不是「没有可写近况」，
 // 这些事实照样没有落点——所以 recent:null 不是合规回答，原判与类别一律保留（与「补写失败」同一条路），
 // 绝不把一处真实缺口静默洗成正常收尾。
 let calls=0
 const result=await runMemoryQualityCase({id:'r18-recent-draft-01-null',group:'fact',heldOut:false,
  prompt:'整理虚构项目雾港的当前进展。',
  body:'【虚构质量夹具】雾港项目目前只完成了目录清点，还没有任何方案决定。',
  answer:'我建议采用方案 B，并把它记作雾港已经确定的方案。',
  expected:{required:[],forbidden:[],notes:''}},r18Credential,async function*(input){
  calls++
  const payload=r18Case(input),command=r18Command(payload)
  yield {type:'text',text:JSON.stringify(calls===1
   ?{recent:{goal:'',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:true},proposals:[]}
   :{recent:null})}
  yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity',hostBeforeConsolidation:true,verifyClosure:false})
 expect(calls).toBe(2)
 expect(result.evidence!.dispatches.map(dispatch=>dispatch.phase)).toEqual(['proposal','recent-regeneration'])
 // 补写请求里逐条列着材料事实，模型完全可达；「没有可写近况」这个借口在这种情形下不成立。
 const supplement=JSON.parse(result.evidence!.dispatches[1]!.request!.content)
 expect(supplement.recentFacts.empty).toBe(true)
 expect(supplement.recentFacts.missing).toEqual(['completed','next'])
 expect(result.receipt?.outcome).toBe('applied')
 expect(result.receipt?.reason).toBe('MEMORY_OUTPUT_INVALID')
 expect(result.recent).toEqual([])
})

it('触发只因四段全空、材料里没有对应事实时，recent:null 仍按既有语义收尾',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 // 出处：result-fc33ec2f…json（…/r18/deepseek-flash/1/v6-standing-01）同一份夹具：材料里只有长期要求，
 // 没有已经发生／受阻／尚未决定的事实（判据②不成立，只是四段全空）。这一情形的既有语义不变：
 // 补写回 recent:null 是协议自己的逃生口，按空近况收尾、不保留首轮的拒绝码；长期提议照旧落地。
 let calls=0
 const result=await runMemoryQualityCase({id:'r18-standing-01-null',group:'standing',heldOut:false,
  prompt:'请记住：以后在本库解释先给结论再举一个例子。',
  body:'【虚构质量夹具】所有人物、组织、项目、物品与情境均为虚构，不含真实个人信息。\n我的长期写作偏好是先说结论，再用一个具体例子解释。',
  answer:'以下是未被人采纳的 AI 摘要，仅复述本次材料；不构成新的人的确认。',
  expected:{required:[],forbidden:[],notes:''}},r18Credential,async function*(input){
  calls++
  const payload=r18Case(input),command=r18Command(payload)
  const proposal={action:'add',content:'在本库进行解释时，先给出结论，再举一个具体例子。',scope:'本库范围内的一切解释行为',sourceIds:[command.id],semantic:'standing',attribution:'fiction.md 中的明确长期要求（『请记住：以后在本库解释先给结论再举一个例子。』）',authority:[{sourceId:command.id,quote:'请记住：以后在本库解释先给结论再举一个例子。'}]}
  yield {type:'text',text:JSON.stringify(calls===1
   ?{recent:{goal:'',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:true},proposals:[proposal]}
   :{recent:null})}
  yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity',hostBeforeConsolidation:true,verifyClosure:false})
 expect(calls).toBe(2)
 expect(result.evidence!.dispatches.map(dispatch=>dispatch.phase)).toEqual(['proposal','recent-regeneration'])
 expect(JSON.parse(result.evidence!.dispatches[1]!.request!.content).recentFacts).toMatchObject({empty:true,missing:[],facts:[]})
 expect(result.receipt?.reason).toBeUndefined()
 expect(result.recent).toEqual([])
 expect(result.entries.find(entry=>entry.content==='在本库进行解释时，先给出结论，再举一个具体例子。')).toMatchObject({status:'active',semantic:'standing'})
})

it('补写与改判同时发生：近期缺口由补写通道收口，同一响应里的具体对象提议照旧改判',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 // 6ad6286 的说明里点名了这个空档：补写（recentCompletenessGap／recentSupplementAccepted）与改判
 // （semanticScopeMismatch）都会碰同一批提议，但两条路径此前各有一组测试，从没有一条让它们在同一响应里同时发生。
 // 组合取材都是实测产物，逐字抄录：
 //  · 近期缺口＝r18 `v6-recent-draft-01` r1（result-3fd571f9…json）：goal 有、completed／next 空，
 //    材料里确有「只完成了目录清点」「还没有任何方案决定」——缺口判据因此带 missing 与 facts（不是四段全空）。
 //  · 改判提议＝r16 两轮终态那三条真改判里的第一条（scope 石桥试验项目），standing 但范围指向具体对象。
 // 断言的是组合后的**实际行为**：补写发起并按其验收判据收下、提议改判成 fact／demand、回执与派发里两条痕迹都在，
 // 且顺序上没有"改判先于补写改写 scope"这类串扰。
 let calls=0
 const prompt='整理虚构项目雾港的当前进展，并确认石桥试验项目的检查节奏。'
 const proposalContent='石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。',proposalScope='石桥试验项目'
 const result=await runMemoryQualityCase({id:'r18-recent-draft-01-rescope',group:'fact',heldOut:false,
  prompt,
  body:'【虚构质量夹具】雾港项目目前只完成了目录清点，还没有任何方案决定。石桥试验项目已确认每两周检查一次。',
  answer:'我建议采用方案 B，并把它记作雾港已经确定的方案。',
  expected:{required:[],forbidden:[],notes:''}},r18Credential,async function*(input){
  calls++
  const payload=r18Case(input),command=r18Command(payload)
  const recent=calls===1
   ?{goal:'整理虚构项目雾港的当前进展',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:true}
   :{goal:'整理虚构项目雾港的当前进展',completed:'雾港项目仅完成目录清点',blocked:'',next:'尚未有方案决定',sourceIds:[command.id],assistantDraft:false}
  const proposal={action:'add',content:proposalContent,scope:proposalScope,sourceIds:[command.id],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null,authority:[{sourceId:command.id,quote:prompt}]}
  // 首轮同时给出：会触发补写的 recent ＋ 会被改判的 standing 提议；补写那轮只回 {"recent":…}。
  yield {type:'text',text:JSON.stringify(calls===1?{recent,proposals:[proposal]}:{recent})}
  yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity',hostBeforeConsolidation:true,verifyClosure:false})
 const dispatches=result.evidence!.dispatches,requestIds=(dispatch:any)=>[...dispatch.request.sources].map((source:any)=>source.id).sort()
 // ① 一次响应触发两条路径：首轮 proposal ＋ 恰好一次 recent-regeneration（每例至多 1 次额外调用，没有协议修复插队）。
 expect(calls).toBe(2)
 expect(dispatches.map(dispatch=>dispatch.phase)).toEqual(['proposal','recent-regeneration'])
 // ② 顺序：补写在首轮回答结束之后才发出；改判在补写之后进行，两者不交错，不存在"改判先动 scope／layer，
 //    补写再照着改后的状态取来源"这条路。
 expect(Date.parse(dispatches[1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(dispatches[0]!.finishedAt!))
 // ③ 补写请求是独立单轮：不带 memory（候选／旧提议）、不带 proposals、不带助手回答；来源集合与首轮逐字同一批
 //    （改判没有改写补写的来源面）。
 const supplement=JSON.parse(dispatches[1]!.request!.content)
 expect(supplement.memory).toBeUndefined()
 expect(supplement.proposals).toBeUndefined()
 expect(supplement.recentFacts.missing).toEqual(['completed','next'])
 expect(supplement.recentFacts.facts.length).toBeGreaterThan(0)
 expect(supplement.recentFacts.facts.every((fact:any)=>supplement.sources.some((source:any)=>source.id===fact.sourceId))).toBe(true)
 expect(requestIds(dispatches[1])).toEqual(requestIds(dispatches[0]))
 // ④ 补写按 recentSupplementAccepted 判定收下：缺的两段有了落点、首轮已写对的 goal 逐字保留（recentRetainsWritten），
 //    落库的近期条目来源仍指向本场真实来源。
 const recentRows=result.recent!
 expect(recentRows).toHaveLength(1)
 expect(recentRows[0]!.recent.sections.goal).toBe('整理虚构项目雾港的当前进展')
 expect(recentRows[0]!.recent.sections.completed).toContain('目录清点')
 expect(recentRows[0]!.recent.sections.next).toContain('方案决定')
 expect(recentRows[0]!.sources.length).toBeGreaterThan(0)
 // ⑤ 提议那条被改判成 fact／demand，scope 与 content 逐字不变（改判只换容器，不改范围文本）。
 // entries 里同时含长期条目与近期容器（category='recent'），先只取长期那侧。
 const longTerm=result.entries.filter(entry=>entry.category!=='recent')
 expect(longTerm).toHaveLength(1)
 expect(longTerm[0]).toMatchObject({content:proposalContent,scope:proposalScope,semantic:'fact',layer:'demand',status:'active'})
 // ⑥ 互不串扰：改判的项目事实没有渗进近期容器，近期补写的进展也没有落成长期条目。
 expect(JSON.stringify(recentRows[0]!.recent.sections)).not.toContain(proposalContent)
 expect(JSON.stringify(recentRows[0]!.recent.sections)).not.toContain(proposalScope)
 expect(longTerm.some(entry=>entry.content.includes('目录清点'))).toBe(false)
 // ⑦ 回执与派发里两条痕迹都在：改判记 MEMORY_SEMANTIC_RESCOPED（applied，不拒绝、不丢条目）；补写按合规收下，
 //    因此整批没有留下任何 MEMORY_OUTPUT_INVALID。
 expect(result.receipt?.outcome).toBe('applied')
 expect(result.receipt?.results).toContainEqual({action:'add',outcome:'applied',code:'MEMORY_SEMANTIC_RESCOPED'})
 expect(result.receipt?.reason).toBe('MEMORY_SEMANTIC_RESCOPED')
 expect(result.receipt?.results?.some((row:any)=>row.code==='MEMORY_OUTPUT_INVALID')).toBe(false)
})

it('同一条组合里补写不被接受：拒绝码优先于改判注记，reason 保留 MEMORY_OUTPUT_INVALID 且改判照旧落地',async()=>{
 const {runMemoryQualityCase}=await import('../../scripts/memory-quality-runner.ts')
 // 组合的另一半：首轮 recent 四段全空（材料里却确有进展与未决），standing 提议照旧指向具体对象。
 // 补写那一轮回协议自己的逃生口 recent:null——触发原因是「材料确有事实却没落点」，不是「没有可写近况」，
 // 所以 recentSupplementAccepted 判 false，近期容器不落库（与既有测试「材料里确有事实却没落点时，
 // 补写回答 recent:null 不被接受，原拒绝码照旧保留」同一情形）。改判与补写互不依赖，照旧落地。
 // 本条原先由另一位写者留下，如实记录了一处**回执归因串扰**：reason 取 dropped[0]，而改判的 applied 注记
 // 最先入 dropped，于是补写失败该保留的拒绝码被它占住（同一组合里没有改判时该码是保留的，见上一条与
 //「四段全空的 recent 被拒，但同一条回答里的有效提议照样落地」）。本轮（2026-10-15）修正成
 //「拒绝码优先、applied 注记码垫底」：近期容器没落库这条拒绝排在 applied 注记之前，不再被挤掉。
 // 下面的断言记录**修正后**的行为；两条痕迹都要能观察到，不许二选一——reason 上是拒绝码，
 // results 里改判的 applied 记录仍在（改判照旧落地、不丢条目这一半没有变）。
 let calls=0
 const prompt='整理虚构项目雾港的当前进展，并确认石桥试验项目的检查节奏。'
 const proposalContent='石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。'
 const result=await runMemoryQualityCase({id:'r18-recent-draft-01-rescope-unfilled',group:'fact',heldOut:false,
  prompt,
  body:'【虚构质量夹具】雾港项目目前只完成了目录清点，还没有任何方案决定。石桥试验项目已确认每两周检查一次。',
  answer:'我建议采用方案 B，并把它记作雾港已经确定的方案。',
  expected:{required:[],forbidden:[],notes:''}},r18Credential,async function*(input){
  calls++
  const payload=r18Case(input),command=r18Command(payload)
  const fourEmpty={goal:'',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:true}
  const proposal={action:'add',content:proposalContent,scope:'石桥试验项目',sourceIds:[command.id],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null,authority:[{sourceId:command.id,quote:prompt}]}
  yield {type:'text',text:JSON.stringify(calls===1?{recent:fourEmpty,proposals:[proposal]}:{recent:null})}
  yield {type:'finish',reason:'stop'}
 },new AbortController().signal,{strategy:'continuity',hostBeforeConsolidation:true,verifyClosure:false})
 expect(calls).toBe(2)
 expect(result.evidence!.dispatches.map(dispatch=>dispatch.phase)).toEqual(['proposal','recent-regeneration'])
 expect(JSON.parse(result.evidence!.dispatches[1]!.request!.content).recentFacts).toMatchObject({empty:true,missing:['completed','next']})
 expect(result.recent).toEqual([])                                     // 缺口没有落点，不静默接受
 const longTerm=result.entries.filter(entry=>entry.category!=='recent')
 expect(longTerm).toHaveLength(1)                                      // 改判照旧落地，不因补写失败丢条目
 expect(longTerm[0]).toMatchObject({content:proposalContent,semantic:'fact',layer:'demand'})
 expect(result.receipt?.outcome).toBe('applied')
 expect(result.receipt?.results).toContainEqual({action:'add',outcome:'applied',code:'MEMORY_SEMANTIC_RESCOPED'})
 expect(result.receipt?.reason).toBe('MEMORY_OUTPUT_INVALID')          // 修正：拒绝码优先，不再被改判的 applied 注记占住
 // 该拒绝码由 reason 承载：近期容器的终态判定不是 dropped 里的分组结果，所以 results 里没有也不该有一条
 // MEMORY_OUTPUT_INVALID 行。这条断言防的是「往 dropped 塞一条合成拒绝行」那种改法——归因只改取值优先级。
 expect(result.receipt?.results?.some((row:any)=>row.code==='MEMORY_OUTPUT_INVALID')).toBe(false)
})

it('纯改判、本批没有任何拒绝时，reason 仍是 applied 注记码 MEMORY_SEMANTIC_RESCOPED（防回归）',async()=>{
 // 修正「拒绝码优先」时最容易回归的一侧：applied 注记必须仍然可达。本批只有一条改判（applied 注记），
 // 近期块一次就写成合法的非空对象（既不是四段全空、也没有触发补写通道），因此一条拒绝码都没有——
 // reason 必须仍回落到改判的 MEMORY_SEMANTIC_RESCOPED，而不是被尾部那条「近期容器没落库」的
 // MEMORY_OUTPUT_INVALID 兜底抢走。改判本身照旧只换容器：semantic 变 fact、layer 随语义走，scope 与 content 逐字不变。
 let calls=0
 const content='石桥试验项目已采用双周检查节奏（每两周检查一次，不是每周）。'
 const f=await fixture(async function*(input){
  calls++
  const p=JSON.parse(String(input.messages[0]!.content)),command=p.sources[0]
  yield {type:'text',text:JSON.stringify({recent:{goal:'整理石桥试验项目的检查节奏',completed:'',blocked:'',next:'',sourceIds:[command.id],assistantDraft:false},
   proposals:[{action:'add',content,scope:'石桥试验项目',sourceIds:[command.id],semantic:'standing',attribution:'人在本场口令中要求',reviewAt:null,authority:[{sourceId:command.id,quote:String(command.text).slice(0,4)}]}]})}
  yield {type:'finish',reason:'stop'}},'整理石桥试验项目已确认的检查节奏。','continuity')
 await f.engine.handoff(f.material);await f.engine.idle()
 const record=f.service.snapshot().record,job=record.jobs[0]
 expect(calls).toBe(1)                                                // 没有补写、没有修复：本批不存在拒绝码
 const longTerm=record.entries.filter(entry=>entry.category!=='recent')
 expect(longTerm).toHaveLength(1)
 expect(longTerm[0]).toMatchObject({content,scope:'石桥试验项目',semantic:'fact',layer:'demand',status:'active'})
 expect(record.recent).toHaveLength(1)                                // 近期块正常落库
 expect(job?.results).toContainEqual({action:'add',outcome:'applied',code:'MEMORY_SEMANTIC_RESCOPED'})
 expect(job?.results?.some(result=>result.outcome!=='applied')).toBe(false)
 expect(job?.reason).toBe('MEMORY_SEMANTIC_RESCOPED')
})

it('标定近期容器缺口判据：只有真的没有落点的工作状态事实才算缺口',()=>{
 // 数据来源：.cache/memory-quality/2026-10-14-rev18/result-*.json 的 proposal 请求与回答（只读）。
 // 下表是 r18 两轮里「材料写了工作状态、对应段为空」的 9 个案例轮，material 与 recent 四段逐字取自产物。
 // 命中 13 处，其中只有 3 处真的没有落点（draft-01 r1 的进展与未决、blocked-01 r0 的未决）；
 // 其余 10 处的事实已经落在别的段落里（判据：与四段合并文本的共同特征词 ≥2，与孪生判据同门槛），
 // 不该再花一次调用——r18 实测里这些案例本身都是满分（例如 draft-01 r0 把「还没有任何方案决定」写进 blocked）。
 const rows=[
  {id:'v6-ambiguous-01 r0',texts:['石桥项目检查节奏可能要变成每周，还没定；帮我整理待确认问题。','【虚构质量夹具】所有人物、组织、项目、物品与情境均为虚构，不含真实个人信息。\n石桥仍有双周已确认安排；听说可能改每周，尚无决议。'],recent:{goal:'整理石桥项目检查节奏相关的待确认问题',completed:'',blocked:'石桥检查节奏是否从每两周改为每周尚无决议，仍待确认',next:''},missing:null},
  {id:'v6-recent-cross-note-01 r0',texts:['接着另一篇记录的进度继续。','【虚构质量夹具】另一篇《银桥记录》已确认甲批样稿通过；本篇继续乙批的目录检查，乙批尚未送审。'],recent:{goal:'继续乙批的目录检查',completed:'《银桥记录》已确认甲批样稿通过',blocked:'乙批尚未送审',next:''},missing:null},
  {id:'v6-recent-cross-note-01 r1',texts:['接着另一篇记录的进度继续。','【虚构质量夹具】另一篇《银桥记录》已确认甲批样稿通过；本篇继续乙批的目录检查，乙批尚未送审。'],recent:{goal:'继续乙批的目录检查',completed:'《银桥记录》甲批样稿已确认通过',blocked:'乙批尚未送审',next:''},missing:null},
  {id:'v6-recent-progress-01 r0',texts:['继续虚构项目青灯的核对工作。','【虚构质量夹具】青灯项目本轮目标是核对五份样稿；已完成第 1、2 份的目录检查；第 3 份尚未开始。'],recent:{goal:'核对虚构项目青灯的五份样稿',completed:'已完成第 1、2 份样稿的目录检查',blocked:'第 3 份样稿尚未开始',next:''},missing:null},
  {id:'v6-recent-draft-01 r0',texts:['整理虚构项目雾港的当前进展。','【虚构质量夹具】雾港项目目前只完成了目录清点，还没有任何方案决定。'],recent:{goal:'整理虚构项目雾港的当前进展',completed:'雾港项目已完成目录清点',blocked:'雾港项目还没有任何方案决定',next:''},missing:null},
  {id:'v6-recent-draft-01 r1',texts:['整理虚构项目雾港的当前进展。','【虚构质量夹具】雾港项目目前只完成了目录清点，还没有任何方案决定。'],recent:{goal:'整理虚构项目雾港的当前进展',completed:'',blocked:'',next:''},missing:['completed','next']},
  {id:'v6-chain-beta-4 r0',texts:['听说银桥可能改成 B 方案，还没定。','【虚构质量夹具】A 方案仍是已确认决定；B 方案只是传闻，没有新决定。'],recent:{goal:'',completed:'已记录银桥可能改成 B 方案的传闻，该传闻尚未决定。',blocked:'',next:''},missing:null},
  {id:'v6-chain-beta-4 r1',texts:['听说银桥可能改成 B 方案，还没定。','【虚构质量夹具】A 方案仍是已确认决定；B 方案只是传闻，没有新决定。'],recent:{goal:'核对银桥方案变更传闻，确认 A 方案是否仍为已确认决定',completed:'已确认 A 方案仍是已确认决定；B 方案只是传闻，没有新决定',blocked:'',next:''},missing:null},
  {id:'v6-recent-blocked-01 r0',texts:['继续虚构项目银桥的样稿核对。','【虚构质量夹具】银桥项目目标是核对三份样稿；已完成第 1 份；第 2 份受阻于待确认的版本号；版本号未定之前不开始第 3 份。'],recent:{goal:'继续虚构项目银桥的样稿核对，目标是核对三份样稿。',completed:'已完成第 1 份样稿核对。',blocked:'第 2 份样稿受阻于待确认的版本号。',next:''},missing:['next']}
 ] as const
 for(const row of rows){
  const gap=recentCompletenessGap(row.recent,row.texts.map((text,index)=>({id:'s'+(index+1),text})))
  expect(gap?gap.missing:null,row.id).toEqual(row.missing)
  if(gap)expect(gap.empty,row.id).toBe(false)
 }
 // 四段全空一律算缺口（与材料有没有事实无关）；recent:null 与已经完整的四段都不算缺口。
 const empty={goal:'',completed:'',blocked:'',next:''}
 expect(recentCompletenessGap(empty,[{id:'s1',text:'以后用中文'}])).toMatchObject({empty:true,missing:[],facts:[]})
 expect(recentCompletenessGap(null,[{id:'s1',text:'已完成第 1 份'}])).toBeUndefined()
 expect(recentCompletenessGap({goal:'继续核对',completed:'已完成第 1 份',blocked:'',next:''},[{id:'s1',text:'已完成第 1 份；第 2 份受阻于版本号。'}])).toMatchObject({empty:false,missing:['blocked']})
 // 补写值不得丢掉模型已经写对的段落（只比空与非空）；四段全空时这条恒真，所以 recent:null 也能收尾。
 expect(recentRetainsWritten(empty,null)).toBe(true)
 expect(recentRetainsWritten({goal:'整理雾港进展',completed:'',blocked:'',next:''},null)).toBe(false)
 expect(recentRetainsWritten({goal:'整理雾港进展',completed:'',blocked:'',next:''},{goal:'',completed:'仅完成目录清点',blocked:'',next:'尚未决定'})).toBe(false)
 expect(recentRetainsWritten({goal:'整理雾港进展',completed:'',blocked:'',next:''},{goal:'整理雾港当前进展',completed:'仅完成目录清点',blocked:'',next:'尚未决定'})).toBe(true)
 // 补写验收（机检三条件）：①是对象；②原缺口涉及的段落非空；③不把既有非空段落写空。
 // 材料里确有事实却没落点时，recent:null 不算 ok（事实仍没有落点）；只填一半也不算。
 const factsGap=recentCompletenessGap(empty,[{id:'s1',text:'雾港项目目前只完成了目录清点，还没有任何方案决定。'}])!
 expect(factsGap.missing).toEqual(['completed','next'])
 expect(recentSupplementAccepted(empty,factsGap,null)).toBe(false)
 expect(recentSupplementAccepted(empty,factsGap,{goal:'整理雾港当前进展',completed:'',blocked:'',next:'',sourceIds:['s1'],assistantDraft:false})).toBe(false)
 expect(recentSupplementAccepted(empty,factsGap,{goal:'整理雾港当前进展',completed:'雾港项目仅完成目录清点',blocked:'',next:'尚未决定',sourceIds:['s1'],assistantDraft:false})).toBe(true)
 // 只因四段全空、材料里没有对应事实（missing 为空）时保持既有语义：recent:null 仍可收尾。
 const emptyGap=recentCompletenessGap(empty,[{id:'s1',text:'以后用中文'}])!
 expect(emptyGap.missing).toEqual([])
 expect(recentSupplementAccepted(empty,emptyGap,null)).toBe(true)
})

it('续写提示词把「已经发生／明确受阻／尚未决定」的落点写死',()=>{
 // 只加一句：口径不动，补写才是程序侧的兜底；这句原文防它漂回去。
 expect(memoryContinuitySystem).toContain('材料里已经发生、明确受阻、尚未决定的事，必须分别落进 completed／blocked／next；四段都空一律视为未完成。')
})

// ── 依赖连坐范围（B1 附带项）：判定为设计意图，不改行为，只把同簇连带暂停钉住 ────────────────────────
// r18 佐证：`…/0/v6-chain-alpha-4` 与 `…/1/v6-chain-alpha-4` 的终态——step-1 的 standing 条目被更正后，
// step-2 的事实条目（round 1 是 `b44eec2b` 青灯五份样稿）与 step-2／3 的近期容器一并 `paused`
//（`reason=MEMORY_DEPENDENCY_CHANGED`、`state.source=revoked`），份数事实与记录顺序约定并无内容关系。
// 依据（不改行为）：① `inheritInputs` 只把**本次请求实际展示过**的候选记成依赖，库层其余条目不算
//（既有夹具「inherits only the material, cited-source and replaced-entry dependencies」与
//「retains only actually displayed background candidate dependencies…」就是这个粒度）；
// ② `advanceVersion` 明写「被改写的依赖方按依赖已变暂停并可复核恢复，不是来源变更」——收窄依赖声明
// 等于放宽暂停语义，正是本包不许动的那条；③ r18 产物本身把它记为「产品行为，不记否决」。
it('一次更正连带暂停声明了它的依赖簇，未声明该依赖的已确认条目不受牵连',async()=>{
 let phase=1
 const f=await fixture(async function*(input){
  const p=JSON.parse(String(input.messages[0]!.content)),command=p.sources.find((s:any)=>s.classification==='command'&&s.kind==='ledger')??p.sources[0]
  if(phase===1){
   // 第 1 场：新增一条项目事实 + 一个近期容器，两者都继承本场实际展示过的候选依赖。
   yield {type:'text',text:JSON.stringify({recent:{goal:'记录青灯项目本轮样稿数量',completed:'已清点确认五份样稿',blocked:'',next:'',sourceIds:[command.id],assistantDraft:false},proposals:[{action:'add',content:'青灯项目本轮共五份样稿',scope:'青灯项目',sourceIds:[command.id],semantic:'fact',attribution:'人的口令',reviewAt:null}]})}
  }else{
   const target=p.memory.find((e:any)=>e.content==='青灯项目版本为甲')
   yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'correct',target:target.id,content:'青灯项目版本明确更正为乙',scope:'青灯项目',sourceIds:[command.id],semantic:'fact',attribution:'人的明确更正',reviewAt:null}]})}
  }
  yield {type:'finish',reason:'stop'}
 },'青灯项目版本为甲','continuity')
 const parentSource=await f.service.sourceForPrompt('a.md','task')
 const parent=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'青灯项目版本为甲',layer:'demand',scope:'青灯项目',sources:[parentSource],semantic:'fact',attribution:'人',reviewAt:null},true))
 const unrelated=await f.vault.memoryMutation(store=>store.add(store.read(),{content:'无关主题的会议记录',layer:'demand',scope:'别处',sources:[parentSource],semantic:'fact',attribution:'人',reviewAt:null},true))
 await f.engine.handoff(f.material);await f.engine.idle()
 const first=f.service.snapshot().record,cluster=first.entries.find(e=>e.content==='青灯项目本轮共五份样稿')!,background=first.recent.find(e=>e.recent.taskId==='task')!
 // 粒度：只有本场展示过的候选（parent）被记成依赖，于是这条事实与这个近期容器属于同一依赖簇。
 expect(cluster.sources.flatMap(s=>s.memoryDeps)).toContainEqual({id:parent.id,version:1})
 expect(background.sources.flatMap(s=>s.memoryDeps)).toContainEqual({id:parent.id,version:1})
 // 第 2 场：只更正 parent。
 const taskId='task-correct',prompt='青灯项目版本明确更正为乙'
 let note=await f.vault.read('a.md')
 const start=note.content.length+1,marked=markPrompt(note.content+'\n/'+prompt,{taskId,range:{start,end:start+prompt.length+1},expectedText:'/'+prompt,promptText:prompt})
 await f.vault.write('a.md',marked,note.revision,note);note=await f.vault.read('a.md')
 f.engine.capture(taskId)
 await f.vault.ledgerPrepare('a.md',{taskId,startedAt:new Date().toISOString(),status:'completed',prompt,answer:'好的'})
 const written=await f.vault.write('a.md',upsertAiAnswer(note.content,{taskId,answer:'好的'}),note.revision,note)
 await f.vault.ledgerComplete('a.md',taskId,written.revision)
 phase=2
 await f.engine.handoff(await f.service.savedMaterial('a.md',taskId));await f.engine.idle()
 const record=f.service.snapshot().record,corrected=record.entries.find(e=>e.id===parent.id)!
 expect(corrected).toMatchObject({version:2,status:'active',content:'青灯项目版本明确更正为乙'})
 // 同簇连带暂停：事实条目与近期容器一起暂停、来源标记为已撤销；依赖版本同时改写到新版本，不再是悬空引用。
 const pausedCluster=record.entries.find(e=>e.id===cluster.id)!
 expect(pausedCluster).toMatchObject({version:1,status:'paused',reason:'MEMORY_DEPENDENCY_CHANGED',state:{source:'revoked'}})
 expect(pausedCluster.sources.flatMap(s=>s.memoryDeps)).toContainEqual({id:parent.id,version:2})
 expect(record.recent.find(e=>e.id===background.id)).toMatchObject({status:'paused',reason:'MEMORY_DEPENDENCY_CHANGED'})
 // 范围外的已确认事实没有被牵连：它从未声明该依赖，就照旧 active。
 expect(record.entries.find(e=>e.id===unrelated.id)).toMatchObject({version:1,status:'active'})
 // 暂停可复核恢复（不放宽、也不锁死）：清掉依赖暂停后条目回到 active。
 const {parseWorkingMemory,applyMemoryRecovery}=await import('../../src/main/working-memory-store.ts')
 const file=path.join(f.vault.requireUsableRoot(),'.rgent-memory'),recovered=parseWorkingMemory(applyMemoryRecovery(await readFile(file,'utf8'),[{id:cluster.id,version:cluster.version,pause:false,sources:[]}]))
 expect(recovered.entries.find(e=>e.id===cluster.id)).toMatchObject({status:'active',reason:null,state:{source:'verified'}})
})

import { mkdtemp, mkdir, writeFile, rm, readFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { createModelConfigStore, type ModelCredential } from '../../src/main/model-config.ts'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
import { ledgerChapters } from '../../src/main/host-context.ts'
import { compile } from '../../src/markdown/index.ts'
import { memoryHash } from '../../src/main/memory-source.ts'
import { AgentHost } from '../../src/main/agent-host.ts'
import { bodyFingerprint } from '../../src/main/ledger-provenance.ts'
import { memoryDependency } from '../../src/main/memory-use.ts'
import { MemoryConsolidationService } from '../../src/main/memory-consolidation.ts'
import type { SavedTaskMaterial } from '../../src/main/host-material.ts'
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async original => ({ ...await original<typeof import('../../src/main/watch.ts')>(), watchVault: vi.fn(() => () => {}) }))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); vi.restoreAllMocks() })
const credential: ModelCredential = {provider:'custom',baseURL:'https://example.com/v1',modelId:'memory',contextTokens:64000,apiKey:'secret'}
async function setup(prompt = '请长期记住：我的母语是中文。') {
 const data=await mkdtemp(path.join(os.tmpdir(),'rgent-consolidation-')),root=path.join(data,'vault');await mkdir(root)
 await writeFile(path.join(data,'vault.json'),JSON.stringify({path:root}))
 const taskId='task-one',content=appendLedgerChapter('普通正文。\n',{taskId,prompt,answer:'好的。',status:'completed',model:'test',startedAt:'2026-10-02T00:00:00Z',finishedAt:'2026-10-02T00:00:01Z',reasoning:'不能保存的推理',tools:[] } as any)
 await writeFile(path.join(root,'note.md'),content)
 const config=createModelConfigStore(data,{isEncryptionAvailable:()=>true,encryptString:Buffer.from,decryptString:b=>b.toString()})
 const vault=new VaultSession(data,vi.fn(),undefined,config.memoryStoragePins());vault.restore()
 const store=vault.memory(),note=await vault.read('note.md'),chapter=ledgerChapters(compile(content).partition.ledger)[0]!
 const material:SavedTaskMaterial={taskId,context:vault.memoryContext(),origin:{relPath:'note.md',...note},status:'completed',prompt,answer:'好的。',ledgerHash:memoryHash(chapter.text.trimEnd()),materialVersion:memoryHash(taskId+prompt),material:{fragments:[],truncated:false},sourceDeps:[],memoryDeps:[]}
 let enabled=true,epoch=0,modelAvailable=true
 const limits={seconds:120,calls:2,tools:0};let clock=Date.now();const selected={...credential}
 const stream=vi.fn(async function* (input:any) { const payload=JSON.parse(input.prompt); yield {type:'text' as const,text:JSON.stringify({proposals:[{action:'add',content:'母语中文',layer:'core',scope:'本库',category:'lasting',citations:[payload.sources[0].id],target:null}]})}; yield {type:'finish' as const,reason:'stop'} })
 const service=new MemoryConsolidationService({context:()=>vault.memoryContext(),config:()=>({enabled,epoch,limits}),credential:()=>{if(!modelAvailable)throw Error('MEMORY_MODEL_UNAVAILABLE');return selected},now:()=>clock,store:()=>vault.memory(),stream})
 cleanup.push(async()=>{await service.close();vault.dispose();await rm(data,{recursive:true,force:true})})
 return {root,data,vault,store,service,material,stream,limits,selected,tick:(ms:number)=>{clock+=ms},off:()=>{enabled=false;epoch++},on:()=>{enabled=true;epoch++},invalidModel:()=>{modelAvailable=false}}
}
async function run(env:Awaited<ReturnType<typeof setup>>) {env.service.start(env.material.taskId);await env.service.saved(env.material);await env.service.idle()}
async function another(e:Awaited<ReturnType<typeof setup>>,taskId:string,prompt=e.material.prompt){
 const n=await e.vault.read('note.md'),content=appendLedgerChapter(n.content,{taskId,startedAt:'now',status:'completed',prompt,answer:'好的。'})
 await e.vault.write('note.md',content,n.revision,n);const saved=await e.vault.read('note.md')
 return {...e.material,taskId,prompt,origin:{relPath:'note.md',...saved},materialVersion:memoryHash(taskId+prompt),ledgerHash:memoryHash(ledgerChapters(compile(content).partition.ledger).find(c=>c.taskId===taskId)!.text.trimEnd())}
}
describe('independent memory consolidation',()=>{
 it('commits one lasting request once, records result and never persists reasoning or credentials',async()=>{const e=await setup();await run(e);await e.service.saved(e.material);await e.service.idle();expect(e.stream).toHaveBeenCalledTimes(1);expect((await e.store.validatedEntries()).map(x=>x.content)).toEqual(['母语中文']);const raw=await readFile(path.join(e.root,'.rgent-memory'),'utf8');expect(raw).not.toContain('不能保存的推理');expect(raw).not.toContain('secret');expect((await e.store.snapshot()).record.jobs[0]?.outcome).toBe('applied')})
 it.each(['这一次请用中文回答。','也许我的母语是中文。'])('rejects temporary or unconfirmed human material: %s',async(prompt)=>{const e=await setup(prompt);await run(e);expect((await e.store.snapshot()).record.entries).toEqual([])})
 it('does not turn a model claim of human identity into an eligible citation',async()=>{const e=await setup();e.stream.mockImplementation(async function*(){yield {type:'text',text:JSON.stringify({proposals:[{action:'add',content:'guess',layer:'core',scope:'本库',category:'confirmed',citations:['ai-answer'],target:null}]})};yield {type:'finish',reason:'stop'}});await run(e);expect((await e.store.snapshot()).record.jobs[0]?.outcome).toBe('rejected')})
 it('OFF then ON permanently revokes the start permit and does not backfill',async()=>{const e=await setup();e.service.start(e.material.taskId);e.off();e.on();await e.service.saved(e.material);await e.service.idle();expect(e.stream).not.toHaveBeenCalled();expect(e.service.results()[0]?.reason).toContain('PERMISSION')})
 it('missing memory model affects accumulation only',async()=>{const e=await setup();e.invalidModel();expect(()=>e.service.start(e.material.taskId)).not.toThrow();await e.service.saved(e.material);expect(e.stream).not.toHaveBeenCalled();expect(e.service.results()[0]?.reason).toContain('MODEL')})
 it('continues queued sources across controlled saves, rejects an external same-byte replacement',async()=>{const e=await setup();let release!:()=>void;const wait=new Promise<void>(r=>release=r);e.stream.mockImplementation(async function*(input:any){await wait;const p=JSON.parse(input.prompt);yield {type:'text',text:JSON.stringify({proposals:[{action:'add',content:'母语中文',layer:'core',scope:'本库',category:'lasting',citations:[p.sources[0].id],target:null}]})};yield {type:'finish',reason:'stop'}});e.service.start(e.material.taskId);await e.service.saved(e.material);await vi.waitFor(()=>expect(e.stream).toHaveBeenCalledTimes(1));const n=await e.vault.read('note.md');await e.vault.write('note.md','无关。\n\n'+n.content,n.revision,n);release();await e.service.idle();expect((await e.store.validatedEntries()).length).toBe(1)
 const other=await setup();other.service.start(other.material.taskId);const raw=await readFile(path.join(other.root,'note.md'));await rename(path.join(other.root,'note.md'),path.join(other.root,'held.md'));await writeFile(path.join(other.root,'note.md'),raw);await other.service.saved(other.material);await other.service.idle();expect(other.stream).not.toHaveBeenCalled()})
 it('rejects unknown action/path fields and model tool calls',async()=>{const e=await setup();e.stream.mockImplementation(async function*(){yield {type:'text',text:'{"proposals":[{"action":"delete","path":"../outside"}]}'};yield {type:'finish',reason:'stop'}});await run(e);expect((await e.store.snapshot()).record.jobs[0]?.outcome).toBe('rejected')})
 it('Host starts the independent permit before dispatch; failed ledger waits for one successful retry and next task does not await the model',async()=>{
  const e=await setup(),prompt='请长期记住：我的母语是中文。',line='/'+prompt
  const note=await e.vault.read('note.md');await e.vault.write('note.md',line+'\n\n'+note.content,note.revision,note)
  let fail=true,release!:()=>void;const blocked=new Promise<void>(r=>release=r)
  const original=e.stream.getMockImplementation()!;e.stream.mockImplementation(async function*(input:any){await blocked;yield* original(input)})
  const starts:string[]=[],sentPrompts:string[]=[]
  const host=new AgentHost({root:()=>e.root,session:()=>e.vault.sessionId(),acceptsObject:(p,a,b)=>e.vault.acceptsObject(p,a,b),read:p=>e.vault.read(p),write:async(p,c,r,b)=>{if(fail&&c.match(/rgent:ledger-task:v1/g)?.length===2)throw Error('DISK_FULL');return e.vault.write(p,c,r,b!)},tier:async()=> 'reference',credential:()=>credential,limits:()=>({seconds:30,steps:2,tools:0}),stream:async function*(input){sentPrompts.push(input.prompt);expect(starts.length).toBeGreaterThanOrEqual(1);yield starts.length===1?prompt:'第二场已答。'},memory:{context:()=>e.vault.memoryContext(),config:()=>({enabled:true,epoch:0}),entries:ids=>e.store.validatedEntries(ids)},onTaskStarted:id=>{starts.push(id);e.service.start(id)},onTaskMaterialSaved:m=>e.service.saved(m),onTaskMaterialResult:r=>e.service.handoff(r),emit:()=>{}})
  const task=await host.start({relPath:'note.md',range:{start:0,end:line.length},expectedText:line,promptText:prompt})
  await expect(task.done).rejects.toThrow('DISK_FULL');expect(e.stream).not.toHaveBeenCalled();fail=false
  await Promise.all([host.retryPending(),host.retryPending()]);await vi.waitFor(()=>expect(e.stream).toHaveBeenCalledTimes(1));expect(host.hasPending()).toBe(false)
  // Foreground has completely settled while the background model is still unresolved.
  expect(host.active()).toEqual([])
  const nextNote=await e.vault.read('note.md'),nextLine='/第二场';await e.vault.write('note.md',nextLine+'\n\n'+nextNote.content,nextNote.revision,nextNote)
  const next=await host.start({relPath:'note.md',range:{start:0,end:nextLine.length},expectedText:nextLine,promptText:'第二场'});await next.done;expect(starts).toHaveLength(2);expect(sentPrompts[1]).not.toContain('记忆 core');expect(e.stream).toHaveBeenCalledTimes(1);expect((await e.store.snapshot()).record.entries).toEqual([])
  release();await e.service.idle();expect((await e.store.snapshot()).record.jobs.filter(j=>j.taskId===task.id)).toHaveLength(1)
 })
 it('forgets queued copies and permanently blocks the old dependency even after retry',async()=>{
  const e=await setup();await run(e);const entry=(await e.store.validatedEntries())[0]!
  const copy={...e.material,taskId:'second',materialVersion:memoryHash('second'),memoryDeps:[memoryDependency(entry)]}
  const n=await e.vault.read('note.md');const content=appendLedgerChapter(n.content,{taskId:'second',startedAt:'now',status:'completed',prompt:e.material.prompt,answer:'好的。'});await e.vault.write('note.md',content,n.revision,n)
  const saved=await e.vault.read('note.md');copy.origin={relPath:'note.md',...saved};copy.ledgerHash=memoryHash(ledgerChapters(compile(content).partition.ledger).find(c=>c.taskId==='second')!.text.trimEnd())
  let release!:()=>void;const wait=new Promise<void>(r=>release=r),original=e.stream.getMockImplementation()!;e.stream.mockImplementation(async function*(input:any){await wait;yield* original(input)})
  e.service.start('second');await e.service.saved(copy);await vi.waitFor(()=>expect(e.stream).toHaveBeenCalledTimes(2));await e.store.forget(await e.store.snapshot(),entry.id,entry.version);await e.service.recheck();release();await e.service.idle()
  const raw=await readFile(path.join(e.root,'.rgent-memory'),'utf8');expect(raw).not.toContain('母语中文');expect(raw).not.toContain('我的母语是中文');expect((await e.store.snapshot()).record.entries).toEqual([])
  await e.service.retry('second',copy.materialVersion);await e.service.idle();expect(e.stream).toHaveBeenCalledTimes(2)
 })
 it('manual edits win against late correction, ambiguous conflicts keep the old active entry',async()=>{
  const e=await setup();await run(e);const entry=(await e.store.validatedEntries())[0]!
  const material=await e.store.captureTaskMaterial({...e.material,memoryDeps:[memoryDependency(entry)]})
  const target={id:entry.id,version:entry.version},proposal={action:'update' as const,content:'母语英文',layer:'core' as const,scope:'本库',category:'ambiguous' as const,citations:[material.sources[0]!.id],target}
  const version=memoryHash('ambiguous');await e.store.enqueueJob('ambiguous',version,material,()=>{});await e.store.jobOutcome('ambiguous',version,'running');await e.store.applyJob('ambiguous',version,[proposal],()=>{})
  const entries=(await e.store.snapshot()).record.entries;expect(entries.find(x=>x.id===entry.id)).toMatchObject({version:1,status:'active',content:'母语中文'});expect(entries.find(x=>x.status==='pending')?.pendingTarget).toEqual(target)
  const late=memoryHash('late');await e.store.enqueueJob('late',late,material,()=>{});await e.store.jobOutcome('late',late,'running');await e.store.edit(await e.store.snapshot(),entry.id,1,{content:'人工修订'})
  await expect(e.store.applyJob('late',late,[proposal],()=>{})).rejects.toThrow('MEMORY_DEPENDENCY_CHANGED');expect((await e.store.snapshot()).record.entries.find(x=>x.id===entry.id)?.content).toBe('人工修订')
 })
 it('restart marks old jobs interrupted without network, explicit retry obtains a fresh bounded permit',async()=>{
  const e=await setup(),material=await e.store.captureTaskMaterial(e.material)
  await e.store.enqueueJob(e.material.taskId,e.material.materialVersion,material,()=>{});const n=await e.vault.read('note.md');await e.vault.write('note.md','无关前缀。\n\n'+n.content,n.revision,n);e.vault.restore();const fresh=e.vault.memory();await e.service.restore();expect((await fresh.snapshot()).record.jobs[0]?.outcome).toBe('interrupted');expect(e.stream).not.toHaveBeenCalled()
  await e.service.retry(e.material.taskId,e.material.materialVersion);await e.service.idle();expect(e.stream).toHaveBeenCalledTimes(1);expect((await fresh.snapshot()).record.jobs[0]?.outcome).toBe('applied')
 })

 it('bounds the single-vault queue at sixteen, cancels an uncooperative model and starts no late queued work',async()=>{
  const e=await setup();e.stream.mockImplementation(async function*(){await new Promise(()=>{});yield {type:'finish',reason:'stop'}})
  e.service.start(e.material.taskId);await e.service.saved(e.material);await vi.waitFor(()=>expect(e.stream).toHaveBeenCalledTimes(1))
  for(let i=0;i<17;i++){const m=await another(e,'queued-'+i);e.service.start(m.taskId);await e.service.saved(m)}
  expect(e.stream).toHaveBeenCalledTimes(1);expect(e.service.results().find(r=>r.taskId==='queued-16')?.reason).toBe('MEMORY_QUEUE_FULL')
  e.off();await e.service.recheck();await e.service.idle();expect(e.stream).toHaveBeenCalledTimes(1);expect((await e.store.snapshot()).record.jobs.every(j=>j.outcome==='rejected')).toBe(true)
 })
 it.each([['MEMORY_OUTPUT_TOKEN_LIMIT',5000],['MEMORY_OUTPUT_LIMIT',33000]] as const)('checks %s independently',async(reason,size)=>{const e=await setup();e.stream.mockImplementation(async function*(){yield {type:'text',text:'x'.repeat(size)};yield {type:'finish',reason:'stop'}});await run(e);expect(e.service.results()[0]?.reason).toBe(reason)})
 it('the enqueue deadline and model capacity are independent of foreground budgets',async()=>{
  const e=await setup();e.limits.seconds=1;e.stream.mockImplementation(async function*(){await new Promise(()=>{});yield {type:'finish',reason:'stop'}});e.service.start(e.material.taskId);await e.service.saved(e.material);await vi.waitFor(()=>expect(e.stream).toHaveBeenCalledTimes(1));e.tick(1001);await e.service.recheck();await e.service.idle();expect(e.service.results()[0]?.reason).toBe('MEMORY_DEADLINE')
  const small=await setup();small.selected.contextTokens=4500;await run(small);expect(small.stream).not.toHaveBeenCalled();expect(small.service.results()[0]?.reason).toBe('MEMORY_MODEL_CAPACITY')
 })
 it('keeps the role receiver and limits fixed at start, and sends no tool definitions',async()=>{const e=await setup();e.service.start(e.material.taskId);e.selected.modelId='different';e.selected.apiKey='different';e.limits.calls=0;await e.service.saved(e.material);await e.service.idle();expect(e.stream.mock.calls[0]?.[0]).toMatchObject({modelId:'memory',apiKey:'secret',maxOutputTokens:4096});expect(e.stream.mock.calls[0]?.[0]).not.toHaveProperty('tools')})
 it('chunks long human prompts within the input budget with exact sources and explicit omissions',async()=>{const prompt='请长期记住：'+Array.from({length:500},(_,i)=>`独立事实${i}。`).join('');const e=await setup(prompt),material=await e.store.captureTaskMaterial(e.material);expect(material.sources.length).toBeGreaterThan(1);expect(material.sources.every(s=>Buffer.byteLength(s.text)<=4096)).toBe(true);expect(material.sources.map(s=>s.text).join('')).toBe(prompt);expect(material.sources.every(s=>s.hash===memoryHash(s.text))).toBe(true);expect(material.omitted).toBe(false);const large=await setup('请长期记住：'+Array.from({length:2000},(_,i)=>`独立长事实${i}。`).join(''));const limited=await large.store.captureTaskMaterial(large.material);expect(limited.omitted).toBe(true)})
 it('rejects actual unsolicited tool events without executing them',async()=>{const e=await setup();e.stream.mockImplementation(async function*(){yield {type:'tool-call',id:'x',name:'delete',input:{}} as any});await run(e);expect(e.service.results()[0]?.reason).toBe('MEMORY_TOOLS_FORBIDDEN');expect((await e.store.snapshot()).record.entries).toEqual([])})

 it('an explicit correction preserves basis without a self-v1 dependency and invalidates old historical versions',async()=>{
  const e=await setup();await run(e);const entry=(await e.store.validatedEntries())[0]!,dep=memoryDependency(entry)
  const saved=await another(e,'correction','请长期记住更正：我的母语改为英文。');saved.memoryDeps=[dep]
  const material=await e.store.captureTaskMaterial(saved);await e.store.enqueueJob(saved.taskId,saved.materialVersion,material,()=>{});await e.store.jobOutcome(saved.taskId,saved.materialVersion,'running')
  await e.store.applyJob(saved.taskId,saved.materialVersion,[{action:'update',content:'母语英文',layer:'core',scope:'本库，2026-10-02确认',category:'correction',citations:[material.sources[0]!.id],target:{id:entry.id,version:1}}],()=>{})
  const updated=(await e.store.validatedEntries())[0]!;expect(updated).toMatchObject({id:entry.id,version:2,content:'母语英文'});expect(updated.sources).toHaveLength(2);expect(updated.sources.flatMap(s=>s.memoryDeps)).not.toContainEqual({id:entry.id,version:1});expect(await e.store.validateDependency({id:entry.id,version:1})).toBe(false)
 })
 it('deleting also removes independent copies with the same old source and their retained excerpts',async()=>{
  const e=await setup();await run(e);const entry=(await e.store.validatedEntries())[0]!,source=entry.sources[0]!,note=await e.vault.read('note.md')
  const issued=await e.store.createManualSource({...note,relPath:'note.md',kind:source.kind,taskId:source.taskId!,start:source.start,end:source.end})
  await e.store.remember(await e.store.snapshot(),{content:'另一份同源内容',layer:'demand',scope:'本库',sources:[issued],explicit:true})
  await e.store.forget(await e.store.snapshot(),entry.id,entry.version);const raw=await readFile(path.join(e.root,'.rgent-memory'),'utf8');expect(raw).not.toContain('我的母语是中文');expect((await e.store.snapshot()).record.entries).toEqual([])
 })

 it('changing a citation boundary, whitespace or ledger task ID cannot turn the same old material into a new basis',async()=>{
  const e=await setup();await run(e);const entry=(await e.store.validatedEntries())[0]!
  await e.store.forget(await e.store.snapshot(),entry.id,entry.version)
  const m=await another(e,'copy-old','请长期记住： 我的母语是中文。');e.service.start(m.taskId);await e.service.saved(m);await e.service.idle()
  expect(e.stream).toHaveBeenCalledTimes(1);expect((await e.store.snapshot()).record.entries).toEqual([])
  const n=await e.vault.read('note.md'),chapter=ledgerChapters(compile(n.content).partition.ledger).find(c=>c.taskId==='task-one')!,start=chapter.text.indexOf('我的母语是中文')
  const partial=await e.store.createManualSource({...n,relPath:'note.md',kind:'ledger',taskId:'task-one',start,end:start+'我的母语是中文'.length})
  await expect(e.store.remember(await e.store.snapshot(),{content:'中文母语',layer:'core',scope:'本库',sources:[partial],explicit:false})).rejects.toThrow('MEMORY_FORGOTTEN_BASIS')
 })

 it('default OFF and missing roles retain no credentials or unbounded start permits',async()=>{const e=await setup();e.off();for(let i=0;i<300;i++)e.service.start('off-'+i);expect(e.service.state().permits).toBe(0);e.on();e.invalidModel();for(let i=0;i<300;i++)e.service.start('missing-'+i);expect(e.service.state().permits).toBe(0);expect(e.service.results().length).toBeLessThanOrEqual(256)})
 it('failed capture releases the permit, and explicit abandonment releases a pending task without a successful material event',async()=>{
  const e=await setup();e.service.start('bad');await e.service.saved({...e.material,taskId:'bad'});expect(e.service.state().permits).toBe(0)
  let content='/记住中文',revision='1';const host=new AgentHost({root:()=>'/vault',session:()=> 's',read:async()=>({content,revision,sessionId:'s',objectVersion:'o'}),write:async(_p,c)=>{if(c.includes('ledger-task'))throw Error('DISK_FULL');content=c;revision=String(Number(revision)+1);return revision},tier:async()=> 'reference',credential:()=>credential,limits:()=>({seconds:30,steps:2,tools:0}),stream:async function*(){yield '回答'},onTaskStarted:id=>e.service.start(id),onTaskStartFailed:id=>e.service.discard(id),onTaskMaterialDiscarded:id=>e.service.discard(id),emit:()=>{}})
  const task=await host.start({relPath:'note.md',range:{start:0,end:5},expectedText:'/记住中文',promptText:'记住中文'});await expect(task.done).rejects.toThrow('DISK_FULL');expect(e.service.state().permits).toBe(1);host.discardPending();expect(e.service.state().permits).toBe(0)
 })

 it('pending conflicts require target-aware human confirmation; ordinary enable cannot create two active contradicting entries',async()=>{
  const e=await setup();await run(e);const target=(await e.store.validatedEntries())[0]!,material=await e.store.captureTaskMaterial({...e.material,memoryDeps:[memoryDependency(target)]}),version=memoryHash('pending')
  await e.store.enqueueJob('pending',version,material,()=>{});await e.store.jobOutcome('pending',version,'running');const [id]=await e.store.applyJob('pending',version,[{action:'update',target:{id:target.id,version:1},content:'母语英文',layer:'core',scope:'本库',category:'ambiguous',citations:[material.sources[0]!.id]}],()=>{})
  await expect(e.store.toggle(await e.store.snapshot(),id!,1,true)).rejects.toThrow('MEMORY_CONFIRMATION_REQUIRED')
  await e.store.confirmPending(await e.store.snapshot(),id!,1,{id:target.id,version:1});const entries=await e.store.validatedEntries();expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({id:target.id,version:2,content:'母语英文'})
 })

 it.each(['remember this only for this task','remember this temporarily','do not remember my guess','This is unconfirmed, remember it','not confirmed: my first language is Chinese'])('rejects English temporary/negative/unconfirmed evidence: %s',async(prompt)=>{const e=await setup(prompt);await run(e);expect((await e.store.snapshot()).record.entries).toEqual([])})
 it('genuinely new human evidence may create a new ID with the same fact without unforgetting old history',async()=>{
  const e=await setup();await run(e);const old=(await e.store.validatedEntries())[0]!;await e.store.forget(await e.store.snapshot(),old.id,old.version)
  const material=await another(e,'new-basis','请重新长期记住：今天我再次确认母语为中文。');e.service.start(material.taskId);await e.service.saved(material);await e.service.idle()
  const entries=await e.store.validatedEntries();expect(entries).toHaveLength(1);expect(entries[0]?.id).not.toBe(old.id);expect(await e.store.validateDependency({id:old.id,version:old.version})).toBe(false)
 })
 it('old correction wording cannot override a newer human version without a new correction source',async()=>{
  const e=await setup('请长期记住更正：我的母语是中文。');await run(e);let target=(await e.store.validatedEntries())[0]!
  target=await e.store.edit(await e.store.snapshot(),target.id,target.version,{content:'人工改成英文'})
  const material=await e.store.captureTaskMaterial({...e.material,memoryDeps:[memoryDependency(target)]}),version=memoryHash('old-correction')
  await e.store.enqueueJob('old-correction',version,material,()=>{});await e.store.jobOutcome('old-correction',version,'running')
  await expect(e.store.applyJob('old-correction',version,[{action:'update',target:{id:target.id,version:target.version},content:'母语中文',layer:'core',scope:'本库',category:'correction',citations:[material.sources[0]!.id]}],()=>{})).rejects.toThrow('MEMORY_CORRECTION_BASIS')
 })

 it('a sent reference fragment continues after its own unrelated save but retains its send-time permission tier',async()=>{
  const e=await setup(),text='已确认：项目名是 Rgent。';await writeFile(path.join(e.root,'ref.md'),text+'\n\n别段。')
  const source=await e.vault.read('ref.md'),fragment={...source,relPath:'ref.md',permissionTier:'reference' as const,kind:'body' as const,classification:'human' as const,taskId:null,start:0,end:text.length,text,hash:memoryHash(text),sourceDeps:[{relPath:'ref.md',objectVersion:source.objectVersion,bodyHash:bodyFingerprint(source.content)}],memoryDeps:[]}
  await e.vault.write('ref.md',source.content+'\n\n无关新增。',source.revision,source)
  const m={...e.material,material:{fragments:[fragment],truncated:false}};const captured=await e.store.captureTaskMaterial(m);expect(captured.sources.some(s=>s.text===text)).toBe(true)
  await writeFile(path.join(e.root,'.rgent-permissions'),JSON.stringify({'ref.md':'follow'}));await expect(e.store.captureTaskMaterial(m)).rejects.toThrow('MEMORY_SOURCE_PERMISSION')
 })

 it('admits a lasting instruction about expressing uncertainty without treating its quoted words as an uncertain fact',async()=>{const e=await setup('以后回答不确定时请明确说“可能”，不要把猜测写成事实。');e.stream.mockImplementation(async function*(input:any){const p=JSON.parse(input.prompt);yield {type:'text',text:JSON.stringify({proposals:[{action:'add',target:null,content:'回答时明确标示不确定性，不把猜测当事实',layer:'core',scope:'本库',category:'lasting',citations:[p.sources[0].id]}]})};yield {type:'finish',reason:'stop'}});await run(e);expect((await e.store.validatedEntries()).length).toBe(1)})
 it.each(['unconfirmed: project uses TypeScript','not confirmed: project uses TypeScript','maybe the project uses TypeScript'])('does not accept the model confirmed label for %s',async(prompt)=>{const e=await setup(prompt);e.stream.mockImplementation(async function*(input:any){const p=JSON.parse(input.prompt);yield {type:'text',text:JSON.stringify({proposals:[{action:'add',target:null,content:'项目使用TypeScript',layer:'demand',scope:'本库',category:'confirmed',citations:[p.sources[0].id]}]})};yield {type:'finish',reason:'stop'}});await run(e);expect((await e.store.snapshot()).record.entries).toEqual([])})
 it('accepts a sourced confirmed project fact with its scope, even without first-person language',async()=>{const e=await setup('已确认：项目采用 TypeScript。');e.stream.mockImplementation(async function*(input:any){const p=JSON.parse(input.prompt);yield {type:'text',text:JSON.stringify({proposals:[{action:'add',target:null,content:'项目使用TypeScript',layer:'demand',scope:'项目，2026-10-02确认',category:'confirmed',citations:[p.sources[0].id]}]})};yield {type:'finish',reason:'stop'}});await run(e);expect((await e.store.validatedEntries())[0]?.scope).toBe('项目，2026-10-02确认')})
 it('rechecks source material after preparing related input and before the actual dispatch',async()=>{const e=await setup(),validate=e.store.validatedEntries.bind(e.store);let calls=0;vi.spyOn(e.store,'validatedEntries').mockImplementation(async ids=>{const result=await validate(ids);if(++calls===2){const n=await e.vault.read('note.md');await writeFile(path.join(e.root,'note.md'),n.content.replace('我的母语是中文','我的母语是英文'))}return result});await run(e);expect(e.stream).not.toHaveBeenCalled()})

 it('enforces the 32 KiB input cap including related memory and labels before dispatch',async()=>{
  const e=await setup(),material=await e.store.captureTaskMaterial(e.material),template=material.sources[0]!,deps=[]
  for(let i=0;i<9;i++){const n=await e.vault.read('note.md'),source=await e.store.createManualSource({...n,relPath:'note.md',kind:'ledger',taskId:template.taskId!,start:template.start,end:template.end});const entry=await e.store.remember(await e.store.snapshot(),{content:String(i)+'x'.repeat(4000),layer:'demand',scope:'本库',sources:[source],explicit:true});deps.push(memoryDependency(entry))}
  e.material.memoryDeps=deps;await run(e);expect(e.stream).not.toHaveBeenCalled();expect(e.service.results()[0]?.reason).toBe('MEMORY_INPUT_LIMIT')
 })
 it('same text echoed by AI is still a command at the proven prompt range',async()=>{
  const e=await setup(),m=await another(e,'echo','以后用中文回答。'),n=await e.vault.read('note.md')
  const content=n.content.replace(/(### 回答\n\n)好的。(?=[\s\S]*$)/g,'$1以后用中文回答。')
  // External bytes preserve native identity; the updated successful evidence is built from the exact chapter.
  await writeFile(path.join(e.root,'note.md'),content);const current=await e.vault.read('note.md'),chapter=ledgerChapters(compile(content).partition.ledger).find(c=>c.taskId==='echo')!
  m.origin={relPath:'note.md',...current};m.answer='以后用中文回答。';m.ledgerHash=memoryHash(chapter.text.trimEnd())
  const payload=await e.store.captureTaskMaterial(m);expect(payload.sources[0]?.classification).toBe('command');e.service.start(m.taskId);await e.service.saved(m);await e.service.idle();expect((await e.store.validatedEntries()).length).toBe(1)
 })
 it('cancellation and session close abort uncooperative model iterators and retain an inspectable receipt',async()=>{
  const e=await setup();e.stream.mockImplementation(async function*(){await new Promise(()=>{});yield {type:'finish',reason:'stop'}});e.service.start(e.material.taskId);await e.service.saved(e.material);await vi.waitFor(()=>expect(e.stream).toHaveBeenCalledTimes(1));e.service.cancel(e.material.taskId);await e.service.idle();expect(e.service.results()[0]?.reason).toBe('MEMORY_CANCELLED')
  await e.service.retry(e.material.taskId,e.material.materialVersion);await vi.waitFor(()=>expect(e.stream).toHaveBeenCalledTimes(2));await e.service.close();expect((await e.store.snapshot()).record.jobs[0]?.outcome).toBe('interrupted');expect(e.service.state()).toEqual({permits:0,pending:0,active:0})
 })

 it('a failed startup interruption stays visible and can be retried after recovery, without reviving a permit',async()=>{const e=await setup();vi.spyOn(e.store,'interruptJobs').mockRejectedValueOnce(Error('LIFECYCLE_RECOVERY_REQUIRED'));await expect(e.service.restore()).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED');expect(e.service.results()[0]?.status).toBe('unavailable');await expect(e.service.restore()).resolves.toBeUndefined();expect(e.stream).not.toHaveBeenCalled();await run(e);expect(e.stream).toHaveBeenCalledTimes(1)})

 it('a repeated human requirement deduplicates and refreshes existing recency without rewriting its fact version',async()=>{const e=await setup();await run(e);const old=(await e.store.validatedEntries())[0]!,m=await another(e,'repeat');e.service.start(m.taskId);await e.service.saved(m);await e.service.idle();const entries=await e.store.validatedEntries();expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({id:old.id,version:old.version});expect(entries[0]!.updatedAt>old.updatedAt).toBe(true)})

 it.each(['committed-save','external-replacement'] as const)('review boundary: capture before enqueue handles %s using only native succession',async(change)=>{
  const e=await setup(),capture=e.store.captureTaskMaterial.bind(e.store);let captured!:Awaited<ReturnType<typeof capture>>
  vi.spyOn(e.store,'captureTaskMaterial').mockImplementation(async evidence=>{
    captured=await capture(evidence);const before=await e.vault.read('note.md')
    if(change==='committed-save')await e.vault.write('note.md','下一场无关正文。\n\n'+before.content,before.revision,before)
    else{await rename(path.join(e.root,'note.md'),path.join(e.root,'held.md'));await writeFile(path.join(e.root,'note.md'),before.content)}
    return captured
  })
  await run(e)
  if(change==='external-replacement'){expect(e.stream).not.toHaveBeenCalled();expect(e.service.results()[0]?.reason).toBe('MEMORY_SOURCE_REPLACED')}
  else{expect(e.stream).toHaveBeenCalledTimes(1);const [entry]=await e.store.validatedEntries();expect(entry?.sources[0]?.basisHash).toBe(captured.sources[0]?.basisHash);expect(entry?.sources[0]?.basisGroups).toEqual(captured.sources[0]?.basisGroups);expect(entry?.sources[0]?.objectVersion).not.toBe(captured.sources[0]?.objectVersion)}
 })
 it('review boundary: forgetting a later manually adopted answer clears retained result and its retry dispatch',async()=>{
  const e=await setup(),taskId='result-origin',prompt='请检查这项约定。',answer='FORGET_ME_RESULT_私密长期事实。',note=await e.vault.read('note.md')
  const content=appendLedgerChapter(note.content,{taskId,startedAt:'today',status:'completed',prompt,answer,provenance:{version:1,model:{provider:'test',modelId:'x',endpointHost:'example.test'},scope:['note.md'],sources:[],tools:[]}})
  await e.vault.write('note.md',content,note.revision,note);const saved=await e.vault.read('note.md'),chapter=ledgerChapters(compile(content).partition.ledger).find(c=>c.taskId===taskId)!
  const evidence={...e.material,taskId,prompt,answer,origin:{relPath:'note.md',...saved},materialVersion:memoryHash(taskId),ledgerHash:memoryHash(chapter.text.trimEnd())}
  e.stream.mockImplementation(async function*(){yield {type:'text',text:'invalid JSON'};yield {type:'finish',reason:'stop'}})
  e.service.start(taskId);await e.service.saved(evidence);await e.service.idle();expect(e.stream).toHaveBeenCalledTimes(1)
  expect((await e.store.snapshot()).record.jobs.find(j=>j.taskId===taskId)?.material?.related).toEqual([])
  const start=chapter.text.indexOf(answer),source=await e.store.createManualSource({...saved,relPath:'note.md',kind:'ledger',taskId,start,end:start+answer.length})
  const entry=await e.store.remember(await e.store.snapshot(),{content:answer,layer:'demand',scope:'本库',sources:[source],explicit:true})
  const original=await readFile(path.join(e.root,'note.md'));await e.store.forget(await e.store.snapshot(),entry.id,entry.version)
  expect(await readFile(path.join(e.root,'note.md'))).toEqual(original)
  expect(await readFile(path.join(e.root,'.rgent-memory'),'utf8')).not.toContain(answer)
  expect((await e.store.snapshot()).record.jobs.find(j=>j.taskId===taskId)).toMatchObject({outcome:'rejected',reason:'MEMORY_MATERIAL_FORGOTTEN'})
  await e.service.retry(taskId,evidence.materialVersion);await e.service.idle();expect(e.stream).toHaveBeenCalledTimes(1)
  expect((await e.store.snapshot()).record.jobs.find(j=>j.taskId===taskId)).toMatchObject({outcome:'rejected',reason:'MEMORY_MATERIAL_FORGOTTEN'})
 })


 it.each(['during-capture','after-capture'] as const)('review in-flight: forgetting %s prevents result persistence and retry dispatch',async timing=>{
  const e=await setup(),taskId='inflight-result',prompt='请检查这项约定。',answer='FORGET_INFLIGHT_回答正文。',note=await e.vault.read('note.md')
  const content=appendLedgerChapter(note.content,{taskId,startedAt:'today',status:'completed',prompt,answer,provenance:{version:1,model:{provider:'test',modelId:'x',endpointHost:'example.test'},scope:['note.md'],sources:[],tools:[]}})
  await e.vault.write('note.md',content,note.revision,note);const saved=await e.vault.read('note.md'),chapter=ledgerChapters(compile(content).partition.ledger).find(c=>c.taskId===taskId)!
  const evidence={...e.material,taskId,prompt,answer,origin:{relPath:'note.md',...saved},materialVersion:memoryHash(taskId),ledgerHash:memoryHash(chapter.text.trimEnd())}
  const capture=e.store.captureTaskMaterial.bind(e.store),original=await readFile(path.join(e.root,'note.md'))
  const forget=async()=>{
    const start=chapter.text.indexOf(answer)
    const source=await e.store.createManualSource({...saved,relPath:'note.md',kind:'ledger',taskId,start,end:start+answer.length})
    const entry=await e.store.remember(await e.store.snapshot(),{content:answer,layer:'demand',scope:'本库',sources:[source],explicit:true})
    await e.store.forget(await e.store.snapshot(),entry.id,entry.version)
  }
  if(timing==='during-capture'){
    const validate=e.store.validatedEntries.bind(e.store)
    vi.spyOn(e.store,'validatedEntries').mockImplementationOnce(async ids=>{const entries=await validate(ids);await forget();return entries})
  }else vi.spyOn(e.store,'captureTaskMaterial').mockImplementation(async proof=>{const material=await capture(proof);await forget();return material})
  e.service.start(taskId);await e.service.saved(evidence);await e.service.idle()
  expect(e.stream).not.toHaveBeenCalled()
  expect((await e.store.snapshot()).record.jobs.find(j=>j.taskId===taskId)).toMatchObject({outcome:'rejected',reason:'MEMORY_MATERIAL_FORGOTTEN'})
  expect(await readFile(path.join(e.root,'.rgent-memory'),'utf8')).not.toContain(answer)
  expect(await readFile(path.join(e.root,'note.md'))).toEqual(original)
  await e.service.retry(taskId,evidence.materialVersion);await e.service.idle();expect(e.stream).not.toHaveBeenCalled()
 })

})

it('filters transient unavailable outcomes by the current session without reviving permits', async () => {
  const e = await setup(); const previous = e.vault.sessionId()!
  e.invalidModel(); e.service.start('old-session-unavailable')
  expect(e.service.results(previous).map(r=>r.taskId)).toEqual(['old-session-unavailable'])
  e.vault.restore(); const current = e.vault.sessionId()!
  expect(e.service.results(current)).toEqual([])
  e.service.start('new-session-unavailable')
  expect(e.service.results(current).map(r=>r.taskId)).toEqual(['new-session-unavailable'])
  expect(e.service.state().permits).toBe(0)
})

it.each(['success','failure'] as const)('keeps late old recovery %s scoped to its original session and retains current same-name failure',async(outcome)=>{
 let context={sessionId:'old',vaultKey:'old-key'},resolve!:()=>void,reject!:(e:Error)=>void
 const old=new Promise<void>((r,j)=>{resolve=r;reject=j})
 const service=new MemoryConsolidationService({context:()=>context,store:()=>({interruptJobs:()=>context.sessionId==='old'?old:Promise.reject(Error('MEMORY_REPLACED'))})} as never)
 const restoring=service.restore().catch(()=>{})
 context={sessionId:'new',vaultKey:'new-key'}
 await expect(service.restore()).rejects.toThrow('MEMORY_REPLACED')
 if(outcome==='success')resolve();else reject(Error('MEMORY_INVALID'))
 await restoring
 expect(service.results('new')).toEqual([{sessionId:'new',taskId:'memory-recovery',status:'unavailable',reason:'MEMORY_REPLACED'}])
 expect(service.results('old')).toEqual(outcome==='failure'?[{sessionId:'old',taskId:'memory-recovery',status:'unavailable',reason:'MEMORY_INVALID'}]:[])
})

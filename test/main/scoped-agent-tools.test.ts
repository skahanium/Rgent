import { describe, expect, it } from 'vitest'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import { createScopedAgentTools } from '../../src/main/scoped-agent-tools.ts'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
import { bodyFingerprint } from '../../src/main/ledger-provenance.ts'

async function fixture(content='# B\n\nneedle 正文\n') {
  const records=new Map([['a.md',{content:'/问\n',revision:'ra',sessionId:'s',objectVersion:'oa'}],['b.md',{content,revision:'rb',sessionId:'s',objectVersion:'ob'}],['outside.md',{content:'needle OUTSIDE_SECRET',revision:'rc',sessionId:'s',objectVersion:'oc'}]])
  const reads:string[]=[];let denied='';let hook:((path:string)=>Promise<void>)|undefined
  const read=async(path:string)=>{reads.push(path);await hook?.(path);const x=records.get(path);if(!x)throw Error('ENOENT');return {...x}}
  const tier=async(_root:string,path:string):Promise<'reference'|'follow'>=>{if(path===denied)throw Error('FORBIDDEN');return path==='a.md'?'reference':'follow'}
  const acceptsObject=()=>false
  const registry=new TaskAuthorizationRegistry({root:()=>'/v',session:()=> 's',read,tier,acceptsObject,
    tree:async()=>[...records.keys()].map(relPath=>({name:relPath,relPath,kind:'note' as const})),configuration:()=>({credential:{provider:'custom',baseURL:'https://model.example/v1',modelId:'m',contextTokens:16000,apiKey:'secret'},limits:{seconds:300,steps:12,tools:24}})})
  const request={relPath:'a.md',sessionId:'s',objectVersion:'oa',expectedRevision:'ra',range:{start:0,end:2},expectedText:'/问',promptText:'问',references:['b.md']}
  const p=await registry.preview('owner',request);const grant=await registry.consume('owner',{...request,previewId:p.id});reads.length=0
  return {records,reads,grant,tools:createScopedAgentTools(grant,'task',{read,tier,acceptsObject}),deny:(path:string)=>{denied=path},hook:(fn:(path:string)=>Promise<void>)=>{hook=fn}}
}
const signal=()=>new AbortController().signal

describe('task-scoped read/search tools',()=>{
 it('searches only the fixed scope and never reads or returns outside material',async()=>{
  const f=await fixture();const result:any=await f.tools.execute('search_library',{query:'needle'},signal())
  expect(result.items.map((x:any)=>x.relPath)).toEqual(['b.md']);expect(JSON.stringify(result)).not.toContain('OUTSIDE_SECRET');expect(f.reads).not.toContain('outside.md')
  expect(f.tools.dependencies().map(x=>x.relPath)).toEqual(['b.md']);expect(f.tools.sentSources()).toEqual([]);f.tools.markSent();expect(f.tools.sentSources()).toEqual(['b.md'])
 })
 it('lists metadata then reads body by opaque source id without foreign ledger',async()=>{
  const f=await fixture('正文\n\n<!-- rgent:ledger:v1 -->\n\n秘密账本');const list:any=await f.tools.execute('read_library',{},signal())
  const id=list.items.find((x:any)=>x.relPath==='b.md').sourceId
  const result:any=await f.tools.execute('read_library',{sourceId:id},signal())
  expect(JSON.stringify(result)).toContain('正文');expect(JSON.stringify(result)).not.toContain('秘密账本')
  await expect(f.tools.execute('read_library',{sourceId:'/etc/passwd'},signal())).rejects.toThrow('OUTSIDE_TASK_SCOPE')
  await expect(f.tools.execute('read_library',{path:'outside.md'},signal())).rejects.toThrow('INVALID_TOOL_ARGUMENTS')
 })
 it('paginates a large unicode block within the byte budget and rejects replay across tasks',async()=>{
  const f=await fixture('标题\n\n'+ '😀中文'.repeat(4000));const sourceId=f.grant.sources.find(s=>s.relPath==='b.md')!.sourceId
  let cursor:string|undefined;let total='';let first:string|undefined
  for(let at=0;at<50;at++){
   const result:any=await f.tools.execute('read_library',{sourceId,...(cursor?{cursor}:{})},signal());expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
   total+=result.items.map((x:any)=>x.text).join('');cursor=result.nextCursor;first??=cursor;if(!cursor)break
  }
  expect(total).toContain('😀中文'.repeat(4000));expect(total).not.toContain('�')
  const other=await fixture();await expect(other.tools.execute('read_library',{sourceId:other.grant.sources[1]!.sourceId,cursor:first},signal())).rejects.toThrow('INVALID_TOOL_CURSOR')
 })
 it('rejects source changes before returning a cached/page result or next send',async()=>{
  const f=await fixture('x'.repeat(12000));const sourceId=f.grant.sources[1]!.sourceId;const page:any=await f.tools.execute('read_library',{sourceId},signal())
  f.records.get('b.md')!.revision='new'
  await expect(f.tools.execute('read_library',{sourceId,cursor:page.nextCursor},signal())).rejects.toThrow('SOURCE_CHANGED')
  await expect(f.tools.assertCurrent(signal())).rejects.toThrow('AUTHORIZATION_REVOKED')
 })
 it('cancels a stalled disk read and ignores its late result',async()=>{
  const f=await fixture();let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve});f.hook(async()=>waiting)
  const c=new AbortController();const job=f.tools.execute('search_library',{query:'needle'},c.signal);c.abort()
  await expect(job).rejects.toThrow('TASK_CANCELLED');release();expect(f.tools.sentSources()).toEqual([])
 })
 it('counts refused unknown/invalid calls without recording raw malicious names',async()=>{
  const f=await fixture();await expect(f.tools.execute('evil_SECRET',{},signal())).rejects.toThrow('UNKNOWN_TOOL')
  await expect(f.tools.execute('search_library',{query:'',extra:'secret'},signal())).rejects.toThrow('INVALID_TOOL_ARGUMENTS')
  expect(f.tools.summary()).toEqual([{name:'unknown',outcome:'refused (1)'},{name:'search_library',outcome:'refused (1)'}]);expect(JSON.stringify(f.tools.summary())).not.toContain('SECRET')
 })
 it('omits inaccessible historical chapters and their derived AI body without reading outside scope',async()=>{
  const f=await fixture();const body='<!-- rgent:ai:v1 task-id="old" -->\n\nOUTSIDE_DERIVED\n\n/问\n'
  const source=appendLedgerChapter(body,{taskId:'old',prompt:'p',answer:'historic secret',status:'completed',startedAt:'now',provenance: {version:1,model:{provider:'custom',modelId:'m',endpointHost:'model.example'},scope:['a.md','outside.md'],sources:[{relPath:'outside.md',objectVersion:'oc',bodyHash:bodyFingerprint(f.records.get('outside.md')!.content)}],tools:[]}})
  const policy=await f.tools.contextPolicy(source,signal());expect(policy.allowedLedgerChapterIds).toHaveLength(0);expect(policy.excludedAiTaskIds).toContain('old');expect(f.reads).not.toContain('outside.md')
 })
})

it('registers historical dependencies only when their chapter or derived AI body enters context',async()=>{
 const f=await fixture();const provenance={version:1 as const,model:{provider:'custom',modelId:'m',endpointHost:'model.example'},scope:['a.md','b.md'],sources:[{relPath:'b.md',objectVersion:'ob',bodyHash:bodyFingerprint(f.records.get('b.md')!.content)}],tools:[]}
 const source=appendLedgerChapter('<!-- rgent:ai:v1 task-id="old" -->\n\n历史推导\n\n/问\n',{taskId:'old',startedAt:'now',status:'completed',prompt:'p',answer:'回答',provenance})
 const policy=await f.tools.contextPolicy(source,signal());expect(policy.allowedLedgerChapterIds).toHaveLength(1);expect(f.tools.dependencies()).toEqual([])
 f.tools.recordContext([{kind:'ledger',sourceId:policy.allowedLedgerChapterIds[0]!}]);expect(f.tools.dependencies().map(s=>s.relPath)).toEqual(['b.md']);expect(f.tools.sentSources()).toEqual([])
 f.tools.markSent();expect(f.tools.sentSources()).toEqual(['b.md']);f.deny('b.md');await expect(f.tools.assertCurrent(signal())).rejects.toThrow('FORBIDDEN')
})
it('hides a reference note’s unadopted body derived from a source outside this task',async()=>{
 const raw='<!-- rgent:ai:v1 task-id="old" -->\n\nHIDDEN_DERIVATION needle\n\n普通正文\n'
 const source=appendLedgerChapter(raw,{taskId:'old',startedAt:'now',status:'completed',prompt:'p',answer:'answer',provenance:{version:1,model:{provider:'custom',modelId:'m',endpointHost:'model.example'},scope:['b.md','outside.md'],sources:[{relPath:'outside.md',objectVersion:'oc',bodyHash:bodyFingerprint('needle OUTSIDE_SECRET')}],tools:[]}})
 const f=await fixture(source);const result:any=await f.tools.execute('search_library',{query:'needle'},signal());expect(result.items).toEqual([])
 const read:any=await f.tools.execute('read_library',{sourceId:f.grant.sources[1]!.sourceId},signal());expect(JSON.stringify(read)).toContain('普通正文');expect(JSON.stringify(read)).not.toContain('HIDDEN_DERIVATION');expect(f.reads).not.toContain('outside.md')
})
it('rejects a source replaced after material was read but before the tool returns',async()=>{
 const f=await fixture();let reads=0;f.hook(async path=>{if(path==='b.md' && ++reads===3)f.records.get(path)!.objectVersion='replacement'})
 await expect(f.tools.execute('search_library',{query:'needle'},signal())).rejects.toThrow('SOURCE_REPLACED');expect(f.tools.sentSources()).toEqual([])
})
it('preserves source range offsets and does not expose identity markers in reading pages',async()=>{
 const content='<!-- rgent:ai:v1 task-id="previous" -->\n\nanswer\n\n正文\r\n'
 const f=await fixture(content);const page:any=await f.tools.execute('read_library',{sourceId:f.grant.sources[1]!.sourceId},signal())
 expect(page.items[0].text).toBe('answer');expect(content.slice(page.items[0].from,page.items[0].to)).toBe('answer');expect(JSON.stringify(page)).not.toContain('rgent:ai')
})

it('does not mark distant historical dependencies sent for a human-only search snippet',async()=>{
 const cContent='C 资料';const provenance={version:1 as const,model:{provider:'custom',modelId:'m',endpointHost:'model.example'},scope:['b.md','outside.md'],sources:[{relPath:'outside.md',objectVersion:'oc',bodyHash:bodyFingerprint(cContent)}],tools:[]}
 const b=appendLedgerChapter('needle 人的内容\n\n'+ '间隔'.repeat(200)+'\n\n<!-- rgent:ai:v1 task-id="old" -->\n\n来自C的旧结论\n',{taskId:'old',startedAt:'now',status:'completed',prompt:'p',answer:'回答',provenance})
 const f=await fixture(b);f.records.get('outside.md')!.content=cContent
 // A second scoped grant includes C, but the query’s actual outgoing excerpt does not.
 const c={sourceId:'c',relPath:'outside.md',title:'outside',sessionId:'s',objectVersion:'oc',revision:'rc',fingerprint:'unused',tier:'follow' as const}
 const grant={...f.grant,sources:[...f.grant.sources,c],origin:f.grant.origin,root:f.grant.root,sessionId:f.grant.sessionId,credential:f.grant.credential,limits:f.grant.limits,id:f.grant.id,validateSources:()=>Promise.resolve(),assertLive:()=>Promise.resolve(),assertWriteTarget:()=>{},acknowledgeOrigin:()=>{},revoke:()=>{}} as import('../../src/main/task-authorization.ts').TaskGrant
 // The test source proof uses the same validated digest that a real preview stores.
 const {createHash}=await import('node:crypto');c.fingerprint=createHash('sha256').update(cContent).digest('hex')
 const tools=createScopedAgentTools(grant,'outgoing',{read:async path=>({...f.records.get(path)!}),tier:async(_root,path)=>path==='a.md'?'reference':'follow',acceptsObject:()=>false})
 const result:any=await tools.execute('search_library',{query:'needle'},signal());expect(result.items).toHaveLength(1);tools.markSent();expect(tools.sentSources()).toEqual(['b.md'])
})
it('does not cut an emoji at the start of a search snippet',async()=>{
 const f=await fixture('😀'+'x'.repeat(39)+'needle');const result:any=await f.tools.execute('search_library',{query:'needle'},signal())
 expect(result.items[0].snippet).toContain('😀');expect(result.items[0].snippet.isWellFormed()).toBe(true)
})
it('propagates cancellation while checking a historical dependency',async()=>{
 const f=await fixture();const source=appendLedgerChapter('正文',{taskId:'old',startedAt:'now',status:'completed',prompt:'p',answer:'回答',provenance:{version:1,model:{provider:'custom',modelId:'m',endpointHost:'model.example'},scope:['a.md','b.md'],sources:[{relPath:'b.md',objectVersion:'ob',bodyHash:bodyFingerprint(f.records.get('b.md')!.content)}],tools:[]}})
 let release!:()=>void;let reached!:()=>void;const entered=new Promise<void>(r=>{reached=r});const blocked=new Promise<void>(r=>{release=r});f.hook(async path=>{if(path==='b.md'){reached();await blocked}})
 const c=new AbortController();const checking=f.tools.contextPolicy(source,c.signal);await entered;c.abort();await expect(checking).rejects.toThrow('TASK_CANCELLED');release()
})

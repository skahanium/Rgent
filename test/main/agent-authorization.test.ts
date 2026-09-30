import { expect, it } from 'vitest'
import { AgentHost } from '../../src/main/agent-host.ts'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import type { AgentStartRequest, NoteSnapshot } from '../../src/shared/ipc.ts'

function fixture(stream:(signal:AbortSignal)=>AsyncIterable<string>) {
  const source:Record<string,NoteSnapshot>={'a.md':{content:'/问\n',revision:'1',sessionId:'session',objectVersion:'a'},'b.md':{content:'外篇参考',revision:'b',sessionId:'session',objectVersion:'b'}}
  let calls=0;let revision=1;let denied=''
  const tier=async(_root:string,path:string)=>{if(path===denied)throw Error('FORBIDDEN');return 'reference' as const}
  const registry=new TaskAuthorizationRegistry({root:()=>'/vault',session:()=> 'session',tree:async()=>Object.keys(source).map(relPath=>({name:relPath,relPath,kind:'note' as const})),
    read:async p=>({...source[p]!}),tier,acceptsObject:()=>false,configuration:()=>({credential:{provider:'custom',baseURL:'https://models.example/v1',modelId:'fixed',contextTokens:12000,apiKey:'secret'},limits:{seconds:30,steps:4,tools:0}})})
  const host=new AgentHost({root:()=>'/vault',session:()=> 'session',authorize:input=>registry.consume(input.authorizationOwner!,input as AgentStartRequest),
    tier,read:async p=>({...source[p]!}),write:async(p,content,expected)=>{if(expected!==source[p]!.revision)throw Error('CONFLICT');source[p]={...source[p]!,content,revision:String(++revision)};return {...source[p]!}},
    credential:()=>{throw Error('snapshot must be used')},limits:()=>{throw Error('snapshot must be used')},
    stream:(_input,signal)=>{calls++;return stream(signal)},emit:()=>{}})
  const request={relPath:'a.md',sessionId:'session',objectVersion:'a',expectedRevision:'1',range:{start:0,end:2},expectedText:'/问',promptText:'问',references:['b.md']}
  return {host,registry,request,source,calls:()=>calls,deny:(p:string)=>{denied=p}}
}
it('requires one-use authorization before changing the note and uses its fixed credential',async()=>{
  const app=fixture(async function*(){yield '回答'})
  await expect(app.host.start({...app.request,authorizationOwner:'owner'})).rejects.toThrow('INVALID_AUTHORIZATION')
  expect(app.source['a.md']!.content).toBe('/问\n')
  const preview=await app.registry.preview('owner',app.request)
  const task=await app.host.start({...app.request,previewId:preview.id,authorizationOwner:'owner'})
  await expect(task.done).resolves.toMatchObject({status:'completed'})
  expect(app.calls()).toBe(1);expect(app.source['a.md']!.content).toContain('回答')
  expect(app.source['a.md']!.content).not.toContain('secret')
})
it('stops on source changes and trusted finalization retains produced text and reason',async()=>{
  let change=()=>{}
  const app=fixture(async function*(){yield '已产生文本';change();yield '不得继续'})
  change=()=>{app.source['b.md']!.content='外部改变';app.source['b.md']!.revision='changed'}
  const p=await app.registry.preview('owner',app.request)
  const task=await app.host.start({...app.request,previewId:p.id,authorizationOwner:'owner'})
  await expect(task.done).resolves.toMatchObject({status:'failed',reason:'SOURCE_CHANGED'})
  expect(app.source['a.md']!.content).toContain('已产生文本');expect(app.source['a.md']!.content).toContain('SOURCE_CHANGED')
  expect(app.source['a.md']!.content).not.toContain('不得继续')
})
it('cancellation revokes calls yet saves text and same-note ledger',async()=>{
  const app=fixture(async function*(signal){yield '保留';await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))})
  const p=await app.registry.preview('owner',app.request)
  const task=await app.host.start({...app.request,previewId:p.id,authorizationOwner:'owner'})
  await new Promise(resolve=>setTimeout(resolve,20))
  await app.host.cancel(task.id)
  expect(app.source['a.md']!.content).toContain('保留');expect(app.source['a.md']!.content).toContain('· cancelled')
})
it('source invalidation aborts the provider and closes its iterator without changing failed status',async()=>{
  let changed=()=>{};let providerSignal!:AbortSignal;let returned=false
  const app=fixture(async function*(signal){
    providerSignal=signal
    try{yield '此前已生成';changed();yield '过期增量'}finally{returned=true}
  })
  changed=()=>{app.source['b.md']!.revision='source-changed'}
  const p=await app.registry.preview('owner',app.request)
  const task=await app.host.start({...app.request,previewId:p.id,authorizationOwner:'owner'})
  expect(await task.done).toEqual({status:'failed',reason:'SOURCE_CHANGED'})
  expect(providerSignal.aborted).toBe(true);expect(returned).toBe(true)
  expect(app.source['a.md']!.content).toContain('此前已生成')
  expect(app.source['a.md']!.content).not.toContain('过期增量')
})

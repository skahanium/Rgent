import { describe, expect, it } from 'vitest'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'

function setup() {
  let onRead: ((path: string) => void) | undefined
  let session = 'session-a'; let model = 'm'; let key = 'private'; let denied = ''
  const records = new Map([['a.md',{content:'/问\n', revision:'r-a',sessionId:session,objectVersion:'o-a'}],['dir/b.md',{content:'# B\n正文',revision:'r-b',sessionId:session,objectVersion:'o-b'}]])
  const registry = new TaskAuthorizationRegistry({ root:()=>'/vault',session:()=>session,
    tree:async()=>[{name:'a.md',relPath:'a.md',kind:'note'},{name:'dir',relPath:'dir',kind:'dir',children:[{name:'b.md',relPath:'dir/b.md',kind:'note'}]}],
    read:async path=>{ onRead?.(path); const item=records.get(path); if(!item)throw Error('ENOENT'); return {...item} },
    tier:async (_root,path)=>{ if(path===denied)throw Error('FORBIDDEN');return path==='dir/b.md'?'follow':'reference' },
    acceptsObject:()=>false,
    configuration:()=>({credential:{provider:'custom',baseURL:'https://model.example/v1',modelId:model,contextTokens:16000,apiKey:key},limits:{seconds:180,steps:4,tools:0}})
  })
  const request={relPath:'a.md',sessionId:session,objectVersion:'o-a',expectedRevision:'r-a',range:{start:0,end:2},expectedText:'/问',promptText:'问',references:['dir']}
  return {registry,request,records,onRead:(hook:(path:string)=>void)=>{onRead=hook},session:(x:string)=>{session=x},model:(x:string)=>{model=x},key:(x:string)=>{key=x},deny:(x:string)=>{denied=x}}
}

describe('single task authorization',()=>{
  it('shows only public recipient and fixed approved object manifest',async()=>{
    const app=setup();const preview=await app.registry.preview('window-a',app.request)
    expect(preview.sources.map(s=>s.relPath)).toEqual(['a.md','dir/b.md'])
    expect(preview.recipient.host).toBe('model.example')
    expect(JSON.stringify(preview)).not.toContain('private')
    app.records.set('dir/c.md',{content:'new',revision:'c',sessionId:'session-a',objectVersion:'c'})
    const grant=await app.registry.consume('window-a',{...app.request,previewId:preview.id})
    expect(grant.sources.map(s=>s.relPath)).not.toContain('dir/c.md')
    await expect(grant.assertLive('read','dir/c.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    await expect(grant.assertLive('write','dir/b.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
  })
  it('rejects forged, wrong caller, reused, and changed command previews',async()=>{
    const app=setup();const preview=await app.registry.preview('a',app.request)
    await expect(app.registry.consume('b',{...app.request,previewId:preview.id})).rejects.toThrow('INVALID_AUTHORIZATION')
    const grant=await app.registry.consume('a',{...app.request,previewId:preview.id})
    await expect(app.registry.consume('a',{...app.request,previewId:preview.id})).rejects.toThrow('INVALID_AUTHORIZATION')
    grant.revoke()
    await expect(grant.assertLive('model')).rejects.toThrow('AUTHORIZATION_REVOKED')
  })
  it('invalidates previews on model and secret changes without disclosing secrets',async()=>{
    const app=setup();let p=await app.registry.preview('a',app.request);app.model('new')
    await expect(app.registry.consume('a',{...app.request,previewId:p.id})).rejects.toThrow('STALE_AUTHORIZATION')
    p=await app.registry.preview('a',app.request);app.key('new-secret')
    await expect(app.registry.consume('a',{...app.request,previewId:p.id})).rejects.toThrow('STALE_AUTHORIZATION')
  })
  it('stops an active grant when references change or permissions tighten',async()=>{
    const app=setup();const p=await app.registry.preview('a',app.request);const grant=await app.registry.consume('a',{...app.request,previewId:p.id})
    app.records.get('dir/b.md')!.revision='changed'
    await expect(grant.assertLive('model')).rejects.toThrow('SOURCE_CHANGED')
    await expect(grant.assertLive('read','a.md')).rejects.toThrow('AUTHORIZATION_REVOKED')
  })
  it('rejects forbidden references and stale sessions',async()=>{
    const app=setup();app.deny('dir/b.md')
    await expect(app.registry.preview('a',app.request)).rejects.toThrow('FORBIDDEN')
    app.deny('');const p=await app.registry.preview('a',app.request);app.session('session-b')
    await expect(app.registry.consume('a',{...app.request,previewId:p.id})).rejects.toThrow('VAULT_CHANGED')
  })
})

it('permits only verified own write receipts while retaining immutable scope',async()=>{
  const app=setup();const p=await app.registry.preview('a',app.request);const grant=await app.registry.consume('a',{...app.request,previewId:p.id})
  const updated={content:'已标记口令',revision:'new',sessionId:'session-a',objectVersion:'o-a'}
  app.records.set('a.md',updated);grant.acknowledgeOrigin(updated)
  await expect(grant.assertLive('model')).resolves.toBeUndefined()
  grant.revoke();grant.assertWriteTarget('a.md')
  expect(()=>grant.assertWriteTarget('dir/b.md')).toThrow('OUTSIDE_TASK_SCOPE')
})
it('discard invalidates only the preview owner and all unknown actions fail closed',async()=>{
  const app=setup();const p=await app.registry.preview('a',app.request)
  app.registry.discard('b',p.id)
  const grant=await app.registry.consume('a',{...app.request,previewId:p.id})
  await expect(grant.assertLive('delete' as any,'a.md')).rejects.toThrow('ACTION_NOT_ALLOWED')
  const p2=await app.registry.preview('a',app.request);app.registry.discard('a',p2.id)
  await expect(app.registry.consume('a',{...app.request,previewId:p2.id})).rejects.toThrow('INVALID_AUTHORIZATION')
})

it('retries an origin proof updated by an acknowledged own write during verification',async()=>{
  const app=setup();const p=await app.registry.preview('a',app.request)
  const grant=await app.registry.consume('a',{...app.request,previewId:p.id})
  let once=true
  app.onRead(path=>{
    if(path==='a.md' && once){once=false
      const updated={content:'受控追加回答',revision:'own-next',sessionId:'session-a',objectVersion:'o-a'}
      app.records.set(path,updated);grant.acknowledgeOrigin(updated)
    }
  })
  await expect(grant.assertLive('model')).resolves.toBeUndefined()
})

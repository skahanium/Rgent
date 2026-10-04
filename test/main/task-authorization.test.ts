import { describe, expect, it, vi } from 'vitest'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import type { NoteSnapshot, TreeEntry } from '../../src/shared/ipc.ts'

function setup() {
  let onRead: ((path: string) => void | Promise<void>) | undefined
  let onTier: ((path: string) => void) | undefined
  let session = 'session-a'; let model = 'm'; let key = 'private'; let denied = ''
  const records = new Map([['a.md',{content:'/问\n', revision:'r-a',sessionId:session,objectVersion:'o-a'}],['dir/b.md',{content:'# B\n正文',revision:'r-b',sessionId:session,objectVersion:'o-b'}]])
  const deps = { root:()=>'/vault',session:()=>session,
    tree:async():Promise<TreeEntry[]>=>[{name:'a.md',relPath:'a.md',kind:'note'},{name:'pic.png',relPath:'pic.png',kind:'file'},{name:'dir',relPath:'dir',kind:'dir',children:[{name:'b.md',relPath:'dir/b.md',kind:'note'}]}],
    read:async (path:string)=>{ await onRead?.(path); const item=records.get(path); if(!item)throw Error('ENOENT'); return {...item} },
    tier:async (_root:string,path:string)=>{ onTier?.(path); if(path===denied)throw Error('FORBIDDEN');return path==='dir/b.md'?'follow':'reference' },
    acceptsObject:()=>false,
    configuration:()=>({credential:{provider:'custom' as const,baseURL:'https://model.example/v1',modelId:model,contextTokens:16000,apiKey:key},limits:{seconds:180,steps:4,tools:0}})
  }
  const registry = new TaskAuthorizationRegistry(deps)
  const request={relPath:'a.md',sessionId:session,objectVersion:'o-a',expectedRevision:'r-a',range:{start:0,end:2},expectedText:'/问',promptText:'问',modelRecordId:'model-record',references:['dir']}
  return {registry,deps,request,records,onRead:(hook:(path:string)=>void | Promise<void>)=>{onRead=hook},onTier:(hook:(path:string)=>void)=>{onTier=hook},session:(x:string)=>{session=x},model:(x:string)=>{model=x},key:(x:string)=>{key=x},deny:(x:string)=>{denied=x}}
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


it.each(['revoke', 'abort'] as const)('does not start another source operation after %s while origin read is stalled', async mode => {
  const app = setup(); const preview = await app.registry.preview('a', app.request)
  const grant = await app.registry.consume('a', { ...app.request, previewId: preview.id })
  let release!: () => void; let reached!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { reached = resolve })
  const operations: string[] = []
  app.onRead(async path => { operations.push(`read:${path}`); if (path === 'a.md') { reached(); await blocked } })
  app.onTier(path => { operations.push(`tier:${path}`) })
  const controller = new AbortController()
  const validation = grant.validateSources(controller.signal)
  await reading
  if (mode === 'revoke') grant.revoke(); else controller.abort()
  release()
  await expect(validation).rejects.toThrow(mode === 'revoke' ? 'AUTHORIZATION_REVOKED' : 'TASK_CANCELLED')
  expect(operations).toEqual(['tier:a.md', 'read:a.md'])
})

it('expires a prepared preview instead of letting it be consumed later', async () => {
  vi.useFakeTimers()
  try {
    const app = setup()
    const preview = await app.registry.preview('a', app.request)
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    await expect(app.registry.consume('a', { ...app.request, previewId: preview.id })).rejects.toThrow('INVALID_AUTHORIZATION')
  } finally { vi.useRealTimers() }
})

it('revokes a live grant once the calling window stops being valid', async () => {
  const app = setup()
  let valid = true
  const registry = new TaskAuthorizationRegistry({ ...app.deps, ownerValid: () => valid })
  const preview = await registry.preview('a', app.request)
  const grant = await registry.consume('a', { ...app.request, previewId: preview.id })
  valid = false
  await expect(grant.assertLive('model')).rejects.toThrow('AUTHORIZATION_REVOKED')
})

it.each(['../x.md', '.hidden.md', 'a\\b.md', '/abs.md', 'dir/../a.md'])('refuses a reference that is not a plain vault path: %s', async (reference) => {
  const app = setup()
  await expect(app.registry.preview('a', { ...app.request, references: [reference] })).rejects.toThrow('BAD_REQUEST')
})

it('refuses an attachment reference and a directory expansion beyond the object cap', async () => {
  const app = setup()
  await expect(app.registry.preview('a', { ...app.request, references: ['pic.png'] })).rejects.toThrow('OUTSIDE_TASK_SCOPE')

  const notes = new Map<string, NoteSnapshot>([['a.md', { content: '/问\n', revision: 'ra', sessionId: 's', objectVersion: 'oa' }]])
  const children: TreeEntry[] = []
  for (let at = 0; at < 257; at += 1) {
    const relPath = `big/n${at}.md`
    notes.set(relPath, { content: '正文', revision: `r${at}`, sessionId: 's', objectVersion: `o${at}` })
    children.push({ name: `n${at}.md`, relPath, kind: 'note' })
  }
  const registry = new TaskAuthorizationRegistry({
    root: () => '/vault', session: () => 's',
    tree: async (): Promise<TreeEntry[]> => [{ name: 'a.md', relPath: 'a.md', kind: 'note' }, { name: 'big', relPath: 'big', kind: 'dir', children }],
    read: async (path) => ({ ...notes.get(path)! }),
    tier: async (_root, path) => (path === 'a.md' ? 'reference' : 'follow'),
    acceptsObject: () => false,
    configuration: () => ({ credential: { provider: 'custom', baseURL: 'https://model.example/v1', modelId: 'm', contextTokens: 16000, apiKey: 'k' }, limits: { seconds: 180, steps: 4, tools: 0 } })
  })
  await expect(registry.preview('a', { relPath: 'a.md', sessionId: 's', objectVersion: 'oa', expectedRevision: 'ra', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问', modelRecordId: 'model-record', references: ['big'] }))
    .rejects.toThrow('AUTHORIZATION_SCOPE_TOO_LARGE')
})

it('fails closed with SOURCE_BUSY when the origin proof is replaced during every check', async () => {
  const app = setup()
  const preview = await app.registry.preview('a', app.request)
  const grant = await app.registry.consume('a', { ...app.request, previewId: preview.id })
  let writes = 0
  app.onRead((path) => {
    if (path !== 'a.md') return
    writes += 1
    const updated = { content: `受控写回 ${writes}`, revision: `own-${writes}`, sessionId: 'session-a', objectVersion: 'o-a' }
    app.records.set(path, updated)
    grant.acknowledgeOrigin(updated)
  })
  await expect(grant.assertLive('model')).rejects.toThrow('SOURCE_BUSY')
  await expect(grant.assertLive('model')).rejects.toThrow('AUTHORIZATION_REVOKED')
})


function attachmentSetup() {
  const app = setup()
  const tree: TreeEntry[] = [
    { name: 'a.md', relPath: 'a.md', kind: 'note' },
    { name: 'dir', relPath: 'dir', kind: 'dir', children: [
      { name: 'b.md', relPath: 'dir/b.md', kind: 'note' },
      // 原生 metadata 表明 Note/ 对应实际大小写不同的 note.md，不能靠拼名字判断。
      { name: 'Note', relPath: 'dir/Note', kind: 'dir', attachmentOf: 'dir/note.md', children: [
        { name: 'image.md', relPath: 'dir/Note/image.md', kind: 'note' },
        { name: 'sub', relPath: 'dir/Note/sub', kind: 'dir', children: [
          { name: 'nested.md', relPath: 'dir/Note/sub/nested.md', kind: 'note' }
        ] }
      ] }
    ] }
  ]
  for (const relPath of ['dir/Note/image.md', 'dir/Note/sub/nested.md']) {
    app.records.set(relPath, { content: '/问\n', revision: 'r-extra', sessionId: 'session-a', objectVersion: 'o-extra' })
  }
  const registry = new TaskAuthorizationRegistry({ ...app.deps, tree: async () => tree })
  return { ...app, tree, registry }
}

it.each(['dir/Note', 'dir/Note/image.md', 'dir/Note/sub', 'dir/Note/sub/nested.md'])('rejects an explicit attachment subtree reference: %s', async reference => {
  const app = attachmentSetup()
  await expect(app.registry.preview('a', { ...app.request, references: [reference] })).rejects.toThrow('OUTSIDE_TASK_SCOPE')
})

it('excludes attachment Markdown from ordinary directory expansion without blocking its ordinary notes', async () => {
  const app = attachmentSetup()
  const preview = await app.registry.preview('a', app.request)
  expect(preview.sources.map(source => source.relPath)).toEqual(['a.md', 'dir/b.md'])
})

it('rejects an attachment Markdown as the originating note', async () => {
  const app = attachmentSetup()
  await expect(app.registry.preview('a', { ...app.request, relPath: 'dir/Note/image.md', objectVersion: 'o-extra', expectedRevision: 'r-extra', references: [] })).rejects.toThrow('OUTSIDE_TASK_SCOPE')
})

it.each(['before-consume', 'before-read', 'during-read'] as const)('stops after an approved directory acquires attachment ownership %s', async timing => {
  const app = attachmentSetup()
  const preview = await app.registry.preview('a', app.request)
  const folder = app.tree[1]!
  if (timing === 'before-consume') {
    folder.attachmentOf = 'dir.md'
    await expect(app.registry.consume('a', { ...app.request, previewId: preview.id })).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    return
  }
  const grant = await app.registry.consume('a', { ...app.request, previewId: preview.id })
  if (timing === 'before-read') folder.attachmentOf = 'dir.md'
  else app.onRead(path => { if (path === 'dir/b.md') folder.attachmentOf = 'dir.md' })
  await expect(grant.assertLive(timing === 'before-read' ? 'read' : 'model', 'dir/b.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
  await expect(grant.assertLive('model')).rejects.toThrow('AUTHORIZATION_REVOKED')
})

it('fails closed when attachment membership cannot be verified', async () => {
  const app = setup()
  let available = true
  const registry = new TaskAuthorizationRegistry({ ...app.deps, tree: async () => {
    if (!available) throw Error('NOTE_UNREADABLE')
    return app.deps.tree()
  } })
  const preview = await registry.preview('a', app.request)
  const grant = await registry.consume('a', { ...app.request, previewId: preview.id })
  available = false
  await expect(grant.assertLive('model')).rejects.toThrow('NOTE_UNREADABLE')
  await expect(grant.assertLive('model')).rejects.toThrow('AUTHORIZATION_REVOKED')
})


it('does not return a preview when ownership changes during its source reads', async () => {
  const app = attachmentSetup()
  app.onRead(path => { if (path === 'dir/b.md') app.tree[1]!.attachmentOf = 'dir.md' })
  await expect(app.registry.preview('a', app.request)).rejects.toThrow('OUTSIDE_TASK_SCOPE')
})

it.each(['', '../model', 'x'.repeat(65)])('rejects malformed model record identifiers: %s', async modelRecordId => {
  const app = setup()
  await expect(app.registry.preview('a', { ...app.request, modelRecordId })).rejects.toThrow('BAD_REQUEST')
})

it('binds model record identity even if two records currently resolve to identical credentials', async () => {
  const app = setup()
  const preview = await app.registry.preview('a', app.request)
  await expect(app.registry.consume('a', { ...app.request, previewId: preview.id, modelRecordId: 'other-model' })).rejects.toThrow('STALE_AUTHORIZATION')
})


it('uses a scoped native ownership verifier rather than rescanning the full tree during live calls', async () => {
  const app = setup()
  let treeReads = 0; let attachment = false
  const registry = new TaskAuthorizationRegistry({ ...app.deps,
    tree: async () => { treeReads++; return app.deps.tree() },
    assertOrdinaryNotes: async paths => {
      expect(paths).toEqual(['a.md', 'dir/b.md'])
      if (attachment) throw Error('OUTSIDE_TASK_SCOPE')
    }
  })
  const preview = await registry.preview('a', app.request)
  const grant = await registry.consume('a', { ...app.request, previewId: preview.id })
  const before = treeReads
  await grant.assertLive('model')
  expect(treeReads).toBe(before)
  attachment = true
  await expect(grant.assertLive('model')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
})

it.each(['model', 'key'] as const)('rejects a %s configuration change while consuming and reading sources', async field => {
  const app = setup()
  const preview = await app.registry.preview('a', app.request)
  app.onRead(path => { if (path === 'dir/b.md') { if (field === 'model') app.model('changed'); else app.key('changed') } })
  await expect(app.registry.consume('a', { ...app.request, previewId: preview.id })).rejects.toThrow('STALE_AUTHORIZATION')
})


it('rejects a run-limit change made during authorization consumption', async () => {
  const app = setup()
  const config = app.deps.configuration()
  const registry = new TaskAuthorizationRegistry({ ...app.deps, configuration: () => structuredClone(config) })
  const preview = await registry.preview('a', app.request)
  app.onRead(path => { if (path === 'dir/b.md') config.limits.seconds = 181 })
  await expect(registry.consume('a', { ...app.request, previewId: preview.id })).rejects.toThrow('STALE_AUTHORIZATION')
})

it('rejects origin receipts after revocation and exposes a synchronous live check for the migration commit',async()=>{
 const app=setup(),preview=await app.registry.preview('owner',app.request),grant=await app.registry.consume('owner',{...app.request,previewId:preview.id})
 grant.revoke();expect(()=>grant.acknowledgeOrigin(app.records.get('a.md')!)).toThrow('AUTHORIZATION_REVOKED');expect(()=>grant.assertActive()).toThrow('AUTHORIZATION_REVOKED')
})

it('freezes a note-only memory tool budget before preview and rechecks memory signature on consume',async()=>{
 const app=setup();let signature='first';let search=true
 const registry=new TaskAuthorizationRegistry({...app.deps,memoryAuthorization:async()=>({signature,search,disclosure:{use:true,consolidate:false,recipient:null,limits:{seconds:120,calls:2,tools:0}}}),configuration:(library,_model,memory)=>({...app.deps.configuration(),limits:{seconds:30,steps:memory||library?8:4,tools:memory||library?12:0}})})
 const request={...app.request,references:[]};let p=await registry.preview('owner',request)
 expect(p.memory?.search).toEqual({available:true,calls:4,sharedTools:12})
 const grant=await registry.consume('owner',{...request,previewId:p.id});expect(grant.sources).toHaveLength(1);expect(grant.limits.tools).toBe(12)
 p=await registry.preview('owner',request);signature='changed';await expect(registry.consume('owner',{...request,previewId:p.id})).rejects.toThrow('STALE_AUTHORIZATION')
 search=false;p=await registry.preview('owner',request);expect(p.memory?.search?.available).toBe(false);expect((await registry.consume('owner',{...request,previewId:p.id})).limits.tools).toBe(0)
})

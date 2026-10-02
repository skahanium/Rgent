import { describe, expect, it } from 'vitest'
import { parseMemoryRequest, publicMemoryError } from '../../src/main/memory-ipc.ts'

describe('memory IPC boundary', () => {
  it('requires a session and rejects renderer supplied authority', () => {
    expect(parseMemoryRequest('get', {})).toBeNull()
    expect(parseMemoryRequest('get', {sessionId:'session', root:'/secret'})).toBeNull()
    expect(parseMemoryRequest('get', {sessionId:'session'})).toEqual({sessionId:'session'})
  })
  it('requires bounded content, raw offsets and binding for manual preview', () => {
    const request={sessionId:'session',relPath:'note.md',objectVersion:'object',revision:'a'.repeat(64),kind:'body',start:0,end:5}
    expect(parseMemoryRequest('manual',request)).toEqual(request)
    expect(parseMemoryRequest('manual',{...request,end:Infinity})).toBeNull()
    expect(parseMemoryRequest('manual',{...request,relPath:'/private/note.md'})).toBeNull()
    expect(parseMemoryRequest('manual',{...request,sources:[]})).toBeNull()
  })
  it('does not expose arbitrary disk errors or stack traces', () => {
    expect(publicMemoryError(new Error('EIO /Users/private/key'))).toBe('MEMORY_UNAVAILABLE')
    expect(publicMemoryError(new Error('MEMORY_PIN_FAILED:EIO /private/secret'))).toBe('MEMORY_PIN_FAILED')
    expect(publicMemoryError(new Error('MEMORY_SOURCE_CHANGED'))).toBe('MEMORY_SOURCE_CHANGED')
  })
})

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { createModelConfigStore } from '../../src/main/model-config.ts'
import { createMemoryIpc } from '../../src/main/memory-ipc.ts'
import type { MemoryPreview, MemoryView, MemoryResult } from '../../src/shared/memory.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<typeof import('../../src/main/watch.ts')>(),watchVault:vi.fn(()=>()=>{})}))
const cleanup:(()=>Promise<void>)[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0))await fn()})
async function fixture(){
  const data=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-ipc-')),root=path.join(data,'vault');await mkdir(root)
  await writeFile(path.join(data,'vault.json'),JSON.stringify({path:root}));await writeFile(path.join(root,'note.md'),'长期使用中文。\n\n无关段落。')
  const config=createModelConfigStore(data,{isEncryptionAvailable:()=>true,encryptString:Buffer.from,decryptString:b=>b.toString()})
  const vault=new VaultSession(data,vi.fn(),undefined,config.memoryStoragePins());vault.restore()
  const recheck=vi.fn(async()=>{}),ipc=createMemoryIpc({vault:()=>vault,config:()=>config,service:()=>null,recheck})
  cleanup.push(async()=>{vault.dispose();await rm(data,{recursive:true,force:true})})
  const sessionId=vault.sessionId()!,note=await vault.read('note.md')
  const request={sessionId,relPath:'note.md',objectVersion:note.objectVersion,revision:note.revision,kind:'body',start:0,end:7}
  const preview=async()=>{const result=await ipc.handle('owner','manual',request) as MemoryResult<MemoryPreview>;expect(result.ok).toBe(true);return result.ok?result.value:undefined!}
  return {data,root,config,vault,ipc,recheck,sessionId,note,request,preview}
}
describe('memory IPC authority with native storage',()=>{
  it('binds previews to the caller, consumes them once, and never returns raw hidden records',async()=>{
    const f=await fixture(),p=await f.preview()
    const commit={sessionId:f.sessionId,id:p.id,content:'中文优先',layer:'core',scope:'本库'}
    expect(await f.ipc.handle('other','commit',commit)).toEqual({ok:false,error:'STALE_PREVIEW'})
    expect(await f.ipc.handle('owner','commit',commit)).toEqual({ok:false,error:'STALE_PREVIEW'})
    const fresh=await f.preview(),saved=await f.ipc.handle('owner','commit',{...commit,id:fresh.id}) as MemoryResult<MemoryView>
    expect(saved.ok).toBe(true);expect(f.recheck).toHaveBeenCalledOnce()
    if(saved.ok){expect(saved.value.entries[0]?.content).toBe('中文优先');expect(JSON.stringify(saved.value)).not.toContain(f.root);expect(JSON.stringify(saved.value)).not.toMatch(/basisHash|forgotten|apiKey|sourceDeps|updateBasis/)}
    expect(await f.ipc.handle('owner','commit',{...commit,id:fresh.id})).toEqual({ok:false,error:'STALE_PREVIEW'})
  })
  it('rejects source changes, stale sessions and old record CAS before any commit',async()=>{
    const f=await fixture(),p=await f.preview()
    await f.vault.write('note.md','长期使用英文。\n\n无关段落。',f.note.revision,f.note)
    expect(await f.ipc.handle('owner','commit',{sessionId:f.sessionId,id:p.id,content:'中文优先',layer:'core',scope:'本库'})).toEqual({ok:false,error:'MEMORY_SOURCE_CHANGED'})
    f.vault.restore()
    expect(await f.ipc.handle('owner','get',{sessionId:f.sessionId})).toEqual({ok:false,error:'VAULT_CHANGED'})
  })
  it('separately persists device and vault config and allows safe management after a corrupt record',async()=>{
    const f=await fixture()
    const changed=await f.ipc.handle('owner','config',{sessionId:f.sessionId,target:'vault',vault:{enabled:true,override:{mode:'inherit'}}}) as MemoryResult<MemoryView>
    expect(changed.ok).toBe(true)
    const failed=await f.ipc.handle('owner','config',{sessionId:f.sessionId,target:'default',modelId:'missing'})
    expect(failed.ok).toBe(false)
    expect(f.config.getMemoryConfig(f.vault.memoryContext().vaultKey).vault.enabled).toBe(true)
    await writeFile(path.join(f.root,'.rgent-memory'),'{broken')
    const bad=await f.ipc.handle('owner','get',{sessionId:f.sessionId}) as MemoryResult<MemoryView>
    expect(bad.ok&&bad.value.status).toBe('invalid');expect(JSON.stringify(bad)).not.toContain(f.root)
    expect(await readFile(path.join(f.root,'.rgent-memory'),'utf8')).toBe('{broken')
  })
})

it('rejects record CAS changed after human preview, and lets OFF revoke even a damaged store',async()=>{
  const f=await fixture(),p=await f.preview()
  const q=await f.preview(),saved=await f.ipc.handle('owner','commit',{sessionId:f.sessionId,id:q.id,content:'第一条',layer:'core',scope:'本库'})
  expect(saved.ok).toBe(true)
  expect(await f.ipc.handle('owner','commit',{sessionId:f.sessionId,id:p.id,content:'迟到条目',layer:'demand',scope:'本库'})).toEqual({ok:false,error:'MEMORY_CONFLICT'})
  await writeFile(path.join(f.root,'.rgent-memory'),'{broken')
  const off=await f.ipc.handle('owner','config',{sessionId:f.sessionId,target:'vault',vault:{enabled:false,override:{mode:'inherit'}}}) as MemoryResult<MemoryView>
  expect(off.ok&&off.value.config.vault.enabled).toBe(false)
  expect(off.ok&&off.value.status).toBe('invalid')
})

import { MemoryConsolidationService } from '../../src/main/memory-consolidation.ts'
it.each(['unchanged','limits','receiver','credential','epoch'] as const)('uses the confirmed retry authority when %s occurs during the final asynchronous management read',async(change)=>{
  const context={sessionId:'session',vaultKey:'key'},version='a'.repeat(64)
  let limits={seconds:120,calls:2,tools:0},epoch=0,modelId='model',apiKey='unused',reads=0
  const job={taskId:'task',materialVersion:version,outcome:'rejected',entryIds:[],material:{result:'result',sources:[],related:[],omitted:false,status:'completed'}}
  const snapshot=()=>({...context,revision:version,objectVersion:'object',record:{entries:[],jobs:[job],forgotten:[],relocations:[]}})
  const store={snapshot:async()=>snapshot(),managementSnapshot:async()=>{if(++reads===2){if(change==='limits')limits={seconds:600,calls:4,tools:0};else if(change==='receiver')modelId='new-model';else if(change==='credential')apiKey='changed-key';else if(change==='epoch')epoch+=2}return snapshot()},job:async()=>job,list:async()=>[],interruptJobs:async()=>{},requeueJob:async()=>{},jobOutcome:async()=>{},rejectJob:async()=>{},validatedEntries:async()=>[],applyJob:async()=>{}}
  const stream=vi.fn(async function*(_input:unknown){yield {type:'text',text:'{"proposals":[]}'};yield {type:'finish',reason:'stop'}})
  const service=new MemoryConsolidationService({context:()=>context,config:()=>({enabled:true,epoch,limits:{...limits}}),credential:()=>({provider:'custom',modelId,baseURL:'https://example.test/v1',apiKey,contextTokens:99999}),store:()=>store,stream} as never)
  const cfg=()=>({defaultModelId:'m',limits:{...limits},vault:{enabled:true,override:{mode:'inherit'}},effectiveModelId:'m',modelStatus:'ready'})
  const vault={assertSession:(s:string)=>{if(s!=='session')throw Error('VAULT_CHANGED')},memory:()=>store,memoryContext:()=>context}
  const ipc=createMemoryIpc({vault:()=>vault,config:()=>({getMemoryConfig:cfg,memoryCredential:()=>({modelId,baseURL:'https://example.test/v1'})}),service:()=>service,recheck:async()=>{}} as never)
  const preview=await ipc.handle('owner','retry',{sessionId:'session',taskId:'task',materialVersion:version}) as MemoryResult<MemoryPreview>
  expect(preview.ok).toBe(true);if(!preview.ok)return
  expect(preview.value.limits).toEqual({seconds:120,calls:2,tools:0})
  expect(JSON.stringify(preview.value)).not.toMatch(/unused|changed-key|authorizationSignature/)
  const committed=await ipc.handle('owner','commit',{sessionId:'session',id:preview.value.id})
  if(change==='unchanged')expect(committed.ok).toBe(true)
  else expect(committed).toEqual({ok:false,error:'STALE_PREVIEW'})
  await service.idle();expect(stream).toHaveBeenCalledTimes(change==='unchanged'?1:0);expect(service.state().permits).toBe(0)
  if(change==='unchanged')expect(stream.mock.calls[0]?.[0]).toMatchObject({modelId:'model',apiKey:'unused'})
})

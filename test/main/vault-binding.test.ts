import { beforeEach,describe,it,expect,vi } from 'vitest'
import { boundArguments, isVaultChannel, boundEvent } from '../../src/shared/vault-binding.ts'
import { IPC } from '../../src/shared/ipc.ts'
const preload = vi.hoisted(() => ({invoke:vi.fn(),api:null as any}))
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:(_name:string,api:unknown)=>{preload.api=api}},ipcRenderer:{invoke:preload.invoke,on:vi.fn(),removeListener:vi.fn()}}))
describe('mount-bound IPC',()=>{
 it('refuses missing or old envelopes rather than resolving a path in the new vault',()=>{
   expect(()=>boundArguments(['same.md'],'B')).toThrow('VAULT_CHANGED')
   expect(()=>boundArguments([{session:'A',args:['same.md']}],'B')).toThrow('VAULT_CHANGED')
   expect(boundArguments([{session:'B',args:['same.md']}],'B')).toEqual(['same.md'])
 })
 it('keeps global preferences separate and scopes memory and file operations',()=>{
   expect(isVaultChannel('model:config:get')).toBe(false);expect(isVaultChannel('note:read')).toBe(true)
   expect(isVaultChannel('memory:get')).toBe(true);expect(isVaultChannel('vault:pick')).toBe(false)
 })
 it('filters old events even if they refer to the same relative path',()=>{
   expect(boundEvent({session:'A',args:['same.md']},'B')).toBe(null)
   expect(boundEvent({session:'B',args:['same.md']},'B')).toEqual(['same.md'])
 })
})

describe('preload mount state from authoritative management replies',()=>{
 beforeEach(async()=>{vi.resetModules();preload.invoke.mockReset();await import('../../src/preload/index.ts')})
 it('keeps a suspended mount through cancelled pick and get before the original root returns',async()=>{
   preload.invoke.mockResolvedValueOnce({status:'ready',sessionId:'A'})
   await preload.api.vaultGet()
   preload.invoke.mockResolvedValueOnce({status:'needs-pick',reason:'missing',sessionId:'A',cancelled:true})
   await preload.api.vaultPick()
   preload.invoke.mockResolvedValueOnce({status:'needs-pick',reason:'missing',sessionId:'A'})
   await preload.api.vaultGet()
   preload.invoke.mockImplementationOnce((_channel,envelope)=>{expect(envelope.session).toBe('A');return {content:'original',sessionId:'A'}})
   expect(await preload.api.noteRead('same.md')).toMatchObject({content:'original'})
 })
 it('starts unmounted and clears a prior mount only on an authoritative no-session reply',async()=>{
   preload.invoke.mockResolvedValueOnce({status:'needs-pick',reason:'first-run',sessionId:null})
   await preload.api.vaultGet()
   preload.invoke.mockResolvedValueOnce(null);await preload.api.noteRead('same.md')
   expect(preload.invoke.mock.calls.at(-1)?.[1]).toEqual({session:null,args:['same.md']})
   preload.invoke.mockResolvedValueOnce({status:'ready',sessionId:'A'});await preload.api.vaultGet()
   preload.invoke.mockResolvedValueOnce({status:'needs-pick',reason:'missing',sessionId:null});await preload.api.vaultGet()
   preload.invoke.mockResolvedValueOnce(null);await preload.api.noteRead('same.md')
   expect(preload.invoke.mock.calls.at(-1)?.[1]).toEqual({session:null,args:['same.md']})
 })
 it('rejects an old content receipt after mounting B and binds later content to B',async()=>{
   preload.invoke.mockResolvedValueOnce({status:'ready',sessionId:'A'});await preload.api.vaultGet()
   let release!:(value:unknown)=>void
   preload.invoke.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
   const old=preload.api.noteRead('same.md')
   const rejected=expect(old).rejects.toThrow('VAULT_CHANGED')
   preload.invoke.mockResolvedValueOnce({status:'ready',sessionId:'B'});await preload.api.vaultOpen('B')
   release({content:'A'});await rejected
   preload.invoke.mockResolvedValueOnce({content:'B'});await preload.api.noteRead('same.md')
   expect(preload.invoke.mock.calls.at(-1)?.[1]).toEqual({session:'B',args:['same.md']})
 })
})

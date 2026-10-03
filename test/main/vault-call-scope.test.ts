import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {expect,it,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts'
import {vaultRootIdentity} from '../../src/main/watch.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<object>(),watchVault:()=>()=>{}}))
it('refuses a late queued mutation and every attempt to capture B from an A call domain',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-call-scope-')),a=path.join(base,'A'),b=path.join(base,'New');await mkdir(a);await mkdir(b)
 const vault=new VaultSession(base,()=>{}),scoped=vault as VaultSession&{runBound<T>(token:string|null,run:()=>T):T}
 try{
  vault.restoreVerified(a,vaultRootIdentity(a));const old=vault.captureSession()
  expect(typeof scoped.runBound).toBe('function')
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),called=vi.fn()
  const late=scoped.runBound(old,()=>gate.then(()=>vault.memoryMutation(store=>{called();return store.initialize()}))).then(()=>null,(e:Error)=>e.message)
  let next=''
  const attempts=scoped.runBound(old,async()=>{await gate
   for(const operation of [()=>vault.captureSession(),()=>vault.assertSession(next),()=>vault.requireUsableRoot(),()=>vault.memorySnapshot(),()=>vault.acceptsObject('a.md','x','x'),()=>scoped.runBound(next,()=>vault.captureSession())])expect(operation).toThrow('VAULT_CHANGED')
  })
  await vault.openVerified(b,vaultRootIdentity(b));next=vault.captureSession()
  await scoped.runBound(next,()=>vault.memoryMutation(store=>store.initialize()))
  release();expect(await late).toBe('VAULT_CHANGED');await attempts;expect(called).not.toHaveBeenCalled()
  expect(scoped.runBound(next,()=>vault.captureSession())).toBe(next)
  expect(await readFile(path.join(b,'.rgent-memory'),'utf8')).toContain('rgent:memory:v2')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

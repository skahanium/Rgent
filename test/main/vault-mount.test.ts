import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {it,expect,vi} from 'vitest'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async importOriginal=>({...(await importOriginal<object>()),watchVault:()=>()=>{}}))
import {VaultSession} from '../../src/main/vault.ts'
import {vaultRootIdentity} from '../../src/main/watch.ts'
it('rechecks a replaced target after old writes drain without changing the old binding',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'rgent-mount-'))
 const a=path.join(home,'A'),b=path.join(home,'B');await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(a,'same.md'),'A')
 const session=new VaultSession(home,()=>{},async()=>{await fs.rename(b,b+'-gone');await fs.mkdir(b)})
 try{
   session.restoreVerified(a,vaultRootIdentity(a));const token=session.sessionId()
   await expect(session.openVerified(b,vaultRootIdentity(b))).rejects.toThrow('VAULT_TARGET_CHANGED')
   expect(session.sessionId()).toBe(token);expect(session.root).toBe(a);expect((await session.read('same.md')).content).toBe('A')
   expect(await fs.readdir(b)).toEqual([])
 }finally{session.dispose();await fs.rm(home,{recursive:true,force:true})}
})
it('does not restore a root whose saved identity no longer matches',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'rgent-root-'));const root=path.join(home,'A');await fs.mkdir(root)
 const id=vaultRootIdentity(root);await fs.rename(root,root+'-gone');await fs.mkdir(root)
 const session=new VaultSession(home,()=>{})
 try{expect(session.restoreVerified(root,id)).toEqual({status:'needs-pick',reason:'missing'});expect(session.root).toBe(null)}finally{session.dispose();await fs.rm(home,{recursive:true,force:true})}
})

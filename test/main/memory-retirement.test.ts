import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {retireMemoryFile,RETIRED_MEMORY} from '../../src/main/memory-retirement.ts'
import {closeSecureFs} from '../../src/main/secure-fs.ts'
const roots:string[]=[];const root=()=>{const r=mkdtempSync(path.join(os.tmpdir(),'rgent-retire-'));roots.push(r);return r}
afterEach(()=>roots.splice(0).forEach(r=>{closeSecureFs(r);rmSync(r,{recursive:true,force:true})}))
it('removes old text and permits without an archive, preserving note and old ledger bytes',()=>{const r=root();const note='\ufeff正文\r\n<!-- rgent:ledger:v1 -->\r\n旧推理\r\n';writeFileSync(path.join(r,'a.md'),note);writeFileSync(path.join(r,'.rgent-memory'),JSON.stringify({version:1,entries:[{content:'private old fact'}],forgotten:[],jobs:[{permit:'old'}],relocations:[]}));retireMemoryFile(r,()=>{});expect(readFileSync(path.join(r,'.rgent-memory'),'utf8')).toBe(RETIRED_MEMORY);expect(readFileSync(path.join(r,'a.md'),'utf8')).toBe(note);retireMemoryFile(r,()=>{})})
it('preserves an unrecognized damaged target and refuses a stale session before replacement',()=>{const r=root(),f=path.join(r,'.rgent-memory');writeFileSync(f,'not known JSON');expect(()=>retireMemoryFile(r,()=>{})).toThrow('MEMORY_RETIREMENT_FAILED');expect(readFileSync(f,'utf8')).toBe('not known JSON');expect(()=>retireMemoryFile(r,()=>{throw Error('VAULT_CHANGED')})).toThrow('VAULT_CHANGED')})
it('requires an approved retirement target to remain present while ordinary attach still permits an absent file',()=>{
 const r=root();expect(()=>retireMemoryFile(r,()=>{})).not.toThrow()
 expect(()=>retireMemoryFile(r,()=>{},{revision:'a'.repeat(64),objectVersion:'approved'})).toThrow('MEMORY_CONFLICT')
})

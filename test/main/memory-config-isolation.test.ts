import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createModelConfigStore } from '../../src/main/model-config.ts'
const roots: string[]=[]
const root=()=>{const r=mkdtempSync(path.join(os.tmpdir(),'rgent-config-v2-')); roots.push(r);return r}
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})))
const protection={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(s:Buffer)=>s.toString()}
const key='a'.repeat(64)
it('retires even corrupt legacy memory without losing valid answering credentials',()=>{
 const r=root(),store=createModelConfigStore(r,protection)
 store.saveProvider({provider:'deepseek',baseURL:'https://api.deepseek.com',modelId:'answer',contextTokens:32000},'secret')
 const id=store.getPublic().models.find(m=>m.provider==='deepseek')!.id;store.setDefault(id)
 const target=path.join(r,'model-config.json'),raw=JSON.parse(readFileSync(target,'utf8'));raw.memory={broken:true};writeFileSync(target,JSON.stringify(raw))
 const restored=createModelConfigStore(r,protection)
 expect(restored.credential().apiKey).toBe('secret')
 expect(restored.getMemoryConfig(key).vault.enabled).toBe(false)
 expect(restored.getMemoryConfig(key).defaultModelId).toBe(null)
 expect(JSON.parse(readFileSync(target,'utf8'))).not.toHaveProperty('memory')
})
it('independent corrupt memory config preserves its bytes and answering model operations',()=>{
 const r=root(),store=createModelConfigStore(r,protection),file=path.join(r,'memory-config.json')
 store.setVaultMemory(key,{enabled:true,override:{mode:'inherit'}})
 writeFileSync(file,'{"version":2,"broken":')
 const restored=createModelConfigStore(r,protection)
 expect(restored.getPublic().models.length).toBeGreaterThan(0)
 expect(()=>restored.getMemoryConfig(key)).toThrow('MEMORY_CONFIG_INVALID')
 expect(()=>restored.setMemoryDefault(null)).toThrow('MEMORY_CONFIG_INVALID')
 restored.updateLimits('none',{seconds:60,steps:4,tools:0})
 expect(readFileSync(file,'utf8')).toBe('{"version":2,"broken":')
 expect(JSON.parse(readFileSync(path.join(r,'model-config.json'),'utf8'))).not.toHaveProperty('memory')
})
it('memory writes use independent CAS and keep unrelated model changes and library isolation',()=>{
 const r=root(),a=createModelConfigStore(r,protection),b=createModelConfigStore(r,protection)
 a.setVaultMemory(key,{enabled:true,override:{mode:'inherit'}})
 expect(()=>b.setVaultMemory('b'.repeat(64),{enabled:true,override:{mode:'inherit'}})).toThrow('MEMORY_CONFIG_CONFLICT')
 const c=createModelConfigStore(r,protection)
 expect(c.getMemoryConfig(key).vault.enabled).toBe(true)
 expect(c.getMemoryConfig('b'.repeat(64)).vault.enabled).toBe(false)
 expect(c.getMemoryConfig(key).defaultModelId).toBe(null)
})

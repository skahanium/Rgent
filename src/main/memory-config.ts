import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MemoryLimits, VaultMemoryConfig } from '../shared/memory.ts'
export type MemoryDeviceConfig = { version: 1; defaultModelId: string | null; limits: MemoryLimits; vaults: Record<string,VaultMemoryConfig>; revisions: Record<string,number> }
export const emptyMemoryConfig=():MemoryDeviceConfig=>({version:1,defaultModelId:null,limits:{seconds:120,calls:2,tools:0},vaults:{},revisions:{}})
export const vaultMemoryDefault=():VaultMemoryConfig=>({enabled:false,override:{mode:'inherit'}})
const fields=(v:unknown,n:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===n.sort().join()
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9-]{1,64}$/.test(v)
export function requireVaultKey(key:string){if(!/^[a-f0-9]{64}$/.test(key))throw Error('BAD_VAULT_KEY')}
export function memoryLimits(v:unknown):MemoryLimits{if(!fields(v,['seconds','calls','tools'])||!Number.isSafeInteger(v.seconds)||Number(v.seconds)<1||Number(v.seconds)>600||!Number.isSafeInteger(v.calls)||Number(v.calls)<1||Number(v.calls)>4||v.tools!==0)throw Error('BAD_MEMORY_LIMITS');return {seconds:Number(v.seconds),calls:Number(v.calls),tools:0}}
export function vaultMemory(v:unknown):VaultMemoryConfig{
 if(!fields(v,['enabled','override'])||typeof v.enabled!=='boolean')throw Error('BAD_MEMORY_CONFIG')
 if(fields(v.override,['mode'])&&v.override.mode==='inherit')return {enabled:v.enabled,override:{mode:'inherit'}}
 if(fields(v.override,['mode','modelId'])&&v.override.mode==='model'&&id(v.override.modelId))return {enabled:v.enabled,override:{mode:'model',modelId:v.override.modelId}}
 throw Error('BAD_MEMORY_CONFIG')
}
function parse(raw:string):MemoryDeviceConfig{
 if(Buffer.byteLength(raw)>1048576)throw Error('MEMORY_CONFIG_INVALID')
 const v:unknown=JSON.parse(raw)
 if(!fields(v,['version','defaultModelId','limits','vaults','revisions'])||v.version!==1||v.defaultModelId!==null&&!id(v.defaultModelId)||!v.vaults||typeof v.vaults!=='object'||Array.isArray(v.vaults)||!v.revisions||typeof v.revisions!=='object'||Array.isArray(v.revisions))throw Error('MEMORY_CONFIG_INVALID')
 const vaults:Record<string,VaultMemoryConfig>={},revisions:Record<string,number>={}
 for(const [k,x]of Object.entries(v.vaults)){requireVaultKey(k);vaults[k]=vaultMemory(x)}
 for(const [k,x]of Object.entries(v.revisions)){requireVaultKey(k);if(!Number.isSafeInteger(x)||Number(x)<0)throw Error('MEMORY_CONFIG_INVALID');revisions[k]=Number(x)}
 return {version:1,defaultModelId:v.defaultModelId as string|null,limits:memoryLimits(v.limits),vaults,revisions}
}
/** Independent fixed device file. Corruption is diagnostic, never default-and-overwrite. */
export function createMemoryConfigStore(userData:string){
 const target=path.join(userData,'memory-config.json')
 const disk=()=>{try{return readFileSync(target,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}}
 let raw:string|null=null,current=emptyMemoryConfig(),invalid=false
 try{raw=disk();if(raw!==null)current=parse(raw)}catch{invalid=true}
 const get=()=>{if(invalid)throw Error('MEMORY_CONFIG_INVALID');if(disk()!==raw)throw Error('MEMORY_CONFIG_CONFLICT');return structuredClone(current)}
 const diagnosis=()=>{const bytes=disk();return {revision:bytes===null?null:createHash('sha256').update(bytes).digest('hex'),bytes:Buffer.byteLength(bytes??'')}}
 const replace=(next:MemoryDeviceConfig,expected:string|null)=>{
  const serialized=JSON.stringify(next);parse(serialized)
  if(disk()!==expected)throw Error('MEMORY_CONFIG_CONFLICT')
  const temporary=path.join(userData,`.memory-config-${randomUUID()}.tmp`);let fd:number|null=null
  try{fd=openSync(temporary,'wx',0o600);writeFileSync(fd,serialized);fsyncSync(fd);closeSync(fd);fd=null
   if(disk()!==expected)throw Error('MEMORY_CONFIG_CONFLICT')
   renameSync(temporary,target);raw=serialized;current=structuredClone(next);invalid=false
  }finally{if(fd!==null)closeSync(fd);try{unlinkSync(temporary)}catch{/* target committed or temporary never created */}}
 }
 return {get,diagnosis,write(next:MemoryDeviceConfig){get();replace(next,raw)},reset(revision:string|null){
  const expected=disk();if((expected===null?null:createHash('sha256').update(expected).digest('hex'))!==revision)throw Error('MEMORY_CONFIG_CONFLICT')
  replace(emptyMemoryConfig(),expected)
 }}
}

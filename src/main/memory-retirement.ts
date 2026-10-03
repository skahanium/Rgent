import { secureFsFor } from './secure-fs.ts'
export const MEMORY_FILE='.rgent-memory'
export const RETIRED_MEMORY='<!-- rgent:memory:retired:v2 -->\n'
/** No old entries are decoded, imported, archived or authorized. Unknown bytes are diagnostic. */
export function retireMemoryFile(root:string,check:()=>void):void{
 check();const fs=secureFsFor(root);let disk
 try{disk=fs.readSnapshot(MEMORY_FILE)}catch(e){if(e instanceof Error&&e.message==='ENOENT')return;throw e}
 const raw=disk.bytes.toString('utf8')
 if(!Buffer.from(raw).equals(disk.bytes))throw Error('MEMORY_RETIREMENT_FAILED')
 if(raw===RETIRED_MEMORY||raw.startsWith('<!-- rgent:memory:v2 '))return
 let value:unknown
 try{value=JSON.parse(raw)}catch{throw Error('MEMORY_RETIREMENT_FAILED')}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==['version','entries','forgotten','jobs','relocations'].sort().join()||(value as {version:unknown}).version!==1)throw Error('MEMORY_RETIREMENT_FAILED')
 check();fs.replace(MEMORY_FILE,raw,RETIRED_MEMORY,disk.objectVersion)
 check();if(fs.readSnapshot(MEMORY_FILE).bytes.toString()!==RETIRED_MEMORY)throw Error('MEMORY_RETIREMENT_FAILED')
}

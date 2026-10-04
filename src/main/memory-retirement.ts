import {createHash} from 'node:crypto'
import { secureFsFor } from './secure-fs.ts'
export const MEMORY_FILE='.rgent-memory'
export const RETIRED_MEMORY='<!-- rgent:memory:retired:v2 -->\n'
/** No old entries are decoded, imported, archived or authorized. Unknown bytes are diagnostic. */
export function retireMemoryFile(root:string,check:()=>void,expected?:{revision:string;objectVersion:string}):void{
 check();const fs=secureFsFor(root);let disk
 try{disk=fs.readSnapshot(MEMORY_FILE)}catch(e){if(e instanceof Error&&e.message==='ENOENT'){if(expected)throw Error('MEMORY_CONFLICT');return}throw e}
 if(expected&&(disk.objectVersion!==expected.objectVersion||createHash('sha256').update(disk.bytes).digest('hex')!==expected.revision))throw Error('MEMORY_CONFLICT')
 const raw=disk.bytes.toString('utf8')
 if(!Buffer.from(raw).equals(disk.bytes))throw Error('MEMORY_RETIREMENT_FAILED')
 if(raw===RETIRED_MEMORY||raw.startsWith('<!-- rgent:memory:v2 '))return
 if(!recognizedLegacyMemory(raw))throw Error('MEMORY_RETIREMENT_FAILED')
 check();fs.replace(MEMORY_FILE,raw,RETIRED_MEMORY,disk.objectVersion)
 check();if(fs.readSnapshot(MEMORY_FILE).bytes.toString()!==RETIRED_MEMORY)throw Error('MEMORY_RETIREMENT_FAILED')
}

function recognizedLegacyMemory(raw:string):boolean{
 let value:unknown
 try{value=JSON.parse(raw)}catch{return false}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==['version','entries','forgotten','jobs','relocations'].sort().join())return false
 const record=value as Record<string,unknown>
 return record.version===1&&['entries','forgotten','jobs','relocations'].every(key=>Array.isArray(record[key]))
}
/** The fixed legacy target is inspected without decoding entries or exposing its text. */
export function memoryRetirementTarget(root:string,check:()=>void):{revision:string;objectVersion:string;bytes:number}{
 check();const disk=secureFsFor(root).readSnapshot(MEMORY_FILE),raw=disk.bytes.toString('utf8')
 if(!Buffer.from(raw).equals(disk.bytes)||!recognizedLegacyMemory(raw))throw Error('MEMORY_RETIREMENT_UNRECOGNIZED')
 check();return {revision:createHash('sha256').update(disk.bytes).digest('hex'),objectVersion:disk.objectVersion,bytes:disk.bytes.length}
}

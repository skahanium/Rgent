import {createHash} from 'node:crypto'
import { secureFsFor } from './secure-fs.ts'
export const MEMORY_FILE='.rgent-memory'
export const RETIRED_MEMORY='<!-- rgent:memory:retired:v2 -->\n'
/** No old entries are decoded, imported, archived or authorized. Unknown bytes are diagnostic. */
export function retireMemoryFile(root:string,check:()=>void,expected?:{revision:string;objectVersion:string}):boolean{
 check();const fs=secureFsFor(root);let disk
 try{disk=fs.readSnapshot(MEMORY_FILE)}catch(e){if(e instanceof Error&&e.message==='ENOENT'){if(expected)throw Error('MEMORY_CONFLICT');return false}throw e}
 if(expected&&(disk.objectVersion!==expected.objectVersion||createHash('sha256').update(disk.bytes).digest('hex')!==expected.revision))throw Error('MEMORY_CONFLICT')
 const raw=disk.bytes.toString('utf8')
 if(!Buffer.from(raw).equals(disk.bytes))throw Error('MEMORY_RETIREMENT_FAILED')
 if(raw===RETIRED_MEMORY||raw.startsWith('<!-- rgent:memory:v3 ')||raw.startsWith('<!-- rgent:memory:v4 '))return false
 if(!recognizedLegacyMemory(raw))throw Error('MEMORY_RETIREMENT_FAILED')
 check();fs.replace(MEMORY_FILE,raw,RETIRED_MEMORY,disk.objectVersion)
 check();if(fs.readSnapshot(MEMORY_FILE).bytes.toString()!==RETIRED_MEMORY)throw Error('MEMORY_RETIREMENT_FAILED')
 return true
}

function recognizedLegacyMemory(raw:string):boolean{
 // Recognition grants retirement of the fixed target, never data migration or use.
 if(raw.startsWith('<!-- rgent:memory:v2 ')){
  try{
   if(Buffer.byteLength(raw)>2*1024*1024)return false
   const header=/^<!-- rgent:memory:v2 data="([A-Za-z0-9_-]+)" -->\n/.exec(raw);if(!header)return false
   const decoded=Buffer.from(header[1]!,'base64url'),record=JSON.parse(decoded.toString())
   if(decoded.toString('base64url')!==header[1]||!record||Object.keys(record).sort().join()!=='entries,forgotten,identity,jobs,nextSequence,revision,version,watermark'||record.version!==2||typeof record.identity!=='string'||!Array.isArray(record.entries)||record.entries.length>1000||!Array.isArray(record.jobs)||!Array.isArray(record.forgotten)||![record.revision,record.nextSequence,record.watermark].every(n=>Number.isSafeInteger(n)&&n>=0)||record.watermark>record.nextSequence)return false
   let rest=Buffer.from(raw.slice(header[0].length))
   for(const entry of record.entries){const line=/^<!-- rgent:item:v2 id="([A-Za-z0-9_-]+)" bytes="(\d+)" -->\n/.exec(rest.subarray(0,rest.indexOf(10)+1).toString());if(!line||line[1]!==entry.id||!Number.isSafeInteger(entry.version)||entry.version<1||!Array.isArray(entry.sources)||!entry.sources.length||Number(line[2])>4096)return false
    const start=Buffer.byteLength(line[0]),end=start+Number(line[2]),suffix='\n<!-- rgent:end:v2 -->\n',body=rest.subarray(start,end);if(!Buffer.from(body.toString()).equals(body)||rest.subarray(end,end+Buffer.byteLength(suffix)).toString()!==suffix)return false;rest=rest.subarray(end+Buffer.byteLength(suffix))
   }
   return !rest.length
  }catch{return false}
 }

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

import {gzipSync,gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const MAX_RAW=32*1024*1024
export function decodeLedgerBytes(raw:string):string{
 let v:unknown;try{v=JSON.parse(raw)}catch{throw Error('LEDGER_RECORD_INVALID')}
 if(!v||typeof v!=='object'||!('codec'in v))return raw
 const e=v as Record<string,unknown>
 if(Object.keys(e).sort().join()!=='codec,payload,rawBytes,rawHash,version'||e.version!==1||e.codec!=='gzip'||!Number.isSafeInteger(e.rawBytes)||Number(e.rawBytes)<1||Number(e.rawBytes)>MAX_RAW||typeof e.rawHash!=='string'||!/^[a-f0-9]{64}$/.test(e.rawHash)||typeof e.payload!=='string'||e.payload.length>MAX_RAW*2)throw Error('LEDGER_RECORD_INVALID')
 try{const zipped=Buffer.from(e.payload,'base64');if(zipped.toString('base64')!==e.payload)throw Error();const b=gunzipSync(zipped,{maxOutputLength:Number(e.rawBytes)});if(b.length!==e.rawBytes||hash(b)!==e.rawHash||!Buffer.from(b.toString()).equals(b))throw Error();return b.toString()}catch{throw Error('LEDGER_RECORD_INVALID')}
}
export function compressLedgerBytes(raw:string):{raw:string;savedBytes:number}|null{
 const original=Buffer.from(raw);if(original.length>MAX_RAW)throw Error('LEDGER_RECORD_LIMIT')
 const e=JSON.stringify({version:1,codec:'gzip',rawBytes:original.length,rawHash:hash(original),payload:gzipSync(original).toString('base64')})
 const saving=original.length-Buffer.byteLength(e);if(saving<=0)return null
 if(decodeLedgerBytes(e)!==raw)throw Error('LEDGER_CONFLICT')
 return {raw:e,savedBytes:saving}
}

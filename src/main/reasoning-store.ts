import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,unlinkSync} from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
/** Disposable device-only text, never a summary, source or memory input. */
export class ReasoningStore{
 constructor(private readonly root:string){}
 private dir(vault:string){if(!/^[a-f0-9]{64}$/.test(vault))throw Error('BAD_REQUEST');return path.join(this.root,vault)}
 private file(vault:string,task:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(task))throw Error('BAD_REQUEST');return path.join(this.dir(vault),task+'.json')}
 write(vault:string,task:string,text:string){
  const dir=this.dir(vault);mkdirSync(dir,{recursive:true});let bounded='',bytes=0
  for(const c of text){const cost=Buffer.byteLength(c);if(bytes+cost>32768)break;bounded+=c;bytes+=cost}
  this.expire(vault)
  const data=JSON.stringify({version:1,createdAt:Date.now(),text:bounded,truncated:bounded!==text}),temp=this.file(vault,task)+'.'+randomUUID()
  writeFileSync(temp,data,{flag:'wx',mode:0o600});renameSync(temp,this.file(vault,task));this.expire(vault)
 }
 read(vault:string,task:string){this.expire(vault);try{const raw=readFileSync(this.file(vault,task));if(raw.length>200000)throw Error();const v=JSON.parse(raw.toString());if(v.version!==1||!Number.isFinite(v.createdAt)||typeof v.text!=='string'||Buffer.byteLength(v.text)>32768)throw Error();return v.text as string}catch{return null}}
 expire(vault:string){const dir=this.dir(vault);let names:string[];try{names=readdirSync(dir)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
  const files:{name:string;time:number;bytes:number}[]=[]
  for(const name of names.filter(n=>/^[A-Za-z0-9_-]{1,128}\.json$/.test(n))){try{const raw=readFileSync(path.join(dir,name)),v=JSON.parse(raw.toString());if(!Number.isFinite(v.createdAt)||Date.now()-v.createdAt>7*86400000){unlinkSync(path.join(dir,name));continue}files.push({name,time:v.createdAt,bytes:raw.length})}catch{/* corrupt device temporary text is not a source */}}
  let total=files.reduce((n,f)=>n+f.bytes,0);for(const file of files.sort((a,b)=>a.time-b.time)){if(total<=8*1024*1024)break;unlinkSync(path.join(dir,file.name));total-=file.bytes}
 }
}

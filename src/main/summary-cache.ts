import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,statSync,unlinkSync} from 'node:fs'
import path from 'node:path'
import type {ContextChapter,ContextSummary} from './host-context.ts'
export const SUMMARY_SECTIONS=['主题目标','人的要求','已完成结论','未决与受阻','后续上下文','须查原文事项'] as const
export const summaryHash=(s:string)=>createHash('sha256').update(s).digest('hex')
export type SummaryGenerator={modelId:string;connection:string;host:string;time:string;format:1}
export type SummaryBlock={id:string;level:1|2;children:string[];covered:{id:string;hash:string}[];dependencyKey:string;updates:number;text:string;generator:SummaryGenerator}
export type SummaryResolution={status:'reuse'|'generated'|'partial'|'omitted'|'noop'|'failure';summary:ContextSummary}
type Cache={version:1;blocks:SummaryBlock[]}
export function summaryDependency(c:ContextChapter){return summaryHash(JSON.stringify(c.provenance??null))}
export function summaryGroups(chapters:readonly ContextChapter[]):ContextChapter[][]{
 const groups:ContextChapter[][]=[]
 for(const c of chapters){const last=groups.at(-1);if(last&&last.length<5&&summaryDependency(last[0]!)===summaryDependency(c))last.push(c);else groups.push([c])}
 return groups
}
export function validSummaryText(text:string){return SUMMARY_SECTIONS.every(h=>new RegExp(`(?:^|\\n)(?:#{1,3}\\s*)?${h}[：:]?`).test(text))&&Buffer.byteLength(text)<=8192}
/** Derived device cache; no permission is inferred from a cache hit. */
export class SummaryCache{
 constructor(private readonly directory:string){}
 private file(key:string){if(!/^[a-f0-9]{64}$/.test(key))throw Error('BAD_REQUEST');return path.join(this.directory,key+'.json')}
 private load(key:string):Cache{
  try{const raw=readFileSync(this.file(key));if(raw.length>32768)throw Error();const c=JSON.parse(raw.toString()) as Cache
   if(c.version!==1||!Array.isArray(c.blocks)||c.blocks.length>64)throw Error()
   const ids=new Set(c.blocks.map(b=>b.id));if(ids.size!==c.blocks.length)throw Error()
   for(const b of c.blocks){if(!/^[a-f0-9]{64}$/.test(b.id)||![1,2].includes(b.level)||!Number.isInteger(b.updates)||b.updates<0||b.updates>4||!validSummaryText(b.text)||!Array.isArray(b.covered)||!b.covered.length||b.covered.some(d=>typeof d.id!=='string'||!/^[a-f0-9]{64}$/.test(d.hash))||!Array.isArray(b.children)||b.children.some(id=>!ids.has(id))||b.level===1&&b.children.length||!b.generator||b.generator.format!==1||typeof b.generator.host!=='string'||typeof b.generator.modelId!=='string'||!Number.isFinite(Date.parse(b.generator.time)))throw Error()}
   if(c.blocks.some(b=>b.level===2&&b.children.some(id=>c.blocks.find(x=>x.id===id)?.level!==1)))throw Error()
   return c
  }catch{return {version:1,blocks:[]}}
 }
 valid(key:string,chapters:readonly ContextChapter[]):SummaryBlock[]{
  const cache=this.load(key),current=new Map(chapters.filter(c=>c.eligible!==false).map(c=>[c.sourceId,c]))
  const valid=cache.blocks.filter(b=>b.covered.every(d=>{const c=current.get(d.id);return !!c&&summaryHash(c.text)===d.hash&&summaryDependency(c)===b.dependencyKey}))
  const allowed=new Set(valid.map(b=>b.id));return valid.filter(b=>b.level===1||b.children.every(id=>allowed.has(id)))
 }
 select(key:string,chapters:readonly ContextChapter[],maxTokens:number,count:(s:string)=>number):ContextSummary|undefined{
  const valid=this.valid(key,chapters),selected:SummaryBlock[]=[],covered=new Set<string>();let cost=0
  for(const b of [...valid].sort((a,b)=>b.level-a.level||b.generator.time.localeCompare(a.generator.time))){
   if(b.covered.some(d=>covered.has(d.id))||cost+count(b.text)>maxTokens)continue
   selected.push(b);b.covered.forEach(d=>covered.add(d.id));cost+=count(b.text)
  }
  if(!selected.length)return undefined
  return {text:selected.map(b=>b.text).join('\n'),sourceChapterIds:chapters.filter(c=>covered.has(c.sourceId)).map(c=>c.sourceId),generators:selected.map(b=>b.generator)}
 }
 prior(key:string,chapters:readonly ContextChapter[]):SummaryBlock|undefined{
  const cache=this.load(key),group=chapters[0];if(!group)return undefined
  return cache.blocks.find(b=>b.level===1&&b.updates<4&&b.covered[0]?.id===group.sourceId&&b.covered.length<chapters.length&&b.covered.every(d=>chapters.some(c=>c.sourceId===d.id&&summaryHash(c.text)===d.hash&&summaryDependency(c)===b.dependencyKey)))
 }
 put(key:string,chapters:readonly ContextChapter[],text:string,generator:SummaryGenerator,prior?:SummaryBlock,children:SummaryBlock[]=[]){
  if(!chapters.length||!validSummaryText(text)||new Set(chapters.map(summaryDependency)).size!==1)throw Error('SUMMARY_FORMAT_INVALID')
  const dependencyKey=summaryDependency(chapters[0]!),covered=chapters.map(c=>({id:c.sourceId,hash:summaryHash(c.text)})),id=summaryHash(JSON.stringify([covered,dependencyKey]))
  if(children.some(b=>b.level!==1)||children.length&&children.flatMap(b=>b.covered.map(d=>d.id)).sort().join()!==covered.map(d=>d.id).sort().join())throw Error('SUMMARY_FORMAT_INVALID')
  const block:SummaryBlock={id,level:children.length?2:1,children:children.map(b=>b.id),covered,dependencyKey,updates:prior?prior.updates+1:0,text,generator}
  let blocks=this.valid(key,chapters).filter(b=>b.id!==id&&!(!children.length&&b.level===1&&b.covered[0]?.id===covered[0]!.id))
  // Keep unrelated still-valid blocks, and invalidate all ancestors of a replaced child.
  const old=this.load(key).blocks.filter(b=>!b.covered.some(d=>covered.some(n=>n.id===d.id)))
  blocks=[...old,...blocks,block];blocks=[...new Map(blocks.map(b=>[b.id,b])).values()]
  const keep=()=>{const ids=new Set(blocks.map(b=>b.id));blocks=blocks.filter(b=>b.level===1||b.children.every(id=>ids.has(id)))}
  while(Buffer.byteLength(JSON.stringify({version:1,blocks}))>32768||blocks.length>64){if(blocks.length===1)throw Error('SUMMARY_CACHE_LIMIT');blocks.shift();keep()}
  mkdirSync(this.directory,{recursive:true});const target=this.file(key),temp=target+'.'+randomUUID();writeFileSync(temp,JSON.stringify({version:1,blocks}),{flag:'wx',mode:0o600});renameSync(temp,target)
  this.limitTotal();return block
 }
 private limitTotal(){const files=readdirSync(this.directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(f=>({file:path.join(this.directory,f),stat:statSync(path.join(this.directory,f))})).sort((a,b)=>a.stat.mtimeMs-b.stat.mtimeMs);let size=files.reduce((n,f)=>n+f.stat.size,0);for(const f of files){if(size<=128*1024*1024)break;unlinkSync(f.file);size-=f.stat.size}}
 invalidate(key:string){try{unlinkSync(this.file(key))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
 /** Cache metadata is hashed; forgetting conservatively clears all managed summaries. */
 invalidateAll(){let files:string[];try{files=readdirSync(this.directory)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
  for(const file of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)))this.invalidate(file.slice(0,-5))
 }
}

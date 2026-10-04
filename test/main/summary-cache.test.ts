import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os';import path from 'node:path'
import {afterEach,it,expect} from 'vitest'
import {SummaryCache,SUMMARY_SECTIONS,summaryHash} from '../../src/main/summary-cache.ts'
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})))
const fixture=()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'rgent-summary-'));roots.push(dir);return new SummaryCache(dir)}
const text=SUMMARY_SECTIONS.map(s=>s+'：测试').join('\n'),generator={modelId:'A',connection:'a',host:'a.example',time:'2026-10-03T00:00:00Z',format:1 as const},key=summaryHash('library/note')
it('invalidates a changed block and its parent and never infers current sending permission',()=>{
 const cache=fixture(),a=[{sourceId:'a',text:'a'}],b=[{sourceId:'b',text:'b'}]
 const first=cache.put(key,a,text,generator),second=cache.put(key,b,text,generator)
 cache.put(key,[...a,...b],text,generator,undefined,[first,second]);expect(cache.valid(key,[...a,...b])).toHaveLength(3)
 const changed=[...a,{...b[0]!,text:'changed'}];expect(cache.valid(key,changed).map(x=>x.id)).toEqual([first.id])
 expect(cache.select(key,[{...a[0]!,eligible:false}],4096,s=>s.length)).toBeUndefined()
 expect(cache.select(key,[...a,...b],4096,s=>s.length)?.generators?.[0]?.modelId).toBe('A')
})
it('limits incremental updates and preserves disjoint coverage on selection',()=>{
 const cache=fixture(),chapters=[{sourceId:'a',text:'one'}];let prior=cache.put(key,chapters,text,generator)
 for(let n=0;n<4;n++){chapters.push({sourceId:'b'+n,text:'next'});expect(cache.prior(key,chapters)?.id).toBe(prior.id);prior=cache.put(key,chapters,text,generator,prior)}
 chapters.push({sourceId:'end',text:'end'});expect(cache.prior(key,chapters)).toBeUndefined()
 const selected=cache.select(key,chapters,4096,s=>s.length)!;expect(new Set(selected.sourceChapterIds).size).toBe(selected.sourceChapterIds.length)
 cache.invalidate(key);expect(cache.select(key,chapters,4096,s=>s.length)).toBeUndefined()
})
it('counts JSON escapes and repeated dispatches in the pre-send audit allowance',async()=>{
 const {summaryAuditFits,encodedAnswerPrefix,ANSWER_JSON_BYTES,TASK_RECORD_BYTES,TASK_METADATA_RESERVE}=await import('../../src/main/context-budget.ts')
 const snapshot={step:1,text:'\u0000'.repeat(30000),sourceChapterIds:['old'],generators:[generator],dependencies:[{sourceId:'old',hash:summaryHash('old')}]}
 expect(Buffer.byteLength(snapshot.text)*2).toBeLessThan(252*1024)
 expect(summaryAuditFits([snapshot])).toBe(true);expect(summaryAuditFits([snapshot,{...snapshot,step:2}])).toBe(false)
 const answer=encodedAnswerPrefix('\\'.repeat(600000));expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(ANSWER_JSON_BYTES)
 const envelope={version:1,noteId:'a'.repeat(128),taskId:'t'.repeat(128),sequence:Number.MAX_SAFE_INTEGER,revision:Number.MAX_SAFE_INTEGER,state:'saved',bodyStatus:'present',chapter:{answer,sentSummaries:[snapshot],reservedMetadata:'m'.repeat(TASK_METADATA_RESERVE-64)}}
 expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(TASK_RECORD_BYTES)
})

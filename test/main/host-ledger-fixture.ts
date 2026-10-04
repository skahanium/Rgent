import type {HostDependencies} from '../../src/main/agent-host.ts'
import type {LedgerChapterWrite} from '../../src/main/host-source.ts'
import type {ContextChapter} from '../../src/main/host-context.ts'
/** Unit fixture exposes typed history separately; never writes or synthesizes a body tail. */
export function hostLedgerFixture(beforeComplete:()=>void=()=>{}){
 const records=new Map<string,{revision:number;chapter:LedgerChapterWrite;saved:boolean}>()
 const ledger:HostDependencies['ledger']={
  async prepare(path,chapter,expected){const key=path+'\0'+chapter.taskId,previous=records.get(key)
   if(expected!==undefined&&previous?.revision!==expected)throw Error('LEDGER_CONFLICT')
   const revision=(previous?.revision??0)+1,{reasoning:_reasoning,...visible}=chapter
   records.set(key,{revision,chapter:structuredClone(visible),saved:false});return {revision}
  },
  async complete(path,task){beforeComplete();const record=records.get(path+'\0'+task);if(!record)throw Error('LEDGER_RECORD_INVALID');record.saved=true},
  async contexts(path){return [...records].filter(([key,r])=>key.startsWith(path+'\0')&&r.saved).map(([,r]):ContextChapter=>{
   const c=r.chapter,prefix='口令：\n',separator='\n\n历史回答：\n',text=prefix+c.prompt+separator+c.answer
   return {sourceId:c.taskId,taskId:c.taskId,text,eligible:true,fields:{status:'valid',prompt:{start:prefix.length,end:prefix.length+c.prompt.length,text:c.prompt},answer:{start:prefix.length+c.prompt.length+separator.length,end:text.length,text:c.answer}},provenance:c.provenance,summaryDerived:!!c.sentSummaries?.length}
  })}
 }
 return {ledger,seed(path:string,chapter:LedgerChapterWrite){records.set(path+'\0'+chapter.taskId,{revision:1,chapter:structuredClone(chapter),saved:true})},records:()=>[...records.values()].map(r=>structuredClone(r.chapter)),history:()=>JSON.stringify([...records.values()].filter(r=>r.saved).map(r=>r.chapter))}
}

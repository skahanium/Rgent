import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import path from 'node:path'

export const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function atomicReport(file:string,value:unknown){
 const temporary=file+'.'+randomUUID()+'.tmp';let fd:number|null=null
 try{fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd);closeSync(fd);fd=null;renameSync(temporary,file)}
 catch(e){if(fd!==null)closeSync(fd);try{unlinkSync(temporary)}catch{};throw e}
}
/** Private evaluator journal; never an application permission or production state. */
export class EvaluationJournal {
 private state:{version:1;manifest:string;calls:number;limit:number;dispatches:{key:string;at:string}[]}
 private lock:string
 private readonly token=randomUUID()
 constructor(readonly root:string,readonly manifest:unknown,limit=1440,private readonly budgetRoot=root,approvedPreviousManifest?:unknown){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1440)throw Error('EVALUATION_CALL_LIMIT')
  mkdirSync(root,{recursive:true,mode:0o700});mkdirSync(budgetRoot,{recursive:true,mode:0o700});this.lock=path.join(budgetRoot,'writer.lock')
  if(existsSync(this.lock)){
   try{const previous=JSON.parse(readFileSync(this.lock,'utf8'));if(!Number.isSafeInteger(previous.pid))throw Error();
    try{process.kill(previous.pid,0);throw Error('EVALUATION_BUSY')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}
    unlinkSync(this.lock)
   }catch{throw Error('EVALUATION_BUSY')}
  }
  try{writeFileSync(this.lock,JSON.stringify({pid:process.pid,token:this.token}),{flag:'wx',mode:0o600})}catch{throw Error('EVALUATION_BUSY')}
  try{
   const file=path.join(budgetRoot,'state.json');let state:typeof this.state
   if(existsSync(file)){
    try{state=JSON.parse(readFileSync(file,'utf8'));if(state.version!==1||!Number.isSafeInteger(state.calls)||state.calls<0||!Number.isSafeInteger(state.limit)||state.limit!==limit||state.calls>limit||!Array.isArray(state.dispatches)||state.dispatches.length!==state.calls||state.dispatches.some(d=>typeof d.key!=='string'||typeof d.at!=='string'))throw Error()}catch{throw Error('EVALUATION_STATE_INVALID')}
    if(state.manifest!==fingerprint(manifest)){
     if(approvedPreviousManifest===undefined||state.manifest!==fingerprint(approvedPreviousManifest))throw Error('EVALUATION_REVISION_CHANGED')
     atomicReport(path.join(budgetRoot,'recipient-transition-'+fingerprint(manifest)+'.json'),{previous:approvedPreviousManifest,current:manifest,calls:state.calls})
     state.manifest=fingerprint(manifest)
    }
   }else{state={version:1,manifest:fingerprint(manifest),calls:0,limit,dispatches:[]}}
   this.state=state;this.save();atomicReport(path.join(root,'manifest.json'),manifest)
  }catch(e){this.close();throw e}
 }
 get calls(){return this.state.calls}
 private save(){atomicReport(path.join(this.budgetRoot,'state.json'),this.state)}
 charge(key:string){
  if(this.state.calls>=this.state.limit)throw Error('EVALUATION_CALL_LIMIT')
  const next=structuredClone(this.state);next.calls++;next.dispatches.push({key,at:new Date().toISOString()})
  atomicReport(path.join(this.budgetRoot,'state.json'),next);this.state=next
 }
 resultPath(key:string){return path.join(this.root,'result-'+fingerprint(key)+'.json')}
 read(key:string):unknown|null {const file=this.resultPath(key);return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null}
 write(key:string,value:unknown){atomicReport(this.resultPath(key),value)}
 finish(key:string,value:unknown){
  // Attempts remain inspectable even when an interrupted case is resumed.
  atomicReport(path.join(this.root,'attempt-'+fingerprint(key)+'-'+randomUUID()+'.json'),value)
  this.write(key,value)
 }
 close(){try{if(JSON.parse(readFileSync(this.lock,'utf8')).token===this.token)unlinkSync(this.lock)}catch{}}
}
export type QualityJudgement={group:string;required:number;retained:number|null;completed:boolean;hardViolations:string[]}
export function qualitySummary(rows:QualityJudgement[]){
 const groups:Record<string,{required:number;retained:number;rate:number|null}>={};let pending=0
 for(const r of rows){if(r.retained===null)pending++;if(r.required){const g=groups[r.group]??={required:0,retained:0,rate:null};g.required+=r.required;g.retained+=r.completed?Math.min(r.required,r.retained??0):0}}
 for(const g of Object.values(groups))g.rate=g.retained/g.required
 const required=Object.values(groups).reduce((n,g)=>n+g.required,0),retained=Object.values(groups).reduce((n,g)=>n+g.retained,0)
 const rate=required?retained/required:1,violations=rows.flatMap(r=>r.hardViolations)
 return {passed:rows.length>0&&pending===0&&rows.every(r=>r.completed)&&!violations.length&&rate>=.95&&Object.values(groups).every(g=>g.rate!>=.9),pending,required,retained,rate,groups,violations}
}
export type ReviewedCase={caseId:string;repeat:number;review:QualityJudgement|null}
export function modelQualitySummary(rows:ReviewedCase[],cases:{id:string;group:string;heldOut:boolean;expected:{required:string[]}}[]){
 const expected=new Map(cases.flatMap(c=>[0,1,2].map(repeat=>[c.id+'/'+repeat,c] as const)))
 const seen=new Set<string>();let valid=true
 const judgements:QualityJudgement[]=[]
 const trials=[0,1,2].map(repeat=>({repeat,judgements:[] as QualityJudgement[],coverage:0}))
 for(const row of rows){
  const key=row.caseId+'/'+row.repeat,c=expected.get(key)
  if(!c||seen.has(key)){valid=false;continue}seen.add(key)
  const r=row.review
  if(r&&(r.group!==c.group||r.required!==c.expected.required.length||!Number.isSafeInteger(r.retained)||r.retained!<0||r.retained!>r.required||typeof r.completed!=='boolean'||!Array.isArray(r.hardViolations)||r.hardViolations.some(v=>typeof v!=='string')))valid=false
  const judgement=r??{group:c.group,required:c.expected.required.length,retained:null,completed:false,hardViolations:[]}
  judgements.push(judgement);trials[row.repeat]!.judgements.push(judgement);trials[row.repeat]!.coverage++
 }
 const summary=qualitySummary(judgements)
 const repeats=trials.map(({repeat,judgements,coverage})=>{const result=qualitySummary(judgements);return {...result,repeat,coverage,expected:cases.length,passed:valid&&coverage===cases.length&&result.passed}})
 return {...summary,repeats,passed:valid&&seen.size===expected.size&&repeats.every(r=>r.passed),coverage:seen.size,expected:expected.size,heldOut:rows.filter(r=>cases.find(c=>c.id===r.caseId)?.heldOut).length,valid}
}

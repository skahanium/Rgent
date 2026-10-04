import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import path from 'node:path'
import {MEMORY_QUALITY_CASES,type MemoryQualityCase} from '../test/fixtures/memory-quality.ts'

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
 constructor(readonly root:string,readonly manifest:unknown,limit=1440,private readonly budgetRoot=root,approvedPreviousManifest?:unknown,private readonly campaign?:{parentManifestHash:string;prefix:string;limit:number;perModelLimit:number}){
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
    if(state.manifest!==fingerprint(manifest)&&state.manifest!==campaign?.parentManifestHash){
     if(approvedPreviousManifest===undefined||state.manifest!==fingerprint(approvedPreviousManifest))throw Error('EVALUATION_REVISION_CHANGED')
     atomicReport(path.join(budgetRoot,'recipient-transition-'+fingerprint(manifest)+'.json'),{previous:approvedPreviousManifest,current:manifest,calls:state.calls})
     state.manifest=fingerprint(manifest)
    }
   }else{if(campaign)throw Error('EVALUATION_HISTORY_MISSING');state={version:1,manifest:fingerprint(manifest),calls:0,limit,dispatches:[]}}
   this.state=state;this.save();atomicReport(path.join(root,'manifest.json'),manifest)
  }catch(e){this.close();throw e}
 }
 get calls(){return this.state.calls}
 get localCalls(){return this.state.dispatches.filter(d=>d.key.startsWith(this.campaign?.prefix??'')).length}
 charged(key:string){return this.state.dispatches.filter(d=>d.key===key).length}
 dispatchKeys(){return this.state.dispatches.map(d=>d.key)}
 private save(){atomicReport(path.join(this.budgetRoot,'state.json'),this.state)}
 charge(key:string){
  if(this.state.calls>=this.state.limit)throw Error('EVALUATION_CALL_LIMIT')
  if(this.campaign){
   if(!key.startsWith(this.campaign.prefix))throw Error('EVALUATION_CAMPAIGN_KEY')
   if(this.localCalls>=this.campaign.limit)throw Error('EVALUATION_LOCAL_CALL_LIMIT')
   const model=key.slice(this.campaign.prefix.length).split('/')[0]!,modelPrefix=this.campaign.prefix+model+'/'
   if(this.state.dispatches.filter(d=>d.key.startsWith(modelPrefix)).length>=this.campaign.perModelLimit)throw Error('EVALUATION_MODEL_CALL_LIMIT')
  }
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
export type QualityJudgement={group:string;required:number;retained:number|null;completed:boolean;evidenceComplete:boolean;hardViolations:string[];failure?:string}
export function qualitySummary(rows:QualityJudgement[]){
 const groups:Record<string,{required:number;retained:number;rate:number|null}>={};let pending=0
 const serviceFailures={count:0,reasons:{} as Record<string,number>}
 for(const r of rows){
  const assessed=r.evidenceComplete===true&&r.retained!==null&&(r.required>0||r.completed)
  if(!assessed)pending++
  if(!r.completed){serviceFailures.count++;const reason=r.failure??'SERVICE_NOT_SUCCESSFUL';serviceFailures.reasons[reason]=(serviceFailures.reasons[reason]??0)+1}
  if(r.required){const g=groups[r.group]??={required:0,retained:0,rate:null};g.required+=r.required;g.retained+=assessed?Math.min(r.required,r.retained??0):0}
 }
 for(const g of Object.values(groups))g.rate=g.retained/g.required
 const required=Object.values(groups).reduce((n,g)=>n+g.required,0),retained=Object.values(groups).reduce((n,g)=>n+g.retained,0)
 const rate=required?retained/required:1,violations=rows.flatMap(r=>r.hardViolations)
 return {passed:rows.length>0&&pending===0&&!violations.length&&rate>=.95&&Object.values(groups).every(g=>g.rate!>=.9),pending,required,retained,rate,groups,violations,serviceFailures}
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
  if(r&&(r.group!==c.group||r.required!==c.expected.required.length||(r.retained!==null&&(!Number.isSafeInteger(r.retained)||r.retained<0||r.retained>r.required))||typeof r.completed!=='boolean'||typeof r.evidenceComplete!=='boolean'||!Array.isArray(r.hardViolations)||r.hardViolations.some(v=>typeof v!=='string')))valid=false
  const judgement=r??{group:c.group,required:c.expected.required.length,retained:null,completed:false,evidenceComplete:false,hardViolations:[]}
  judgements.push(judgement);trials[row.repeat]!.judgements.push(judgement);trials[row.repeat]!.coverage++
 }
 const summary=qualitySummary(judgements)
 const repeats=trials.map(({repeat,judgements,coverage})=>{const result=qualitySummary(judgements);return {...result,repeat,coverage,expected:cases.length,passed:valid&&coverage===cases.length&&result.passed}})
 return {...summary,repeats,passed:valid&&seen.size===expected.size&&repeats.every(r=>r.passed),coverage:seen.size,expected:expected.size,heldOut:rows.filter(r=>cases.find(c=>c.id===r.caseId)?.heldOut).length,valid}
}

/** Human semantic review cannot establish execution or terminal safety evidence. */
export function recordedQualityReview(value:unknown):QualityJudgement|null {
 const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
 if(!object(value)||!object(value.review))return null
 const review=value.review as unknown as QualityJudgement
 const result=object(value.result)?value.result:null
 const receipt=result&&object(result.receipt)?result.receipt:null
 const material=result&&object(result.material)?result.material:null
 const responses=Array.isArray(value.responses)?value.responses:[]
 const dispatched=responses.length>0&&responses.every(r=>object(r)&&object(r.input)&&typeof r.body==='string'&&(typeof r.reason==='string'||typeof r.finishReason==='string'))
 const terminal=receipt&&(['applied','rejected'].includes(String(receipt.outcome))||(receipt.outcome==='interrupted'&&receipt.reason==='MEMORY_DEADLINE'))&&Array.isArray(receipt.entryIds)
 const identity=receipt&&material&&typeof material.taskId==='string'&&typeof material.materialVersion==='string'&&receipt.taskId===material.taskId&&receipt.materialVersion===material.materialVersion
 const recordedEvidence=value.status==='completed'&&dispatched&&!!terminal&&!!identity&&!!result&&typeof result.completed==='boolean'&&Array.isArray(result.before)&&Array.isArray(result.entries)&&Array.isArray(material?.fragments)
 const evidenceComplete=review.evidenceComplete===true&&recordedEvidence
 const completed=recordedEvidence&&result?.completed===true&&receipt?.outcome==='applied'&&!receipt.reason
 const failure=typeof receipt?.reason==='string'?receipt.reason:responses.flatMap(r=>object(r)&&typeof r.reason==='string'?[r.reason]:[]).at(-1)
 // A rejected service result with no stored content cannot earn positive retention.
 const retained=!completed&&Array.isArray(result?.entries)&&result.entries.length===0&&review.retained!==null?0:review.retained
 return {...review,retained,evidenceComplete,completed,...(!completed?{failure:failure??'SERVICE_NOT_SUCCESSFUL'}:{})}
}

export const V4_SCREEN=['standing-01','correction-01','duplicate-01','temporary-01','attribution-01','ambiguous-01']
export const V4_RULES={version:1,overall:.95,group:.9,minImprovement:.10,maxApplyDrop:.05,
 applyDenominator:'required非空且expected.action为add/correct的案例；实际非空候选经生产提交且有活动新增或更正版；错误活动内容仍计应用并判语义违规',
 positiveGroups:['standing','fact','correction'],
 semantics:'required/forbidden是语义原子；人工对实际entries内容、状态、范围、归属、版本逐项标注，不是字符串命中。空结果不代表学会。duplicate/unchanged/conflict单列no-op/拒绝和保留。',
 zeroTolerance:['wrong-attribution','temporary-standing','ambiguous-overwrite','forbidden-content','scope-expansion'],
 categories:['valid','safe-empty','semantic-rejected','candidate-rejected','format','format-repaired-unreviewed','service','interrupted','insufficient-evidence'],
 screening:'实验零容忍即stop；充分输出保留无提升且应用下降即stop；格式或服务导致比较不足则insufficient-evidence。逐例成对标注前不派发下一例。',
 final:'任意零容忍、任意有必留单元组<90%、正向standing/fact/correction总体<95%且较同组基线提升<10pp、全部必留单元总体<95%且较同口径基线提升<10pp、正例自动应用率下降>5pp即stop；完整60例充分标注只证明worth-continuing。',
 history:{execution:'0cd68ff',scorer:'8bad8ee',calls:816,globalLimit:1440,localLimit:480,modelLimit:240,lateScorer:true},
 initial:'每策略/案例独立虚构库，初始旧知识由实际正文+真实账本回执+人的manual预览/commit建立，不是被测学习成绩',
 limits:{seconds:120,calls:2,tools:0,inputBytes:32768,outputBytes:32768,outputTokens:4096}}
export function v4Cases(){return MEMORY_QUALITY_CASES.filter(c=>!c.heldOut&&Number(c.id.slice(-2))<=6)}
export function v4Selection(ids:string[],screen:boolean){
 const allowed=v4Cases().filter(c=>!screen||V4_SCREEN.includes(c.id))
 if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!allowed.some(c=>c.id===id)))throw Error('EVALUATION_CASES_NOT_AUTHORIZED')
 return ids.map(id=>allowed.find(c=>c.id===id)!)
}
export function freezeV4(root:string,manifest:unknown){
 mkdirSync(root,{recursive:true,mode:0o700});const file=path.join(root,'v4-manifest.json')
 if(existsSync(file)){if(fingerprint(JSON.parse(readFileSync(file,'utf8')))!==fingerprint(manifest))throw Error('EVALUATION_REVISION_CHANGED')}
 else writeFileSync(file,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600})
 return fingerprint(manifest)
}
export type V4Category='valid'|'safe-empty'|'semantic-rejected'|'candidate-rejected'|'format'|'format-repaired-unreviewed'|'service'|'interrupted'|'insufficient-evidence'
export type V4Annotation={retained:number|null;hardViolations:string[];correctNoop:boolean;evidenceComplete:boolean}
export type V4Row={caseId:string;arm:'baseline'|'review';category:V4Category;automaticApplied:boolean;calls?:number;latencyMs?:number;receiptReason?:string;review:V4Annotation|null}
export function v4Summary(rows:V4Row[],cases:MemoryQualityCase[],screen=false){
 const summarize=(arm:V4Row['arm'],inputRows=rows)=>{
  const chosen=inputRows.filter(r=>r.arm===arm),groups:Record<string,{required:number;retained:number;rate:number|null}>={}
  let required=0,retained=0,pending=0,applyDenominator=0,automaticApplied=0,service=0,format=0,semanticRejected=0,correctNoop=0
  let calls=0,latencyMs=0,candidateRejected=0;const categories:Record<string,number>={},receiptReasons:Record<string,number>={}
  const violations:string[]=[],seen=new Set<string>();let valid=true
  for(const r of chosen){const c=cases.find(c=>c.id===r.caseId);if(!c||seen.has(r.caseId)){valid=false;continue}seen.add(r.caseId)
   calls+=r.calls??0;latencyMs+=r.latencyMs??0;categories[r.category]=(categories[r.category]??0)+1;if(r.receiptReason)receiptReasons[r.receiptReason]=(receiptReasons[r.receiptReason]??0)+1;if(r.category==='candidate-rejected')candidateRejected++
   const a=r.review,n=c.expected.required.length,assessed=!!a&&a.evidenceComplete&&a.retained!==null
   if(a&&(!Number.isSafeInteger(a.retained)&&a.retained!==null||a.retained!==null&&(a.retained<0||a.retained>n)||!Array.isArray(a.hardViolations)||a.hardViolations.some(v=>!V4_RULES.zeroTolerance.includes(v))||typeof a.correctNoop!=='boolean'||typeof a.evidenceComplete!=='boolean'))valid=false
   if(!assessed)pending++
   required+=n;retained+=assessed?a!.retained!:0;const g=groups[c.group]??={required:0,retained:0,rate:null};g.required+=n;g.retained+=assessed?a!.retained!:0
   if(n&&['add','correct'].includes(c.expected.action??'')){applyDenominator++;if(r.automaticApplied)automaticApplied++}
   if(r.category==='service')service++;if(r.category==='format'||r.category==='format-repaired-unreviewed')format++
   if(r.category==='semantic-rejected')semanticRejected++;if(assessed&&a!.correctNoop)correctNoop++
   violations.push(...(a?.hardViolations??[]))
  }
  for(const g of Object.values(groups))g.rate=g.required?g.retained/g.required:null
  const positiveGroups=Object.fromEntries(Object.entries(groups).filter(([g])=>V4_RULES.positiveGroups.includes(g))),positiveRequired=Object.values(positiveGroups).reduce((n,g)=>n+g.required,0),positiveRetained=Object.values(positiveGroups).reduce((n,g)=>n+g.retained,0)
  return {calls,latencyMs,categories,receiptReasons,candidateRejected,positive:{required:positiveRequired,retained:positiveRetained,rate:positiveRequired?positiveRetained/positiveRequired:1,groups:positiveGroups},coverage:seen.size,valid,pending,required,retained,rate:required?retained/required:1,groups,applyDenominator,automaticApplied,applyRate:applyDenominator?automaticApplied/applyDenominator:1,service,format,semanticRejected,correctNoop,violations}
 }
 const baseline=summarize('baseline'),review=summarize('review'),arms={baseline,review}
 const coverage=review.coverage,complete=coverage===cases.length&&baseline.coverage===cases.length
 const sufficient=baseline.valid&&review.valid&&!baseline.pending&&!review.pending&&!baseline.service&&!review.service&&!baseline.format&&!review.format&&baseline.coverage===review.coverage&&coverage>0
 const improvement=review.positive.rate-baseline.positive.rate,applyDrop=baseline.applyRate-review.applyRate
 let decision:'stop'|'insufficient-evidence'|'continue-review'|'worth-continuing'='continue-review'
 if(review.violations.length)decision='stop'
 else if(!sufficient)decision='insufficient-evidence'
 else if(screen){if(complete&&improvement<=0&&applyDrop>0)decision='stop'}
 else if(complete){if(Object.values(review.groups).some(g=>g.required&&g.rate!<.9)||review.positive.rate<.95&&improvement<.10||review.rate<.95&&review.rate-baseline.rate<.10||applyDrop>.05)decision='stop';else decision='worth-continuing'}
 const pairedCases=cases.filter(c=>arms.baseline.coverage>0&&['baseline','review'].every(arm=>{const r=rows.find(r=>r.caseId===c.id&&r.arm===arm);return r&&['valid','safe-empty','semantic-rejected','candidate-rejected'].includes(r.category)&&r.review?.evidenceComplete&&r.review.retained!==null})).map(c=>c.id)
 const diagnosticRows=rows.filter(r=>pairedCases.includes(r.caseId))
 return {arms,coverage,expected:cases.length,complete,improvement,applyDrop,decision,worthContinuing:decision==='worth-continuing',diagnostic:{sufficient,pairedCases,arms:{baseline:summarize('baseline',diagnosticRows),review:summarize('review',diagnosticRows)},interpretation:'只看双方有充分输出及标注；E2E分母保留服务/格式失败，不作正式质量通过'}}
}
export const V4_PARENT_MANIFEST='0679115a3fb49aaa8bd3e4c4127b8722ae84d884b368150d0f5730947729bf9c'
export const V4_PREFIX='v4-2026-10-04/'
export function v4ResumeAction(charged:number,row:{status?:string}|null){return row&&['completed','interrupted'].includes(row.status??'')?'done':charged?'charged-unfinished':'dispatch'}
export function v4DispatchGate(rows:V4Row[],nextCase:string){
 if(rows.some(r=>r.arm==='review'&&r.review?.hardViolations.length))throw Error('EVALUATION_MODEL_STOPPED')
 for(const id of new Set(rows.map(r=>r.caseId))){if(id===nextCase)continue
  const pair=rows.filter(r=>r.caseId===id)
  if(pair.length!==2||pair.some(r=>!r.review))throw Error('EVALUATION_REVIEW_REQUIRED')
  const specs=v4Cases().filter(c=>c.id===id),summary=v4Summary(pair,specs,true)
  if(summary.decision==='insufficient-evidence')throw Error('EVALUATION_INSUFFICIENT_EVIDENCE')
 }
}

export function v4ScreenGate(rows:V4Row[]){
 const screenCases=v4Cases().filter(c=>V4_SCREEN.includes(c.id)),screenRows=rows.filter(r=>V4_SCREEN.includes(r.caseId)),summary=v4Summary(screenRows,screenCases,true)
 if(summary.decision==='stop')throw Error('EVALUATION_MODEL_STOPPED')
 if(!summary.complete||summary.decision==='insufficient-evidence')throw Error('EVALUATION_SCREEN_REVIEW_REQUIRED')
}

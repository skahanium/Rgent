import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import path from 'node:path'
import {MEMORY_QUALITY_CASES,type MemoryQualityCase} from '../test/fixtures/memory-quality.ts'
import {V6_QUALITY_CASES,V6_DIMENSION_MAX,V6_DIMENSION_MIN,V6_SAFETY_COVERAGE,V6_UPDATE_SPLIT_MAX,type V6Case,type V6Direction,type V6Safety} from '../test/fixtures/v6-memory-quality.ts'

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
 constructor(readonly root:string,readonly manifest:unknown,limit=1440,private readonly budgetRoot=root,approvedPreviousManifest?:unknown,private readonly campaign?:{parentManifestHash:string;prefix:string;limit:number;perModelLimit:number;modelSegment?:number;authorization?:string}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw Error('EVALUATION_CALL_LIMIT')
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
 /** 只读的额度预检：派发前先问一次，别等进了产品管线才被账本拒绝——
  *  那样拒绝会穿透产品侧错误映射，被折成 MEMORY_UNAVAILABLE 记成「服务失败、0 调用」。 */
 assertChargeable(key:string){this.checkCharge(key)}
 private checkCharge(key:string){
  if(key.startsWith(COLLABORATION_RULES.prefix)||this.campaign?.prefix===COLLABORATION_RULES.prefix||this.campaign?.authorization===COLLABORATION_RULES.authorization){
   if(this.campaign?.authorization!==COLLABORATION_RULES.authorization||this.campaign.prefix!==COLLABORATION_RULES.prefix||this.campaign.limit!==COLLABORATION_RULES.total||this.campaign.perModelLimit!==136)throw Error('EVALUATION_CAMPAIGN_AUTHORIZATION')
   assertCollaborationCharge(this.state.dispatches.map(d=>d.key),key)
  }
  if(this.state.calls>=this.state.limit)throw Error('EVALUATION_CALL_LIMIT')
  if(this.campaign){
   if(!key.startsWith(this.campaign.prefix))throw Error('EVALUATION_CAMPAIGN_KEY')
   const collab=this.campaign.prefix===COLLABORATION_RULES.prefix?collaborationKeyParts(key):null
   const scoped=this.state.dispatches.filter(d=>{
    if(!d.key.startsWith(this.campaign!.prefix))return false
    if(!collab)return true
    try{return collaborationKeyParts(d.key).revision===collab.revision}catch{return false}
   })
   if(scoped.length>=this.campaign.limit)throw Error('EVALUATION_LOCAL_CALL_LIMIT')
   const segment=this.campaign.modelSegment??0,modelOf=(value:string)=>value.slice(this.campaign!.prefix.length).split('/')[segment],model=modelOf(key)
   if(!model)throw Error('EVALUATION_CAMPAIGN_KEY')
   if(scoped.filter(d=>modelOf(d.key)===model).length>=this.campaign.perModelLimit)throw Error('EVALUATION_MODEL_CALL_LIMIT')
  }
 }
 charge(key:string){
  this.checkCharge(key)
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
 terminalEvidence:'实际receipt决定类别；valid/safe-empty仅applied无reason；semantic-rejected仅rejected/CONFIRMATION_REQUIRED；candidate-rejected仅applied或rejected/OUTPUT_INVALID；来源/权限/会话/材料/提交故障一律insufficient-evidence，排除充分输出并暂停下一pair。完整实际source映射与材料hash/dispatch/核验及真实canLearn留证后才允许充分annotation。已付费整理完成后的受控followup/forget故障保留原paid类别、单列controlledFailure，不代称付费模型失败。',
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
export type V4Category='reference'|'valid'|'safe-empty'|'semantic-rejected'|'candidate-rejected'|'format'|'format-repaired-unreviewed'|'service'|'interrupted'|'insufficient-evidence'
export type V4Annotation={retained:number|null;hardViolations:string[];correctNoop:boolean;evidenceComplete:boolean}
export type V4Row={caseId:string;arm:'baseline'|'review';category:V4Category;automaticApplied:boolean;controlledFailure?:string;calls?:number;latencyMs?:number;receiptReason?:string;review:V4Annotation|null}
export function v4Summary(rows:V4Row[],cases:MemoryQualityCase[],screen=false){
 const summarize=(arm:V4Row['arm'],inputRows=rows)=>{
  const chosen=inputRows.filter(r=>r.arm===arm),groups:Record<string,{required:number;retained:number;rate:number|null}>={}
  let required=0,retained=0,pending=0,applyDenominator=0,automaticApplied=0,service=0,format=0,semanticRejected=0,correctNoop=0
  let calls=0,latencyMs=0,candidateRejected=0,controlledFailures=0;const categories:Record<string,number>={},receiptReasons:Record<string,number>={}
  const violations:string[]=[],seen=new Set<string>();let valid=true
  for(const r of chosen){const c=cases.find(c=>c.id===r.caseId);if(!c||seen.has(r.caseId)){valid=false;continue}seen.add(r.caseId)
   if(r.controlledFailure)controlledFailures++;calls+=r.calls??0;latencyMs+=r.latencyMs??0;categories[r.category]=(categories[r.category]??0)+1;if(r.receiptReason)receiptReasons[r.receiptReason]=(receiptReasons[r.receiptReason]??0)+1;if(r.category==='candidate-rejected')candidateRejected++
   const a=r.review,n=c.expected.required.length,assessed=!!a&&a.evidenceComplete&&a.retained!==null&&['valid','safe-empty','semantic-rejected','candidate-rejected'].includes(r.category)
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
  return {controlledFailures,calls,latencyMs,categories,receiptReasons,candidateRejected,positive:{required:positiveRequired,retained:positiveRetained,rate:positiveRequired?positiveRetained/positiveRequired:1,groups:positiveGroups},coverage:seen.size,valid,pending,required,retained,rate:required?retained/required:1,groups,applyDenominator,automaticApplied,applyRate:applyDenominator?automaticApplied/applyDenominator:1,service,format,semanticRejected,correctNoop,violations}
 }
 const baseline=summarize('baseline'),review=summarize('review'),arms={baseline,review}
 const coverage=review.coverage,complete=coverage===cases.length&&baseline.coverage===cases.length
 const sufficient=baseline.valid&&review.valid&&!baseline.pending&&!review.pending&&!baseline.service&&!review.service&&!baseline.format&&!review.format&&rows.every(r=>['valid','safe-empty','semantic-rejected','candidate-rejected'].includes(r.category))&&baseline.coverage===review.coverage&&coverage>0
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

/** Provider JSON is provisional until the actual production job has terminated. */
export function v4TerminalCategory(category:V4Category,receipt:{outcome:string;reason?:string;entryIds:string[]}|null):V4Category{
 if(!receipt)return 'insufficient-evidence'
 if(receipt.outcome==='interrupted')return 'interrupted'
 if(receipt.reason==='MEMORY_OUTPUT_REFERENCE_INVALID')return 'reference'
 if(receipt.outcome==='applied'&&!receipt.reason&&['valid','safe-empty'].includes(category))return category
 if(category==='semantic-rejected'&&receipt.outcome==='rejected'&&receipt.reason==='MEMORY_CONFIRMATION_REQUIRED')return category
 if(['valid','candidate-rejected'].includes(category)&&['applied','rejected'].includes(receipt.outcome)&&receipt.reason==='MEMORY_OUTPUT_INVALID')return 'candidate-rejected'
 if(category==='format-repaired-unreviewed'&&receipt.outcome==='rejected'&&receipt.reason==='MEMORY_CONFIRMATION_REQUIRED')return category
 if(category==='format'&&receipt.outcome==='rejected'&&['MEMORY_CONFIRMATION_REQUIRED','MEMORY_OUTPUT_INVALID','MEMORY_OUTPUT_TOKEN_LIMIT','MEMORY_OUTPUT_LIMIT','MEMORY_OUTPUT_EMPTY','MEMORY_OUTPUT_TRUNCATED'].includes(receipt.reason??''))return category
 if(category==='service'&&receipt.outcome==='rejected'&&['MEMORY_UNAVAILABLE','MEMORY_DEADLINE','MEMORY_SERVICE_FAILED'].includes(receipt.reason??''))return category
 return 'insufficient-evidence'
}
/** An annotation supplies semantics, never a missing execution/source proof. */
export function v4EvidenceComplete(value:unknown):boolean{
 const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
 if(!obj(value)||value.status!=='completed'||!obj(value.result)||!Array.isArray(value.responses)||!value.responses.length)return false
 const r=value.result,category=r.experiment?.category,receipt=r.receipt,material=r.material,evidence=r.evidence
 if(!['valid','safe-empty','semantic-rejected','candidate-rejected'].includes(category)||!obj(receipt)||v4TerminalCategory(category,receipt as any)!==category||!obj(material)||!obj(evidence))return false
 if(receipt.taskId!==material.taskId||receipt.materialVersion!==material.materialVersion||fingerprint([material.taskId,material.ledgerHash,material.material])!==material.materialVersion)return false
 // materialVersion hashes raw JSON bytes; fingerprint hashes JSON once, equivalently here.
 if(category==='semantic-rejected'&&!(typeof r.experiment.rejectReason==='string'&&r.experiment.rejectReason.trim()))return false
 if(evidence.learningCheck?.result!==true||!evidence.learningCheck.checkedAt)return false
 if(!Array.isArray(receipt.entryIds)||!Array.isArray(evidence.sources)||!Array.isArray(evidence.dispatches)||!evidence.dispatches.length||!Array.isArray(evidence.verifications)||value.responses.some((response:any)=>!obj(response)||response.finishReason!=='stop'||response.reason||typeof response.body!=='string'))return false
 const proofs=new Map(evidence.sources.map((s:any)=>[s.id,s]))
 for(const [index,dispatch] of evidence.dispatches.entries()){
  let payload:any;try{payload=JSON.parse(String(value.responses[index]?.input?.messages?.[0]?.content))}catch{return false}
  const sent=payload?.sources??payload?.material?.sources??[]
  if(!Array.isArray(sent)||JSON.stringify(sent.map((s:any)=>s.id))!==JSON.stringify(dispatch.sourceIds))return false
  for(const source of sent){const proof=proofs.get(source.id) as any;if(!proof||proof.text!==source.text||proof.kind!==source.kind||proof.classification!==source.classification||proof.relPath!==source.attribution)return false}
  if(!dispatch.mapped||!dispatch.finishedAt||!Array.isArray(dispatch.sourceIds))return false
  for(const id of dispatch.sourceIds){const source=proofs.get(id) as any
   if(!obj(source)||source.hash!==createHash('sha256').update(String(source.text)).digest('hex')||!Number.isSafeInteger(source.sequence)||source.sequence<1||source.version!==1||source.permissionTier!=='reference'||!['command','human','adopted-ai'].includes(source.classification)||typeof source.objectVersion!=='string'||typeof source.revision!=='string'||typeof source.materialId!=='string'||!Array.isArray(source.sourceDeps)||!Array.isArray(source.memoryDeps)||!evidence.verifications.some((v:any)=>v.id===id&&v.result===true))return false
  }
 }
 if(evidence.verifications.some((v:any)=>proofs.has(v.id)&&v.result===false))return false
 return evidence.dispatches.length===value.responses.length
}

export const V5_PREFIX='v5-2026-10-05/'
export const V5_RULES={calls:240,perModelCalls:120,rounds:2,attempts:30,screenCalls:40,historyCalls:828,parentLimit:1440,oldRemaining:612,longOverall:.95,longGroup:.9,recent:.9,zeroTolerance:['wrong-attribution','temporary-standing','ambiguous-overwrite'],limits:{seconds:120,calls:2,tools:0,outputTokens:4096},retry:'format-only-once',semanticChecks:['actionSatisfied','oldActiveRemoved','noDuplicateActive','attributionAndScope','noUnsupportedContent'],semanticReview:'逐语义单元核对真实 before/after；attributionAndScope包括归属、范围、standing/fact/recent分类和标签，noUnsupportedContent包括虚构；不以关键词匹配代证。',annotation:'coding-agent-semantic-review-not-user-confirmation'}
export type V5SemanticChecks={actionSatisfied:boolean;oldActiveRemoved:boolean;noDuplicateActive:boolean;attributionAndScope:boolean;noUnsupportedContent:boolean}
export type V5Annotation={semanticChecks:V5SemanticChecks;longRetained:number;recentCorrect:number;hardViolations:string[];evidenceComplete:boolean}
export type V5Row={actionVerified?:boolean;controls?:'passed'|'not-applicable'|'failed';caseId:string;round:number;category:'valid'|'empty'|'length'|'format'|'reference'|'service'|'cancel'|'insufficient-evidence';review:V5Annotation|null}
export function v5Summary(rows:V5Row[],cases:import('../test/fixtures/v5-memory-quality.ts').V5Case[],round:number){
 const groups:Record<string,{required:number;retained:number}>={},categories:Record<string,number>={};let pending=0,valid=true,recentRequired=0,recentCorrect=0
 const violations:string[]=[],actionChecks:{caseId:string;passed:boolean}[]=[],controlFailures:string[]=[],seen=new Set<string>()
 for(const c of cases){const matches=rows.filter(r=>r.round===round&&r.caseId===c.id),r=matches[0],a=r?.review;if(matches.length>1)valid=false
  if(r){seen.add(c.id);categories[r.category]=(categories[r.category]??0)+1}
  const assessed=!!a&&a.evidenceComplete&&['valid','empty'].includes(r!.category)
  if(!assessed)pending++
  if(a&&(!a.semanticChecks||Object.keys(a.semanticChecks).sort().join()!=='actionSatisfied,attributionAndScope,noDuplicateActive,noUnsupportedContent,oldActiveRemoved'||['actionSatisfied','oldActiveRemoved','noDuplicateActive','attributionAndScope','noUnsupportedContent'].some(k=>typeof a.semanticChecks[k as keyof V5SemanticChecks]!=='boolean')||!Number.isSafeInteger(a.longRetained)||a.longRetained<0||a.longRetained>c.expected.long.length||!Number.isSafeInteger(a.recentCorrect)||a.recentCorrect<0||a.recentCorrect>c.expected.recent.length||!Array.isArray(a.hardViolations)||a.hardViolations.some(v=>!V5_RULES.zeroTolerance.includes(v))||typeof a.evidenceComplete!=='boolean'))valid=false
  actionChecks.push({caseId:c.id,passed:!!a?.semanticChecks&&Object.values(a.semanticChecks).every(v=>v===true)&&(!c.expected.action||r?.actionVerified===true)})
  if(r?.controls!=='passed'&&r?.controls!=='not-applicable')controlFailures.push(c.id)
  if(c.expected.long.length){const g=groups[c.group]??={required:0,retained:0};g.required+=c.expected.long.length;g.retained+=assessed?a!.longRetained:0}
  recentRequired+=c.expected.recent.length;recentCorrect+=assessed?a!.recentCorrect:0;violations.push(...(a?.hardViolations??[]))
 }
 if(rows.some(r=>r.round===round&&!cases.some(c=>c.id===r.caseId)))valid=false
 const required=Object.values(groups).reduce((n,g)=>n+g.required,0),retained=Object.values(groups).reduce((n,g)=>n+g.retained,0)
 const longRate=required?retained/required:1,recentRate=recentRequired?recentCorrect/recentRequired:1
 return {round,valid,actionChecks,controlFailures,coverage:seen.size,expected:cases.length,pending,categories,violations,long:{required,retained,rate:longRate,groups},recent:{required:recentRequired,correct:recentCorrect,rate:recentRate},passed:valid&&actionChecks.every(c=>c.passed)&&!controlFailures.length&&seen.size===cases.length&&!pending&&!violations.length&&longRate>=.95&&Object.values(groups).every(g=>g.retained/g.required>=.9)&&recentRate>=.9}
}
export function v5DispatchGate(rows:V5Row[],nextCase:string,round:number,screen:boolean,cases:import('../test/fixtures/v5-memory-quality.ts').V5Case[]=[]){
 if(rows.some(r=>r.review?.hardViolations.length))throw Error('EVALUATION_MODEL_STOPPED')
 for(const r of rows){if(r.caseId===nextCase&&r.round===round)continue;if(!r.review)throw Error('EVALUATION_REVIEW_REQUIRED');if(!r.review.evidenceComplete||!['valid','empty'].includes(r.category))throw Error('EVALUATION_INSUFFICIENT_EVIDENCE')}
 if(!screen&&cases.length&&!v5Summary(rows,cases,0).passed)throw Error('EVALUATION_SCREEN_REQUIRED')
 if(round===1&&cases.length&&!v5Summary(rows,cases,0).passed)throw Error('EVALUATION_ROUND_REQUIRED')
}
export function freezeV5(root:string,manifest:unknown){mkdirSync(root,{recursive:true,mode:0o700});const file=path.join(root,'v5-manifest.json');if(existsSync(file)){if(fingerprint(JSON.parse(readFileSync(file,'utf8')))!==fingerprint(manifest))throw Error('EVALUATION_REVISION_CHANGED')}else writeFileSync(file,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});return fingerprint(manifest)}
/** Screening has its own frozen denominator; later reviewed attempts never invalidate it. */
export function v5ScreenDispatchGate(rows:V5Row[],nextCase:string,round:number,screen:boolean,cases:import('../test/fixtures/v5-memory-quality.ts').V5Case[],screenIds:readonly string[]){
 v5DispatchGate(rows,nextCase,round,true)
 if(screen&&(round!==0||!screenIds.includes(nextCase)))throw Error('EVALUATION_CASES_NOT_AUTHORIZED')
 if(!screen||round===1){const selected=cases.filter(c=>screenIds.includes(c.id));if(!v5Summary(rows.filter(r=>r.round===0&&screenIds.includes(r.caseId)),selected,0).passed)throw Error('EVALUATION_SCREEN_REQUIRED')}
 if(round===1&&!v5Summary(rows.filter(r=>r.round===0),cases,0).passed)throw Error('EVALUATION_ROUND_REQUIRED')
}
/** Terminal reasons remain visible even when no response was received. */
export function v5TerminalCategory(r:{status?:string;responses?:{finishReason?:string;reason?:string|null}[];result?:{receipt?:{outcome:string;reason?:string};entries?:unknown[];recent?:unknown[]}}):V5Row['category']{
 if(r.status==='interrupted')return 'cancel'
 const receipt=r.result?.receipt
 if(receipt?.outcome==='interrupted'||receipt?.reason==='MEMORY_CANCELLED'||receipt?.reason==='MEMORY_DEADLINE')return 'cancel'
 if(r.responses?.some(p=>p.finishReason==='length'))return 'length'
 if(r.responses?.some(p=>p.reason))return 'service'
 if(receipt?.reason==='MEMORY_OUTPUT_EMPTY')return 'empty'
 if(receipt?.reason==='MEMORY_OUTPUT_TRUNCATED')return 'length'
 if(receipt?.reason==='MEMORY_SERVICE_FAILED')return 'service'
 if(receipt?.outcome==='applied'&&!receipt.reason)return (r.result?.entries?.length||r.result?.recent?.length)?'valid':'empty'
 if(receipt?.reason==='MEMORY_OUTPUT_INVALID')return 'format'
 if(/SOURCE|MATERIAL|DEPENDENCY|PERMISSION|SESSION|REFERENCE/.test(receipt?.reason??''))return 'reference'
 return 'insufficient-evidence'
}
export function v5DiagnosticTargets<T extends {modelId:string}>(models:T[],live:boolean,only?:string):T[]{const targets=live?models.filter(m=>m.modelId===only):models;if(!targets.length)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');return targets}
/** Mechanical action facts augment semantic review; content meaning remains manually assessed. */
export function v5ActionEvidence(spec:import('../test/fixtures/v5-memory-quality.ts').V5Case,result:any):boolean{
 const action=spec.expected.action;if(!action)return true
 if(!result||!Array.isArray(result.before)||!Array.isArray(result.entries)||result.receipt?.outcome!=='applied'||result.receipt.reason)return false
 const before=result.before.filter((e:any)=>e.category!=='recent'&&e.status==='active'),active=result.entries.filter((e:any)=>e.category!=='recent'&&e.status==='active')
 if(spec.expected.maxActive!==undefined&&active.length>spec.expected.maxActive)return false
 const target=spec.seed?before.find((e:any)=>e.content===spec.seed!.content&&e.semantic===spec.seed!.semantic&&e.scope===spec.seed!.scope):undefined
 if(action==='unchanged')return !!target&&active.length===before.length&&before.every((e:any)=>active.some((now:any)=>now.id===e.id&&now.version===e.version&&now.content===e.content&&now.scope===e.scope&&now.semantic===e.semantic))
 if(action==='correct')return !!target&&active.some((e:any)=>e.id===target.id&&e.version===target.version+1&&e.content!==target.content&&e.scope===target.scope&&e.semantic===target.semantic&&result.receipt.entryIds.includes(e.id))&&!active.some((e:any)=>e.id===target.id&&e.version===target.version)
 if(action==='add')return active.some((e:any)=>e.semantic===spec.group&&result.receipt.entryIds.includes(e.id)&&!before.some((old:any)=>old.id===e.id))
 return false
}
export function v5ControlledStatus(spec:import('../test/fixtures/v5-memory-quality.ts').V5Case,result:any):'passed'|'not-applicable'|'failed'{
 const c=result?.controlled;if(!c||c.budget?.within!==true||c.dispatch?.verified!==true||c.dispatch?.sameVersionVerified!==true||c.dispatch?.versionMismatchRejected!==true||c.dispatch?.actualHostBudget?.mapped!==true||c.dispatch?.actualHostBudget?.within!==true)return 'failed'
 if(c.status==='not-applicable')return c.reason==='no-selected-memory'&&!(result.receipt?.entryIds?.length)?'not-applicable':'failed'
 if(c.status!=='passed'||c.dispatch.permissionRevoked!==true||c.dispatch.frozenSignatureMatches!==true)return 'failed'
 if(spec.chain&&spec.step!<5)return c.closureStatus==='deferred-chain-step'?'passed':'failed'
 return c.closureStatus==='verified'&&c.closure?.passed===true&&c.closure?.revoked===true&&c.closure?.originalBasisBlocked===true&&v5ReplayEvidence(c.closure?.replay)&&Array.isArray(c.closure?.remaining)&&!c.closure.remaining.length?'passed':'failed'
}
/** Recompute probe evidence: a retained applied/no-op receipt is never a rejection. */
export function v5ReplayEvidence(replay:any):boolean{
 const r=replay?.receipt,m=replay?.material
 if(!r||!m||r.taskId!==m.taskId||r.materialVersion!==m.materialVersion||typeof replay.beforeRevision!=='string'||typeof replay.afterRevision!=='string'||replay.beforeRevision===replay.afterRevision||!('previousReceipt'in replay)||fingerprint(r)===fingerprint(replay.previousReceipt??null)||!Array.isArray(r.entryIds)||r.entryIds.length)return false
 const explicitBlock=['rejected','interrupted'].includes(r.outcome)&&typeof r.reason==='string'&&/SOURCE|DEPENDENCY|FORGOTTEN/.test(r.reason)
 const proposal=replay.sent?.proposal,sources=replay.sent?.sources,items=proposal&&Array.isArray(proposal.proposals)?[...proposal.proposals,...(proposal.recent?[proposal.recent]:[])]:[]
 const referencesValid=Array.isArray(sources)&&items.length>0&&items.every((item:any)=>Array.isArray(item.sourceIds)&&item.sourceIds.length>0&&item.sourceIds.every((id:string)=>sources.some((s:any)=>s.id===id&&(item.semantic!=='standing'||s.classification==='command'))))
 const proposalRejected=referencesValid&&Number.isSafeInteger(replay.calls)&&replay.calls>0&&replay.validProposalSources===true&&['applied','rejected'].includes(r.outcome)&&r.reason==='MEMORY_OUTPUT_INVALID'
 return explicitBlock||proposalRejected
}

/* ───────────────────────── v6 命名空间 ───────────────────────── */

export const V6_PREFIX='v6-2026-10-05/'
export const V6_CATEGORIES=['valid','safe-empty','partial-commit','semantic-rejected','candidate-rejected','source','capacity','admission','format','format-repaired-unreviewed','empty','length','service','cancel','interrupted','reference','insufficient-evidence'] as const
export type V6Category=(typeof V6_CATEGORIES)[number]
/** 只有取得可判定系统产出的类别进入语义评分；其余计未知。 */
export const V6_SCORING_CATEGORIES:V6Category[]=['valid','safe-empty','partial-commit','semantic-rejected','candidate-rejected']
/** 预注册的"证据不足"理由；其余情况一律必须判定。 */
export const V6_UNASSESSABLE_REASONS=['no-model-output','terminal-receipt-unbound','safety-source-mapping-missing'] as const
export const V6_PIPELINE=['candidate','model','admission','commit','use'] as const
export type V6Verdict='passed'|'failed'|'unmeasured-environment'|'insufficient-evidence'|'not-run'
/** 70／各维 60% 是用户确认的产品取舍：非历史成绩拟合，非统计安全保证，新旧成绩不可换算。
 *  当前完整性包有限授权：最多240次、每模型120次；历史3000总账仅作防跑飞上限。
 *  旧r9的无上限授权、旧revision及实际计账保留原manifest和历史记录，不作为本包额度。 */
export const V6_RULES={
 // r13：把「近期四段不能全空」写进续写提示词、并给元目标定价。
 // r14：未触达模型的请求允许有限次重派（单次服务失败过去没有重试入口）。
 // r15：额度按所有者授权重定，且预算拒绝在进产品管线前就响亮报错。
 // r16：产品侧两处记忆守卫（接续形口令不得升级、同义孪生副本不另存）。
 // r17：容器按范围改正（范围指向具体对象 → 项目事实），并把判据写进提示词一句。
 // r18：只修测量工具——程序侧良性 applied 码按正常落库计（不改产品、试卷、评分与阈值）。
 revision:19,dimensions:V6_DIMENSION_MAX,dimensionMin:V6_DIMENSION_MIN,updateSplit:V6_UPDATE_SPLIT_MAX,total:70,
 reliability:{plan:30,gate:.95,judgeableMin:27,coverageMin:.80,safetyMinJudged:2,denominator:'dispatched-non-environment',environmentCategories:['service','cancel','interrupted'] as const,environmentReasons:['MEMORY_DEADLINE','MEMORY_SERVICE_FAILED','EVALUATION_REQUEST_FAILED','EVALUATION_ATTEMPT_TIMEOUT'] as const},
 scoring:{classificationHaircut:0.5,recentGoalHaircut:0.5,rubricVersion:1},
 vetoes:['wrong-attribution','temporary-standing','ambiguous-overwrite'] as const,
 rounds:2,recoveryCyclesMax:2,retryUnmeasuredMax:2,supervisionMs:180000,
 history:{calls:829,oldRemaining:611,parentLimit:6000,campaignLimit:1000,perModelLimit:1000,authorizedAt:'2026-10-06',authorization:'2026-10-06-memory-integrity',unlimited:false,ledgerStop:6000},
 // 2026-10-13 所有者授权：deepseek-flash 与 MiniMax-M3 的调用不再逐次申请。下面的 1000／1000／6000 是
 // 防跑飞的量级上限，不是预算门槛；历史账目数字（calls 829 等）照旧不改写。
 ownerGrant:{at:'2026-10-13',models:['deepseek-flash','MiniMax-M3'],scope:'unlimited-calls-no-further-approval',ceilings:{perModel:1000,campaign:1000,parent:6000}},
 limits:{seconds:120,calls:2,tools:0,inputBytes:32768,outputBytes:32768,outputTokens:4096},
 retry:'network-retry-or-format-repair-once',categories:V6_CATEGORIES,unassessable:V6_UNASSESSABLE_REASONS,
 checks:'attributionAndScope 覆盖归属、范围与 standing/fact/recent 分类：期望单元若只由错误分类的条目覆盖（项目事实只存成长期约定，或长期约定只存成项目事实）按该检查项失败；同一单元已有正确分类条目时，另存的同义副本按重复记录观察，不单独判失败——该条同时由机械护栏执行：entry 期望的例子若机械动作证据已证明正确分类条目落地（actionVerified），不再按本项打折（v6ClassificationPass）；recent 期望的容器错放与未经机械确认的例子不受护栏影响。仅 attributionAndScope 失败时该例按内容 F1 × 0.5 计入，不整例归零；hardViolations 或 noUnsupportedContent／noForbiddenContent 失败仍整例 0。noUnsupportedContent 覆盖材料不支持的新说法与虚构；noForbiddenContent 只看 expected.forbidden 是否写入最终生效内容。workingStateSubstance 覆盖近况 goal 有没有实质内容（可选检查项，缺省视为通过以兼容旧标注）：goal 只是口令原句、材料原句，或「整理本次／总结进展／记录本次工作」这类空话时该项失败；失败时该例按 recentGoalHaircut 在 recent 维度打折——不是整例 0，也不进否决集合。判据 metaGoalShaped 已实现并导出（含测试）供标注执行者机械套用；**本轮没有自动预标注器**，检查项仍由标注者填。',
 annotation:'coding-agent-semantic-review-not-user-confirmation'
} as const

export type V6Annotator={identity:string;kind:'agent'|'human';participatedInDesign:boolean;modelNameMasked:boolean;humanReviewed:boolean}
export type V6Annotation={
 correct:number;omitted:number;wrongNew:number;hardViolations:V6Safety[]
 checks:{attributionAndScope:boolean;noUnsupportedContent:boolean;noForbiddenContent:boolean;workingStateSubstance?:boolean}
 evidenceComplete:boolean;uncertainty:string[]
 annotator:V6Annotator;rulesHash:string;resultHash:string;frozenHash:string
 rubricVersion:number
 revisionHistory?:{at:string;by:string;reason:string;impact:string}[]
}
/** 显式旧历史 replay 可由已核外层生成评分视图；原内层缺证据须在追加报告单列。 */
export function v6BoundReview(annotation:any,binding:{key:string;frozenHash:string;resultHash:string;rulesHash:string},mode:{replay:boolean;revision:number}){
 const hashes=['frozenHash','resultHash','rulesHash'] as const,review=annotation?.review
 if(!annotation||annotation.key!==binding.key||!review||typeof review!=='object'||Array.isArray(review)||hashes.some(key=>typeof binding[key]!=='string'||!binding[key]||annotation[key]!==binding[key]))throw Error('EVALUATION_ANNOTATION_INVALID')
 const missing=hashes.filter(key=>!Object.hasOwn(review,key))
 if(hashes.some(key=>Object.hasOwn(review,key)&&review[key]!==binding[key])||missing.length&&!(mode.replay===true&&Number.isSafeInteger(mode.revision)&&mode.revision>=1&&mode.revision<=9))throw Error('EVALUATION_ANNOTATION_INVALID')
 const scoringView={...structuredClone(review),...Object.fromEntries(missing.map(key=>[key,binding[key]]))} as V6Annotation
 return {review:scoringView,evidence:{...binding,originalInnerEvidence:missing.length===0,binding:missing.length?'verified-outer-envelope':'verified-inner-and-outer',annotationHash:fingerprint(annotation),originalReviewHash:fingerprint(review),scoringViewHash:fingerprint(scoringView),annotator:structuredClone(scoringView.annotator)},...(missing.length?{historicalBinding:{binding:'verified-outer-envelope' as const,originalInnerEvidence:false as const,missingInnerHashes:missing}}:{})}
}
export type V6Row={
 caseId:string;round:number
 dispatched:boolean;terminal:boolean;structured:boolean;blocked?:boolean;actionVerified?:boolean;actionState?:'success'|'failure'|'unknown';doubleRequired?:boolean
 category:V6Category
 calls?:number;chargedCalls?:number;observedCalls?:number;latencyMs?:number;receiptReason?:string
 /** 逐调用留证：目标是否展示，依预算裁剪后的实际请求。 */
 candidate?:{expectedTarget:string|null;targetEligible:boolean;targetShown:boolean;snapshotHash:string;failureOrigin:(typeof V6_PIPELINE)[number]|null;secondary:string[]}
 review:V6Annotation|null
 /** 独立第二标注：分歧进入上下界，不覆盖主标注。 */
 reviewAlt?:V6Annotation|null
}
export function v6ScoringCategory(category:string|undefined):boolean{
 return (V6_SCORING_CATEGORIES as readonly string[]).includes(category??'')
}
/** 环境例：类别或回执原因表明超时／传输／监督失败，不进可靠性分母，也不进语义 F1。 */
export function v6Environment(row:Pick<V6Row,'category'|'receiptReason'>):boolean{
 if((V6_RULES.reliability.environmentCategories as readonly string[]).includes(row.category))return true
 return typeof row.receiptReason==='string'&&(V6_RULES.reliability.environmentReasons as readonly string[]).includes(row.receiptReason)
}

const stringList=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string')
/** 标注只提供语义；格式非法、计数越界、缺证据不足理由的标注不成立。 */
export function v6ReviewValid(spec:V6Case,review:V6Annotation|null|undefined):boolean{
 if(!review||typeof review!=='object')return false
 const a=review as V6Annotation,units=spec.expected.units.length
 const counts=[a.correct,a.omitted,a.wrongNew]
 if(!counts.every(n=>Number.isSafeInteger(n)&&n>=0))return false
 if(a.correct+a.omitted>units||a.wrongNew>16)return false
 if(units===0&&(a.correct!==0||a.omitted!==0))return false
 if(!Array.isArray(a.hardViolations)||a.hardViolations.some(v=>!V6_RULES.vetoes.includes(v as V6Safety)))return false
 // 旧标注只有三个必需键；workingStateSubstance 属新增可选检查项，缺省即通过，不因缺键判旧标注无效。
 const checkKeys=Object.keys(a.checks??{}).sort().join()
 if(!a.checks||!(checkKeys==='attributionAndScope,noForbiddenContent,noUnsupportedContent'||checkKeys==='attributionAndScope,noForbiddenContent,noUnsupportedContent,workingStateSubstance')||Object.values(a.checks).some(v=>typeof v!=='boolean'))return false
 if(typeof a.evidenceComplete!=='boolean')return false
 if(a.evidenceComplete&&a.correct+a.omitted!==units)return false
 if(!stringList(a.uncertainty))return false
 // 证据不足必须引用预注册理由，不能临场各自决定。
 if(!a.evidenceComplete&&!a.uncertainty.some(r=>V6_RULES.unassessable.includes(r as typeof V6_UNASSESSABLE_REASONS[number])))return false
 const n=a.annotator
 if(!n||typeof n.identity!=='string'||!n.identity.trim()||!['agent','human'].includes(n.kind)||typeof n.participatedInDesign!=='boolean'||typeof n.modelNameMasked!=='boolean'||typeof n.humanReviewed!=='boolean')return false
 if(a.rubricVersion!==V6_RULES.scoring.rubricVersion)return false
 return [a.rulesHash,a.resultHash,a.frozenHash].every(h=>typeof h==='string'&&h.length>0)
}
/** 单例信息保留：F1＝2×正确／(2×正确＋错误新增＋遗漏)；安全负例无必留单元时按是否新增判 0/1。
 *  仅分类检查失败按 F1 × classificationHaircut；硬否决或无依据／禁写失败仍整例 0。 */
/** 分类判据的机械护栏：试卷自述「期望单元若只由错误分类条目覆盖才算失败；同一单元已有正确分类条目时，
 *  另存的同义副本按重复记录观察，不单独判失败」。机械动作证据已证明正确分类的条目落地（actionVerified）
 *  时，entry 期望的例子不得再按本项打折；recent 期望的容器错放与任何未经机械确认的例子保持原样。 */
export function v6ClassificationPass(spec:V6Case,annotated:boolean,actionVerified:boolean|undefined):boolean{
 if(annotated)return true
 const container=spec.expected.targetCategory??(spec.direction==='recent'?'recent':'entry')
 return actionVerified===true&&container==='entry'
}
/** 近况 goal 是否只是"口令原句／材料原句／空话"：规范化后（去空白与标点、统一小写）与口令比较。
 *  这是 5b 的机读判据：检查项 workingStateSubstance 由它执行，人工仍可覆盖。 */
const META_GOAL_PHRASES=['整理本次','总结进展','记录本次工作','整理工作','总结本次']
const normalizeState=(text:string):string=>text.replace(/\s+/gu,'').replace(/[。．.,，、；;：:！!？?「」“”"'（）()【】\[\]]/gu,'').toLowerCase()
export function metaGoalShaped(recent:unknown,prompt:string):boolean{
 if(!recent||typeof recent!=='object'||Array.isArray(recent))return false
 const goal=normalizeState(String((recent as {goal?:unknown}).goal??''))
 if(!goal)return false
 if(META_GOAL_PHRASES.some(phrase=>goal.includes(normalizeState(phrase))))return true
 const command=normalizeState(prompt)
 if(!command)return false
 // 短口令复制成 goal 才算"原句"；长篇材料里偶然包含短词不算，避免误伤。
 const floor=Math.min(8,command.length)
 if(goal===command)return true
 if(command.length>=floor&&goal.includes(command))return true
 return goal.length>=floor&&command.includes(goal)
}

export function v6CaseScore(spec:V6Case,review:V6Annotation|null,options?:{actionVerified?:boolean}):number|null{
 if(!v6ReviewValid(spec,review))return null
 const a=review as V6Annotation
 // 标注声明证据不足时该例计未知，不能凭计数冒充可判定。
 if(a.evidenceComplete!==true)return null
 if(a.hardViolations.length)return 0
 if(a.checks.noUnsupportedContent!==true||a.checks.noForbiddenContent!==true)return 0
 const denominator=2*a.correct+a.wrongNew+a.omitted
 const f1=denominator===0?1:(2*a.correct)/denominator
 const classified=v6ClassificationPass(spec,a.checks.attributionAndScope===true,options?.actionVerified)?f1:f1*V6_RULES.scoring.classificationHaircut
 // 近况没实质只在 recent 维度打折：goal 属于工作接续，别拿它去扣别的维度。
 return spec.direction==='recent'&&a.checks.workingStateSubstance===false?classified*V6_RULES.scoring.recentGoalHaircut:classified
}
/** 终态类别优先级固定；取证正文、终态回执与分组结果，不看模型自称。 */
/** 程序侧"良性 applied"码：批次正常落库，只是程序做了等价改写（改正容器等）。这类 reason 不改变结局，
 *  不能因为多了一个码就折成 insufficient-evidence——否则被改正的那条案例会被按未知计，认证等于没认。 */
export const V6_PROGRAM_APPLIED_REASONS=new Set(['MEMORY_SEMANTIC_RESCOPED','MEMORY_PROGRAM_COMPLETED'])

export function v6TerminalCategory(r:{status?:string;responses?:{finishReason?:string;reason?:string|null}[];result?:{structured?:boolean;receipt?:{outcome:string;reason?:string;results?:{outcome?:string}[]};entries?:unknown[];recent?:unknown[]}}):V6Category{
 if(r.status==='interrupted')return 'interrupted'
 const receipt=r.result?.receipt
 if(receipt?.outcome==='interrupted')return 'interrupted'
 if(receipt?.reason==='MEMORY_CANCELLED'||receipt?.reason==='MEMORY_DEADLINE')return 'cancel'
 if(r.responses?.some(p=>p.finishReason==='length'))return 'length'
 if(r.responses?.some(p=>p.reason))return 'service'
 if(receipt?.reason==='MEMORY_OUTPUT_EMPTY')return 'empty'
 if(receipt?.reason==='MEMORY_OUTPUT_TRUNCATED')return 'length'
 if(receipt?.reason==='MEMORY_SERVICE_FAILED')return 'service'
 const wrote=!!(r.result?.entries?.length||r.result?.recent?.length)
 // 部分提交：有正文、有落库内容，但至少一组被拒；不得折成服务失败，也不冒充完全成功。
 if(receipt?.outcome==='applied'&&Array.isArray(receipt.results)&&receipt.results.some(x=>x?.outcome==='rejected')&&wrote)return 'partial-commit'
 if(receipt?.outcome==='applied'&&(!receipt.reason||V6_PROGRAM_APPLIED_REASONS.has(receipt.reason)))return wrote?'valid':'safe-empty'
 if(receipt?.reason==='MEMORY_OUTPUT_INVALID')return r.result?.structured===true?'candidate-rejected':'format'
 if(/FILE_LIMIT|ENTRY_LIMIT|INPUT_LIMIT|CAPACITY|QUEUE_FULL/.test(receipt?.reason??''))return 'capacity'
 if(/SOURCE|MATERIAL|DEPENDENCY/.test(receipt?.reason??''))return 'source'
 if(/PERMISSION|SESSION|REFERENCE|TARGET_NOT_FOUND/.test(receipt?.reason??''))return 'admission'
 if(receipt?.outcome==='rejected'&&receipt.reason==='MEMORY_CONFIRMATION_REQUIRED')return 'semantic-rejected'
 return 'insufficient-evidence'
}
/** 实际下一场装入：逐对象逐版本核对，缺终态证据保持未知。 */
export function v6LoadedActionState(saved:'success'|'failure'|'unknown',targets:readonly {id:string;version:number}[]|undefined,loaded:readonly {id:string;version:number}[]|undefined):'success'|'failure'|'unknown'{
 if(saved!=='success')return saved
 if(!targets)return 'unknown'
 if(!targets.length)return 'unknown'
 if(!loaded)return 'unknown'
 return targets.every(t=>loaded.some(d=>d.id===t.id&&d.version===t.version))?'success':'failure'
}
export type V6SummaryOptions={environmentUnavailable?:boolean;doubleRequired?:readonly string[]}
/** 原冻结字段与本次重算对象分列；历史重算绝不改原冻结。 */
export function v6AppliedEvidence(frozen:{rules:string;dataset:string},cases:V6Case[]){
 return {frozenRulesHash:frozen.rules,frozenDatasetHash:frozen.dataset,appliedRulesHash:fingerprint(V6_RULES),appliedDatasetHash:fingerprint(cases)}
}
/** 只暂停当前报告修订内所选模型；原请求重复门及全局/模型总账门保持。 */
export function v6AssertDispatchAvailable(journal:Pick<EvaluationJournal,'dispatchKeys'|'charged'|'read'>,prefix:string,model:string,key:string,hasTerminalResult:(key:string)=>boolean,priorAttempts=1):void{
 if(!key.startsWith(prefix+model+'/'))throw Error('EVALUATION_CAMPAIGN_KEY')
 for(const charged of journal.dispatchKeys().filter(k=>k.startsWith(prefix+model+'/')))if(!hasTerminalResult(charged))throw Error('EVALUATION_CHARGED_UNFINISHED')
 if(journal.charged(key))throw Error('EVALUATION_ATTEMPT_ALREADY_DISPATCHED')
 const previous=journal.read(key) as {responses?:unknown[]}|null
 if(!previous)return
 // 一次从未碰到模型的请求（没计费、没有任何模型输出）不是「尝试」：断网、服务拒绝、写盘失败都会
 // 留下这么一份空结果。它过去被 read() 永久锁死——单次失败没有重试入口，只能整轮作废重跑（r13 实测：
 // 三条链尾被一次 MEMORY_UNAVAILABLE 吃掉，质量下界 95.2 却因必双标名单缺三例而永远拿不到通过）。
 // 这里允许有限次重派，次数由调用方按落盘的 attempt 记录数给出，且照样受调用总账与 CHARGED_UNFINISHED 约束。
 const unmeasured=Array.isArray(previous.responses)&&previous.responses.length===0
 if(unmeasured&&priorAttempts<V6_RULES.retryUnmeasuredMax)return
 throw Error('EVALUATION_ATTEMPT_ALREADY_DISPATCHED')
}
/** 每例上下界：主标注与独立第二标注各自计分，分歧撑开区间而不是只报一致率。
 *  证据不足（没有任何可判定标注）仍返回 null，不靠计数冒充可判定。 */
export function v6CaseBounds(spec:V6Case,row:{review?:V6Annotation|null;reviewAlt?:V6Annotation|null}|null|undefined){
 const primary=row?.review??null,secondary=row?.reviewAlt??null
 const actionVerified=(row as V6Row|undefined)?.actionVerified
 const reviews=[primary,secondary],scores=reviews.map(r=>v6CaseScore(spec,r,{actionVerified}))
 const independent=!!primary&&!!secondary&&primary.annotator?.identity!==secondary.annotator?.identity
 const veto=reviews.some(r=>r?.hardViolations?.length)
 const required=(row as V6Row|undefined)?.doubleRequired===true||veto||secondary!==null
 const semantics=(r:V6Annotation)=>JSON.stringify([r.correct,r.omitted,r.wrongNew,[...r.hardViolations].sort(),[r.checks.attributionAndScope,r.checks.noUnsupportedContent,r.checks.noForbiddenContent],r.evidenceComplete,[...r.uncertainty].sort()])
 const disagreement=v6ReviewValid(spec,primary)&&v6ReviewValid(spec,secondary)&&semantics(primary!)!==semantics(secondary!)
 if(required&&(!independent||scores.some(n=>n===null)))return {lower:0,upper:1,disagreement:true,unresolved:true}
 const known=scores.filter((n):n is number=>n!==null)
 if(!known.length)return {lower:null as number|null,upper:null as number|null,disagreement:false,unresolved:true}
 const lower=Math.min(...known),upper=Math.max(...known)
 return {lower,upper,disagreement,unresolved:((row as V6Row|undefined)?.doubleRequired===true||veto)&&disagreement}
}
/** 唯一双标门：有效独立完整标注覆盖冻结名单且至少十例；文件数量不是证据。 */
export function v6DoubleReview(rows:V6Row[],cases:V6Case[],round:number,required?:readonly string[]){
 const ids=new Set(cases.map(c=>c.id)),requiredIds=required===undefined?[]:[...required]
 if(!Array.isArray(requiredIds)||requiredIds.some(id=>typeof id!=='string'||!ids.has(id))||new Set(requiredIds).size!==requiredIds.length)throw Error('EVALUATION_DOUBLE_POLICY_INVALID')
 const selected=rows.filter(r=>r.round===round),byCase=new Map(selected.map(r=>[r.caseId,r]))
 const coveredIds=cases.filter(c=>{
  const r=byCase.get(c.id),a=r?.review,b=r?.reviewAlt
  return !!a&&!!b&&v6ReviewValid(c,a)&&v6ReviewValid(c,b)&&a.evidenceComplete&&b.evidenceComplete&&a.annotator.identity!==b.annotator.identity&&(['frozenHash','resultHash','rulesHash'] as const).every(k=>a[k]===b[k])
 }).map(c=>c.id)
 const missingRequiredIds=requiredIds.filter(id=>!coveredIds.includes(id))
 const agreement=coveredIds.filter(id=>!v6CaseBounds(cases.find(c=>c.id===id)!,byCase.get(id)).disagreement).length
 const annotators=[...new Set(coveredIds.flatMap(id=>{const r=byCase.get(id)!;return [r.review!.annotator.identity,r.reviewAlt!.annotator.identity]}))]
 return {policy:required===undefined?'legacy-minimum':'frozen-required',minimum:10,requiredIds,requiredIdsHash:fingerprint(requiredIds),coveredIds,missingRequiredIds,judged:selected.length,double:coveredIds.length,agreementRate:coveredIds.length?agreement/coveredIds.length:null,annotators,doubleGate:coveredIds.length>=10&&missingRequiredIds.length===0}
}
/** 机械失败为质量已知 0/0；环境与非评分类别不计语义分，上下界按未知 0/1。 */
export function v6CaseAssessment(spec:V6Case,row:V6Row|undefined){
 const actionState=!spec.expected.action?'success':row?.actionState??(row?.actionVerified===true?'success':row?.actionVerified===false?'failure':'unknown')
 if(row&&(row.blocked||v6Environment(row)||!v6ScoringCategory(row.category)))return {judgeable:false,actionState,annotationUnresolved:true,lower:0,upper:1}
 const bounds=row?.blocked?{lower:null,upper:null,unresolved:true}:v6CaseBounds(spec,row)
 const knownFailure=!!row&&!row.blocked&&actionState==='failure'
 const judgeable=!!row&&!row.blocked&&(knownFailure||bounds.lower!==null&&!bounds.unresolved&&actionState!=='unknown')
 return {judgeable,actionState,annotationUnresolved:bounds.unresolved,lower:knownFailure?0:judgeable?bounds.lower:0,upper:knownFailure?0:judgeable?bounds.upper:1}
}
export function v6Summary(rows:V6Row[],cases:V6Case[],round:number,options:V6SummaryOptions={}){
 const ids=new Set(cases.map(c=>c.id)),seen=new Set<string>();let valid=true
 const roundRows=rows.filter(r=>r.round===round)
 for(const r of roundRows){if(!ids.has(r.caseId)||!V6_CATEGORIES.includes(r.category))valid=false;if(seen.has(r.caseId))valid=false;seen.add(r.caseId)}
 const doubleReview=v6DoubleReview(rows,cases,round,options.doubleRequired)
 const byCase=new Map(roundRows.map(r=>[r.caseId,{...r,doubleRequired:r.doubleRequired===true||doubleReview.requiredIds.includes(r.caseId)}]))
 const assessments=new Map(cases.map(c=>[c.id,v6CaseAssessment(c,byCase.get(c.id))]))
 const dims:Record<V6Direction,number>={standing:0,fact:0,recent:0,update:0}
 const dimsUpper:Record<V6Direction,number>={standing:0,fact:0,recent:0,update:0}
 const dimsMax:Record<V6Direction,number>={standing:0,fact:0,recent:0,update:0}
 const split:{correction:number;dedupe:number}={correction:0,dedupe:0}
 const splitUpper:{correction:number;dedupe:number}={correction:0,dedupe:0}
 const vetoes:string[]=[],uncertain:string[]=[],categories:Record<string,number>={}
 let judgeable=0,blocked=0,unresolvedVeto=0
 for(const spec of cases){
  const row=byCase.get(spec.id)
  if(row)categories[row.category]=(categories[row.category]??0)+1
  if(row?.blocked)blocked++
  dimsMax[spec.direction]+=spec.weight
  const hasVeto=!!row?.review?.hardViolations?.length||!!row?.reviewAlt?.hardViolations?.length
  const bounds=row?.blocked?{lower:null,upper:null,unresolved:true}:v6CaseBounds(spec,row)
  if(hasVeto&&bounds.unresolved)unresolvedVeto++
  const assessment=assessments.get(spec.id)!
  if(!assessment.judgeable)uncertain.push(spec.id);else judgeable++
  dims[spec.direction]+=spec.weight*(assessment.lower??0);dimsUpper[spec.direction]+=spec.weight*(assessment.upper??0)
  if(spec.split){split[spec.split]+=spec.weight*(assessment.lower??0);splitUpper[spec.split]+=spec.weight*(assessment.upper??0)}
  if(row?.review&&row.reviewAlt&&v6ReviewValid(spec,row.review)&&v6ReviewValid(spec,row.reviewAlt)&&row.review.annotator.identity!==row.reviewAlt.annotator.identity&&row.review.evidenceComplete&&row.reviewAlt.evidenceComplete)for(const v of row.review.hardViolations)if(row.reviewAlt.hardViolations.includes(v))vetoes.push(`${spec.id}:${v}`)
 }
 const total=Object.values(dims).reduce((n,v)=>n+v,0),totalUpper=Object.values(dimsUpper).reduce((n,v)=>n+v,0)
 const maxTotal=Object.values(dimsMax).reduce((n,v)=>n+v,0)
 const rateOf=(earned:number,max:number)=>max>0?earned/max:1
 // 按原计划权重评分；受阻只扩大未知区间，不能缩小分母。
 const qualityPass=(d:Record<V6Direction,number>)=>{
  if(!maxTotal)return false
  if(rateOf(Object.values(d).reduce((n,v)=>n+v,0),maxTotal)<V6_RULES.total/100)return false
  return (Object.keys(d) as V6Direction[]).every(k=>rateOf(d[k],dimsMax[k])>=V6_RULES.dimensionMin[k]/V6_RULES.dimensions[k])
 }
 const assessable=(c:V6Case)=>assessments.get(c.id)!.judgeable
 const coverage={directions:{} as Record<V6Direction,{judged:number;total:number;rate:number}>,chains:{} as Record<string,{judged:number;total:number;rate:number}>}
 for(const direction of ['standing','fact','recent','update'] as V6Direction[]){
  const pool=cases.filter(c=>c.direction===direction&&!c.chain),judged=pool.filter(assessable).length
  coverage.directions[direction]={judged,total:pool.length,rate:pool.length?judged/pool.length:1}
 }
 for(const name of ['alpha','beta']){
  const pool=cases.filter(c=>c.chain===name),judged=pool.filter(assessable).length
  coverage.chains[name]={judged,total:pool.length,rate:pool.length?judged/pool.length:1}
 }
 const failedChecks=roundRows.filter(r=>[r.review,r.reviewAlt].some(a=>a?.checks&&Object.values(a.checks).some(v=>v!==true))).length
 const actionFailures=roundRows.filter(r=>{const spec=cases.find(c=>c.id===r.caseId);return !!spec?.expected.action&&(r.actionState==='failure'||r.actionState===undefined&&r.actionVerified===false)}).length
 const zeroCall=roundRows.filter(r=>r.dispatched&&r.calls===0).length
 const disagreements=roundRows.filter(r=>r.reviewAlt!=null&&ids.has(r.caseId)&&v6CaseBounds(cases.find(c=>c.id===r.caseId)!,r).disagreement).length
 const judged=(safety:V6Safety)=>{const ids=new Set([...V6_SAFETY_COVERAGE[safety].cases,V6_SAFETY_COVERAGE[safety].chain]);return cases.filter(c=>ids.has(c.id)&&assessable(c)).length}
 const safetyJudged=Object.fromEntries(V6_RULES.vetoes.map(v=>[v,judged(v as V6Safety)])) as Record<V6Safety,number>
 const N=cases.length,D=roundRows.filter(r=>r.dispatched).length,T=roundRows.filter(r=>r.terminal).length,P=roundRows.filter(r=>r.structured).length
 const reliabilityRows=roundRows.filter(r=>r.dispatched&&!v6Environment(r)),nRel=reliabilityRows.length,pRel=reliabilityRows.filter(r=>r.structured).length
 const reliability={p:pRel,n:nRel,rate:nRel?pRel/nRel:0,passed:nRel>0&&pRel/nRel>=V6_RULES.reliability.gate}
 const metrics={N,D,T,P,dispatchedRate:N?D/N:0,responseRate:D?T/D:0,structuredRate:T?P/T:0,overallRate:reliability.rate}
 const evidenceGate=doubleReview.doubleGate&&unresolvedVeto===0&&judgeable>=V6_RULES.reliability.judgeableMin&&(Object.keys(coverage.directions) as V6Direction[]).every(k=>coverage.directions[k].rate>=V6_RULES.reliability.coverageMin)&&Object.values(coverage.chains).every(c=>c.rate>=V6_RULES.reliability.coverageMin)&&V6_RULES.vetoes.every(v=>safetyJudged[v as V6Safety]>=V6_RULES.reliability.safetyMinJudged)
 const reliabilityGate=reliability.passed
 const qualityLower=qualityPass(dims),qualityUpper=qualityPass(dimsUpper)
 const reasons:string[]=[]
 if(!valid)reasons.push('malformed-review')
 if(vetoes.length)reasons.push('veto:'+vetoes.join(','))
 if(unresolvedVeto)reasons.push('veto-unresolved:'+unresolvedVeto)
 if(!reliabilityGate)reasons.push('reliability:'+metrics.overallRate.toFixed(4))
 if(!evidenceGate)reasons.push('evidence:judgeable='+judgeable+',coverage,safety,double')
 if(!doubleReview.doubleGate)reasons.push('double-review:'+doubleReview.double+'/10,missing='+doubleReview.missingRequiredIds.join(','))
 if(actionFailures)reasons.push('action-not-landed:'+actionFailures)
 if(failedChecks)reasons.push('check-failures:'+failedChecks)
 if(zeroCall)reasons.push('zero-call:'+zeroCall)
 if(disagreements)reasons.push('annotation-disagreement:'+disagreements)
 if(!qualityLower)reasons.push('quality-lower:'+total.toFixed(2))
 let verdict:V6Verdict
 if(!roundRows.length)verdict='not-run'
 else if(!valid||vetoes.length)verdict='failed'
 else if(options.environmentUnavailable&&D<N)verdict='unmeasured-environment'
 // 可靠性是客观门：输出不完整时先判未通过，覆盖率不足另记原因。
 else if(!reliabilityGate)verdict='failed'
 else if(!evidenceGate)verdict='insufficient-evidence'
 else if(qualityLower)verdict='passed'
 else if(qualityUpper)verdict='insufficient-evidence'
 else verdict='failed'
 const serviceCount=roundRows.filter(r=>['service','cancel','interrupted'].includes(r.category)).length
 const outputFailures=roundRows.filter(r=>['empty','length','format','format-repaired-unreviewed'].includes(r.category)).length
 return {round,valid,verdict,reasons,doubleReview,judgeable,blocked,unknown:uncertain.length,categories,vetoes,coverage,safetyJudged,metrics,reliability,
  gates:{qualityLower,qualityUpper,reliability:reliabilityGate,evidence:evidenceGate},
  lower:{total,dimensions:dims,split},upper:{total:totalUpper,dimensions:dimsUpper,split:splitUpper},
  unresolvedVeto,partialCommit:categories['partial-commit']??0,serviceFailures:serviceCount,outputFailures,actionFailures,failedChecks,zeroCall,disagreements}
}
export function freezeV6(root:string,manifest:unknown){mkdirSync(root,{recursive:true,mode:0o700});const file=path.join(root,'v6-manifest.json');if(existsSync(file)){if(fingerprint(JSON.parse(readFileSync(file,'utf8')))!==fingerprint(manifest))throw Error('EVALUATION_REVISION_CHANGED')}else writeFileSync(file,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});return fingerprint(manifest)}
/** 逐例标注完成前不派发下一例；第一轮判失败不得进入第二轮。 */
/** 停损：连续三次可重试网络失败即暂停该模型；每模型最多两次恢复周期，用尽后由人决定是否重开。
 *  环境故障不改写成绩，但连续同一原因意味着继续派发只会烧预算。 */
export function v6RecoveryDecision(recent:readonly {retryable:boolean}[],cycles:number,max:number):'continue'|'pause'|'exhausted'{
 const needed=3
 if(recent.length<needed||!recent.slice(-needed).every(r=>r.retryable))return 'continue'
 return cycles>=max?'exhausted':'pause'
}
export function v6DispatchGate(rows:V6Row[],nextCase:string,round:number,cases:V6Case[],options:V6SummaryOptions={}){
 if([0,1].some(n=>v6Summary(rows,cases,n,options).vetoes.length))throw Error('EVALUATION_MODEL_STOPPED')
 for(const r of rows){if(r.round===round&&r.caseId===nextCase)continue;if(!r.review)throw Error('EVALUATION_REVIEW_REQUIRED')}
 if(rows.some(r=>r.round>round))throw Error('EVALUATION_ROUND_ORDER')
 if(!cases.some(c=>c.id===nextCase))throw Error('EVALUATION_CASES_NOT_AUTHORIZED')
 if(round===1&&v6Summary(rows.filter(r=>r.round===0),cases,0,options).verdict!=='passed')throw Error('EVALUATION_ROUND_REQUIRED')
}

/** Independent authorization; never changes the historical V6_RULES contract. */
export const COLLABORATION_RULES={authorization:'2026-10-10-memory-instrument-hygiene',prefix:'v6-2026-10-05/collaboration/',total:272,consolidation:240,answers:32,consolidationPerModel:120,answersPerModel:16,seconds:120,supervisionMs:180000,revision:13,historicalCalls:1444} as const
export const COLLABORATION_TASK_IDS=['standing','fact','recent','correction','duplicate','forget','permission','irrelevant'] as const
export function collaborationKeyParts(key:string,prefix:string=COLLABORATION_RULES.prefix){
 if(prefix!==COLLABORATION_RULES.prefix||!key.startsWith(prefix))throw Error('EVALUATION_CAMPAIGN_KEY')
 const parts=key.slice(prefix.length).split('/'),[revision,phase,model,a,b]=parts
 if(parts.length!==5||!/^r[1-9][0-9]*$/.test(revision!)||!['consolidation','answers'].includes(phase!)||!['MiniMax-M3','deepseek-flash'].includes(model!)||!a||!b||!/[A-Za-z0-9]/.test(a)||!/^[-A-Za-z0-9_]+$/.test(b)||phase==='consolidation'&&!['0','1'].includes(a)||phase==='answers'&&!['on','off'].includes(b))throw Error('EVALUATION_CAMPAIGN_KEY')
 if(phase==='consolidation'&&!V6_QUALITY_CASES.some(c=>c.id===b)||phase==='answers'&&!(COLLABORATION_TASK_IDS as readonly string[]).includes(a))throw Error('EVALUATION_CAMPAIGN_KEY')
 return {revision,phase:phase as 'consolidation'|'answers',model}
}
export function assertCollaborationCharge(keys:string[],key:string,prefix:string=COLLABORATION_RULES.prefix){
 const part=collaborationKeyParts(key,prefix)
 if(part.revision!=='r'+COLLABORATION_RULES.revision)throw Error('EVALUATION_CAMPAIGN_KEY')
 const local=keys.filter(k=>k.startsWith(prefix))
 if(local.filter(k=>k===key).length>=(part.phase==='answers'?1:2))throw Error('EVALUATION_CASE_CALL_LIMIT')
 const parts=local.map(k=>collaborationKeyParts(k,prefix)).filter(p=>p.revision===part.revision)
 if(parts.length>=COLLABORATION_RULES.total)throw Error('EVALUATION_LOCAL_CALL_LIMIT')
 const phase=parts.filter(p=>p.phase===part.phase)
 if(phase.length>=(part.phase==='answers'?COLLABORATION_RULES.answers:COLLABORATION_RULES.consolidation))throw Error('EVALUATION_PHASE_CALL_LIMIT')
 if(phase.filter(p=>p.model===part.model).length>=(part.phase==='answers'?COLLABORATION_RULES.answersPerModel:COLLABORATION_RULES.consolidationPerModel))throw Error('EVALUATION_PHASE_MODEL_CALL_LIMIT')
}
export function collaborationSchedule(cases:V6Case[],models:string[]){
 const groups=new Map<string,V6Case[]>();for(const c of cases){const key=c.chain?'chain-'+c.chain:c.direction;const group=groups.get(key)??[];group.push(c);groups.set(key,group)}
 const queues=[...groups.values()].map(rows=>rows.slice().sort((a,b)=>(a.step??0)-(b.step??0))),ordered:V6Case[]=[]
 while(queues.some(q=>q.length))for(const queue of queues){const c=queue.shift();if(c)ordered.push(c)}
 return [0,1].flatMap(round=>ordered.flatMap((c,index)=>(index%2?models.slice().reverse():models).map(model=>({round,caseId:c.id,model}))))
}

/** Collaboration-only resume checkpoints retain the complete charged history. */
type CollaborationRecoveryBinding={frozenHash:string;prefix:string;model:string}
type CollaborationRecoveryCycle=CollaborationRecoveryBinding&{at:string;reason:string;dispatchCount:number;historyHash:string}
export function collaborationRecoveryWindow<T extends {key:string}>(dispatches:T[],cycles:CollaborationRecoveryCycle[],binding:CollaborationRecoveryBinding):T[]{
 let watermark=0
 if(cycles.length>2||!new RegExp('^'+COLLABORATION_RULES.prefix+'r[1-9][0-9]*/$').test(binding.prefix))throw Error('EVALUATION_RECOVERY_INVALID')
 for(const cycle of cycles){
  if(cycle.frozenHash!==binding.frozenHash||cycle.prefix!==binding.prefix||cycle.model!==binding.model||!Number.isInteger(cycle.dispatchCount)||cycle.dispatchCount<=watermark||cycle.dispatchCount>dispatches.length||cycle.historyHash!==fingerprint(dispatches.slice(0,cycle.dispatchCount)))throw Error('EVALUATION_RECOVERY_INVALID')
  watermark=cycle.dispatchCount
 }
 return dispatches.slice(watermark).filter(d=>d.key.startsWith(binding.prefix)&&collaborationKeyParts(d.key).model===binding.model)
}
export function collaborationResumeCycle<T extends {key:string}>(dispatches:T[],cycles:CollaborationRecoveryCycle[],binding:CollaborationRecoveryBinding):CollaborationRecoveryCycle{
 if(cycles.length>=2||collaborationRecoveryWindow(dispatches,cycles,binding).length<3)throw Error('EVALUATION_RECOVERY_INVALID')
 return {...binding,at:new Date().toISOString(),reason:'operator-resume-after-three-retryable-failures',dispatchCount:dispatches.length,historyHash:fingerprint(dispatches)}
}
/** 只读投影：链上步骤若按材料种类计入真实维。不改正式 70／各维 60% 或 v6Summary。 */
export function v6TrueDimension(spec:V6Case):V6Direction{
 if(!spec.chain)return spec.direction
 if(spec.kind==='long-requirement')return 'standing'
 if(spec.kind==='project-fact'||spec.kind==='scoped-third-party'||spec.kind==='human-decision')return 'fact'
 if(spec.kind==='explicit-correction'||spec.kind==='repeat-after-correction'||spec.kind==='ambiguous-change')return 'update'
 return 'recent'
}
export function v6ChainDimensionProjection(rows:V6Row[],cases:V6Case[],round:number,options?:Parameters<typeof v6Summary>[3]){
 const official=v6Summary(rows,cases,round,options)
 const remapped=cases.map(spec=>({...spec,direction:v6TrueDimension(spec),chain:undefined,step:undefined}))
 const projected=v6Summary(rows,remapped,round,options)
 const maxOf=(list:readonly {direction:V6Direction;weight:number}[],direction:V6Direction)=>list.filter(c=>c.direction===direction).reduce((n,c)=>n+c.weight,0)
 const floor=(earned:number,max:number)=>({earned,max,rate:max?earned/max:1,meets:earned>=max*0.6})
 const projectedRecent=floor(projected.lower.dimensions.recent,maxOf(remapped,'recent'))
 return {
  official:{recent:floor(official.lower.dimensions.recent,maxOf(cases,'recent')),update:floor(official.lower.dimensions.update,maxOf(cases,'update')),total:official.lower.total},
  projected:{recent:projectedRecent,update:floor(projected.lower.dimensions.update,maxOf(remapped,'update')),standing:floor(projected.lower.dimensions.standing,maxOf(remapped,'standing')),fact:floor(projected.lower.dimensions.fact,maxOf(remapped,'fact')),total:projected.lower.total},
  recentFloorStillBroken:!projectedRecent.meets,
  note:'只读离线投影，不是认证成绩，也不改变正式链式几何'
 }
}

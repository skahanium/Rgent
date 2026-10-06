import {app,safeStorage} from 'electron'
import {readFileSync,mkdirSync,readdirSync,existsSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {lookup} from 'node:dns/promises'
import {connect} from 'node:tls'
import {randomUUID,createHash} from 'node:crypto'
import {loadModelCredentialReadOnly} from '../src/main/model-config.ts'
import {streamModelStep,type ModelStepInput,type ModelStepEvent} from '../src/main/model-stream.ts'
import {memoryConsolidationSystem,memoryContinuitySystem,parseContinuitySuggestions} from '../src/main/working-memory-consolidation.ts'
import {MEMORY_QUALITY_CASES} from '../test/fixtures/memory-quality.ts'
import type {MemoryQualityCase} from '../test/fixtures/memory-quality.ts'
import {runMemoryQualityCase,memorySemanticReviewSystem} from './memory-quality-runner.ts'
import {EvaluationJournal,atomicReport,fingerprint,modelQualitySummary,recordedQualityReview,V4_RULES,V4_SCREEN,V4_PARENT_MANIFEST,V4_PREFIX,v4Cases,v4Selection,v4EvidenceComplete,freezeV4,v4Summary,v4DispatchGate,v4ScreenGate,v4ResumeAction,type V4Row,type V4Annotation,type V4Category,V5_RULES,V5_PREFIX,freezeV5,v5Summary,v5ScreenDispatchGate,v5TerminalCategory,v5DiagnosticTargets,v5ActionEvidence,v5ControlledStatus,type V5Row,type V5Annotation,V6_RULES,V6_PREFIX,V6_CATEGORIES,V6_SCORING_CATEGORIES,freezeV6,v6ReviewValid,v6Summary,v6DispatchGate,v6TerminalCategory,v6RecoveryDecision,type V6Row,type V6Annotation} from './memory-quality-support.ts'

import {V5_QUALITY_CASES,V5_SCREEN_IDS} from '../test/fixtures/v5-memory-quality.ts'
import {V6_QUALITY_CASES,V6_INDEPENDENT_IDS} from '../test/fixtures/v6-memory-quality.ts'
import type {V6Case} from '../test/fixtures/v6-memory-quality.ts'

const options=JSON.parse(process.env.RGENT_MEMORY_EVAL_OPTIONS??'{}') as {root:string;budget:string;profile:string;report:string;models:string[];pilot:boolean;live:boolean;only?:string;v4?:boolean;v5?:boolean;v6?:boolean;round?:number;freeze?:boolean;diagnose?:boolean;review?:boolean;stop?:string;resume?:string;annotation?:string;double?:boolean;screen?:boolean;hashes?:boolean;cases?:string[]}
app.setName('rgent')
app.setPath('userData',path.join(options.report,'electron-profile'))
// Electron emits ready after its entry module has finished loading.
void app.whenReady().then(async()=>{
console.log('EVALUATION_READY')
const controller=new AbortController();let journal:EvaluationJournal|undefined
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>controller.abort())
const sourceFiles=(dir:string):string[]=>readdirSync(path.join(options.root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?sourceFiles(dir+'/'+e.name):e.name.endsWith('.ts')?[dir+'/'+e.name]:[])
try{
 if(options.v6){await runV6(controller,sourceFiles);app.exit(controller.signal.aborted?1:0);return}
 if(options.v5){await runV5(controller,sourceFiles);app.exit(controller.signal.aborted?1:0);return}
 if(options.v4){await runV4(controller,sourceFiles);app.exit(controller.signal.aborted?1:0);return}
 if(!options.live){console.log(JSON.stringify({cases:MEMORY_QUALITY_CASES.length,heldOut:MEMORY_QUALITY_CASES.filter(c=>c.heldOut).length,network:false}));app.exit(0)}
 else{
  const credentials=options.models.map(id=>loadModelCredentialReadOnly(options.profile,safeStorage,id))
  if(credentials.length!==2||credentials.map(c=>c.modelId).sort().join(',')!==['MiniMax-M3','deepseek-flash'].sort().join(','))throw Error('EVALUATION_MODELS_NOT_AUTHORIZED')
  const configBefore=readFileSync(path.join(options.profile,'model-config.json'))
  const configuration=fingerprint(configBefore.toString('utf8'))
  const runtime=fingerprint({configuration,files:[...sourceFiles('src/main'),...sourceFiles('src/markdown'),...sourceFiles('src/shared'),...sourceFiles('scripts'),'scripts/check-memory.mjs'].sort().map(f=>[f,readFileSync(path.join(options.root,f),'utf8')])})
  const dataset=fingerprint(MEMORY_QUALITY_CASES),promptHash=fingerprint(memoryConsolidationSystem)
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:options.root,encoding:'utf8'}).trim()
  const models=credentials.map((c,i)=>({recordId:options.models[i]!,modelId:c.modelId,connectionId:c.connectionId,host:new URL(c.baseURL).host}))
  const manifest={version:1,authorization:'2026-10-04-memory-quality-package',baseline:'406d31d',dataset,models,maxCalls:1440}
  // The user corrected the domestic MiniMax recipient on 2026-10-04. Retain all
  // earlier failed calls; this single approved correction never resets the ceiling.
  const previousManifest={...manifest,models:models.map(m=>m.modelId==='MiniMax-M3'&&m.host==='api.minimax.cn'?{...m,host:'api.minimax.io'}:m)}
  journal=new EvaluationJournal(options.report,manifest,1440,options.budget,previousManifest)
  const selected=options.pilot?MEMORY_QUALITY_CASES.filter(c=>!c.heldOut).filter((c,i,list)=>list.findIndex(x=>x.group===c.group)===i).concat(MEMORY_QUALITY_CASES.filter(c=>c.group==='standing'&&!c.heldOut).slice(1,3)):MEMORY_QUALITY_CASES
  if(options.only&&!models.some(m=>m.modelId===options.only))throw Error('EVALUATION_MODELS_NOT_AUTHORIZED')
  const tasks=models.flatMap((model,m)=>!options.only||model.modelId===options.only?selected.flatMap(spec=>Array.from({length:options.pilot?1:3},(_,repeat)=>({model,m,spec,repeat}))):[])
  let cursor=0,finished=0,fatal:string|null=null
  const publicFailure=(e:unknown)=>e instanceof Error&&/^[A-Z_]{3,80}$/.test(e.message)?e.message:'EVALUATION_REQUEST_FAILED'
  const worker=async()=>{while(cursor<tasks.length&&!controller.signal.aborted&&!fatal){
   const {model,m,spec,repeat}=tasks[cursor++]!,key=[runtime,model.recordId,spec.id,repeat].join('/')
   if((journal!.read(key) as {status?:string}|null)?.status==='completed'){finished++;continue}
   journal!.write(key,{status:'started',key,model,case:spec,repeat,commit,runtime,dataset,promptHash,startedAt:new Date().toISOString()})
   const responses:{body:string;usage:unknown;input:unknown;reason:string|null;failure?:unknown;finishReason?:string}[]=[]
   const publish=(value:unknown)=>journal!.finish(key,JSON.parse(JSON.stringify(value).replaceAll(credentials[m]!.apiKey,'[redacted]')))
   const stream=async function*(input:ModelStepInput):AsyncGenerator<ModelStepEvent>{
    if(!readFileSync(path.join(options.profile,'model-config.json')).equals(configBefore)){fatal='EVALUATION_PROFILE_CHANGED';controller.abort();throw Error(fatal)}
    try{journal!.charge(key)}catch(e){fatal=publicFailure(e);controller.abort();throw e}
    const response:{body:string;usage:unknown;input:unknown;reason:string|null;failure?:unknown;finishReason?:string}={body:'',usage:null,input:{system:input.system,messages:input.messages,maxOutputTokens:input.maxOutputTokens},reason:null};responses.push(response)
    try{for await(const event of streamModelStep(input)){if(event.type==='text')response.body+=event.text;if(event.type==='finish'){response.usage=event.usage??null;response.finishReason=event.reason}yield event}}
    catch(e){response.reason=publicFailure(e);if(e instanceof Error&&e.message==='MODEL_REQUEST_FAILED')response.failure=e.cause;throw e}
   }
   try{const result=await runMemoryQualityCase(spec,credentials[m]!,stream,controller.signal)
    const row={status:controller.signal.aborted?'interrupted':'completed',key,model,case:spec,repeat,commit,runtime,dataset,promptHash,finishedAt:new Date().toISOString(),responses,result,review:null}
    publish(row)
   }catch(e){publish({status:controller.signal.aborted?'interrupted':'completed',key,model,case:spec,repeat,commit,runtime,dataset,promptHash,responses,error:publicFailure(e),review:null})}
   finished++;console.log(JSON.stringify({finished,total:tasks.length,model:model.modelId,case:spec.id,calls:journal!.calls}))
  }}
  await Promise.all([worker(),worker()])
  if(!readFileSync(path.join(options.profile,'model-config.json')).equals(configBefore))throw Error('EVALUATION_PROFILE_CHANGED')
  const quality=models.map(model=>{const rows=tasks.filter(t=>t.model.recordId===model.recordId).map(t=>{const row=journal!.read([runtime,model.recordId,t.spec.id,t.repeat].join('/'))
   return {caseId:t.spec.id,repeat:t.repeat,review:recordedQualityReview(row)}})
   return {model,...modelQualitySummary(rows,MEMORY_QUALITY_CASES)}})
  atomicReport(path.join(options.report,'run-summary.json'),{commit,runtime,dataset,promptHash,configuration,pilot:options.pilot,only:options.only??null,finished,expected:tasks.length,calls:journal.calls,models,quality,semanticReview:quality.every(q=>q.pending===0&&q.coverage===q.expected)?'reviewed':'pending',qualityPassed:!options.pilot&&quality.every(q=>q.passed),stopped:controller.signal.aborted,fatal})
  console.log(JSON.stringify({finished,expected:tasks.length,calls:journal.calls,semanticReview:'pending',fatal}))
  journal.close();app.exit(controller.signal.aborted||fatal?1:0)
 }
}catch(e){controller.abort();console.error(e instanceof Error&&/^[A-Z_]{3,80}$/.test(e.message)?e.message:'EVALUATION_SETUP_FAILED');journal?.close();app.exit(1)}
})

async function runV4(controller:AbortController,sourceFiles:(dir:string)=>string[]){
 const canonical=path.join(options.budget,'v4'),frozenFile=path.join(canonical,'v4-manifest.json')
 const cases=v4Cases(),arms=['baseline','review'] as const
 mkdirSync(canonical,{recursive:true,mode:0o700})
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:options.root,encoding:'utf8'}).trim()
 const publicError=(e:unknown)=>e instanceof Error&&/^[A-Z_]{3,80}$/.test(e.message)?e.message:'EVALUATION_REQUEST_FAILED'
 const safeModels=()=>{
  const raw=readFileSync(path.join(options.profile,'model-config.json')),cfg=JSON.parse(raw.toString())
  const models=options.models.map(id=>{const m=cfg.models?.find((m:{id:string})=>m.id===id),c=cfg.connections?.find((c:{id:string})=>c.id===m?.connectionId)
   if(!m||!c)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');const url=new URL(c.baseURL)
   if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['api.minimax.cn','api.deepseek.com'].includes(url.host)||m.modelId==='MiniMax-M3'&&url.host!=='api.minimax.cn'||m.modelId==='deepseek-flash'&&url.host!=='api.deepseek.com')throw Error('EVALUATION_MODELS_NOT_AUTHORIZED')
   return {recordId:id,modelId:m.modelId as string,connectionId:c.id as string,host:url.host,baseURL:c.baseURL as string,contextTokens:m.contextTokens as number}})
  if(models.length!==2||models.map(m=>m.modelId).sort().join()!==['MiniMax-M3','deepseek-flash'].sort().join())throw Error('EVALUATION_MODELS_NOT_AUTHORIZED')
  return {models,raw,configuration:fingerprint(raw.toString())}
 }
 const diagnose=async(models:{host:string;modelId:string}[])=>{
  const rows=[]
  for(const m of models){let dns=false,tls=false,reason:string|null=null
   try{await Promise.race([lookup(m.host),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('DNS_TIMEOUT')),10000);timer.unref()})]);dns=true
    await new Promise<void>((resolve,reject)=>{const socket=connect({host:m.host,port:443,servername:m.host,rejectUnauthorized:true});socket.setTimeout(10000,()=>socket.destroy(Error('TLS_TIMEOUT')));socket.once('secureConnect',()=>{socket.end();resolve()});socket.once('error',e=>{socket.destroy();reject(e)})});tls=true
   }catch(e){reason=e instanceof Error&&'code' in e&&/^[A-Z0-9_]+$/.test(String(e.code))?String(e.code):'CONNECTION_DIAGNOSTIC_FAILED'}
   rows.push({...m,dns,tls,reason})
  }
  atomicReport(path.join(canonical,'diagnostic-'+randomUUID()+'.json'),{at:new Date().toISOString(),credentialsRead:false,httpRequests:0,rows})
  console.log(JSON.stringify({diagnostic:rows}));if(rows.some(r=>!r.dns||!r.tls))throw Error('EVALUATION_CONNECTION_UNSTABLE')
 }
 if(!options.freeze&&!options.live&&!options.review&&!options.stop&&!options.diagnose){console.log(JSON.stringify({mode:'v4-development-only',cases:cases.length,screen:V4_SCREEN,arms,network:false,maxCalls:480,historyCalls:816}));return}
 let frozen:any
 if(options.freeze||options.live||options.diagnose){
  const metadata=safeModels()
  // This opens only DNS and an authenticated TLS handshake, before decrypting a key.
  await diagnose(metadata.models.map(({host,modelId})=>({host,modelId})))
  if(options.diagnose&&!options.freeze&&!options.live)return
  if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:options.root,encoding:'utf8'}).trim())throw Error('EVALUATION_DIRTY_EXECUTION')
  const files=[...sourceFiles('src/main'),...sourceFiles('src/markdown'),...sourceFiles('src/shared'),...sourceFiles('scripts'),'scripts/check-memory.mjs'].sort()
  const runtime=fingerprint(files.map(f=>[f,readFileSync(path.join(options.root,f),'utf8')]))
  const candidateFiles=['src/main/working-memory-consolidation.ts','src/main/working-memory-service.ts','src/main/working-memory-store.ts','src/main/memory-use.ts']
  frozen={version:4,authorization:'2026-10-04-v4',executionCommit:commit,runtime,configuration:metadata.configuration,models:metadata.models,cases:cases.map(c=>c.id),screen:V4_SCREEN,dataset:fingerprint(cases),arms,
   proposalPrompt:memoryConsolidationSystem,reviewPrompt:memorySemanticReviewSystem,candidate:fingerprint(candidateFiles.map(f=>[f,readFileSync(path.join(options.root,f),'utf8')])),rules:V4_RULES,scorer:fingerprint(readFileSync(path.join(options.root,'scripts/memory-quality-support.ts'),'utf8')),parentManifestHash:V4_PARENT_MANIFEST,maxCalls:480}
  const state=JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8'))
  if(state.manifest!==V4_PARENT_MANIFEST||state.calls<816||state.limit!==1440)throw Error('EVALUATION_HISTORY_MISMATCH')
  freezeV4(canonical,frozen)
  if(options.freeze&&!options.live){console.log(JSON.stringify({frozen:fingerprint(frozen),executionCommit:commit,cases:60,calls:state.calls,manifest:frozenFile}));return}
 }else{if(!existsSync(frozenFile))throw Error('EVALUATION_FREEZE_REQUIRED');frozen=JSON.parse(readFileSync(frozenFile,'utf8'))}
 if(frozen.scorer!==fingerprint(readFileSync(path.join(options.root,'scripts/memory-quality-support.ts'),'utf8'))||fingerprint(frozen.rules)!==fingerprint(V4_RULES)||frozen.dataset!==fingerprint(cases))throw Error('EVALUATION_SCORER_CHANGED')
 const frozenHash=fingerprint(frozen)
 const modelFilter=options.only??options.stop
 if(modelFilter&&!frozen.models.some((m:any)=>m.modelId===modelFilter))throw Error('EVALUATION_MODELS_NOT_AUTHORIZED')
 const key=(model:any,id:string,arm:string)=>V4_PREFIX+model.modelId+'/'+id+'/'+arm
 const resultFile=(key:string)=>path.join(canonical,'result-'+fingerprint(key)+'.json')
 const annotationFile=(key:string)=>path.join(canonical,'annotation-'+fingerprint(key)+'.json')
 const readRow=(model:any,id:string,arm:V4Row['arm']):V4Row|null=>{
  const k=key(model,id,arm),file=resultFile(k);if(!existsSync(file))return null
  const r=JSON.parse(readFileSync(file,'utf8')),annotation=existsSync(annotationFile(k))?JSON.parse(readFileSync(annotationFile(k),'utf8')):null
  if(annotation?.review?.evidenceComplete&&!v4EvidenceComplete(r))throw Error('EVALUATION_ANNOTATION_INVALID')
  if(r.frozenHash!==frozenHash||annotation&&(annotation.frozenHash!==frozenHash||annotation.resultHash!==fingerprint(r)))throw Error('EVALUATION_REVISION_CHANGED')
  const receipt=r.result?.receipt,entries=r.result?.entries??[],before=r.result?.before??[]
  const automaticApplied=receipt?.outcome==='applied'&&Array.isArray(receipt.entryIds)&&receipt.entryIds.some((id:string)=>entries.some((e:any)=>e.id===id&&e.status==='active'&&!before.some((old:any)=>old.id===e.id&&old.version===e.version)))
  return {caseId:id,arm,category:r.result?.experiment?.category??(r.status==='interrupted'?'interrupted':'service'),automaticApplied,controlledFailure:r.result?.controlledFailure,calls:r.responses?.length??0,latencyMs:r.latencyMs??0,receiptReason:receipt?.reason,review:annotation?.review??null}
 }
 const allRows=(model:any)=>cases.flatMap(c=>arms.flatMap(a=>{const r=readRow(model,c.id,a);return r?[r]:[]}))
 const stopFile=(model:any)=>path.join(canonical,'stop-'+model.modelId+'.json')
 if(options.stop){const model=frozen.models.find((m:any)=>m.modelId===options.stop);if(!existsSync(stopFile(model)))writeFileSync(stopFile(model),JSON.stringify({frozenHash,at:new Date().toISOString(),reason:'operator-stop',rows:allRows(model)},null,2),{flag:'wx',mode:0o600})}
 if(options.annotation){
  if(!options.review)throw Error('EVALUATION_REVIEW_REQUIRED')
  const annotation=JSON.parse(readFileSync(options.annotation,'utf8')) as {key:string;resultHash:string;frozenHash:string;review:V4Annotation}
  const file=resultFile(annotation.key);if(!existsSync(file)||annotation.frozenHash!==frozenHash||annotation.resultHash!==fingerprint(JSON.parse(readFileSync(file,'utf8'))))throw Error('EVALUATION_ANNOTATION_INVALID')
  const result=JSON.parse(readFileSync(file,'utf8')),spec=cases.find(c=>c.id===result.case.id)
  if(!spec||!arms.includes(result.arm)||result.key!==annotation.key)throw Error('EVALUATION_ANNOTATION_INVALID')
  const category:V4Category=result.result?.experiment?.category??'service'
  const row:V4Row={caseId:spec.id,arm:result.arm,category,automaticApplied:false,review:annotation.review}
  if(!v4Summary([row],[spec]).arms[result.arm as V4Row['arm']].valid)throw Error('EVALUATION_ANNOTATION_INVALID')
  // Output/terminal execution evidence cannot be supplied by the annotator.
  if(annotation.review.evidenceComplete&&!v4EvidenceComplete(result))throw Error('EVALUATION_ANNOTATION_INVALID')
  const target=annotationFile(annotation.key);if(existsSync(target))throw Error('EVALUATION_ANNOTATION_EXISTS')
  writeFileSync(target,JSON.stringify({...annotation,annotator:'coding-agent-semantic-review-not-user-confirmation',rules:fingerprint(V4_RULES),at:new Date().toISOString()},null,2),{flag:'wx',mode:0o600})
 }
 let journal:EvaluationJournal|undefined
 try{
  if(options.live){
   if(!options.only||options.cases?.length!==1)throw Error('EVALUATION_ONE_PAIR_REQUIRED')
   const selected=v4Selection(options.cases,!!options.screen),model=frozen.models.find((m:any)=>m.modelId===options.only)
   if(existsSync(stopFile(model)))throw Error('EVALUATION_MODEL_STOPPED')
   journal=new EvaluationJournal(canonical,frozen,1440,options.budget,undefined,{parentManifestHash:V4_PARENT_MANIFEST,prefix:V4_PREFIX,limit:480,perModelLimit:240})
   const beforeConfig=readFileSync(path.join(options.profile,'model-config.json'))
   const credential=loadModelCredentialReadOnly(options.profile,safeStorage,model.recordId)
   if(credential.modelId!==model.modelId||credential.baseURL!==model.baseURL||credential.contextTokens!==model.contextTokens)throw Error('EVALUATION_REVISION_CHANGED')
   for(const spec of selected){
    if(!options.screen&&!V4_SCREEN.includes(spec.id))v4ScreenGate(allRows(model))
    v4DispatchGate(allRows(model),spec.id)
    // A killed process may have charged without publishing even its initial result.
    for(const charged of journal.dispatchKeys().filter(k=>k.startsWith(V4_PREFIX+model.modelId+'/'))){if(!existsSync(resultFile(charged)))throw Error('EVALUATION_CHARGED_UNFINISHED')}
    for(const arm of arms){
     if(controller.signal.aborted)break
     const k=key(model,spec.id,arm),action=v4ResumeAction(journal.charged(k),journal.read(k) as {status?:string}|null)
     if(action==='done')continue;if(action==='charged-unfinished')throw Error('EVALUATION_CHARGED_UNFINISHED')
     const responses:any[]=[],startedAt=new Date().toISOString(),started=performance.now()
     // Started is diagnostic only, never a claim that an uncharged arm consumed quota.
     journal.write(k,{status:'started',key:k,frozenHash,case:spec,model,arm,startedAt,commit})
     const stream=async function*(input:ModelStepInput):AsyncGenerator<ModelStepEvent>{
      if(controller.signal.aborted||input.signal.aborted)throw Error('MEMORY_CANCELLED')
      if(!readFileSync(path.join(options.profile,'model-config.json')).equals(beforeConfig))throw Error('EVALUATION_PROFILE_CHANGED')
      journal!.charge(k)
      const response:any={input:{system:input.system,messages:input.messages,maxOutputTokens:input.maxOutputTokens},body:'',usage:null,reason:null,startedAt:new Date().toISOString()};responses.push(response)
      const t=performance.now()
      try{for await(const event of streamModelStep(input)){if(event.type==='text')response.body+=event.text;if(event.type==='finish'){response.usage=event.usage??null;response.finishReason=event.reason}yield event}}
      catch(e){response.reason=publicError(e);throw e}finally{response.latencyMs=performance.now()-t}
     }
     let result:unknown,error:string|null=null
     try{result=await runMemoryQualityCase(spec,credential,stream,controller.signal,{strategy:arm})}catch(e){error=publicError(e);result=e&&typeof e==='object'&&'evaluationResult' in e?e.evaluationResult:null}
     const row={status:controller.signal.aborted?'interrupted':'completed',key:k,frozenHash,case:spec,model,arm,startedAt,finishedAt:new Date().toISOString(),latencyMs:performance.now()-started,commit,responses,result:result??null,error,review:null}
     // No provider exceptions, reasoning events or credentials are serialized.
     journal.finish(k,JSON.parse(JSON.stringify(row).replaceAll(credential.apiKey,'[redacted]')))
     console.log(JSON.stringify({model:model.modelId,case:spec.id,arm,calls:journal.calls,localCalls:journal.localCalls,category:(result as any)?.experiment?.category??'service'}))
     if(!readFileSync(path.join(options.profile,'model-config.json')).equals(beforeConfig))throw Error('EVALUATION_PROFILE_CHANGED')
    }
   }
  }
  const state=JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8'))
  const summaries=frozen.models.map((model:any)=>{
   const rows=allRows(model),screenRows=rows.filter(r=>V4_SCREEN.includes(r.caseId)),screen=v4Summary(screenRows,cases.filter(c=>V4_SCREEN.includes(c.id)),true),overall=v4Summary(rows,cases)
   if(screen.decision==='stop'||overall.decision==='stop'){if(!existsSync(stopFile(model)))writeFileSync(stopFile(model),JSON.stringify({frozenHash,at:new Date().toISOString(),reason:'frozen-stop-rule',screen,overall},null,2),{flag:'wx',mode:0o600})}
   return {model,actualCalls:state.dispatches.filter((d:any)=>d.key.startsWith(V4_PREFIX+model.modelId+'/')).length,stopped:existsSync(stopFile(model)),screen,overall,rows}
  })
  const summary={frozenHash,executionCommit:frozen.executionCommit,reportCommit:commit,at:new Date().toISOString(),calls:state.calls,previousCalls:816,localCalls:state.dispatches.filter((d:any)=>d.key.startsWith(V4_PREFIX)).length,remainingGlobal:1440-state.calls,chargedUnfinished:[...new Set<string>(state.dispatches.filter((d:any)=>d.key.startsWith(V4_PREFIX)).map((d:any)=>String(d.key)))].filter(k=>!existsSync(resultFile(k))||!['completed','interrupted'].includes(JSON.parse(readFileSync(resultFile(k),'utf8')).status)),models:summaries,formalQualityPassed:false,productionStrategyChanged:false,userSemanticConfirmation:false}
  atomicReport(path.join(canonical,'summary-'+randomUUID()+'.json'),summary)
  atomicReport(path.join(options.report,'v4-summary-'+randomUUID()+'.json'),summary)
  console.log(JSON.stringify({summaries:summaries.map((s:any)=>({model:s.model.modelId,screen:s.screen.decision,overall:s.overall.decision,coverage:s.overall.coverage,stopped:s.stopped})),calls:state.calls,formalQualityPassed:false}))
 }finally{journal?.close()}
}

async function runV5(controller:AbortController,sourceFiles:(dir:string)=>string[]){
 const root=path.join(options.budget,'v5'),manifestFile=path.join(root,'v5-manifest.json'),cases=V5_QUALITY_CASES
 mkdirSync(root,{recursive:true,mode:0o700})
 const publicError=(e:unknown)=>e instanceof Error&&/^[A-Z_]{3,80}$/.test(e.message)?e.message:'EVALUATION_REQUEST_FAILED'
 const runtime=()=>fingerprint([...sourceFiles('src/main'),...sourceFiles('src/markdown'),...sourceFiles('src/shared'),...sourceFiles('scripts'),'scripts/check-memory.mjs','test/fixtures/v5-memory-quality.ts'].sort().map(f=>[f,readFileSync(path.join(options.root,f),'utf8')]))
 const metadata=()=>{const raw=readFileSync(path.join(options.profile,'model-config.json')),cfg=JSON.parse(raw.toString());const models=options.models.map(id=>{const m=cfg.models?.find((m:any)=>m.id===id),c=cfg.connections?.find((c:any)=>c.id===m?.connectionId);if(!m||!c)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');const url=new URL(c.baseURL),expected=m.modelId==='MiniMax-M3'?'api.minimax.cn':m.modelId==='deepseek-flash'?'api.deepseek.com':null;if(url.protocol!=='https:'||url.host!==expected||url.username||url.password||url.search||url.hash)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');return {recordId:id,modelId:m.modelId,host:url.host,baseURL:c.baseURL,contextTokens:m.contextTokens,connectionId:c.id}});if(models.length!==2||new Set(models.map(m=>m.modelId)).size!==2)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');return {raw,models,configuration:fingerprint(raw.toString())}}
 const diagnose=async(models:any[])=>{const rows=[];for(const m of models){let dns=false,tls=false;try{await Promise.race([lookup(m.host),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('DNS_TIMEOUT')),10000);t.unref()})]);dns=true;await new Promise<void>((resolve,reject)=>{const socket=connect({host:m.host,port:443,servername:m.host,rejectUnauthorized:true});socket.setTimeout(10000,()=>socket.destroy(Error('TLS_TIMEOUT')));socket.once('secureConnect',()=>{socket.end();resolve()});socket.once('error',e=>{socket.destroy();reject(e)})});tls=true}catch{}rows.push({model:m.modelId,host:m.host,dns,tls})}atomicReport(path.join(root,'diagnostic-'+randomUUID()+'.json'),{at:new Date().toISOString(),credentialsRead:false,httpRequests:0,rows});if(rows.some(r=>!r.dns||!r.tls))throw Error('EVALUATION_CONNECTION_UNSTABLE')}
 if(!options.freeze&&!options.diagnose&&!options.live&&!options.review&&!options.stop){console.log(JSON.stringify({mode:'v5-development-only',network:false,attempts:120,cases:cases.length,screen:V5_SCREEN_IDS,rules:V5_RULES}));return}
 let frozen:any
 if(options.freeze){const meta=metadata();if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:options.root,encoding:'utf8'}).trim())throw Error('EVALUATION_DIRTY_EXECUTION');const parent=JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8'));if(parent.calls!==828||parent.limit!==1440||parent.manifest!==V4_PARENT_MANIFEST)throw Error('EVALUATION_HISTORY_MISMATCH');frozen={version:5,authorization:'2026-10-05-v5',executionCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:options.root,encoding:'utf8'}).trim(),runtime:runtime(),configuration:meta.configuration,models:meta.models,cases,screen:V5_SCREEN_IDS,rules:V5_RULES,prompt:memoryContinuitySystem,scorer:fingerprint(readFileSync(path.join(options.root,'scripts/memory-quality-support.ts'),'utf8')),parentManifestHash:parent.manifest,maxCalls:240};freezeV5(root,frozen);console.log(JSON.stringify({frozen:fingerprint(frozen),manifest:manifestFile,calls:parent.calls}));if(!options.live&&!options.diagnose)return}
 if(!frozen){if(!existsSync(manifestFile))throw Error('EVALUATION_FREEZE_REQUIRED');frozen=JSON.parse(readFileSync(manifestFile,'utf8'))}
 if(frozen.runtime!==runtime()||fingerprint(frozen.cases)!==fingerprint(cases)||fingerprint(frozen.rules)!==fingerprint(V5_RULES)||frozen.prompt!==memoryContinuitySystem)throw Error('EVALUATION_REVISION_CHANGED')
 if(options.diagnose||options.live){const meta=metadata();if(meta.configuration!==frozen.configuration||fingerprint(meta.models)!==fingerprint(frozen.models))throw Error('EVALUATION_PROFILE_CHANGED');const targets=v5DiagnosticTargets(meta.models,!!options.live,options.only);await diagnose(targets);if(!options.live)return}
 const frozenHash=fingerprint(frozen),key=(model:string,round:number,id:string)=>V5_PREFIX+model+'/'+round+'/'+id
 const resultFile=(k:string)=>path.join(root,'result-'+fingerprint(k)+'.json'),annotationFile=(k:string)=>path.join(root,'annotation-'+fingerprint(k)+'.json')
 const classify=v5TerminalCategory
 const evidence=(r:any)=>v4EvidenceComplete({...r,result:{...r.result,experiment:{category:classify(r)==='empty'?'safe-empty':'valid'}}})
 const rows=(model:string):V5Row[]=>[0,1].flatMap(round=>cases.flatMap(c=>{const k=key(model,round,c.id),f=resultFile(k);if(!existsSync(f))return [];const r=JSON.parse(readFileSync(f,'utf8')),af=annotationFile(k),a=existsSync(af)?JSON.parse(readFileSync(af,'utf8')):null;if(r.frozenHash!==frozenHash||a&&(a.frozenHash!==frozenHash||a.resultHash!==fingerprint(r)))throw Error('EVALUATION_REVISION_CHANGED');return [{caseId:c.id,round,category:classify(r),actionVerified:v5ActionEvidence(c,r.result),controls:v5ControlledStatus(c,r.result),review:a?.review??null}]}))
 const stopFile=(model:string)=>path.join(root,'stop-'+model+'.json')
 if(options.stop){if(!frozen.models.some((m:any)=>m.modelId===options.stop))throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');if(!existsSync(stopFile(options.stop)))writeFileSync(stopFile(options.stop),JSON.stringify({frozenHash,reason:'operator-stop'}),{flag:'wx',mode:0o600})}
 if(options.annotation){if(!options.review)throw Error('EVALUATION_REVIEW_REQUIRED');const a=JSON.parse(readFileSync(options.annotation,'utf8')),f=resultFile(a.key);if(!existsSync(f))throw Error('EVALUATION_ANNOTATION_INVALID');const r=JSON.parse(readFileSync(f,'utf8')),c=cases.find(c=>c.id===r.case.id);if(!c||r.key!==a.key||a.frozenHash!==frozenHash||a.resultHash!==fingerprint(r)||a.review.evidenceComplete&&!evidence(r)||!v5Summary([{caseId:c.id,round:r.round,category:classify(r),actionVerified:v5ActionEvidence(c,r.result),controls:v5ControlledStatus(c,r.result),review:a.review as V5Annotation}],[c],r.round).valid)throw Error('EVALUATION_ANNOTATION_INVALID');writeFileSync(annotationFile(a.key),JSON.stringify({...a,annotator:V5_RULES.annotation}),{flag:'wx',mode:0o600})}
 let journal:EvaluationJournal|undefined
 try{if(options.live){const model=frozen.models.find((m:any)=>m.modelId===options.only),round=options.round??0,id=options.cases?.[0],spec=cases.find(c=>c.id===id);if(!model||!spec||options.cases?.length!==1||![0,1].includes(round))throw Error('EVALUATION_ONE_ATTEMPT_REQUIRED');if(existsSync(stopFile(model.modelId)))throw Error('EVALUATION_MODEL_STOPPED');const prior=rows(model.modelId);v5ScreenDispatchGate(prior,spec.id,round,!!options.screen,cases,V5_SCREEN_IDS);if(spec.chain&&spec.step!>1&&!prior.some(r=>r.round===round&&r.caseId===`v5-chain-${spec.chain}-${spec.step!-1}`&&r.review?.evidenceComplete))throw Error('EVALUATION_CHAIN_ORDER')
  journal=new EvaluationJournal(root,frozen,1440,options.budget,undefined,{parentManifestHash:frozen.parentManifestHash,prefix:V5_PREFIX,limit:240,perModelLimit:120});const k=key(model.modelId,round,spec.id);for(const charged of journal.dispatchKeys().filter(k=>k.startsWith(V5_PREFIX)))if(!existsSync(resultFile(charged)))throw Error('EVALUATION_CHARGED_UNFINISHED');if(journal.charged(k)||journal.read(k))throw Error('EVALUATION_ATTEMPT_ALREADY_DISPATCHED');if(options.screen&&journal.dispatchKeys().filter(k=>k.startsWith(V5_PREFIX)&&V5_SCREEN_IDS.some(id=>k.endsWith('/'+id))).length>=40)throw Error('EVALUATION_SCREEN_CALL_LIMIT')
  const beforeConfig=readFileSync(path.join(options.profile,'model-config.json')),credential=loadModelCredentialReadOnly(options.profile,safeStorage,model.recordId),responses:any[]=[]
  const stream=async function*(input:ModelStepInput):AsyncGenerator<ModelStepEvent>{if(controller.signal.aborted||input.signal.aborted)throw Error('MEMORY_CANCELLED');if(!readFileSync(path.join(options.profile,'model-config.json')).equals(beforeConfig))throw Error('EVALUATION_PROFILE_CHANGED');if(responses.length>=2)throw Error('EVALUATION_CASE_CALL_LIMIT');if(responses.length===1){let bad=false;try{parseContinuitySuggestions(responses[0].body)}catch{bad=true}let repair:any;try{repair=JSON.parse(String(input.messages[0]?.content))}catch{}if(!bad||!repair?.repair||repair.repair.draft!==responses[0].body||responses[0].reason||responses[0].finishReason!=='stop')throw Error('EVALUATION_FORMAT_REPAIR_ONLY')}if(options.screen&&journal!.dispatchKeys().filter(k=>k.startsWith(V5_PREFIX)&&V5_SCREEN_IDS.some(id=>k.endsWith('/'+id))).length>=40)throw Error('EVALUATION_SCREEN_CALL_LIMIT');journal!.charge(k);const response:any={input:{system:input.system,messages:input.messages,maxOutputTokens:input.maxOutputTokens},body:'',usage:null,reason:null};responses.push(response);try{for await(const e of streamModelStep(input)){if(e.type==='text')response.body+=e.text;if(e.type==='finish'){response.finishReason=e.reason;response.usage=e.usage??null}yield e}}catch(e){response.reason=publicError(e);throw e}}
  let result:unknown,error:string|null=null;const started=performance.now();try{result=await runMemoryQualityCase({id:spec.id,group:spec.group==='negative'?'temporary':spec.group==='recent'?'fact':spec.group,heldOut:false,prompt:spec.prompt,body:spec.body,answer:spec.answer,seed:spec.seed,expected:{required:[],forbidden:[],notes:'v5 semantic review only'}},credential,stream,controller.signal,{strategy:'continuity',verifyClosure:!spec.chain||spec.step===5,...(spec.chain?{base:path.join(root,'fictional-'+model.modelId+'-'+round+'-'+spec.chain),noteName:`step-${spec.step}.md`,hostBeforeConsolidation:true}:{})})}catch(e){error=publicError(e);result=(e as any)?.evaluationResult??null}const row={key:k,model,round,case:spec,frozenHash,status:controller.signal.aborted?'interrupted':'completed',responses,result,error,latencyMs:performance.now()-started,review:null};journal.finish(k,JSON.parse(JSON.stringify(row).replaceAll(credential.apiKey,'[redacted]')))
 }
 const summaries=frozen.models.map((m:any)=>({model:m.modelId,attemptDiagnostics:[0,1].flatMap(round=>cases.flatMap(c=>{const f=resultFile(key(m.modelId,round,c.id));if(!existsSync(f))return [];const r=JSON.parse(readFileSync(f,'utf8'));return [{round,caseId:c.id,calls:r.responses.length,category:classify(r),responses:r.responses.map((p:any)=>{let format=false;try{parseContinuitySuggestions(p.body)}catch{format=true}return {empty:!p.body.trim(),length:p.finishReason==='length',format,service:!!p.reason,cancel:r.status==='interrupted',finishReason:p.finishReason??null,usage:p.usage??null}})}]})),rounds:[0,1].map(round=>v5Summary(rows(m.modelId),cases,round))}));atomicReport(path.join(root,'summary.json'),{frozenHash,calls:JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8')).dispatches.filter((d:any)=>d.key.startsWith(V5_PREFIX)).length,parentCalls:JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8')).calls,models:summaries,passed:summaries.every((m:any)=>m.rounds.every((r:any)=>r.passed)),formalQualityPassed:false})
 }finally{journal?.close()}
}

/** v6 评测命名空间：固定试卷 30 例（20 独立 ＋ 两条五步链）、两轮、每次一个案例。
 *  与 v5 的差别：无付费筛查、单次尝试 180 秒监督（在 check-memory.mjs）、第二次调用可网络重试或格式修复、
 *  可靠性用四项指标、环境故障记"未取得有效测量（环境）"。 */
async function runV6(controller:AbortController,sourceFiles:(dir:string)=>string[]){
 // v6 无付费筛查：试卷按 30 次尝试冻结，v6 通道任何 --screen 组合直接拒绝。
 if(options.screen)throw Error('EVALUATION_SCREEN_NOT_AUTHORIZED')
 const root=path.join(options.budget,'v6'),manifestFile=path.join(root,'v6-manifest.json'),cases=V6_QUALITY_CASES
 mkdirSync(root,{recursive:true,mode:0o700})
 const publicError=(e:unknown)=>e instanceof Error&&/^[A-Z_]{3,80}$/.test(e.message)?e.message:'EVALUATION_REQUEST_FAILED'
 // 执行提交在 git 不可用时退回环境变量，仍与 v4／v5 一样只记录事实。
 const executionCommit=()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:options.root,encoding:'utf8'}).trim()}catch{return process.env.RGENT_EVALUATION_COMMIT??'unknown'}}
 const promptHash=()=>createHash('sha256').update(memoryContinuitySystem,'utf8').digest('hex')
 const scorerHash=()=>fingerprint(readFileSync(path.join(options.root,'scripts/memory-quality-support.ts'),'utf8'))
 const weightsHash=()=>fingerprint(cases.map(c=>[c.id,c.direction,c.weight,c.split??null,c.chain??null,c.step??null]))
 const runtime=()=>fingerprint([...sourceFiles('src/main'),...sourceFiles('src/markdown'),...sourceFiles('src/shared'),...sourceFiles('scripts'),'scripts/check-memory.mjs','test/fixtures/v6-memory-quality.ts'].sort().map(f=>[f,readFileSync(path.join(options.root,f),'utf8')]))
 const metadata=()=>{const raw=readFileSync(path.join(options.profile,'model-config.json')),cfg=JSON.parse(raw.toString());const models=options.models.map(id=>{const m=cfg.models?.find((m:any)=>m.id===id),c=cfg.connections?.find((c:any)=>c.id===m?.connectionId);if(!m||!c)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');const url=new URL(c.baseURL),expected=m.modelId==='MiniMax-M3'?'api.minimax.cn':m.modelId==='deepseek-flash'?'api.deepseek.com':null;if(url.protocol!=='https:'||url.host!==expected||url.username||url.password||url.search||url.hash)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');return {recordId:id,modelId:m.modelId,host:url.host,baseURL:c.baseURL,contextTokens:m.contextTokens,connectionId:c.id}});if(models.length!==2||new Set(models.map(m=>m.modelId)).size!==2)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');return {raw,models,configuration:fingerprint(raw.toString())}}
 // 与 v5 相同的无付费诊断：只开 DNS 与一次认证 TLS 握手，不读密钥、不发 HTTP。
 const diagnose=async(models:any[],strict:boolean)=>{const rows=[];for(const m of models){let dns=false,tls=false;try{await Promise.race([lookup(m.host),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('DNS_TIMEOUT')),10000);t.unref()})]);dns=true;await new Promise<void>((resolve,reject)=>{const socket=connect({host:m.host,port:443,servername:m.host,rejectUnauthorized:true});socket.setTimeout(10000,()=>socket.destroy(Error('TLS_TIMEOUT')));socket.once('secureConnect',()=>{socket.end();resolve()});socket.once('error',e=>{socket.destroy();reject(e)})});tls=true}catch{}rows.push({model:m.modelId,host:m.host,dns,tls})}
  atomicReport(path.join(root,'diagnostic-'+randomUUID()+'.json'),{at:new Date().toISOString(),credentialsRead:false,httpRequests:0,rows});if(strict&&rows.some(r=>!r.dns||!r.tls))throw Error('EVALUATION_CONNECTION_UNSTABLE');return rows}
 if(!options.freeze&&!options.diagnose&&!options.live&&!options.review&&!options.stop&&!options.resume&&!options.hashes){console.log(JSON.stringify({mode:'v6-development-only',network:false,cases:cases.length,independent:V6_INDEPENDENT_IDS.length,rounds:V6_RULES.rounds,campaignLimit:V6_RULES.history.campaignLimit,perModelLimit:V6_RULES.history.perModelLimit,supervisionMs:V6_RULES.supervisionMs,categories:V6_CATEGORIES,scoring:V6_SCORING_CATEGORIES,rules:V6_RULES}));return}
 let frozen:any
 if(options.freeze){const meta=metadata();if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:options.root,encoding:'utf8'}).trim())throw Error('EVALUATION_DIRTY_EXECUTION');const parent=JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8'));if(parent.limit!==V6_RULES.history.parentLimit||parent.calls<V6_RULES.history.calls)throw Error('EVALUATION_HISTORY_MISMATCH')
  const revision=Math.max(1,Number(process.env.RGENT_V6_REVISION??1)||1)
  frozen={version:6,revision,prefix:V6_PREFIX+'r'+revision+'/',authorization:'2026-10-05-v6',executionCommit:executionCommit(),runtime:runtime(),configuration:meta.configuration,models:meta.models,cases:cases.map(c=>c.id),dataset:fingerprint(cases),weights:weightsHash(),rules:fingerprint(V6_RULES),prompt:memoryContinuitySystem,promptHash:promptHash(),scorer:scorerHash(),limits:V6_RULES.limits,parentManifestHash:parent.manifest,maxCalls:V6_RULES.history.campaignLimit}
  freezeV6(root,frozen);console.log(JSON.stringify({frozen:fingerprint(frozen),manifest:manifestFile,calls:parent.calls,executionCommit:frozen.executionCommit,promptHash:frozen.promptHash,cases:cases.length}));if(!options.live&&!options.diagnose)return}
 if(!frozen){if(!existsSync(manifestFile))throw Error('EVALUATION_FREEZE_REQUIRED');frozen=JSON.parse(readFileSync(manifestFile,'utf8'))}
 if(frozen.runtime!==runtime()||frozen.dataset!==fingerprint(cases)||frozen.weights!==weightsHash()||frozen.rules!==fingerprint(V6_RULES)||frozen.promptHash!==promptHash()||frozen.scorer!==scorerHash())throw Error('EVALUATION_REVISION_CHANGED')
 let diagnostic:any[]|null=null
 if(options.diagnose||options.live){const meta=metadata();if(meta.configuration!==frozen.configuration||fingerprint(meta.models)!==fingerprint(frozen.models))throw Error('EVALUATION_PROFILE_CHANGED');const targets=options.live?meta.models.filter((m:any)=>m.modelId===options.only):meta.models;if(!targets.length)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');diagnostic=await diagnose(targets,!options.live);if(!options.live)return}
 // 已诊断环境故障不改写成模型失败；未跑满的轮次按合同记"未取得有效测量（环境）"。
 const environmentUnavailable=!!diagnostic&&diagnostic.some((r:any)=>!r.dns||!r.tls)
 const frozenHash=fingerprint(frozen)
 const prefix=String(frozen.prefix??V6_PREFIX)
 const key=(model:string,round:number,id:string)=>prefix+model+'/'+round+'/'+id
 const resultFile=(k:string)=>path.join(root,'result-'+fingerprint(k)+'.json'),doubleFile=(k:string)=>path.join(root,'annotation2-'+fingerprint(k)+'.json'),annotationFile=(k:string)=>path.join(root,'annotation-'+fingerprint(k)+'.json')
 // 只读：为一条已落盘结果打印标注必须绑定的三个指纹，不改任何文件、不派发。
 if(options.hashes){
  const round=options.round??0,id=options.cases?.[0],model=frozen.models.find((m:any)=>m.modelId===options.only)
  if(!model||!id||options.cases?.length!==1)throw Error('EVALUATION_ONE_ATTEMPT_REQUIRED')
  const k=key(model.modelId,round,id),file=resultFile(k)
  if(!existsSync(file))throw Error('EVALUATION_RESULT_MISSING')
  console.log(JSON.stringify({key:k,frozenHash,resultHash:fingerprint(JSON.parse(readFileSync(file,'utf8'))),rulesHash:fingerprint(V6_RULES)}));return
 }
 const classify=v6TerminalCategory
 const rowOf=(model:string,round:number,c:V6Case):V6Row|null=>{
  const k=key(model,round,c.id),file=resultFile(k);if(!existsSync(file))return null
  const r=JSON.parse(readFileSync(file,'utf8')),af=annotationFile(k),a=existsSync(af)?JSON.parse(readFileSync(af,'utf8')):null
  if(r.frozenHash!==frozenHash||a&&(a.frozenHash!==frozenHash||a.resultHash!==fingerprint(r)))throw Error('EVALUATION_REVISION_CHANGED')
  const paid=r.result??null
  return {caseId:c.id,round,dispatched:paid?.dispatched===true,terminal:paid?.terminal===true,structured:paid?.structured===true,blocked:paid?.blocked===true,actionVerified:paid?.actionVerified===true,category:classify(r),calls:Array.isArray(r.responses)?r.responses.length:0,latencyMs:typeof r.latencyMs==='number'?r.latencyMs:0,receiptReason:paid?.receipt?.reason,candidate:paid?.candidate??undefined,review:a?.review??null}
 }
 const rows=(model:string):V6Row[]=>[0,1].flatMap(round=>cases.flatMap(c=>{const row=rowOf(model,round,c);return row?[row]:[]}))
 const stopFile=(model:string)=>path.join(root,'stop-'+model+'.json'),recoveryFile=(model:string)=>path.join(root,'recovery-'+model+'.json')
 const cyclesOf=(model:string):{at:string;reason:string}[]=>{if(!existsSync(recoveryFile(model)))return [];try{const value=JSON.parse(readFileSync(recoveryFile(model),'utf8'));return Array.isArray(value.cycles)?value.cycles:[]}catch{return []}}
 // 连续失败只看该模型按时间顺序的最近尝试；"可重试网络失败"= 传输失败或当次无终态。
 const recentAttempts=(model:string)=>{
  const state=JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8')) as {dispatches:{key:string}[]}
  return state.dispatches.filter(d=>d.key.startsWith(prefix+model+'/')).slice(-3).map(d=>{
   const file=resultFile(d.key);if(!existsSync(file))return {retryable:true}
   try{const r=JSON.parse(readFileSync(file,'utf8')),error=String(r.error??'')
    const retryable=r.status!=='completed'||['MEMORY_SERVICE_FAILED','EVALUATION_REQUEST_FAILED','EVALUATION_ATTEMPT_TIMEOUT','MEMORY_DEADLINE'].includes(error)
    return {retryable:retryable||(Array.isArray(r.responses)&&r.responses.length>0&&r.responses.every((p:any)=>!!p.reason&&p.reason!=='MEMORY_OUTPUT_INVALID'))}
   }catch{return {retryable:true}}
  })
 }
 const recoveryDecision=(model:string)=>v6RecoveryDecision(recentAttempts(model),cyclesOf(model).length,V6_RULES.recoveryCyclesMax)
 if(options.resume){const model=frozen.models.find((m:any)=>m.modelId===options.resume);if(!model)throw Error('EVALUATION_MODELS_NOT_AUTHORIZED')
  if(recoveryDecision(model.modelId)!=='pause')throw Error('EVALUATION_RESUME_NOT_REQUIRED')
  const cycles=cyclesOf(model.modelId),next=[...cycles,{at:new Date().toISOString(),reason:'operator-resume-after-three-retryable-failures'}]
  writeFileSync(recoveryFile(model.modelId),JSON.stringify({model:model.modelId,cycles:next,max:V6_RULES.recoveryCyclesMax},null,2),{mode:0o600})
  console.log(JSON.stringify({resumed:model.modelId,cycles:next.length,max:V6_RULES.recoveryCyclesMax,remaining:V6_RULES.recoveryCyclesMax-next.length}))}
 if(options.stop){if(!frozen.models.some((m:any)=>m.modelId===options.stop))throw Error('EVALUATION_MODELS_NOT_AUTHORIZED');if(!existsSync(stopFile(options.stop)))writeFileSync(stopFile(options.stop),JSON.stringify({frozenHash,reason:'operator-stop',at:new Date().toISOString(),rows:rows(options.stop)},null,2),{flag:'wx',mode:0o600})}
 if(options.annotation){
  if(!options.review)throw Error('EVALUATION_REVIEW_REQUIRED')
  const input:any=JSON.parse(readFileSync(options.annotation,'utf8'))
  // 兼容 {key,review} 与扁平标注；annotator 由标注自带，程序不改写身份、也不代填人工复核。
  const review:V6Annotation=(input.review??input) as V6Annotation,file=resultFile(String(input.key??''))
  if(!existsSync(file))throw Error('EVALUATION_ANNOTATION_INVALID')
  const result=JSON.parse(readFileSync(file,'utf8')),spec=cases.find(c=>c.id===result.case?.id)
  if(!spec||result.key!==input.key||(input.frozenHash??review.frozenHash)!==frozenHash||(input.resultHash??review.resultHash)!==fingerprint(result)||(input.rulesHash??review.rulesHash)!==fingerprint(V6_RULES)||!v6ReviewValid(spec,review))throw Error('EVALUATION_ANNOTATION_INVALID')
  const target=options.double?doubleFile(String(input.key)):annotationFile(String(input.key))
  if(options.double){const primary=annotationFile(String(input.key));if(!existsSync(primary))throw Error('EVALUATION_DOUBLE_ORDER')
   const first=JSON.parse(readFileSync(primary,'utf8'))
   // 双标注必须是另一名标注者：同身份重复提交不算独立复核。
   if(first.review?.annotator?.identity===review.annotator?.identity)throw Error('EVALUATION_DOUBLE_NOT_INDEPENDENT')}
  if(existsSync(target))throw Error('EVALUATION_ANNOTATION_EXISTS')
  writeFileSync(target,JSON.stringify({key:input.key,frozenHash,resultHash:fingerprint(result),rulesHash:fingerprint(V6_RULES),review,double:options.double===true,at:new Date().toISOString()},null,2),{flag:'wx',mode:0o600})
 }
 let journal:EvaluationJournal|undefined
 try{
  if(options.live){
   const round=options.round??0,id=options.cases?.[0],spec=cases.find(c=>c.id===id),model=frozen.models.find((m:any)=>m.modelId===options.only)
   if(!model||!spec||options.cases?.length!==1||![0,1].includes(round))throw Error('EVALUATION_ONE_ATTEMPT_REQUIRED')
   // 历史门槛与总账上限：本轮与 v4／v5 共用同一份 state.json。
   const history=JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8'))
   if(history.limit!==V6_RULES.history.parentLimit||history.calls<V6_RULES.history.calls)throw Error('EVALUATION_HISTORY_MISMATCH')
   if(existsSync(stopFile(model.modelId)))throw Error('EVALUATION_MODEL_STOPPED')
   const recovery=recoveryDecision(model.modelId)
   if(recovery==='exhausted')throw Error('EVALUATION_RECOVERY_EXHAUSTED')
   if(recovery==='pause')throw Error('EVALUATION_MODEL_PAUSED')
   const prior=rows(model.modelId)
   let blocked=false
   if(spec.chain&&(spec.step??1)>1){const upstream=prior.find(r=>r.round===round&&r.caseId===`v6-chain-${spec.chain}-${(spec.step??1)-1}`);if(!upstream||!upstream.review)throw Error('EVALUATION_CHAIN_ORDER');blocked=upstream.blocked===true||upstream.structured!==true}
   v6DispatchGate(prior,spec.id,round,cases)
   journal=new EvaluationJournal(root,frozen,V6_RULES.history.parentLimit,options.budget,undefined,{parentManifestHash:frozen.parentManifestHash,prefix:V6_PREFIX,limit:V6_RULES.history.campaignLimit,perModelLimit:V6_RULES.history.perModelLimit})
   const k=key(model.modelId,round,spec.id)
   // 被监督计时器杀掉时可能已计费但结果未落盘；状态不明不得自动重派。
   for(const charged of journal.dispatchKeys().filter(charged=>charged.startsWith(prefix)))if(!existsSync(resultFile(charged)))throw Error('EVALUATION_CHARGED_UNFINISHED')
   if(journal.charged(k)||journal.read(k))throw Error('EVALUATION_ATTEMPT_ALREADY_DISPATCHED')
   const beforeConfig=readFileSync(path.join(options.profile,'model-config.json')),credential=loadModelCredentialReadOnly(options.profile,safeStorage,model.recordId)
   if(credential.modelId!==model.modelId||credential.baseURL!==model.baseURL||credential.contextTokens!==model.contextTokens)throw Error('EVALUATION_REVISION_CHANGED')
   const responses:any[]=[]
   const stream=async function*(input:ModelStepInput):AsyncGenerator<ModelStepEvent>{
    if(controller.signal.aborted||input.signal.aborted)throw Error('MEMORY_CANCELLED')
    if(!readFileSync(path.join(options.profile,'model-config.json')).equals(beforeConfig))throw Error('EVALUATION_PROFILE_CHANGED')
    if(responses.length>=V6_RULES.limits.calls)throw Error('EVALUATION_CASE_CALL_LIMIT')
    if(responses.length===1){
     // 第二次调用只允许一次网络重试（同一 payload）或一次格式修复（repair.draft 等于首次正文）。
     let repair:any;try{repair=JSON.parse(String(input.messages[0]?.content))}catch{}
     const samePayload=fingerprint(input.messages)===fingerprint(responses[0].input.messages)
     const transportRetry=samePayload&&(!!responses[0].reason||responses[0].finishReason!=='stop')
     const formatRepair=!!repair?.repair&&typeof repair.repair.draft==='string'&&repair.repair.draft===responses[0].body&&!responses[0].reason&&responses[0].finishReason==='stop'
     if(!transportRetry&&!formatRepair)throw Error('EVALUATION_RETRY_NOT_ALLOWED')
    }
    journal!.charge(k)
    const response:any={input:{system:input.system,messages:input.messages,maxOutputTokens:input.maxOutputTokens},body:'',usage:null,reason:null,startedAt:new Date().toISOString()};responses.push(response)
    const started=performance.now()
    try{for await(const e of streamModelStep(input)){if(e.type==='text')response.body+=e.text;if(e.type==='finish'){response.finishReason=e.reason;response.usage=e.usage??null}yield e}}
    catch(e){response.reason=publicError(e);throw e}finally{response.latencyMs=performance.now()-started}
   }
   // 开始标记沿用 v5 的 result-<hash>/attempt-<hash> 落盘方式，供恢复与停损判断。
   journal.write(k,{status:'started',key:k,frozenHash,model,round,case:spec,startedAt:new Date().toISOString()})
   let result:unknown,error:string|null=null
   const started=performance.now()
   try{result=await runMemoryQualityCase(v6RunnerSpec(spec),credential,stream,controller.signal,{strategy:'continuity',verifyClosure:!spec.chain||spec.step===5,...(spec.chain?{base:path.join(root,`fictional-${model.modelId}-r${frozen.revision??1}-${round}-${spec.chain}`),noteName:`step-${spec.step}.md`,hostBeforeConsolidation:true}:{}),chainBlocked:blocked})}
   catch(e){error=publicError(e);result=(e as any)?.evaluationResult??null}
   const row:any={key:k,model,round,case:spec,frozenHash,status:controller.signal.aborted?'interrupted':'completed',responses,result,error,latencyMs:performance.now()-started,review:null}
   journal.finish(k,JSON.parse(JSON.stringify(row).replaceAll(credential.apiKey,'[redacted]')))
   console.log(JSON.stringify({model:model.modelId,round,case:spec.id,blocked,calls:journal.calls,localCalls:journal.localCalls,category:classify(row),error}))
  }
  const state=JSON.parse(readFileSync(path.join(options.budget,'state.json'),'utf8'))
  const campaignCalls=(prefix:string)=>state.dispatches.filter((d:any)=>d.key.startsWith(prefix)).length
  // 首调用成功率：与四项指标分列，只作诊断，不代称模型语义能力。
  const firstCall=(model:string)=>{const attempts=[0,1].flatMap(round=>cases.flatMap(c=>{const file=resultFile(key(model,round,c.id));return existsSync(file)?[JSON.parse(readFileSync(file,'utf8'))]:[]})),parsed=attempts.filter((attempt:any)=>{const first=Array.isArray(attempt.responses)?attempt.responses[0]:null;if(!first||first.reason||first.finishReason!=='stop'||typeof first.body!=='string')return false;try{parseContinuitySuggestions(first.body);return true}catch{return false}}).length;return {parsed,total:attempts.length,rate:attempts.length?parsed/attempts.length:0}}
  const modelCalls=(modelId:string)=>state.dispatches.filter((d:any)=>d.key.startsWith(V6_PREFIX)&&d.key.includes('/'+modelId+'/')).length
  const summaries=frozen.models.map((m:any)=>({model:m.modelId,recordId:m.recordId,host:m.host,calls:modelCalls(m.modelId),remaining:V6_RULES.history.perModelLimit-modelCalls(m.modelId),firstCall:firstCall(m.modelId),rounds:[0,1].map(round=>({round,summary:v6Summary(rows(m.modelId),cases,round,{environmentUnavailable})}))}))
  // 双标注复核：逐模型轮报告独立第二标注的覆盖率与计数一致率，不代称用户人工确认。
  const reviewProtocol=frozen.models.map((m:any)=>({model:m.modelId,rounds:[0,1].map(round=>{
   const keys=cases.map(c=>key(m.modelId,round,c.id)).filter(k=>existsSync(resultFile(k)))
   const both=keys.filter(k=>existsSync(annotationFile(k))&&existsSync(doubleFile(k)))
   const agree=both.filter(k=>{const a=JSON.parse(readFileSync(annotationFile(k),'utf8')).review,b=JSON.parse(readFileSync(doubleFile(k),'utf8')).review
    return a.correct===b.correct&&a.omitted===b.omitted&&a.wrongNew===b.wrongNew&&JSON.stringify(a.hardViolations)===JSON.stringify(b.hardViolations)})
   const annotators=[...new Set(both.flatMap(k=>[JSON.parse(readFileSync(annotationFile(k),'utf8')).review?.annotator?.identity,JSON.parse(readFileSync(doubleFile(k),'utf8')).review?.annotator?.identity]).filter((v:any)=>typeof v==='string'))]
   return {round,judged:keys.length,double:both.length,agreementRate:both.length?agree.length/both.length:null,doubleGate:both.length>=10,annotators}
  })}))
  const summary={frozenHash,executionCommit:frozen.executionCommit,reportCommit:executionCommit(),at:new Date().toISOString(),reviewProtocol,calls:state.calls,previousCalls:V6_RULES.history.calls,remainingGlobal:V6_RULES.history.parentLimit-state.calls,campaignCalls:campaignCalls(V6_PREFIX),campaignLimit:V6_RULES.history.campaignLimit,environment:{unavailable:environmentUnavailable,rows:diagnostic??[]},models:summaries,formalQualityPassed:false,productionStrategyChanged:false,userSemanticConfirmation:false}
  atomicReport(path.join(root,'summary.json'),summary)
  console.log(JSON.stringify({models:summaries.map((s:any)=>({model:s.model,calls:s.calls,rounds:s.rounds.map((r:any)=>({round:r.round,verdict:r.summary.verdict,metrics:r.summary.metrics,judgeable:r.summary.judgeable,blocked:r.summary.blocked}))})),calls:state.calls,remainingGlobal:summary.remainingGlobal,campaignCalls:summary.campaignCalls,environmentUnavailable}))
 }finally{journal?.close()}
}

/** runner 使用 v5 时代的 MemoryQualityCase 形状：v6 方向映射到 group，动作与种子原样带上，供机械动作核对。 */
function v6RunnerSpec(spec:V6Case):MemoryQualityCase{
 return {id:spec.id,group:(spec.direction==='recent'?'fact':spec.direction) as MemoryQualityCase['group'],heldOut:false,prompt:spec.prompt,body:spec.body,answer:spec.answer,...(spec.seed?{seed:spec.seed}:{}),
  expected:{required:[],forbidden:[],notes:'v6 semantic review only',...(spec.expected.action?{action:spec.expected.action}:{}),...(spec.expected.maxActive!==undefined?{maxActive:spec.expected.maxActive}:{}),...(spec.expected.semantic?{semantic:spec.expected.semantic}:{})}}
}

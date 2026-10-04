import {app,safeStorage} from 'electron'
import {readFileSync,mkdirSync,readdirSync,existsSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {lookup} from 'node:dns/promises'
import {connect} from 'node:tls'
import {randomUUID} from 'node:crypto'
import {loadModelCredentialReadOnly} from '../src/main/model-config.ts'
import {streamModelStep,type ModelStepInput,type ModelStepEvent} from '../src/main/model-stream.ts'
import {memoryConsolidationSystem} from '../src/main/working-memory-consolidation.ts'
import {MEMORY_QUALITY_CASES} from '../test/fixtures/memory-quality.ts'
import {runMemoryQualityCase,memorySemanticReviewSystem} from './memory-quality-runner.ts'
import {EvaluationJournal,atomicReport,fingerprint,modelQualitySummary,recordedQualityReview,V4_RULES,V4_SCREEN,V4_PARENT_MANIFEST,V4_PREFIX,v4Cases,v4Selection,v4EvidenceComplete,freezeV4,v4Summary,v4DispatchGate,v4ScreenGate,v4ResumeAction,type V4Row,type V4Annotation,type V4Category} from './memory-quality-support.ts'

const options=JSON.parse(process.env.RGENT_MEMORY_EVAL_OPTIONS??'{}') as {root:string;budget:string;profile:string;report:string;models:string[];pilot:boolean;live:boolean;only?:string;v4?:boolean;freeze?:boolean;diagnose?:boolean;review?:boolean;stop?:string;annotation?:string;screen?:boolean;cases?:string[]}
app.setName('rgent')
app.setPath('userData',path.join(options.report,'electron-profile'))
// Electron emits ready after its entry module has finished loading.
void app.whenReady().then(async()=>{
console.log('EVALUATION_READY')
const controller=new AbortController();let journal:EvaluationJournal|undefined
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>controller.abort())
const sourceFiles=(dir:string):string[]=>readdirSync(path.join(options.root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?sourceFiles(dir+'/'+e.name):e.name.endsWith('.ts')?[dir+'/'+e.name]:[])
try{
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

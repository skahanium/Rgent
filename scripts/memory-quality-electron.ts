import {app,safeStorage} from 'electron'
import {readFileSync,mkdirSync,readdirSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {loadModelCredentialReadOnly} from '../src/main/model-config.ts'
import {streamModelStep,type ModelStepInput,type ModelStepEvent} from '../src/main/model-stream.ts'
import {memoryConsolidationSystem} from '../src/main/working-memory-consolidation.ts'
import {MEMORY_QUALITY_CASES} from '../test/fixtures/memory-quality.ts'
import {runMemoryQualityCase} from './memory-quality-runner.ts'
import {EvaluationJournal,atomicReport,fingerprint,modelQualitySummary,recordedQualityReview} from './memory-quality-support.ts'

const options=JSON.parse(process.env.RGENT_MEMORY_EVAL_OPTIONS??'{}') as {root:string;budget:string;profile:string;report:string;models:string[];pilot:boolean;live:boolean;only?:string}
app.setName('rgent')
app.setPath('userData',path.join(options.report,'electron-profile'))
// Electron emits ready after its entry module has finished loading.
void app.whenReady().then(async()=>{
console.log('EVALUATION_READY')
const controller=new AbortController();let journal:EvaluationJournal|undefined
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>controller.abort())
const sourceFiles=(dir:string):string[]=>readdirSync(path.join(options.root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?sourceFiles(dir+'/'+e.name):e.name.endsWith('.ts')?[dir+'/'+e.name]:[])
try{
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

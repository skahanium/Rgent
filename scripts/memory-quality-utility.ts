/** Internal evaluator only. Restores actual bytes solely in runner-created fictional roots. */
import {createHash,randomUUID} from 'node:crypto'
import {readFile,writeFile,stat,lstat,realpath,readdir,unlink} from 'node:fs/promises'
import path from 'node:path'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {VaultSession} from '../src/main/vault.ts'
import {WorkingMemoryService} from '../src/main/working-memory-service.ts'
import {validOwner,type LedgerOwner} from '../src/main/ledger-store.ts'
import type {WorkingRecord,WorkingSource} from '../src/main/working-memory-store.ts'
import type {ModelCredential} from '../src/main/model-config.ts'
import type {ModelStepInput,ModelStepEvent} from '../src/main/model-stream.ts'
import {AgentHost} from '../src/main/agent-host.ts'
import {TaskAuthorizationRegistry} from '../src/main/task-authorization.ts'
import {modelTierFor} from '../src/main/permissions.ts'
import {memorySection} from '../src/main/memory-use.ts'
import {fingerprint,collaborationKeyParts,collaborationRecoveryWindow,v6RecoveryDecision} from './memory-quality-support.ts'

export const UTILITY_TASKS=[
 {id:'standing',source:'v6-standing-01',body:'工作计划',prompt:'解释为什么工作计划需要明确验收标准。',required:['先结论','一个具体例子'],forbidden:['无依据事实'],intervention:'none'},
 {id:'fact',source:'v6-fact-01',body:'石桥试验项目',prompt:'石桥试验项目目前的检查节奏是什么？若资料不足请说明。',required:['双周'],forbidden:['每周'],intervention:'none'},
 {id:'recent',source:'v6-recent-progress-01',body:'青灯项目',prompt:'继续青灯项目的样稿核对：说明当前完成范围和下一项待核对工作，不实际执行。',required:['五份目标','1/2目录完成','3未开始'],forbidden:['3已完成','自定期限'],intervention:'none'},
 {id:'correction',source:'v6-chain-alpha-4',body:'项目记录',prompt:'按本库当前项目记录约定，写一段示例项目记录。事项：样稿已收到，依据是收件回执。',required:['先依据后结论'],forbidden:['旧顺序有效'],intervention:'none'},
 {id:'duplicate',source:'v6-chain-alpha-5',body:'项目记录',prompt:'按本库当前项目记录约定，写一段示例项目记录。事项：样稿已收到，依据是收件回执。',required:['先依据后结论','真实id/version稳定性另报'],forbidden:['新旧并存冲突'],intervention:'none'},
 {id:'forget',source:'v6-fact-01',body:'石桥试验项目',prompt:'石桥试验项目目前的检查节奏是什么？若资料不足请说明。',required:['资料不足明确未知'],forbidden:['遗忘后引用双周'],intervention:'forget'},
 {id:'permission',source:'v6-fact-01',body:'石桥试验项目',prompt:'石桥试验项目目前的检查节奏是什么？若资料不足请说明。',required:['资料不足明确未知'],forbidden:['引用受禁来源双周'],intervention:'permission'},
 {id:'irrelevant',source:'v6-fact-01',body:'木叶项目',prompt:'木叶项目有12份样稿，每箱装3份。需要几箱？只按题中数据说明。',required:['4箱'],forbidden:['石桥','双周检查','无关范围约定'],intervention:'none'}
] as const
export const UTILITY_RULES={version:1,fixture:{independentSource:'source/fiction.md',chainSource:'step-N.md',permissionDirectory:'source',utilityNote:'opaque-root-note'},round:0,tasks:UTILITY_TASKS,limits:{seconds:120,steps:1,tools:0,calls:1,output:'max(512,min(4096,floor(contextTokens/4)))',sdkRetries:0},order:'task-index-plus-model-index-parity:on-off/off-on',preflight:'two-new-opaque-notes-cancel-at-stream-before-charge;actual-equals-own-preflight',restore:'actual-M4-and-permissions-only;original-source-objects-and-owner-task-material-proofs',scoring:{completion:[0,1,2],errors:'explicit-list',limitations:'explicit-list',scopeFollowed:'boolean',comparison:'win-tie-loss-with-disagreement',humanReviewed:false}} as const
export type UtilityBinding={frozenHash:string;key:string;model:string;round:number;caseId:string}
type FileProof={relPath:string;identity:string|null;hash:string|null;kind?:'directory'}
export type UtilityPreparation={parentArtifactHash:string;sourceResultHash:string;taskId:string;intervention:string;receipt:{forget:unknown[];permissions:unknown[];initialMemory:string|null;initialPermissions:string|null;finalMemory:string|null;finalPermissions:string|null}}
export type UtilityArtifact={version:1;id:string;base:string;root:string;rootIdentity:string;binding:UtilityBinding;memory:string|null;permissions:string|null;record:WorkingRecord;receipt:any;sources:WorkingSource[];proofs:FileProof[];owners:LedgerOwner[];materials:unknown[];preparation?:UtilityPreparation;hash:string}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const identity=async(file:string)=>{const s=await lstat(file);if(s.isSymbolicLink())throw Error('EVALUATION_ARTIFACT_PATH');return `${s.dev}:${s.ino}`}
const markerFile=(base:string)=>path.join(base,'collaboration-fictional.json')
async function safeFile(root:string,rel:string){
 if(path.isAbsolute(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..')||rel.includes('\\'))throw Error('EVALUATION_ARTIFACT_PATH')
 let file=root
 for(const part of rel.split('/')){file=path.join(file,part);try{if((await lstat(file)).isSymbolicLink())throw Error('EVALUATION_ARTIFACT_PATH')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
 return file
}
async function optional(file:string){try{return await readFile(file)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}}
async function proof(root:string,relPath:string):Promise<FileProof>{const file=await safeFile(root,relPath),bytes=await optional(file);return {relPath,identity:bytes?await identity(file):null,hash:bytes?sha(bytes):null}}
async function directoryProof(root:string,relPath:string):Promise<FileProof>{const file=await safeFile(root,relPath);try{return {relPath,kind:'directory',identity:await identity(file),hash:fingerprint((await readdir(file)).filter(f=>f!=='.DS_Store').sort())}}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {relPath,kind:'directory',identity:null,hash:null};throw e}}
async function registry(root:string){
 const raw=await optional(await safeFile(root,'.rgent/registry.json'));if(!raw)return [] as LedgerOwner[]
 const parsed=JSON.parse(raw.toString());if(parsed.version!==1||!Array.isArray(parsed.owners)||!parsed.owners.every(validOwner)||new Set(parsed.owners.map((o:LedgerOwner)=>o.noteId)).size!==parsed.owners.length||new Set(parsed.owners.map((o:LedgerOwner)=>o.relPath)).size!==parsed.owners.length)throw Error('EVALUATION_ARTIFACT_REGISTRY')
 return parsed.owners as LedgerOwner[]
}
async function materialUnits(root:string,noteIds:string[]){const bytes=await optional(await safeFile(root,'.rgent/materials.json'));if(!bytes)return [];const data=JSON.parse(bytes.toString());if(data.version!==1||!Array.isArray(data.units))throw Error('EVALUATION_ARTIFACT_REGISTRY');return data.units.filter((u:any)=>noteIds.includes(u.noteId))}
export async function markUtilityRoot(base:string,binding:UtilityBinding){
 const root=path.join(base,'vault'),rootIdentity=await identity(root),file=markerFile(base),raw=await optional(file)
 if(raw){const marker=JSON.parse(raw.toString());if(marker.version!==1||marker.base!==base||marker.root!==root||marker.rootIdentity!==rootIdentity||marker.frozenHash!==binding.frozenHash||marker.model!==binding.model||marker.round!==binding.round)throw Error('EVALUATION_ARTIFACT_MARKER');return}
 if((await readdir(root)).length)throw Error('EVALUATION_ARTIFACT_MARKER')
 if(await realpath(base)!==base||await realpath(root)!==root)throw Error('EVALUATION_ARTIFACT_PATH')
 await writeFile(file,JSON.stringify({version:1,base,root,rootIdentity,frozenHash:binding.frozenHash,model:binding.model,round:binding.round,artifacts:{}}),{flag:'wx',mode:0o600})
}
export async function captureUtilityArtifact(base:string,binding:UtilityBinding,session:VaultSession,service:WorkingMemoryService,receipt:any,additionalSources:WorkingSource[]=[],preparation?:UtilityPreparation):Promise<UtilityArtifact>{
 await session.idle();const root=session.requireUsableRoot(),marker=JSON.parse((await readFile(markerFile(base))).toString())
 if(root!==marker.root||await identity(root)!==marker.rootIdentity||binding.frozenHash!==marker.frozenHash||binding.model!==marker.model||binding.round!==marker.round)throw Error('EVALUATION_ARTIFACT_MARKER')
 const record=structuredClone(service.snapshot().record),sources=[...record.entries,...record.recent].flatMap(e=>e.sources).concat(additionalSources)
 const rels=[...new Set(sources.flatMap(s=>[s.relPath,...s.sourceDeps.map(d=>d.relPath)]))].sort(),allOwners=await registry(root),owners=allOwners.filter(o=>rels.includes(o.relPath))
 const files=new Set(rels),directories:FileProof[]=[]
 for(const owner of owners){const dir=`.rgent/ledgers/${owner.noteId}`,directory=await directoryProof(root,dir);directories.push(directory);files.add(`${dir}/owner.json`);for(const source of sources.filter(s=>s.relPath===owner.relPath&&s.taskId))files.add(`${dir}/${source.taskId}.json`);if(directory.identity!==null)for(const file of await readdir(await safeFile(root,dir)))if(file!=='.DS_Store')files.add(`${dir}/${file}`)}
 const proofs=[...directories,...await Promise.all([...files].sort().map(rel=>proof(root,rel)))]
 const data={version:1 as const,id:randomUUID(),base,root,rootIdentity:marker.rootIdentity,binding:structuredClone(binding),memory:(await optional(await safeFile(root,'.rgent-memory')))?.toString('base64')??null,permissions:(await optional(await safeFile(root,'.rgent-permissions')))?.toString('base64')??null,record,receipt:structuredClone(receipt),sources:structuredClone(sources),proofs,owners,materials:await materialUnits(root,owners.map(o=>o.noteId)),...(preparation?{preparation:structuredClone(preparation)}:{})}
 const artifact={...data,hash:fingerprint(data)};marker.artifacts[artifact.id]={hash:artifact.hash,binding:artifact.binding};await writeFile(markerFile(base),JSON.stringify(marker),{mode:0o600});return artifact
}
export async function verifyUtilityArtifact(artifact:UtilityArtifact,binding:UtilityBinding){
 const {hash,...data}=artifact
 if(hash!==fingerprint(data)||fingerprint(binding)!==fingerprint(artifact.binding)||artifact.root!==path.join(artifact.base,'vault')||await realpath(artifact.base)!==artifact.base||await realpath(artifact.root)!==artifact.root)throw Error('EVALUATION_ARTIFACT_BINDING')
 const marker=JSON.parse((await readFile(markerFile(artifact.base))).toString())
 if(marker.version!==1||marker.root!==artifact.root||marker.base!==artifact.base||marker.rootIdentity!==artifact.rootIdentity||await identity(artifact.root)!==artifact.rootIdentity||marker.frozenHash!==binding.frozenHash||marker.model!==binding.model||marker.round!==binding.round||marker.artifacts?.[artifact.id]?.hash!==hash||fingerprint(marker.artifacts?.[artifact.id]?.binding)!==fingerprint(binding))throw Error('EVALUATION_ARTIFACT_MARKER')
 for(const expected of artifact.proofs)if(fingerprint(await (expected.kind==='directory'?directoryProof:proof)(artifact.root,expected.relPath))!==fingerprint(expected))throw Error('EVALUATION_ARTIFACT_SOURCE_CHANGED')
 const owners=await registry(artifact.root)
 if(artifact.owners.some(o=>fingerprint(owners.find(p=>p.noteId===o.noteId))!==fingerprint(o))||fingerprint(await materialUnits(artifact.root,artifact.owners.map(o=>o.noteId)))!==fingerprint(artifact.materials))throw Error('EVALUATION_ARTIFACT_SOURCE_CHANGED')
}
/** Call only after all old Hosts/engines completed, session.idle and dispose. */
export async function restoreUtilityArtifact(artifact:UtilityArtifact,binding:UtilityBinding){
 await verifyUtilityArtifact(artifact,binding)
 for(const [rel,bytes] of [['.rgent-memory',artifact.memory],['.rgent-permissions',artifact.permissions]] as const){const file=await safeFile(artifact.root,rel);if(bytes===null){if(await optional(file))await unlink(file)}else await writeFile(file,Buffer.from(bytes,'base64'),{mode:0o600})}
 await verifyUtilityArtifact(artifact,binding)
}
const publicInput=(input:Omit<ModelStepInput,'signal'>&{contextTokens?:number})=>({system:input.system,messages:structuredClone(input.messages),tools:input.tools??null,maxOutputTokens:input.maxOutputTokens,modelId:input.modelId,baseURL:input.baseURL,contextTokens:input.contextTokens,purpose:input.purpose??null})
export function assertUtilityInputs(on:any,off:any,sections:string[]){
 const normalized=structuredClone(on),messages=normalized.messages
 if(!Array.isArray(messages)||messages.length!==1||messages[0].role!=='user'||typeof messages[0].content!=='string')throw Error('EVALUATION_UTILITY_INPUT_MISMATCH')
 if(sections.length){const block='\n'+sections.join('\n'),text=messages[0].content;if(!text.endsWith(block)||text.split(block).length!==2||sections.some(s=>text.split(s).length!==2))throw Error('EVALUATION_UTILITY_MEMORY_AMBIGUOUS');messages[0].content=text.slice(0,-block.length)}
 if(fingerprint(normalized)!==fingerprint(off))throw Error('EVALUATION_UTILITY_INPUT_MISMATCH')
}
async function utilityHost(artifact:UtilityArtifact,task:typeof UTILITY_TASKS[number],credential:ModelCredential,enabled:boolean,preflight:boolean,signal:AbortSignal,stream:(input:ModelStepInput)=>AsyncIterable<ModelStepEvent>,beforeStream?:(input:ReturnType<typeof publicInput>)=>Promise<void>){
 const session=new VaultSession(artifact.base,()=>{});session.restore();const service=new WorkingMemoryService(session,()=>null)
 let host:AgentHost|undefined
 try{
  await service.initialize();const root=session.requireUsableRoot(),relPath=randomUUID()+'.md',raw='/'+task.prompt,body=task.body+'\n\n'+raw+'\n'
  await writeFile(path.join(root,relPath),body,{flag:'wx',mode:0o600})
  const history=await session.ledgerContexts(relPath);if(history.length)throw Error('EVALUATION_UTILITY_HISTORY')
  const entries=await service.entries(),port={context:()=>service.context(),config:()=>({enabled,revision:1}),entries:(ids?:readonly string[])=>service.entries(ids)}
  const authorization=new TaskAuthorizationRegistry({root:()=>root,session:()=>session.sessionId(),tree:()=>session.tree(),read:rel=>session.readOpened(rel),tier:modelTierFor,acceptsObject:(rel,expected,current)=>session.acceptsObject(rel,expected,current),configuration:()=>({credential,limits:{seconds:120,steps:1,tools:0}})})
  const note=await session.readOpened(relPath),start=note.content.lastIndexOf(raw),command={...note,modelRecordId:'utility',expectedRevision:note.revision,relPath,range:{start,end:start+raw.length},expectedText:raw,promptText:task.prompt}
  const preview=await authorization.preview('utility',{...command,references:[]})
  let observed:ReturnType<typeof publicInput>|null=null,bodyOutput='',finishReason:string|null=null,usage:unknown=null,streamError:string|null=null,gateError:unknown=null,calls=0
  const started=performance.now()
  host=new AgentHost({root:()=>root,session:()=>session.sessionId(),acceptsObject:(rel,expected,current)=>session.acceptsObject(rel,expected,current),read:rel=>session.readOpened(rel),write:(rel,text,revision,binding)=>{if(!binding)throw Error('NOTE_REPLACED');return session.write(rel,text,revision,binding)},authorize:()=>authorization.consume('utility',{...command,previewId:preview.id}),tier:modelTierFor,credential:()=>credential,limits:()=>({seconds:120,steps:1,tools:0}),memory:port,
   ledger:{prepare:(rel,chapter,version,binding)=>{if(!binding)throw Error('BAD_REQUEST');return session.ledgerPrepare(rel,chapter,version,binding)},complete:(rel,id,revision)=>session.ledgerComplete(rel,id,revision),contexts:rel=>session.ledgerContexts(rel)},
   stream:async function*(){throw Error('EVALUATION_UTILITY_STREAM_REQUIRED')},streamStep:async function*(input,taskSignal){
    if(++calls!==1||input.tools)throw Error('EVALUATION_UTILITY_EXTRA_CALL')
    observed=publicInput(input)
    if(preflight){host!.cancel(active.id);throw Error('TASK_CANCELLED')}
    try{await beforeStream?.(observed)}catch(error){gateError=error;throw error}
    try{for await(const event of stream({...input,signal:AbortSignal.any([taskSignal,signal])})){if(event.type==='text')bodyOutput+=event.text;if(event.type==='finish'){finishReason=event.reason;usage=event.usage??null}yield event}}
    catch(error){streamError=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EVALUATION_REQUEST_FAILED';throw error}
   },emit:()=>{}})
  const active=await host.start({...command,previewId:preview.id}),stop=()=>host!.cancel(active.id);signal.addEventListener('abort',stop,{once:true})
  try{if(signal.aborted)stop();await active.done}finally{signal.removeEventListener('abort',stop)}
  if(gateError)throw gateError
  const ledger=await session.ledgerRecord(relPath,active.id),deps=ledger.chapter?.provenance?.version===2?ledger.chapter.provenance.memoryDeps:[]
  if(!enabled&&deps.length)throw Error('EVALUATION_UTILITY_OFF_DEPENDENCY')
  if(!observed)throw Error('EVALUATION_UTILITY_INPUT_MISSING')
  const sections=deps.map(d=>{const entry=entries.find(e=>e.id===d.id&&e.version===d.version);if(!entry)throw Error('EVALUATION_UTILITY_MEMORY_MAPPING');return memorySection(entry)})
  return {id:active.id,relPath,bodyHash:sha(body),prompt:task.prompt,history,input:observed as ReturnType<typeof publicInput>,body:bodyOutput,finishReason,usage,error:streamError,status:preflight?'preflight-cancelled':ledger.chapter?.status??'failed',ledger,sections,latencyMs:performance.now()-started,calls:preflight?0:calls}
 }finally{await session.idle();session.dispose()}
}
export async function runUtilityPair(input:{artifact:UtilityArtifact;binding:UtilityBinding;taskId:string;credential:ModelCredential;signal:AbortSignal;charge:(condition:'on'|'off')=>void;stream:(input:ModelStepInput)=>AsyncIterable<ModelStepEvent>;onCondition?:(condition:'on'|'off',result:unknown)=>void;onDispatchBoundary?:(condition:'on'|'off',index:number)=>void;sourceResultHash:string;preparedArtifact?:UtilityArtifact;skipConditions?:('on'|'off')[];onPrepared?:(artifact:UtilityArtifact)=>void;onPreflight?:(preflight:any,order:('on'|'off')[])=>void}){
 const {artifact,binding,credential,signal}=input,task=UTILITY_TASKS.find(t=>t.id===input.taskId)
 if(!task||binding.caseId!==task.source||binding.round!==0)throw Error('EVALUATION_UTILITY_SOURCE')
 if(!/^[a-f0-9]{64}$/.test(input.sourceResultHash))throw Error('EVALUATION_UTILITY_PREPARED_BINDING')
 if(input.preparedArtifact){const prepared=input.preparedArtifact,preparation=prepared.preparation;if(!preparation||preparation.parentArtifactHash!==artifact.hash||preparation.sourceResultHash!==input.sourceResultHash||preparation.taskId!==task.id||preparation.intervention!==task.intervention||preparation.receipt.initialMemory!==artifact.memory||preparation.receipt.initialPermissions!==artifact.permissions||preparation.receipt.finalMemory!==prepared.memory||preparation.receipt.finalPermissions!==prepared.permissions)throw Error('EVALUATION_UTILITY_PREPARED_BINDING');await verifyUtilityArtifact(prepared,binding)}
 await restoreUtilityArtifact(artifact,binding)
 const session=new VaultSession(artifact.base,()=>{});session.restore();const service=new WorkingMemoryService(session,()=>null)
 let after:UtilityArtifact
 try{
  await service.initialize()
  const receipt:UtilityPreparation['receipt']={forget:[],permissions:[],initialMemory:artifact.memory,initialPermissions:artifact.permissions,finalMemory:null,finalPermissions:null}
  if(!input.preparedArtifact&&task.intervention==='forget')for(const id of artifact.receipt?.entryIds??[]){const entry=(await service.entries()).find(e=>e.id===id);if(entry){const basis=service.snapshot(),committed=await service.forget({sessionId:service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id,version:entry.version});receipt.forget.push({id,version:entry.version,before:basis.revision,after:committed.revision,forgotten:structuredClone(committed.record.forgotten)})}}
  if(!input.preparedArtifact&&task.intervention==='permission'){if(!artifact.sources.length||artifact.sources.some(s=>!s.relPath.startsWith('source/')))throw Error('EVALUATION_UTILITY_PERMISSION_SOURCE');const before=await session.permissions(),after=await session.setPermission('source','forbidden');receipt.permissions.push({relPath:'source',tier:'forbidden',before,after})}
  receipt.finalMemory=(await optional(await safeFile(artifact.root,'.rgent-memory')))?.toString('base64')??null;receipt.finalPermissions=(await optional(await safeFile(artifact.root,'.rgent-permissions')))?.toString('base64')??null
  after=input.preparedArtifact??await captureUtilityArtifact(artifact.base,binding,session,service,artifact.receipt,artifact.sources,{parentArtifactHash:artifact.hash,sourceResultHash:input.sourceResultHash,taskId:task.id,intervention:task.intervention,receipt})
 }finally{await session.idle();session.dispose()}
 input.onPrepared?.(after)
 const preflight={} as Record<'on'|'off',Awaited<ReturnType<typeof utilityHost>>>,conditions={} as typeof preflight
 for(const condition of ['on','off'] as const){await restoreUtilityArtifact(after,binding);preflight[condition]=await utilityHost(after,task,credential,condition==='on',true,signal,async function*(){throw Error('EVALUATION_PREFLIGHT_NETWORK_FORBIDDEN')})}
 assertUtilityInputs(preflight.on.input,preflight.off.input,preflight.on.sections)
 if(preflight.on.bodyHash!==preflight.off.bodyHash||preflight.on.prompt!==preflight.off.prompt||fingerprint(preflight.on.history)!==fingerprint(preflight.off.history))throw Error('EVALUATION_UTILITY_INPUT_MISMATCH')
 const parity=(UTILITY_TASKS.findIndex(t=>t.id===task.id)+(binding.model==='MiniMax-M3'?1:0))%2,order:('on'|'off')[]=parity?['off','on']:['on','off']
 input.onPreflight?.(preflight,order)
 let dispatchIndex=0
 for(const condition of order){if(input.skipConditions?.includes(condition))continue;await restoreUtilityArtifact(after,binding);conditions[condition]=await utilityHost(after,task,credential,condition==='on',false,signal,input.stream,async observed=>{
  await verifyUtilityArtifact(after,binding)
  if(fingerprint(observed)!==fingerprint(preflight[condition].input))throw Error('EVALUATION_UTILITY_PREFLIGHT_CHANGED')
  for(const [rel,bytes] of [['.rgent-memory',after.memory],['.rgent-permissions',after.permissions]] as const)if((await optional(await safeFile(after.root,rel)))?.toString('base64')!== (bytes??undefined))throw Error('EVALUATION_UTILITY_BASELINE_CHANGED')
  input.onDispatchBoundary?.(condition,dispatchIndex++)
  input.charge(condition)
 });input.onCondition?.(condition,conditions[condition]);await verifyUtilityArtifact(after,binding)
  for(const [rel,bytes] of [['.rgent-memory',after.memory],['.rgent-permissions',after.permissions]] as const)if((await optional(await safeFile(after.root,rel)))?.toString('base64')!== (bytes??undefined))throw Error('EVALUATION_UTILITY_BASELINE_CHANGED')
 }
 await restoreUtilityArtifact(after,binding)
 return {frozenHash:binding.frozenHash,model:binding.model,taskId:task.id,artifactHash:artifact.hash,afterHash:after.hash,actualEntries:after.record.entries.map(e=>({id:e.id,version:e.version,status:e.status})),preflight,conditions,order,humanReviewed:false}
}
export function utilityBlindPacket(result:any){
 const task=UTILITY_TASKS.find(t=>t.id===result.taskId);if(!task)throw Error('EVALUATION_UTILITY_TASK')
 const answers=(['on','off'] as const).map(condition=>({id:randomUUID(),condition,result:result.conditions[condition]})).sort((a,b)=>a.id.localeCompare(b.id))
 const binding={frozenHash:result.frozenHash,resultHash:fingerprint(result),rulesHash:fingerprint(UTILITY_RULES)}
 const packet={public:{binding,prompt:task.prompt,required:task.required,forbidden:task.forbidden,humanReviewed:false,answers:answers.map(a=>({id:a.id,body:a.result.body,status:a.result.status}))},private:{...binding,taskId:task.id,model:result.model,mapping:answers.map(a=>({id:a.id,condition:a.condition}))}}
 return {...packet,public:{...packet.public,binding:{...binding,packetHash:fingerprint(packet)}}}
}
export function assertUtilityPacket(packet:ReturnType<typeof utilityBlindPacket>,result:any){
 const {packetHash,...binding}=packet.public.binding,task=UTILITY_TASKS.find(t=>t.id===result.taskId)
 if(!task||fingerprint({public:{...packet.public,binding},private:packet.private})!==packetHash||binding.resultHash!==fingerprint(result)||binding.frozenHash!==result.frozenHash||binding.rulesHash!==fingerprint(UTILITY_RULES)||packet.private.taskId!==result.taskId||packet.private.model!==result.model||['frozenHash','resultHash','rulesHash'].some(k=>packet.private[k as keyof typeof packet.private]!==binding[k as keyof typeof binding])||packet.public.prompt!==task.prompt||fingerprint(packet.public.required)!==fingerprint(task.required)||fingerprint(packet.public.forbidden)!==fingerprint(task.forbidden)||packet.private.mapping.length!==2||new Set(packet.private.mapping.map(m=>m.condition)).size!==2||packet.private.mapping.some(m=>!['on','off'].includes(m.condition)||packet.public.answers.filter(a=>a.id===m.id&&a.body===result.conditions[m.condition]?.body&&a.status===result.conditions[m.condition]?.status).length!==1))throw Error('EVALUATION_UTILITY_ANNOTATION_INVALID')
}
export function validateUtilityAnnotation(packet:ReturnType<typeof utilityBlindPacket>,review:any){
 const valid=review&&['frozenHash','resultHash','rulesHash','packetHash'].every(k=>review[k]===packet.public.binding[k as keyof typeof packet.public.binding])&&typeof review.annotator?.identity==='string'&&review.annotator.identity.trim().length>0&&review.annotator.humanReviewed===false&&review.annotator.modelNameMasked===true&&typeof review.annotator.participatedInDesign==='boolean'&&Array.isArray(review.scores)&&review.scores.length===2&&new Set(review.scores.map((s:any)=>s.id)).size===2&&review.scores.every((s:any)=>packet.public.answers.some(a=>a.id===s.id)&&[0,1,2].includes(s.completion)&&Array.isArray(s.errors)&&s.errors.every((e:unknown)=>typeof e==='string')&&Array.isArray(s.limitations)&&s.limitations.every((e:unknown)=>typeof e==='string')&&typeof s.scopeFollowed==='boolean')
 if(!valid)throw Error('EVALUATION_UTILITY_ANNOTATION_INVALID')
}
/** 传输失败、空取消或收费前阻断不进 win／tie／loss 分母。 */
export function utilityPairContaminated(result:any):boolean{
 const conds=result?.conditions??{}
 return (['on','off'] as const).some(c=>{
  const row=conds[c]??{}
  const status=typeof row.status==='string'?row.status:''
  const error=typeof row.error==='string'?row.error:''
  if(['not-dispatched','cancelled-empty','charged-without-terminal'].includes(status))return true
  if(status==='MODEL_REQUEST_FAILED'||error==='MODEL_REQUEST_FAILED')return true
  return error.startsWith('EVALUATION_UTILITY')||error==='EVALUATION_REQUEST_FAILED'
 })
}
export function utilityReviewSummary(packet:ReturnType<typeof utilityBlindPacket>,primary:any,secondary:any,result:any){
 assertUtilityPacket(packet,result);validateUtilityAnnotation(packet,primary);validateUtilityAnnotation(packet,secondary)
 if(primary.annotator.identity===secondary.annotator.identity)throw Error('EVALUATION_UTILITY_ANNOTATION_INVALID')
 const normalized=(s:any)=>({id:s.id,completion:s.completion,errors:[...s.errors].sort(),limitations:[...s.limitations].sort(),scopeFollowed:s.scopeFollowed})
 const disagreements=primary.scores.filter((s:any)=>fingerprint(normalized(s))!==fingerprint(normalized(secondary.scores.find((t:any)=>t.id===s.id)))).map((s:any)=>({id:s.id,primary:s,secondary:secondary.scores.find((t:any)=>t.id===s.id)}))
 const compare=(review:any)=>{const score=(condition:string)=>{const s=review.scores.find((s:any)=>s.id===packet.private.mapping.find(m=>m.condition===condition)!.id);return s.scopeFollowed&&!s.errors.length?s.completion:-1};return score('on')>score('off')?'win':score('on')<score('off')?'loss':'tie'}
 const eligible=!utilityPairContaminated(result)
 return {binding:packet.public.binding,taskId:packet.private.taskId,model:packet.private.model,eligible,nValid:eligible?1:0,primary:eligible?compare(primary):null,secondary:eligible?compare(secondary):null,disagreements,humanReviewed:false}
}

// These readers only inspect evaluator reports. They never restore a vault or open a profile.
type UtilityEvidenceInput={root:string;pairKey:string;frozenHash:string;dispatches:{key:string}[]}
const evidenceFile=(root:string,pairKey:string,kind:string)=>path.join(root,kind+'-'+fingerprint(pairKey)+'.json')
const readEvidence=(file:string):any=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null
const requireEvidence=(valid:unknown)=>{if(!valid)throw Error('EVALUATION_UTILITY_EVIDENCE_MISMATCH')}
const same=(a:unknown,b:unknown)=>fingerprint(a)===fingerprint(b)
const artifactFingerprint=(a:UtilityArtifact)=>{const {hash,...data}=a;requireEvidence(hash===fingerprint(data))}
function preflightBasis(preflight:any){return Object.fromEntries((['on','off'] as const).map(c=>[c,{input:preflight[c].input,bodyHash:preflight[c].bodyHash,prompt:preflight[c].prompt,history:preflight[c].history,sections:preflight[c].sections}]))}
export function persistUtilityPreflight(input:{root:string;pairKey:string;frozenHash:string;source:any;afterHash:string;preflight:any;order:('on'|'off')[]}){
 const {root,pairKey,...data}=input,file=evidenceFile(root,pairKey,'utility-preflight'),previous=readEvidence(file)
 if(previous){const {hash,...old}=previous;requireEvidence(hash===fingerprint(old)&&same({...old,preflight:preflightBasis(old.preflight)},{...data,preflight:preflightBasis(data.preflight)}));return previous}
 const plan={...data,hash:fingerprint(data)};writeFileSync(file,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});return plan
}
export function readUtilityEvidence(input:UtilityEvidenceInput){
 const {root,pairKey,frozenHash,dispatches}=input,parts=collaborationKeyParts(pairKey+'/on'),task=UTILITY_TASKS.find(t=>pairKey.endsWith('/'+t.id))!
 requireEvidence(parts.phase==='answers'&&task)
 const file=(kind:string)=>evidenceFile(root,pairKey,kind),result=readEvidence(file('utility-result')),sub=readEvidence(file('utility-source')),plan=readEvidence(file('utility-preflight'))
 const sourceKey=pairKey.slice(0,pairKey.indexOf('/answers/'))+'/consolidation/'+parts.model+'/0/'+task.source,sourceRow=readEvidence(evidenceFile(root,sourceKey,'result'))
 const raw=Object.fromEntries((['on','off'] as const).map(c=>[c,readEvidence(evidenceFile(root,pairKey+'/'+c,'result'))]))
 const calls=(c:string)=>dispatches.filter(d=>d.key===pairKey+'/'+c).length
 const conditions:Record<string,{status:string;calls:number;raw:any;answer:any}>={}
 if(sourceRow)requireEvidence(sourceRow.key===sourceKey&&sourceRow.frozenHash===frozenHash)
 if(result)requireEvidence(result.frozenHash===frozenHash&&result.model===parts.model&&result.taskId===task.id)
 if(!sub&&!plan&&!raw.on&&!raw.off){
  if(result)requireEvidence(result.status==='not-dispatched-source-missing'&&result.sourceKey===sourceKey&&result.calls===0&&!calls('on')&&!calls('off')&&(!sourceRow||!sourceRow.result?.utilityArtifact)&&(!sourceRow||result.sourceResultHash===fingerprint(sourceRow)))
  for(const c of ['on','off'])conditions[c]={status:calls(c)?'charged-without-terminal':result?.status??'not-dispatched',calls:calls(c),raw:null,answer:null}
  return {result,source:null,after:null,plan:null,conditions}
 }
 requireEvidence(sourceRow?.key===sourceKey&&sourceRow.frozenHash===frozenHash&&sourceRow.result?.utilityArtifact&&sub)
 const artifact:UtilityArtifact=sourceRow.result.utilityArtifact;artifactFingerprint(artifact)
 const source={version:1,frozenHash,taskId:task.id,sourceKey,sourceResultHash:fingerprint(sourceRow),artifactHash:artifact.hash},after:UtilityArtifact=sub.after
 requireEvidence(same(sub.source,source)&&after&&sub.afterHash===after.hash);artifactFingerprint(after)
 const expectedBinding={frozenHash,key:sourceKey,model:parts.model,round:0,caseId:task.source},preparation=after.preparation
 requireEvidence(same(artifact.binding,expectedBinding)&&same(after.binding,expectedBinding)&&preparation?.parentArtifactHash===artifact.hash&&preparation.sourceResultHash===source.sourceResultHash&&preparation.taskId===task.id&&preparation.intervention===task.intervention&&preparation.receipt.initialMemory===artifact.memory&&preparation.receipt.initialPermissions===artifact.permissions&&preparation.receipt.finalMemory===after.memory&&preparation.receipt.finalPermissions===after.permissions)
 if(plan){
  const {hash,...data}=plan,parity=(UTILITY_TASKS.indexOf(task)+(parts.model==='MiniMax-M3'?1:0))%2
  requireEvidence(hash===fingerprint(data)&&plan.frozenHash===frozenHash&&same(plan.source,source)&&plan.afterHash===after.hash&&same(plan.order,parity?['off','on']:['on','off']))
  const {on,off}=plan.preflight
  requireEvidence(on.status==='preflight-cancelled'&&off.status==='preflight-cancelled'&&on.calls===0&&off.calls===0&&same(on.history,[])&&same(off.history,[])&&on.prompt===task.prompt&&off.prompt===task.prompt&&on.bodyHash===off.bodyHash&&same(off.sections,[]))
  assertUtilityInputs(on.input,off.input,on.sections)
 }
 for(const c of ['on','off']){
  const row=raw[c],charged=calls(c);requireEvidence(charged<=1)
  if(row){requireEvidence(plan&&row.key===pairKey+'/'+c&&row.frozenHash===frozenHash&&['terminal','started'].includes(row.status)&&same(row.source,source)&&row.afterHash===after.hash&&row.preflightHash===plan.hash)
   if(row.status==='terminal'){const answer=row.result,basis=plan.preflight[c];requireEvidence(charged===1&&answer?.calls===1&&same(answer.input,basis.input)&&answer.bodyHash===basis.bodyHash&&answer.prompt===basis.prompt&&same(answer.history,[])&&typeof answer.body==='string'&&['completed','failed','cancelled','limit'].includes(answer.status));if(c==='off')requireEvidence(!(answer.ledger?.chapter?.provenance?.memoryDeps??[]).length)}
  }
  const answer=row?.status==='terminal'?row.result:null
  conditions[c]={status:answer?.status??(charged?'charged-without-terminal':'not-dispatched'),calls:charged,raw:row,answer}
  if(result&&answer)requireEvidence(same(result.conditions?.[c],answer))
 }
 if(result)requireEvidence(plan&&same(result.source,source)&&result.artifactHash===artifact.hash&&result.afterHash===after.hash&&same(result.preflight,plan.preflight)&&same(result.order,plan.order)&&result.calls===2&&result.planned===2&&result.humanReviewed===false&&result.validTerminal===Object.values(result.conditions??{}).filter((r:any)=>r.status==='completed'&&r.finishReason==='stop'&&!r.error).length&&same(result.actualEntries,after.record.entries.map(e=>({id:e.id,version:e.version,status:e.status}))))
 return {result,source,after,plan,conditions}
}
export function recoverUtilityReport(input:UtilityEvidenceInput){
 const evidence=readUtilityEvidence(input),{source,after,plan,conditions}=evidence,file=(kind:string)=>evidenceFile(input.root,input.pairKey,kind)
 let result=evidence.result
 if(result?.status!=='not-dispatched-source-missing'){
  if(!conditions.on!.answer||!conditions.off!.answer)throw Error('EVALUATION_CHARGED_UNFINISHED')
  if(!result){result={frozenHash:input.frozenHash,model:after!.binding.model,taskId:source!.taskId,artifactHash:source!.artifactHash,afterHash:after!.hash,actualEntries:after!.record.entries.map(e=>({id:e.id,version:e.version,status:e.status})),preflight:plan.preflight,conditions:{on:conditions.on!.answer,off:conditions.off!.answer},order:plan.order,humanReviewed:false,source,calls:2,planned:2,validTerminal:Object.values(conditions).filter(r=>r.answer?.status==='completed'&&r.answer.finishReason==='stop'&&!r.answer.error).length};writeFileSync(file('utility-result'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600})}
 }
 let packet=readEvidence(file('utility-blind'))
 if(packet)assertUtilityPacket(packet,result)
 else{packet=utilityBlindPacket(result);writeFileSync(file('utility-blind'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600})}
 return {result,packet}
}


/** Shared service stop gate for this frozen model, independent of certification scores. */
type CollaborationServiceInput={root:string;frozenHash:string;prefix:string;model:string;dispatches:{key:string}[];activeConsolidation?:{key:string;responses:any[]}}
export function collaborationServiceState(input:CollaborationServiceInput){
 const binding={frozenHash:input.frozenHash,prefix:input.prefix,model:input.model},stop=readEvidence(path.join(input.root,'stop-'+input.model+'.json')),recovery=readEvidence(path.join(input.root,'recovery-'+input.model+'.json'))
 if(stop&&stop.frozenHash!==input.frozenHash||recovery&&(recovery.model!==input.model||!Array.isArray(recovery.cycles)))throw Error('EVALUATION_RECOVERY_INVALID')
 const cycles=recovery?.cycles??[],window=collaborationRecoveryWindow(input.dispatches,cycles,binding)
 const networkFailure=(reason:any,finishReason:any)=>!!reason&&reason!=='MEMORY_OUTPUT_INVALID'||!finishReason
 const attempts=window.slice(-3).map(dispatch=>{
  const parts=collaborationKeyParts(dispatch.key)
  if(parts.phase==='answers'){
   const condition=dispatch.key.split('/').at(-1)!,pairKey=dispatch.key.slice(0,-condition.length-1)
   const row=readUtilityEvidence({...input,pairKey}).conditions[condition]!
   return {key:dispatch.key,retryable:!row.answer||networkFailure(row.answer.error,row.answer.finishReason)}
  }
  const active=input.activeConsolidation?.key===dispatch.key?input.activeConsolidation:null
  const row=active?{key:active.key,frozenHash:input.frozenHash,status:'active',responses:active.responses}:readEvidence(evidenceFile(input.root,dispatch.key,'result'))
  if(row&&(row.key!==dispatch.key||row.frozenHash!==input.frozenHash))throw Error('EVALUATION_REVISION_CHANGED')
  if(!row||!active&&!['completed','interrupted'].includes(row.status))return {key:dispatch.key,retryable:true}
  const ordinal=input.dispatches.slice(0,input.dispatches.indexOf(dispatch)+1).filter(d=>d.key===dispatch.key).length-1,response=row.responses?.[ordinal]
  return {key:dispatch.key,retryable:!response||networkFailure(response.reason,response.finishReason)}
 })
 return {binding,cycles,attempts,stopped:!!stop,decision:v6RecoveryDecision(attempts,cycles.length,2)}
}
export function assertCollaborationServiceDispatch(input:CollaborationServiceInput){
 const state=collaborationServiceState(input)
 if(state.stopped)throw Error('EVALUATION_MODEL_STOPPED')
 if(state.decision==='pause')throw Error('EVALUATION_MODEL_PAUSED')
 if(state.decision==='exhausted')throw Error('EVALUATION_RECOVERY_EXHAUSTED')
}

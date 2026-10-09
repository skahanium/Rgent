import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as utility from '../../scripts/memory-quality-utility.ts'
import {runMemoryQualityCase} from '../../scripts/memory-quality-runner.ts'
import {VaultSession} from '../../src/main/vault.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {fingerprint} from '../../scripts/memory-quality-support.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})})
const credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
const binding={frozenHash:'a'.repeat(64),key:'v6-2026-10-05/collaboration/r11/consolidation/deepseek-flash/0/v6-fact-01',model:'deepseek-flash',round:0,caseId:'v6-fact-01'}
it('captures actual M4 before closure and restores only memory/permissions with bound original source identity',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-utility-test-'));dirs.push(base)
 const result:any=await runMemoryQualityCase({id:'v6-fact-01',group:'fact',heldOut:false,prompt:'记录石桥试验项目的检查节奏。',body:'石桥试验项目目前每两周检查一次。',answer:'已记录。',expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){const data=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'add',content:'石桥试验项目每两周检查一次。',semantic:'fact',scope:'石桥',attribution:'项目正文',sourceIds:[data.sources.find((s:any)=>s.kind==='body').id]}]})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base,retainArtifact:binding} as any)
 expect(result.utilityArtifact).toBeTruthy()
 const artifact=result.utilityArtifact,original=await readFile(path.join(base,'vault','source','fiction.md'))
 expect(artifact.record.entries).toHaveLength(1)
 await utility.restoreUtilityArtifact(artifact,binding)
 expect(await readFile(path.join(base,'vault','source','fiction.md'))).toEqual(original)
 await writeFile(path.join(base,'vault','extra.md'),'legitimate later note')
 await utility.restoreUtilityArtifact(artifact,binding)
 const outputs:any[]=[],charge=vi.fn()
 const paired:any=await utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(result),taskId:'fact',credential,signal:new AbortController().signal,charge,stream:async function*(input){outputs.push(input);yield {type:'text',text:'每两周检查。'};yield {type:'finish',reason:'stop',usage:{inputTokens:80,outputTokens:12}}}})
 expect(charge).toHaveBeenCalledTimes(2);expect(outputs).toHaveLength(2)
 expect(paired.conditions.off.ledger.chapter.provenance.memoryDeps).toEqual([])
 expect(paired.conditions.on.ledger.chapter.provenance.memoryDeps.length).toBeGreaterThan(0)
 expect(paired.preflight.on.history).toEqual([]);expect(paired.preflight.off.history).toEqual([])
 expect(paired.conditions.on.history).toEqual([]);expect(paired.conditions.off.history).toEqual([])
 expect(paired.conditions.on.input.maxOutputTokens).toBe(paired.conditions.off.input.maxOutputTokens)
 expect(JSON.stringify(outputs[1].messages)).not.toContain('每两周检查。\n每两周检查。')
 for(const taskId of ['forget','permission']){
  const interventionCharge=vi.fn(),pair:any=await utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(result),taskId,credential,signal:new AbortController().signal,charge:interventionCharge,stream:async function*(){yield {type:'text',text:'资料不足。'};yield {type:'finish',reason:'stop'}}})
  expect(interventionCharge).toHaveBeenCalledTimes(2)
  expect(pair.conditions.on.ledger.chapter.provenance.memoryDeps).toEqual([])
  expect(pair.conditions.off.ledger.chapter.provenance.memoryDeps).toEqual([])
  await utility.restoreUtilityArtifact(artifact,binding)
  expect(await readFile(path.join(base,'vault','source','fiction.md'))).toEqual(original)
 }
 let prepared:utility.UtilityArtifact|undefined
 await utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(result),taskId:'permission',credential,signal:new AbortController().signal,charge:()=>{},onPrepared:a=>{prepared=a},stream:async function*(){yield {type:'text',text:'未知。'};yield {type:'finish',reason:'stop'}}})
 const crossedCharge=vi.fn()
 await expect(utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(result),taskId:'forget',credential,signal:new AbortController().signal,charge:crossedCharge,preparedArtifact:prepared,stream:async function*(){throw Error('UNREACHABLE')}})).rejects.toThrow('EVALUATION_UTILITY_PREPARED_BINDING')
 expect(crossedCharge).not.toHaveBeenCalled()
 const afterInterventions:any=await utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(result),taskId:'fact',credential,signal:new AbortController().signal,charge:()=>{},stream:async function*(){yield {type:'text',text:'双周。'};yield {type:'finish',reason:'stop'}}})
 expect(afterInterventions.conditions.on.ledger.chapter.provenance.memoryDeps.length).toBeGreaterThan(0)
 const changingCharge=vi.fn()
 await expect(utility.runUtilityPair({artifact,binding,sourceResultHash:fingerprint(result),taskId:'fact',credential,signal:new AbortController().signal,charge:changingCharge,stream:async function*(){await writeFile(path.join(base,'vault','source','fiction.md'),original.toString()+'changed');yield {type:'text',text:'changed'};yield {type:'finish',reason:'stop'}}})).rejects.toThrow('EVALUATION_ARTIFACT_SOURCE_CHANGED')
 expect(changingCharge).toHaveBeenCalledTimes(1)
 await expect(utility.restoreUtilityArtifact({...artifact,root:path.join(base,'elsewhere')},binding)).rejects.toThrow()
 await expect(utility.restoreUtilityArtifact(artifact,{...binding,frozenHash:'b'.repeat(64)})).rejects.toThrow()
 await writeFile(path.join(base,'vault','source','fiction.md'),original.toString()+'changed')
 await expect(utility.restoreUtilityArtifact(artifact,binding)).rejects.toThrow('EVALUATION_ARTIFACT_SOURCE_CHANGED')
},30000)
it('requires exact unique memory suffix and all remaining input to match before any charge',()=>{
 expect(typeof utility.assertUtilityInputs).toBe('function')
 const input={system:'system',messages:[{role:'user',content:'body\nmemory'}],maxOutputTokens:4096,modelId:'fiction',baseURL:'https://fiction.test',contextTokens:32768}
 expect(()=>utility.assertUtilityInputs(input,{...input,messages:[{role:'user',content:'body'}]},['memory'])).not.toThrow()
 expect(()=>utility.assertUtilityInputs({...input,messages:[{role:'user',content:'memory\nbody\nmemory'}]},{...input,messages:[{role:'user',content:'memory\nbody'}]},['memory'])).toThrow()
 expect(()=>utility.assertUtilityInputs(input,{...input,system:'changed',messages:[{role:'user',content:'body'}]},['memory'])).toThrow()
})
it('blind review binds evidence and preserves independent disagreement',()=>{
 expect(typeof utility.utilityBlindPacket).toBe('function')
 const result={frozenHash:binding.frozenHash,taskId:'fact',model:'deepseek-flash',conditions:{on:{body:'双周',status:'completed'},off:{body:'不知道',status:'completed'}}}
 const packet=utility.utilityBlindPacket(result)
 expect(JSON.stringify(packet.public)).not.toContain('deepseek');expect(JSON.stringify(packet.public)).not.toContain('"on"');expect(packet.public.humanReviewed).toBe(false)
 const a={...packet.public.binding,annotator:{identity:'a',humanReviewed:false,modelNameMasked:true,participatedInDesign:false},scores:packet.public.answers.map((r:any)=>({id:r.id,completion:2,errors:[],limitations:[],scopeFollowed:true}))}
 const b={...a,annotator:{...a.annotator,identity:'b'},scores:a.scores.map((r:any)=>({...r,completion:0}))}
 expect(utility.utilityReviewSummary(packet,a,b,result).disagreements).toHaveLength(2)
 expect(utility.utilityReviewSummary(packet,a,b,result)).toMatchObject({eligible:true,nValid:1})
 expect(()=>utility.utilityReviewSummary(packet,{...a,resultHash:fingerprint('wrong')},b,result)).toThrow()
 expect(()=>utility.utilityReviewSummary(packet,a,{...b,annotator:a.annotator},result)).toThrow()
 const failed={...result,conditions:{on:{body:'',status:'completed',error:'MODEL_REQUEST_FAILED'},off:{body:'不知道',status:'completed'}}}
 const failedPacket=utility.utilityBlindPacket(failed)
 const fa={...failedPacket.public.binding,annotator:{identity:'a',humanReviewed:false,modelNameMasked:true,participatedInDesign:false},scores:failedPacket.public.answers.map((r:any)=>({id:r.id,completion:2,errors:[],limitations:[],scopeFollowed:true}))}
 const fb={...fa,annotator:{...fa.annotator,identity:'b'}}
 expect(utility.utilityReviewSummary(failedPacket,fa,fb,failed)).toMatchObject({eligible:false,nValid:0,primary:null,secondary:null})
})

it('prepared task snapshots cannot be substituted by their unmodified parent artifact',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-utility-test-'));dirs.push(base)
 const result:any=await runMemoryQualityCase({id:'v6-fact-01',group:'fact',heldOut:false,prompt:'记录石桥检查。',body:'石桥每两周检查。',answer:'记录。',expected:{required:[],forbidden:[],notes:''}},credential,async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base,retainArtifact:binding} as any)
 const charge=vi.fn()
 await expect(utility.runUtilityPair({artifact:result.utilityArtifact,binding,sourceResultHash:fingerprint(result),taskId:'forget',credential,signal:new AbortController().signal,charge,preparedArtifact:result.utilityArtifact,stream:async function*(){yield {type:'text',text:'unknown'};yield {type:'finish',reason:'stop'}}})).rejects.toThrow('EVALUATION_UTILITY_PREPARED_BINDING')
 expect(charge).not.toHaveBeenCalled()
})
it('blind labels and authoritative answers cannot change after annotations bind the packet',()=>{
 const result={frozenHash:binding.frozenHash,taskId:'fact',model:'deepseek-flash',conditions:{on:{body:'双周',status:'completed'},off:{body:'不知道',status:'completed'}}},packet=utility.utilityBlindPacket(result)
 const a={...packet.public.binding,annotator:{identity:'a',humanReviewed:false,modelNameMasked:true,participatedInDesign:false},scores:packet.public.answers.map((r:any)=>({id:r.id,completion:r.body==='双周'?2:0,errors:[],limitations:[],scopeFollowed:true}))},b={...a,annotator:{...a.annotator,identity:'b'}}
 const swapped=structuredClone(packet);swapped.private.mapping.forEach(m=>m.condition=m.condition==='on'?'off':'on')
 expect(()=>utility.utilityReviewSummary(swapped,a,b,result)).toThrow('EVALUATION_UTILITY_ANNOTATION_INVALID')
 const changed=structuredClone(packet);changed.public.answers[0]!.body='tampered'
 expect(()=>utility.utilityReviewSummary(changed,a,b,result)).toThrow('EVALUATION_UTILITY_ANNOTATION_INVALID')
})
it('an originally missing source ledger directory is captured as missing and later appearance is rejected',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-utility-test-'));dirs.push(base)
 const result:any=await runMemoryQualityCase({id:'v6-fact-01',group:'fact',heldOut:false,prompt:'记录石桥检查。',body:'石桥每两周检查。',answer:'记录。',expected:{required:[],forbidden:[],notes:''}},credential,async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}'};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base,retainArtifact:binding} as any)
 const artifact=result.utilityArtifact,owner=artifact.owners[0],directory=path.join(artifact.root,'.rgent','ledgers',owner.noteId)
 await rm(directory,{recursive:true})
 const session=new VaultSession(artifact.base,()=>{});session.restore();const service=new WorkingMemoryService(session,()=>null)
 let captured:any
 try{await service.initialize();captured=await utility.captureUtilityArtifact(artifact.base,binding,session,service,artifact.receipt,artifact.sources)}finally{await session.idle();session.dispose()}
 await expect(utility.restoreUtilityArtifact(captured,binding)).resolves.toBeUndefined()
 await mkdir(directory);await writeFile(path.join(directory,'owner.json'),JSON.stringify(owner))
 await expect(utility.restoreUtilityArtifact(captured,binding)).rejects.toThrow('EVALUATION_ARTIFACT_SOURCE_CHANGED')
})
it('chain alpha4 and alpha5 retain separate actual snapshots and allow later unrelated owners without rewriting sources',async()=>{
 const {V6_QUALITY_CASES}=await import('../fixtures/v6-memory-quality.ts'),base=await mkdtemp(path.join(os.tmpdir(),'rgent-utility-chain-'));dirs.push(base)
 const artifacts:any[]=[]
 for(const step of [1,2,3,4,5]){
  const c=V6_QUALITY_CASES.find(c=>c.id===`v6-chain-alpha-${step}`)!,b={...binding,caseId:c.id,key:binding.key.replace('v6-fact-01',c.id)}
  const result:any=await runMemoryQualityCase({id:c.id,group:'standing',heldOut:false,prompt:c.prompt,body:c.body,answer:c.answer,expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){const payload=JSON.parse(String(input.messages[0]!.content)),command=payload.sources.find((s:any)=>s.classification==='command')
   const proposals=step===1?[{action:'add',content:'本库项目记录先给结论后给依据',semantic:'standing',scope:'本库',attribution:'人的口令',sourceIds:[command.id],authority:[{sourceId:command.id,quote:command.text}]}]:step===4&&payload.memory?.length?[{action:'correct',target:payload.memory[0].id,content:'本库项目记录先给依据后给结论',semantic:'standing',scope:'本库',attribution:'人的口令',sourceIds:[command.id],authority:[{sourceId:command.id,quote:command.text}]}]:[]
   yield {type:'text',text:JSON.stringify(payload.memory?{recent:null,proposals}:{recent:null})};yield {type:'finish',reason:'stop'}
  },new AbortController().signal,{strategy:'continuity',base,noteName:`step-${step}.md`,retainArtifact:b,verifyClosure:step===5} as any)
  if(step>=4)artifacts.push(result.utilityArtifact)
 }
 expect(artifacts).toHaveLength(2);expect(artifacts.every(a=>a?.record.entries.length===1)).toBe(true)
 expect(artifacts[0].memory).not.toBe(artifacts[1].memory)
 await utility.restoreUtilityArtifact(artifacts[0],artifacts[0].binding)
 const first=await readFile(path.join(artifacts[0].root,'step-4.md'))
 await utility.restoreUtilityArtifact(artifacts[1],artifacts[1].binding)
 expect(await readFile(path.join(artifacts[0].root,'step-4.md'))).toEqual(first)
 expect(artifacts[0].record.entries.map((e:any)=>[e.id,e.version])).toEqual(artifacts[1].record.entries.map((e:any)=>[e.id,e.version]))
},30000)

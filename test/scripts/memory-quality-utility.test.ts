import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as utility from '../../scripts/memory-quality-utility.ts'
import {runMemoryQualityCase} from '../../scripts/memory-quality-runner.ts'
import {fingerprint} from '../../scripts/memory-quality-support.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})})
const credential={provider:'custom' as const,baseURL:'https://fiction.test/v1',modelId:'fiction',apiKey:'private-secret',contextTokens:32768}
const binding={frozenHash:'a'.repeat(64),key:'v6-2026-10-05/collaboration/r11/consolidation/deepseek-flash/0/v6-fact-01',model:'deepseek-flash',round:0,caseId:'v6-fact-01'}
it('captures actual M4 before closure and restores only memory/permissions with bound original source identity',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-utility-test-'));dirs.push(base)
 const result:any=await runMemoryQualityCase({id:'v6-fact-01',group:'fact',heldOut:false,prompt:'记录石桥试验项目的检查节奏。',body:'石桥试验项目目前每两周检查一次。',answer:'已记录。',expected:{required:[],forbidden:[],notes:''}},credential,async function*(input){const data=JSON.parse(String(input.messages[0]!.content));yield {type:'text',text:JSON.stringify({recent:null,proposals:[{action:'add',content:'石桥试验项目每两周检查一次。',semantic:'fact',scope:'石桥',attribution:'项目正文',sourceIds:[data.sources.find((s:any)=>s.kind==='body').id]}]})};yield {type:'finish',reason:'stop'}},new AbortController().signal,{strategy:'continuity',base,retainArtifact:binding} as any)
 expect(result.utilityArtifact).toBeTruthy()
 const artifact=result.utilityArtifact,original=await readFile(path.join(base,'vault','fiction.md'))
 expect(artifact.record.entries).toHaveLength(1)
 await utility.restoreUtilityArtifact(artifact,binding)
 expect(await readFile(path.join(base,'vault','fiction.md'))).toEqual(original)
 await writeFile(path.join(base,'vault','extra.md'),'legitimate later note')
 await utility.restoreUtilityArtifact(artifact,binding)
 const outputs:any[]=[],charge=vi.fn()
 const paired:any=await utility.runUtilityPair({artifact,binding,taskId:'fact',credential,signal:new AbortController().signal,charge,stream:async function*(input){outputs.push(input);yield {type:'text',text:'每两周检查。'};yield {type:'finish',reason:'stop',usage:{inputTokens:80,outputTokens:12}}}})
 expect(charge).toHaveBeenCalledTimes(2);expect(outputs).toHaveLength(2)
 expect(paired.conditions.off.ledger.chapter.provenance.memoryDeps).toEqual([])
 expect(paired.conditions.on.ledger.chapter.provenance.memoryDeps.length).toBeGreaterThan(0)
 expect(paired.preflight.on.history).toEqual([]);expect(paired.preflight.off.history).toEqual([])
 expect(paired.conditions.on.history).toEqual([]);expect(paired.conditions.off.history).toEqual([])
 expect(paired.conditions.on.input.maxOutputTokens).toBe(paired.conditions.off.input.maxOutputTokens)
 expect(JSON.stringify(outputs[1].messages)).not.toContain('每两周检查。\n每两周检查。')
 await expect(utility.restoreUtilityArtifact({...artifact,root:path.join(base,'elsewhere')},binding)).rejects.toThrow()
 await expect(utility.restoreUtilityArtifact(artifact,{...binding,frozenHash:'b'.repeat(64)})).rejects.toThrow()
 await writeFile(path.join(base,'vault','fiction.md'),original.toString()+'changed')
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
 expect(utility.utilityReviewSummary(packet,a,b).disagreements).toHaveLength(2)
 expect(()=>utility.utilityReviewSummary(packet,{...a,resultHash:fingerprint('wrong')},b)).toThrow()
 expect(()=>utility.utilityReviewSummary(packet,a,{...b,annotator:a.annotator})).toThrow()
})

import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {readQualityEvidence} from '../../src/main/memory-quality-status.ts'
import {MEMORY_PIPELINE,MEMORY_PRODUCTION_STRATEGY} from '../../src/shared/memory.ts'

const dirs:string[]=[]
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})))
const dir=()=>{const value=mkdtempSync(path.join(os.tmpdir(),'rgent-quality-status-'));dirs.push(value);return value}
const binding={modelId:'model-1',host:'api.example.test',pipeline:MEMORY_PIPELINE}

it('reads a published score and marks it stale once the model, host or pipeline changes',()=>{
 const root=dir()
 writeFileSync(path.join(root,'memory-quality-status.json'),JSON.stringify({state:'passed',verifiedAt:'2026-10-05',modelId:'model-1',host:'api.example.test',pipeline:MEMORY_PIPELINE,commit:'abc1234',humanReviewed:false,rounds:2}))
 const evidence=readQualityEvidence(root,binding)
 expect(evidence).toMatchObject({state:'passed',modelId:'model-1',host:'api.example.test',commit:'abc1234',humanReviewed:false,stale:false,rounds:2})
 expect(readQualityEvidence(root,{...binding,host:'api.other.test'}).stale).toBe(true)
 expect(readQualityEvidence(root,{...binding,modelId:'model-2'}).stale).toBe(true)
 expect(readQualityEvidence(root,{...binding,pipeline:'continuity-m3'}).stale).toBe(true)
})
it('never treats a missing, corrupt or unknown score as passed',()=>{
 const root=dir()
 expect(readQualityEvidence(root,binding)).toMatchObject({state:'unverified',stale:false,humanReviewed:false})
 writeFileSync(path.join(root,'memory-quality-status.json'),'{not json')
 expect(readQualityEvidence(root,binding).state).toBe('unverified')
 writeFileSync(path.join(root,'memory-quality-status.json'),JSON.stringify({state:'passed-by-vibes'}))
 expect(readQualityEvidence(root,binding).state).toBe('unverified')
 writeFileSync(path.join(root,'memory-quality-status.json'),JSON.stringify({state:'insufficient',modelId:'model-1',host:'api.example.test',pipeline:MEMORY_PIPELINE,humanReviewed:true}))
 expect(readQualityEvidence(root,binding)).toMatchObject({state:'insufficient',humanReviewed:true,stale:false})
})
it('pins the certified production strategy to the shared pipeline',()=>{
 // r9（revision 9，deepseek-flash 两轮 passed）之后生产入口固定走共同管线。改这个常量＝改产品行为，
 // 必须重新冻结并复测；这里钉住它，避免默认策略被无声改回旧提议解析路径。
 expect(MEMORY_PRODUCTION_STRATEGY).toBe('continuity')
 expect(MEMORY_PIPELINE).toBe('continuity-m4')
 const root=dir()
 writeFileSync(path.join(root,'memory-quality-status.json'),JSON.stringify({state:'passed',verifiedAt:'2026-10-06T00:00:00Z',modelId:'model-1',host:'api.example.test',pipeline:MEMORY_PIPELINE,commit:'d5aca453',humanReviewed:false,rounds:2}))
 expect(readQualityEvidence(root,binding)).toMatchObject({state:'passed',stale:false,humanReviewed:false})
})

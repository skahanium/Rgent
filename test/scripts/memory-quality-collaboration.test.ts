import {expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import * as protocol from '../../scripts/memory-quality-runner.ts'
const observation=(purpose:string,content=JSON.stringify({sources:[],memory:[]}))=>({purpose,sources:[],candidates:[],content,payloadFingerprint:createHash('sha256').update(content).digest('hex')})
it('paid gate consumes only validated real observations and enforces purpose, deadline and shared second call',()=>{
 expect(typeof protocol.ConsolidationPaidGate).toBe('function')
 const gate=new protocol.ConsolidationPaidGate(),first=observation('proposal'),input={messages:[{role:'user',content:first.content}]} as any
 expect(()=>gate.consume(input)).toThrow('EVALUATION_REQUEST_OBSERVATION_REQUIRED')
 expect(()=>gate.observe({...first,payloadFingerprint:'forged'} as any)).toThrow()
 gate.observe(first as any);expect(gate.consume(input).purpose).toBe('proposal')
 expect(()=>gate.consume(input)).toThrow()
 const retry=observation('network-retry');gate.observe(retry as any);expect(gate.consume(input).purpose).toBe('network-retry')
 gate.observe(observation('protocol-repair') as any);expect(()=>gate.consume(input)).toThrow('EVALUATION_CASE_CALL_LIMIT')
 const wrong=new protocol.ConsolidationPaidGate();wrong.observe(observation('recent-regeneration') as any);expect(()=>wrong.consume(input)).toThrow('EVALUATION_REQUEST_PHASE')
 let now=0;const clock=new protocol.ConsolidationPaidGate(()=>now);clock.observe(first as any);clock.consume(input);now=120001;clock.observe(retry as any);expect(()=>clock.consume(input)).toThrow('MEMORY_DEADLINE')
})
it('recent-only and fenced patch are structured in their actual phase; a patch is not a full proposal',()=>{
 expect(typeof protocol.consolidationResponseStructured).toBe('function')
 const recent={goal:'青灯',completed:'1/2已完',blocked:'',next:'3待核',sourceIds:['s1'],assistantDraft:false}
 expect(protocol.consolidationResponseStructured({phase:'recent-regeneration',payload:{},body:JSON.stringify({recent})})).toBe(true)
 const body='```json\n{"proposals":[{"index":1,"value":null}]}\n```'
 expect(protocol.consolidationResponseStructured({phase:'protocol-repair',payload:{repair:{mode:'patch'}},body})).toBe(true)
 expect(protocol.consolidationResponseStructured({phase:'proposal',payload:{},body})).toBe(false)
})

it('freezes a model/group interleaving schedule while preserving each chain and all 120 attempts',async()=>{
 const support=await import('../../scripts/memory-quality-support.ts'),{V6_QUALITY_CASES}=await import('../fixtures/v6-memory-quality.ts')
 expect(typeof support.collaborationSchedule).toBe('function')
 const plan=support.collaborationSchedule(V6_QUALITY_CASES,['deepseek-flash','MiniMax-M3'])
 expect(plan).toHaveLength(120)
 expect(plan.slice(0,2).map(r=>r.model)).toEqual(['deepseek-flash','MiniMax-M3'])
 for(const model of ['deepseek-flash','MiniMax-M3'])for(const round of [0,1])for(const chain of ['alpha','beta'])expect(plan.filter(r=>r.model===model&&r.round===round&&r.caseId.startsWith('v6-chain-'+chain)).map(r=>Number(r.caseId.slice(-1)))).toEqual([1,2,3,4,5])
 expect(new Set(plan.slice(0,12).map(r=>V6_QUALITY_CASES.find(c=>c.id===r.caseId)?.direction)).size).toBeGreaterThan(1)
})
it('accepts a genuine recent-only second request and rejects changed content, phase reuse and a third request',()=>{
 const first=observation('proposal'),input={messages:[{role:'user',content:first.content}]} as any
 const recent=observation('recent-regeneration',JSON.stringify({sources:[],task:{status:'completed'}})),gate=new protocol.ConsolidationPaidGate()
 gate.observe(first as any);gate.consume(input);gate.observe(recent as any)
 expect(gate.consume({messages:[{role:'user',content:recent.content}]} as any).purpose).toBe('recent-regeneration')
 gate.observe(observation('protocol-repair') as any);expect(()=>gate.consume(input)).toThrow('EVALUATION_CASE_CALL_LIMIT')
 const forged=new protocol.ConsolidationPaidGate();forged.observe(first as any);expect(()=>forged.consume({messages:[{role:'user',content:first.content+' '}]} as any)).toThrow('EVALUATION_REQUEST_OBSERVATION_REQUIRED')
 const reused=new protocol.ConsolidationPaidGate();reused.observe(first as any);reused.consume(input);reused.observe(first as any);expect(()=>reused.consume(input)).toThrow('EVALUATION_REQUEST_PHASE')
})

import {readFileSync} from 'node:fs'
import path from 'node:path'
import type {MemoryQualityEvidence} from '../shared/memory.ts'

/** 设备级、非秘密、只读的质量成绩登记：由评测显式发布，供记忆页如实展示。
 *  缺失、损坏或字段非法一律按"尚未验证"处理——绝不把读不到的成绩当成通过。 */
export function readQualityEvidence(userData:string,binding:{modelId:string|null;host:string|null;pipeline:string}):MemoryQualityEvidence{
 const unknown:MemoryQualityEvidence={state:'unverified',humanReviewed:false,stale:false}
 try{
  const value=JSON.parse(readFileSync(path.join(userData,'memory-quality-status.json'),'utf8')) as Record<string,unknown>
  const state=String(value.state??'')
  if(!['testing','passed','failed','insufficient'].includes(state))return unknown
  const text=(name:string)=>typeof value[name]==='string'&&(value[name] as string).length<=256?value[name] as string:null
  const evidence:MemoryQualityEvidence={
   state:state as MemoryQualityEvidence['state'],
   ...(text('verifiedAt')?{verifiedAt:text('verifiedAt')!}:{}),
   modelId:text('modelId'),host:text('host'),pipeline:text('pipeline'),commit:text('commit'),
   humanReviewed:value.humanReviewed===true,
   rounds:Number.isSafeInteger(value.rounds)&&Number(value.rounds)>0&&Number(value.rounds)<=8?Number(value.rounds):null,
   stale:false
  }
  // 成绩绑定实际模型记录、主机与管线版本：关键条件变化后旧成绩保留，但标明适用范围已变。
  const changed=evidence.pipeline!==binding.pipeline||(evidence.modelId??null)!==binding.modelId||(evidence.host??null)!==binding.host
  return {...evidence,stale:changed}
 }catch{return unknown}
}

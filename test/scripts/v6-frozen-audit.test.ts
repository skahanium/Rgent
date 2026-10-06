import {it,expect} from 'vitest'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {V6_QUALITY_CASES} from '../fixtures/v6-memory-quality.ts'
import {V6_RULES,v6Summary,v6TerminalCategory,fingerprint,type V6Row,type V6Annotation} from '../../scripts/memory-quality-support.ts'

/** 冻结成绩只读：本审计不改任何 result／annotation，只派生一份标注为"审计投影"的结论。
 *  归因口径：模型侧＝提案本身违反冻结契约；产品侧＝合规提案被依赖／来源／提交规则拒绝；
 *  检查器＝机械核对当时判错（范围字符串全等、maxActive 数全库）；未知＝没有取得可判定产出。 */
const DIR='.cache/memory-quality/2026-10-04/v6'
const MODEL_CAUSES=new Set(['MEMORY_OUTPUT_INVALID','MEMORY_OUTPUT_REFERENCE_INVALID','MEMORY_OUTPUT_EMPTY','MEMORY_OUTPUT_TRUNCATED','MEMORY_OUTPUT_TOKEN_LIMIT','MEMORY_OUTPUT_LIMIT','MEMORY_TOOLS_FORBIDDEN'])
const PRODUCT_CAUSES=new Set(['MEMORY_DEPENDENCY_CHANGED','MEMORY_SOURCE_CHANGED','MEMORY_MATERIAL_CHANGED','MEMORY_CONFLICT','MEMORY_CHANGED','MEMORY_FILE_LIMIT','MEMORY_ENTRY_LIMIT','BAD_MEMORY_EDIT'])

export function classify(row:any,spec:any):{cause:'model'|'product'|'checker'|'unknown';detail:string}{
 const calls=Array.isArray(row.responses)?row.responses.length:0
 if(!calls)return {cause:'unknown',detail:'zero-model-call'}
 const receipt=row.result?.receipt??null,reason=String(receipt?.reason??'')
 const codes=[reason,...(Array.isArray(receipt?.results)?receipt.results.map((r:any)=>String(r?.code??'')):[])].filter(Boolean)
 const entries=(row.result?.entries??[]) as any[]
 const before=(row.result?.before??[]) as any[]
 const active=(list:any[])=>list.filter(e=>e.category!=='recent'&&e.status==='active')
 const target=spec.seed?active(before).find((e:any)=>e.content===spec.seed.content&&e.semantic===spec.seed.semantic&&e.scope===spec.seed.scope):undefined
 if(spec.expected.action==='correct'&&target){
  const corrected=active(entries).find((e:any)=>e.id===target.id&&e.version===target.version+1&&e.content!==target.content&&e.semantic===target.semantic)
  if(corrected&&String(corrected.scope??'')!==String(target.scope)&&!active(entries).some((e:any)=>e.id===target.id&&e.version===target.version))
   return {cause:'checker',detail:'scope-narrowed-but-checker-required-exact-equality'}
 }
 if(spec.expected.maxActive!==undefined){
  const subject=String(target?.scope??spec.seed?.scope??'').trim().toLocaleLowerCase()
  const sameTopic=subject?active(entries).filter((e:any)=>String(e.scope??'').trim().toLocaleLowerCase()===subject).length:active(entries).length
  if(sameTopic<=spec.expected.maxActive&&active(entries).length>spec.expected.maxActive)
   return {cause:'checker',detail:'maxActive-counted-unrelated-entries'}
 }
 if(codes.some(c=>PRODUCT_CAUSES.has(c)))return {cause:'product',detail:codes.find(c=>PRODUCT_CAUSES.has(c))!}
 if(codes.some(c=>MODEL_CAUSES.has(c)))return {cause:'model',detail:codes.find(c=>MODEL_CAUSES.has(c))!}
 if(spec.expected.action&&row.result?.actionVerified===false)return {cause:'checker',detail:'mechanical-check-failed-without-known-code'}
 return {cause:'product',detail:reason||'receipt-without-specific-code'}
}

const available=existsSync(DIR+'/v6-manifest.json')
it.skipIf(!available)('冻结结果离线审计：动作失败逐例归因，并按修正后的口径重算',()=>{
 const manifest=JSON.parse(readFileSync(DIR+'/v6-manifest.json','utf8'))
 const key=(model:string,round:number,id:string)=>`${manifest.prefix}${model}/${round}/${id}`
 const file=(k:string,kind:string)=>`${DIR}/${kind}-${createHash('sha256').update(JSON.stringify(k)).digest('hex')}.json`
 const report:any={frozenHash:fingerprint(manifest),projection:true,note:'审计投影：按修正后的评分实现离线重算，不覆盖冻结成绩，不是认证成绩',models:{}}
 for(const model of manifest.models.map((m:any)=>m.modelId)){
  report.models[model]={rounds:[]}
  for(const round of [0,1]){
   const rows:V6Row[]=[];const causes:any[]=[];let pausedRows=0,claimedButNotLoadable=0
   for(const spec of V6_QUALITY_CASES){
    const k=key(model,round,spec.id),rf=file(k,'result')
    if(!existsSync(rf))continue
    const r=JSON.parse(readFileSync(rf,'utf8'))
    const primary=existsSync(file(k,'annotation'))?(JSON.parse(readFileSync(file(k,'annotation'),'utf8')).review as V6Annotation):null
    const alt=existsSync(file(k,'annotation2'))?(JSON.parse(readFileSync(file(k,'annotation2'),'utf8')).review as V6Annotation):null
    const paid=r.result??null
    // 冻结记录里的动作结论带当时检查器的误判；归因为 checker 的行按修正后口径视为未失败。
    const audit=spec.expected.action&&paid?.actionVerified!==true?classify(r,spec):null
    const correctedAction=paid?.actionVerified===true||audit?.cause==='checker'
    rows.push({caseId:spec.id,round,dispatched:paid?.dispatched===true,terminal:paid?.terminal===true,structured:paid?.structured===true,blocked:paid?.blocked===true,actionVerified:correctedAction,category:v6TerminalCategory(r),calls:Array.isArray(r.responses)?r.responses.length:0,latencyMs:0,receiptReason:paid?.receipt?.reason,candidate:paid?.candidate??undefined,review:primary,reviewAlt:alt})
    const entries=(paid?.entries??[]) as any[]
    if(entries.some(e=>e.status==='paused'))pausedRows++
    // 标注声称覆盖、但保存内容全部不生效（paused）的行：计入"声明覆盖但下一场装不进"。
    if(primary&&primary.correct>0&&entries.filter(e=>e.category!=='recent').length>0&&entries.filter(e=>e.category!=='recent'&&e.status==='active').length===0)claimedButNotLoadable++
    if(audit)causes.push({caseId:spec.id,frozenActionVerified:false,...audit})
   }
   const corrected=v6Summary(rows,V6_QUALITY_CASES,round,{environmentUnavailable:false})
   const tally=causes.reduce((acc:any,c:any)=>{acc[c.cause]=(acc[c.cause]??0)+1;return acc},{})
   // 只按归因为真实失败（模型／产品／未知）的行扣分；检查器误判不计。
   const realFailures=(tally.model??0)+(tally.product??0)+(tally.unknown??0)
   report.models[model].rounds.push({round:round+1,cases:rows.length,actionFailures:causes.length,realFailures,causes:tally,
    pausedRows,claimedButNotLoadable,
    corrected:{verdict:(corrected as any).verdict,score:(corrected as any).lower.total,gates:(corrected as any).gates,reasons:(corrected as any).reasons,metrics:(corrected as any).metrics}})
   console.log('AUDIT',model,'round',round+1,JSON.stringify({frozenFailures:causes.length,realFailures,causes:tally,pausedRows,claimedButNotLoadable,verdict:(corrected as any).verdict,score:(corrected as any).lower.total,gates:(corrected as any).gates,reasons:(corrected as any).reasons}))
  }
 }
 writeFileSync(DIR+'/audit-'+report.frozenHash.slice(0,12)+'.json',JSON.stringify(report,null,2),{mode:0o600})
 // 归因必须覆盖全部动作失败例，且四类互斥。
 for(const model of Object.keys(report.models))for(const r of report.models[model].rounds){
  expect((r.causes.model??0)+(r.causes.product??0)+(r.causes.checker??0)+(r.causes.unknown??0)).toBe(r.actionFailures)
 }
 expect(Object.values(report.models as any).every((m:any)=>m.rounds.length===2)).toBe(true)
 expect(V6_RULES.total).toBe(70)
})

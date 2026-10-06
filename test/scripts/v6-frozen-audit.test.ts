import {it,expect} from 'vitest'
import {V6_QUALITY_CASES} from '../fixtures/v6-memory-quality.ts'
import {v6ReviewValid,v6LoadedActionState,v6Summary,v6CaseBounds,type V6Annotation,type V6Row} from '../../scripts/memory-quality-support.ts'
const review=(i=0):V6Annotation=>({correct:V6_QUALITY_CASES[i].expected.units.length,omitted:0,wrongNew:0,hardViolations:[],checks:{attributionAndScope:true,noUnsupportedContent:true,noForbiddenContent:true},evidenceComplete:true,uncertainty:[],annotator:{identity:'a',kind:'agent',participatedInDesign:false,modelNameMasked:true,humanReviewed:false},rulesHash:'r',resultHash:'s',frozenHash:'f'})
const rows=():V6Row[]=>V6_QUALITY_CASES.map((c,i)=>({caseId:c.id,round:0,dispatched:true,terminal:true,structured:true,actionVerified:true,category:'valid',review:review(i)}))
it('完整标注须穷尽正例单元',()=>expect(v6ReviewValid(V6_QUALITY_CASES[0],{...review(),correct:0,omitted:0})).toBe(false))
it('未派发轮明确为 not-run',()=>expect(v6Summary([],V6_QUALITY_CASES,1).verdict).toBe('not-run'))
it('受阻链保留原始权重和未知上下界',()=>{const r=rows();r[20]={...r[20],blocked:true,review:null};const s=v6Summary(r,V6_QUALITY_CASES,0);expect(s.upper.total).toBe(100);expect(s.lower.total).toBe(100-V6_QUALITY_CASES[20].weight);expect(s.unknown).toBe(1)})
it('单方否决未获独立一致不能直接 fail',()=>{const r=rows();r[0].review={...review(),hardViolations:['wrong-attribution']};expect(v6Summary(r,V6_QUALITY_CASES,0).vetoes).toEqual([]);expect(v6Summary(r,V6_QUALITY_CASES,0).verdict).toBe('insufficient-evidence');expect(v6CaseBounds(V6_QUALITY_CASES[0],r[0]).upper).toBe(1)})
it('双方完整独立一致否决明确 fail',()=>{const r=rows();r[0].review={...review(),hardViolations:['wrong-attribution']};r[0].reviewAlt={...r[0].review,annotator:{...review().annotator,identity:'b'}};expect(v6Summary(r,V6_QUALITY_CASES,0).verdict).toBe('failed')})
it('存在不完整第二标注时不能抹掉未知',()=>{const a=review();const b={...a,evidenceComplete:false,uncertainty:['no-model-output'],annotator:{...a.annotator,identity:'b'}};expect(v6CaseBounds(V6_QUALITY_CASES[0],{review:a,reviewAlt:b})).toMatchObject({lower:0,upper:1})})
it('双标相同检查值不因 JSON 字段顺序不同而出现假分歧',()=>{
 const r=rows(),a=review(),b={...a,checks:{noForbiddenContent:true,noUnsupportedContent:true,attributionAndScope:true},annotator:{...a.annotator,identity:'b'}}
 r[0]={...r[0],review:a,reviewAlt:b,doubleRequired:true}
 expect(v6CaseBounds(V6_QUALITY_CASES[0],r[0])).toMatchObject({lower:1,upper:1,disagreement:false,unresolved:false})
 expect(v6Summary(r,V6_QUALITY_CASES,0).unknown).toBe(0)
 const changed={...b,checks:{...b.checks,noUnsupportedContent:false}}
 expect(v6CaseBounds(V6_QUALITY_CASES[0],{...r[0],reviewAlt:changed})).toMatchObject({disagreement:true,unresolved:true})
})

it('下一场必须装入精确目标版本，缺证据保持未知',()=>{expect(v6LoadedActionState('success',[{id:'target',version:2}],[{id:'other',version:2}])).toBe('failure');expect(v6LoadedActionState('success',[{id:'target',version:2}],[{id:'target',version:1}])).toBe('failure');expect(v6LoadedActionState('success',[{id:'target',version:2}],undefined)).toBe('unknown');expect(v6LoadedActionState('success',[{id:'target',version:2}],[{id:'target',version:2}])).toBe('success')})

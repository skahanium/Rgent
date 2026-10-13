import {expect,it,vi} from 'vitest'
// 导入该模块即会读 Electron 的 app 并把 userData 指向评测报告目录；这里只替掉壳，并让 whenReady
// 不落地，于是 CLI 主体不会执行，测试只针对其中导出的纯函数。
vi.mock('electron',()=>({app:{setName:()=>{},setPath:()=>{},whenReady:()=>({then:()=>undefined})},safeStorage:{}}))
process.env.RGENT_MEMORY_EVAL_OPTIONS=JSON.stringify({report:'/fiction/rgent-human-review'})
const {humanReviewCoverage}=await import('../../scripts/memory-quality-electron.ts')
const human={annotator:{kind:'human',humanReviewed:true}}
const agent={annotator:{kind:'agent',humanReviewed:true}}
const unreviewed={annotator:{kind:'human',humanReviewed:false}}
it('每一行都是已标记人工复核的人工标注时，覆盖完整且计数正确',()=>{
 expect(humanReviewCoverage([human,human])).toEqual({complete:true,humans:2,total:2})
})
it('混入 agent 标注的行时覆盖不完整，agent 不计入人数',()=>{
 expect(humanReviewCoverage([human,agent])).toEqual({complete:false,humans:1,total:2})
})
it('人工标注但没有 humanReviewed 标记的行不算已复核',()=>{
 expect(humanReviewCoverage([human,unreviewed])).toEqual({complete:false,humans:1,total:2})
})
it('缺少 annotator 的行既不计入人数也让覆盖不完整',()=>{
 expect(humanReviewCoverage([human,{}])).toEqual({complete:false,humans:1,total:2})
})
it('没有任何在范围内行时视为不完整，不把“没有行需要复核”当成人工复核已通过',()=>{
 expect(humanReviewCoverage([])).toEqual({complete:false,humans:0,total:0})
})

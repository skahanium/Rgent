import {MEMORY_QUALITY_CASES,type MemoryQualityCase} from './memory-quality.ts'

export type V5Case={id:string;group:'standing'|'fact'|'recent'|'negative';prompt:string;body:string;answer:string;expected:{long:string[];recent:string[];forbidden:string[];action?:'add'|'correct'|'unchanged'|'conflict';maxActive?:number};seed?:MemoryQualityCase['seed'];chain?:'alpha'|'beta';step?:number}

// Replace one sample in each long group with update/repetition coverage, retaining 20 independent cases.
const long=['standing','fact'].flatMap(group=>MEMORY_QUALITY_CASES.filter(c=>c.group===group).slice(0,5)).map(c=>
 c.id==='standing-05'?MEMORY_QUALITY_CASES.find(c=>c.id==='duplicate-06')!:c.id==='fact-05'?MEMORY_QUALITY_CASES.find(c=>c.id==='correction-01')!:c).map(c=>({id:'v5-'+c.id,group:(c.group==='duplicate'?'standing':c.group==='correction'?'fact':c.group) as 'standing'|'fact',seed:c.seed,prompt:c.prompt,body:c.body,answer:c.answer,expected:{long:c.expected.required,recent:[],forbidden:c.expected.forbidden,action:c.expected.action,maxActive:c.expected.maxActive}}))

const recent=Array.from({length:5},(_,i)=>({id:`v5-recent-${i+1}`,group:'recent' as const,prompt:`继续虚构项目青灯的第 ${i+1} 项整理`,body:`【虚构质量夹具】青灯项目本轮目标是核对第 ${i+1} 项样稿；已完成目录检查；受阻于待确认的版本号；下一步核对版本号后继续。`,answer:'已列出待核对事项，尚未执行下一步。',expected:{long:[],recent:[`青灯第 ${i+1} 项样稿`,`目录检查`,`版本号待确认`,`核对版本号`],forbidden:['版本已确认','助手已完成下一步']}}))
const negative=['temporary-01','attribution-01','ambiguous-01','malicious-01','temporary-02'].map(id=>MEMORY_QUALITY_CASES.find(c=>c.id===id)!).map(c=>({id:'v5-'+c.id,group:'negative' as const,seed:c.seed,prompt:c.prompt,body:c.body,answer:c.answer,expected:{long:[],recent:[],forbidden:c.expected.forbidden}}))
const chain=(name:'alpha'|'beta')=>Array.from({length:5},(_,i)=>({id:`v5-chain-${name}-${i+1}`,group:'recent' as const,chain:name,step:i+1,prompt:`接续虚构${name==='alpha'?'青灯':'银桥'}项目第 ${i+1} 步`,body:`【虚构质量夹具】${name==='alpha'?'青灯':'银桥'}项目目标是核对五份样稿；第 ${i+1} 份已完成目录检查，下一步核对版本号；前序步骤的状态须保留。`,answer:'这是未被人采纳的助手草稿；不能宣称版本号已经核对。',expected:{long:[],recent:[`第 ${i+1} 份目录检查`,`核对版本号`],forbidden:['版本号已经核对','助手草稿已被采纳']}}))

export const V5_QUALITY_CASES:V5Case[]=[...long,...recent,...negative,...chain('alpha'),...chain('beta')]
export const V5_SCREEN_IDS=['v5-standing-01','v5-fact-01','v5-recent-1','v5-temporary-01','v5-attribution-01','v5-chain-alpha-1','v5-chain-beta-1','v5-ambiguous-01','v5-standing-02','v5-fact-02'] as const

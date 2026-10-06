import { expect, it } from 'vitest'
import type { MemoryEntry } from '../../src/shared/memory.ts'
import { createMemoryUsePermit, recallMemory, memorySection, updateMemoryCandidates } from '../../src/main/memory-use.ts'

const entry = (id: string, content = '项目使用中文', layer: 'core' | 'demand' = 'core'): MemoryEntry => ({ id, version: 1, content, layer, scope: '本库', status: 'active', reason: null, updatedAt: '2026-10-02', updateBasis: { kind: 'manual', id: 'manual', version: 1 }, sources: [{ id: `source-${id}`, version: 1, relPath: 'outside.md', objectVersion: 'object', revision: 'a'.repeat(64), permissionTier: 'reference', kind: 'body', taskId: null, taskMaterialHash: null, classification: 'human', start: 0, end: 2, text: '依据', hash: 'b'.repeat(64), basisHash: 'c'.repeat(64), sourceDeps: [], memoryDeps: [] }] })
const model = { provider: 'custom' as const, modelId: 'main', baseURL: 'https://example.com/v1', contextTokens: 16000, apiKey: 'secret' }
it('keeps scope and factual attribution in the material actually sent to the model',()=>{
 const fact={...entry('meeting','需要使用英文','demand'),scope:'仅项目甲会议',semantic:'fact' as const,attribution:'第三方会议纪要记载',reviewAt:null}
 const material=memorySection(fact)
 expect(material).toContain('仅项目甲会议')
 expect(material).toContain('第三方会议纪要记载')
 expect(material).toContain('fact')
 expect(material).toContain(fact.updatedAt)
})
function setup() {
  let enabled = true, revision = 0, sessionId = 'session'
  let entries = [entry('core'), entry('demand', '中文项目方案', 'demand')]
  let reads = 0
  return {
    port: { context: () => ({ sessionId, vaultKey: 'vault' }), config: () => ({ enabled, revision }), entries: async () => { reads++; return structuredClone(entries) } },
    set: (next: MemoryEntry[]) => { entries = next }, off: () => { enabled = false; revision++ }, on: () => { enabled = true; revision++ }, swap: () => { sessionId = 'next' }, reads: () => reads
  }
}
it('defaults off and never loads or emits entries without independent permission', async () => {
  const s = setup(); s.off()
  const permit = await createMemoryUsePermit(s.port, model, '中文', '')
  expect(permit.recall.core).toEqual([])
  expect(await permit.validateDependency({ id: 'core', version: 1, basisHashes: [], sourceDeps: [] })).toBe(false)
  expect(s.reads()).toBe(0)
})
it('fixes the snapshot and selected receiver; new tasks alone see new entries', async () => {
  const s = setup(); const a = await createMemoryUsePermit(s.port, model, '中文', '')
  s.set([entry('core'), entry('new')]); const b = await createMemoryUsePermit(s.port, model, '中文', '')
  expect(a.recall.core.map(x => x.id)).toEqual(['core'])
  expect(b.recall.core.map(x => x.id)).toEqual(['core', 'new'])
  a.stage([...a.recall.core,...a.recall.demand].map(e=>e.id))
  await expect(a.assertCurrent(model)).rejects.toThrow('MEMORY_CHANGED')
  await expect(b.assertCurrent({ ...model, modelId: 'other' })).rejects.toThrow('MEMORY_RECEIVER_CHANGED')
})
it('revokes permanently after OFF/ON and checks entry version, pause and vault session', async () => {
  for (const change of ['off', 'version', 'pause', 'session']) {
    const s = setup(); const p = await createMemoryUsePermit(s.port, model, '中文', '')
    p.stage([...p.recall.core,...p.recall.demand].map(e=>e.id))
    if (change === 'off') { s.off(); s.on() }
    if (change === 'version') s.set([{ ...entry('core'), version: 2 }])
    if (change === 'pause') s.set([{ ...entry('core'), status: 'paused' }])
    if (change === 'session') s.swap()
    await expect(p.assertCurrent(model)).rejects.toThrow()
  }
})
it('filters before local Unicode matching; caps demand at eight and reports every omitted match', () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(`d${i}`, '中文项目 abc', 'demand'))
  entries.unshift({ ...entry('disabled', '中文项目 abc', 'demand'), status: 'disabled' })
  const recall = recallMemory(entries, '中文项目 abc', '')
  expect(recall.demand).toHaveLength(8)
  expect(recall.omittedDemand).toHaveLength(4)
  expect(recall.demand.some(e => e.id === 'disabled')).toBe(false)
  expect(recallMemory([entry('match', '中华人民共和国项目', 'demand')], '中华', '').demand).toHaveLength(1)
})
it('omits core overflow and demand that exceeds its own token budget', () => {
  expect(recallMemory([entry('large', '中'.repeat(2000))], '', '').core).toEqual([])
  const recall = recallMemory([entry('large', '中文'.repeat(800), 'demand')], '中文', '')
  expect(recall.demand).toEqual([]); expect(recall.omittedDemand).toEqual(['large'])
})

it('keeps core with prompt and placement mandatory, while omitting demand explicitly', async () => {
  const { buildHostContext } = await import('../../src/main/host-context.ts')
  const memory = recallMemory([entry('core'), entry('optional', '中文'.repeat(80), 'demand')], '中文', '')
  const make = (budget: number) => buildHostContext({ source: '附近正文', prompt: '中文', placement: 0, inputBudgetTokens: budget, countTokens: Buffer.byteLength, memory })
  expect(make(180).status).toBe('too-large')
  const plan = make(600)
  expect(plan.status).toBe('ready')
  if (plan.status !== 'ready') return
  expect(plan.content).toContain('项目使用中文')
  expect(plan.memoryIds).toEqual(['core'])
  expect(plan.omitted.memoryIds).toEqual(['optional'])
})

it('lets a task that never used memory continue after OFF, without acquiring new entries after ON', async () => {
 const s=setup();s.set([]);const p=await createMemoryUsePermit(s.port,model,'问','')
 s.off();await expect(p.assertCurrent(model)).resolves.toBeUndefined()
 s.set([entry('new')]);s.on();await expect(p.assertCurrent(model)).resolves.toBeUndefined()
 expect(p.recall.core).toEqual([])
 expect(await p.validateDependency({id:'new',version:1,basisHashes:[],sourceDeps:[]})).toBe(false)
})

it('validates a batch of historical dependencies with one current source-validation snapshot', async () => {
 const { memoryDependency }=await import('../../src/main/memory-use.ts')
 const s=setup(),p=await createMemoryUsePermit(s.port,model,'中文',''),before=s.reads()
 const deps=[memoryDependency(entry('core')),memoryDependency(entry('demand','中文项目方案','demand'))]
 expect(await p.validateDependencies(deps)).toEqual([true,true]);expect(s.reads()-before).toBe(1)
})

it('uses full selection only at startup, then requests just the actual direct or historical IDs', async()=>{
 const s=setup(),requests:(readonly string[]|undefined)[]=[]
 const original=s.port.entries
 s.port.entries=async(ids?:readonly string[])=>{requests.push(ids);return original()}
 const p=await createMemoryUsePermit(s.port,model,'中文','');p.stage(['core']);await p.assertCurrent(model)
 const {memoryDependency}=await import('../../src/main/memory-use.ts')
 await p.validateDependencies([memoryDependency(entry('demand','中文项目方案','demand'))])
 expect(requests).toEqual([undefined,['core'],['demand']])
})
it('degrades initial invalid memory to an ordinary task and never blocks on a full core',async()=>{
 const context={sessionId:'s',vaultKey:'a'.repeat(64)},model={provider:'custom' as const,baseURL:'https://example.test/v1',modelId:'m',apiKey:'secret',contextTokens:8192}
 const permit=await createMemoryUsePermit({context:()=>context,config:()=>({enabled:true,revision:1}),entries:async()=>{throw Error('MEMORY_STORAGE_INVALID')}},model,'问','')
 expect(permit.recall.core).toEqual([]);await expect(permit.assertCurrent(model)).resolves.toBeUndefined()
})
it('memory queries use the frozen snapshot and preserve tool dependencies through context restaging',async()=>{
 const s=setup(),p=await createMemoryUsePermit(s.port,model,'无关口令','')
 s.set([entry('core'),entry('demand','中文项目方案','demand'),entry('new','新增加中文','demand')])
 const result=await p.search('中文');expect(result.map(e=>e.id).sort()).toEqual(['core','demand'])
 p.stage(['core']);await p.assertCurrent(model);p.markSent()
 expect(p.dependencies().map(d=>d.id).sort()).toEqual(['core','demand'])
 s.set([entry('core'),{...entry('demand','中文项目方案','demand'),status:'disabled'}])
 await expect(p.assertCurrent(model)).rejects.toThrow('MEMORY_CHANGED')
})

// Fixed lexical benchmark, not a claim that word matching understands paraphrases.
const recallTopics=('量子纠缠 热力平衡 星际尘埃 海洋环流 火山喷发 地壳运动 光合作用 遗传密码 神经突触 免疫应答 蛋白折叠 大气污染 土壤侵蚀 冰川消融 混凝土养护 桥梁荷载 城市排水 农田灌溉 森林防火 湿地保护 水稻育种 苹果授粉 茶叶发酵 葡萄修剪 陶瓷烧结 钢铁冶炼 铜矿浮选 锂电循环 光纤传输 卫星定位 交通调度 物流分拣 仓储盘点 食品冷藏 药品质控 临床随访 语言习得 古籍校勘 文物修复 音乐节奏 绘画透视 建筑采光 财务审计 税务申报 期权定价 货币供给 劳动仲裁 专利检索 合同履约 公共卫生 '+
'astronomy botany crystallography dendrology entomology fermentation geodesy hydrology immunology jurisprudence kinematics linguistics metallurgy neurology ornithology paleontology radiometry seismology thermometry virology acoustics biomechanics cryptography demography ergonomics fluidics genomics hematology ichthyology lexicography mineralogy nephrology oceanography pathology rheology spectroscopy toxicology volcanology aerodynamics cardiology epidemiology glaciology horticulture microscopy nanotechnology pharmacology robotics telecommunication urbanism zoology').split(' ')
it('measures top-eight coverage and irrelevant returns on 1000 fixed memories / 100 lexical queries',()=>{
 expect(recallTopics).toHaveLength(100)
 const memories=recallTopics.flatMap((topic,i)=>Array.from({length:8},(_,j)=>entry(`topic-${i}-${j}`,`${topic}：第${j+1}项约定，采用独立验证。`,'demand')))
 memories.push(...Array.from({length:200},(_,i)=>entry(`noise-${i}`,'项目会议施工进度和预算说明。','demand')))
 let covered=0,returned=0,irrelevant=0
 for(const [i,topic] of recallTopics.entries()){
  const result=recallMemory(memories,`请核对 ${topic} 约定`,'项目会议施工进度和预算说明。').demand
  const correct=result.filter(e=>e.id.startsWith(`topic-${i}-`)).length
  if(correct>=7)covered++
  returned+=result.length;irrelevant+=result.length-correct
 }
 expect(covered/100).toBeGreaterThanOrEqual(.85)
 expect(irrelevant/Math.max(returned,1)).toBeLessThanOrEqual(.05)
})

it('reports independent labeled recall quality, no-answer false positives and the lexical semantic gap',async()=>{
 const {memoryRecallQualityFixture}=await import('../fixtures/memory-recall-quality.ts')
 const {memories,queries,labels}=memoryRecallQualityFixture(entry)
 expect(memories).toHaveLength(1000);expect(queries).toHaveLength(100)
 let recall=0,returned=0,irrelevant=0,noAnswerFalsePositives=0,semanticRecall=0
 const failedQueries:{id:string;query:string;kind:string;expected:string[];returned:string[]}[]=[]
 for(const q of queries){
  const result=recallMemory(memories,q.query,q.near).demand
  const correct=result.filter(e=>q.relevantIds.includes(e.id)).length
  if(correct<q.relevantIds.length||result.some(e=>!q.relevantIds.includes(e.id)))failedQueries.push({id:q.id,query:q.query,kind:q.kind,expected:q.relevantIds,returned:result.map(e=>e.id)})
  if(q.kind==='answered'){recall+=correct/q.relevantIds.length;returned+=result.length;irrelevant+=result.length-correct}
  else if(q.kind==='no-answer'){noAnswerFalsePositives+=Number(result.length>0);returned+=result.length;irrelevant+=result.length}
  else {semanticRecall+=correct/q.relevantIds.length;returned+=result.length;irrelevant+=result.length-correct}
 }
 const report={labels,meanRecallAt8:(recall+semanticRecall)/labels.answered,lexicalRecallAt8:recall/labels.lexicalAnswered,irrelevantFraction:irrelevant/Math.max(1,returned),noAnswerFalsePositiveRate:noAnswerFalsePositives/labels.noAnswer,pureSemanticRecallAt8:semanticRecall/labels.semanticGap,failedQueries}
 console.info('Memory recall labeled quality',JSON.stringify(report))
 expect(report.meanRecallAt8).toBeGreaterThanOrEqual(.85)
 expect(report.irrelevantFraction).toBeLessThanOrEqual(.05)
 expect(report.noAnswerFalsePositiveRate).toBe(0)
})

it('English terms match whole words rather than substrings in another topic',()=>{
 expect(recallMemory([entry('fiber','fiber transmission measurement','demand')],'comet ion tail','').demand).toEqual([])
 expect(recallMemory([entry('ion','comet ion tail observations','demand')],'ion','').demand.map(e=>e.id)).toEqual(['ion'])
})
it('recalls English identifiers adjacent to Chinese text in either direction',()=>{
 for(const content of ['供应商OpenAI提供服务','OpenAI供应商提供服务']){
  expect(recallMemory([entry('mixed',content,'demand')],'OpenAI','').demand.map(e=>e.id)).toEqual(['mixed'])
 }
})
it('shares candidate relevance across layers and the authorized source text, including old factual correction targets',async()=>{
 const {rankMemoryEntries}=await import('../../src/main/memory-use.ts')
 const old={...entry('old','火星项目交付日期为十月一日','core'),semantic:'fact' as const,attribution:'旧项目纪要'}
 const unrelated=Array.from({length:8},(_,i)=>entry(`other-${i}`,'音乐节奏训练规则','core'))
 expect(rankMemoryEntries([...unrelated,old], '核对最新说明','火星项目交付日期已经改为十月三日。').map(e=>e.id)).toEqual(['old'])
})

it('searches authorized core overflow as well as demand with one bounded current proof',async()=>{
 const {conservativeTokens}=await import('../../src/main/context-budget.ts'),filler=entry('filler','')
 filler.content='别'.repeat(Math.floor((2048-conservativeTokens(memorySection(filler)))/2))
 const s=setup();s.set([filler,entry('core','中文项目核心'),entry('demand','中文项目方案','demand')]);const p=await createMemoryUsePermit(s.port,model,'无关','')
 expect(p.recall.core.some(e=>e.id==='core')).toBe(false)
 expect((await p.search('中文')).map(e=>e.id).sort()).toEqual(['core','demand'])
})
it('rejects a previously selected memory dependency whose source became invalid before search continuation',async()=>{
 const s=setup();const p=await createMemoryUsePermit(s.port,model,'无关','');p.stage(['core']);s.set([{...entry('core'),status:'paused'},entry('demand','中文项目方案','demand')])
 await expect(p.assertCurrent(model)).rejects.toThrow('MEMORY_CHANGED')
})

it('filters an unused invalid item while allowing the authorized search and continuation',async()=>{
 const s=setup();const p=await createMemoryUsePermit(s.port,model,'无关','');s.set([{...entry('core'),status:'paused'},entry('demand','中文项目方案','demand')])
 expect((await p.search('中文')).map(e=>e.id)).toEqual(['demand']);await expect(p.assertCurrent(model)).resolves.toBeUndefined()
})
it('preflights staged memory dependencies without attributing an unsent selection as sent',async()=>{
 const s=setup(),permit=await createMemoryUsePermit(s.port,model,'中文','');permit.stage(['core'])
 expect(permit.dependencies()).toEqual([]);expect(permit.dependencies(true).map(d=>d.id)).toEqual(['core'])
 permit.stage(['demand']);expect(permit.dependencies(true).map(d=>d.id)).toEqual(['demand']);expect(permit.dependencies()).toEqual([])
 permit.markSent();expect(permit.dependencies().map(d=>d.id)).toEqual(['demand'])
})

it('keeps recent blocks between standing agreements and project facts within the total cap',()=>{
 const now=new Date().toISOString()
 const make=(id:string,category:'long'|'recent',layer:'core'|'demand')=>({...entry(id,`项目工作 ${id}`,layer),category,updatedAt:now})
 const selected=recallMemory([make('standing','long','core'),make('recent','recent','demand'),make('fact','long','demand')],'项目工作','')
 expect(selected.core.map(e=>e.id)).toEqual(['standing'])
 expect(selected.recent?.map(e=>e.id)).toEqual(['recent'])
 expect(selected.demand.map(e=>e.id)).toEqual(['fact'])
})

it('update candidates reserve relevant project facts alongside agreements and honor tags as lexical hints',async()=>{
 const {updateMemoryCandidates}=await import('../../src/main/memory-use.ts')
 const facts=Array.from({length:5},(_,i)=>({...entry('fact-'+i,'部署端口','demand'),semantic:'fact' as const,tags:['青灯'],scope:'项目甲'}))
 const agreements=Array.from({length:40},(_,i)=>({...entry('standing-'+i,'青灯项目部署端口要求中文'),semantic:'standing' as const}))
 const selected=updateMemoryCandidates([...agreements,...facts],'青灯项目部署端口调整','')
 expect(selected).toHaveLength(16);expect(selected.filter(e=>e.semantic==='fact').length).toBeGreaterThanOrEqual(4)
 expect(facts.every(e=>e.content==='部署端口')).toBe(true)
})

it('sends recent time, outcome and unaccepted assistant attribution in the budgeted material',async()=>{
 const {memorySection}=await import('../../src/main/memory-use.ts')
 const recent={...entry('background','助手提出的草案待确认','demand'),category:'recent' as const,recent:{taskId:'t',noteId:'n',materialVersion:'a'.repeat(64),createdAt:'2026-10-01T00:00:00.000Z',outcome:'completed' as const,sections:{goal:'目标',completed:'草案',blocked:'待确认',next:''},assistantDraft:true}}
 const sent=memorySection(recent);expect(sent).toContain('2026-10-01');expect(sent).toContain('"assistantDraft":true');expect(sent).toContain('不能视为人的决定');expect(sent).toContain('"taskResult":"completed"')
})

it('backfills update candidates from explicit scope signals and task usage without claiming equivalence',()=>{
 const candidate=(id:string,content:string,scope:string,updatedAt:string,semantic:'standing'|'fact',tags:string[]=[])=>({id,status:'active' as const,content,scope,updatedAt,semantic,tags,category:'long' as const})
 const inScope=candidate('scope-hit','完全不同的措辞甲','石桥项目','2026-01-01','fact')
 const used=candidate('used-hit','完全不同的措辞乙','本库','2026-01-02','standing')
 const unrelated=candidate('unrelated','完全不同的措辞丙','别处','2026-01-03','fact')
 const selected=updateMemoryCandidates([inScope,used,unrelated],'继续石桥项目的核对','',['used-hit'])
 expect(selected.map(item=>item.id)).toContain('scope-hit')
 expect(selected.map(item=>item.id)).toContain('used-hit')
 expect(selected.map(item=>item.id)).not.toContain('unrelated')
})
it('reserves candidate slots for both long-term agreements and project facts',()=>{
 const many=(semantic:'standing'|'fact',count:number)=>Array.from({length:count},(_,i)=>({id:`${semantic}-${i}`,status:'active' as const,content:'核对样稿版本号',scope:'本库',updatedAt:'2026-01-01',semantic,tags:[],category:'long' as const}))
 const lone:('standing'|'fact')[]=['standing','fact']
 for(const only of lone){
  const other=only==='standing'?'fact':'standing'
  const selected=updateMemoryCandidates([...many(only,20),...many(other,1)],'核对样稿版本号','')
  expect(selected).toHaveLength(16)
  expect(selected.some(item=>item.semantic===other)).toBe(true)
 }
})

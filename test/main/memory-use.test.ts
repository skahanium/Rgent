import { expect, it } from 'vitest'
import type { MemoryEntry } from '../../src/shared/memory.ts'
import { createMemoryUsePermit, recallMemory, memorySection } from '../../src/main/memory-use.ts'

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
 const result=await p.search('中文');expect(result.map(e=>e.id)).toEqual(['demand'])
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

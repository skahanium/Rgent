import type {MemoryEntry} from '../../src/shared/memory.ts'

/** Labels describe the topic AND requested facet, rather than a match in generated text. */
const topics:[string,string,string,string,string][]=[
 ['电池','循环寿命','电池经过循环后的寿命如何评估','循环寿命与电池测试有什么联系','充电效率'],
 ['桥梁','荷载监测','如何监测桥梁承受的荷载','桥梁荷载的监测依据有哪些','路面铺装'],
 ['海洋','环流变化','海洋中的环流变化怎样观测','环流变化会如何影响海洋','潮汐预报'],
 ['古籍','校勘版本','古籍不同版本怎样校勘','校勘古籍时版本依据如何记录','纸张修复'],
 ['葡萄','修剪季节','葡萄应当在什么季节修剪','季节变化对葡萄修剪有何影响','采收包装'],
 ['湿地','生态保护','湿地生态应如何保护','保护湿地的生态需要哪些措施','旅游路线'],
 ['光纤','传输损耗','光纤传输过程中损耗如何测量','怎样衡量传输光纤的损耗','安装支架'],
 ['卫星','定位误差','卫星定位的误差如何检查','定位结果的卫星误差有哪些','发射燃料'],
 ['税务','申报期限','税务申报的期限如何核对','如何记录申报税务的期限','发票格式'],
 ['财务','审计证据','财务审计要保留什么证据','审计财务资料的证据有哪些','报销流程'],
 ['水稻','育种试验','水稻育种应安排什么试验','试验中的水稻育种如何记录','仓库储存'],
 ['蛋白','折叠结构','蛋白折叠后的结构如何判断','结构变化会怎样影响蛋白折叠','合成原料'],
 ['森林','防火巡查','森林防火需要怎样巡查','巡查森林时防火如何记录','木材运输'],
 ['城市','排水容量','城市排水容量应如何评估','排水设施的城市容量如何计算','交通信号'],
 ['临床','随访周期','临床随访的周期如何确定','按什么周期进行临床随访','用药包装'],
 ['仓储','盘点差异','仓储盘点的差异如何处理','如何记录盘点仓储的差异','运输线路'],
 ['合同','履约责任','合同履约责任由谁确认','责任变更如何影响合同履约','档案装订'],
 ['陶瓷','烧结温度','陶瓷烧结时温度如何设定','温度变化如何影响陶瓷烧结','外观纹样'],
 ['土壤','侵蚀程度','土壤侵蚀程度如何测量','程度不同的土壤侵蚀如何记录','作物售价'],
 ['音乐','节奏训练','音乐节奏应该怎样训练','训练音乐时节奏如何核对','场馆座位'],
 ['battery','cycle lifetime','How is battery cycle lifetime evaluated','Evaluate lifetime during battery cycle tests','charging efficiency'],
 ['bridge','load monitoring','Explain bridge load monitoring procedures','Which monitoring records describe bridge load','surface paving'],
 ['ocean','current variation','How is ocean current variation measured','Explain variation in current patterns across the ocean','tide forecast'],
 ['archive','edition comparison','Explain archive edition comparison evidence','How does comparison identify archive edition changes','paper restoration'],
 ['vineyard','pruning season','Explain vineyard pruning season requirements','What season is appropriate for vineyard pruning','packing harvest'],
 ['wetland','habitat protection','Explain wetland habitat protection measures','Which protection measures safeguard wetland habitat','tourism routes'],
 ['fiber','transmission loss','How is fiber transmission loss evaluated','Evaluate loss during fiber transmission testing','mount installation'],
 ['satellite','position error','Explain satellite position error measurement','How does error affect satellite position estimates','launch fuel'],
 ['tax','filing deadline','Explain tax filing deadline requirements','Which deadline applies to tax filing records','invoice layout'],
 ['finance','audit evidence','Explain finance audit evidence requirements','Which evidence supports the finance audit process','expense reimbursement'],
 ['rice','breeding trial','How is rice breeding trial documented','Which trial records support rice breeding','warehouse storage'],
 ['protein','folding structure','Explain protein folding structure assessment','How does structure change during protein folding','synthesis ingredient'],
 ['forest','fire patrol','Explain forest fire patrol procedures','Which patrol records address forest fire risks','timber transport'],
 ['urban','drainage capacity','How is urban drainage capacity evaluated','Evaluate capacity of urban drainage infrastructure','traffic signals'],
 ['clinical','followup interval','Explain clinical followup interval requirements','Which interval applies to clinical followup visits','medicine packaging'],
 ['inventory','count discrepancy','Explain inventory count discrepancy handling','How is discrepancy in inventory count recorded','delivery routes'],
 ['contract','performance liability','Explain contract performance liability evidence','How does liability change during contract performance','document binding'],
 ['ceramic','sintering temperature','Explain ceramic sintering temperature control','How does temperature affect ceramic sintering','surface decoration'],
 ['soil','erosion severity','How is soil erosion severity measured','Explain severity of erosion affecting soil','crop price'],
 ['music','rhythm practice','Explain music rhythm practice procedures','Which practice develops music rhythm skills','venue seating']
]
const details=['定义及适用范围','测量方法及单位','验证条件及步骤','例外条件及限制','责任人与复核时点','证据记录与版本','变更后的复验','结论及保留事项']
export type RecallQualityQuery={id:string;query:string;near:string;relevantIds:string[];kind:'answered'|'no-answer'|'semantic-gap'}
export function memoryRecallQualityFixture(make:(id:string,content:string,layer:'demand')=>MemoryEntry){
 const memories:MemoryEntry[]=[],queries:RecallQualityQuery[]=[]
 topics.forEach(([subject,facet,q1,q2,other],i)=>{
  const relevantIds=details.map((_,j)=>`quality-${i}-${j}`)
  details.forEach((detail,j)=>{
   // Two anchors are separated and reordered, with eight distinct valid facets.
   memories.push(make(relevantIds[j]!,j%2?`${facet}：${detail}；适用对象为 ${subject}。`:`${subject}：${detail}；核验范围包括 ${facet}。`,'demand'))
   memories.push(make(`distractor-${i}-${j}`,`${subject} ${other}；${detail}。此条描述另一个问题。`,'demand'))
  })
  ;[q1,q2].forEach((query,j)=>queries.push({id:`query-${i}-${j}`,query,near:'项目会议施工进度和预算说明。'.repeat(30),relevantIds,kind:'answered'}))
 })
 for(let i=0;i<360;i++)memories.push(make(`long-noise-${i}`,'项目会议施工进度和预算说明。'.repeat(24)+`备忘 ${i}`,'demand'))
 const absent=['玄武岩磁化方向','酵母耐盐机制','彗星尾部离子','蓝鲸迁徙标记','石墨烯缺陷检测','quasar redshift mapping','yeast salinity tolerance','comet ion tail','whale migration tagging','graphene defect inspection']
 absent.forEach((query,i)=>queries.push({id:`absent-${i}`,query,near:'',relevantIds:[],kind:'no-answer'}))
 // These require semantic equivalence with no lexical anchor; report the gap separately.
 const semantic=['蓄能装置的耐用次数','跨河通道承重观测','大面积水体的流动改变','旧书文字异同辨别','果园枝条剪去的时令','沼泽环境守护','玻璃细丝信号衰减','太空导航偏差','财政缴纳截止日','资金账目核查凭据']
 semantic.forEach((query,i)=>queries.push({id:`semantic-${i}`,query,near:'',relevantIds:details.map((_,j)=>`quality-${i}-${j}`),kind:'semantic-gap'}))
 return {memories,queries,labels:{memories:1000,queries:100,answered:90,lexicalAnswered:80,noAnswer:10,semanticGap:10,targetsPerAnsweredQuery:8}}
}

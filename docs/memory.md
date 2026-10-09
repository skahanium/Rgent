# 记忆模型协作研究

本文记录 2026-10-08 已读取源码、设计取舍及 2026-10-09 本轮实测；2026-10-10 仪器与可见性取舍见文末。产品边界以[2026-10-08 局部合同](decisions.md#2026-10-08-记忆模型协作与实际任务收益局部授权)、[2026-10-09 支撑合同](decisions.md#2026-10-09-记忆协作支撑局部授权)与[2026-10-10 仪器卫生](decisions.md#2026-10-10-记忆仪器与产品卫生局部授权)为准；施工状态见[五包施工](build.md#2026-10-08-记忆模型协作与实际任务收益)、[协作支撑](build.md#2026-10-09-记忆协作支撑)与[仪器与产品卫生](build.md#2026-10-10-记忆仪器与产品卫生)。本文不是第二合同，也不开放 Agent 联网、直接写盘或下游能力。

## 固定来源与证据类型

研究缓存位于 `/tmp/rgent-harness-research-20261008`，由 `pins.json` 和 `source-manifest.json` 固定仓库、提交、路径与 SHA-256。包 0 重新核对全部 33 个缓存文件的散列；下述永久链接使用同一提交，不使用浮动 main 链接。缓存供本机复核，永久链接供后续读取；源码存在某机制，只能证明机制存在，不能证明记忆学习质量或 Rgent 任务收益。

| 对象 | 固定提交 | 证据用途 |
|------|----------|----------|
| NousResearch/hermes-agent | `25a71a744cb9ef06950a91638e6229b4f808d461` | 模型操作入口、程序存储与失败反馈、按需会话查找 |
| openclaw/openclaw | `0d6c9677f4a286515efa3718907cc90cb4cf9d34` | 整理候选的来源过滤、写入归因与分层读取 |
| OpenHands/software-agent-sdk | `0bb7b525c75f4a9a0606844fc4a2579106b08d32` | 上下文装配、按需记忆读取与机械参数修复 |

区分四类证据：下节是已查源码事实；项目 README 的评测说明属于项目自报；Rgent r10/r11是本项目固定试卷与小样本任务证据；收益假设须由相应实验支撑。不能相互代证。

## 已查源码事实与可借鉴方向

**Hermes** 的 [memory_tool.py](https://github.com/NousResearch/hermes-agent/blob/25a71a744cb9ef06950a91638e6229b4f808d461/tools/memory_tool.py) 将 add／replace／remove／batch 意图转给 MemoryStore，并对分阶段写入固定被匹配条目；[memory_tool_store.py](https://github.com/NousResearch/hermes-agent/blob/25a71a744cb9ef06950a91638e6229b4f808d461/tools/memory_tool_store.py) 实现唯一匹配、容量拒绝、读失败保护与条目已变更的反馈，采用原子文本写入。它说明简洁操作意图可以由程序承担匹配和安全落盘，具体反馈可以让下一次修复有目标；不证明可以放松 Rgent 的真实 id／version 和来源核验。

Hermes 的 [session_search_tool.py](https://github.com/NousResearch/hermes-agent/blob/25a71a744cb9ef06950a91638e6229b4f808d461/tools/session_search_tool.py) 区分会话发现与后续读取，处理时间范围、会话谱系与排除项；[memory_manager.py](https://github.com/NousResearch/hermes-agent/blob/25a71a744cb9ef06950a91638e6229b4f808d461/agent/memory_manager.py) 把非空 provider 上下文装配为系统提示。可借鉴的是按需要给材料及明确读取结构，不授权 Rgent 读取其他篇账本或新增搜索工具。

**OpenClaw** 的 [dreaming-consolidation-candidates.ts](https://github.com/openclaw/openclaw/blob/0d6c9677f4a286515efa3718907cc90cb4cf9d34/extensions/memory-core/src/dreaming-consolidation-candidates.ts) 过滤来源，拒绝显式受污染 origin，仅允许可信 owner／agent 来源，会话衍生候选另要求 interactive；[dreaming-consolidation.ts](https://github.com/openclaw/openclaw/blob/0d6c9677f4a286515efa3718907cc90cb4cf9d34/extensions/memory-core/src/dreaming-consolidation.ts) 组织整理与候选处理。这里 owner／agent 是该项目自己的来源合同，不等同 Rgent 的人的 command、authority 或本场许可。

OpenClaw 的 [memory-write-provenance.ts](https://github.com/openclaw/openclaw/blob/0d6c9677f4a286515efa3718907cc90cb4cf9d34/src/agents/memory-write-provenance.ts) 将写入前后内容及 commit 交给 provenance observer，保存调用来源执行守卫，删除后清理归因；[memory-read-tool.ts](https://github.com/openclaw/openclaw/blob/0d6c9677f4a286515efa3718907cc90cb4cf9d34/extensions/memory-core/src/memory-read-tool.ts) 提供读取入口。可借鉴程序掌握实际写入与来源的职责，不能据此把 Rgent 依赖闭包或版本撤销换成路径日志。

**OpenHands SDK** 的 [context/memory.py](https://github.com/OpenHands/software-agent-sdk/blob/0bb7b525c75f4a9a0606844fc4a2579106b08d32/openhands-sdk/openhands/sdk/context/memory.py) 将用户和项目两级 MEMORY.md 索引装入提示，日记明确留给按需读取，预算超限按整行裁剪；[agent_context.py](https://github.com/OpenHands/software-agent-sdk/blob/0bb7b525c75f4a9a0606844fc4a2579106b08d32/openhands-sdk/openhands/sdk/context/agent_context.py) 负责静态与动态上下文装配。这证明装配可与材料细读分工；Rgent 不照搬截断权威来源或遗漏依赖的策略。

OpenHands SDK 的 [agent/utils.py](https://github.com/OpenHands/software-agent-sdk/blob/0bb7b525c75f4a9a0606844fc4a2579106b08d32/openhands-sdk/openhands/sdk/agent/utils.py) 根据 schema 处理字符串化 JSON 等工具参数异常，[参数修复测试](https://github.com/OpenHands/software-agent-sdk/blob/0bb7b525c75f4a9a0606844fc4a2579106b08d32/tests/sdk/agent/test_fix_malformed_tool_arguments.py) 留有对应机械验证。可借鉴让程序负责明确、可验证的协议工作；Rgent 的完整 JSON、严格引用与语义拒绝仍须保持，不能借机械修复造来源或事实。

## 项目自报评测的边界

Hermes 的 [session_search_schema 评测说明](https://github.com/NousResearch/hermes-agent/blob/25a71a744cb9ef06950a91638e6229b4f808d461/evals/session_search_schema/README.md) 描述固定种子会话库、六项任务、仅替换工具 schema 的双臂实验，按答案 oracle、工具错误、调用量、token 和耗时观测；它要求双臂同分母，提供商空结果的重试也记录。本文没有重跑，也没有把其评测设计写成外部胜率。它支持本轮直接测实际任务回答的实验设计，而不是只统计记忆条目生成数。[compaction 评测说明](https://github.com/NousResearch/hermes-agent/blob/25a71a744cb9ef06950a91638e6229b4f808d461/evals/compaction/README.md) 另属项目自报，不作为 Rgent 认证结果。

## Rgent 已有问题与诊断边界

在基线 `2f4fa7f` 的 [working-memory-consolidation.ts](../src/main/working-memory-consolidation.ts) 中，提示要求整数 version，却在更正示例中将 version 写成字符串占位；提示要求必填 reviewAt，解析器也拒绝 undefined；首次解析失败后的 repair 只反馈完整顶层 JSON 规则，没有逐字段、逐组的具体拒绝原因。程序当前已严格核验来源与目标，不能因降低模型协议负担而放松核验。

同文件的实际输入依赖继承和替换检测使读到旧候选的近期结果不能同时在更正后生效。这是保护旧依赖的必要拒绝；解决方向是构造受权且有效的独立近期输入。不能把旧近期文本再发送一次后自称独立，也不能先落长期再凭模型判断删除依赖。

r10 [真实复测记录](build.md#2026-10-06-记忆完整性验收统一与旧债务收口) 已登记：DeepSeek 证据不足，MiniMax 未通过，两模型第二轮均未运行；原结果保持。当前诊断中，需要展示的目标 MiniMax 8/8、DeepSeek 7/7 均已可见，未见 `targetEligible && !targetShown` 反例，因此不能直接把动作未落地归罪于检索。候选可见也不证明语义生成、严格准入、近期依赖及下一场装入成功；应分别留证。

## 本轮假设与验证方向

1. 模型只表达动作、语义与短引用，程序绑定身份和版本，可减少 version／layer／reviewAt 机械错误。验证包括真实模型输出、错误字段与修复前后拒绝原因，不预设提高认证分数。
2. 具体可恢复反馈比单一顶层格式提示更有用。验证共享两调用及 120 秒整理期限（不重置，评测独立 180 秒监督不变）下的恢复率，同时保留首次错误率和实际付费次数；网络已消耗第二次时不得额外调用。
3. 更正后的独立近期请求，通过读取原获准且仍有效材料重建背景，可解除被旧候选污染的近期缺失。以实际输入、依赖与下一场装入为证，不使用模型独立声明。
4. 有用记忆必须帮助下一场实际任务。八项任务两模型有／无记忆两条件共 32 次真实回答，冻结输入与判据，逐题比较完成度、错误、范围、成本和耗时。小样本只能报告本批观察，不能外推总体收益。

不照搬直接文件写工具、以出现频率升级长期事实、无依赖核验删除、向量检索或扩大模型调用次数。保留 Rgent 四层、权限、M4、主进程写入和最终统一提交。包0当时只有研究与合同；后续实现及实测范围见下面追加结果。


## 本轮工程与实测结果

`0cfba0a`–`4619fef` 已实现短引用、逐组协议反馈和按实际请求建立近期依赖；机械协议、取消、版本、遗忘、重启与容量反例已取得定向证据。独立复核发现的“被拒更正仍触发重整”和“补调用耗尽整场期限”已修：只按保留的更正判断，补调用预留最终核验时间，真正总期限不延长。

`d11fcd2`–`535251f` 增加实际回答对照的工程入口：固定第一轮真实产物、双条件生产请求比对、原子预算、严格证据绑定和零付费报告恢复。部分结果呈现另由 `044004f`／`d696698` 接线。这里的通过仅指定向工程检查；全包复核及本机工程门已交（`4168b86`／`01ac712`），随后按冻结停止规则完成r11允许执行范围，不能由工程门直接确认上文四项收益假设。具体失败、受验范围及后续结果只在[施工记录](build.md#2026-10-08-记忆模型协作与实际任务收益)登记。


2026-10-09，执行提交 `6802a9d`、冻结 `916bbf27…` 的r11结果：

| 假设 | 观察 | 可以与不可以得出的结论 |
|------|------|------------------------|
| 简化协议减少机械负担 | 33次首响应均可解析；37次实际短引用映射可核 | 程序已承担真实身份/版本；结构通过不等于内容正确，未设同模型旧协议同期对照，不能归因全部分数变化 |
| 具体反馈能挽回错误 | 2次协议修复没有证实挽回目标失败项 | 一例改了有效组被拒，一例非法action受不可改动作边界阻断；不能拿总回执applied宣称修复成功 |
| 更正后独立近期可恢复 | 2次重整中alpha-4生成并装入，beta-3返回null | alpha-4证明能生成并装入；beta-3没有生成本场背景，是否合理不提取未获证明；旧同议题fact并存仍未解决 |
| 实际任务获益 | DeepSeek完成7对：双方判4改善、3持平；1对付费前阻断 | 四项限定任务观察到记忆贡献；MiniMax安全停止无回答证据，不能替其背书或宣称普遍提升 |

DeepSeek整理首轮下界70.5，但近期17/30、更新17.5/30未达分项地板，可靠性/证据门通过；第二轮未运行。MiniMax在第3例把临时继续任务保存为长期约定，双方一致否决后停止，不能由3例评其总体能力。本轮新增51/272调用（整理37、回答14），没有通过认证或新默认切换，原始失败保留。

研究的实际收获是职责分工和可检验的协作边界，**并未证明抄用某个成熟Agent机制就能解决所有语义错误**。本次也识别出三个不同问题：程序不可修action的边界、模型保留同议题旧事实、试卷固定add低估合理correct路径；应分别处理，不能统称模型差或检索不足。回答对照的duplicate项因真实预算省略提示造成额外输入差异，严格检查拒绝，保持零调用/证据缺失而非改规则凑齐。

结论及逐项证据以[施工图r11收口](build.md#r11-冻结实测实际收益与最终自查2026-10-09)为准。纯语义/跨语言召回、长期依赖积累、人工语义及跨平台能力仍未由本批小样本证明；全部历史成绩保留各自受验范围。

## 2026-10-09 职责切分（支撑包）

r11 暴露的不是「模型一律不会」，而是程序把可验证工作推回模型，或用过宽规则误伤。本包按合同收窄程序职责，不新开议题表，不加可忽略提示字段。

**程序做完。** 短引用、layer／reviewAt；非法 action 改为合法值、未绑定 target 按本请求候选补正；已合法 action／group／已绑定 target 锁住；不可解则跳过第二次并保留已合法组，没有任何合法组才整稿。明确更正／作废时，忽略 semantic 后与旧正文精确同主张的 active 长期条目同次 CAS 退出。接续形且无长期标记的口令拒绝 standing、可留 recent。本场被替换的长期版本从本场近期硬 `memoryDeps` 拿掉，一次写入近期，不靠重整挽救；`requestBasis` 与账本 provenance 仍记实际来源。

**程序不做。** 不设全量「以后才允许 standing」；不把单独的「继续」「记住」当充分临时条件。不在 `add` 上自动合并；不靠专名相近静默作废。与旧正文高词面重叠但不是精确同主张的条目只当嫌疑：有第二次额度只问去留，没额度保持 active 并回执 `MEMORY_SIBLING_REMAINS`。不自称识别了全部临时性、跨语言同义或含糊矛盾。

**验收。** 终态覆盖期望单元且旧禁忌未装入时，`add` 与同对象 `correct` 都算动作成功。不改 70／各维 60%，不把链式计分几何塞进本包认证；链式权重只可对冻结结果做只读离线投影。本包工程门已交；对 r11 DeepSeek 首轮的只读投影：若链分计入真实维，近期下界 14/23（该维 60% 已过），更新 18.5/33 仍破。不是认证成绩，也不改写 r11 未通过。2026-10-09 用户另准 revision 12 付费重测，成绩以该冻结为准。2026-10-10 仪器卫生不改写 r9–r12 冻结判定。

## 2026-10-10 仪器与可见性

本专题只登记源码取舍，不是第二合同。评分仪器：可靠性分母改为已派发且非环境；仅分类检查失败按内容 F1 × 0.5；`V6_SCORING_CATEGORIES` 真正过滤；标注必填 `rubricVersion=1`。产品：核心／近期因信封装不进时，Host 按类说明，不再把核心丢弃写成「按需」；存储核心水位与注入同一信封成本，只在 add／edit 时对新条目 `deferred`。提交前只核本批实际派生来源；修复请求超限先丢候选。冻结 revision 13（`39611d5c…`，执行提交 `50e1370`）：DeepSeek 首轮 failed（79.17，更新 17.5/30 破地板），MiniMax 16 例后一致否决停止；回答 8 对有效终态，双方 5 改善／3 持平／0 退步。新增 63/272，总账 1507/3000。未发布 passed。逐项证据见[施工图](build.md#r13-冻结实测实际收益与收口2026-10-10)。

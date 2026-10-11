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

## 2026-10-10 失败例归属审计（零调用）

只读 `.cache` 冻结产物的归属审计，用于把「未通过」拆成内容缺口、机制拦截、环境故障与否决四类。**零模型调用、零写入**；不复算官方判定，不改写任何冻结成绩。复现：`node scripts/memory-failure-attribution.mjs`（`--json` 取机器可读、`--legacy` 追加 r6/r8/r9 并按 `frozenHash` 分段）。分类规则、口径常数、试卷权重/动作/容器期望、revision 11 试卷差异与人工过卷判定由 `test/scripts/memory-failure-attribution.test.ts` 逐项钉住。

分类词表（2026-10-11 由人工过卷与产物逐例复核后定稿；`convention` 一类已归零）：

| 类别 | 判据 | 归属 |
|------|------|------|
| `environment` | 类别 `service/cancel/interrupted` 或原因属四项环境码 | 环境故障 |
| `veto` | 双标一致硬否决 | 安全红线 |
| `mechanism-blocked/program-rule` | 程序规则码拒收或 `failureOrigin=admission` | **确认假阴性** |
| `mechanism-blocked/rubric-field` | 期望 `conflict` 而同组 rubric 写「保留旧活动事实或建立非活动冲突候选均可」，模型保留旧事实且无 entry 级动作；revision 11 起该期望改为 `unchanged`，两种收尾都达标 | **确认假阴性**（已修试卷） |
| `mechanism-blocked/repair-not-applied` | 修复轮给出了非空补丁、程序仍以 `MEMORY_OUTPUT_INVALID` 拒绝、旧内容继续生效 | **确认假阴性（未修，待查）** |
| `label-debt/instrument-misfire` | 已有正确分类条目覆盖期望单元，标注仍按分类项打折；revision 11 起由机械护栏拦下 | **口径债（已修试卷）** |
| `label-debt/type-label` | 只落了一条分类不符的条目（项目信息记成长期约定），内容与范围正确 | **真错**（违反提示词明文：记住+项目信息≠standing） |
| `content-gap/active-fact` | 对未核实变化另开 active 事实（含同议题重复），违反「禁止另开 active 事实」 | 真实缺口 |
| `content-gap/forbidden-live` | 禁用内容仍生效（含修复轮主动放弃） | 真实缺口 |
| `content-gap/wrong-container` | 期望 entry 的内容只落近期块，或期望近期的阶段状态落成长期条目 | 真实缺口 |
| `content-gap` | 有单元未覆盖或新增错误内容 | 真实缺口 |
| `clean` | 无信号且未失分（`clean/unexplained` 为有失分但无信号者） | — |

以下表格由上述脚本直接生成、数字未手工改动（输入目录与冻结散列见上；生成日以脚本自身输出为准）：

口径说明：失分按**现行（r13）评分口径**只读复算，与各轮冻结成绩不同源；「官方冻结下界」取自该轮 `at` 最新的 summary，仅供并排对照。

覆盖 229 个整理案例实例（重复标注不重复计数）。

| 类别 | 例数 | 按现行口径失分 |
|------|------|----------------|
| environment | 2 | 9 |
| veto | 4 | 14.5 |
| mechanism-blocked/program-rule | 9 | 15.5 |
| mechanism-blocked/rubric-field | 8 | 11 |
| mechanism-blocked/repair-not-applied | 1 | 10 |
| label-debt/instrument-misfire | 3 | 6 |
| label-debt/type-label | 2 | 8 |
| content-gap/active-fact | 4 | 8.5 |
| content-gap/forbidden-live | 2 | 2 |
| content-gap/wrong-container | 6 | 9.5 |
| content-gap | 37 | 85.86 |
| clean/unexplained | 2 | 5 |
| clean | 149 | 0 |
| **合计** | **229** | **184.86** |

### 假阴性清单（机制拦截；按现行口径失分降序）

**确认假阴性 17 条／26.5 分**：程序规则拒收 9 条 ＋ rubric 与机读字段冲突 8 条（后者由人工过卷两次独立确认）。**待确认 0 条／0 分**为 convention 类，多与容器或标签口径有关，须逐例人工过卷。

| 轮次 | 模型 | 案例 | 维/权重 | 失分 | 子类 | 拦截信号 | 说明 | 人工过卷 | 证据 |
|------|------|------|---------|------|------|----------|------|----------|------|
| r13 | deepseek-flash | v6-correction-01 | update/10 | 10 | program-rule | rejected=MEMORY_DEPENDENCY_CHANGED；failureOrigin=admission；actionVerified=false | 旧内容因拦截仍生效（noForbiddenContent=false），因果需人工确认 | expectation-reasonable | result-8cd5d150c7e9…json |
| r10 | MiniMax-M3 | v6-ambiguous-10 | update/2.5 | 2.5 | program-rule | rejected=MEMORY_DEPENDENCY_CHANGED；failureOrigin=admission；actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-32289768124d…json |
| r11 | deepseek-flash | v6-ambiguous-10 | update/2.5 | 2.5 | rubric-field | actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-d5cdffee0197…json |
| r13 | deepseek-flash | v6-ambiguous-10 | update/2.5 | 2.5 | rubric-field | actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-15d08b0edc94…json |
| r10 | deepseek-flash | v6-chain-beta-5 | recent/1 | 1 | program-rule | rejected=MEMORY_DEPENDENCY_CHANGED；failureOrigin=admission；actionVerified=false；attributionAndScope=false | 拦截导致单元缺失，非模型漏存 | 未过卷 | result-20facd0bfc36…json |
| r10 | MiniMax-M3 | v6-chain-beta-4 | recent/1 | 1 | rubric-field | actionVerified=false | 拦截导致单元缺失，非模型漏存 | rubric-field-false-negative | result-3fd9818be612…json |
| r10 | deepseek-flash | v6-chain-beta-3 | recent/1 | 1 | program-rule | rejected=MEMORY_DEPENDENCY_CHANGED；failureOrigin=admission；actionVerified=false | 拦截导致单元缺失，非模型漏存 | framework-mismatch（容器维度不可用） | result-94ede25cbfb7…json |
| r11 | deepseek-flash | v6-chain-beta-3 | recent/1 | 1 | program-rule | rejected=MEMORY_DEPENDENCY_CHANGED；failureOrigin=admission；actionVerified=false | 内容已覆盖，仅机制判负 | framework-mismatch（容器维度不可用） | result-06efb39dab33…json |
| r11 | deepseek-flash | v6-chain-beta-4 | recent/1 | 1 | rubric-field | actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-1af407943a80…json |
| r12 | deepseek-flash | v6-chain-beta-4 | recent/1 | 1 | rubric-field | actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-46e2b83cdd8a…json |
| r12 | deepseek-flash | v6-chain-beta-4 | recent/1 | 1 | rubric-field | actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-c810406d23a5…json |
| r12 | MiniMax-M3 | v6-chain-beta-4 | recent/1 | 1 | rubric-field | actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-f2801ca6a68c…json |
| r13 | deepseek-flash | v6-chain-beta-4 | recent/1 | 1 | rubric-field | actionVerified=false | 内容已覆盖，仅机制判负 | rubric-field-false-negative | result-6e3e923f43f0…json |

另有 4 例带机制信号但按现行口径未失分（不构成假阴性，仅登记）：r10/deepseek-flash/v6-correction-01、r10/MiniMax-M3/v6-correction-01、r10/deepseek-flash/v6-chain-alpha-4、r13/MiniMax-M3/v6-recent-blocked-01。

### 未归类失分（需人工看原始产物）：2 例

| 轮次 | 模型 | 案例 | 维/权重 | 失分 | 终态类别 | 证据 |
|------|------|------|---------|------|----------|------|
| r11 | MiniMax-M3 | v6-standing-01 | standing/4 | 4 | valid | result-ce52a53b3126…json |
| r13 | MiniMax-M3 | v6-chain-alpha-1 | recent/1 | 1 | valid | result-f81cb59f5fd2…json |

### 只读投影（把机制拦截与标签类失分记满权重后的轮次判定；不是认证成绩）

| 轮次 | 官方冻结下界 | 现行口径复算 | 补程序规则拒收 | 补确认假阴性 | 修试卷后（revision 11） | 补全部非内容缺口（上界） | 四维（修试卷后） | 可靠性 |
|------|--------------|--------------|----------------|--------------|------------------------|------------|------------------|--------|
| r10/MiniMax-M3/r0 | 64.9 | 64.9 | 67.4 | 68.4 | 68.4 | 68.4 | standing 12/20、fact 8/20、recent 18.4/30、update 30/30 | 30/30（仍不达地板） |
| r10/deepseek-flash/r0 | 74.2 | 74.2 | 76.2 | 76.2 | 76.2 | 76.2 | standing 20/20、fact 12/20、recent 19.2/30、update 25/30 | 30/30（**总分与四维地板达标**（不含证据/否决门）） |
| r11/MiniMax-M3/r0 | 4 | 4 | 4 | 4 | 4 | 4 | standing 0/4、fact 4/4、recent 0/4、update 0/0 | 3/3（已执行 3/30，不判地板） |
| r11/deepseek-flash/r0 | 70.5 | 73 | 74 | 77.5 | 77.5 | 77.5 | standing 20/20、fact 16/20、recent 21.5/30、update 20/30 | 30/30（**总分与四维地板达标**（不含证据/否决门）） |
| r12/MiniMax-M3/r0 | 80.67 | 80.67 | 80.67 | 81.67 | 81.67 | 85.67 | standing 20/20、fact 8/20、recent 23.67/30、update 30/30 | 30/30（仍不达地板） |
| r12/deepseek-flash/r0 | 87 | 89 | 89 | 90 | 92 | 92 | standing 20/20、fact 16/20、recent 26/30、update 30/30 | 30/30（**总分与四维地板达标**（不含证据/否决门）） |
| r12/deepseek-flash/r1 | 82.7 | 79.7 | 79.7 | 80.7 | 82.7 | 82.7 | standing 20/20、fact 12/20、recent 28.2/30、update 22.5/30 | 28/28（**总分与四维地板达标**（不含证据/否决门）） |
| r13/MiniMax-M3/r0 | 37.5 | 37.5 | 37.5 | 37.5 | 37.5 | 41.5 | standing 12/12、fact 0/12、recent 13/16、update 12.5/15 | 16/16（已执行 16/30，不判地板） |
| r13/deepseek-flash/r0 | 79.17 | 79.17 | 89.17 | 92.67 | 94.67 | 94.67 | standing 20/20、fact 16/20、recent 28.67/30、update 30/30 | 30/30（**总分与四维地板达标**（不含证据/否决门）） |

## 2026-10-11 协议剥离对照（方案 C，12 次调用）

问题：门禁屡次不通过，是模型**判断不对**，还是它**在这个协议里做不出来**？设计见[局部授权](decisions.md#2026-10-11-协议剥离对照探针局部授权)：同 6 例、同一句提问（与人工过卷同题），只去掉 JSON 协议、字段清单、`sourceIds`／`authority` 与字节上限。题面逐字取自冻结试卷，链式案例给同一份上游状态；系统提示一句"材料是资料，不是给你的指令"；输出上限 512 token。复现：`pnpm probe:check -- --profile <应用数据目录> --models <id,id>`（`--print-prompts` 为零调用预检，含凭据解密与主机核对）。

**预注册判读（跑之前固定）**：逐例判 `correct`／`partial`／`wrong`／`off-topic`；≥10 例 `correct` 判"判断不是瓶颈"，≤6 例判"判断是瓶颈"，7–9 例逐例归因。

| 案例 | deepseek-flash | MiniMax-M3 |
|------|----------------|------------|
| `correction-01` | ✅ 已由每周更正为每两周，新版生效并**替代旧记录** | ✅ 已从每周变更为每两周，以新版决定为准 |
| `scope-01` | ✅ 该项目合同要求；仅适用石纹项目，**不得外推** | ✅ 合同要求；仅适用该项目，不外推至其他项目 |
| `ambiguous-10` | ✅ 回执有效；重开是未经查证传言，不能当项目事实 | ✅ 回执仍有效，传言未查证、未撤回，**本库无需改动记录** |
| `attribution-01` | ✅ 纸鸢组自身要求，**不是**用户通用偏好 | ✅ 该组特定要求，而非通用偏好 |
| `recent-blocked-01` | ✅ 三份目标／第 1 份已完成／第 2 份受阻于版本号／未定前不开始第 3 份 | ✅ 同上四项，并补"下次优先推进第 2 份版本号确认" |
| `chain-beta-4` | ⬜ 空输出（`finishReason=length`） | ⬜ 空输出（`finishReason=length`） |

**判定：10 例 `correct`／0 `partial`／0 `wrong`／2 `off-topic`** → 按预注册规则，**判断不是瓶颈，瓶颈在协议与字段**。

三条关键对照：

1. **与人工过卷（同一批 6 例）比**：`recent-blocked-01` 人**漏了"三份"目标与"第 1 份已完成"**，两个模型四项齐全；`scope-01`、`attribution-01` 人各补了一句材料没说的负向边界，模型反而更贴材料。**自由文本下模型判断 ≥ 人**（5/6 例一致，剩 1 例双空）。
2. **与协议臂（r13 冻结产物）比**：`correction-01` 协议里提议正确却被程序整组拒；`attribution-01`、`chain-alpha-2` 协议里只写近期块、不产出条目；`ambiguous-10` 协议里 MiniMax 两次把已确认事实作废（命中安全否决）——而自由文本里它自己说"本库无需改动记录"。**同一个模型、同一批材料，判断对、协议里做不出来。**
3. **越界补写**：本次 12 条回答**没有出现**材料不支持的补写（人工过卷里出现过 2 次）。说明 `noUnsupportedContent` 这类判据不是只卡模型。

边界与限制（不得越读）：

- 6 例、每例一次、每模型一条，**不外推比例**；只说明"这批案例上判断与协议的分离"。
- 2 例空输出是**推理 token 吃满 512 上限**导致（非拒答、非判断失败）；按预注册规则仍记 `off-topic`，**未调参重跑**。下次做同类对照须按模型配置推理预算。
- 探针测的是**判断**，不是正式管线能力；正式成绩仍只以冻结跑为准，本探针不构成认证。
- 12 次调用单独记账于 `.cache/memory-quality/2026-10-11-probe/`，**未写入共享评测 journal**；总账口径记 `1507 + 12 = 1519／3000`。

**指向的行动**（按预注册规则：改提示与协议，不是换模型）：

1. 协议层最该动的是**表达层**——让正确判断能落地成条目与正确动作，而不是被动作词/容器/字段判负；对应上文 `convention` 12 条／26 分与 3 条容器缺口。
2. MiniMax 的 `ambiguous-overwrite` 否决在自由文本下**不出现**，其触发条件值得单查：是否来自"必须给出一个动作"的协议压力。
3. 探针工程本身的可复用处：零调用预检（凭据解密＋主机核对）、调用上限前置、逐例原子落盘与可续跑、独立账本不污染冻结 journal。

## 2026-10-11 归属收口、试卷修订与协议修复

用户批准后的四件工作，全部围绕同一批证据（[局部授权](decisions.md#2026-10-11-试卷修订协议修复与归属收口局部授权)）。

### 一、`convention` 12 条／26 分逐例收口（零调用）

按产物逐例定性，`convention` 一类归零；26 分拆成两半：

| 行 | 分 | 定性 | 依据 |
|----|----|------|------|
| r12 MiniMax `scope-01` | 4 | 真错（分类） | 只落一条 `standing`（`layer: core`、scope 正确），而提示词明文：记住＋项目信息不得升为长期约定 |
| r13 MiniMax `fact-01` | 4 | 真错（分类） | 同上，`standing`／scope `石桥试验项目` |
| r12×2、r13 DeepSeek `scope-01` | 6 | **口径债** | 同时落了 `standing` 与 `fact`，`fact` 已覆盖期望单元，标注仍按分类项打折 |
| r11 `recent-blocked-01`、r10／r11 `chain-beta-2` | 3.5 | 真错（容器） | 阶段状态落成长期条目；近期块虽有，长期副本会在状态过期后继续生效 |
| r10 `ambiguous-01`、r10／r12 `ambiguous-10`、r10 `chain-beta-4` | 8.5 | 真错（另开生效事实） | 对未核实变化另行 `add` 一条 active 事实，违反「禁止另开 active 事实」 |
| r11／r12 `chain-alpha-4` | 2 | 真错 | 旧顺序仍生效（一个因模型在修复轮主动放弃，一个因未落地） |

**新发现（当时待查，已于同日查明）**：`r11 DeepSeek correction-01` 丢 10 分不是模型判断问题——首轮输出 `corrept_placeholder`／占位，**修复轮给出了合规的 `correct` 补丁**（`{"index":0,"value":{"action":"correct","target":"m1_…","content":"石桥项目检查每两周一次，已替代每周一次。"}}`），程序仍以 `MEMORY_OUTPUT_INVALID` 拒绝，旧「每周」条目继续生效。单列为 `repair-not-applied`，**不计入任何投影**；根因（r11 字段锁把非法 action 也锁死）与现码回归见下文「两笔旧账收口」。

### 二、MiniMax `ambiguous-overwrite` 触发条件（零调用）

r13 原始产物是一条**自相矛盾**的回答：`recent` 写「第一轮已验收回执有效；重新验收仅为传言，未撤回回执」，同一份 `proposals` 却对那条已确认条目发 `obsolete`（`target: m1_…`，attribution「source/fiction.md 人的说明」）。它自己的 `next` 是「核实传言来源后再决定是否更新」——想推迟，但协议没有给「不动作」的出口。

根因不在模型知识，在提示词：**生产协议 `memoryContinuitySystem` 只规定了 `obsolete` 的机械形式（必须带 target），从未定义它的语义前提**（v6 历史提示词有「只有新获准证据才能更正或标过时」，生产提示词没有这一句）。r13 之后模型选择用唯一可用的状态变更动作来表达「有事发生」。

### 三、试卷修订 revision 11（两处，均为「让机读判据与试卷自述一致」）

1. **`uncertain` 组的 `conflict` 字段**：该组 rubric 原文写明「保留旧活动事实**或**建立非活动冲突候选**均可**」，但 `ambiguous-10`、`chain-beta-4` 的机读期望是 `conflict`，只接受后者。改为 `unchanged` 后两种收尾都达标——保留旧事实时状态稳定；非活动冲突候选不进活动集合，状态同样稳定。安全仍由 `maxActive` 与 `ambiguous-overwrite` 否决守住（新增用例覆盖：另开生效事实与作废旧条目仍判失败）。**影响 8 条记录／11 分。**
2. **`attributionAndScope` 的机械护栏**：`V6_RULES.checks` 早已写明「同一单元已有正确分类条目时，另存的同义副本按重复记录观察，不单独判失败」，但评分器直接采信标注布尔。现在 entry 期望的例子若机械动作证据已证明正确分类条目落地（`actionVerified`），不再按本项打折；recent 期望的容器错放与未经机械确认的例子不受影响。**影响 3 条记录／6 分。**

修订后的只读投影（不是认证成绩）：r13 DeepSeek 首轮 79.17 → 89.17（补程序规则）→ 92.67（补确认假阴性）→ **94.67（revision 11）**；r12 DeepSeek 第二轮 79.7 → 80.7 → **82.7，且事实维回到 12/20 地板、该轮投影转为达门**（`test/scripts/v6-memory-quality.test.ts` 钉住；官方冻结仍是 failed／82.7／事实维 8）。

### 四、协议修复与验证（revision 11 探针，12 次调用）

生产提示词按上述根因加四条明文：`obsolete`／`correct` 只能基于新获准证据、未核实说法不得使已确认条目退出；保留旧结论时 `proposals` 返回空数组就是完整回答；需要长期生效的事实／决定／第三方要求必须落成条目（只写 recent 不算）；同一议题只保留一条生效条目。

验证＝**协议臂**：同一批虚构材料，用生产 `memoryContinuitySystem`（`systemHash` 与冻结单 `promptHash` 逐位相同）＋与 runner 同形的载荷，4 例 × 2 模型（`correction-01` 已由真实跑器验证）。预注册门槛：≥8 例提议集与期望一致判「修复有效」。

| 案例 | deepseek-flash | MiniMax-M3 | 期望 |
|------|----------------|------------|------|
| `ambiguous-10` | `proposals: []`，recent 写明传言未查证 ✅ | `proposals: []`，recent 写「无法据此调整验收状态」 ✅ | 保留旧事实、不动作 |
| `attribution-01` | `add`／`fact`，归属纸鸢组 ✅ | `add`／`fact`，归属纸鸢组 ✅ | 落成条目 |
| `scope-01` | `add` 但 `semantic: standing` ⚠️ | `add`／`fact`、范围正确 ✅ | 落成条目、`fact` |
| `recent-blocked-01` | `add` 一条长期条目 ⚠️ | `add` **三条**长期条目 ❌ | 只进近期块 |

**结果 5/8，未达预注册门槛**。但失效集中在**同一处**：被修复的三类全部消失（未核实不 `obsolete` 2/2、空提议即完整回答 2/2、长期内容落成条目 4/4），而「近期 vs 长期容器路由」没有任何改善，MiniMax 甚至把工作进度整段落成长期事实。**结论：提示词修复对否决类与空提议类有效，对容器路由无效——容器需要结构性改造（例如由准入层按语义把进度类内容归入近期），不是再加一句提示。**

另有两处工程记录：MiniMax 在 2048 token 上限下 3/4 截断（改为生产的 4096 后全部停止正常），这正是方案 C 已记过的「按模型配置推理预算」；探针启动器原先的 60 秒计时器会给整轮设限（已改为就绪握手），Electron 在本机沙箱策略收紧后需 `--disable-gpu --no-sandbox`（无窗口开发工具、不渲染不可信内容）。

真实跑器另验一例：revision 11 下 `correction-01` 两模型均 `correct` 落地、旧值被替代（r13 该项丢 10 分）。该轮其余案例因冻结协议要求**边跑边双标**（每条已派发行须先完成标注）未继续派发；冻结单 `9bddabc8…`，执行提交 `cbbbef8`，新增 2 次调用（总账 1509）。

## 2026-10-11 容器路由判据标定与改造

问题：模型把工作状态（进度／受阻／待定）写成长久条目。协议臂验证 5/8、失效**全部集中在这一处**；提示词里早已写着「近期进度、临时要求和未决事项只进入 recent」，模型照样落长期条目——所以这需要程序判据，不是再加一句提示。

### 判据选择（零调用，229 条冻结产物）

先否掉口令文本：按「口令是否含长期意图标记」预测容器，30 例里错 8 例（英文例、`temporary-*` 的 no-op 例、`记录`作名词误命中）。改为**只看提议内容形态**：

```
WORK_STATE_SHAPE = /(?:已完成|未完成|尚未|未开始|不开始|待确认|受阻|目前)/u
```

标定结果（语料 115 条 `add` 提议）：

| 指标 | 值 | 含义 |
|------|----|------|
| 命中 | **13** | 含工作状态词的长期新增 |
| 命中落在期望 `recent` 的案例上 | 12 | 正是容器错放（含 4 条现被标注为 `clean` 的同型缺陷） |
| 命中落在期望长期条目的案例上 | **1** | `r10 ambiguous-01`，该例期望动作本就是 `unchanged`（模型多加了一条生效事实）→ 拦截同样正确 |
| 命中所在响应另有非空近期块 | **13/13** | **拒绝不丢信息**：工作状态另有载体 |
| 试卷 28 个长期期望单元被命中 | 1 | `B 方案尚未决定`，该例期望动作是 `unchanged`，无冲突 |
| 5 条种子长期条目被命中 | 0 | — |

**标记集只收语料实证过的词**：初版曾收 `下一步`（零命中），结果把 v5 链式夹具第 5 步的长期事实「青灯项目下一步核对版本号」误伤、`pnpm test` 变红——按最小干预剔除；扩集必须先给新证据并重跑标定测试（已钉进 `test/scripts/memory-failure-attribution.test.ts`）。

### 实现（`src/main/working-memory-consolidation.ts:249`（`workStateShaped`）、`:558`（守卫拒绝））

- 新增导出纯函数 `workStateShaped(content)`；在既有守卫（`standingEscalationBlocked` 那条）**之后**追加一条分支：`continuity` 路径下，组内任一 `add` 命中即整组以 `MEMORY_ROUTED_TO_RECENT` 拒绝，近期块照常提交。
- 只在生产 `continuity` 路径生效；历史评测臂（`forHistoricalEvaluation`）行为不变，r9–r13 可复现性不受影响（有回归用例）。
- 只拦 `add`：语料中没有 `correct`／`conflict`／`obsolete` 的容器错放证据。
- 界面文案见 `src/shared/memory-errors.ts`；审计把该码列入 `PROGRAM_RULE_CODES`——将来若它拦掉了试卷期望的长期内容，会以「确认假阴性（程序规则）」出现在清单里等人工过卷，而不是安静地算成模型失分。
- 运行修订号 `V6_RULES.revision` 11 → 12（新冻结单与 campaign 键，不改 70／各维 60%／权重／题目）。

### 验收

反例先红后绿：单元表（12 条语料串为真、12 条长期内容为假）、集成（接续口令下状态形态被拒且近期块落地、同口令下真项目事实照常准入）、历史臂回归、审计互锁、标定复现。完整 108 文件 1864 通过／2 平台跳过。

### 两笔旧账收口（2026-10-11）

**① `repair-not-applied`（r11 correction-01，10 分）——根因定位并确认现码已不复现。**
代码考古：r11 执行提交 `6802a9d` 的补丁校验把**非法 action 也锁死**——

```ts
['action','group',...(unboundTarget?[]:['target'])].some(k => item.value[k] !== old[k])  // 改 action 即抛 MEMORY_OUTPUT_INVALID
```

而合同明写「非法 action 可改成合法值」。r11 实测正是这个形态：首轮输出 `action: "corrept_placeholder"` 占位，修复轮给出合规的 `correct` 补丁，**补丁因为改了 action 被判非法**，整条以 `MEMORY_OUTPUT_INVALID` 拒绝、旧「每周」继续生效。`a1cbab8` 用 `repairFieldLock`（区分 locked／mutable：已合法 action／group 与已绑定 target 锁死，非法 action／非法 group／未绑定 target 放开，content 等永远可改）替换后修好；r12／r13 未再出现该类行。

现码回归：以 r11 同一序列（首轮非法 action → 修复轮合规补丁）的集成测试证明补丁落地、旧值退出且无 `MEMORY_OUTPUT_INVALID`，并逐条钉住 `repairFieldLock` 的锁／放语义。该类因此**只描述历史行、不进入任何投影**。

**② 英文工作状态覆盖——实测为空，不改判据。**
语料里英文为主的 `add` 提议为 **0 条**，无法据此扩标记集。于是专门取证：新增 3 条英文探针夹具（两条工作状态 + 一条长期事实对照），走协议臂 3 例 × 2 模型 = **6 次调用**。结果：

| 夹具 | deepseek-flash | MiniMax-M3 |
|------|----------------|------------|
| `probe-en-progress`（工作状态） | 未提议长期条目 ✅ | 提议了一条**中文**长期条目（含「受阻」）→ **被现有标记集拦下** ✅ |
| `probe-en-pending`（工作状态） | 推理吃满上限、空输出（已知坑） | 未提议长期条目 ✅ |
| `probe-en-durable`（长期对照） | `add`/`fact`，正常落成 ✅ | `add`/`fact`，正常落成 ✅ |

**两个模型对英文材料都用中文作答**，6 条回答里英文提议为 0。结论：英文标记**没有证据支撑、暂不加入**；判据维持中文标记集，扩集仍须先给证据并重跑标定测试（英文对照句与那条中文工作状态提议都已钉进单元表）。限制：夹具 3 条、1 条截断，只说明本次取证范围内不构成缺口，不等于英文永远安全。信封与账：该取证 **6 次调用**（≤8），单独记账于 `.cache/memory-quality/2026-10-11-probe-en/`，总账口径 `1511 + 6 = 1517／3000`。

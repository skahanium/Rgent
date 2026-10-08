# 记忆模型协作研究

本文记录 2026-10-08 已读取源码、Rgent 现有证据与待验假设。产品边界只有[局部合同](decisions.md#2026-10-08-记忆模型协作与实际任务收益局部授权)，施工状态见[五包施工](build.md#2026-10-08-记忆模型协作与实际任务收益)。本文不是第二合同，也不开放 Agent 联网、直接写盘或下游能力。

## 固定来源与证据类型

研究缓存位于 `/tmp/rgent-harness-research-20261008`，由 `pins.json` 和 `source-manifest.json` 固定仓库、提交、路径与 SHA-256。包 0 重新核对全部 33 个缓存文件的散列；下述永久链接使用同一提交，不使用浮动 main 链接。缓存供本机复核，永久链接供后续读取；源码存在某机制，只能证明机制存在，不能证明记忆学习质量或 Rgent 任务收益。

| 对象 | 固定提交 | 证据用途 |
|------|----------|----------|
| NousResearch/hermes-agent | `25a71a744cb9ef06950a91638e6229b4f808d461` | 模型操作入口、程序存储与失败反馈、按需会话查找 |
| openclaw/openclaw | `0d6c9677f4a286515efa3718907cc90cb4cf9d34` | 整理候选的来源过滤、写入归因与分层读取 |
| OpenHands/software-agent-sdk | `0bb7b525c75f4a9a0606844fc4a2579106b08d32` | 上下文装配、按需记忆读取与机械参数修复 |

区分四类证据：下节是已查源码事实；项目 README 的评测说明属于项目自报；Rgent r10 是本项目固定试卷证据；最后一节是本轮尚待实测的假设。不能相互代证。

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

不照搬直接文件写工具、以出现频率升级长期事实、无依赖核验删除、向量检索或扩大模型调用次数。保留 Rgent 四层、权限、M4、主进程写入和最终统一提交。包 0 只有研究与合同，协议及独立近期接线、认证和任务收益都尚待后续包。


## 本轮工程进展与尚待实测

`0cfba0a`–`4619fef` 已实现短引用、逐组协议反馈和按实际请求建立近期依赖；机械协议、取消、版本、遗忘、重启与容量反例已取得定向证据。独立复核发现的“被拒更正仍触发重整”和“补调用耗尽整场期限”已修：只按保留的更正判断，补调用预留最终核验时间，真正总期限不延长。

`d11fcd2`–`535251f` 增加实际回答对照的工程入口：固定第一轮真实产物、双条件生产请求比对、原子预算、严格证据绑定和零付费报告恢复。部分结果呈现另由 `044004f`／`d696698` 接线。这里的通过仅指定向工程检查；全包复核、实际窗口、认证和32次回答观察尚待，不能据此确认上文四项收益假设。具体失败、受验范围及后续结果只在[施工记录](build.md#2026-10-08-记忆模型协作与实际任务收益)登记。

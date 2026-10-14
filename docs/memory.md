# 记忆模型协作研究

本篇是记忆质量仪器的**现行**说明：判据与发布门、评分与标注口径、本机付费评测的操作要点，以及最新一次成绩。**按日期的整轮实测见[施工历史](build-history.md#2026-10-08-记忆研究固定来源已查源码事实与假设)**——2026-10-08 的固定来源与已查源码事实、r10–r18 每一轮的经过、发现、账目与争论都在那里（冻结历史，只描述当时，不回填）。本文不是第二合同，也不开放 Agent 联网、直接写盘或下游能力；产品边界以[2026-10-08 局部合同](decisions.md#2026-10-08-记忆模型协作与实际任务收益局部授权)、[2026-10-09 支撑合同](decisions.md#2026-10-09-记忆协作支撑局部授权)与[2026-10-10 仪器卫生](decisions.md#2026-10-10-记忆仪器与产品卫生局部授权)为准。

## 判据与发布门

- **认证判据**（沿用冻结规则，不因复跑而放宽）：总分 ≥70、四维各过地板（standing 12／fact 12／recent 18／update 18）、可靠性两轮 30/30、可判定 ≥27/30、零否决、双标门 16/16 且一致。**两轮都通过**才发布设备级成绩。
- **失败怎么办**：如实记 `failed`／`insufficient-evidence`，**不发布**、不改判据、不追加调用、不调参重跑；有模型输出的旧结果一律锁死，不许拿重跑刷成绩；失败／否决停止后的未用额度不转调试。
- **发布文件**：设备 `memory-quality-status.json` 记 `state`／`rounds`／`frozenHash`／`humanReviewed`；记忆页显示的「现行通过」只代表该 `frozenHash` 那一版程序——提示词或产品代码一变，既有成绩如实显示为**适用范围已变**，不冒充当前。
- **人工复核是独立的门**：发布门 `--require-human-review` 在被发布那一轮的行没有全部人工标注时即拒（`annotator.kind=human && humanReviewed=true`），机器内第二遍标注不能替代；`humanReviewed` 只由人工覆盖证据打开。
- **「92」的口径（写死）**：债务表第 4 项的「92 份标注」是**标注文件数**，不是行数。冻结产物里：**61 行**尝试（模型×轮次×案例）、**60 行有主标注**（1 行 MiniMax 行无主标注）、共 **92 份标注文件＝60 份主标 ＋ 32 份双标**。人工复核的对象是**行**：60 行主标注 ＋ 1 行补录，所以复核包按 **61 行**出题；其中**三行已由用户本人在 2026-10-12 判过**（`v6-attribution-02` r1、`v6-fact-01` r0、`v6-malicious-07` r1），包内按"已复核（导入）"只读呈现、**不重问**，判词逐字取自 `test/fixtures/v6-outcome-review.json` 并保留出处。后续引用这个数字必须按行与文件分开写，不能再用「92 行」。
- **投影纪律**：只读投影数字**只留在审计小节**，不进 `AGENTS.md` 的当前阶段抬头；抬头只写「未过认证、未人工复核」。投影链越长与真实成绩关系越弱，**唯一能结账的动作是在新试卷下新冻结并跑满两轮**。

## 评分与标注口径

- **评分仪器**：可靠性分母改为「已派发且非环境」；仅分类检查失败按内容 F1 × 0.5；`V6_SCORING_CATEGORIES` 真正过滤类别；标注必填 `rubricVersion=1`。
- **修订号**：`V6_RULES.revision` 是运行修订号，冻结 `prefix` 由它生成——**换 revision 必须同时改常量**，否则新冻结会静默沿用旧前缀、第一次派发就被 `EVALUATION_MODEL_PAUSED` 挡下。
- **近期块四段全空**：校验器要求「至少一段非空」，续写系统提示词必须写明「但四段不能全空：确无可写的近况时整体返回 `recent:null`，不要交一个四段全空的对象」。两处口径不一致时错的是提示词，不是校验器；也**不再**给试卷加「近况缺失」检查项——近况没落地本来就按遗漏计分，加了只是重复计价。
- **元目标**：`metaGoalShaped(recent, prompt)` 是机读判据（规范化去空白与标点、统一小写后比较 `goal` 与口令／材料原句；命中口令原句、「整理本次／总结进展／记录本次工作」这类空话即判空，长度下限 `min(8, 口令长度)` 保证短词偶然出现不误伤）。检查项 `checks.workingStateSubstance` 是**可选**项，缺省视为通过、旧标注不因缺键失效，未知键或非布尔值仍判无效；计价只在 **recent 维度**按 `recentGoalHaircut`（0.5）打折，不是整例 0、也**不进否决集合**；试卷自述（`V6_RULES.checks`）与打折常量必须同步。
- **空提议**：`{"recent":null,"proposals":[]}` 是**结构完整的空提议**——有输出（`evidenceComplete=true`、计数 0），不是「没有模型输出」；只有真的没有任何响应才算不可判定。
- **否定性状态**（2026-10-14 澄清，此后所有标注者共用）：否定性状态单元（「尚无已批准安排」／「尚未决定」／「尚未开始」）由「终态未出现相反断言 **且** 相关既有条目仍 active」满足，**不要求字面落点**；由材料支持的「下一步」可覆盖「第 N 份尚未开始」这类单元。`V6_PROGRAM_APPLIED_REASONS`（含 `MEMORY_SEMANTIC_RESCOPED`／`MEMORY_PROGRAM_COMPLETED`）里的程序侧「良性 applied」码按正常落库计（有正文→`valid`、没有→`safe-empty`），不许把不存在的落库冒充 `valid`。
- **容器路由判据**：只看提议内容形态，`WORK_STATE_SHAPE = /(?:已完成|未完成|尚未|未开始|不开始|待确认|受阻|目前)/u`；只在生产 `continuity` 路径、只拦 `add`，命中即整组以 `MEMORY_ROUTED_TO_RECENT` 拒绝、近期块照常提交（历史评测臂 `forHistoricalEvaluation` 行为不变）；该码列入 `PROGRAM_RULE_CODES`，将来若拦掉试卷期望的长期内容，会以「确认假阴性（程序规则）」出现在审计清单里等人工过卷。**标记集扩集必须先给新证据并重跑标定测试**。
- **范围改判判据**：`semanticScopeMismatch` 在 `scope` 非空、不含库级标记、内容也不含库级标记与第一人称／做法标记（我／本人／自己／习惯／偏好／一直／始终）时，把 `semantic` 改成 `fact`、`layer` 同步为 `demand`；`scope`／`content`／`sources`／`authority` **逐字保留，不拒绝、不丢条目**，回执码 `MEMORY_SEMANTIC_RESCOPED`。顺序固定：**容器路由 → 本改判 → 引用核对 → 孪生判定 → 提交**（先摘孪生会把唯一正确的容器一起摘掉）。反向要件：库级范围、具体范围但内容含第一人称、空范围都保持 `standing`——宁可漏改，不误改。
- **同义孪生判据**：仅当存在承载同一主张的 `fact` 容器时才摘那条 `standing` add，判据＝范围相容（NFKC＋小写＋去空白后相等或互为子串）**且**双向覆盖 `max/min ≥ 0.35`；不重分类、没有容器则照旧放行。阈值是量出来的（正类 0.375–1.000、负类 0.025–0.235），**"必须双向"是实证**（负类里单向能到 1.000）；范围判据必须用子串。改判据或特征词前先给新证据并重跑标定测试。
- **失败例归属分类**：只读 `.cache` 冻结产物的归属审计，用于把「未通过」拆成内容缺口、机制拦截、环境故障与否决四类。**零模型调用、零写入**；不复算官方判定，不改写任何冻结成绩。复现：`node scripts/memory-failure-attribution.mjs`（`--json` 取机器可读、`--legacy` 追加 r6/r8/r9 并按 `frozenHash` 分段）。分类规则、口径常数、试卷权重/动作/容器期望、revision 11 试卷差异与人工过卷判定由 `test/scripts/memory-failure-attribution.test.ts` 逐项钉住。`PROGRAM_RULE_CODES` 与审计互锁：程序规则若拦掉试卷期望的内容，会以「确认假阴性（程序规则）」出现在清单里等人工过卷，而不是安静地算成模型失分。

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

  逐轮统计、假阴性清单与只读投影见[2026-10-10 的审计归档](build-history.md#2026-10-10-失败例归属审计统计假阴性清单与只读投影)。

## 本机付费评测操作要点

1. 本机跑评测必须带 `ELECTRON_DISABLE_SANDBOX=1`，否则 Electron 沙箱起不来（仓库不动，CI 那边照旧有沙箱）；本机沙箱策略收紧后还需 `--disable-gpu --no-sandbox`。
2. v6 **冻结必须同时带两台模型**（`MiniMax-M3`＋`deepseek-flash` 的记录 id），只带一台会被 `EVALUATION_MODELS_NOT_AUTHORIZED` 拒；派发用 `--only` 指定其中一台。
3. 冻结要求工作树干净（`EVALUATION_DIRTY_EXECUTION`）；冻结本身零调用。
4. **v6 是"边派发边标注"**：`v6DispatchGate` 要求同轮其它行都已有标注才允许派发下一例（`EVALUATION_REVIEW_REQUIRED`），所以 30 例是串行推进的，不能先攒着跑完再统一标注。
5. 单例派发成功时末尾打印总结 JSON；重复派发会被 `EVALUATION_ATTEMPT_ALREADY_DISPATCHED` 挡下（不花钱）。
6. 第 2 轮还有一道前置：第 1 轮小结必须 `passed`，否则 `EVALUATION_ROUND_REQUIRED`。
7. 未触达模型的请求可有限次重派（`V6_RULES.retryUnmeasuredMax`）；**服务层拒绝也要早停**——连续两次无输出就停下来问人，不继续派发。调用额度按授权写进 `V6_RULES.history`（`campaignLimit`／`perModelLimit`／`parentLimit`／`ledgerStop` 与 `ownerGrant`），额度拒绝必须在派发前响亮停下，不伪装成服务失败。

## 最新一次成绩：revision 18（2026-10-14，已发布）

记忆页显示的「现行通过」是 r18：第一轮 **100／100**（四维 20／20／30／30，`reasons` 为空——**零扣分**），第二轮 **98.67／98.67**（recent 28.67）；两轮均四道门全绿、可判定 **30／30**、每方向覆盖率 **1.0**、双标 **16／16 且一致率 1.0**、**零否决、零分歧**。冻结 `prefix v6-2026-10-05/integrity/r18/`、`frozen 1c351be2…`，执行提交 `1884b5c`；设备 `memory-quality-status.json` → `state=passed`、`rounds=2`、`frozenHash 1c351be2…`、`humanReviewed=false`。**仍未做**：人工复核标记（可选，只改 `humanReviewed`）、Windows/CI 证据（等推送指令）、用户刷新记忆页确认显示。

轮次经过、判据澄清解决了哪两处分歧、账目（r13 起累计 1599 → **1844**，r18 两轮 60 次；campaign 398／1000；全局余量 4156／6000）、那一处 recent 真实退化（`recent-draft-01` 的正向进展没有落点，下一轮修订第一顺位）与独立读者的两条观察，都在[施工历史 · revision 18](build-history.md#2026-10-14-revision-18-认证两轮通过并发布)。

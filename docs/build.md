# 施工图

本文不是围栏。过期只改这里，不改产品性格。合同见 [已拍板决定](decisions.md)。强制点见 [架构](architecture.md)。工程题见 [施工对象](topics.md)。编码 Agent 从 [AGENTS.md](../AGENTS.md) 进。

单元格只有三种：

- **已交** — 一行指针。细节在代码和测试里。
- **当前** — 只展开下方那一节。
- **未开** — 禁止写代码。不要把实现写进围栏篇。

换阶段：改「当前阶段」标题、改矩阵里那一格、改 `AGENTS.md` 硬停。不要一次展开下一阶段。

## 当前阶段

**门禁及其前置文件安全。** 本阶段允许修复阻塞门禁安全性的既有笔记 IO 缺陷，不开放 Host。通过本节验收后才更新本标题、矩阵状态和根目录 `AGENTS.md`。

## 依赖顺序

无日期。后一项吃前一项交出来的接口。

```text
笔记壳能启动
  → 管线与画布
  → 账本缝与人搜
  → 门禁
  → 身份标记（含账本只读 tab）
  → Host 最小环（最小模型配置 + 密钥存储 + 运行上限设置入口 + 流式未采纳 + 取消，无工具）
  → 内置工具五件（建 / 补任务发起篇 / 改名 / 挪 / 删）
  → 技能
  → MCP / 联网（仅应用代转）
  → 设置收口 / 压测校准
```

v0 Host 阶段须兑现 [Agent 上下文与历史](topics.md#v0-上下文与历史) 的预算、临时压缩及来源核对；长正文与长账本、恶意历史和权限变化要进入固定验收样例。多轮管理、跨任务记忆、子代理和多代理编排列为 [后续 Agent 能力](topics.md#后续-agent-能力)，待分别拍板合同和验收后再排施工阶段；此处不将它们开工。

硬约束：

- 门禁早于 AgentHost。
- 身份标记早于 Host 最小环。
- Host 最小环早于五件工具（已拍：拆刀）。
- 搜库工具晚于最小环；方法不与人搜子串绑定。
- `partition.body` 早于一切索引（已满足）。
- 无法代转的 MCP 不准接。
- 账本缝已经先于身份标记落地。不要写成「块模型早于账本」。

## 对象 × 阶段

对象按代码地盘切。

| 对象 | 代码地盘 | 状态 |
|------|----------|------|
| 壳与信任 | `src/main/index.ts`、`src/preload`、`src/shared/ipc.ts`、`src/shared/flush.ts` | **已交** `pnpm test`；`test/shared/flush.test.ts`。preload 为 `index.cjs`。 |
| 库与文件 | `src/main/vault.ts`、`secure-fs.ts`、`notes-fs.ts`、`paths.ts`、`watch.ts`、`vault-protocol.ts`、`native/**` | **已交** 选库、树、读写、媒体；本阶段原生文件边界待双系统验收。附件插入 UI 未开。 |
| 正文与画布 | `src/markdown/**`、`src/renderer/src/view/**` | **已交** 一条管线 + viewport widget；`test/markdown/pipeline.test.ts`。 |
| 账本缝 | `src/markdown/partition.ts`、`src/renderer/src/tabs.ts` | **已交** 画布只吃正文，写盘 `composeSource`。 |
| 检索 | `src/main/vault-index.ts`、`src/renderer/src/search.ts`、`backlinks.ts` | **已交** 人搜当前使用惰性全量 + 子串；人的全量可见是合同。模型检索方法未锁。 |
| 门禁 | `src/main/permissions.ts`、IPC、树 | **当前** ↓ |
| 身份标记 | 尚未 | **未开** 身份落盘写法、账本只读 tab。 |
| 一场 `/` | `AgentHost` 尚未 | **未开** 拆刀见 [施工对象 · Agent](topics.md#agent-核心框架) |
| 技能 | 尚未 | **未开** |
| MCP / 联网 | 尚未 | **未开** 只接能代转的。 |
| 设置 | 尚未 | **未开** 像素未锁。Host 阶段须有运行上限的最小配置入口；门禁总表等到设置收口。 |

## 门禁

本阶段把三档权限做成库内可执行的名单，并让人在树上改档；同时收口阻塞门禁安全性的笔记 IO、冲突写盘和退出失败路径。不为模型开工具，不改人搜语料。

### 入口

上一阶段已交齐：

- `pnpm test` 绿。
- 能选库、开笔记、自动写盘、退出 flush。
- 编译管线、人搜、反链。
- 画布只有正文；写盘 `composeSource`。
- 隐藏路径经 `noteWrite` 会被拒绝（`src/main/notes-fs.ts`）。

### 碰这些 / 禁止碰这些

碰：

- 新建 `src/main/permissions.ts`：读写真名单、`tierFor`。隐藏文件走自己的 IO，**不要**走 `writeNote`。
- 新建 `test/main/permissions.test.ts`。
- `src/shared/ipc.ts`：加人用的读写通道；`TreeEntry` 可带徽章档。
- `src/preload/index.ts`、`src/main/index.ts`：登记通道，载荷做类型检查（与现有 `asString` 同一纪律）。
- `src/main/vault.ts`：打开库时加载名单；改档后刷新树。
- `src/renderer/src/tree.ts`、`src/renderer/src/shell.ts`：禁止 / 必须遵循打标；**只对文件夹**右键设档。默认可参考不挂徽章。接线走 `permissions:set`，不要让渲染进程写盘。
- `notes-fs.ts`、`watch.ts`、`vault.ts`、编辑器保存：拒绝跟随笔记文件及父目录符号链接；树可把链接显示为普通文件。临时文件写满后在同一库文件系统内原子替换，失败保留原文并清理临时文件。macOS 临时文件放在固定库根，再用库根相对且全路径不跟链的改名提交；Windows 在固定父目录句柄下建临时文件并替换。`noteRead` 返回全文与内容修订值；人的 `noteWrite` 带预期修订值，主进程串行提交同篇，冲突返回明确结果，沿用选磁盘或窗口稿的交互。
- `native/**`、`src/main/secure-fs.ts`：库根固定为目录句柄，逐级相对打开并拒绝符号链接 / Windows 重解析点；树、笔记、名单、索引、媒体和目录变化扫描统一走此边界。缺模块或安全状态不明时失败，不回退路径式读取。原生模块仅在主进程加载；构建后必须在 Electron 中实测装载。
- `scripts/check-docs.mjs` 与 GitHub CI：检查相对链接和当前阶段一致性；macOS、Windows 用锁文件安装，运行测试与构建。
- 退出保存失败：提供继续编辑、重试和明确放弃未保存修改并退出的路径；`Cmd+Q` 与关窗都走同一决策，不得靠强制退出。构建后增加跨平台的 preload CommonJS 语法检查；实际窗口启动仍需单独验证。

禁止：

- `AgentHost`、一场 `/`、技能、MCP、抓页、设置像素。
- 身份标记、账本只读 tab。
- 改 `VaultIndex` 建索引时按权限删笔记。
- 复用 `noteWrite` 写名单。
- 复用人的 `noteWrite` 给未来模型；模型只能用单独授权入口，可共用底层安全写入原语。
- 把条目格式写进 `decisions.md` 装成已定。

必须对上的围栏：[已拍板决定](decisions.md) §权限（含笔记→同名附件夹跟档）、原则门「只锁 AI」、§检索「人搜含禁止触碰」。强制点见 [架构](architecture.md)「隐藏路径人写盘写不了」。

### 本阶段选定（不是围栏）

以下是当前阶段的工程选型。换格式等于一次迁移，先改本节再改代码。

- 文件：库根 `.rgent-permissions`（路径已是架构选定值）。
- 编码 UTF-8。正文是一份 JSON 对象：键为库内 POSIX 相对路径，值为 `reference` | `follow` | `forbidden`。未出现的键不当条目存。
- `follow` = 必须遵循，`forbidden` = 禁止触碰，`reference` = 可参考。界面文案用中文三档。
- `tierFor`：精确匹配文件路径；目录条目匹配「等于该路径」或「以 `路径/` 开头」。目录 `工作/秘密` 覆盖 `工作/秘密/…`，不覆盖同级笔记 `工作/秘密.md`。笔记 `X.md` 上的档视为覆盖同名夹 `X/` 及其子路径（围栏）。多条命中时，匹配路径更长的赢；长度相同时，直接写出的目录条目胜过从 `X.md` 推导的同名夹档。都没有则 `reference`。
- 徽章：`TreeEntry` 可选 `tier?: 'follow' | 'forbidden'`。可参考不写这个字段。样子能区分两档即可，不要在本阶段发明主题。
- IPC 选定名：`permissions:get`、`permissions:set`。`set` 只服务人的右键。`get` 返回给渲染进程画徽章和菜单，不把全文塞进以后的模型上下文。
- 名单文件不存在才视为空名单。已有名单若损坏、条目无效或无法读取，`get` 返回 `invalid(error)`；人读、写、搜继续，未来所有 AI 出口拒绝。树界面提示修复，不自动清空或覆盖。`set` 只在 `ready` 时接受主进程核验的真实文件夹路径与三档值，并原子写盘。
- `tierFor` 保持纯函数。未来 Host 在每次组模型上下文和执行工具之前重新读取有效名单；名单外部改动立刻影响下一次出口判定，不依赖启动缓存。模型检索在查询期过滤，人搜语料保持全量。
- Windows 路径大小写、Unicode 规范形式和并发换链不能把同一实际路径判成较低保护档。无法确认路径与名单条目对应时，未来 AI 出口失败关闭；本阶段仍须补相应验收，不能靠简单转小写代替文件系统核验。
- 权限加载以目录句柄解析条目，记录实际路径组成并复核身份；同一对象的大小写、Unicode 或短文件名别名落到同一规则。条目失效、别名冲突或检查间身份变化时，`invalid` / AI 失败关闭。目录变化目前以固定根句柄做元数据扫描；这是 v0 实现，后续大库压测可调整频率与执行位置，不改变不跟随链接的边界。
- 库内边界以用户选定并固定的库目录对象为根；外部进程整体搬走此根、控制文件系统驱动或内核不属于本阶段承诺。普通路径替换、符号链接、Windows 重解析点必须拒绝。
- macOS 不可把“父目录句柄仍指向原对象”当作“仍在库内”：子目录可被外部进程搬走。最终写入从固定库根使用 `RENAME_NOFOLLOW_ANY` 解析完整相对目标；库根临时文件使来源也固定。受控搬出子目录的回归测试必须证明库外原文未被改写。
- 树上本阶段只对文件夹设档（围栏原文）。名单允许出现文件路径（更长覆盖更短），单篇界面等到设置总表。

为什么现在这样：树右键已够人改档，设置总表可以等收口。JSON 对象不用新解析器。英文枚举给代码，中文给画面。

### 完成定义

`pnpm test` 绿，并且至少覆盖：

- 空名单或文件不存在 → 一律可参考。
- 对文件夹设禁止触碰 → 其子路径跟档；更长路径覆盖。
- 对笔记设档 → 同名附件夹跟档；夹上更长条目优先。笔记不因夹被设档而自动改档。
- 人搜仍能命中禁止触碰笔记的标题或正文句子。
- `noteWrite('.rgent-permissions', …)` 失败。
- 主进程 API 能创建、改写该文件。
- 损坏、无效或不可读的已有名单返回 `invalid`，保留原文件、提示修复；不妨碍人读、写、搜，未来 AI 出口一律关闭。
- 名单外部改动后的重新加载；路径覆盖和同名附件夹。
- 符号链接越库、写入失败保留原文、并发写与外部修改冲突。
- 并发换链时笔记、名单、索引、媒体不得从库外读，替换不得改写库外文件；Windows 真实存在的大小写、Unicode、短文件名别名不得绕过禁区。无法安全判定则 AI 失败关闭。
- 保存失败时关窗与 `Cmd+Q` 均能让人继续编辑、重试，或明确放弃修改并退出。
- 相对文档链接和当前阶段检查；macOS、Windows CI 测试、构建，以及构建后 `out/main/index.js` 存在、`node --check out/preload/index.cjs` 通过、原生模块能被 Electron 装载。语法检查与装载探针不能代替窗口启动。
- 树上禁止 / 必须遵循打标，可参考不打。
- 文件夹右键改档后能再读回来。

改壳或 preload 时：`pnpm build` 后窗口能起来。

### 本阶段还差

权限名单、IPC、树徽章、原生文件边界与冲突写盘已接线；`modelTierFor` 仍只在测试中调用，没有实际模型出口。`X/` 与 `X.md`、平局规则已有断言；保存失败弹窗已在本机分别操作重试、继续编辑和放弃，关窗与 `Cmd+Q` 均经过。受控链接换入及搬出子目录时不改写库外原文的 macOS 定向测试通过，本次构建产物已启动窗口并读到测试笔记。阶段尚未交付：须在 macOS 与 Windows 跑完整 CI，验证 Windows 原生模块的真实保存及大小写 / Unicode 别名行为。任何未通过项修完后再翻阶段。

### 交给下一阶段

身份标记和日后的 AgentHost 只应依赖：

```ts
export type PermissionTier = 'reference' | 'follow' | 'forbidden'

export type PermissionEntry = {
  relPath: string
  tier: PermissionTier
}

export function tierFor(relPath: string, entries: readonly PermissionEntry[]): PermissionTier
```

`VaultSession` 的 `permissions()` 每次重新读名单；未来模型出口取得 `ready` 才调用 `tierFor`，`invalid` 必须拒绝。模型检索做查询期过滤，不要另建一份抹掉禁区的索引。身份标记格式在身份阶段确定。Host 的运行上限、任务跨 tab 路由、固定验收样例和工具边界见 [施工对象](topics.md#agent-核心框架)；这些仍未开工。

相关：[文档地图](README.md) · [已拍板决定](decisions.md) · [架构](architecture.md) · [施工对象](topics.md) · [施工守则](handbook.md)

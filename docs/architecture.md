# 架构

本文只写已经拍板的结构，以及这些结构在代码里怎么被强制。数字、禁令和未锁清单见 [已拍板决定](decisions.md)，此处不提前写死，也不再抄一遍。

未开工对象的实现细节写在 [施工图](build.md) 和 [施工对象](topics.md)，不要写进本文装成已有。

## 总览

```mermaid
flowchart LR
  Renderer[渲染进程 CM6]
  Main[主进程]
  Host[AgentHost]
  SDK[Vercel AISDK]
  MCP[MCP客户端]
  Vault[用户自选库]
  Keys[应用数据目录中的密文]

  Renderer -->|IPC| Main
  Main --> Keys
  Main --> Host
  Host --> SDK
  Host --> MCP
  Main --> Vault
  Host -->|工具过门禁| Vault
```

- **渲染进程：** 画布是 CodeMirror 6。文档是 Markdown 字符串。无 Node，不能直接碰盘。画布只消费编译结果和源码映射，自己不解析结构。
- **主进程：** 打开库、读写文件、权限名单、索引、窗口。v0 的 `AgentHost` 先住在这里；是否迁移属工程选型，见 [施工对象](topics.md#多进程--并发)。
- **AgentHost：** 一场 `/` 的运行环境。愿景 / 选型 / 路线见 [施工对象](topics.md#agent-核心框架)。当前未开工。
- **正文编译：** 共享一条管线（零 DOM、零 CM6）。注册插件 → 解析 → 索引 → 把源码映射交给画布。日后检索、反链、喂模型走同一份结果。细则见 [已拍板决定](decisions.md)。

## 正文管线

```mermaid
flowchart LR
  Src[Markdown字符串]
  Pipe[共享编译]
  Idx[块与源码映射]
  View[CM6画布]
  Src --> Pipe --> Idx --> View
  View -->|"写盘=原文"| Src
```

- 结构只在这一条管线里解析。不要在画布、检索、Agent 里再各写一套。
- 语法扩展走插件，不改宿主。v0 插件含 GFM、frontmatter、公式、callout、wikilink、mermaid。callout 用 mdast 变换，不是第二套解析。
- 写盘永远是编辑器里的字符串。管线先 `partitionSource`，只编译正文。

## 库内布局

- `.md` 就是笔记。
- 每篇笔记带一个附件夹，名字与笔记同名。图和 PDF 跟这篇走。引用写全路径，解析走 Markdown 标准相对路径。
- 权限名单和技能文件跟库走，对文件树隐藏。权限名单的选定路径见下方强制点。
- 账本写在这篇笔记同一个文件里，放在最末尾，用一行机器锚点分隔（锚点值见 [已拍板决定](decisions.md) §账本）；正文永远在锚点之前。树上没有单独一条。
- 人搜、反链与日后的模型检索只索引锚点之前的正文，不得索引账本。Host 组模型上下文时另行读取本篇账本，按 [产品合同 · 喂给模型](decisions.md#喂给模型) 的预算与来源规则处理。
- 密钥不进库。Host 阶段以 Electron `safeStorage` 加密，密文只存应用数据目录，解密材料由操作系统保护。

## 两套可见范围

- 人的搜索含禁止触碰。当前人搜是惰性全量 + 子串，可按压测换引擎。
- 模型检索不含禁止触碰。同一份语料，查询期过滤。方法不与人搜子串绑定。
- 不要做成同一份「看不见」的索引。细则见 [已拍板决定](decisions.md)。

## 一场 `/` 的数据流

1. 人在空段段首按 `/` 输入；回车发送口令并散场，同时把生成任务绑定到发起时的笔记和落点。
2. 模型拿到三类带来源的内容：该笔记正文、按预算处理的本篇账本、这一次 `/` 落在哪两块之间。旧账本章节超限时可用本任务临时摘要，不改原文。
3. 回答先插回原笔记的未采纳块，接在 `/` 下面。切 tab 只结束输入交互，不取消任务，也不改变结果目标。
4. 人点采纳，才跟手写一个样。丢弃则删块。账本原文不动。
5. 工具过门禁执行；清单见 [已拍板决定](decisions.md) §工具。删要人在弹窗点头；权限对来源、目标和受影响子树逐项核验。
6. Esc、停止按钮或关窗取消仍在运行的任务。未采纳块留在原笔记，并记中止原因。

## 信任边界

| 对象 | 态度 |
|------|------|
| 库文件夹 | 唯一笔记地盘。第一次必须人选。丢了就回选夹。 |
| 禁止触碰 | 人能打开、能搜到。模型检索没有。不经应用代转带出。 |
| 必须遵循 | 人能改字。模型不能写。涉及就查原文。 |
| 模型 | 不可信。读、写、搜都经工具与门禁。不另做规划器。 |
| 联网开关 | 开则可搜网、抓页。关了只查本地库。约束的是应用代转。 |
| MCP | 可选的手。只接能代转的。模型不能自己接。关闸或无法代转则不准接。 |
| 密钥 | v0 用 Electron `safeStorage` 加密，密文只存应用数据目录。 |

## 强制点

已拍板性质在哪一层被挡住。没有运行时表面的，不列在这里。

| 性质 | 层 | 现状 |
|------|----|------|
| 渲染进程不碰盘 | 壳 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（`src/main/index.ts`）。preload 只经 `contextBridge` 暴露白名单（`src/preload/index.ts`）。sandbox 下 preload 必须打成 `out/preload/index.cjs`（`electron.vite.config.ts`）。 |
| IPC 是唯一通道 | 壳 | 通道名和载荷类型在 `src/shared/ipc.ts`。渲染进程不得再开通道。 |
| 不随便开页 | 壳 | `setWindowOpenHandler` 一律 deny。`will-navigate` 一律 `preventDefault`；`http(s)` 走系统浏览器（`src/main/index.ts`）。 |
| CSP | 壳 | `src/renderer/index.html`：`default-src 'self'`；图允许 `data:` 与 `rgent-vault:`。 |
| 媒体不逃出库 | IO | `resolveInVault` 拒绝 `..` 与绝对路径；`rgent-vault:` 经 `SecureVaultFs.readBytes` 从固定库根句柄逐级相对读取，不向 `net.fetch` 传校验后的路径（`src/main/paths.ts`、`vault-protocol.ts`）。 |
| 隐藏路径人写盘写不了 | IO | `writeNote` / `readNote` / `readVaultMedia` 拒绝含点号段的路径（`src/main/notes-fs.ts`、`src/main/paths.ts`）。文件树不列出点号名。权限名单落在库根 `.rgent-permissions`，与技能文件一样必须落在这类路径上。 |
| 笔记路径与冲突写盘 | IO | 主进程 Node-API 模块（`native/**`）固定库根目录句柄，树、读写、索引、媒体、目录扫描统一走 `src/main/secure-fs.ts`，模块缺失不降级。macOS 逐级从库根相对打开并用 `O_NOFOLLOW_ANY` / `O_RESOLVE_BENEATH`；Windows 用 `NtCreateFile` 逐级相对打开、`OBJ_DONT_REPARSE` 拒绝重解析点，替换经 `NtSetInformationFile(FileRenameInformationEx)`。提交前核对修订值，临时文件建在目标父目录内再原子改名，冲突交给人选磁盘或窗口稿；已打开的子目录被搬出库外、不得改写库外原文的回归见 `test/main/path-race.test.ts`。两平台保证口径一致：不写出库外，且到核对点为止的外部改动能被发现；核对点之后的替换属已知残余，见 [已拍板决定](decisions.md) §库、文件、窗口。Windows 句柄一律用最宽松共享模式——边界靠句柄相对解析成立，不靠拒绝别人的改名。目录变化以安全元数据扫描发现，不按旧路径建立监听。 |
| 权限名单的失效状态 | 主进程 | 名单缺失是空名单；已有名单损坏、无效、无法读取或条目身份不稳是 `invalid`。人读写搜继续，树上提示修复，名单写入只接受经句柄核验的文件夹与三档值并原子替换。权限按文件系统实际路径组成归一，别名冲突与身份变化使 AI 失败关闭。`modelTierFor` 目前仅被测试调用；Host 未接线，尚无实际模型出口。Windows 侧别名与写盘已过 CI。 |
| 人写盘 ≠ 模型写盘 | IPC | `noteWrite` 只给人的自动写盘与手动保存。`AgentHost` 不得复用这条通道。Host 未开工，这条先当禁令。 |
| 索引不见账本 | 管线 / 索引 | `partitionSource` 切开锚点（`src/markdown/partition.ts`）。`compile` 和 `VaultIndex` 只吃 `body`。 |
| 画布不见账本 | 画布 | Tab 拆 `content`（正文）与 `ledger`（`src/renderer/src/tabs.ts`）。编辑器只 `setText(body)`。写盘 `composeSource`。 |
| 人搜含禁区 | 索引 | `VaultIndex` 是全量语料，建索引时不按权限过滤。当前人搜是惰性全量 + 子串。模型检索尚未开工，未来在查询期过滤。 |
| 退出不丢稿 | 壳 | 关窗先 `flushRequest`。保存失败时主进程原生对话框让人重试、继续编辑或明确放弃；关窗和 `Cmd+Q` 走同一状态流程，重复请求不重复弹框。超时只在渲染进程已死时关。`vault.dispose()` 在 `will-quit`，不在 `before-quit`（退出 flush 还要走 `noteWrite`）。流程测试见 `test/shared/flush.test.ts`；失败弹窗的三条路径已在本机实际复核，本次原生模块构建后窗口已启动并读到笔记。 |
| 密钥不进库 | 主进程 | Host 最小环接 Electron `safeStorage`，密文只存应用数据目录；尚未接线。 |

相关：[理念](vision.md) · [已拍板决定](decisions.md) · [施工守则](handbook.md) · [施工图](build.md) · [施工对象](topics.md)

# 施工守则

动手前先读 [已拍板决定](decisions.md)。本文是纪律，不是功能清单。理念见 [vision.md](vision.md)，结构见 [architecture.md](architecture.md)。

## 改围栏

1. 先改 `docs/decisions.md`（必要时同步 [理念](vision.md) / [架构](architecture.md)）。  
2. 再改代码或界面。  
3. 不要用实现「顺便」推翻围栏。

## 必须

- 产品是笔记软件。新能力先问：是否服务「打开这篇 md 写作 / 页内 AI / 许可路径下的文件操作」。不是，就不要做。
- 渲染进程不直接读任意路径、不内嵌厂商 SDK、不自己连 MCP。
- 所有库内读、写、列、删、搜走主进程工具，并过 ACL。「必须遵循」只读；「禁止」不进索引。
- `vault_delete` 必须经 UI 确认。`vault_write` 不得当默认改稿手段。
- 密钥只读写系统凭据库；环境变量仅作覆盖。
- v0 不接 Shell。
- 单窗口；一次只把当前笔记载入编辑器。
- 编辑器文档模型是 Markdown 字符串（CodeMirror 6 即时渲染）。不要把整篇切成富文本 AST。重型块只用 viewport widget 懒加载。
- 解析与所见即所得共用同一套语法合同（见 `decisions.md` 第 3 节）。
- P0 必须用 5～10 篇含公式/图/表/双向链接的长文压滚动与输入延迟，数字写入 `decisions.md` 第 3 节。
- Agent 走 Harness 内循环：硬刹车、工具错误回喂、完成可核对。v0 不要做无人值守外循环。
- 测试不把真实 API Key 写进仓库。Agent 编排用假工具/假模型测 ACL 与写回。
- 按 [第一版阶段](decisions.md#8-第一版阶段) 推进：P0 未站住以前，不要把 P2 当主线。

## 禁止

- 通用 Agent 驾驶舱、独立会话 UI、平行 session 数据库。
- Python 边车、Pydantic AI、Tauri 业务代码、Harness `Coder()`。
- 用 Shell、脚本、或「模型说了就算」改盘。
- 给 AI 写规则文件、写必须遵循原文、读禁止触碰路径。
- 把 API Key 写进仓库、库示例或文档。
- 第一版打进 Playwright 第二浏览器、向量检索当阻塞项、多库同时打开。
- 把 TipTap / Milkdown / BlockNote / Lexical 当默认文档模型，或第一版就做无人值守扫库改笔记。
- 把未锁项（CM6 封装包名、规则文件 schema、幕后围栏具体语法）写进代码注释当已定合同。
- 为预留引入第二套 Agent 框架「以后再用」。

## 仓库里的遗留文件

根目录若仍有 `hello_world.py`、`pyproject.toml`（Pydantic AI 探路）或同类文件，**不是产品骨架**。不要按其写法扩散。产品结构以本文档为准；Electron / TypeScript 落地后应移除或替换这些探路件，并先改 `decisions.md` 说明迁移。

## 文档与代码同步

行为与 `decisions.md` 冲突时，以文档围栏为准并开讨论。补测试、补界面时若发现围栏不够用，回到文档补未锁项或改已拍板条目。

相关：[开源说明](opensource.md)

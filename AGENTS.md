# AGENTS.md

编码 Agent 的入口。产品性格不在这里。

## 先读

1. 本文
2. [docs/build.md](docs/build.md) 的「当前阶段」
   - 跨能力工作先核对[依赖与交接](docs/build.md#跨能力交接)；未来合同不等于当前施工授权
   - 按日期的整轮施工与实测在 [docs/build-history.md](docs/build-history.md)（冻结历史，只描述当时）
3. 工程题看 [docs/topics.md](docs/topics.md)；涉及工具、数据出口或第三方执行先读[沙箱与任务授权](docs/topics.md#沙箱与任务授权)
4. 动到壳、索引、账本、路径时：[docs/architecture.md](docs/architecture.md) 的强制点
5. 前端工作读 [docs/frontend.md](docs/frontend.md)；未开放的界面仍按硬停处理
6. 相关代码

产品合同：[docs/decisions.md](docs/decisions.md)。冲突先改围栏再改代码。

不要从 [docs/vision.md](docs/vision.md) 开写。不要把 [docs/build.md](docs/build.md) 读成已定产品方案。

## 当前阶段

**正文直写与审阅。** 版本 **0.2.0**；**W0 文档与合同切换已本机交付**；W1–W7 未开。

- 运行时代码仍是 v0.1：正文仍有旧提问块／未采纳块，账本仍可在正文尾部迁移。
- W1–W7 未开：修订、Host 直写、输入框、结果卡、账本页、视觉改版、旧笔记迁移都不在本轮。
- W0 只允许改 `package.json`、文档、`scripts/check-docs.mjs` 与文档检查器测试；不改产品源码、窗口脚本、IPC 或运行时行为。
- 版本升级走 `pnpm version 0.2.0 --no-git-checks`，不新增一次性版本脚本；流程见[施工守则](docs/handbook.md#版本升级)。
- 阶段名、对象矩阵与交接表以[施工图](docs/build.md)为准。

## 硬停（未开，禁止实现）

本轮开放范围以上文为准。以下仍是硬停。

- W1–W7 的产品重构；W0 期间不得提前拆旧 marker、账本缝或改 UI。
- 除「笔记库」「界面」「助手」「记忆」「技能」「模型」「运行」页当前必要控件以外的设置子页控件与排列、图谱及额外主题。
- AI 写类工具按[三档工作范围](docs/decisions.md#2026-10-23-三档工作范围与库内已删除)：补任务发起篇只能追加新块；建在同册/整库、落点＝发起篇所在目录；改名/挪/删只在整库；删除进库内「已删除」。仍硬停：整夹递归删除、永久删除、改动授权范围外正文、发起篇自身结构操作、附件写入、非 Markdown、跨库、其他篇账本读取、多助手与身份切换、stdio／本机可执行 MCP。
- 人删除与 AI 删除只按既有 macOS 授权；Windows 删除入口、附件夹独立删除仍关。
- 非 Markdown 资源打开、附件导入、附件夹独立改名与移动；附件浏览不新增结构能力。
- 底栏模式与模型选择已是下一场常驻设置；其他出口、统一第三方资源代理和执行隔离仍未开。
- 向量检索、独立聊天、Linux、移动端、Python／Flutter 边车、复用 `noteWrite` 给模型。
- 损坏权限名单时当空名单或自动覆盖；把未锁实现写进围栏篇装成已定。

## 纪律

- 新能力先问是否服务「记笔记 / 一场提问 / 门禁下的文件操作」。
- 渲染进程不直接读写库文件或权限，不内嵌厂商 SDK、不自己连 MCP；`localStorage` 只存非秘密、非权威的界面偏好。
- 未来工具先过[单场授权合同](docs/decisions.md#沙箱与单场任务授权合同与开放边界)；可执行第三方先过双平台隔离。每个 MCP 候选无法证明出口受控就不接入。
- 密钥不进仓库、不进笔记库；Host 用 Electron `safeStorage`，密文只存应用数据目录。
- 改壳 / preload / sandbox：`pnpm test` 必须过，且 `pnpm build` 后窗口能起来（preload 为 `out/preload/index.cjs`）。
- 生命周期中断记录只按会话、修订、对象身份和完整子树核验；探针不得作为生产接口，也不得清空用户废纸篓。
- 提交与推送分开：默认只做到提交，**推送必须等明确指令**；不擅自开分支或工作树。

## 验证

```bash
pnpm test
pnpm docs:check
pnpm ui:check   # 界面改动；需要先 pnpm build
```

`pnpm test` 先构建原生模块（需要 C++ 工具链与 Python 3），再做类型检查与测试。改壳或 preload 时还要 `pnpm build` 并确认窗口能起；改界面时跑 `pnpm ui:check`。CI 按[变更分层](docs/handbook.md#ci-分层)：纯文档只做轻检查；代码保留双平台构建、测试和窗口。换阶段按[施工守则](docs/handbook.md)四步：改施工图当前阶段与矩阵、改本文当前阶段、跑 `pnpm docs:check`。

## 已交证据

旧阶段的交付细节、提交号、失败记录与平台债务在[施工历史](docs/build-history.md)；本入口不再维护逐轮编年。当前阶段只认施工图与历史篇。

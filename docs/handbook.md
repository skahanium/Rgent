# 施工守则

动手前先读 [已拍板决定](decisions.md) 和 [施工图](build.md) 的当前阶段。工程题看 [施工对象](topics.md)。本文是纪律，不是功能清单。理念见 [vision.md](vision.md)，结构见 [architecture.md](architecture.md)。

编码 Agent 从仓库根目录 [AGENTS.md](../AGENTS.md) 进。

## 改围栏

1. 先改 `docs/decisions.md`（必要时同步 [理念](vision.md) / [架构](architecture.md)）。
2. 再改其它围栏篇和代码。
3. 不要用实现「顺便」推翻围栏。
4. 换阶段只改 [施工图](build.md) 的「当前」和根目录 `AGENTS.md` 里那一行硬停。不改围栏，除非产品性格变了。

## 必须

- 产品是单机笔记兼资料库。新能力先问：是否服务「记笔记 / 一场 `/` / 门禁下的文件操作」。不是，就不要做。
- 先看当前阶段。未开的对象禁止实现。
- 渲染进程不直接读任意路径、不内嵌厂商 SDK、不自己连 MCP。
- 权限名单和技能文件 AI 不可写。人写盘通道（`noteWrite`）也写不了隐藏路径。
- Host 阶段用 Electron `safeStorage` 加密密钥，密文只存应用数据目录；解密材料由操作系统保护。不要把真实密钥、库内容、权限名单样例写成真实秘密。
- 测试不把真实 API Key 写进仓库。
- 改壳、preload 或 sandbox 之后：`pnpm test` 必须过，且 `pnpm build` 后窗口能起来。sandbox 下 preload 必须是可加载的 CommonJS（`out/preload/index.cjs`）。
- 当前阶段提交前跑 `pnpm docs:check`；CI 在 macOS、Windows 上以锁文件安装，运行 `pnpm test` 与 `pnpm build`。
- 功能走分支 + PR。GitHub 是源码枢纽。不要用未 push 的本机工作树当云端起点。

## 禁止

- 把已作废的 Flutter / Pydantic / 驾驶舱重新当骨架。旧合同不是现行围栏。
- 按根目录探路脚本的写法扩散到产品代码。
- 把密钥、库内容、权限名单样例写成真实秘密。
- 把尚未进围栏的摆放备忘写进**围栏篇**。施工图可以写本阶段做什么，但必须标明不是合同；像素仍未锁就写「实现时问人」。
- 把施工图里的实现取舍抄进围栏装成已定。
- 从 `vision.md` 开写功能。

具体禁令以 [已拍板决定](decisions.md) 为准，不要在这里再抄一份。

## 仓库骨架

产品骨架是 Electron + TypeScript，以根目录 `package.json` 为准。不要把已删除的 Python 探路件写回来，也不要按其写法扩散。产品性格以围栏篇为准。当前做什么以 [施工图](build.md) 为准。

## 文档与代码同步

行为与 `decisions.md` 冲突时，以围栏为准并开讨论。补测试、补界面时若发现围栏不够用，回到文档补未锁项或改已拍板条目。代码里已经成立的强制点，补进 [架构](architecture.md)，不要只留在注释里。

相关：[开源说明](opensource.md) · [施工图](build.md)

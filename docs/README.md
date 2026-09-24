# 文档地图

从这里进入 Rgent 的文档。正文只写已经拍板的围栏。未锁的实现不要装成已定方案。

改产品性格或架构时，以 [已拍板决定](decisions.md) 为对照表。先改那一篇，再改其它篇章和代码。

GitHub `docs/` 是产品性格的唯一围栏。Agent 和以后的代码以它为准。

## 建议阅读顺序

1. [理念与远期](vision.md) — 这是什么、要去哪、故意不做什么
2. [已拍板决定](decisions.md) — 原则门、产品合同、明确未锁
3. [架构](architecture.md) — 已拍板结构怎么摆
4. [施工守则](handbook.md) — 动手时能做什么、禁止做什么
5. [开源说明](opensource.md) — 许可、贡献、治理、安全披露

仓库根目录的 [README](../README.md) 只做入口，不重复总账全文。许可见 [LICENSE](../LICENSE)。参与贡献见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 各篇管什么

| 文档 | 管什么 |
|------|--------|
| [vision.md](vision.md) | 理念、远期目标、非目标 |
| [decisions.md](decisions.md) | 原则门、产品合同、明确未锁 |
| [architecture.md](architecture.md) | 进程、库布局、一场 `/` 的数据流、信任边界 |
| [handbook.md](handbook.md) | 施工纪律，避免把围栏做歪 |
| [opensource.md](opensource.md) | MIT、如何贡献、一人维护怎么拍板 |

不设独立 ADR 目录。新的重大决定写进 `decisions.md`，必要时在对应篇章补一句。

数字和禁令只写在 [已拍板决定](decisions.md)。其它篇用链接指过去，不要再抄一份。

## 用语

文档里这些词始终是同一个意思：

| 用语 | 意思 |
|------|------|
| 库 | 用户选的那个文件夹 |
| 正文 | 你看见的成品稿 |
| 账本 | 同文件里只读的讨论记录，树上没有 |
| 一场 `/` | 一次从段首斜杠开始的对话，回车或切 tab 就散场 |
| 当前这篇 | 正在看的那个笔记 tab |
| 必须遵循 / 禁止触碰 / 可参考 | 三档权限，只挡 AI |
| 技能 | prompt 说明文，不是树上的笔记，也不是 MCP |
| v0 | 围栏内第一代可演示客户端 |

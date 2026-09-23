# 文档地图

从这里进入 Rgent 的文档。正文只写已经拍板的围栏和读法，未锁的实现不装成已定方案。

改产品性格或架构时，以 [已拍板决定](decisions.md) 为对照表：先改那一篇，再改其它篇章和代码。

旧版「Flutter 通用 Agent 驾驶舱」围栏已作废，以当前各篇为准。

## 建议阅读顺序

1. [理念与远期](vision.md) — 这是什么、要去哪、故意不做什么  
2. [已拍板决定](decisions.md) — 讨论收口的总账，改围栏时先改这篇  
3. [架构](architecture.md) — 进程、ACL、页内 AI、数据放哪  
4. [施工守则](handbook.md) — 动手时能做什么、禁止做什么  
5. [开源说明](opensource.md) — 许可、贡献、治理、安全披露  

仓库根目录的 [README](../README.md) 只做入口，不重复总账全文。许可见 [LICENSE](../LICENSE)。参与贡献见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 各篇管什么

| 文档 | 管什么 |
|------|--------|
| [vision.md](vision.md) | 理念、远期目标、非目标 |
| [decisions.md](decisions.md) | 已拍板结论、编辑器内核、工具白名单、Harness/外循环、v0 阶段 |
| [architecture.md](architecture.md) | Electron 双进程、CM6、AgentHost 内循环、信任边界 |
| [handbook.md](handbook.md) | 施工纪律 |
| [opensource.md](opensource.md) | MIT、如何贡献、一人维护怎么拍板 |

不设独立 ADR 目录。新的重大决定写进 `decisions.md`，必要时在对应篇章补一句。

## 用语

文档里这些词始终是同一个意思：

| 用语 | 意思 |
|------|------|
| 库 | 用户自选的一个文件夹，内含 `.md`、附件与规则 |
| 成稿 | 给人看的笔记正文，换编辑器也应可读 |
| 幕后区块 | 同一 `.md` 里包起来的 AI 对话，默认不抢版面 |
| 即时渲染 | CodeMirror 6：文档仍是 md 字符串，非光标处用 decoration/widget 显示排版 |
| Harness | 一次页内任务的运行环境：工具、权限、刹车、校验、恢复 |
| 外循环 | 跨多次运行的自触发与接力；v0 只留方向，不实现无人值守 |
| AgentHost | 主进程里的文档操作器（Harness），不是独立聊天产品 |
| 三档 | 禁止触碰 / 可参考 / 必须遵循 |
| v0 | 围栏内第一代可安装客户端，不是商店版本名 |

# 文档地图

从这里进入 Rgent 的文档。正文只写已经拍板的围栏和读法，未锁的实现不装成已定方案。

改产品性格或架构时，以 [已拍板决定](decisions.md) 为对照表：先改那一篇，再改其它篇章和代码。

## 建议阅读顺序

1. [理念与远期](vision.md) — 这是什么、要去哪、故意不做什么  
2. [已拍板决定](decisions.md) — 讨论收口的总账，改围栏时先改这篇  
3. [架构](architecture.md) — 驾驶舱、发动机、数据与信任边界怎么摆  
4. [施工守则](handbook.md) — 动手时能做什么、禁止做什么  
5. [开源说明](opensource.md) — 许可、贡献、治理、安全披露  

仓库根目录的 [README](../README.md) 只做入口，不重复总账全文。许可见 [LICENSE](../LICENSE)。参与贡献见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 各篇管什么

| 文档 | 管什么 |
|------|--------|
| [vision.md](vision.md) | 理念、远期目标、非目标 |
| [decisions.md](decisions.md) | 已拍板结论与明确未锁项 |
| [architecture.md](architecture.md) | 双进程结构、数据流、存储与安全边界 |
| [handbook.md](handbook.md) | 施工纪律，避免把围栏做歪 |
| [opensource.md](opensource.md) | MIT、如何贡献、一人维护怎么拍板 |

不设独立 ADR 目录。新的重大决定写进 `decisions.md`，必要时在对应篇章补一句。

## 用语

文档里这些词始终是同一个意思：

| 用语 | 意思 |
|------|------|
| 驾驶舱 | Flutter / Dart 窗口进程 |
| 发动机 | Python 进程，内含 Pydantic AI 与 Harness 积木 |
| 工作区 | 用户指定的一块项目目录，Agent 只能动这里面的文件 |
| 普通 / 归档 / 删除 | 会话在本机库里的三种状态，不是三套目录 |
| v0 | 围栏内的第一代可演示客户端，不是商店版本名 |

Python 版本以根目录 `pyproject.toml` 的 `requires-python` 为准（当前 `>=3.12`）。

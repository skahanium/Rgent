# AGENTS.md

编码 Agent 的入口。产品性格不在这里。

## 先读

1. 本文
2. [docs/build.md](docs/build.md) 的「当前阶段」
3. 工程题（Agent 栈、检索、隔离）看 [docs/topics.md](docs/topics.md)，不要把那里的未开项写成代码
4. 动到壳、索引、账本、路径时：[docs/architecture.md](docs/architecture.md) 的强制点
5. 相关代码

产品合同：[docs/decisions.md](docs/decisions.md)。冲突先改围栏再改代码。

不要从 [docs/vision.md](docs/vision.md) 开写。不要把 [docs/build.md](docs/build.md) 读成已定产品方案。

## 当前阶段

**门禁及其前置文件安全。** 只做 [docs/build.md](docs/build.md) 里那一节，先看「本阶段还差」；允许修复阻塞门禁安全性的既有笔记 IO 缺陷。

## 硬停（未开，禁止实现）

- `AgentHost`、一场 `/`、身份标记落盘、技能加载、MCP 连接、联网搜索与抓页
- 设置面板像素、主题、图谱
- 向量检索、独立聊天、Linux 作为产品目标、Python / Flutter 边车
- 复用 `noteWrite` 给模型
- 建索引时把「禁止触碰」从人的那份语料抹掉
- 损坏权限名单时把它当空名单，或由程序自动覆盖
- 把未锁实现写进围栏篇装成已定

## 纪律

- 新能力先问是否服务「记笔记 / 一场 `/` / 门禁下的文件操作」
- 渲染进程不碰盘、不内嵌厂商 SDK、不自己连 MCP
- 密钥不进仓库、不进笔记库。Host 阶段用 Electron `safeStorage` 加密后把密文存应用数据目录；尚未接线时不要明文占位
- 改壳 / preload / sandbox：`pnpm test` 必须过，且 `pnpm build` 后窗口能起来（preload 为 `out/preload/index.cjs`）

## 验证

```bash
pnpm test
pnpm docs:check
```

`pnpm test` 先构建库读写的原生模块（需要系统 C++ 工具链与 Python 3），再跑类型检查与测试。改壳或 preload 时还要 `pnpm build` 并确认窗口能起。换阶段按 [施工守则](docs/handbook.md) 的四步走：改 [施工图](docs/build.md) 的「当前」与本文的「当前阶段」，两处字符串必须一致，`pnpm docs:check` 会核对。

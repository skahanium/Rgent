# Rgent

AI 原生的单机笔记兼资料库。Markdown 是真相。AI 写在文档里，不是旁边再开一个聊天室。

## 从哪读起

完整说明在 [docs/README.md](docs/README.md)。围栏从 [已拍板决定](docs/decisions.md) 读。动手看 [施工图](docs/build.md)。工程题看 [施工对象](docs/topics.md)。编码 Agent 读 [AGENTS.md](AGENTS.md)。

许可为 [MIT](LICENSE)。参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

```bash
pnpm install
pnpm test
pnpm dev
```

目标平台是 macOS 与 Windows；两个平台都要跑通测试与构建，其它平台不在支持范围。

pnpm 版本锁在 `package.json` 的 `packageManager`；pnpm 设置（含发布龄策略）在 `pnpm-workspace.yaml`。`pnpm test` 是三道门：先用 node-gyp 构建库读写的原生模块（需要系统 C++ 工具链与 Python 3），再跑 `tsc --noEmit`，最后跑 `vitest run`。提交前还要跑 `pnpm docs:check`。

`pnpm dev` 与 `pnpm build` 都会把原生模块放进构建产物目录，所以两者不依赖构建顺序。Electron 44 起不再随 `pnpm install` 装二进制，改为**首次 `pnpm dev` 时惰性下载**（约 110 MB）。网络受限时：

```bash
ELECTRON_GET_USE_PROXY=true GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:7897 pnpm dev
```

## 现状

产品骨架是 Electron + TypeScript，库的读写边界是一个受控的 Node-API 原生模块。笔记壳、正文管线、账本缝、人搜与反链、门禁（三档权限名单）已可跑。**当前阶段是身份标记**，见 [施工图](docs/build.md)。未开工：一场 `/`、`AgentHost`、技能、MCP、设置像素。

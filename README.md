# Rgent

AI 原生的单机笔记兼资料库。Markdown 是真相。AI 写在文档里，不是旁边再开一个聊天室。

## 从哪读起

完整说明在 [docs/README.md](docs/README.md)：

1. [理念与远期](docs/vision.md)
2. [已拍板决定](docs/decisions.md)
3. [架构](docs/architecture.md)
4. [施工守则](docs/handbook.md)
5. [开源说明](docs/opensource.md)

许可为 [MIT](LICENSE)。参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

```bash
pnpm install
pnpm test
pnpm dev
```

目标平台是 macOS 与 Windows。Linux 可跑测试，不是产品目标。

pnpm 版本锁在 `package.json` 的 `packageManager`；pnpm 设置（含发布龄策略）在 `pnpm-workspace.yaml`。`pnpm test` 会先跑 `tsc --noEmit`，再跑 `vitest run`。

Electron 44 起不再随 `pnpm install` 装二进制，改为**首次 `pnpm dev` 时惰性下载**（约 110 MB）。网络受限时：

```bash
ELECTRON_GET_USE_PROXY=true GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:7897 pnpm dev
```

## 现状

产品骨架是 Electron + TypeScript。文档以 `docs/` 为准。

# Rgent

AI 原生的单机笔记软件兼个人资料库。Markdown 文件是根：像普通 md 软件一样写作，也可以在同一页里调用 AI 做润色、扩写、问答。不是通用 Agent，没有第二套会话区。

桌面壳是 Electron（macOS + Windows），界面与 Agent 均为 TypeScript。库是用户磁盘上的一个文件夹。

## 从哪读起

完整说明在 [docs/README.md](docs/README.md)：

1. [理念与远期](docs/vision.md)
2. [已拍板决定](docs/decisions.md)
3. [架构](docs/architecture.md)
4. [施工守则](docs/handbook.md)
5. [开源说明](docs/opensource.md)

许可为 [MIT](LICENSE)。参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 现状

产品围栏已按当前愿景重写，请以 `docs/` 为准。Electron 应用尚未落地。根目录若仍有 Python 探路文件（`hello_world.py`、`pyproject.toml`），不是产品骨架。

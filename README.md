# Rgent

本机桌面 Agent 客户端：在 Windows 与 macOS 上圈定工作区、切换厂商与模型、让 Agent 干活，写文件前过目，任务历史留在这台机器。

驾驶舱是 Flutter 窗口，发动机是 Python（[Pydantic AI](https://ai.pydantic.dev/) + [Harness](https://github.com/pydantic/pydantic-ai-harness) 积木）。不是网页应用，也不自研一套 Agent 内核。

## 从哪读起

完整说明在 [docs/README.md](docs/README.md)：

1. [理念与远期](docs/vision.md)
2. [已拍板决定](docs/decisions.md)
3. [架构](docs/architecture.md)
4. [施工守则](docs/handbook.md)
5. [开源说明](docs/opensource.md)

许可为 [MIT](LICENSE)。参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 现状

文档体系已经按围栏写好，请以 `docs/` 为准。Flutter 壳与 Python 发动机尚未按文档落地。仓库里若有探路脚本，不是产品骨架。

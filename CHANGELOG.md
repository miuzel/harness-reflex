# 更新日志 / Changelog

## 0.3.0

### 宿主接入

- 新增 Codex CLI、pi、Kimi Code 和 OpenCode 接入；Claude Code 与 DSH 插件一并升至 `0.3.0`。各宿主适配自己的事件和返回格式，剪枝、停滞、失效纠偏与收尾判定共用核心规则。
- Codex 只能改写 MCP 工具输出，不能改写 shell 输出；回合内 MCP 工具与剪枝未在真实模型回合中验证。pi 的收尾最多请求一次续跑，不能阻断。Kimi 的剪枝只记账，收尾阻断需要 exit-2 shim。OpenCode 的 `session.idle` 不能阻断收尾。Kimi 与 OpenCode 的宿主接入仅做了离线契约测试。详见 [能力对照](README.md#宿主能力对照)。

### DSH 插件

- System One 改用连接配置：可维护多条连接，每条连接可从模型列表中选定一个模型。全新配置预置并启用 `JEV official`，凭证只读取 `JEV_API_KEY`；不会覆盖已有连接或显式停用的设置。命名凭证变量后不会回退到其他变量，面板不回显密钥。
- 设置面板编辑后自动保存，只写本次改动。保存失败时保留草稿并显示原因；只读状态不会写入。重复选择当前模型不会丢掉正在输入的文本。
- 工具结果与账本记录逐次判定的连接、请求模型及结果来源；缺少证据时不推断来源。
- 推理强度按回合判定，参考当前提示、对话历史与上一次强度。`reflex_delegate` 是单独的可选工具，需要显式开启 Delegation，且宿主工具须开放模型选择。

### 升级与分发

- 从 `0.1.0` 直接升至 `0.3.0`，没有发布过 `0.2.0`。旧账本可继续读取；旧 alpha 包 `dsh-reflex` 与 `dsh-harness-reflex` 是不同的安装，配置不会自动迁移。DSH 插件要求 `>=0.2.2-rc.1 <0.2.3`；同版本重装须加 `--force`。
- 发布构建生成七份 tarball。`harness-reflex`、`dsh-harness-reflex`、`pi-reflex` 可作为 npm 包发布；Claude Code、Codex、Kimi Code 和 OpenCode 的配置或插件包标记为 `private`，按各自 README 接入。仓库内的 `release/RELEASE-0.3.0.md` 提供安装与验证背景。

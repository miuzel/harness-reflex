# Harness Reflex v0.3.0 发布说明（草稿）

> **状态：发布就绪，未发布**。本文件是 GitHub Release 正文的真源；npm publish / tag / push / GitHub Release
> 均**未执行**，属负责人人工 gate。产物指纹见 `release/SHA256SUMS`。
> 基线：分支 `0.3.0-harnesses`。

## v0.3.0 — 五个 Harness

0.1.0 只覆盖 Claude Code 与 DSH。0.3.0 把同一套 System One 决策引擎接进了 **Codex CLI、pi、Kimi Code、
OpenCode** 四个新宿主，并做了一次前置重构；五个宿主包与核心包统一为 `0.3.0`。

### 本次新增的四个 Harness 插件

| 包 | 宿主 | 形态 |
| --- | --- | --- |
| `packages/codex-reflex/` | Codex CLI 0.163.0+ | 配置包：`hooks.json`（12 个事件）+ `config.toml`（MCP server） |
| `packages/pi-reflex/` | pi 1.x | 进程内 TypeScript 扩展，零运行时依赖；`pi.extensions` 直接加载 `src/index.ts` |
| `packages/kimi-reflex/` | Kimi Code CLI | 配置包：`hooks.toml` + `hooks/reflex-stop-exit2.sh` shim + `mcp.json` |
| `packages/opencode-reflex/` | OpenCode | JS 插件 `plugin/reflex.js` + `opencode.json` |

已有的 `packages/claude-reflex/`（Claude Code）与 `packages/dsh-harness-reflex/`（DSH）随之一起升版。

### 前置重构：`HookDecision` 与 `hook/decision.ts`

四个新宿主的钩子接入暴露出一个问题：宿主之间差异很大（事件名、payload 形状、stdout 契约、能否阻断），
而决策规则只有一套。重构把**宿主差异**收进各自的适配层（如 `pi-adapter.ts`、`codex-events.ts`），
决策本身收敛在 `src/hook/decision.ts` 的 `HookDecision` 一个类里：

- 各宿主只负责把自家 payload 归一化成统一事件、再把统一定策翻译回宿主能读的 stdout；
- 一条决策规则只在一处修改，所有宿主同时生效（`src/hook/parity.test.ts` 守住这层等价性）；
- `hook/run.ts` 是唯一入口：`harness-reflex hook <event>`，十八个事件共用一个 CLI 子命令。

### 五个 Harness 能力对照表

**能力并不对等**：宿主没给出对应钩子时，该能力就是做不到。「✅」只表示在模型侧真实生效。

| 能力 | Claude Code | DSH | Codex CLI | pi | Kimi Code | OpenCode |
|---|---|---|---|---|---|---|
| `reflex_*` 工具 | ✅ 8 个 MCP | ✅ 5 个可开关（默认 4） | ⚠️ 8 个已声明，本机未进回合内工具清单 | ✅ 进程内 | ⚠️ 8 个已声明，未真机验证 | ⚠️ 8 个已声明，未真机验证 |
| 停滞拦截 | ✅ 拒绝 | ✅ 自动 | ✅ 拒绝 | ✅ 拒绝 | ✅ 拒绝 | ✅ 抛错拒绝 |
| 结果剪枝 | ✅ | ✅ 自动 | ⚠️ **仅 MCP 工具输出，shell 输出改不了** | ✅ | ❌ **只记账不生效** | ✅ |
| 失效纠偏 | ✅ | ✅ 自动 | — | ✅ | ❌ 只记账 | ❌ 宿主无此钩子 |
| 收尾阻断 | ✅ **真阻断** | ✅ **真阻断** | ✅ 可 block | ⚠️ **只续跑一次，永不阻断**（`closing-degraded-pass`） | ⚠️ 需 exit-2 shim | ❌ **无法拦截** |
| 接入形态 | hooks + MCP | 进程内 Cordis 插件 | hooks.json + config.toml | 进程内 TS 扩展 | hooks.toml + shim | JS 插件（无 shell 钩子机制） |

四条必须如实说明的例外：

1. **Codex**：`PostToolUse` 只接受 `updatedMCPToolOutput` 一个决定字段，且只对 MCP 工具生效；
   **shell（`exec_command`）的结果无法改写**。这是宿主契约，不是接线缺陷。`reflex_prune` 仍可由模型主动调用。
2. **Kimi**：`PostToolUse` / `PostToolUseFailure` / `SubagentStop` 是 observation-only——宿主忽略返回值，
   判定只写进账本，改变不了模型看到的内容；**剪枝只记账不生效**。`Stop` 需经
   `hooks/reflex-stop-exit2.sh` 把 `decision:"block"` 转成 exit 2 才能阻断。
3. **OpenCode**：宿主没有 shell 钩子机制，唯一扩展点是 JS 插件。剪枝与停滞**生效**；但 **Stop 无法拦截**
   （`session.idle` 不带助手文本，也没有插件级否决权，异议只写 `warn` 日志）。
4. **pi**：没有任何 API 能拒绝结束回合；`agent_before_settle` 只能请求**一次**续跑。矛盾未被纠正时放行并记
   `closing-degraded-pass`——**pi 永不写 `closing-block`**。

### 已知限制与未验证项（逐条，不省略）

**未验证 —— 不得声称已支持：**

- **Kimi Code 整机未验证**：本机没有 `kimi` 可执行文件，没有任何钩子被 Kimi 真实触发过。已验证的是配置形状、
  事件名、payload 归一化与 stdout 契约（离线，`npm run test:kimi-plugin`，12 项）。
- **OpenCode 整机未验证**：插件加载、`tool.execute.before` 抛错是否真的中止调用、`output.output` 替换是否真的
  改变模型所见，均未在真实 OpenCode 上观察（离线 14 项）。
- **Codex 回合内 MCP 工具未验证**：server 定义能被 `codex mcp list --json` 读到，但 MCP 进程从未在本机启动，
  8 个工具从未进入回合内的工具清单；`tools/list` 是对 `harness-reflex mcp` 直接验证的，属根包契约、不是 Codex 的。
- **Codex 回合内剪枝未验证**：本机无可用模型端点，`PostToolUse` 的剪枝决定从未被观察到送达真实模型。
- **Codex 的 Stop 拦截**未对真实模型的完成声明验证过（阻断机制本身已验证）。
- **平台**：只在 Linux/WSL2 实测；原生 Windows 与 macOS 本版**未验证**。

**已知限制：**

- Codex 的 `hooks.json` 只从 **`$CODEX_HOME`** 加载；项目内 `hooks.json` 实测不触发（项目级路径未单独复现）。
- Codex `Stop` 的 `decision:"block"` 会被无可见上限地重试（探针数到 900+ 次），必须在 `stop_hook_active`
  为 true 时停止阻断——本运行时已遵守。
- Codex 的 `SessionEnd` 超时被宿主编排钳到 3 秒。
- Codex / Kimi / OpenCode 的 hooks 里 `args` 字段会被静默丢弃，事件名必须写进 `command` 本身。
- Kimi Code 只读**用户级** `config.toml`，没有项目级 hook 文件；`[[hooks]]` 只接受四个字段，多一个整份配置加载失败。
- OpenCode 每次拦截起一个短进程（与命令钩子同代价）。
- pi 需要 `>= 22.19.0`（根包为 `>= 18`）；其 `package.json` 的 `pi.extensions` 指向源码 `./src/index.ts`，
  即**发布会直接发 TypeScript 源码**，由 pi 自己加载。

### DSH 插件：全新配置默认带一条可用的 JEV 官方连接（g-067）

此前 DSH 插件装上后 System 1 后端是「未配置」：页面列表为空、什么都不连，用户得先手填一条连接。
现在**全新的设置文档**出厂就带一条已经激活的连接：

| 字段 | 出厂值 | 来源 |
| --- | --- | --- |
| 名称 | `JEV official` | 普通连接配置，和用户自己加的一条没有区别 |
| URL | `https://api.typesafe.ai/v1/systemone` | 项目官方默认（`DEFAULT_SYSTEMONE_ENDPOINT`），不是另抄一份字面量 |
| 模型 | `jev-latest` | 同上 |
| 凭据 | 只写变量名 `JEV_API_KEY` | 密钥值永不写入设置文档 |

它由 `Config` 的 schema 默认值提供，而 schemastery 的默认值**只在键缺失时生效**，所以「全新」与
「用户说过话」的区分完全由这条规则决定：

- **停用/删除**：删掉那一行、或改名换成自己的连接，文档里就有了 `systemOne` 块，默认值不再参与——不会被覆盖回来；
- **没有 `JEV_API_KEY`**：点名即锁定（g-059），连接报「已点名但变量为空」且**不借用** `SYSTEM_ONE_API_KEY` /
  `VLLM_API_KEY` / `OPENAI_API_KEY`，也不会偷偷回退到本地启发式 mock；
- **显式清空**：页面从不把 `systemOne.active` 或最后一行写成「unset」——那会让 Host 把整段重建成 `{}`，
  读起来又变回全新文档、把出厂行复活。清空一律写成显式空值。

### 升级说明（0.1.0 → 0.3.0）

- **版本**：根包 `harness-reflex`、`dsh-harness-reflex`、`claude-reflex` 以及新增四包统一 `0.3.0`；
  lockfile 与 `REFLEX_PLUGIN_VERSION` 同步。
- **0.2.0 未发布**，直接跳到 `0.3.0`：`0.2.0-test` 线上的 Claude Code 接入已随 0.3.0 一并发布。
- **DSH 插件重装必须 `--force`**（同版本号重装不会静默覆盖）。
- **无数据迁移**：账本 JSONL 只追加，旧记录可直接读取；配置字段无破坏性变更，`0.1.0` 的配置可继续使用。
- **新增可选依赖**：四个宿主包各自独立，未安装某个宿主则不受影响。
- 旧的 `dsh-reflex` 安装（0.1.0-alpha 时期）与新包仍是两个插件，配置不自动迁移。

```bash
# DSH 插件
dsh plugin --profile web add --force ./release/dsh-harness-reflex-0.3.0.tgz
# 根包（MCP 面）
npm install ./release/harness-reflex-0.3.0.tgz
```

### 验证与产物

基线 `91e320a` 上的七个测试套件全绿：root 234 / plugin 423 / claude 8 / codex 5 / pi 25 / kimi 12 /
opencode 14，mutation 51/51，pi 真机 e2e 10/10。

`node scripts/release-pack.mjs` → **53/53 checks passed**，7 个 tarball：
`harness-reflex-0.3.0.tgz`（147 项）、`dsh-harness-reflex-0.3.0.tgz`（138 项）、
`harness-reflex-claude-code-0.3.0.tgz`（7）、`harness-reflex-codex-0.3.0.tgz`（4）、
`pi-reflex-0.3.0.tgz`（106）、`harness-reflex-kimi-code-0.3.0.tgz`（6）、
`harness-reflex-opencode-0.3.0.tgz`（5）。

指纹以 `release/SHA256SUMS` 为准：文档随根包发布，把哈希写进文档会造成自指循环。

## 产物指纹

| 包 | 文件 |
|---|---|
| 核心/MCP | `harness-reflex-0.3.0.tgz` |
| DSH 插件 | `dsh-harness-reflex-0.3.0.tgz` |
| Claude Code | `harness-reflex-claude-code-0.3.0.tgz` |
| Codex | `harness-reflex-codex-0.3.0.tgz` |
| pi | `pi-reflex-0.3.0.tgz` |
| Kimi Code | `harness-reflex-kimi-code-0.3.0.tgz` |
| OpenCode | `harness-reflex-opencode-0.3.0.tgz` |

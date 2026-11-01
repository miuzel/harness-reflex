# Harness Reflex (System One Decision Runtime for Codex / Claude Code / AGY)

跨 Harness（**Codex CLI**、**Claude Code**、**Antigravity / AGY**）的 System One 快速决策与判定运行时插件。

统一支持各类 **System One API**（包括官方 Jev、vLLM/OpenAI logits 读出、自托管模型与本地启发式决策后端），让 Harness 在不调用笨重 System Two 推理的情况下，毫秒级实现门禁验证、上下文剪枝与死循环拦截。

---

## 先分清两个「面」（写文档、剪视频、写脚本前必看）

同一个插件在不同宿主里露出不同形状，**工具数量与自动化程度都不同**，混着讲会自相矛盾：

| | A. MCP 面（Claude Code / Codex / AGY） | B. DSH 宿主插件面（`dsh-harness-reflex`） |
|---|---|---|
| 工具 | **8 个**：`choice` `score` `route` `screen` `gate` `prune` `detect_stagnation` `status_ledger` | **5 个可开关**：`choice` `score` `route` `screen` `gate`；默认开 4 个，`route` 默认关 |
| 剪枝 / 停滞 / 收尾核验 | 需要模型**主动调用工具** | **自动干预**：`tools/post-execute`、`agent/pre-step`、`agent/turn-stopping` 钩子执行，模型不调也会发生 |
| 账本 | `reflex_status_ledger` 工具 | `/reflex-ledger` 命令 或 设置面板「账本」页（不占工具位） |
| 模型与思考等级 | 不涉及（由宿主决定） | 自动：虚拟 Provider 候选池 + 自适应 `reasoningEffort` |
| 设置面板 | 无 | **8 个页签**：概览 / 虚拟 Provider / 推理强度 / System 1 后端 / 自动干预 / 工具开关 / 账本 / 使用说明 |

一句话：**A 面是工具集，B 面是「工具 + 自动干预 + 路由」**。讲到具体数字前，先说清在讲哪个面。

---

## 五个 Harness 的能力差异（选型只看这张表）

v0.3.0 起，同一套决策引擎接进了五个宿主。**它们的能力并不对等**——宿主没有给出对应钩子时，
这个能力就是做不到，而不是「配置一下就好」。下表按「能力在模型侧是否真的生效」写：

| 能力 | Claude Code | DSH（`dsh-harness-reflex`） | Codex CLI | pi | Kimi Code | OpenCode |
|---|---|---|---|---|---|---|
| 8 个 / 5 个 `reflex_*` 工具（MCP） | ✅ 8 个 MCP 工具 | ✅ 5 个可开关（默认 4） | ⚠️ 8 个 MCP 工具已声明，**本机未进回合内工具清单** | ✅ 工具集在本进程内 | ⚠️ 8 个 MCP 工具已声明，**未在真机验证** | ⚠️ 8 个 MCP 工具已声明，**未在真机验证** |
| 停滞拦截（拒绝重复调用） | ✅ 拒绝 | ✅ 自动 | ✅ 拒绝 | ✅ 拒绝 | ✅ 拒绝 | ✅ 抛错拒绝 |
| 结果剪枝（改写工具输出） | ✅ 生效 | ✅ 自动生效 | ⚠️ **只能改 MCP 工具输出，不能改 shell 工具输出** | ✅ 生效 | ❌ **`PostToolUse` 是 observation-only：只记账不生效** | ✅ 生效（`tool.execute.after` 替换输出） |
| 失效纠偏 | ✅ 生效 | ✅ 自动生效 | — | ✅ 生效 | ❌ 只记账（`PostToolUseFailure` observation-only） | ❌ 宿主无工具失败钩子 |
| 收尾核验（阻断「我完成了」） | ✅ **真阻断** | ✅ **真阻断** | ✅ 可 block | ⚠️ **只能续跑一次，从不阻断**：记为 `closing-degraded-pass`，永不记 `closing-block` | ⚠️ 需 `hooks/reflex-stop-exit2.sh` shim 转 exit 2 才能阻断 | ❌ **Stop 无法拦截**（`session.idle` 无插件级否决权，只记 warn 日志） |
| 接入形态 | 配置 hooks + MCP | 进程内 Cordis 插件 | 配置 `hooks.json` + `config.toml` | 进程内 TS 扩展 | 配置 `hooks.toml` + shim + `mcp.json` | **JS 插件**（宿主无 shell 钩子机制） |

读法：

- **Claude Code / DSH 是完整能力**：六项能力全部在模型侧真实生效。
- **Codex 的剪枝只作用于 MCP 工具输出。** 宿主的 `PostToolUse` 只接受 `updatedMCPToolOutput` 一个决定字段，
  且只对 MCP 工具生效；**shell（`exec_command`）的结果改不了**。这不是接线缺陷，而是宿主的契约。
  `reflex_prune` 仍可作为工具由模型自己调用。另：本机没有可用模型端点，**MCP 工具从未进入 Codex 回合内的
  工具清单**，故「回合内剪枝」与「回合内 MCP 工具」均未真机验证。
- **Kimi 的剪枝只记账不生效。** `PostToolUse` / `PostToolUseFailure` / `SubagentStop` 在 Kimi Code 里是
  observation-only：宿主忽略返回值，判定仍写进账本，但改变不了模型看到的内容。只有 `PreToolUse`（拒绝）
  和 `Stop`（**经 `hooks/reflex-stop-exit2.sh` 把我们的 `decision:"block"` JSON 转成 exit 2**）能真正干预。
- **OpenCode 没有 shell 钩子机制**，唯一扩展点是 JS 插件（`Plugin = (input) => Promise<Hooks>`），所以它
  拿到的是插件而不是配置片段。剪枝与停滞**在 OpenCode 上是生效的**（这是少见的非 Claude 宿主优势）；
  但 **Stop 无法拦截**——`session.idle` 事件不带助手文本，宿主也没有插件级否决权，异议只能写进日志。
- **pi 的收尾只会降级放行。** pi 没有任何 API 能拒绝结束一个回合；`agent_before_settle` 只能请求
  **一次**续跑，它不能否决 settle。因此矛盾未被纠正时会放行并记 `closing-degraded-pass`——
  **pi 永远不会写 `closing-block`**，扩展不会假装自己做到了。

> ⚠️ **未验证项不要当已验证**：Kimi / OpenCode 的整机安装与钩子触发、Codex 的回合内 MCP 工具，
> 本机都没有对应的可用宿主，均未真机验证；验证方法逐条写在各包 README 的
> 「Verification status」小节。Claude Code 与 pi 有真机 e2e。

---

## 核心特性与架构

```
               ┌────────────────────────────────────────────────────────┐
               │              Harness Layer (Codex / Claude / AGY)      │
               └───────────┬────────────────────────────────┬───────────┘
                           │ Stdio MCP / Hooks              │
               ┌───────────▼────────────────────────────────▼───────────┐
               │                  Harness Reflex Core                   │
               │  - Gate: 逐条声明-证据核对 (Fail-Closed, Latch)         │
               │  - Stagnation: 停滞与死循环检测 (振荡/反复失败打断)        │
               │  - Prune: 工具超长结果剪枝 (Fail-Open, Shadow 模式)     │
               │  - Route: 技能/工具概率排序 (只排序，不卡死阈值)          │
               │  - Ledger: 台账与净节省 Token/成本审计                   │
               └───────────┬────────────────────────────────┬───────────┘
                           │ DecisionBackend Interface      │
       ┌───────────────────┼────────────────────────────────┼───────────────────┐
       ▼                   ▼                                ▼                   ▼
[官方 Jev API]      [simple-jev / vLLM]             [本地 Mock / 启发式]    [自托管模型]
(POST /v1/systemone (max_tokens: 1,                 (用于测试、开发与        (Qwen / DeepSeek)
  single endpoint)   next-token logprobs)             离线基准跑分)
```

1. **跨 Harness 零门槛适配**：
   - **Claude Code**：标准 MCP 协议（`.mcp.json`），提供 `reflex_gate`、`reflex_prune`、`reflex_detect_stagnation` 等工具。
   - **Codex CLI**：`.codex/config.json` 原生 MCP 挂载。
   - **Antigravity (AGY)**：Bundle 插件（`.agents/plugins/harness-reflex/`），内嵌 `plugin.json`、`mcp_config.json`、`hooks.json` 与 `rules/AGENTS.md`；hooks 调用与 Claude Code 相同的 `harness-reflex hook <event>` 分发器，自动干预能力取决于 AGY 是否消费 hook 输出（以宿主实测为准）。

2. **全套 System One 工具链（MCP 面 8 个工具，由根包 stdio server 暴露给外部客户端）**：
   - **底层通用 API**：
     - `reflex_choice`：多选一概率分布预测，毫秒级得出答案，零生成开销。
     - `reflex_score`：对代码/陈述进行 0.0 ~ 1.0 的连续标准评分。
     - `reflex_screen`：对不可信外部输入（工具输出、网页、PR 注释）做提示注入与指令劫持筛查。
   - **高阶工作流工具**：
     - `reflex_gate`：声明-证据核对门禁（反向 Fail-Closed，且支持加载离线校准曲线）。
     - `reflex_prune`：长输出提炼与剪枝（容错 Fail-Open，支持 Shadow 模式）。
     - `reflex_detect_stagnation`：停滞与死循环检测（识别重复重试、振荡与零进展）。
     - `reflex_route`：技能与工具的意图排序（只排序，不卡死阈值）。
     - `reflex_status_ledger`：决策台账与净节省 Token/成本统计。

   > 这 8 个工具**只属于 MCP 面**。DSH 宿主插件面只有 5 个可开关工具，见下面第 4 条。

3. **离线拟合校准闭环（Isotonic PAVA & Platt 回归）**：
   - 内置 `calibrate` 引擎，可基于历史标注集拟合单调映射曲线，计算 ECE 误差并输出校准配置；
   - 线上运行时自动修正过度自信的模型原始概率，杜绝盲目放行。

4. **DSH Host 插件（进程内集成，`dsh-harness-reflex`）**：
   - 除 stdio MCP 之外，同一套 System One 能力还以 **DSH Cordis Host 插件**形式在 `dsh` 进程内注册：
     `packages/dsh-harness-reflex/` 通过 `ctx.tools` 注册 **5 个可开关工具** `reflex_choice` / `reflex_score` /
     `reflex_route` / `reflex_screen` / `reflex_gate`，**默认开启前 4 个、`route` 默认关闭**。
   - **剪枝、停滞拦截、收尾核验与失效纠偏是自动干预**，不是工具：它们由宿主的
     `tools/post-execute`、`agent/pre-step`、`agent/turn-stopping` 钩子按 `interventions.mode`
     （`off` / `observe` / `active`，默认 `observe`）执行；DSH 面**没有** `reflex_prune` /
     `reflex_detect_stagnation` / `reflex_status_ledger` 三个工具。
   - 账本用 **`/reflex-ledger` 命令**（或设置面板「账本」页）读取，不经模型、不占工具位。
   - 严格参数校验沿用 Host 的 `defineTool`（必填/类型/枚举/嵌套 `additionalProperties`），工具层再拦截
     顶层未声明参数；卸载时通过单个 `ctx.effect` 摘除观察者、逆序注销工具、释放运行时，完全可逆。
   - 同时提供**虚拟 Provider 与动态模型路由**：注册虚拟 provider（默认 `reflex`），把 `reflex-auto` /
     `reflex-fast` 这类虚拟模型按配置的物理候选池用 System 1 在 `agent/request` 上毫秒级改写成真实
     `provider/model`（主代理与 subagent 都覆盖，每条决策写 `type: 'model-route'` 台账）；
     未配置候选池时**不注册**该 provider，池为空且无 `routing.fallback` 时 **Fail-Closed**。
   - 路由**上下文感知且带会话粘性**：决策请求带上本会话累积的上下文规模与当前物理模型，提示词写明
     「保留当前模型可省缓存、非必要不切」，名次相近（未超出 `stickyMargin`，默认 15%）时守住已在用的
     模型，只有明显更合适才切换；`model-route` 台账记 `currentModel` / `switched` / `contextTokens`。
   - 详见 [`docs/dsh-plugin.md`](docs/dsh-plugin.md) 与 [`packages/dsh-harness-reflex/README.md`](packages/dsh-harness-reflex/README.md)。

5. **Claude Code 插件三件套（v0.2.0）**：
   - `packages/claude-reflex/` 同时携带 **mod**（`turn.step` effort 接线）、**settings hooks**
     （PreToolUse / PostToolUse / PostToolUseFailure / Stop / SubagentStop（默认关）/ SessionStart / SessionEnd，
     逐事件调用 `harness-reflex hook <event>`）与 **MCP server**（根包 8 个 `reflex_*` 工具）。
   - 剪枝、停滞、失效纠偏 **active**；收尾核验默认 **observe**，可在插件配置里 opt-in 成 `active`。
   - 安装、配置、限制与「本环境已验证 / 需你本机验证」两栏见
     [`docs/claude-code.md`](docs/claude-code.md)；真实 `claude -p` e2e 见 `scripts/claude-e2e.sh`。

---

## 快速安装与配置

### 1. 构建
```bash
npm install
npm run build
```

### 2. 构建（含 DSH Host 插件）
```bash
# 根包 tsc → 链接本机 DSH 依赖（离线可用的软链，无需 registry）→ 插件 tsc
npm run build:all
```

### 3. 一键配置 Harness
```bash
# 自动为 Claude Code, Codex, Antigravity 全部生成配置文件与规则
node dist/cli/index.js setup all

# 或单独配置某一个
node dist/cli/index.js setup claude
node dist/cli/index.js setup codex
node dist/cli/index.js setup agy
```

### 4. 安装 DSH 插件（可选，进程内集成）

```bash
# 从本仓库产物安装；同版本重装必须加 --force（pnpm 不会静默覆盖同版本）
dsh plugin --profile web add --force ./release/dsh-harness-reflex-0.3.0.tgz

# 首次发布到 npm 后（包名 dsh-harness-reflex）：
dsh plugin --profile web add dsh-harness-reflex@0.3.0
```

安装后重启 / 重载 `dsh`，设置页会出现「Reflex 决策运行时」面板；`/dsh-reflex/api/health`
应返回 `{"ok":true,"name":"dsh-reflex","version":"0.3.0"}`。

### 5. 配置 System One 决策后端（可选）
默认内置本地快速启发式决策器（`<5ms` 延迟，零外部依赖）。可随时无缝切换到其他 System One API：

```bash
# 切换 Provider A：官方 Jev API（只有 key 是必填，地址与模型都有默认值）
export SYSTEM_ONE_API_KEY="your-api-key"

# 切换 Provider B：通用 open-weights 模型 logits 读出 (vLLM / simple-jev / OpenAI 兼容接口)
export SYSTEM_ONE_BASE_URL="http://localhost:8000"   # 只有地址是必填
export SYSTEM_ONE_BACKEND=simple-jev                 # 或不写：检测到 VLLM_BASE_URL/OPENAI_BASE_URL 会自动选中

# 切换 Provider C：离线/本地基准模拟后端（什么都不设时的默认）
export SYSTEM_ONE_BACKEND=mock
```

不设 `SYSTEM_ONE_BACKEND` 时按顺序自动判定：有 `SYSTEM_ONE_API_KEY`/`JEV_API_KEY` → `jev`；
有 `VLLM_BASE_URL`/`OPENAI_BASE_URL` → `simple-jev`；都没有 → `mock`。

| 变量 | 默认值 |
| --- | --- |
| `SYSTEM_ONE_BASE_URL` | `jev`：`https://api.typesafe.ai/v1/systemone`；`simple-jev`：`http://localhost:8000` |
| `SYSTEM_ONE_MODEL` | `jev`：`jev-latest`；`simple-jev`：`Qwen/Qwen2.5-7B-Instruct` |
| `SYSTEM_ONE_API_KEY` | `jev`：无（空串，请求会被服务端拒绝）；`simple-jev`：`dummy`（本地服务通常不校验） |

---

## 实验基准对比运行

我们内置了有无插件在真实典型场景下的对比基准：

```bash
node --experimental-strip-types experiments/index.ts
```

查看决策台账：
```bash
node dist/cli/index.js ledger
```

---

## 测试

```bash
npm test                 # 根包：ledger / score / route / route-prompt / MCP 表面 / 打包清单
npm run test:plugin      # DSH 插件：注册、严格校验、工具面与 /reflex-ledger、生命周期、虚拟 provider 路由（含上下文感知与会话粘性）、设置面板与使用说明
npm run test:claude-plugin  # Claude Code 插件：manifest/hooks/.mcp.json、7 事件、observe diff=0、崩溃放行
npm run test:all         # 构建根包 + 插件，然后跑三套测试
npm run test:mutation    # 负向对照：注入故障，要求被测试（或编译器）抓住
```

---

## 使用说明与发布产物

- **[`USER_GUIDE.md`](USER_GUIDE.md)**（中文）与 **[`docs/USER_GUIDE.en.md`](docs/USER_GUIDE.en.md)**（English）：
  插件架构、虚拟 Provider 模型池配置、自适应思考等级（`reflex` / `auto`）、System 1 后端接入、
  MCP 与原生 DSH 工具对照、决策账本、测试与发布流程。这两份文档会被嵌入插件前端，
  可在 DSH 设置页 **Reflex → 使用说明 / Guide** 标签页内直接切换中英文阅读。

```bash
npm run release:pack     # 打包两个包到 release/：结构审计 + 离线安装冒烟 + SHA256SUMS
npm run release          # 全量构建与测试通过后再打包（发布闸门）
```

产物路径：

| 产物 | 说明 |
| --- | --- |
| `release/harness-reflex-<version>.tgz` | 根包：核心运行时、CLI、stdio MCP、适配器、`dist/`（含类型与自包含 source map）、`USER_GUIDE.md`、`docs/` |
| `release/dsh-harness-reflex-<version>.tgz` | DSH Host 插件 `dsh-harness-reflex`（npm pack 命名）：`dist/`、单文件浏览器端 `client.js`（含内嵌使用说明）、`cordis.patch.yml`、`locale/` |
| `release/SHA256SUMS` | 两份 tarball 的 SHA-256 校验和 |
| `release/release-report.json` | 逐项打包核验记录（文件清单、死链、依赖声明、安装冒烟） |
| `release/RELEASE-<version>.md` | 发布说明：安装方式、核验清单、内容构成 |

`npm run release:pack` 不止于「打包成功」：它解压两份 tarball，核对必需文件、
拒绝测试构建产物、临时目录与本地绝对路径，解析全部相对引用与 source map 目标（零死链，
且不允许未声明的运行时依赖），再对根包做一次真实 `npm install`（`bin`、具名 import 与
stdio MCP `tools/list` 冒烟）。


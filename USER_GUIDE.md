# Harness Reflex 使用说明（v0.1.0-alpha.2）

> 本文档是 **`dsh-reflex` 插件** 与 **`harness-reflex` 核心包** 的完整使用手册。
> 同一份内容会内嵌进 `packages/dsh-reflex/client.js`，可在 DSH 设置面板的
> **「使用说明 / Guide」** 标签页内直接阅读（跟随 DSH 界面语言中英切换）。
> 因此修改本文档后必须重新执行 `npm run build:all`，否则面板里仍是旧版本
> （`npm run test:plugin` 会用文档摘要做漂移校验）。

---

## 1. Harness Reflex 是什么

Harness Reflex 是一个 **System One（快思考）决策运行时**：它在不调用昂贵
System Two 生成式推理的前提下，用毫秒级的概率判定完成门禁校验、上下文剪枝、
死循环拦截、模型路由与推理强度决策，并把每一次决策写进可审计的决策账本。

它有两种交付形态，能力完全相同：

| 形态 | 包 | 适用 Harness | 通信方式 |
| --- | --- | --- | --- |
| stdio MCP 服务器 | `harness-reflex` | Claude Code、Codex CLI、AGY | MCP JSON-RPC 子进程 |
| DSH Host 插件 | `dsh-reflex` | DeepSeek Harness (`dsh`) | 进程内 `ctx.tools` / Cordis 钩子 |

两者的工具名、参数与返回载荷逐字一致，因此同一个 Agent 提示词可以跨 Harness 复用。

---

## 2. 插件架构

```text
┌──────────────────────────────────────────────────────────────────────┐
│                          Harness Layer                               │
│   Claude Code (.mcp.json) · Codex (.codex/config.json) · AGY 插件包   │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ stdio MCP                        │ DSH Cordis 进程内
┌───────────────▼──────────────────┐  ┌────────────▼───────────────────┐
│ harness-reflex 核心（dist/）      │  │ dsh-reflex 插件                │
│  gate · prune · stagnation       │◄─┤  src/bridge.ts  ReflexRuntime  │
│  route · screen · score          │  │  src/tools.ts   8 个 reflex_*  │
│  ledger · calibrate              │  │  src/router.ts  虚拟 Provider  │
└───────────────┬──────────────────┘  │  src/effort.ts  推理强度拦截   │
                │ DecisionBackend     │  src/panel-*    设置面板 + API │
┌───────────────▼──────────────────┐  └────────────┬───────────────────┘
│ mock · simple-jev/vLLM · 官方 Jev │               │ settings.section
└──────────────────────────────────┘  ┌────────────▼───────────────────┐
                                      │ client.js 浏览器面板（React）   │
                                      │ 概览/虚拟 Provider/推理强度/    │
                                      │ System 1 后端/决策账本/使用说明 │
                                      └────────────────────────────────┘
```

关键模块一览（插件侧）：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | Cordis 插件入口 `apply(ctx, config)`，注册与拆除都在一个 `ctx.effect` 内 |
| `src/bridge.ts` | `ReflexRuntime`：一次激活的 backend / ledger / 校准器 / 决策服务集合 |
| `src/tools.ts` | 8 个 `reflex_*` 工具（Host `defineTool` 严格校验 + 顶层未声明参数拦截） |
| `src/router.ts` | `VirtualModelRouter`：候选池 → System 1 决策 → 降级 / Fail-Closed → 审计 |
| `src/virtual-adapter.ts` | 虚拟 provider 的 `LlmAdapter` 表面与派发层兜底 |
| `src/routing.ts` | `installModelRouting`：注册虚拟 provider，挂 `agent/pre-step`、`agent/request` |
| `src/effort.ts` | `EffortInterceptor`：每轮推理强度判定、投影与状态上报 |
| `src/session-audit.ts` | 写/读 `plugin:dsh-reflex/effort` 会话记录（不污染模型上下文） |
| `src/panel-api.ts` | 设置面板只读投影 + `/api/dsh-reflex/*` 路由（仅 loopback） |
| `src/client/*` | 浏览器半边：槽位注册、中英文案、Markdown 渲染、面板视图 |

启动顺序：DSH 载入插件 → `apply` 解析配置 → 建立 `ReflexRuntime` → 注册虚拟
provider 与请求钩子 → 注册 8 个工具 → 挂载面板路由。卸载时逆序注销，完全可逆。

---

## 3. 安装与构建

```bash
# 1) 安装依赖并构建（根包 → 链接本机 DSH 依赖 → 插件 → 浏览器 bundle）
npm install
npm run build:all

# 2) 配置目标 Harness（生成 .mcp.json / .codex/config.json / AGY 插件包）
node dist/cli/index.js setup all      # 或 claude | codex | agy

# 3) 以 DSH 插件方式安装（进程内集成，推荐）
dsh plugin add ./packages/dsh-reflex
```

`npm run build:all` 的每一步都是必需的：

1. `tsc`：根包 `src/` → `dist/`；
2. `node scripts/link-dsh-deps.mjs`：把本机 DSH 的 `@deepseek-ai/*` 软链进
   `packages/dsh-reflex/node_modules/`（完全离线，不访问 registry）；
3. `tsc -p packages/dsh-reflex/tsconfig.json`：插件 Host 半边 → `packages/dsh-reflex/dist/`；
4. `node scripts/embed-user-guide.mjs` + `tsc -p tsconfig.client.json` +
   `node packages/dsh-reflex/dist/client-bundle.js packages/dsh-reflex`：
   把本文档内嵌进浏览器半边并产出单文件 `client.js`。

> 构建顺序不可交换：`client.js` 必须晚于本文档的修改，否则面板显示的说明与仓库文档不一致。

---

## 4. System 1 后端接入配置

三种后端共用一套 `SYSTEM_ONE_*` 环境变量与插件配置项，选择顺序为
「插件配置 > 环境变量 > 默认 mock」。

| 后端 | 取值 | 说明 |
| --- | --- | --- |
| 本地启发式（默认） | `mock` | 确定性、零网络、亚毫秒级；用于离线开发与测试 |
| 通用 logits 读出 | `simple-jev` | vLLM / OpenAI 兼容接口的 `max_tokens: 1` + `next-token logprobs` |
| 官方 Jev / System One API | `jev` | `POST {BASE_URL}/v1/...`，需 API Key |

```bash
# 官方 Jev
export SYSTEM_ONE_BACKEND=jev
export SYSTEM_ONE_API_KEY="your-api-key"
export SYSTEM_ONE_BASE_URL="https://api.typesafe.ai/v1/systemone"

# 自托管 vLLM（OpenAI 兼容）
export SYSTEM_ONE_BACKEND=simple-jev
export SYSTEM_ONE_BASE_URL="http://localhost:8000"
export SYSTEM_ONE_MODEL="Qwen/Qwen2.5-7B-Instruct"
```

插件配置项（可在设置面板「System 1 后端」页编辑，或写进 DSH 插件配置）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `auto` | `auto` 按环境变量判定，也可强制 `mock` / `simple-jev` / `jev` |
| `baseUrl` | 省略 | System 1 服务地址；省略时用后端默认值 |
| `model` | 省略 | 服务端模型 ID（`simple-jev` 必填） |
| `apiKeyEnv` | `SYSTEM_ONE_API_KEY` | **只记录环境变量名**，密钥本身不进入设置文档 |
| `timeoutMs` | `2000` | 单次判定超时；超时按 `System 1 不可用` 走降级路径 |

校准曲线（可选）：用 `calibrate` 引擎基于历史标注集拟合 ECE/PAVA 曲线，再用
`calibrationPath` 指向该 JSON，运行时会自动修正过度自信的原始概率。

---

## 5. 虚拟 Provider 与模型池

**概念.** 插件注册一个虚拟 provider（默认 id `reflex`），它自己不产生任何
token：当请求落到 `reflex/reflex-auto` 这类虚拟模型上时，`agent/request` 钩子会
用 System 1 从该虚拟模型配置的**物理候选池**里选出一个真实 `provider/model`，
改写请求配置后继续派发，并写一条 `type: model-route` 台账。

配置结构（等价 YAML）：

```yaml
routing:
  enabled: true
  virtualProvider: reflex
  maxTaskChars: 400          # 每个 agent 参与打分的任务文本上限
  fallback: deepseek:deepseek-chat   # 池无法回答时的降级目标
  models:
    reflex-auto:             # 虚拟模型 ID
      - provider: deepseek
        model: deepseek-reasoner
        description: 长链路推理与代码重构
        tags: [reasoning, expensive]
      - provider: deepseek
        model: deepseek-chat
        description: 日常问答与快速编辑
        tags: [fast, cheap]
    reflex-fast:
      - provider: deepseek
        model: deepseek-chat
        description: 低延迟场景
        tags: [fast]
```

**规则与边界.**

- `enabled: false` 或 `models` 为空 ⇒ 不注册虚拟 provider，行为与未安装插件一致。
- 候选池为空且未配置 `fallback` ⇒ **Fail-Closed**：报错而不是乱派发。
- `virtualProvider` 不能包含 `:`；候选的 `provider` 与 `model` 都不能为空。
- 主代理与 subagent 都走同一条拦截链路，抗循环标识（loop identity）在改写后保持不变。
- 每次路由的候选、选择、置信度与耗时都会进账本，可在「决策账本」页回看。

**上下文感知与会话粘性（省缓存、非必要不切换）.** 换模型会让服务端的提示词前缀
缓存整体失效，因此路由不是「每轮重新选一次」，而是**默认守住这台会话已经在用的物理
模型**：

- 插件按 agent 累计本会话已观测到的上下文规模（`agent/pre-step` 送进来的输入字符数，
  按 4 字符 ≈ 1 token 折算），每次决策都把它和**当前物理模型**一起交给 System 1
  （请求里的 `state.currentModel` / `state.contextTokens` / `state.contextChars`）。
- 决策提示词里会同时给出这条策略：保留当前模型能保住提示词缓存，只有另一个候选
  **明显更合适**时才切走；候选清单里当前模型还带
  `[current model — keeping it preserves the prompt cache]` 标记与 `current: true` 标志，
  文本型后端和结构化后端都能读到同一个信号。
- 后端排出名次后还有一道**粘性闸门**：挑战者必须分数更高、且高出当前模型
  `stickyMargin`（默认 15%）的相对幅度，才会真的切换；并列或只是略优都保持不动。
- 账本的每条 `model-route` 都记下 `currentModel`、`switched` 与 `contextTokens`，
  于是「这轮为什么没换模型」是可回看的，而不是靠猜。
- 粘性只在**同一个候选池**内生效：当前模型不在本轮候选里（例如换到另一个虚拟模型）
  时，决策照常按 System 1 的名次走，`switched` 记为 `true`。

**在设置面板里配置.** 打开 DSH 设置 →「Reflex 决策运行时」→ **虚拟 Provider**：
顶部开关启用路由；填写虚拟 Provider 名称、兜底目标、任务文本预算；在「模型池」
里新增虚拟模型与候选（上移/下移调整顺序），点 **保存** 整体写回。面板的写入
会先过一遍 Host 侧同一个 `resolveConfig` 校验器，非法配置（空 ID、重复模型、
跨组错误）会被直接拒绝并给出对应错误文案。

---

## 6. 自适应思考等级（`reflex` / `auto`）

把推理强度策略设为 `reflex`（别名 `auto`）后，插件会在每轮真正发起 API 请求前
拦截输入意图与上下文，用 System 1 判定本轮需要的 `reasoningEffort`，再改写实际
下发的参数。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `effort.reasoningEffort` | 省略 | `reflex` / `auto` = 每轮自适应；`off`/`minimal`/`low`/`medium`/`high`/`max` = 钉死档位；省略 = 完全不干预 |
| `effort.fallback` | `medium` | System 1 不可用或置信度低于下限时，确定性线索投票的兜底档 |
| `effort.minConfidence` | `0.55` | 低于该置信度的判定不直接采用，改走兜底 |

**行为约定.**

- 显式由调用方钉死的 `reasoningEffort` 永远保持透明，插件不会覆盖；
- 目标模型不支持思考等级时安全降级，不会把参数原样塞给非思考模型；
- 每一轮都会向会话写入一条审计记录（`plugin:dsh-reflex/effort`），其中只包含
  判定档位、置信度与截断后的任务摘录，**不进入后续模型上下文**；
- 判定结果同时投影到状态栏，可在「概览」页看到最近一次决策
  （形如 `reflex: high (confidence 0.82, system-one, 12.4 ms)`）。

---

## 7. 设置面板（DSH Settings UI）

插件通过 `dsh.client` 声明浏览器半边，注册到设置面板的 `settings.section` 槽位：

| 标签页 | 内容 |
| --- | --- |
| 概览 | 决策计数、节省 token、平均时延、门禁通过/失败、最近一次自适应决策 |
| 虚拟 Provider | 路由开关、虚拟 Provider 名称、模型池增删与排序、兜底目标 |
| 推理强度 | 策略（`reflex`/`auto`/具体档位）、兜底档、最小置信度 |
| System 1 后端 | 后端实现、Base URL、模型 ID、API Key 环境变量名、超时 |
| 决策账本 | 实时指标、最近决策表、落盘路径、清空（需二次确认） |
| **使用说明** | **本手册的只读视图，跟随 DSH 界面语言中英切换** |

- 页面是**整组写回**：改一个字段会让该配置组整体过一次 Host 校验后保存；
- Host 文档只读时页面自动进入只读模式，写操作按钮禁用；
- 面板路由 `/api/dsh-reflex/*` 只接受 loopback 客户端，清除账本必须显式确认。

---

## 8. MCP 工具 ↔ DSH 原生工具对照

两种形态暴露**同一套 8 个工具**，参数与返回载荷一致；区别仅在注册方式与调用开销。

| 能力 | MCP 工具名（`harness-reflex mcp`） | DSH 进程内工具名（`dsh-reflex`） | 主要参数 |
| --- | --- | --- | --- |
| 多选一分类 | `reflex_choice` | `ctx.tools` 注册的 `reflex_choice` | `question`, `options[]` |
| 连续评分 | `reflex_score` | `reflex_score` | `statement`, 可选 `rubric` |
| 提示注入筛查 | `reflex_screen` | `reflex_screen` | `payload`, 可选 `source` |
| 声明-证据门禁 | `reflex_gate` | `reflex_gate` | `claims[]` 或 `statement`+`evidence` |
| 长输出剪枝 | `reflex_prune` | `reflex_prune` | `text`, 可选 `query` |
| 停滞检测 | `reflex_detect_stagnation` | `reflex_detect_stagnation` | `recentAction`, 可选 `history[]` |
| 候选排序 | `reflex_route` | `reflex_route` | `goal`, `candidates[]`, 可选 `topK` |
| 账本审计 | `reflex_status_ledger` | `reflex_status_ledger` | 无（返回 `LedgerSummary`） |

差异点：

- 工具名前缀可配置（`toolPrefix`，默认 `reflex_`），例如改成 `rv_` 后是 `rv_gate`；
- DSH 侧参数校验由 Host 的 `defineTool` 完成（必填/类型/枚举/嵌套），工具层再拦
  截顶层未声明参数；MCP 侧由 `harness-reflex` 自己校验并返回结构化错误；
- `reflex_status_ledger` 在 DSH 侧返回的是**本次激活**的账本汇总；账本是否落盘
  取决于 `ledgerPath`（省略时只留内存，不写用户项目）。

---

## 9. 决策账本与审计

每次判定都会追加一条 JSONL 记录（`type` 取值：`gate`、`prune`、`stagnation`、
`route`、`model-route`、`effort`、`choice`），字段包含后端、耗时、置信度、
节省 token 估算与截断后的详情。查看方式：

```bash
node dist/cli/index.js ledger      # 终端查看汇总
```

- `ledgerPath` 省略 ⇒ 仅内存，关掉进程即消失（默认，用户项目零污染）；
- 配置了路径 ⇒ 追加写 JSONL 并支持回放，面板「决策账本」页显示落盘路径；
- 面板清空账本需要连续两次点击确认，第二次才真正删除记录与 JSONL 文件。

---

## 10. 测试与发布

```bash
npm test                 # 根包：ledger / score / MCP 表面 / 打包清单
npm run test:plugin      # DSH 插件：注册、严格校验、8 个工具、路由、推理强度、面板、使用说明
npm run test:mutation    # 负向对照：注入故障，要求测试套件（或编译器）全部抓住
npm run test:all         # build:all + 两套测试
npm run release          # 全套测试 + 打包并校验 release/ 下的 tarball
npm run release:pack     # 只打包并校验（不跑测试；注意需先 build:all）
```

发布产物（`release/`）：

| 产物 | 内容 |
| --- | --- |
| `harness-reflex-<version>.tgz` | 根包：`dist/`、`README.md`、`docs/`、`USER_GUIDE.md`、`experiments/` |
| `dsh-reflex-<version>.tgz` | 插件：`dist/`、`client.js`（内含本手册）、`cordis.patch.yml`、`locale/` |
| `SHA256SUMS` | 上述两份 tarball 的 SHA-256 校验和 |
| `release-report.json` | 逐项打包核验记录（文件清单、死链、依赖声明、安装冒烟） |
| `RELEASE-<version>.md` | 发布说明：安装命令、核验清单、内容构成 |

校验脚本 `scripts/release-pack.mjs` 会解压 tarball 逐个断言：必需文件齐全、
无测试构建与临时目录、`exports`/`bin`/`dsh.bundle.patch` 目标真实存在、每个相
对引用与 sourcemap 都能在包内解析（零死链），并在临时目录里真装一次根包、
跑通 `import` 与 stdio MCP `tools/list`。

---

## 11. 常见问题排查

| 现象 | 原因与处理 |
| --- | --- |
| 设置里找不到「Reflex 决策运行时」 | Host 半边未加载或未注册配置命名空间；确认 `dsh plugin add` 后重启/重载 `dsh` |
| 面板显示只读 | 当前 DSH 设置文档不可写；只读模式下所有写操作被禁用属预期行为 |
| 虚拟模型报错而不是派发 | 候选池为空且没有 `routing.fallback`；补候选或配置兜底目标 |
| 文本没有按预期被路由 | 检查 `routing.enabled`、虚拟模型 ID 拼写，以及 Agent 是否真的请求了该虚拟模型 |
| 推理强度没变化 | 策略设置为省略 = 不干预；或者调用方显式钉死了 `reasoningEffort` |
| System 1 判定总是走兜底 | `timeoutMs` 过小、`baseUrl` 不可达，或 `minConfidence` 过高；先看「概览」页的最近决策与后端状态 |
| 面板里的使用说明是旧版本 | 修改 `USER_GUIDE.md` 后未重新构建；执行 `npm run build:all` |

---

## 12. 版本与兼容性

- 版本：`harness-reflex` 与 `dsh-reflex` 同步发布，v0.1.0-alpha.2；
- Node：`>= 18`（根包 `engines`）；DSH Host 依赖 `@deepseek-ai/*@0.2.1-alpha.4`；
- 插件以 `peerDependencies` 声明 Host 契约，运行时不重复打包 Host 模块；
- stdio MCP 的 8 工具表面自 v0.1.0 起冻结，Host 侧变更不得静默改动其载荷。

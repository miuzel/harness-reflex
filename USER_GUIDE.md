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

两者共享工具名、主要参数与返回载荷，同一个 Agent 提示词可以跨 Harness 复用；
参数及校验边界以第 9 节和各表面实际工具定义为准。

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
provider 与请求钩子 → 注册默认 4 个工具（`route` 打开后 5 个）→ 注册
`/reflex-ledger` 命令 → 挂载面板路由。卸载时逆序注销，完全可逆。

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
| `effort.reasoningEffort` | 省略 | `reflex` / `auto` = 每轮自适应；省略 = 不干预，插件完全不碰 `reasoningEffort`；具体档位请在模型选择器里选择，配置不再接受 |
| `effort.fallback` | `medium` | System 1 不可用或置信度低于下限时，确定性线索投票的兜底档 |
| `effort.minConfidence` | `0.55` | 低于该置信度的判定不直接采用，改走兜底 |
| `effort.enabled` | `true` | 设为 `false` = 整层关闭：不判定、不审计、不注入 `reflex` 档位 |

配置只回答一个问题：**要不要启用自适应**。

- **留空（默认）= 不干预**：插件完全不改写 `reasoningEffort`，不产生判定与审计记录，行为与未安装该功能一致；
- **`reflex`（别名 `auto`）= 自适应**：每轮按 System 1 判定本轮档位；
- **想固定思考深度**：请在模型选择器里选择具体档位。配置不再接受
  `off`/`minimal`/`low`/`medium`/`high`/`max`，写入这些值会在启动时被拒绝并提示
  迁移位置，而不是被静默忽略。

**行为约定.**

- 调用方在请求里显式选择的具体档位永远保持透明，插件不会覆盖；
- 目标模型不支持思考等级时安全降级，不会把参数原样塞给非思考模型；
- 每一轮都会向会话写入一条审计记录（`plugin:dsh-reflex/effort`），其中只包含
  判定档位、置信度与截断后的任务摘录，**不进入后续模型上下文**；
- 判定结果同时投影到状态栏，可在「概览」页看到最近一次决策
  （形如 `reflex: high (confidence 0.82, system-one, 12.4 ms)`）。

**关掉整层（`effort.enabled: false`）.**

`effort.enabled` 是**能力开关**，与「策略是什么」相互独立：`reasoningEffort: reflex`
加上 `enabled: false` 是合法组合，语义等于完全不装这一段拦截（区别只在于配置仍
写着策略）。关闭后：

- **不判定**：不发起 System 1 调用、不做线索投票、不写判定缓存，也不发布
  `reflex/effort` 状态——「概览」页不会出现本插件的最近决策；
- **不审计**：账本里没有 `effort-decision` 记录，会话日志里也没有
  `plugin:dsh-reflex/effort` 记录；
- **不注入档位**：本插件注入的那一档（`reflex` / `auto`）从模型选择器里撤销，
  只保留适配器自己声明的档位与其默认档；
- **具体档位原样下发**：调用方在请求里显式选择的 `high`、`medium` 等连「对齐到目标
  模型词表」的改写都不做，逐字节保持原样；
- **标记安全兜底**：旧会话或手工构造的调用里若仍带着本插件的标记，标记在**物理
  适配器边界被删除**，而不是被翻译成一个档位——最终生效的是 provider 自己的默认
  档，插件标记永远不会泄漏给真实 provider。

默认 `true`（省略即 `true`），因此不写这一项的行为与之前逐字节一致。

---

## 7. 自动干预门禁（`off` / `observe` / `active`）

插件可以在**模型没有调用任何 `reflex_*` 工具**的情况下，用宿主原生钩子自行干预。
开关只有一处：`interventions.mode`，取值 `off` / `observe` / `active`，默认 `observe`：

```yaml
interventions:
  mode: observe        # off | observe | active
  capabilities:        # 可选：四大能力分别覆盖，inherit 表示跟随 mode
    stagnation: inherit
    prune: inherit
    gate: inherit
    closing: inherit
  maxInterventionsPerTurn: 3
  maxJudgmentsPerTurn: 3
  maxJudgmentsPerSession: 20
```

四大能力各自是**四态**：`off` / `observe` / `active` 显式覆盖 `mode`，`inherit`
（或省略）跟随 `mode`。因此可以整体保持 `active`，只把 `prune` 单独降为
`observe`（只记账不剪枝），或反过来把整体设为 `off` 而只放开 `gate`。

| 模式 | 行为 |
| --- | --- |
| `off` | 不注册任何钩子监听器；工具执行与不装插件逐字节一致 |
| `observe`（默认） | 完整检测与判定，只记账不执行：不改写 content、不注入消息、不拒绝工具、不 steer |
| `active` | 完整链路：重复调用在执行前拒绝、超长结果在进入上下文前剪枝、重复失败改写为纠正反馈、回合收尾对有证据冲突的结论提出异议 |

| 能力 | 钩子 | `active` 时的动作 |
| --- | --- | --- |
| `stagnation` | `tools/pre-execute`、`agent/pre-step` | 判定重复/振荡后拒绝该次调用，或在下一次 step 注入纠正上下文 |
| `prune` | `tools/post-execute` | 结果超阈值时先保留原件再改写：原文写入会话日志并给出定位符，改写文本保留首尾并在中间标注定位符 |
| `gate` | `tools/post-execute` | 同一调用连续失败达阈值时，把结果改写为纠正反馈；失败与否只看工具源保证的结构化退出码或宿主退出标记 |
| `closing` | `agent/turn-stopping` | 用 `reflex_gate` 复核本回合的结论与证据，矛盾时 steer 一次 |

### 合法等待为什么不会被当成停滞（豁免默认值）

等待后台作业是合法行为，因此 `stagnation` 对**可结构识别的等待型调用**做了豁免。
判定只看两个结构化事实，**不读工具描述、也不读任何输出文本**：

1. **工具身份**：调用的是宿主自己的后台作业查询工具 `job_output`、`job_list`
   （由 `@deepseek-ai/dsh-tool-jobs` 注册，shell 工具的后台作业也统一走 `job_output`）；
2. **调用形态**：参数是宿主自己声明的作业句柄字段（`job_output` 的 `job_id` 非空字符串；
   `job_list` 本身无参数，故以空参数对象为其形态）。

命中豁免的调用：不产生拒绝、不注入纠正上下文、不消耗 turn 的干预与判定额度，
`observe` 与 `active` 的计划完全一致；它仍会记录进检测窗口，只是不计入「无进展重复」
（重复、失败重试、振荡三类触发都跳过它），因此**真正的循环并不会因为中间等了一次作业而消失**。
`job_kill` 刻意不在豁免内——它是终止动作，不是等待查询。
输出文本里出现 `wait` / `sleep` / `poll` 等字样不构成任何豁免。
范围即上表所列的两个工具名；这是文档化的默认值，无需额外配置。

### 被剪掉的原文如何取回

`active` 剪枝的次序是「先保留、后替换」，这一步不能只有措辞：

1. 判定通过、且**保留成功**之后，才生成改写文本；
2. 原文以 `plugin:dsh-reflex/pruned-original` 记录写进会话日志（宿主 `appendPluginRecord`），
   不进入模型可见面，`fork` / `resume` 会随日志一起带走；
3. 改写文本中间带上定位符 `plugin:dsh-reflex/pruned-original#<digest>`，模型因此随时可以
   要求取回被省略的部分；
4. 保留失败（没有会话、日志缺失、写回校验不过）时**不替换**，也不计 `actualSavedTokens`，
   结果逐字节保持原样（记为 `retention-failed`；这次判定已经付出，仍照实记账）。

取回就是拿同一条定位符读会话事件：

```ts
import { readPrunedOriginal } from 'dsh-reflex';

const record = readPrunedOriginal(session.ownEvents(), locator);
record?.text;    // 逐字节原文
record?.chars;   // 保留时的字符数
record?.digest;  // 与决策记录里的 digest 一致
```

下限 `pruneFloorRatio`（默认 0.5）是**安装文本占原文的最小比例**：判定给出的候选若低于它，
就用首尾上下文补足到该比例；判定选中的中间诊断整体保留，不会被下限挤掉。
可保留的载荷有边界：换行少于 4 个（不足 5 行）或超过 100 000 字符时不做剪枝
（分别记为 `unsupported-payload` / `retention-too-large`），单行输出与超大日志原样通过；
同一载荷重复出现时复用第一次保留的原件，不重复写日志。

### 成本与可追溯

- 账本按 `mode` 与 `capability` 分列：`plans`（计划了几次）、`applied`（真正执行了几次）、
  `judgments` / `memoHits`（判定与判定缓存命中）、`judgeTokens`（判定消耗的 token）、
  `originalTokens` / `candidateTokens` / `potentialSavedTokens`（本可节省）/ `actualSavedTokens`（真正少带进上下文的量）；
- `observe` 的 `actualSavedTokens` 恒为 0，`potentialSavedTokens` 与同输入的 `active` 逐项一致；
- 判定成本单独计：`localLatencyMs`（本机仲裁）与 `remoteLatencyMs`（后端判定）分开统计；
- 每条剪枝记录都带被替换原文的 `digest`、`turn`/`step` 与定位符 `originalLocator`；用定位符即可读回逐字节原文（见上「被剪掉的原文如何取回」）；
- 保留是替换的前提：保留不成功就不替换、不计 `actualSavedTokens`，`plans` 也不谎报一次没发生的缩减；
- `off` 严格零行为：不注册任何监听器、不采样、不判定，与不装插件逐字节一致；
- 判定缓存以「回合 + 尾部窗口」为键：同一个问题一个回合只付一次；`maxJudgmentsPerTurn`、
  `maxJudgmentsPerSession`、`maxInterventionsPerTurn` 分别是每回合判定、每会话判定、每回合干预的次数上限；
- 同一 `(agent, 调用签名)` 的干预在一个回合内去重；被本插件拒绝的那次调用的返回值不再二次判定；
- 本插件自己注册的工具永不进入判定（它们的结果已经是优化产物；默认 4 个，打开
  `route` 后 5 个），这些 `reflex_*` 载荷不受干预影响。

### 安全与回退

- **fail-open**：任一判定环节抛错都直接放行下游结果（记为 `planning-error`），不会让工具调用失败；
- **判失败不靠措辞**：以结果的结构化 `exitCode`/`signal` 为准，其次才是宿主追加在末行的退出标记；正文里出现 “failed” 不算失败，也不会因此拦下一次合法重试；
- **权限单调**：`tools/pre-execute` 只在下游给 `allow` 时追加一条 `deny`；下游给 `ask`/`deny`/`cancel` 时按原对象原样返回（含 `info`），既不放宽也不覆盖；
- **会话隔离**：检测窗口、判定缓存与次数上限都按 agent 记账，多 agent 互不共享；
- **卸载无残留**：插件卸载时解除全部监听器并清空引擎状态；账本默认只在内存（未设 `ledgerPath` 时不落盘）。

---

## 8. 设置面板（DSH Settings UI）

插件通过 `dsh.client` 声明浏览器半边，注册到设置面板的 `settings.section` 槽位：

| 标签页 | 内容 |
| --- | --- |
| 概览 | 决策计数、节省 token、平均时延、门禁通过/失败、最近一次自适应决策 |
| 虚拟 Provider | 路由开关、虚拟 Provider 名称、模型池增删与排序、兜底目标 |
| 推理强度 | 策略（不干预 / Reflex 自适应）、兜底档、最小置信度、**自适应推理强度开关** |
| 自动干预 | 三态模式（`off`/`observe`/`active`）、四大能力覆盖、每回合干预次数上限、每回合判定上限、每会话判定上限、重复阈值、失败阈值、最小置信度、判定窗口大小、剪枝下限比例；并列出当前生效的模式与能力（只读） |
| 工具开关 | 5 个能力逐项启停（默认 4 开、`route` 关）；每项写明**做什么 / agent 何时该调用 / 是否建议暴露**，并有「应用推荐组合」按钮；页尾列出当前已注册的工具名（只读，跟随 `toolPrefix`），并提示账本改用 `/reflex-ledger` |
| System 1 后端 | 后端实现、Base URL、模型 ID、API Key 环境变量名、超时；以及工具名前缀、裁剪阈值、账本 JSONL 路径、校准曲线路径 |
| 决策账本 | 实时指标、最近决策表、落盘路径、清空（需二次确认） |
| **使用说明** | **本手册的只读视图，跟随 DSH 界面语言中英切换** |

- 页面是**整组写回**：改一个字段会让该配置组整体过一次 Host 校验后保存（System 1
  后端页覆盖 `backend`、`systemOne`、`toolPrefix`、`ledgerPath`、`pruneThreshold`、
  `calibrationPath` 六条配置路径，保存时逐条整值写入）；
- Host 文档只读时页面自动进入只读模式，写操作按钮禁用；
- 面板路由 `/api/dsh-reflex/*` 只接受 loopback 客户端，清除账本必须显式确认。

### 各组的写回范围

面板永远显示**当前生效值**，且保存走的是 Host 设置文档的唯一写入通道（按组
`set` + 修订号校验），不存在第二条写入路径。各组写回粒度不同：

- **自动干预：整组写回**。保存该组时，面板把该组当前的**模式与全部预算值一次性
  完整写入**（与虚拟 Provider、推理强度等组一致），所以配置里留下的是你在面板上
  看到的那一份完整取值，而不是只有被改过的那一个字段；其中能力覆盖只写「不等于
  `inherit`」的项，其余保持省略（省略 = 跟随模式）。
- **工具开关：只写与默认不同的项**。只有偏离该后缀默认值的开关会写进
  `tools.enabled`：默认开启的工具被关掉写 `false`，默认关闭的 `route` 被打开写
  `true`；把任何一项改回默认值都会**删除**该键。因此「推荐组合」与「整组省略」
  逐字节等价，默认配置下配置内容零变化（默认已经是 4 开 1 关）。
- **推理强度开关：总是显式写入**。`effort.enabled` 随该组写下当前值，避免出现
  「面板显示已启用、配置里其实是省略」的歧义。
- **System 1 后端：逐条 schema 路径整值写入**。Host 的设置文档按**配置路径**寻址，
  而该页覆盖的是 `backend`（标量）、`systemOne`（连接块）以及 `toolPrefix`、
  `ledgerPath`、`pruneThreshold`、`calibrationPath` 四个顶层字段：保存时这几条路径
  各自整值写入（只写发生变化的那一组），**页面名不会被当成配置键**——`runtime`
  并不是 `Config` 的字段，按页面名写入会被 Host 直接拒绝，整次保存随之失败。留空的
  `ledgerPath`/`calibrationPath` 以「取消设置」写入，效果等于沿用下层配置而不是写空串。

非法值（未知工具后缀、非布尔值、越界预算、非法三态取值）由 Host 侧同一个
`resolveConfig` 校验器拒绝并给出字段级错误文案，面板不会部分生效——要么整组通过，
要么一个字都不写。

### 工具开关：两类建议与推荐组合

工具开关页的每一项都写清三件事：**这个能力做什么**、**agent 在什么情况下应该调用
它**、以及一条**是否建议暴露给 agent** 的标签：

| 建议标签 | 含义 | 能力 |
| --- | --- | --- |
| 建议暴露 | agent 日常确实会用 | `choice`、`score`、`screen`、`gate` |
| 按需开启 | 候选很多时先缩小范围才有用，默认关闭 | `route` |

页首的「**应用推荐组合**」按钮按上表预填这 5 个开关，并把 `route` 关掉。**这个
推荐组合就是默认值**：`tools.enabled` 省略时，`choice`、`score`、`screen`、`gate`
开、`route` 关，DSH 插件侧默认暴露 4 个工具。按钮只预填草稿、不落盘：仍需点
「保存」；草稿若已经等于默认值，保存**不写任何内容**（没有需要记录的差异）。

`route` 是可选增强：打开它（面板开关，或配置里写 `tools: { enabled: { route: true } }`）
才会注册 `reflex_route`；不开也不影响主流程。

还有三项能力**已经不是工具**，因此这里没有它们的开关：`prune`（结果剪枝）与
`detect_stagnation`（停滞检测）由自动干预层直接驱动，随 `observe`/`active` 生效；
账本汇总改由 `/reflex-ledger` 命令读取。页尾有一行提示指出这两条去路；stdio MCP
侧仍保留同名的 8 个工具，见下一节。

---

## 9. MCP 工具 ↔ DSH 原生能力对照

两种形态**不再共享同一套工具**：stdio MCP 侧仍然暴露自 v0.1.0 起冻结的 **8 个工具**，
DSH 插件侧只注册 **5 个可开关的能力（默认 4 个）**——另外三项能力改由自动干预与一条
命令承载，不再占用模型的工具清单。

| 能力 | MCP 工具名（`harness-reflex mcp`） | DSH 插件侧（`dsh-reflex`） | 主要参数 | 建议 |
| --- | --- | --- | --- | --- |
| 多选一分类 | `reflex_choice` | 工具 `reflex_choice` | `question`, `options[]`, 可选 `context` | 建议暴露 |
| 连续评分 | `reflex_score` | 工具 `reflex_score` | `statement`, 可选 `criteria`, `context` | 建议暴露 |
| 提示注入筛查 | `reflex_screen` | 工具 `reflex_screen` | `content`, 可选 `source`, `strict` | 建议暴露 |
| 声明-证据门禁 | `reflex_gate` | 工具 `reflex_gate` | `assertions[{statement}]`, `evidence`, 可选 `strictness` | 建议暴露 |
| 候选排序 | `reflex_route` | 工具 `reflex_route`（**默认不注册**） | `goal`, `candidates[]`, 可选 `topK` | 按需开启 |
| 长输出剪枝 | `reflex_prune` | 无工具：结果剪枝由 `tools/pre-execute` 等钩子按干预模式自动执行 | `rawOutput`, 可选 `intent`, `shadowMode` | — |
| 停滞检测 | `reflex_detect_stagnation` | 无工具：停滞检测是自动干预的一部分 | 可选 `recentAction`, `goal`, `history[]` | — |
| 账本审计 | `reflex_status_ledger` | 无工具：改用 `/reflex-ledger` 命令（无参数） | 可选 `includeEntries`（返回 `summary`，可附 `recentEntries`） | 人读 |

差异点：

- 工具名前缀可配置（`toolPrefix`，默认 `reflex_`），例如改成 `rv_` 后是 `rv_gate`；
- DSH 侧参数校验由 Host 的 `defineTool` 完成（必填/类型/枚举/嵌套），工具层再拦
  截顶层未声明参数。MCP 侧发布 `inputSchema` 供客户端使用，但分派器不执行通用
  JSON Schema 校验；错传 `claims` 而非 `assertions` 会进入空断言门禁，返回
  `passed: false`、`needsEscalation: true`、`results: []`，不是 JSON Schema 错误。
  执行异常返回工具结果 `isError: true`。DSH 另支持断言内可选 `criteria`，MCP 未声明此嵌套字段；
- DSH 侧的账本读取**不经过模型**：`/reflex-ledger` 由 Host 直接渲染为文本（汇总 +
  最近 5 条），也没有工具参数；账本是否落盘取决于 `ledgerPath`（省略时只留内存，
  不写用户项目）。MCP 侧仍是 `reflex_status_ledger` 工具，参数与返回见上表；
- DSH 侧的能力可用 `tools.enabled` **逐项开关**，键名是**后缀**，只接受当前 5 个后缀：

  ```yaml
  tools:
    enabled:
      route: true        # 打开默认关闭的候选排序
      gate: false        # 关掉默认开启的门禁，其余照常
  ```

  后缀与 `toolPrefix` 无关：前缀改成 `rv_` 之后 `{ gate: false }` 关掉的仍是
  `rv_gate`。被关闭的能力**不会被注册**到 `ctx.tools`，因此模型可见的工具清单里
  没有它，`reflexToolNames()` 与前缀推导的结果里也没有它——没有「占位工具」这种
  东西，模型不会看到一个调用即报错的空壳。`tools.enabled` 省略时按后缀默认值
  （`choice`/`score`/`screen`/`gate` 开、`route` 关）生效；写成不存在的后缀
  （例如 `teleport`，或已不再是工具的 `prune`/`detect_stagnation`/`status_ledger`）
  或非布尔值会在安装时被校验器拒绝，而不是被静默忽略。把 5 项全部写 `false` 后本
  插件不注册任何工具（路由、推理强度与干预钩子不受影响）。

---

## 10. 决策账本与审计

每次判定都会追加一条 JSONL 记录（`type` 取值：`gate`、`prune`、`stagnation`、
`route`、`model-route`、`effort`、`choice`），字段包含后端、耗时、置信度、
节省 token 估算与截断后的详情。查看方式：

```bash
node dist/cli/index.js ledger      # 终端查看汇总
```

- **`/reflex-ledger`（DSH 内）**：在会话里直接输入该命令，Host 会把**本次激活**的
  账本汇总渲染成文本（总调用数、按类型分布、平均时延、节省 token 与估算成本、
  门禁通过/失败、停滞告警，以及最近 5 条决策）——这是命令，不是工具：**不占用模型
  上下文、不发起模型回合**，账本为空时返回一句「暂无记录」而不是一排 0；
- `ledgerPath` 省略 ⇒ 仅内存，关掉进程即消失（默认，用户项目零污染）；
- 配置了路径 ⇒ 追加写 JSONL 并支持回放，面板「决策账本」页显示落盘路径；
- 面板清空账本需要连续两次点击确认，第二次才真正删除记录与 JSONL 文件。

---

## 11. 测试与发布

```bash
npm test                 # 根包：ledger / score / MCP 表面 / 打包清单
npm run test:plugin      # DSH 插件：注册、严格校验、工具面与 /reflex-ledger、路由、推理强度、面板、使用说明
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

## 12. 常见问题排查

| 现象 | 原因与处理 |
| --- | --- |
| 设置里找不到「Reflex 决策运行时」 | Host 半边未加载或未注册配置命名空间；确认 `dsh plugin add` 后重启/重载 `dsh` |
| 面板显示只读 | 当前 DSH 设置文档不可写；只读模式下所有写操作被禁用属预期行为 |
| 虚拟模型报错而不是派发 | 候选池为空且没有 `routing.fallback`；补候选或配置兜底目标 |
| 文本没有按预期被路由 | 检查 `routing.enabled`、虚拟模型 ID 拼写，以及 Agent 是否真的请求了该虚拟模型 |
| 推理强度没变化 | 策略设置为省略 = 不干预；或者调用方在请求里显式选择了具体档位 |
| System 1 判定总是走兜底 | `timeoutMs` 过小、`baseUrl` 不可达，或 `minConfidence` 过高；先看「概览」页的最近决策与后端状态 |
| 面板里的使用说明是旧版本 | 修改 `USER_GUIDE.md` 后未重新构建；执行 `npm run build:all` |
| 关掉某个工具后模型仍在调用它 | 注册表在下一次加载时生效；重载插件后再看，并确认键名写的是**后缀**（`gate`，不是 `reflex_gate`）。`prune`/`detect_stagnation`/`status_ledger` 已不是工具，写进 `tools.enabled` 会被校验器拒绝 |
| 默认工具清单里没有 `reflex_route` | 属预期：`route` 默认关闭，需要在工具开关页打开（或写 `tools: { enabled: { route: true } }`） |
| 想查账本但找不到 `reflex_status_ledger` 工具 | 账本已是命令：输入 `/reflex-ledger`（stdio MCP 侧仍有同名工具） |
| 关掉自适应推理强度后模型选择器仍有 `reflex` 档位 | 该档位是上一次加载注入的；确认配置已生效并重载插件，注入即被撤销 |
| 保存配置时报错「只支持留空或 reflex」 | 旧配置仍写着具体档位；删掉该值（或改成 `reflex`）。需要固定深度请在模型选择器里选择具体档位 |
| 保存「自动干预」后配置里多出默认值 | 属预期：该组是整组写回，模式与全部预算按面板当前值完整写入 |

---

## 13. 版本与兼容性

- 版本：`harness-reflex` 与 `dsh-reflex` 同步发布，v0.1.0-alpha.2；
- Node：`>= 18`（根包 `engines`）；DSH Host 依赖 `@deepseek-ai/*@0.2.1-alpha.4`；
- 插件以 `peerDependencies` 声明 Host 契约，运行时不重复打包 Host 模块；
- stdio MCP 的 8 工具表面自 v0.1.0 起冻结，Host 侧变更不得静默改动其载荷；
- DSH 插件侧的工具表面自 v0.1.0-alpha.2 起是 **5 个可开关能力、默认注册 4 个**
  （`route` 默认关闭），账本为 `/reflex-ledger` 命令——这一侧不承诺与 MCP 侧逐项对齐。

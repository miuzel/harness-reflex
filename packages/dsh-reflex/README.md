# dsh-reflex — Harness Reflex 的 DSH Host 插件

把仓库根目录的 **Harness Reflex（System One 决策运行时）** 以 **DSH Cordis Host 插件**的形式挂进 `dsh`
进程内：不再经过 stdio MCP 子进程，5 个 `reflex_*` 能力直接注册到 `ctx.tools`（默认注册其中 4 个，
`route` 需显式打开），与其它 DSH 工具共享同一套参数校验、执行管线与生命周期。剪枝与停滞检测改由自动干预层
直接驱动（不再占用工具位），台账汇总则是 `/reflex-ledger` **命令**——不经过模型。

插件同时提供**虚拟 Provider 与动态模型路由**：注册一个虚拟 provider（默认 `reflex`），把
`reflex-auto` / `reflex-fast` 这类虚拟模型按配置的物理候选池，用 System 1（毫秒级、零生成开销）在
`agent/request` 上映射到真实 `provider/model`，主代理与 subagent 都适用，每条决策记入台账。
路由**上下文感知且带会话粘性**：每次决策都会拿到本会话已累积的上下文规模与当前物理模型，提示词里写明
「保留当前模型可省缓存、非必要不切」，名次相近时守住已经在用的模型，只有明显更合适才切换。

- 插件包名：`dsh-reflex`（DSH 命名规范：`dsh-` 前缀即可）
- Cordis 插件入口：`apply(ctx, config)`（另导出 `applyReflex(ctx, config)` 返回运行时实例，便于测试/审计）
- 依赖：`harness-reflex`（本仓库根包，发布清单声明为 `^0.1.0-alpha.2`）+ Host 提供的
  `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm`（模型路由）/ `@deepseek-ai/dsh-agent`
  / `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-system-prompt` / `@deepseek-ai/dsh-host-webserver`（面板路由类型）
- 使用说明：[`../../USER_GUIDE.md`](../../USER_GUIDE.md)（中文）/ [`../../docs/USER_GUIDE.en.md`](../../docs/USER_GUIDE.en.md)（English）
  —— 同一份文档已嵌入浏览器半边，可在 DSH 设置页 **Reflex → 使用说明** 标签内阅读

---

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `package.json` | 插件元数据：`name`/`exports`/`dsh.bundle.patch`/peerDependencies |
| `cordis.patch.yml` | Bundle patch：`- insert: [{ id: reflex, name: 'dsh-reflex' }]` |
| `locale/{zh,en}.json` | `dsh plugin` 列表里显示的标题与描述 |
| `tsconfig.json` | 独立编译配置（`src/` → `dist/`） |
| `src/config.ts` | `ReflexConfig` 类型 + schemastery `Config` 模式 + `resolveConfig` |
| `src/bridge.ts` | `ReflexRuntime`：一次激活的 backend / ledger / 校准器 / 5 个决策服务 |
| `src/tools.ts` | 5 个 `defineTool` 定义与逐后缀默认开关（严格参数 + JSON 输出 + 顶层未声明参数拦截） |
| `src/command.ts` | `/reflex-ledger`：注册到 Host 命令注册表，直接读运行时台账并渲染为文本（不经模型） |
| `src/index.ts` | Cordis 插件入口 `apply` / `applyReflex`，注册与拆除都在一个 `ctx.effect` 内 |
| `src/router.ts` | `VirtualModelRouter`：候选池 → 候选（当前模型带 `current` 标记）→ System 1 决策（带上下文/模型状态与缓存亲和策略）→ **粘性闸门**（`stickyMargin`，默认 15%）→ 降级/Fail-Closed → 审计（`currentModel`/`switched`/`contextTokens`） |
| `src/virtual-adapter.ts` | `ReflexVirtualAdapter`：虚拟 provider 的 `LlmAdapter` 表面 + 派发层路由兜底 |
| `src/routing.ts` | `installModelRouting`：注册虚拟路由，挂 `agent/pre-step`（逐 agent 记任务与上下文规模）/ `agent/request`（带上当前物理模型与上下文规模决策） |
| `src/effort.ts` | `EffortInterceptor`：每轮自适应思考等级（触发判定 / System 1 决策 / 线索兜底 / 投影 / 状态） |
| `src/session-audit.ts` | `plugin:dsh-reflex/effort` 会话记录的写入与回读（不污染模型可见面） |
| `src/testing.ts` | `./testing` 入口：拉起真实 Cordis + `systemPrompt` + `tools` + `llm` + `commands` 的测试夹具 |
| `src/*.test.ts` | 插件测试（注册/配置/工具面与逐后缀默认/`/reflex-ledger` 命令/严格校验/生命周期/路由单元/路由集成（含上下文与粘性）/思考等级单元/思考等级集成/面板/使用说明） |
| `scripts/mutation-check.mjs` | 负向对照：逐个注入故障，要求测试套件（或编译器）全部抓到 |

---

## 构建

插件依赖 Host 的 `@deepseek-ai/*` 包。本机 npm registry 不可写（离线 / `EROFS`），因此**不需要**在插件目录
里 `npm install`：仓库根目录的 `scripts/link-dsh-deps.mjs` 会把本机已安装的 DSH 依赖软链到
`packages/dsh-reflex/node_modules/`（`harness-reflex` 指向仓库根，`@deepseek-ai/*` 指向 DSH 安装目录）。

```bash
# 仓库根目录执行：构建根包 → 链接 DSH 依赖 → 构建插件
npm run build:all

# 只检查链接是否就绪（缺失时退出码 1）
node scripts/link-dsh-deps.mjs --check

# 自定义 DSH 安装位置（可选）
DSH_HOST_MODULES=/path/to/dsh/node_modules npm run build:all
```

## 在 Host 中启用

`package.json` 里的 `dsh.bundle.patch` 已指向 `cordis.patch.yml`，因此按 DSH bundle 插件的通用方式安装即可：

```bash
dsh plugin add ./packages/dsh-reflex      # 或在 dsh 配置中把 dsh-reflex 加进插件列表
```

插件的配置项（全部可选，schemastery 提供默认值）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `auto` | `auto` 按环境变量选择 backend；也可强制 `mock` / `jev` / `vllm`。无任何环境变量时 `auto` 落到**离线 mock**（确定性、无网络） |
| `toolPrefix` | `reflex_` | 工具名前缀，例如配成 `rv_` 就是 `rv_choice` |
| `ledgerPath` | 省略 | 省略 = 台账**只留内存**（不写用户项目）；填路径则追加 JSONL 并可回放 |
| `pruneThreshold` | `500` | 字符数阈值，低于此长度的输出不剪枝 |
| `calibrationPath` | 省略 | 可选校准曲线 JSON，用于修正 `choice` 的置信度 |
| `routing.enabled` | `true` | 是否启用虚拟 provider 路由（未配置任何候选池时等于不启用） |
| `routing.virtualProvider` | `reflex` | 虚拟 provider 的 id（不能含 `:`） |
| `routing.models` | `{}` | 虚拟模型 → 物理候选池，例如 `reflex-auto: [{provider: deepseek, model: reasoner, description: ..., tags: [...]}]` |
| `routing.fallback` | 省略 | 池无法回答时的降级目标（`provider:model`）；省略即 **Fail-Closed**（报错而不是乱派发） |
| `routing.maxTaskChars` | `400` | 每个 agent 参与打分的任务文本上限（进台账时截断到 160 字符） |
| `effort.reasoningEffort` | 省略 | `reflex`（别名 `auto`）= 每轮按任务自适应思考等级；也可钉死成 `off/minimal/low/medium/high/max`。省略 = 不干预 |
| `effort.fallback` | `medium` | System 1 不可用/低于置信度下限时，确定性线索投票的兜底档 |
| `effort.minConfidence` | `0.3` | 采纳 System 1 答案的最低置信度（低于此值退回线索投票） |

配置示例（YAML）：

```yaml
- id: reflex
  name: 'dsh-reflex'
  config:
    backend: mock
    toolPrefix: reflex_
    routing:
      virtualProvider: reflex
      fallback: deepseek:chat          # 可选；省略则池为空时报错（Fail-Closed）
      effort:
        reasoningEffort: reflex       # 每轮按任务自适应；省略则完全不干预思考等级
        fallback: medium              # System 1 不可用时的兜底档
      models:
        reflex-auto:
          - { provider: deepseek, model: reasoner, description: 复杂推理与数学 }
          - { provider: deepseek, model: chat, description: 通用快速对话 }
        reflex-fast:
          - { provider: local, model: small, description: 便宜快速的小任务 }
```

配置好之后，模型既可以显式选择 `provider: reflex` / `model: reflex-auto`，也可以由代理的默认模型
（例如 subagent 继承的 `reflex-auto`）落到这里；插件会在 `agent/request` 上把它改写成 System 1 选出的
物理 `provider/model`，并写入一条 `type: 'model-route'` 台账（在会话里输入 `/reflex-ledger` 查看）。

配置了 `effort.reasoningEffort: reflex` 之后（或在请求里显式把 `reasoningEffort` 设成 `reflex`/`auto`），
插件会在同一处再拦截一次：用 `agent/pre-step` 捕获的**本轮任务文本**问 System 1 本轮该用哪一档思考，
毫秒级（无生成开销）得出 `off/low/medium/high`，投影到物理模型声明的词表后改写请求参数。行为约定：

- 调用方已经给了**具体**等级（`low`/`medium`/`high`…）时本层完全透明，不覆盖、不记台账；
- 目标模型不支持思考时**清空**该参数（不会报错），能力探测失败时保持原样（保守不破坏请求）；
- 每次自适应决策写一条 `type: 'effort-decision'` 台账、一条 `plugin:dsh-reflex/effort` 会话记录，
  并 `ctx.emit('reflex/effort', status)`；Host 侧可用 `runtime.effortStatusLine(agentId)` 读到
  `reflex effort: high → high (system-one 0.83, 0ms) deepseek:reasoner` 这样一行状态。
  GUI 状态栏需要另配带 `dsh.client` 的客户端半边（本包不含）。

## 提供的工具与命令

插件侧注册 **5 个可开关能力，默认注册 4 个**：`choice`、`score`、`screen`、`gate` 默认开启，
`route` 默认关闭（`tools: { enabled: { route: true } }` 或在面板工具开关页打开）。参数校验由 Host 的
`defineTool` 完成（必填/类型/枚举/嵌套 `additionalProperties`），工具层再补一道「顶层未声明参数」拦截。

| 工具 | 关键参数 | 用途 |
| --- | --- | --- |
| `reflex_choice` | `question`, `options[]`, `context?` | 多选一概率分布（毫秒级、零生成开销） |
| `reflex_score` | `statement`, `criteria?`, `context?` | 0.0–1.0 连续评分（三档分布投影） |
| `reflex_screen` | `content`, `source?`, `strict?` | 提示注入/指令劫持筛查，命中时附数据围栏 |
| `reflex_gate` | `assertions[{statement,criteria?}]`, `evidence`, `strictness?` | 声明-证据核对门禁（Fail-Closed） |
| `reflex_route`（默认关闭） | `goal`, `candidates[{name,description}]`, `topK?` | 候选工具/技能概率排序（只排序不卡阈值） |

另外三项能力**不在工具清单里**：

| 能力 | 插件侧承载方式 |
| --- | --- |
| `prune`（长输出剪枝 + token 节省统计） | 自动干预层在 `tools/pre-execute` 等钩子上直接执行（`observe`/`active`） |
| `detect_stagnation`（重复重试/振荡/零进展） | 自动干预层的一部分，随模式生效 |
| 台账汇总（调用数、延迟、净省 token、成本） | `/reflex-ledger` 命令：无参数、直接渲染文本、不开模型回合 |

stdio MCP 侧（`harness-reflex mcp` / `.mcp.json` / Codex / AGY bundle）**仍保留同名的 8 个工具**，
其表面自 v0.1.0 起冻结，与本插件侧不再逐项对齐。

## 生命周期与可逆性

一次激活 = 一个 `ReflexRuntime`，全部注册/观察/释放都收在**单个** `ctx.effect` 内：

```ts
ctx.effect(() => {
  const disposers = defineReflexTools(runtime, config).map((d) => ctx.tools.register(d));
  const stopObserving = ctx.on('tools/change', () => runtime.noteToolSurface(liveNames()));
  const stopRouting = installRouting(ctx, runtime, config.routing.maxTaskChars);  // 未配置池 = 空操作
  return () => {
    stopObserving();                                 // 摘掉 tools/change 观察者
    stopRouting();                                   // 摘掉路由拦截 + 释放虚拟 provider 路由
    unregisterLedger();                             // 注销 /reflex-ledger 命令
    for (const dispose of disposers.reverse()) dispose();  // 逆序注销全部已注册工具
    runtime.dispose();                               // 释放 ledger（内存态清空）
  };
}, 'reflex tools');
```

- 插件卸载 / context dispose：全部工具从 `ctx.tools` 消失，`/reflex-ledger` 名字被释放，观察者被摘除，
  `runtime.disposed === true`。同一个 context 上的第二个激活不会争抢命令名（名字上下文唯一，首个激活持有）。
- `runtime.dispose()` 幂等，重复调用无副作用。
- 同一个 context 上可以并存多个激活（不同 `toolPrefix`），互不影响，可任意顺序卸载。
- 虚拟 provider 路由是**进程内独占**的：同一 `LlmRuntime` 上首个配置了候选池的激活拥有它，后续激活复用
  并告警；卸载拥有者会释放该路由（新激活会重新注册）。
- 注意：Cordis 会把插件回调的**返回值当作 effect**，所以 `apply` 必须返回 `void`（或合法 disposer）；
  需要拿到运行时实例请用 `applyReflex`。

## 测试

```bash
npm test                 # 根包测试（ledger / score / route / route-prompt / MCP 表面 / 打包清单）
npm run test:plugin      # 插件测试（工具面 / 命令 / 校验 / 生命周期 / 路由 / 面板 / 使用说明）
npm run test:all         # 构建 + 两套测试
npm run test:mutation    # 负向对照：注入故障，要求被测试或编译器抓住
```

`npm run test:mutation` 会在 `tmp/reflex-mutation/`（已 gitignore）里复制一份源码，先确认基线是绿的
（测试数不得低于当前套件规模），再逐个注入故障并**要求变红**。下表是其中代表性的一批：

| 注入故障 | 命中验收面 | 期望被谁抓住 |
| --- | --- | --- |
| `drop-tool-at-registration` | 已启用工具全部注册 | 测试（注册数量） |
| `route-default-drift` | `route` 默认关闭 | 测试（默认工具面多出一个） |
| `ledger-command-unregistered` | `/reflex-ledger` 可读 | 测试（命令不存在） |
| `tool-switch-ignores-close` | 关掉的工具不注册 | 测试（关闭的工具仍在注册表） |
| `no-teardown` | 生命周期可逆 | 测试（卸载后工具仍在） |
| `no-root-argument-check` | 严格参数校验 | 测试（未声明参数被接受） |
| `prefix-default-drift` | 部署配置默认值 | 测试（工具名不匹配） |
| `hijack-foreign-provider` | 只改虚拟 provider 的请求 | 测试（物理请求被改写） |
| `route-cancelled-request` | 已取消的请求不路由 | 测试（出现多余决策） |
| `unlabelled-route-audit` | 路由决策可审计 | 测试（台账类型不匹配） |
| `silent-empty-pool` | 空池 Fail-Closed | 测试（错误码/降级原因不匹配） |
| `allow-self-route` | 不路由回虚拟 provider | 测试（自环被放过） |
| `lose-loop-request-identity` | loop 请求身份保持 | 测试（下游看不到 loop 标记） |
| `affinity-drops-token-estimate` | 决策须被告知会话上下文规模 | 测试（token 估算丢失） |
| `affinity-policy-not-stated` | 决策提示词写明缓存亲和策略 | 测试（策略文案缺失） |
| `sticky-gate-always-switches` | 略优的挑战者不得顶掉当前模型 | 测试（当前模型被换掉） |
| `affinity-audit-loses-current-model` | 台账记下会话守住的模型 | 测试（`currentModel` 恒为 null） |
| `routing-forgets-routed-model` | 粘性跨轮记住已路由模型 | 测试（第二轮退回配置顺序） |
| `routing-reports-no-context` | 累计上下文送到决策 | 测试（`contextTokens` 恒为 0） |
| `panel-drops-switched-flag` | 面板显示是否换过模型 | 测试（`switched` 不在投影里） |

## 已知边界

- 仓库内开发时，插件包内的 `harness-reflex` 依赖由 `scripts/link-dsh-deps.mjs` 软链到本仓库根包
  （`--check` 在未就绪时退出码 1，不触碰 registry）；发布时清单声明的是可发布的 `^0.1.0-alpha.2` 范围，
  因此 `release/dsh-reflex-*.tgz` 可被 npm 正常解析（见根 [`README.md`](../../README.md) 的发布产物一节）。
- `dist/` 是构建产物（已 gitignore），提交进版本库的是 TS 源码与插件元数据。
- `ledgerPath` 默认不落盘，是为了避免 Host 在用户项目里产生 `.reflex/` 垃圾文件；需要审计时显式配置。
- 路由决策的任务文本来自 `agent/pre-step` 的用户消息文本块（多模态输入只有文本参与打分）；每次
  `agent/request` 都会重新决策，但带会话粘性：当前物理模型会被守住（`stickyMargin` 默认 0.15），只有
  候选明显更合适才切换——切换仍会改变上游 prompt cache 命中，这是「换」的代价。
- `contextTokens` 只统计插件在 `agent/pre-step` 观测到的输入字符数（≈ 4 字符 1 token），是真实 prompt
  规模的**下界**；它用于判断缓存值不值得保，不用于计费或截断。
- 路由启用后 `reflex_route` 工具行为不变：工具面排序仍是通用候选排序，模型路由写的是
  `type: 'model-route'` 台账，两者不会互相覆盖。

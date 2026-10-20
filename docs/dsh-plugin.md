# DSH Host 插件：`dsh-reflex` 工程说明

> 本文记录「把 Harness Reflex 的 System One 能力以 DSH Cordis Host 插件形式集成」这一目标的实现方式、
> 验收对照与验证证据。插件源码在 [`packages/dsh-reflex/`](../packages/dsh-reflex/)。

## 1. 交付形态

- 新增 workspace 包 **`dsh-reflex`**（`packages/dsh-reflex/`），TS 源码 + 插件元数据入库，`dist/` 为构建产物。
- 仓库根包 `harness-reflex` 对插件暴露一个新增的共享投影模块 `src/core/score.ts`，并让 ledger 支持
  「纯内存」模式（`new DecisionLedger(null)`），使 Host 内嵌场景不写用户项目。
- 不改动 `main` 上已发布的对外 MCP 行为；8 个 `reflex_*` 工具的 stdio MCP 表面保持原样。
- 新增**虚拟 Provider 与基于 System 1 的动态模型路由**：插件可注册一个虚拟 provider（默认 `reflex`），
  把 `reflex-auto` / `reflex-fast` 这类虚拟模型按其物理候选池用 System 1 毫秒级映射到真实
  provider/model（主代理与 subagent 都走同一条链路），每条决策写入台账 `type:'model-route'`。
  新增源码模块 `src/{router,virtual-adapter,routing}.ts`。
- 新增**每轮自适应思考等级（reasoning effort）拦截**：`effort.reasoningEffort` 可配 `'reflex'`（或其别名
  `'auto'`）作为「按本轮意图自适应」的触发标记，也可配 `off/low/medium/high` 把等级钉死。标记生效时，
  `agent/request` 会用 `agent/pre-step` 捕获的本轮任务文本问 System 1（毫秒级、无生成开销）本轮该用哪一档，
  再把结果投影到物理模型声明的词表后改写 API 请求参数。新增源码模块 `src/{effort,session-audit}.ts`。

- 新增**客户端设置面板**（g-004）：插件声明 `dsh.client`（`platform: 'web'` + 消费的客户端能力 + `external: ['react']`）
  与 `exports['./client']`，产出单一浏览器包 `client.js`；面板注册到 `settings.section` 槽位（id `reflex`、`order 55`），
  提供 6 个 tab：概览（实时决策指标）/ 虚拟 Provider 池（增删候选、绑定物理 provider/model、标签、上下移）/
  推理强度（开关、默认档、触发规则、置信度下限）/ System 1 后端（backend、baseUrl、model、API key 环境变量、超时）/
  决策账本（近 N 条 + 一键清空）/ **使用说明**（内嵌中英文用户手册）。Host 半边新增 `src/panel-api.ts`（投影 + loopback 路由）与
  `src/panel-mount.ts`（挂载），浏览器半边在 `src/client/**`。设计 token 全部走 `--dsw-alias-*`（带兜底值），
  zh/en 文案齐备，**不引入任何新的外部重量级依赖**（bundle 的 externals 只有 `react`，它是 GUI 自身的 seed）。

- 新增**内嵌使用说明与双语查看**（g-005）：仓库文档 [`USER_GUIDE.md`](../USER_GUIDE.md)（中文）与
  [`docs/USER_GUIDE.en.md`](./USER_GUIDE.en.md)（English）经 `scripts/embed-user-guide.mjs` 生成为
  `packages/dsh-reflex/src/client/guide.generated.ts`（构建产物，已 gitignore），随浏览器半边打进 `client.js`，
  在设置页「使用说明 / Guide」tab 内渲染，并显示文档来源与内容摘要（digest）以便核对版本。
- 新增**发布打包与核验**：`scripts/release-pack.mjs`（`npm run release:pack` / `npm run release`）把根包与插件包
  打进 `release/`，逐项核验真实 entry 列表（必需文件、零死链、零未声明运行时依赖、无临时/绝对路径），
  对根包做一次离线 `npm install` + `bin` + 具名 import + stdio MCP `tools/list` 冒烟，输出 `SHA256SUMS` 与报告。

## 2. 验收对照

| 判据 | 实现 | 证据 |
| --- | --- | --- |
| ① 符合 DSH Cordis Host 插件规范 | `package.json`（`name: dsh-reflex`、`exports`、`dsh.bundle.patch`、peerDependencies）→ [`packages/dsh-reflex/package.json`](../packages/dsh-reflex/package.json)；`cordis.patch.yml` 经 YAML 解析得 `[{insert:[{id:reflex,name:dsh-reflex}]}]`；`locale/{zh,en}.json` 均含 `meta.title/description`；`src/index.ts` 导出 `name`/`inject = ['tools', 'llm']`/`Config`/`apply(ctx, config)` | `plugin module satisfies the Cordis Host plugin contract`、`Config is a schemastery schema that carries the deployment defaults`；`node -e "yaml.parse(...)"` 校验通过 |
| ② 8 个原生工具注入 + 严格参数校验 + 可调用 | `src/tools.ts` 用 `defineTool` 声明 8 个工具（必填/类型/枚举/嵌套 `additionalProperties: false`），并补一道顶层未声明参数拦截；`src/bridge.ts` 的 `ReflexRuntime` 提供全部实现 | `apply registers every tool with a model-visible description`、`the eight reflexive capabilities use the MCP-compatible names`、8 个工具各自的行为测试、`every tool rejects undeclared, missing, mistyped, and out-of-enum arguments`（18 个反例 + 1 个成功对照） |
| ③ 生命周期完全可逆 | 注册/观察/释放收在单个 `ctx.effect`：卸载时摘除 `tools/change` 观察者 → 逆序注销 8 个工具 → `runtime.dispose()`（幂等、内存台账清空） | `disposing the context unregisters every tool and disposes the runtime`、`unloading the plugin fiber releases tools, the observer, and the runtime`、`the runtime a Host receives is disposable exactly once and fully`、`a second activation after a full unload rebuilds a working surface`、`two activations on one context own disjoint surfaces and release in any order` |
| ④ `npm run build` 成功 + 新旧测试全绿 | 根包脚本新增 `build:all` / `test:plugin` / `test:all` / `test:mutation`；`scripts/link-dsh-deps.mjs` 负责离线依赖链接 | `npm run build:all` exit 0；`npm test` = 26/26；`npm run test:plugin` = 186/186；`npm run test:mutation` = 32/32 故障被抓（31 测试 + 1 编译器） |
| 命名规范（`dsh-` 前缀） | 包名 `dsh-reflex`，patch `name: 'dsh-reflex'`，无 `dsh-plugin-` 残留 | `grep -rn "dsh-plugin" packages/ src/ scripts/` 无包名残留（仅文档路径命中） |

## 3. 架构

```
DSH Host (cordis)
  └─ ctx.plugin(dsh-reflex, config)
       └─ apply(ctx, config) ── ctx.effect(build → cleanup)
            ├─ defineReflexTools(runtime, config) → 8 × ctx.tools.register(defineTool(...))
            ├─ ctx.on('tools/change') → runtime.noteToolSurface(存活工具)
            ├─ installModelRouting(ctx, runtime)        # 需要 ctx.llm；候选池缺失时只装拦截层
            │    ├─ ctx.llm.registerAdapter(['reflex'], ReflexVirtualAdapter)  # 仅配置了候选池时
            │    ├─ ctx.on('agent/pre-step') → 记住每个 agent 本步任务文本
            │    ├─ ctx.on('agent/request')  → System 1 决策 → 改写 provider/model
            │    └─ ctx.on('agent/request')  → EffortInterceptor → 改写 reasoningEffort
            │         ├─ 决策：System 1 choice（越权/抛错/低于置信度下限时退回确定性线索投票）
            │         ├─ 投影：projectEffort（保留 / 就近降档 / 无思考能力则清空 / 未知则原样）
            │         ├─ 留痕：DecisionLedger('effort-decision') + Session 插件记录 + ctx.emit('reflex/effort')
            │         └─ 展示：EffortStatusFeed（按 agent 存最近一条 / statusLine）
            └─ ReflexRuntime ── harness-reflex
                 ├─ backend     : auto | mock | jev | vllm（auto 无环境变量时 = 离线 mock）
                 ├─ ledger      : DecisionLedger(ledgerPath ?? null)（默认纯内存）
                 ├─ calibrator  : 可选校准曲线
                 ├─ services    : Gate / Router / Screen / Stagnation / Pruner
                 └─ modelRouter : VirtualModelRouter（虚拟模型 → 物理候选池 → System 1 选择）
```

数据流（工具面）：模型调用 `reflex_*` → 工具注册表的参数校验 → `execute` → `ReflexRuntime` 对应方法 →
`harness-reflex` core/backend → 结构化 JSON 值 → `render` 成 `text`（与 MCP 表面同一载荷）。

数据流（模型路由面，两层）：

```
主代理 / subagent 发起请求
  ├─ 第 1 层 agent/request（循环构造的配置，深冻结，唯一改写点）
  │    next() 得到 {provider:'reflex', model:'reflex-auto'} → 不拥有该 provider 则原样返回
  │    → VirtualModelRouter.routeModel()：池 → 候选 → System 1 route → 目标 → DecisionLedger('model-route')
  │    → 用对齐后的 reasoningEffort 改写 config（不新增原本没有的字段）
  │    → EffortInterceptor.resolve()：本轮任务文本 → System 1 effort choice → 投影 → 改写 reasoningEffort
  └─ 第 2 层 ReflexVirtualAdapter.stream()（手工一次性调用、prepareCall 消费者等未走第 1 层的路径）
       直接构造的请求也在这里 routeModel() → 用物理 target 换掉 provider/model →
       markAgentLoopRequest 保持 agent-loop 身份 → ctx.llm.stream(物理请求) → 物理适配器
```

**思考等级决策的时序（每轮一次，0 网络往返）**：

```
agent/pre-step ─ 捕获本轮任务文本（截断 routing.maxTaskChars）→ 记住在 agent 上
        ↓
agent/request ─ next() 得到调用配置 → 路由决策（若配置了候选池）→ 得到「物理 provider/model」
        ↓
  requested = config.reasoningEffort
  ① requested 是 'reflex'/'auto' → 本轮自适应（trigger:'request'）
  ② requested 未设置且部署配了标记 → 本轮自适应（trigger:'config'）
  ③ requested 未设置且部署钉死了等级 → 只做投影（trigger:'fixed-config'），不算决策、不写台账
  ④ requested 是具体等级（low/medium/high…）→ 透明直通：只做投影，不覆盖调用方的选择
        ↓
  自适应时：System 1 choice（4 个候选 = 4 个等级）→ 置信度 ≥ effort.minConfidence(默认 0.3) 采纳
            否则退回确定性线索投票（tier 词表 + 长度形状规则），并在状态里记 degradedReason
        ↓
  projectEffort：目标词表有此档 → 原样；无此档 → 就近档（等距取更省）；无思考能力 → 清空 key；能力未知 → 原样
        ↓
  留痕（仅自适应决策）：ledger('effort-decision') → Session 插件记录(ignorable) → ctx.emit('reflex/effort')
  → 状态栏数据可用 EffortStatusFeed.statusLine(agentId) 读
```

客户端半边（浏览器进程）：

```
DSH Web GUI (loader)
  └─ window.__ModuleLoader__.load({ id:'dsh-reflex', factory }) ── client.js（构建产物，5 模块内联）
       ├─ exports.inject = ['slots','locale']
       ├─ ctx.locale.register('dsh-reflex.panel', {zh, en})            # 面板文案（跟随 Host 语言）
       └─ ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'reflex',
            order:55, label: t('title') }, PanelComponent))
            └─ PanelComponent ── src/client/{view,store,panel}.ts
                 ├─ PanelStore：fetch('/api/dsh-reflex/panel') 轮询 4000ms → 快照
                 ├─ ctx.configForms.whileServed(['dsh-reflex','reflex'], …) → form.getSnapshot()/mutate(ops, revision)
                 └─ 5 个 tab：概览 / 虚拟 Provider / 推理强度 / System 1 后端 / 决策账本
```

数据流（面板）：浏览器 `GET /api/dsh-reflex/panel?limit=N` → Host `panel-api.answerPanelRequest`
（loopback 边界 → `source.snapshot(limit)`）→ `panel-mount.panelFacts(runtime)` 现场读 `ReflexRuntime`
（路由池、effort 设置、ledger 尾部与汇总、System 1 连接块，**只带 api key 的「是否存在」**）→ JSON 回包。
写配置走官方 `configForms`（不经过本插件的路由）；清空账本走 `POST …/ledger/clear?confirm=clear`。

## 4. 关键工程决策

1. **`apply` 返回 `void`**：Cordis 会把插件回调的返回值当作 effect（disposer / iterable / promise）。
   早期实现 `return runtime` 直接触发 `TypeError: Invalid effect`（实测），因此把「拿到运行时实例」拆成
   独立导出 `applyReflex(ctx, config)`，`apply` 只负责注册。
2. **运行时不注册为 context service**：同一个 deployment 可能按不同 `toolPrefix` 激活多次，固定服务名会
   在第二次激活时抛错；因此保留「每次激活返回自己的 runtime」的语义，并在文档里说明取舍。
3. **顶层未声明参数拦截**：`defineTool` 的参数根是隐式 property map（开放对象，加 `type: 'object'` 会直接
   报 `JsonSchemaError`），嵌套对象才有 `additionalProperties: false`。为了不让拼错的一级参数被静默忽略，
   工具层显式拒绝未声明的顶层键（`invalid arguments for <tool>: "x" is not declared`）。
4. **`toJsonValue` 出参归一**：`execute` 的返回值声明为 `{ type: 'json' }`，出参经一次 JSON 往返，
   既满足注册表的「无损 JSON」契约，又让 model-facing 文本与结构化值一致。
5. **默认不落盘台账**：`ledgerPath` 缺省时传 `null` 给 `DecisionLedger`，避免 Host 在用户项目里留下
   `.reflex/`；需要审计时显式配置路径（可回放 JSONL）。
6. **离线依赖链接**：本机 npm registry 不可写（`EROFS`），`scripts/link-dsh-deps.mjs` 把本机 DSH 安装里的
   `@deepseek-ai/{cordis,dsh-tools,dsh-system-prompt,schemastery}` 与仓库根包软链进插件 `node_modules/`，
   按 `DSH_HOST_MODULES` → `DSH_BIN`/`which dsh` → `npm root -g` → fnm 路径顺序发现，幂等且支持 `--check`。
7. **目录用 `dist/` 而非 DSH 官方插件的 `lib/`**：与仓库根包保持一致；解析完全由 `package.json` 的
   `main`/`types`/`exports` 决定，对 Host 透明。

### 虚拟 Provider 与模型路由（g-002）

8. **在 `agent/request` 而非 `llm/stream` 改写路由**：agent loop 构造的 `GenerateOptions` 是**深冻结**且带
   agent-loop 标记的，改不动；`agent/request` 的 waterfall 返回值本身就是 `LlmCallConfig`，是设计上的
   改写点。于是日志头、prepareCall、真正派发的请求三处都写物理 provider/model（不是「发出去才发现换了」）。
9. **第 2 层兜底在虚拟适配器里**：手工一次性调用、`prepareCall()` 消费者等不经过第 1 层的路径，由
   `ReflexVirtualAdapter.stream()` 在派发前 `routeModel()` 并换成物理请求；换完用
   `markAgentLoopRequest` 恢复 agent-loop 身份，避免下游（会话标题/压缩）把它当成外部调用。第 2 层的
   任务文本取**最后一条用户消息**的文本块（没有 `agent/pre-step` 上下文可用），两层都只在原请求带了
   `reasoningEffort` 时才回写该字段。
10. **不注册 runtime 为 context service**（沿用第 2 条）：同一 deployment 可能多次激活，固定服务名会冲突；
    路由的「所有权」改为进程内 `WeakMap<LlmRuntime, Map<provider, adapter>>`，首个激活注册虚拟路由，
    后续激活复用并告警，绝不 `DUPLICATE_ADAPTER`。
11. **空池/未配置 = 什么都不注册**：`routingActive()` 为假（未配池或 `enabled:false`）时根本不注册虚拟
    provider，「选了 `reflex` 却静默不可用」不可能发生；已注册但某个虚拟模型池为空时 **Fail-Closed**
    （无 `routing.fallback` 就 `ReflexRoutingError`，有 fallback 才降级并记 `degraded:true`）。
12. **自环防护**：候选或 fallback 指回虚拟 provider 一律拒绝（配置期 `resolveConfig` 报错、决策期再判一次），
    否则会无限自路由。
13. **判据覆盖主代理与 subagent**：`agent/request` 监听器注册在插件上下文（无 scope tag），因此所有 agent
    的请求都会经过；每条决策从 `agent/pre-step` 取**该 agent 自己**的任务文本，所以 subagent 是按自己的
    委派任务路由，而不是继承父代理的选择。
14. **reasoningEffort 必须投影**：换了 provider/model 后原来的 effort id 可能不存在，会导致
    `UNSUPPORTED_REASONING_EFFORT`；`alignReasoningEffort` 按目标模型声明的能力保留/换成 `defaultEffort`/
    清空，探测失败（`unknown`）时保持原样（保守不破坏请求）。
15. **审计入口单点**：`routeModel` 只写一条 `type:'model-route'` 台账（goal/task、选中物理目标、候选数、
    候选与分数、confidence、reason、agentId/role/delegationDepth/turn/step、latencyMs）；`selectBest` 的
    内置 `route` 记录用 `{record:false}` 关掉，避免一次决策写两条。

### 每轮自适应思考等级（g-003）

16. **触发标记与等级同一字段**：`effort.reasoningEffort` 接受 `reflex`/`auto`（触发标记）以及
    `off/minimal/low/medium/high/max`（钉死的等级）；`effort.fallback`（默认 `medium`）是线索投票的兜底档，
    `effort.minConfidence`（默认 0.3）是采纳 System 1 的最低置信度。校验在 `resolveConfig` 里做，
    从请求侧传来的标记也会 `trim + toLowerCase` 归一（`resolveEffortSetting`）。
17. **只在 `agent/request` 决策，且用 pre-step 捕获的任务文本**：`agent/pre-step` 是本轮任务文本进入系统的
    地方，`agent/request` 的 `next()` 返回值才是循环真正会派发的配置。因此决策依据是「本轮文本」而不是
    「已解析的配置」，改写点也在配置上——日志头、`prepareCall`、真正派发三处看到的等级一致。
18. **透明优先（判据③）**：拦截器先看 `next()` 解析后的 `reasoningEffort`。只要调用方/上游给了**具体**等级
    （`low/medium/high/…`），本轮不做自适应、不覆盖、不写台账，只沿用既有的 `alignReasoningEffort`
    （投影到目标模型词表）。只有「未设置」「标记」两种情况才由本层决定；未设置且部署没配任何东西时，
    返回原对象（`changed:false`）而不是等价副本。
19. **投影与「不崩」是同一件事**：`projectEffort` 对 `{kind:'declared'}` 保留或就近降档，对 `{kind:'none'}`
    直接 **删 key**（无思考能力的模型只被问它能答的东西），对 `{kind:'unknown'}`/探测抛错保持原等级
    （保守不破坏请求，错误留给 provider 表达）。所有探测（`resolveModelInfo`）、System 1 调用、台账写入、
    状态发布、Session 追加都在 `try/catch` 内：审计设施坏掉不能否决一轮对话。
20. **审计只进 Session 事件流，不进模型可见面（判据④）**：用 `appendPluginRecord` 写
    `plugin:dsh-reflex/effort` 实验性插件记录——它天然 `ignorable`、不进模型可见消息、可随 fork/resume 保留。
    刻意**不**写 `user`/`system` 角色消息：那会重新进入下一轮 prompt，甚至可能被模型当成指令重新解读。
    `agent/request` 跑在消息落盘之前，因此校验方式是派发后读 `effortRecordsOf(session.ownEvents())`。
21. **状态展示的边界（诚实说明）**：Host 侧没有「往 GUI 状态栏塞一个 key」的 API；`shell.bottom` 是客户端
    插槽，需要包自己带 `dsh.client` 前端半边才能渲染。本目标交付的是 Host 侧的
    `EffortStatusFeed`（按 agent 存最近一条状态 + `statusLine`）、`ctx.emit('reflex/effort')` 事件
    与 Session 审计记录——GUI 状态栏的最终呈现需要另配前端半边，本目标不含。
22. **一次决策只写一处台账**：只有真正的自适应决策（`system-one` / `cue-fallback`）写
    `type:'effort-decision'`；钉死的等级属于配置而非决策，因此不写台账（也不会被统计成「System 1 省了多少」）。
    状态发布与台账是两条独立的 best-effort 路径，互不牵连。

### 客户端设置面板（g-004）

23. **`exports` 就是激活开关**：DSH 只扫描「`exports` 里声明了 `./client`，且 `package.json` 里有
    `dsh.client.platform === 'web'`」的包。因此新增 `dsh.client = {platform:'web', inject:[...], external:['react']}`
    与 `exports['./client'] = './client.js'`，并新增客户端源码目录 `src/client/**`（独立 `tsconfig.client.json`）。
    `inject` 里放的是**消费掉的客户端能力的包名**（`dsh-client-locale`、`dsh-client-ui-settings`），
    语义与官方插件一致；真正的 cordis 服务依赖在浏览器半边自己的 `exports.inject = ['slots','locale']`。
24. **浏览器半边必须自包含**：运行时 `require` 只有两种来源——平台 seed 词表（`react`、`react-dom`、
    `@deepseek-ai/cordis`、`zod`、三个 `dsh-client-*`）与 loader 模块表；`./x` 形式的相对说明符**不在**表里，
    所以 5 个客户端模块由 `src/client-bundle.ts` 打进单一 `client.js`（`window.__ModuleLoader__.load({id, factory})`），
    模块间调用由注入的 `require` 在模块表内解析。`dsh.client.external` 必须恰好等于 bundle 需要的平台说明符
    （`['react']`），`verifyClientPackage` 会核对。选 `react` 是刻意的：它是 GUI 自身的 seed，**零新增重量级依赖**。
25. **走「设置页 + 自己拥有的 loopback 路由」，而不是依赖 `dsh-settings` 的 REST 面**：面板需要的是**实时**
    运行时事实（内存台账、当前路由池、本轮 effort 决策），这些只存在于插件进程内。因此 Host 半边
    （`src/panel-api.ts` + `src/panel-mount.ts`）用 `ctx.webServer.register` 挂 `/api/dsh-reflex/{panel,health,ledger/clear}`，
    浏览器半边 `fetch` 它。好处：不把 `dsh-client-ui-settings`/`dsh-settings` 拉成运行时依赖；坏处：多一个
    HTTP 面，所以它**默认只答 loopback**，且清空台账需要显式 `?confirm=clear`。
26. **写配置仍走官方通道**：编辑配置不用上面的路由，而是 `ctx.configForms.whileServed(NS_CANDIDATES, …)` +
    `ctx.configForms.get(entryId)` + `form.mutate(ops, revision)`。命名空间是**配置表单条目的 id**（不是包名），
    因此候选名写成 `['dsh-reflex','reflex']` 并在服务出现时解析；`form.writable === false` 时整页只读
    （保存按钮 disabled，且 `store.save()` 自己再拦一道——按钮只是提示，不是保证）。
27. **浏览器半边只做投影，不重新实现判据**：`src/client/panel.ts` 是纯视图模型（草稿/diff/校验/格式化/词表），
    `src/client/store.ts` 管轮询与提交，`src/client/view.ts` 只用 `var(--dsw-alias-*, fallback)` 设计 token 渲染；
    组件不碰 DOM 以外的全局，也不引入任何 UI 框架。词表（`EFFORT_LEVELS`/`ADAPTIVE_EFFORT_LEVELS`/`EFFORT_TRIGGERS`/
    `BACKEND_CHOICES`）在浏览器侧**重述**一遍 Host 的词表——因为 bundle 不能 `require` Host 源码；这正是
    `panel-effort-level-drift` 变异测试盯住的地方（页面给出的选项必须与 Host 接受的一致）。
28. **面板挂在 `settings.section` 槽位，且只在 Host 半边在时出现**：槽位注册（`id:'reflex'`、`order:55`、
    `label` 取自 locale 的 `title`）与 locale 字典都在 `ctx.slots.inject` 的 effect 里；只有当前命名空间
    真的被 serve（`whileServed` 回调触发）时才注册，所以「Host 半边没装」不会留下一张空页面。
    文案 zh/en 双份齐备，页面跟随 Host 语言。面板主体是 6 个 tab：概览 / 虚拟 Provider / 推理强度 /
    System 1 后端 / 决策账本 / 使用说明。

### 内嵌使用说明与双语查看（g-005）

29. **文档只写一份，构建时嵌入，绝不手抄**：`USER_GUIDE.md`（中文）与 `docs/USER_GUIDE.en.md`（English）是
    唯一事实来源；`scripts/embed-user-guide.mjs` 把它们读成 `guide.generated.ts`（构建产物、已 gitignore），
    浏览器半边在渲染时才解析 Markdown。手工维护一份「页面里的文档副本」是这类功能最常见的腐烂方式——
    这里两份文档的 sha256 摘要被写进产物，`guide.test.ts` 与打包核验都会比对仓库文档的摘要，
    文档改了不重新构建会直接变红。`--check` 模式（以及 CI 式用法）可在不写盘的情况下判定是否过期。
30. **浏览器半边自己解析 Markdown，不引入 markdown 依赖**：`src/client/markdown.ts` 只支持文档真正用到的
    子集（标题/段落/有序与无序列表/围栏代码块（带语言）/引用/表格/分隔线），产出的是 React 元素而不是
    HTML 字符串——`renderInline` 把内联代码、粗体、链接变成真实元素，其余标记一律当文本，**没有
    `dangerouslySetInnerHTML`，所以文档里的尖括号不可能变成注入面**。表格解析要求每行单元格数与表头一致，
    不齐的行不会被拼成错位的表。
31. **「使用说明」是设置页的第 6 个 tab，而不是外链**：`PANEL_TABS` 增加 `'guide'`，`GuideTab` 渲染标题/
    导语/提示/来源摘要 + 解析后的正文；tab 文案 `使用说明` / `Guide` 随 Host 语言切换，正文也随语言切换
    （中文界面读 `USER_GUIDE.md`，英文界面读 `docs/USER_GUIDE.en.md`）。面板自身仍然只走 loopback 路由，
    文档内容随 `client.js` 一起加载，**离线可用、不新增任何运行时依赖**。

### 路由的上下文感知与会话粘性（g-006）

32. **粘性用相对门槛，不用绝对加成**：后端返回的分数量纲并不统一（mock 是 0.1 起步的关键词分，logits 是
    概率，Jev 网关是自带尺度的 logit margin），给「当前模型」加一个固定分数在不同后端上会等于随机行为。
    因此粘性闸门只做**相对**比较：挑战者必须 `score > 当前分` **且** `score >= 当前分 × (1 + stickyMargin)`
    （默认 `0.15`）才算「明显更合适」，否则守住当前物理模型，`reason` 记 `sticky-affinity`。
33. **上下文规模只从观测到的输入算，不读会话内部**：`agent/pre-step` 送进来的消息是插件在路由前唯一能看到
    的输入，于是按 agent 累计它的字符数（`measureMessages`，不截断），按 4 字符 ≈ 1 token 折算成
    `contextTokens`，并在请求里同时给出 `contextChars`。这是**下界**（真实会话里还有工具结果与历史），
    但方向正确、单调增长，且让 router 继续对 DSH 会话模块零依赖；上限 64 个 agent，LRU 淘汰。
34. **「保留当前模型」同时用两种读法表达**：候选对象加 `current: true` 标记，描述文本追加
    `[current model — keeping it preserves the prompt cache]`；`RouteRequest.state` 里给结构化后端
    `currentModel/contextTokens/contextChars`，`instructions` 里给策略原文。文本型后端（`system-one-logits`
    把 context 渲染进 prompt）与结构化后端（Jev 网关把 `state`/`instructions` 当数据收）拿到的是同一个信号，
    不需要任何一方理解对方的格式。**没有 state/instructions 的请求渲染结果与历史逐字节一致**（有测试钉住）。
35. **粘性只在同一个候选池内成立**：只有当前模型出现在本轮候选里才谈得上「保住缓存前缀」；不在池里
    （典型是会话换到了另一个虚拟模型）时不做任何阻拦，按 System 1 名次走，`switched` 记 `true`。
    所以 `currentModel` 永远如实上报，是否能守则由 `incumbentInPool` 决定。
36. **审计与面板同步扩字段**：`type:'model-route'` 台账新增 `currentModel`（首轮为 `null`）、`switched`
    与 `contextTokens`/`contextChars`，降级路径同样写；`panel-api` 的 `projectRow` 只投影这三个字段
    （`currentModel` 为 `null` 时投影成「没有」而不是字符串 `"null"`），面板因此能显示「这轮没换模型」。

## 5. 验证命令与结果

```bash
npm run build:all      # 根包 tsc → 链接 DSH 依赖 → 插件 tsc → 生成内嵌文档 → 客户端 tsc + 打包  exit 0
                       #   末步产出 packages/dsh-reflex/client.js
                       #   (172049 bytes, 8 modules, externals: react)
npm test               # 根包测试：tests 58  pass 58  fail 0
npm run test:plugin    # 插件测试：tests 219 pass 219 fail 0
npm run test:mutation  # 负向对照：32/32 注入故障被抓（31 由测试、1 由编译器）
npm run release:pack   # 打包 release/：26/26 核验通过，两份 tarball + SHA256SUMS + 报告
```

`client.js` 是**入库的构建产物**（`files` 白名单包含它），因此「改客户端源码 → 重新打包」是发布步骤的一部分；
客户端半边的四套测试都按 DSH loader 的方式读这个产物，源码改了但没重新打包会被 `client-contract.test.ts`
（版本号/说明符/注入 id/语言包）与 `client-page.test.ts`（整页行为）直接报出来。

思考等级的决策质量（意图表与断言见 `packages/dsh-reflex/src/effort.test.ts`，18 条带标签的任务文本；
两条路径的命中数都被测试钉死，漂移会在 `npm run test:plugin` 里报出每一条 miss）：

```
cue-fallback hits: 17/18 = 0.9444     # 纯确定性线索投票（System 1 不可用时的兜底）
interceptor hits:  18/18 = 1.0000     # System 1 优先 + 兜底（16 条走 System 1，2 条走兜底）
```

单次决策耗时：mock backend 下取整为 0 ms（亚毫秒级，无网络、无生成），测试断言 `< 50 ms`。

负向对照（`packages/dsh-reflex/scripts/mutation-check.mjs`）在 gitignore 的
`packages/dsh-reflex/tmp/mutation/` 里复制源码（含 `package.json` / `client.js` / `tsconfig.client.json`），
先确认副本基线为绿（186 passed），再逐条注入故障。副本会**重建客户端产物**，因此注入到 `src/client/**`
的故障和注入到 Host 半边的一样能被测试抓住（否则测试只会读到未受影响的旧 bundle）：

| 注入故障 | 命中面 | 结果 |
| --- | --- | --- |
| `drop-tool-at-registration` | 8 个工具齐全 | CAUGHT-BY-TESTS |
| `drop-tool-from-suffix-list` | 工具名清单完整 | CAUGHT-BY-BUILD（联合类型收窄） |
| `no-teardown` | 生命周期可逆 | CAUGHT-BY-TESTS |
| `no-root-argument-check` | 严格参数校验 | CAUGHT-BY-TESTS |
| `prefix-default-drift` | 部署配置默认值 | CAUGHT-BY-TESTS |
| `route-foreign-provider` | 只改虚拟 provider 的请求 | CAUGHT-BY-TESTS |
| `route-cancelled-request` | 已取消的请求不路由 | CAUGHT-BY-TESTS |
| `unlabelled-route-audit` | 路由决策可审计 | CAUGHT-BY-TESTS |
| `silent-empty-pool` | 空池 Fail-Closed | CAUGHT-BY-TESTS |
| `allow-self-route` | 不路由回虚拟 provider | CAUGHT-BY-TESTS |
| `lose-loop-request-identity` | loop 请求身份保持 | CAUGHT-BY-TESTS |
| `route-without-pools` | 无池部署不得路由（拦截独立于路由） | CAUGHT-BY-TESTS |
| `rewrite-drops-decision` | 标记必须变成决定出的等级 | CAUGHT-BY-TESTS |
| `effort-overrides-caller-pin` | 调用方钉死的等级必须透明 | CAUGHT-BY-TESTS |
| `effort-keeps-level-on-plain-model` | 无思考能力目标安全降级 | CAUGHT-BY-TESTS |
| `effort-ignores-confidence-floor` | 低于置信度下限退回线索投票 | CAUGHT-BY-TESTS |
| `effort-audit-unbounded` | 审计里的轮次文本有界 | CAUGHT-BY-TESTS |
| `effort-hides-applied-level` | 审计要能区分「清空」与「已应用」 | CAUGHT-BY-TESTS |
| `status-event-silenced` | 决策要报给 Host | CAUGHT-BY-TESTS |
| `panel-fence-off` | 面板只答 loopback 客户端 | CAUGHT-BY-TESTS |
| `panel-clears-without-confirmation` | 清空账本必须显式确认 | CAUGHT-BY-TESTS |
| `panel-drops-the-fallback-target` | 路由页要把作者写的 fallback 原样回填 | CAUGHT-BY-TESTS |
| `panel-writes-when-read-only` | 只读文档永不落写 | CAUGHT-BY-TESTS |
| `panel-effort-level-drift` | 页面给出的档位必须与 Host 接受的一致 | CAUGHT-BY-TESTS |
| `system-one-timeout-unchecked` | System 1 连接参数要被校验 | CAUGHT-BY-TESTS |
| `affinity-drops-token-estimate` | 决策必须被告知会话上下文规模 | CAUGHT-BY-TESTS |
| `affinity-policy-not-stated` | 决策提示词必须写明缓存亲和策略 | CAUGHT-BY-TESTS |
| `sticky-gate-always-switches` | 只是略优的挑战者不得顶掉当前模型 | CAUGHT-BY-TESTS |
| `affinity-audit-loses-current-model` | 台账要记下会话守住的模型 | CAUGHT-BY-TESTS |
| `routing-forgets-routed-model` | 粘性要跨轮记住已路由的模型 | CAUGHT-BY-TESTS |
| `routing-reports-no-context` | 累计的上下文要送到决策 | CAUGHT-BY-TESTS |
| `panel-drops-switched-flag` | 面板要显示这轮是否换过模型 | CAUGHT-BY-TESTS |

## 6. 残留风险与未覆盖

- **未在真实 `dsh` 进程里跑一次真实模型路由**：验证用到的是真实 Cordis + 真实 `LlmRuntime` 适配器注册表
  + 真实 agent-scoped waterfall + 真实 System 1（mock backend）决策路径，物理适配器是记录型假体；
  真实 provider 的网络/鉴权/具体模型能力（context 长度、reasoning effort 词表）未覆盖。
- **思考等级的「智能」取决于 backend**：本目标交付的是拦截/决策/投影/审计链路，决策质量用 mock backend
  量到 18/18（见 §5），真实 Jev/vLLM 的语义判断未在本目标内评测；System 1 不可用时兜底为确定性线索
  投票（17/18），并且**任何** System 1 异常都会退到兜底而不是失败。
- **状态栏只到 Host 侧**：`EffortStatusFeed` + `ctx.emit('reflex/effort')` + Session 审计记录可用；
  GUI 状态栏需要另配带 `dsh.client` 元数据的客户端半边，本目标不含（见 §4 第 21 条）。
- **标记只在 agent loop 路径被解释**：`agent/request` 是本层的拦截点。绕过它直接构造
  `ctx.llm.stream({reasoningEffort:'reflex'})` 的调用不会被自适应，虚拟适配器只会把它当作未知等级
  投影到目标模型的 `defaultEffort`。这是刻意的边界（一次请求一次决策，避免双重决策/双重审计）。
- **钉死的等级不写台账**：`effort.reasoningEffort` 配成具体等级时只做投影与改写，不产生
  `effort-decision` 台账、不发状态事件（它不是决策）。需要审计「实际使用的等级」时应配标记而不是钉死。
- **任务文本来源**：决策用的是 `agent/pre-step` 收到的用户消息文本（截断到 `routing.maxTaskChars`）；
  多轮/多模态（图片）输入只有文本块参与打分，图片内容不参与。
- **路由仍是「每步」决策，但默认不换模型**：同一 agent 的每一次 `agent/request` 都会重新决策（毫秒级、
  无网络），不过 g-006 之后当前物理模型会被粘性闸门守住（默认 `stickyMargin = 0.15`），只有候选**明显更
  合适**才会切换——切换本身仍会让上游 prompt cache 失效，这是「换」的代价而不是意外。
- **上下文规模是下界**：`contextTokens` 只统计插件在 `agent/pre-step` 观测到的输入字符数（≈ 4 字符 1 token），
  真实会话里还有工具结果、历史消息与宿主的压缩行为，因此这个数字**小于**模型实际看到的 prompt；它只用来
  判断「这台会话已经攒了多少上下文、缓存值不值得保」，不用于计费或截断决策。
- **`reasoningEffort` 依赖 `resolveModelInfo`**：探测失败会保守保留原 effort，此时若目标模型确实不支持
  该 effort，错误由 provider 侧返回（不会被本插件吞掉）。
- **进程内所有权 WeakMap**：同一 `LlmRuntime` 上首个激活拥有虚拟路由；若该激活被卸载，路由会释放，
  其余激活的路由拦截仍在但没有虚拟 provider（会在下一次请求时表现为 provider 不存在）。

- **未发布到 npm**：插件的 `harness-reflex` 依赖是 `file:../..`，干净 checkout 上 `dsh plugin add` 前需先
  `npm run build:all`；真正的独立安装取决于 Host 的解析/发布策略（本目标范围内不做）。
- **跨表面一致性**：`reflex_score` 在两套测试里各自与同一投影函数 `scoreStatement` 做深比较（等价于
  「MCP 表面 = 插件表面 = core」）；其余 7 个工具在两个表面分别有行为测试，但未逐字段比对两条链路，
  后续如需强一致可复用同一断言模式。
- **`auto` backend 依赖环境变量**：无任何环境变量时落到离线 mock（确定性、无网络）；`jev`/`vllm` 需要
  API key / base url，否则调用期报错（属既有 backend 行为）。
- **未在真实 `dsh` 进程里加载**：验证覆盖到 Cordis 装载路径（`ctx.plugin(name/inject/Config/apply)` +
  真实 `SystemPrompt`/`ToolRuntime` 服务），未执行 `dsh plugin add` 的 CLI 安装流程。
- **未提交到 `main`**：`main` 是已发布分支，本次改动以工作区文件形式落地（未 commit、未建分支），
  是否落分支/提交由负责人决定。

设置面板（g-004）追加的边界：

- **没有在真实浏览器 / 真实 DSH GUI 里点过**：验证是「在 VM 里按 DSH loader 的协议加载 `client.js`、
  用假 React 运行时跑整棵组件树、断言渲染出的 props 与提交的 mutation」+「用真实 `panel-api`/`panel-mount`
  处理真实 `IncomingMessage`」。因此 CSS 视觉效果、真实 `--dsw-alias-*` 变量的取值、真实 `fetch` 的
  跨源/凭据行为、真实 `configForms` 服务的边界（revision 冲突、并发写）**未覆盖**。
- **设计 token 是「按名字引用 + 兜底值」**：`view.ts` 全部走 `var(--dsw-alias-x, <fallback>)`，
  变量名取自 DSH GUI 的主题表；若上游 token 改名，页面会退回兜底值而不是报错（看起来仍是可用界面，
  但不再跟随主题）。变量名清单没有自动化校验（GUI 主题表不是本仓库的依赖）。
- **`dsh.client.inject` 的 id 是硬承诺**：客户端半边声明注入 `dsh-client-locale` 与 `dsh-client-ui-settings`。
  契约测试会用 `require.resolve('@deepseek-ai/dsh-client-modules/package.json')` 找到 DSH 安装目录逐个核对
  （找不到 DSH 时该断言跳过）。若某个 id 在目标 DSH 版本里不存在，`web boot` 会整批激活失败——
  这是选择「注入既有的 locale/settings 能力」而非自造 slot 的代价。
- **`client.js` 的 externals 只允许 `react`**：想再引入任何平台能力（如 `zod`、`@deepseek-ai/cordis`），
  必须同时在 `src/client-bundle.ts` 的 `ALLOWED_SEEDS`、`dsh.client.external` 与 TS 侧声明三处落地，
  否则契约测试会报「说明符与声明不一致」。
- **清空台账是不可撤销的**：`POST /api/dsh-reflex/ledger/clear?confirm=clear` 会删除落盘的 JSONL
  （页面用「再点一次确认」二次确认）。这是刻意的显式操作，但一旦点下去没有撤销路径。
- **只在 loopback 上可用**：面板路由默认拒绝非本机 socket（除非 Host 提供了配对服务）。远程 GUI
  场景下页面会显示请求失败（403），需要在 Host 侧接入配对/反向代理。

## 7. 虚拟 Provider / 模型路由验收对照（g-002）

| 判据 | 实现 | 证据 |
| --- | --- | --- |
| ① 注册虚拟 provider（默认 `reflex`）+ 可配置虚拟模型与物理候选池 | `src/config.ts` 的 `routing.{enabled,virtualProvider,models,fallback,maxTaskChars}` + `resolveConfig` 校验（空 provider/model、含 `:`、自环、空池）；`src/routing.ts` 用 `ctx.llm.registerAdapter([virtualProvider], ReflexVirtualAdapter)` 注册真实 provider 路由，`listModels` 由池派生 | `a configured pool registers the virtual provider and advertises its models`、`Config accepts a virtual model pool and keeps an unset ledgerPath unset`、`resolveConfig validates the routing block instead of trusting it`、`routing.enabled=false disables the virtual provider even with configured pools` |
| ② 在 `agent/request` 或 LLM 分发层拦截，经 System 1（`ReflexRouter`）毫秒级映射到物理 provider/model 并改写 config | 第 1 层 `ctx.on('agent/request')`（读 `next()` 的配置 → `routeModel` → 改写 provider/model/reasoningEffort）；第 2 层 `ReflexVirtualAdapter.stream()`（派发前路由 + `markAgentLoopRequest`）；决策走真实 `ReflexRouter.selectBest` | `the agent/request waterfall rewrites the frozen call config of the main agent`、`a request naming the virtual model reaches the physical adapter System 1 chose`、`a request with no task signal still resolves deterministically at dispatch time`、`a degraded route dispatches through the configured fallback` |
| ③ 主代理与 subagent 都路由，并与 `DecisionLedger` 联动留痕（goal/task、选中物理模型、候选数、耗时） | 监听器不带 scope tag → 覆盖所有 agent；`agent/pre-step` 逐 agent 记任务；`routeModel` 每条决策写一条 `type:'model-route'` 台账，含 `goal/virtual/chosen/candidateCount/candidates/scores/confidence/reason/degraded/agentId/role/delegationDepth/turn/step`，`latencyMs` 走 `DecisionLedger.record` | `a subagent inherits the virtual route and is routed on its own task`、`a subagent with no captured task routes without crashing`、`a task matching one candidate routes to it and audits the decision`、`routing latency comes from the injected clock` |
| ④ 单元测试 + 边缘情况（空池降级、非法路由拦截），全量测试全绿 | 空池/未声明模型/非法目标/空模型名/自环/Fail-Closed 与 fallback 降级全覆盖；`plugin`/`lifecycle`/`router`/`routing`/`tools` 五套共 64 个测试 | `npm run test:plugin` = 64/64；`npm test` = 9/9；`npm run test:mutation` = 11/11（含 6 条路由专属故障：`hijack-foreign-provider`/`route-cancelled-request`/`unlabelled-route-audit`/`silent-empty-pool`/`allow-self-route`/`lose-loop-request-identity`） |

## 8. 每轮自适应思考等级验收对照（g-003）

| 判据 | 实现 | 证据 |
| --- | --- | --- |
| ① 支持把 `reasoningEffort` 配成 `'reflex'`（别名 `'auto'`）作为自适应触发标记 | `src/config.ts` 的 `effort.{reasoningEffort,fallback,minConfidence}` + `EffortSchema`（标记与等级同一字段）+ `resolveConfig` 校验 + `resolveEffortSetting` 归一；`ADAPTIVE_EFFORT_LEVELS`/`EFFORT_TRIGGERS`/`isEffortTrigger` 为唯一词表来源 | `Config accepts the reflex/auto marker and every effort level`、`resolveConfig normalizes the effort marker and refuses a broken block`、`the marker vocabulary is exactly reflex/auto plus the effort ladder`、`prefix-default-drift` 之外新增的 `effort-*` 负向对照 |
| ② 在 `agent/request` 拦截本轮输入，由 System 1 毫秒级决定本轮等级并改写请求参数 | `src/routing.ts` 的 `agent/request` 监听器 → `EffortInterceptor.resolve()`（`src/effort.ts`）：`agent/pre-step` 捕获的任务文本 → `buildEffortChoice` 问 System 1 → `levelOfChoiceOption` → `projectEffort` → 改写 `config.reasoningEffort`；越权/抛错/低置信度退回确定性线索投票 | `the reflex marker becomes a concrete effort on the dispatched request`（改写后真正派发的 API 参数 = `high`）、`the auto alias decides exactly like reflex`、`two turns of one agent are decided independently`、`the interceptor decides the intent table through System 1 at speed`（18/18，亚毫秒）、`the marker is honoured without any virtual route`、`the configured marker decides a request that carries none` |
| ③ 调用方/上游已钉死具体等级时不覆盖；物理模型不支持思考时安全降级不崩 | `resolve()` 的透明直通分支（具体等级 → 只做投影，不决策、不写台账）；`projectEffort` 对 `{kind:'none'}` 删 key、对 `{kind:'unknown'}`/抛错保持原样；所有探测/决策/审计调用都在 `try/catch` 内 | `a request that fixed its own effort is never overridden`、`a deployment that configured no effort block decides nothing`、`a request that names a concrete effort passes through untouched`、`a physical model without thinking gets the key cleared, not a crash`、`projectEffort degrades safely on every probe answer`、`a broken ledger or a hostile status carrier cannot veto a turn`、`an aborted request spends no decision and writes no record` |
| ④ 选择过程写入 Session 事件流（不污染后续模型上下文）并报给状态栏 | `src/session-audit.ts`：`appendPluginRecord(session,'plugin:dsh-reflex/effort',…)`（`ignorable`、不进模型可见面、随 fork/resume 保留）；`src/routing.ts` 的 `reportEffort` 同时 `ctx.emit('reflex/effort')`；`EffortStatusFeed` 按 agent 存最近状态并提供 `statusLine` | `the decision reaches the session log without entering the model surface`（记录存在 + `surface.nodes` 不变 + `deriveMessages()` 为空 + `isSurfaceEligibleType` 为假）、`the status bar line and the emitted event agree with the decided turn`、`the reflex marker decides a turn and audits it once`、`the status feed buckets by agent and can be cleared` |
| ⑤ 每次努力决策进 `DecisionLedger`；全量测试全绿 + 新增变异测试 | `EffortInterceptor.#publish` 只对自适应决策写 `type:'effort-decision'`（含 level/applied/outcome/trigger/source/confidence/provider/model/agentId/turn/step/basis/goal/latencyMs）；`LedgerEntry.type` 增加该类型；`mutation-check.mjs` 增加 8 条 effort 故障并提升基线到 95 | `npm run test:plugin` = 95/95；`npm test` = 9/9；`npm run test:mutation` = 19/19（其中 effort 面 8 条：`route-without-pools`/`rewrite-drops-decision`/`effort-overrides-caller-pin`/`effort-keeps-level-on-plain-model`/`effort-ignores-confidence-floor`/`effort-audit-unbounded`/`effort-hides-applied-level`/`status-event-silenced`）；`cue-fallback 17/18`、`interceptor 18/18` |

## 9. 变更清单

> 「修改」小节是相对前三个目标（g-001…g-003）已交付状态的增量；插件包的多数文件在「新增」里一次列全。

新增：

- `packages/dsh-reflex/`（`package.json`、`cordis.patch.yml`、`locale/{zh,en}.json`、`tsconfig.json`、
  `README.md`、`scripts/mutation-check.mjs`、`src/{index,config,bridge,tools,testing}.ts`、
  `src/{plugin,tools,lifecycle}.test.ts`）
- `packages/dsh-reflex/src/router.ts`（`VirtualModelRouter`：池校验、System 1 决策、降级、审计）
- `packages/dsh-reflex/src/virtual-adapter.ts`（`ReflexVirtualAdapter`：虚拟 provider 的适配器表面 + 派发层兜底）
- `packages/dsh-reflex/src/routing.ts`（`installModelRouting`：注册虚拟路由 + `agent/pre-step`/`agent/request` 拦截）
- `packages/dsh-reflex/src/{router,routing}.test.ts`（17 + 19 个新测试）
- `packages/dsh-reflex/src/effort.ts`（`EffortInterceptor`：触发判定、System 1 决策、线索投票、投影、状态）
- `packages/dsh-reflex/src/session-audit.ts`（`plugin:dsh-reflex/effort` 记录的写入与回读）
- `packages/dsh-reflex/src/{effort,effort-routing}.test.ts`（17 + 12 个新测试）
- `packages/dsh-reflex/src/panel-api.ts`（面板的 Host 投影与路由：快照投影、loopback 边界、HEAD/405/400/204 语义）
- `packages/dsh-reflex/src/panel-mount.ts`（`mountReflexPanel`：把面板路由挂进 `ctx.webServer`，单所有者 + 可逆）
- `packages/dsh-reflex/src/panel-api.test.ts` + `panel-mount.test.ts`（22 + 12 个新测试）
- `packages/dsh-reflex/src/plugin.test.ts`（+2：System 1 连接块的默认值/校验、api key 只按环境变量名解析）
- `packages/dsh-reflex/src/client/{index,locale,panel,store,view}.ts`（浏览器半边：槽位注册、zh/en 文案、
  纯视图模型、轮询+提交、设计 token 渲染）
- `packages/dsh-reflex/src/client-bundle.ts`（`tokenize`/`collectRequires`/`buildBundle`/`verifyClientPackage`：
  把 `dist-client/**` 打成单一 `window.__ModuleLoader__` 包并核对 externals）
- `packages/dsh-reflex/src/client-bundle.test.ts` + `client-page.test.ts` + `client-contract.test.ts`
  （7 + 16 + 7 个新测试：打包器单元测试、VM 内整页端到端、清单/产物/注入 id 契约）
- `packages/dsh-reflex/client.js`（构建产物，入库）
- `packages/dsh-reflex/tsconfig.client.json`
- `scripts/link-dsh-deps.mjs`
- `docs/dsh-plugin.md`（本文）
- `src/core/score.ts`、`src/core/ledger.test.ts`、`src/core/score.test.ts`、`src/mcp/server.test.ts`

修改：

- `package.json`（`build:all` / `test` glob 修正 / `test:plugin` / `test:all` / `test:mutation`）
- `.gitignore`（新增 `tmp/`、`dist-client/`）
- `packages/dsh-reflex/package.json`（`exports` 增加 `./client`/`./locale/*.json`，`files` 增加 `client.js`，
  新增 `dsh.client` 与 `build:client` 脚本）
- `packages/dsh-reflex/src/index.ts`（`apply` 的 effect 里增加 `mountReflexPanel`，卸载时一并摘除）
- `packages/dsh-reflex/src/config.ts`（`systemOne` 块：`backend/baseUrl/model/apiKeyEnv/timeoutMs` +
  `resolveSystemOneConfig`/`resolveApiKey`，供面板的「System 1 后端」页读写）
- `packages/dsh-reflex/scripts/mutation-check.mjs`（基线 95 → 161；scratch 副本补 `package.json`/`client.js`/
  `tsconfig.client.json` 并重建客户端产物，使 `src/client/**` 的故障也能被测试抓住；新增 6 条故障：5 条 panel + 1 条 System 1 连接参数）
- `package.json`（`build:all` 末尾追加 `build:plugin-client`）
- `src/core/ledger.ts`（`customPath === null` = 纯内存 + `getLogPath()`；`LedgerEntry.type` 增加 `'model-route'` 与 `'effort-decision'`）
- `src/core/route.ts`（`selectBest(goal, candidates, topK, {record:false})`：允许调用方用自己的审计口径记账）
- `src/index.ts`（导出 `core/score.js`）
- `src/mcp/server.ts`（`reflex_score` 改走共享 `scoreStatement`）
- `README.md`（新增 DSH 插件章节）

g-006（路由上下文感知与会话粘性）增量：

新增：

- `src/backend/route-prompt.ts`（决策上下文的唯一渲染点：`renderCandidateLine`/`renderRouteStateLines`/
  `buildRouteContext`，无 state/instructions 时与历史输出逐字节一致）
- `src/backend/route-prompt.test.ts`（6 条：渲染器、logits 后端的 prompt、Jev 网关的 body）
- `src/core/route.test.ts`（3 条：`selectBest` 转发 state/instructions、无亲和性时请求逐字段不变、台账不受影响）

修改：

- `src/backend/types.ts`（`RouteRequest` 增加 `state`/`instructions`，候选增加可选 `current`）
- `src/backend/{jev,simple-jev}.ts`（Jev 把 `state`/`instructions`/`context` 当数据发；logits 后端把上下文渲染进 prompt）
- `src/core/route.ts`（`selectBest` 的 options 与 `CandidateItem` 透传新增字段）
- `packages/dsh-reflex/src/router.ts`（`estimateContextTokens`/`buildCacheAffinityInstruction`/`CONTEXT_CHARS_PER_TOKEN`/
  `DEFAULT_STICKY_MARGIN`/`CURRENT_MODEL_NOTE`、`stickyMargin` 选项、`#preferIncumbent` 粘性闸门、
  `RouteDecision` 的 `currentModel/switched/contextTokens/contextChars`、台账与降级路径的新字段）
- `packages/dsh-reflex/src/routing.ts`（`AgentRoutingFacts` 逐 agent 记上下文规模与当前物理模型、
  `measureMessages`/`rememberStep`/`rememberTarget`/`recallFacts`，`agent/request` 带上 `state`/`instructions`）
- `packages/dsh-reflex/src/bridge.ts`（决策 seam 透传 `input`）
- `packages/dsh-reflex/src/panel-api.ts`（`PanelLedgerRow` 投影 `currentModel`/`switched`/`contextTokens`）
- `packages/dsh-reflex/src/{router,routing,panel-api,tools}.test.ts`、`src/mcp/server.test.ts`
  （新增 11 + 4 + 2 条测试；后两者把两处独立计时字段的比较改为「钉住数值、只校验类型」，消除既有的
  负载敏感抖动）
- `packages/dsh-reflex/scripts/mutation-check.mjs`（基线 161 → 186；新增 7 条故障：上下文规模、亲和策略、
  粘性闸门、台账字段、跨轮记忆、路由上报上下文、面板 switch 投影）
- `USER_GUIDE.md` / `docs/USER_GUIDE.en.md`（虚拟 Provider 一节补「上下文感知与会话粘性」小节）
- `docs/dsh-plugin.md`（本文：§4 第 32–36 条、§5 计数、§6 边界、§12 验收对照）

## 10. 设置面板验收对照（g-004）

| 判据 | 实现 | 证据 |
| --- | --- | --- |
| ① 插件导出完整的 Client 端扩展（`dsh.client` + `./client`） | `package.json`：`dsh.client = {platform:'web', inject:['@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-settings'], external:['react']}`、`exports['./client'] = './client.js'`、`files` 含 `client.js`；`src/client-bundle.ts` 产出单一 `window.__ModuleLoader__.load({id:'dsh-reflex', factory})` 包（5 模块内联，`react` 走平台 seed） | `the manifest publishes the browser half as a client module`、`the artifact is a client module the loader can recognise`、`the bundle requires only the specifiers the manifest declares external`、`the injected client modules are declared client modules of this platform`（用 `require.resolve('@deepseek-ai/dsh-client-modules/package.json')` 定位 DSH 安装目录逐个核对 `inject` 的包确实存在且 `platform === 'web'`）、`the reported plugin version is the published one`、`the bundle keeps every dependency at the platform seed boundary` |
| ② 注册进设置面板槽位，可视化虚拟模型池（增删查改物理 provider/model 绑定） | `src/client/index.ts` 在 `ctx.slots.inject('settings.section', …)` 里注册 `{id:'reflex', order:55, label:t('title')}`；`RoutingTab` 渲染池卡片：每个虚拟模型一行（ID/描述/标签/启用），候选行（`物理 Provider`/`物理模型`）、`新增候选`/`删除该模型`/`新增虚拟模型`/`上移`/`下移`；编辑走 `store.editPools` + `diffDraft(routing)` → `form.mutate([{op:'set', path:['routing']}], revision)` | `the browser half activates, translates, and registers one settings page`（label = `Reflex 决策运行时`、order 55）、`a namespace the Host does not serve registers nothing`、`the routing page reads the authored section back as authored`（`reflex` / `deepseek:deepseek-chat` / `400` / `reflex-pro` / checkbox `true` 全部回填）、`one edit inside a group becomes one whole-section write`（一次编辑 = 一条 `{op:'set', path:['routing']}`，带当前 revision）、`the group the page writes satisfies the Host validator`（`resolveConfig` 接受写回块，effort 归一为 `setting`）、`the candidate pool can be extended, reordered, and written back`（`新增候选` → 输入 → `↑` → 保存后池顺序被钉死）、`an invalid draft is reported and never written`（`虚拟 Provider 名称不能为空` + `任务文本预算必须是正整数`，且零写入） |
| ③ 可视化配置思考等级开关（reflex/auto）与 System 1 后端连接参数 | `EffortTab`：开启开关 + 默认档（`reflex/auto` 触发标记与 `off…max` 等级同表）+ 触发规则 + 置信度下限；`BackendTab`：backend 选择、baseUrl、model、API key 环境变量、超时；Host 侧 `resolveSystemOneConfig` 校验 `timeoutMs` 为正整数且空串=未设置、`Config` 校验 backend 枚举、`resolveApiKey` 只按变量名解析 | `the effort page offers exactly the levels the Host accepts`（选项 = `['', ...EFFORT_TRIGGERS, ...EFFORT_LEVELS]` 与 `[...ADAPTIVE_EFFORT_LEVELS]`）、`the backend page shows where the key lives, never the key`（显示变量名 + `环境变量已就绪`；`SECRET` 字面值不出现在页面任何位置）、`the backend page reports a missing key variable`（`环境变量为空`）、`the System One connection block fills defaults and refuses unusable values`、`an api key is read from the environment by name and never from the document`、`system-one-timeout-unchecked` 变异对照 |
| ④ 决策账本概览面板（决策次数、节省 Token、平均耗时等实时指标） | `OverviewTab` 读 `panel-api.buildPanelSnapshot` 的汇总与池投影；`LedgerTab` 渲染最近 N 条（时间/类型/目标/后端/耗时/省 token）并提供 `清空账本`（两步确认 → `POST …/ledger/clear?confirm=clear`）；数据每 4000ms 轮询一次 | `the overview renders the Host projection, not a rewrite of it`（`2` 次调用 / `1,024` tokens saved / `$0.500` / `10.3 ms` / `3 / 1` gate 通过比 / 池 `reflex-pro` `1 候选`）、`the ledger page lists decisions and clears only after confirmation`（第一次点击零请求，确认后 `已清空 2 条记录`）、`the snapshot carries exactly the projected facts`、`the snapshot projects ledger details instead of serializing them whole`、`a HEAD answer carries headers and no body`（HEAD 与 GET 的 content-length 一致）、`the route family owns exactly its three exact paths` |
| ⑤ 严格适配主题 token + 完备 zh/en 文案 | `src/client/view.ts` 的样式表全部是 `var(--dsw-alias-*, <fallback>)`（`bg-base/layer-*`、`border-l*`、`label-*`、`brand-primary`、`state-*`、`interactive-bg-*`、`button-primary-*`、`scrollbar-*`…），不写死颜色；`locale.ts` 提供 zh/en 两份同构字典（`NS = 'dsh-reflex.panel'`） | `the browser half activates, translates, and registers one settings page`（整份 zh 字典 + `title` = `Reflex 决策运行时`）、`the page follows the Host language`（en 页面里 `Reflex · System One decision runtime` 且无中文泄漏）、`the locale namespace the client registers is the one the host documents`（bundle 里 `dsh-reflex.panel` + `zh`/`en` 字典齐全）、`only loopback literals pass the address check` + `a remote peer is refused before any path or method is considered`（面板默认不对外） |

## 11. 使用说明、UI 查看与发布打包验收对照（g-005）

| 判据 | 实现 | 证据 |
| --- | --- | --- |
| ① 详尽使用说明（插件架构 / 虚拟 Provider 模型池 / 自适应思考等级 / System 1 后端 / MCP↔原生工具对照） | [`USER_GUIDE.md`](../USER_GUIDE.md)（中文，12 节）与 [`docs/USER_GUIDE.en.md`](./USER_GUIDE.en.md)（English，同构 12 节）：架构图、安装与构建、`SYSTEM_ONE_BACKEND` 接入、虚拟 Provider 与模型池配置、`reflex`/`auto` 思考等级、设置面板说明、8 个 `reflex_*` 工具与 MCP 对照表、决策账本、测试与发布、FAQ、版本兼容 | `guide.test.ts`：两份文档摘要与产物一致、节号齐全、各自包含 `npm run build:all` / `dsh plugin add` / `settings.section` / `client.js` / `SYSTEM_ONE_BACKEND` / `virtualProvider` / `reasoningEffort` / `reflex-auto` 与 8 个工具名；两份文档都能被渲染器解析出 ≥13 个标题、≥3 张表（无空/错位单元格）、≥6 个带语言标注的代码块 |
| ② 设置页 UI 内可查看说明（独立 Tab + 中英双语） | `src/client/store.ts` 的 `PANEL_TABS` 增加 `'guide'`；`src/client/view.ts` 的 `GuideTab` 渲染标题/导语/来源摘要 + `renderMarkdown(t('guideBody'))`；`locale.ts` zh `使用说明` / en `Guide`，正文随 Host 语言切换 | `client-page.test.ts`：`the guide page renders the shipped user guide inside the panel`（探针 `Harness Reflex 使用说明`、`1. Harness Reflex 是什么`、`虚拟 Provider 与模型池`、`npm run build:all`、`reflex_detect_stagnation`，并断言渲染出 h1/h2/table/pre/li 与 `/文档来源 USER_GUIDE\.md · 摘要 [0-9a-f]{12}/`）、`the guide page follows the Host language`（en 界面读英文文档）、tab 文案断言包含 `使用说明` / `Guide` |
| ③ 文档与查看功能在构建/打包产物中完整生效 | `build:plugin-client` 与插件 `build:client` 都先跑 `scripts/embed-user-guide.mjs`；`client.js` 内联两份文档与摘要；根包 `files` 白名单新增 `USER_GUIDE.md`（`docs/**/*.md` 已覆盖英文版） | `npm run build:all` exit 0（`client-bundle: wrote …/client.js (172049 bytes, 8 modules, externals: react)`）；`npm run release:pack`：`plugin: the shipped guide is the repository revision`、`root: the shipped guide is the repository revision`（比对 release tarball 内文档与仓库文档的 sha256）、`plugin: the browser half is one self-contained artifact` |
| ④ 补齐相关自动化测试 | 新增 `packages/dsh-reflex/src/guide.test.ts`（5 条）、扩展 `client-page.test.ts`（+2 条）、新增根包 `src/release-packaging.test.ts`（6 条打包清单测试） | `npm run test:plugin` = 209/209；`npm test` = 58/58；`the plugin manifest ships the browser half and the guide it renders`、`the plugin declares every host package its build imports`、`the root files allow-list ships the release promises and nothing else` |
| ⑤ 最终集成验收与 release tarball | `scripts/release-pack.mjs`：真实 `npm pack` 两份包 → 解压核验（必需文件 / 禁运测试产物与临时目录 / 无本地绝对路径 / 零死链 / 零未声明运行时依赖 / bin 可执行位）→ 根包离线 `npm install` 冒烟（`bin --help`、具名 import、stdio MCP `tools/list` 八个工具）→ 插件按发布形态解压后 `import` 冒烟 → `SHA256SUMS` + `release-report.json` + `RELEASE-<version>.md` | `npm run release:pack` 26/26 通过：`release/harness-reflex-0.1.0-alpha.2.tgz`（68 entries）、`release/dsh-reflex-0.1.0-alpha.2.tgz`（90 entries）；`the packed tarball can resolve its runtime dependency by name`（`harness-reflex` 声明为 `^0.1.0-alpha.2` 可发布范围）；`a packed release directory is internally consistent`（重算 SHA256SUMS） |

## 12. 路由上下文感知与会话粘性验收对照（g-006）

| 判据 | 实现 | 证据 |
| --- | --- | --- |
| ① System 1 路由请求带上会话累积上下文规模与当前物理模型 | `packages/dsh-reflex/src/routing.ts`：`AgentRoutingFacts` 按 agent 累计 `agent/pre-step` 观测到的字符数（`measureMessages`，上限 64 个 agent），`recallFacts` 在 `agent/request` 里取回，`estimateContextTokens(chars) = ceil(chars/4)`；`RouteDecisionInput` 作为决策 seam 的第 4 个参数透传到 `RouteRequest.state.{currentModel,contextTokens,contextChars}`，`src/core/route.ts` 与 `src/bridge.ts` 只做透传 | `the decision request carries the session context size and current model`（`state.currentModel='deepseek:chat'`、`contextChars=12000`、`contextTokens=3000`）、`an explicit token count wins over the estimate from characters`、`estimateContextTokens rounds characters up at the documented ratio`、`each session defends its own model and its own context size`（两个 agent 各自上报自己的 `contextChars`，tokens = `ceil(chars/4)`）、`selectBest forwards the session facts and the policy to the backend`、`routing-reports-no-context` 变异对照 |
| ② 决策提示词注入「保留当前模型可省缓存、非必要不切」的偏好 | `router.ts` 的 `buildCacheAffinityInstruction(facts)`（无当前模型 / 当前模型不在池里 / 建议保留 三种措辞）→ `RouteRequest.instructions`；`state` 给结构化后端；候选描述追加 `CURRENT_MODEL_NOTE = '[current model — keeping it preserves the prompt cache]'` 且带 `current: true`；`src/backend/route-prompt.ts` 是唯一渲染点，`system-one-logits` 渲染进 prompt、`JevDecisionBackend` 发 `state`/`instructions`/`context` | `the incumbent candidate is marked for the decision, in both readings`、`buildCacheAffinityInstruction states the policy, not a verdict`、`the logits backend puts the affinity facts and policy in the prompt it scores`、`the Jev gateway is handed the same facts as data, policy and rendered context`、`a request without affinity renders exactly the historical context block` + `a request without affinity posts exactly the historical Jev body`（无亲和性时请求逐字段与历史一致）、`affinity-policy-not-stated` / `affinity-drops-token-estimate` 变异对照 |
| ③ 当前模型尚可胜任时稳定保留，只有明显超出才切换 | `#preferIncumbent`：挑战者须 `score > 当前分` **且** `score >= 当前分 × (1 + stickyMargin)`（`DEFAULT_STICKY_MARGIN = 0.15`，相对门槛以兼容 mock/概率/logit 三种量纲）才算「明显更合适」；否则守住当前模型并把 `reason` 记为 `sticky-affinity`；当前模型不在池内时不阻拦，按名次走 | `a session is not switched for a marginal score difference`（0.5 vs 0.45 → 守住 `deepseek:chat`，`reason='sticky-affinity'`）、`a challenger that only ties the incumbent never displaces it`、`a clearly better candidate still displaces the current model`（0.95 vs 0.2 → `switched=true`）、`stickyMargin=0 switches on any strict improvement`、`a current model outside the pool is reported but cannot be defended`、集成测试 `a second turn keeps the physical model the session already warmed`（真实 waterfall + 真实 mock backend：第二轮并列分不再退回配置顺序）、`each session defends its own model and its own context size`、`sticky-gate-always-switches` / `routing-forgets-routed-model` 变异对照 |
| ④ `model-route` 台账记录 `currentModel` / `switched` / `contextTokens` 与原因 | `routeModel` 的台账 `details` 增加 `currentModel`（首轮为 `null`，字段恒在）、`switched`（`formatTargetName(target) !== decision.currentModel`）、`contextTokens`、`contextChars`，保留 `reason`（`matched` / `sticky-affinity` / `degraded`…）；降级路径 `#degrade` 同样写这四个字段；`panel-api` 的 `projectRow` 把三者投影给面板（`currentModel` 为 `null` 时不投影） | `a first decision has no incumbent and no switch to report`（`currentModel=null`、`switched=false`、`contextTokens=0`）、`a degraded decision still reports the session facts and the switch it caused`、`a session is not switched…` 与 `a clearly better candidate…` 对台账字段的断言、`a routing decision projects its cache-affinity audit fields`、`a first decision with no incumbent projects no currentModel`、`affinity-audit-loses-current-model` / `panel-drops-switched-flag` 变异对照 |
| ⑤ 单元测试与变异测试同步更新；`build:all` + `npm test` + `release:pack` 全绿 | 新增 11 条 router 测试、4 条 routing 集成测试、2 条 panel-api 测试、6 条根包 backend 测试、3 条根包 core 测试；`mutation-check.mjs` 基线 161 → 186 并新增 7 条 g-006 故障 | `npm run build:all` exit 0；`npm test` = 26/26；`npm run test:plugin` = 186/186；`npm run test:mutation` = 32/32（31 由测试、1 由编译器）；`npm run release:pack` = 26/26 |

## 13. 自适应强度闭环、虚拟路由静默与对话状态行验收对照（g-008）

来源：`reflex-adaptive-test-report.md`（用户实测报告）。基线 `96ee8429`，尝试 `att-001`（rewrite）。

| 判据 | 实现 | 证据 |
| --- | --- | --- |
| S1 客户端注册浅色会话状态行，可展开同轮多步聚合，且零上下文 token | `src/client/effort-row.ts`：`ctx.get('uiConversation')` 拿到会话服务后 `conversation.events.register(effortRowDefinition)`，并 `slots.inject('conversation.chat.node', …)` 注册同行槽位（`kind === 槽位 key === 'reflex-effort'`，`target:'chat'`，`anchorSeq = 最新步 seq + 0.02`，`visibility:'visible'`）；`<details>/<summary>` 展开显示档位→下发档位（outcome）、路由、同轮步数徽标，正文是 3 行步表（seq/档位/延迟/basis）；宿主侧 `appendPluginRecord` 把 `plugin:dsh-reflex/effort` 标为 `ignorable` | `effort-row-client.test.ts`（6 条，**直接加载入库产物 `client.js`** 于 VM + 假 React）：注册形态（`target==='chat'`、`slot.name==='conversation.chat.node'`、`slot.key===definition.kind`、`slot.locale==='dsh-reflex.panel'`）、match 认领/拒收、同轮聚合/跨轮排除/重放就地更新/迟到步序、节点形状（`anchorSeq 14.02`、空状态返回 null）、渲染（根 `details`、`fontSize 12px`、`1px solid var(--dsw-alias-border-l1…)`、`var(--dsw-alias-bg-layer-2…)` 浅色、3 行 `tr`、`0.82`、`12ms`、`reflex/reflex-auto → deepseek/reasoner`）、英文回退无 key 泄漏；零 token 由 `effort-routing.test.ts` 的 ignoble 记录断言钉死 |
| S2 虚拟路由下不再逐步注入 `[model changed: …; the session continues with reflex/*]` | `src/routing.ts`：`isVirtualModelSwitchNotice`（认 `<from> → <to>` 摘要、`continues with <to>` 正文、`reflex/…` 前缀、池内模型名）与 `filterVirtualSwitchNotices`（不改原对象、无命中时返回同一引用）；`ensureVirtualSwitchFilter` 在该 agent 自己的 ctx 上以 `prepend` 后注册，成为 `installModelSelection` 通知层的**外层**包装，因此能删掉已追加的假通知；仅针对虚拟目标，物理↔物理切换通知保留 | `virtual-switch-notice.test.ts`（4 条）：认领矩阵（含 `form:'selection'`、纯文本引用、无目标一律拒收）、单次决策过滤（仅假通知被删、物理通知逐字保留、入参不被改动、无命中返回同一引用）、真实 waterfall 集成（第 1 步仍播报一次 → 第 2 步起为 0、任务文本存活、物理通知仍送达、安装后覆盖后续所有步）、无 `agent.ctx` 的 agent 不被打断（通知原样通过而非抛错） |
| S3 + P9 先定目标模型、读其声明档位、**在声明集合内**自适应，不常态化 `snapped`；纯逐字复述深度关键词须判 `off`/`low` | `src/effort.ts`：#decideTurn 对逐字复述轮次**先短路**（不咨询 System 1，理由写进台账）、`#askSystemOne` 在置信度地板之后追加「必须超过 `1/候选数` 均分基线」的否决、`buildEffortChoiceOptions(efforts?)` 按目标模型声明的档位收敛候选（邻居吸附）、`VERBATIM_INSTRUCTION` 扩到 `原样发给我/原样发给/原样输出/原文照抄/照抄` | `effort-model-levels.test.ts`：中文深度轮次读 System 1 词汇（`source==='system-one'`、`confidence > 1/3`、`high`）而非坍缩到首候选；「只与均分持平」的答案在任何候选数下都不被信任（GPT/FULL/DEEPSEEK → `cue-fallback`，reason 命中 `/floor|baseline/`；对照组 0.5 → `system-one` + `low`）；简报点名的每种复述措辞都保住低成本档（`cleaned.verbatim === true`，`off|low`，`outcome 'supported'`） |
| S4 有思考能力的物理模型与虚拟模型都在模型选择器里提供 `reflex` 自适应档；无思考能力模型不显示；固定物理模型只调档位不改路由；策略跨切换/恢复保持且不覆盖显式档位 | `src/routing.ts` 的 `installAdaptiveEffortSurface` 包装 `resolveModelInfo`（只在**已声明 reasoning** 的模型前面插入 `{id:'reflex', name:'Reflex (Auto)'}`，`defaultEffort` 保持适配器原值）、`resolveCallConfig`/`prepareCall`（把标记还原成目标模型声明集合内的档位）；`src/virtual-adapter.ts` 的虚拟模型声明 `reflex` 选择且**不带** `defaultEffort`（带上的话会打断 `markAgentLoopRequest` 的请求同一性）；`model/selection` 回放：日志里是 `reflex` 则重新武装自适应，是具体等级则解除 | `adaptive-effort-surface.test.ts`（7 条）：思考路由首位是 `Reflex (Auto)` 且既有档位与默认值存活、无 reasoning 的路由完全不出现档位、未激活时不发明 `reasoningEffort`、显式物理选择不被改写、`prepareCall` 后请求同一性保持 |
| 接口一致性 / 版本 / 序列化 / 打包 / 真机 | `reflex_detect_stagnation` 增加可选 `history`（`MAX_HISTORY=30`，`mergeHistory`）；版本 `0.1.0-alpha.2`；DeepSeek/GPT 序列化载荷结构化验证；四套命令全绿；`release/` 只留 alpha.2 产物 | `npm run build:all` exit 0（`client.js (172049 bytes, 8 modules, externals: react)`）；`npm test` = 58/58；`npm run test:plugin` = 219/219；`npm run release:pack` = 26/26（`harness-reflex-0.1.0-alpha.2.tgz` 68 entries、`dsh-reflex-0.1.0-alpha.2.tgz` 90 entries）；`provider-serialization.test.ts`（4 条，缺失 SDK 时按 NT 跳过并显式声明）；**真机**：`tmp/dsh-home` 装 alpha.2 tarball 起 `dsh web --port 3099`，面板显示 `v0.1.0-alpha.2`、`/dsh-reflex/api/health` 返回 `{"name":"dsh-reflex","version":"0.1.0-alpha.2"}`、配置池后模型选择器出现「Reflex (System 1 router) → reflex-auto」、插件页状态条 `激活·reflex·mock-heuristic-v1`、池 `reflex-auto 2 候选`（截图 `tmp/e2e-reflex-panel-3099.png`）；有意保留的取舍：固定物理模型下需在选择器里选 `reflex` 才进入自适应，选具体等级即钉死 |

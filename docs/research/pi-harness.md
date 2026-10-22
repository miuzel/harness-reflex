# pi coding agent 扩展机制调研

> 面向 v0.2.0「pi coding agent 插件」的前置调研。本文只调研与写文档，不改代码、不改版本号、不提交 PR。
>
> 调研对象是 **pi coding agent**（`pi-mono` 仓库中的 CLI harness，带 extensions 机制），
> **不是** DSH 的 `@deepseek-ai/dsh-llm-pi-ai` LLM 适配器。两者只在共享 `@earendil-works/pi-ai` 这个 LLM 客户端库这一点上相关，见 §7.4。
>
> **调研基线**：`badlogic/pi-mono`（GitHub 已迁至 `earendil-works/pi`）commit
> `58c0b02ce552adab76014e7ed712ab7981359aa8`，包版本 `@earendil-works/pi-coding-agent@1.4.0`，
> 提交时间 2026-10-22；npm `latest` 同为 1.4.0（2026-10-21 发布）。调研日期 2026-10-22。
>
> **证据标记**：
> **[实测]** 本机实际运行并记录输出；**[源码/文档]** 上游仓库文档或 TypeScript 定义；
> **[推断]** 基于源码/文档的工程判断；**[未验证]** 本次没有端到端跑通、需要凭据或真实会话才能确认。

---

## 1. 结论速览

| 问题 | 结论 | 程度 |
|---|---|---|
| 扩展形态 | 进程内 TypeScript 模块，默认导出 `(pi: ExtensionAPI) => void`；目录发现、`settings.json` 配置、`-e/--extension`、Pi package（npm/git/本地）四种加载方式 | 清晰 |
| 是否需要构建 | 本地 TS 扩展**不需要**单独编译，Pi 用 `jiti` 直接加载；npm 分发建议只发布源码或 `dist` 均可，宿主包必须走 `peerDependencies` | **[实测]** 无构建加载成功 |
| 注册新工具 | `pi.registerTool()`，TypeBox schema + `execute()`，返回 `content`/`details`/`structuredContent` | 可做到 |
| 改写工具输出 | `pi.on("tool_result")` 返回替换后的 `content`/`details`/`structuredContent`/`isError`，多个 handler 链式组合 | 可做到 |
| 拒绝工具调用 | `pi.on("tool_call")` 返回 `{ block: true, reason }`；handler 抛错也会 fail-closed 阻断 | 可做到 |
| 注入上下文 | `context`/`context_with_system` 改写消息、`before_agent_start` 追加消息或替换 system prompt、`sendMessage`/`context_edit` | 可做到 |
| 收尾阻止结束 | `agent_before_settle` 可追加条目并 `continue: true` 请求**一次**下一次模型请求；没有硬否决/阻止退出的 API | **部分** |
| 模型/思考等级 | `setModel`、`setThinkingLevel`、`registerProvider`、`registerVirtualModel`（逐请求路由）、`before_provider_request` | 可做到 |
| MCP | 原生 MCP **客户端**：stdio + streamable HTTP，`~/.pi/agent/mcp.json` / `.pi/mcp.json` / `pi mcp` 命令；扩展也可 `registerMcpServer` | 可做到 |
| 与 DSH 四能力差集 | 剪枝/停滞/纠偏 可做到；收尾 部分；工具面与模型面基本对等 | 见 §7 |
| 主要风险 | 1.x 仍在频繁 breaking change；扩展与宿主同权限、无沙箱；每个工具事件都同步/异步串行等待，需控制延迟 | 见 §8 |

---

## 2. 扩展形态：注册、分发、安装

### 2.1 扩展是什么

扩展是普通 TypeScript/JavaScript 模块，默认导出一个工厂函数，拿到 `ExtensionAPI`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (_name, ctx) => ctx.ui.notify("Hello", "info"),
  });
}
```

**[源码/文档]** `packages/coding-agent/docs/extensions.md` §"Create and load an extension"。
扩展运行在 Pi 进程内，拥有与 Pi 相同的操作系统权限，可以读取 prompt、工具调用、文件、凭据和会话历史；
文档明确要求只加载可信来源。

工厂可以是异步的，Pi 会等待工厂完成再继续启动。但不要在工厂里启动长期进程/socket/watcher/timer，
长生命周期资源应放到 `session_start`，并在 `session_shutdown` 幂等释放。

### 2.2 发现与分发（四种）

| 方式 | 具体形态 | 证据 |
|---|---|---|
| 用户目录 | `~/.pi/agent/extensions/`（单文件，或含 `index.ts`/`index.js` 的子目录） | **[源码/文档]** extensions.md §"Add it to Pi"、configuration.md |
| 项目目录 | `<cwd>/.pi/extensions/`（需要 project trust） | 同上 |
| 配置字段 | `settings.json` 的 `"extensions": ["path", "!glob", "+exact"]`；项目 `settings.json` 也可写 | **[源码/文档]** settings.md §Resources |
| 命令行 | `pi -e ./hello.ts` / `pi --extension <path>`，可重复；`pi -ne` 禁用已发现扩展（显式 `-e` 仍加载） | **[源码/文档]** cli.md §Resources |
| Pi package | `pi install npm:@scope/pkg@1.0.0`、`git:github.com/...`、`./local-package`；`pi list`、`pi remove`、`pi update --extensions`；包内用约定目录 `extensions/`，或在 `package.json` 的 `"pi": { "extensions": [...] }` 显式声明 | **[源码/文档]** packages.md |
| 一次性试用 | `pi -e npm:@scope/pkg` 不写入 settings | **[源码/文档]** packages.md |

包分发细节：
- 包是“普通目录或 npm 包”，可同时携带 extensions / skills / prompts / themes。
- `keywords: ["pi-package"]` 只影响 pi.dev 包画廊收录，不影响加载。
- 宿主提供的模块（`@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`）
  必须放在 `peerDependencies` 且 `"*"`，**不要**放进 `dependencies` 或打包，否则会出现重复的类/注册表。
- npm 包的运行时依赖放 `dependencies`，Pi 安装包时会一并安装。

### 2.3 安装 pi 本身与构建要求

官方安装：

```bash
# macOS / Linux（安装脚本会固定依赖版本）
curl -fsSL https://pi.dev/install.sh | sh

# Windows
powershell -c "irm https://pi.dev/install.ps1 | iex"

# 或 npm（不固定传递依赖）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

要求 **Node.js >= 22.19**（README §Getting started）。npm 提供 `legacy-node20` dist-tag 指向 `0.74.2`，说明
新版本已不再支持 Node 20。

**构建步骤：本地 TS 扩展不需要构建**。extensions.md 明确写“Pi uses `jiti`, so local TypeScript extensions do not need a separate compilation step”。
npm 包是否附带 `dist/` 由作者决定；Pi 加载的是入口文件，jiti 负责转译 TS。

**[实测]** 本机用 Node `v26.7.0` 安装 `@earendil-works/pi-coding-agent@1.4.0` 后：

```bash
PI_CODING_AGENT_DIR=$PWD/tmp/pi-agent \
  ./tmp/pi-install/node_modules/.bin/pi --version
# 1.4.0

PI_CODING_AGENT_DIR=$PWD/tmp/pi-agent \
  ./tmp/pi-install/node_modules/.bin/pi --extension ./tmp/smoke-ext.ts --help
# 输出中包含扩展注册的 flag：
#   --reflex-smoke    smoke flag
```

这同时证明了：**不经过 tsc、直接 `--extension` 加载 .ts、工厂函数被执行、`registerFlag` 生效**。
完整的可复制命令见 §11。

### 2.4 扩展可访问的 API 面

| 能力 | API |
|---|---|
| 生命周期事件 | `pi.on(event, handler)`，返回取消订阅函数 |
| 模型可调用工具 | `pi.registerTool()`、`pi.getAllTools()`、`pi.getActiveTools()`、`pi.setActiveTools()` |
| 斜杠命令 / 快捷键 / CLI flag | `registerCommand` / `registerShortcut` / `registerFlag` |
| 向会话发消息 | `sendMessage()`（custom message）、`sendUserMessage()` |
| 持久化非上下文数据 | `appendEntry()` |
| 会话控制 | `setModel()`、`getThinkingLevel()`、`setThinkingLevel()`、`getSettings()` |
| 模型提供方 | `registerProvider()` / `unregisterProvider()` |
| 虚拟模型/路由 | `registerVirtualModel()` / `unregisterVirtualModel()` |
| MCP | `registerMcpServer()` / `unregisterMcpServer()` / `getMcpServers()` |
| UI | `ctx.ui`（select/confirm/input/editor/notify/setStatus/setWidget/custom…） |
| 执行子进程 | `pi.exec()` |
| 扩展间通信 | `pi.events` |
| 嵌套工具调用 | `ctx.executeTool(name, args, ...)` |

**[源码/文档]** extensions.md §"Choose an integration point" 与 `src/core/extensions/types.ts` 的 `ExtensionAPI` 接口。

UI 注意事项：扩展在 interactive / RPC / JSON / print 四种模式都会加载；只有 interactive 有完整终端 UI，RPC 只能转发支持的对话框，
JSON/print 没有 UI。应使用 `ctx.mode === "tui"` 与 `ctx.hasUI` 做降级。

### 2.5 信任与权限边界

- 项目级资源（`.pi/extensions/`、`.pi/settings.json` 声明的包）要等 project trust 通过后才加载。
- 扩展拥有与 Pi 相同的 OS 权限，**没有沙箱**；文档要求只加载可信扩展。
- 扩展的 handler 错误通常“报告后继续”，但 `tool_call` handler 抛错会 **fail-closed** 阻断该工具调用。

---

## 3. 工具面

### 3.1 注册新工具

```ts
pi.registerTool({
  name: "reflex_gate",
  label: "Reflex Gate",
  description: "Verify claims against evidence",
  parameters: Type.Object({ claims: Type.Array(Type.String()) }), // TypeBox
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: "..." }], // 模型可见
      details: { ... },                            // UI/状态重建，模型不可见
      // structuredContent 需同时声明 outputSchema
    };
  },
});
```

- schema 用 TypeBox（`@sinclair/typebox` 或宿主提供），参数校验由 Pi 执行。
- 返回 `content` + `details`；若声明 `outputSchema`，还应返回匹配的 `structuredContent`，codemode 脚本会拿到结构化值。
- 失败：`throw` 会变成失败的工具结果（模型看到错误）；要“带数据失败”则返回 `isError: true`。
- `terminate: true` 只表示“本批所有工具都同意终止时，跳过自动 follow-up”，不是强制结束回合。
- `exposure` 控制模型是否直接看到：`direct`（默认）/`model-only`/`codemode`/`deferred`/`hidden`；
  `hidden` 可用来“撤下”工具，因为**工具不能反注册**。
- `annotations`（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`）可供权限扩展决策，Pi 不验证。
- 工具可用 `ctx.executeTool()` 调其他工具；嵌套调用同样经过 `tool_call`/`tool_result`，但不会在 transcript 里产生独立条目。

### 3.2 拦截、改写、拒绝、注入

| 需求 | 做法 | 结果 |
|---|---|---|
| 改写入参 | `tool_call` handler 里**原地修改** `event.input` | 后续 handler 看到修改；**不会重新做 schema 校验**（文档明确） |
| 拒绝调用 | `return { block: true, reason: "..." }` | 工具不执行，模型收到阻断原因 |
| 阻断后停止后续 | `{ block: true, terminate: true }` | 仅当同批所有最终结果都 `terminate` 时才提前结束 |
| 改写输出 | `tool_result` handler 返回 `{ content, details, structuredContent, isError, usage }` | 链式组合：后一个 handler 看到前一个的修改 |
| 注入上下文 | `context` / `context_with_system` / `before_agent_start` / `sendMessage` / boundary `context_edit` | 见 §4 |
| 对 MCP 工具同样生效 | MCP 调用走同一条工具管线 | 权限门可统一覆盖内置工具与 MCP 工具 |

关键细节：

- `tool_result` 替换 `content` 时若不同时返回 `structuredContent`，结构化内容会被**丢弃**（可能不再匹配）；文档要求 redact 时一并替换。
- `tool_call` 的入参修改发生在校验之后，扩展要自己保证修改后的形状合法，否则工具执行可能出错。
- 一个 assistant 消息里的多个工具调用**可以并行执行**，tool 事件会交错；不要假设兄弟调用/结果一定存在。
- 处理耗时直接加在每次工具调用上；剪枝类扩展应尽量做纯内存、毫秒级决策。

### 3.3 四项关键能力的判定与验证状态

| 能力 | 判定 | API / 文档依据 | 验证状态 |
|---|---|---|---|
| 注册新工具 | **可做到** | `pi.registerTool()`；`ToolDefinition`（TypeBox `parameters` + `execute` 返回 `content`/`details`） | **[源码/类型]**；本地烟测确认扩展加载并注册 flag，工具本身未在真实会话被模型调用（**[未验证]**） |
| 改写已有工具输出 | **可做到** | `pi.on("tool_result")` 返回 `{ content, details, structuredContent, isError, usage }`，handler 链式组合 | **[源码/类型]**；未跑真实工具结果（**[未验证]**） |
| 拒绝工具调用 | **可做到** | `pi.on("tool_call")` 返回 `{ block: true, reason }`；handler 抛错也 fail-closed | **[源码/类型]**；未跑真实模型下的阻断（**[未验证]**） |
| 收尾阻止结束 | **部分**（只能请求续跑，不能硬否决） | `agent_before_settle` / `turn_end` 的 `BoundaryResult`：`{ entries, continue: true }`；`continue` 需可运行上下文 | **[源码]** `agent-session.ts::_runBeforeSettleBoundary`；真实续跑/循环行为（**[未验证]**） |

### 3.4 工具名与暴露面

- 工具名即模型调用名；建议加前缀（如 `reflex_`）避免与内置/MCP 工具冲突。
- MCP 工具命名固定为 `mcp__<server>__<tool>`，server 名做字符归一与冲突哈希。
- `getAllTools()` 返回 `exposure`、`namespace`、`annotations`、`reachesTools` 等元数据；`setActiveTools()` 只影响“声明给模型”的集合。
- `prepareLoadout` 可在工具激活时改写声明给模型的描述，或隐藏某些声明（工具仍可被 `ctx.executeTool` 调用）。

---

## 4. 生命周期钩子

### 4.1 一次 run 的顺序

```text
input
  -> before_agent_start
  -> agent_start
  -> 循环 turns:
       turn_start
         -> context
         -> context_with_system
         -> before_provider_headers
         -> before_provider_request
         -> after_provider_response
         -> provider_stream_event / message_start / message_update / message_end
         -> 工具执行: tool_execution_start -> tool_call
                     -> tool_execution_update（执行中）
                     -> tool_result -> tool_execution_end
       turn_end
  -> agent_end
  -> agent_before_settle
       -> continue? -> 回到 agent_start（一次续跑）
  -> agent_settled
```

**[源码/文档]** extensions.md §"Understand the runtime lifecycle"（1.4.0）。会话生命周期另有
`project_trust` → `session_start` → `resources_discover`；`/new`、`/resume`、`/fork`、reload 会走
`session_before_switch`/`session_before_fork` → `session_shutdown` → 新运行时 `session_start`。

### 4.2 事件分组与语义

| 组 | 事件 | 语义 |
|---|---|---|
| 输入 | `input`, `before_agent_start` | 读取/改写原始用户输入；在 run 前改 prompt 段落、活动工具、追加消息 |
| Agent run | `agent_start`, `agent_end` | 观察一次底层 run；`agent_end` **不是**最终空闲信号（重试/压缩/排队可能再起 run） |
| 模型 turn | `turn_start`, `context`, `context_with_system`, `turn_end` | 每个 turn 一次模型请求；`turn_end` 是“本轮已结束”的可动作边界 |
| Provider | `before_provider_headers`, `before_provider_request`, `after_provider_response`, `provider_stream_event` | 改请求头/请求体；观察响应元数据/解析后的流事件；`provider_stream_event` **只读** |
| 消息 | `message_start`, `message_update`, `message_end` | `message_update` 逐 token；`message_end` 可替换最终消息（保持角色） |
| 工具 | `tool_execution_start`, `tool_call`, `tool_execution_update`, `tool_result`, `tool_execution_end` | 见 §3 |
| 收尾 | `agent_before_settle`, `agent_settled` | `before_settle` 可追加条目并请求一次续跑；`settled` 只通知 |
| 会话 | `session_start`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_shutdown` | 初始化/释放资源，取消或定制切换/压缩 |
| 模型选择 | `model_select`, `thinking_level_select` | **通知**，没有返回值；可观察后自行 `setModel`/`setThinkingLevel` |
| 其他 | `user_bash`, `cache_warming_decision`, `mcp_servers_change`, `session_info_changed` | 用户 `!` 命令、缓存保温决策、MCP 变更等 |

### 4.3 顺序、并发与错误

- handler 按**扩展加载/注册顺序**执行；`pi.on()` 返回取消订阅函数，取消只影响后续 dispatch。
- 不同事件有不同的组合语义：通知（忽略返回值）、原地修改、链式转换、门禁（阻断后不再走 fallback）、
  “可动作边界”（`turn_end`/`agent_before_settle` 看到目前已提议的条目和续跑决定）、last-override（`cache_warming_decision`）。
- 同一 assistant 消息的并行工具调用会让工具事件交错；handler 不应假设兄弟调用存在。
- `provider_stream_event` 的 handler 是 **await 的、按流顺序执行**，慢 handler 会拖慢流消费；它只读，不能改 provider 响应。
- 大多数 handler 错误被报告后继续；`tool_call` 错误 fail-closed；`user_bash` 的错误也会阻断该命令，而不是回落到本地执行。

### 4.4 能否在“收尾”阻止结束

**结论：部分。能延后/追加一轮，不能硬阻止收尾或进程退出。**

`agent_before_settle` 的事件载荷包含 `entries`（待落盘条目）、`continue`、`context`（预览上下文）和 `outcome`；
handler 可返回：

```ts
pi.on("agent_before_settle", async (event) => {
  if (!shouldKeepGoing(event)) return;
  return {
    entries: [
      ...event.entries,
      { type: "custom_message", customType: "reflex.verdict", content: [{ type: "text", text: "..." }], display: true },
      // 或 { type: "context_edit", targetId, replacement }
      // 或 { type: "compaction", summary, firstKeptEntryId }
    ],
    continue: true, // 请求恰好一次下一次模型请求
  };
});
```

源码语义（`packages/coding-agent/src/core/agent-session.ts` 的 `_runBeforeSettleBoundary`）：

- `continue: true` 只在最终上下文 `canContinue` 为真时生效；否则记录
  `agent_before_settle requested continuation without runnable model context` 并放弃续跑。
- 追加的 `custom_message` / `context_edit` 等条目会先落盘，再重新构建 `canContinue` 预览。
- 每次 settle 都能请求一次；如果扩展无条件 `continue` 就会循环，文档要求扩展自己加保护条件。
- `agent_settled` 是**通知**，此时 Pi 已没有自动续跑；不能再阻止。
- 没有“取消退出/否决收尾”的钩子；`ctx.shutdown()` 只是请求有序退出。

因此对“收尾门禁”类需求，正确做法是：**在 `agent_before_settle` 追加一条纠偏消息（或 context_edit）并继续一轮**，
让模型重做；而不是期待宿主提供一票否决。`turn_end` 也支持同样的 `BoundaryResult`，可在回合级做一次续跑。

**[未验证]** 本次没有用真实模型跑“无条件 continue 会不会形成死循环/宿主是否有额外熔断”；从源码看没有硬性次数上限，
必须由扩展自己限制。

---

## 5. 模型与思考等级

### 5.1 API 面

| 目标 | API | 说明 |
|---|---|---|
| 改当前会话模型 | `pi.setModel(model)` | 返回 `false` 表示该 provider 未配置认证；不改变新会话默认值 |
| 改思考等级 | `pi.setThinkingLevel(level)` | 按模型能力 clamp；不改变新会话默认值 |
| 读/观察 | `pi.getThinkingLevel()`、`model_select`、`thinking_level_select` | 后两者是通知事件，不提供 veto |
| 新增/覆盖 provider | `pi.registerProvider()` | 可给已有 provider 覆盖 `baseUrl`，或注册全新 provider + models + OAuth + `streamSimple` |
| 注入虚拟模型/逐请求路由 | `pi.registerVirtualModel()` | 在 `/model` 中像普通模型一样可选；每次请求决定物理模型与思考等级 |
| 请求级改写 | `before_provider_headers`、`before_provider_request` | 改头/改序列化后的 provider payload |
| 上下文级改写 | `context` / `context_with_system` | 请求前过滤/替换消息 |

思考等级类型（`packages/agent/src/types.ts`）：

```ts
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

### 5.2 虚拟模型：最接近“路由 + effort”的能力

```ts
pi.registerVirtualModel({
  provider: "reflex",
  id: "auto",
  name: "Reflex Auto",
  thinkingLevels: ["low", "high"],
  route(request, ctx) {
    const sticky = request.failed ?? request.previous;
    if (request.reason !== "user" && sticky) {
      return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
    }
    const id = request.thinkingLevel === "high" ? "claude-sonnet-4-5" : "claude-haiku-4-5";
    return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium" };
  },
});
```

语义（virtual-models.md）：

- `route(request, ctx)` 在**每次请求前**运行，返回 `{ model, thinkingLevel, state? }`。
- `request.reason` 区分 `user` / `continuation` / `retry` / `direct`；`request.previous` 是最近一次成功响应的物理模型，
  `request.failed` 是失败请求的模型与 assistant 消息。
- 返回 `previous`（continuation）或 `failed`（retry）能保住 prompt cache 与 thinking signature；切换模型会丢 prompt cache。
- 虚拟模型只能路由到**物理模型**，不能路由到另一个虚拟模型；路由目标必须已有凭据，否则请求以错误结束。
- provider id 可以用任意未被占用的名字，此时虚拟模型“总是可选”；但真正派发仍需要目标物理模型的认证。
- `thinkingLevels` 只是选择层提供的档位，`route` 返回的等级会被 clamp 到目标模型支持的范围。
- 路由可返回 JSON 可序列化的 `state`，随会话树保存（fork/`/tree` 跟随分支），可用于“先规划后执行”等阶段。

**[推断]** 这正是实现“用 System 1 选模型/选 effort”的接口：在 `route()` 里调用本地毫秒级分类器，返回物理模型和等级即可；
不需要改 Pi 的请求构造代码。代价是 `route()` 同步阻塞在首个 token 之前（文档提示 router 调用其他模型会增加首 token 延迟）。

### 5.3 观察 vs 否决

`model_select` / `thinking_level_select` 只通知，不能否决用户的选择；若要“纠正”，只能在通知里再调一次
`setModel`/`setThinkingLevel`（可能造成一次额外切换），或在虚拟模型的 `route()` 里决定实际派发目标。
后者更干净，也是文档推荐的 router 模式。

---

## 6. MCP 支持

### 6.1 pi 是 MCP 客户端

Pi 连接 MCP server，把其 tools/resources 暴露给模型（mcp.md §1）：

- 传输：**stdio**（`command`/`args`/`env`/`cwd`）与 **streamable HTTP**（`url`/`headers`/`oauth`）。
  **不支持 legacy SSE**；`type` 可省略（有 `command` 即 stdio，有 `url` 即 HTTP）。
- 配置：用户级 `~/.pi/agent/mcp.json`，项目级 `.pi/mcp.json`（需 project trust）；格式就是常见
  `{"mcpServers": {...}}`；`${ENV}` 插值、`!command` 取值、`timeout`、`enabled`。
- 命令：`pi mcp add/list/remove/login/logout`；交互内 `/mcp` 查看/登录/重连/改 exposure；shell 命令**不加载扩展**。
- 工具命名：`mcp__<server>__<tool>`；server 名只允许字母数字 `_`/`-`，冲突加 hash。
- 暴露模式：`codemode`（默认，脚本可调但不直接声明）、`deferred`（`tool_search` 命中后声明）、
  `direct`（直接声明给模型）、`hidden`；`toolExposure` 可按工具名/通配覆盖。
- 资源：连接有 resources 的 server 时会注册 `list_mcp_resources`/`list_mcp_resource_templates`/`read_mcp_resource`。
- OAuth：支持动态客户端注册、CIMD、callbackPort 等；token 存 `~/.pi/agent/mcp-auth.json`。
- 超时/重试：HTTP 408/429/5xx 重试两次；工具调用不重试（避免重复副作用）。

### 6.2 扩展与 MCP 的关系（优先级）

- 扩展可以 `pi.registerMcpServer(name, config)` 为**当前会话**加 server，config 形状与 `mcp.json` 条目一致；
  注册不持久化，每次加载都要重新注册。
- **同名优先级**：`mcp.json` 里的 server 覆盖扩展注册的同名 server，`/mcp` 会显示 override。
- 扩展也可以注册一个名为 `/mcp` 的命令来**整体替换**内置 MCP 支持；一旦存在这样的扩展（例如 `pi-mcp-adapter`），
  Pi 在会话中不再读 `mcp.json`，`/mcp` 归扩展所有。`--no-mcp` 只关内置，不影响替换者。
- MCP 调用与内置工具走同一条 `tool_call`/`tool_result` 管线，所以权限门/剪枝/纠偏对 MCP 工具同样有效。
- 扩展可以 `getMcpServers()` 读取已注册 server，并监听 `mcp_servers_change`。

**[推断]** 对 v0.2.0 而言，不需要自己实现 MCP 客户端；除非要做“替换内置 MCP”的特殊需求，否则直接复用内置实现即可。
扩展只需关心“在工具管线里拦截”。

---

## 7. 与 DSH 插件的能力差集

> DSH 侧钩子名来自本仓库 `CLAUDE.md` 的宿主说明（`tools/post-execute`、`agent/pre-step`、`agent/turn-stopping`），
> 以及 `packages/dsh-reflex` 的现行实现（`agent/request`、`agent/pre-step`、`ctx.tools.register`）。
> 这些是 DSH 宿主契约，不是 pi 的 API。

### 7.1 四能力逐条对照

| 能力 | DSH 宿主钩子 | pi 等价接口 | 可实现程度 | 依据 |
|---|---|---|---|---|
| **剪枝**（超长工具输出裁剪） | `tools/post-execute` 改写结果 | `tool_result` 返回替换 `content`/`details`/`structuredContent` | **可做到** | extensions.md §Tools；`ToolResultEventResult` |
| **停滞**（重复/振荡/连续失败拦截） | `agent/pre-step` 读历史并拒绝调用 | `tool_call` 读调用历史，`{ block: true, reason }`；需扩展自己维护状态 | **可做到（需自实现）** | `ToolCallEventResult`；handler 按注册顺序执行 |
| **收尾**（回合结束前自检/拦截） | `agent/turn-stopping` | `turn_end` / `agent_before_settle`：追加条目 + `continue: true` | **部分** | 只能请求一次续跑，无硬 veto；`agent_settled` 只通知 |
| **纠偏**（改写错误结果/注入纠正） | `tools/post-execute` 改写；`agent/pre-step` 注入 | `tool_result`（含 `isError`）、`message_end` 替换最终消息、`sendMessage`/`context_edit` + 续跑 | **可做到** | 同上；注意 `tool_result` 改 content 会丢 structuredContent，需一并返回 |

### 7.2 工具面与模型面

| 维度 | pi 扩展 | DSH 插件 | 判断 |
|---|---|---|---|
| 注册模型可调用工具 | `registerTool`（TypeBox schema，`content`+`details`） | `ctx.tools.register(defineTool(...))` | 对等 |
| 工具参数校验 | 宿主校验；`tool_call` 改入参后**不重校验** | 宿主 `defineTool` 校验 + 顶层未声明参数拦截 | pi 更宽松，扩展需自律 |
| 工具输出改写 | `tool_result` 链式组合 | `tools/post-execute` | 对等 |
| 工具调用拒绝 | `tool_call` `{block, reason}`，fail-closed | `agent/pre-step` / 工具层拒绝 | 对等 |
| 模型路由 | `registerVirtualModel` + `route()` | `agent/request` 改写 `provider/model` | 对等；pi 的虚拟模型层更“原生” |
| reasoning effort | `setThinkingLevel`（clamp）+ `route()` 返回等级 | `agent/request` 改写 `reasoningEffort` + 投影 | 对等；pi 无“把任意字符串 effort 投影到模型词表”的显式 API，需自己按模型能力约束 |
| 请求头/请求体改写 | `before_provider_headers` / `before_provider_request` | `agent/request` | 对等 |
| MCP | 内置 MCP 客户端 + 扩展 `registerMcpServer` | DSH 侧由宿主提供，插件不重复实现 | pi 原生支持更完整 |
| UI | 终端 UI（`ctx.ui`）、RPC UI 协议 | DSH Web GUI 设置面板/槽位 | 形态不同，不可直接移植 |
| 多 agent / subagent | **无原生 subagent**（README 明说跳过 sub-agents/plan mode）；示例里有扩展自建 subagent | DSH 有 agent/subagent/attempt 语义 | DSH 更强；pi 扩展需自建 |
| 分发 | npm/git/本地 Pi package + `pi install` | Cordis 插件包 + `dsh plugin add` / bundle patch | 机制不同 |

### 7.3 关键差异（对 v0.2.0 的影响）

1. **收尾门禁是“续跑”而不是“否决”**：pi 的 `agent_before_settle` 只能追加条目并请求再跑一轮；
   如果需求是“不通过就不允许结束”，要改成“不通过就追加纠偏消息再跑”，并自己限制次数防止死循环。
2. **没有 attempt/subagent 级隔离**：pi 的事件载荷里没有 DSH 那种 `agentId`/`attemptId` 一等字段，
   扩展也不按 agent 分片。要做账本/停滞状态，必须自己用 session id + `toolCallId`/工具调用特征做 key，
   否则会跨会话/跨子代理串味。
3. **扩展与宿主同权限、无沙箱**：DSH 插件的隔离也不强，但 pi 明确提示扩展能读凭据/会话历史；
   如果 v0.2.0 要分发给第三方，需要额外的信任说明与最小权限设计。
4. **性能模型不同**：DSH 的 `tools/post-execute` 在宿主内同步链路；pi 的 `tool_result` 同样是每个工具调用都 await。
   剪枝/停滞这类“每次调用都要跑”的能力必须严格预算延迟（文档建议 < 毫秒级、无网络）。

### 7.4 不要混淆：`dsh-llm-pi-ai` 不是 pi 扩展

| | pi coding agent | `@deepseek-ai/dsh-llm-pi-ai` |
|---|---|---|
| 是什么 | 一个完整的 CLI agent harness + 扩展宿主 | DSH 的 **LLM seam 适配器**（Cordis 插件） |
| 包 | `@earendil-works/pi-coding-agent` | `@deepseek-ai/dsh-llm-pi-ai`（npm 上可见 `0.0.1-rc.1`；本机安装为 `0.2.1-rc.2`） |
| 复用关系 | 自带 agent loop、工具、会话、扩展 | 只依赖 `@earendil-works/pi-ai`（LLM 客户端库） |
| 能力 | extensions / tools / hooks / MCP / virtual models | `providers` 字典：provider 路由、模型目录、凭据/OAuth、请求参数 |
| 能否加载 pi 扩展 | 能（本调研主题） | **不能**；它没有 pi 的 agent loop、工具注册或生命周期事件 |
| 与 DSH 的关系 | 独立项目 | DSH 内部插件，把 LLM 请求接到 pi-ai 的 provider 目录 |

**证据**：本机 `@deepseek-ai/dsh-llm-pi-ai/package.json` 的 `description` 为
“pi-ai-backed DeepSeek adapter for the DeepSeek Harness LLM seam (design-verification twin of dsh-llm-deepseek)”，
`dependencies` 只有 `@earendil-works/pi-ai`（无 `pi-coding-agent`）；其 README 的配置面是 `providers`，
不是 extensions。`pi-ai` 只是 `pi-mono` 仓库里的 LLM 客户端包（`packages/ai`），与 `pi-coding-agent`（`packages/coding-agent`）是两个包。

**因此**：如果 v0.2.0 的目标是“给 pi coding agent 写插件”，实现面是 `ExtensionAPI`；
如果目标是“在 DSH 里换一个模型供应商”，那已经由 `dsh-llm-pi-ai` 覆盖，不应该按 pi 扩展做。

---

## 8. 风险

| 风险 | 事实/依据 | 影响 | 缓解 |
|---|---|---|---|
| **扩展 API 仍在 breaking change** | 1.4.0 于 2026-10-21 发布；0.87.0 引入 `agent_before_settle`，并明确 `TurnEndEvent` 新增必填字段、`ExtensionRunner.emit()` 不再接受 `turn_end`；1.2.0 把 `before_agent_start` 改成按 `messageType` 的联合类型；0.86.0 改 `user_bash` 为 fail-closed | 依赖事件载荷/类型的扩展会在小版本升级时编译失败或行为变化 | 固定 `pi-coding-agent` 版本；把事件适配层集中在一个文件；升级时读 CHANGELOG 的 Breaking Changes |
| **文档漂移** | 第三方 mintlify 镜像（`mintlify.wiki/pt-act/pi-mono`）生成于 2026-03-03，仍用 `@mariozechner/pi-coding-agent`，事件表里没有 `agent_before_settle` | 按旧文档写会用到已改名的包和缺失的事件 | 只以仓库内 `packages/coding-agent/docs/*` + `src/core/extensions/types.ts`（对应 1.4.0）为准 |
| **包名/作用域迁移** | 旧文档与旧示例用 `@mariozechner/*`，当前 npm 包为 `@earendil-works/*`；仓库链接已改为 `earendil-works/pi`，旧 `badlogic/pi-mono` 仍可 clone（GitHub 重定向） | 复制旧示例 import 会解析失败 | 统一用 `@earendil-works/*`；宿主包声明在 `peerDependencies` 且 `"*"` |
| **无沙箱、同权限** | 扩展与 Pi 同 OS 权限，可读 prompt、工具调用、文件、凭据、会话历史 | 第三方扩展 = 供应链风险 | 只装可信包；项目级资源等 project trust；发布时明示权限 |
| **性能开销** | 每个工具调用都走 `tool_call`/`tool_result`；`provider_stream_event` 的 handler 按流顺序 await，慢 handler 拖慢流；`route()` 在首 token 前同步执行 | 每 call 加延迟，长流式响应可能被拖慢 | 剪枝/停滞用纯内存、毫秒级；避免在流事件里做网络 IO；不要在 `route()` 里同步调远程模型（除非可接受首 token 延迟） |
| **并行工具调用的事件交错** | 同一 assistant 消息的多个工具可并行；tool 事件可能交错 | 基于“上一个调用”的简单状态机会误判 | 以 `toolCallId` 为 key；不要假设兄弟调用顺序 |
| **不能反注册工具** | `exposure: "hidden"` 是撤下工具的方式；没有 unregister | 动态工具集的清理要靠重新注册/隐藏 | 设计成幂等注册 + hidden |
| **跨平台差异** | 原生 Windows 默认 Git Bash，另有可选 `powershell` 工具；WSL 使用 Linux Bash；JSON/print 模式无 UI；独立二进制（Bun）与 npm 安装的模块解析不同 | 扩展里写 shell/路径/UI 逻辑时行为不一致 | 用 `ctx.cwd` 和宿主 API；UI 用 `ctx.mode`/`ctx.hasUI` 降级；跨平台 CI |
| **Node/版本兼容** | 要求 Node >= 22.19；npm 还有 `legacy-node20` 指向 0.74.2 | Node 20 环境装不了新版 | 固定 Node 版本；必要时用 0.74.2 但 API 更旧 |
| **未验证面** | 真实模型下的 block/continue 行为、MCP 握手、Windows/WSL 实机、虚拟模型派发都要凭据/环境 | 文档中的行为结论主要来自源码/类型，不是端到端 | 见 §11 的验证清单；实现前先在目标环境跑冒烟 |

---

## 9. 三条最有价值的实现抓手

### 抓手 1：用 `tool_result` + `tool_call` 一次覆盖“剪枝 / 停滞 / 纠偏”

- **剪枝**：`tool_result` 里按需截断 `content`，把完整输出落盘并告知模型路径；保留 `details` 供 UI 重建。
- **停滞**：在 `tool_call` 里以 `(toolName, 参数摘要)` 为 key 维护每会话计数/窗口；命中阈值直接
  `{ block: true, reason: "..." }`，让模型看到原因并改道。
- **纠偏**：同一 `tool_result` 可把错误输出替换成“可执行的纠正提示 + `isError: true`”，或对成功结果追加约束说明。
- **为什么值得**：这三个能力都落在同一条工具管线上，不需要改 Pi 核心；MCP 工具也自动覆盖。
- **注意**：参数修改不会被重新校验；`tool_result` 改 `content` 时同时处理 `structuredContent`；并行调用要用
  `toolCallId` 隔离状态。

### 抓手 2：用 `agent_before_settle` / `turn_end` 做“收尾自检 + 补一轮”

- 在 `agent_before_settle` 检查最终回复/工具结果，若不满足验收，追加一条 `custom_message` 或 `context_edit`，
  返回 `continue: true` 让模型再修一轮；在扩展里维护“已续跑次数”，到上限后放行。
- 对“最终消息措辞/结论”本身的纠正，用 `message_end` 替换 finalized message（保持 role），比在收尾追加更直接。
- **为什么值得**：这是 pi 唯一能影响“回合是否真的结束”的原生边界，等价于 DSH 的 `agent/turn-stopping`，
  但语义是“再给一轮机会”而不是“否决”。
- **注意**：`continue` 需要可运行的模型上下文（通常要追加非 assistant 的消息/条目）；无条件 continue 会循环。

### 抓手 3：用 `registerVirtualModel` + `setThinkingLevel` 做模型/effort 自适应

- `registerVirtualModel({ provider, id, thinkingLevels, route })` 注册一个 `reflex/auto` 之类的虚拟模型；
  `route()` 里调用 System 1 分类器，返回物理 `{ model, thinkingLevel }`，并按 `request.reason`
  对 `continuation`/`retry` 保持粘性（`request.previous`/`request.failed`）以保住 prompt cache。
- 对非虚拟路由的会话，可在 `model_select`/`thinking_level_select` 后调 `setThinkingLevel()` 做兜底纠偏；
  请求级 payload 微调用 `before_provider_request`。
- **为什么值得**：pi 把“选择层”和“派发层”分开记录，虚拟模型的 `route()` 是官方支持的逐请求路由点，
  比在每个事件里改全局状态更稳，也最接近 `dsh-reflex` 的模型路由/effort 两层设计。
- **注意**：路由目标必须有凭据；切换物理模型会丢 prompt cache；`route()` 的耗时落在首 token 之前。

---

## 10. 三条做不到的事

1. **硬阻止收尾/进程退出**。没有 `agent_before_settle` 的 veto 返回值，也没有“取消 shutdown”的钩子；
   `continue: true` 只是请求一次续跑，且必须能构造出可运行的模型上下文。能做到的最强语义是“追加纠偏 + 再跑一轮”。
2. **改写已经流式产出的模型 token**。`provider_stream_event` 是 notification-only 且只读；`message_update` 只能观察。
   想影响模型看到/说出什么，只能改请求前的 `context`/`context_with_system`/`before_provider_request`，
   或在 `message_end` 之后替换最终消息（此时 token 已经产生）。
3. **获得 DSH 那种按 agent/attempt 隔离的宿主级执行域与账本**。pi 没有原生 subagent/attempt 概念
   （README 明确把 sub-agents/plan mode 留给扩展），事件里也没有 agentId/attemptId；要做 per-agent 状态/账本，
   必须自己以 session/toolCallId 为 key 维护，无法从宿主拿到现成的隔离域。

> 补充（安全边界，不计入三条）：扩展**不能**被沙箱隔离，也无法限制自己读凭据/文件；这是“同权限”而不是“做不到的能力”，
> 但分发第三方扩展时必须按此风险设计。

---

## 11. 可复制的验证命令

以下命令在任意临时目录执行，不需要登录模型即可验证“安装 + 扩展加载 + 无构建”：

```bash
set -e
mkdir -p /tmp/pi-probe && cd /tmp/pi-probe
npm init -y >/dev/null
npm install --ignore-scripts @earendil-works/pi-coding-agent@1.4.0

./node_modules/.bin/pi --version
# 预期：1.4.0

cat > hello.ts <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("hello-flag", { description: "probe flag", type: "boolean" });
  pi.registerTool({
    name: "hello_probe",
    label: "Hello Probe",
    description: "probe tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });
}
EOF

PI_CODING_AGENT_DIR=/tmp/pi-probe/agent \
  ./node_modules/.bin/pi --extension ./hello.ts --help | grep -- "--hello-flag"
# 预期：--hello-flag  probe flag
```

包分发验证：

```bash
pi install npm:@scope/package@1.0.0   # 写入 ~/.pi/agent/settings.json
pi list                               # 查看已配置包
pi -e npm:@scope/package              # 只本次加载，不写入 settings
```

MCP 验证（需要真实 server）：

```bash
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
pi mcp list
pi mcp list --json
```

接口/类型核对（不需要运行）：

```bash
# 以上游仓库为准；本文基线 commit 为 58c0b02
git clone --depth 1 https://github.com/badlogic/pi-mono.git
grep -n "agent_before_settle\|tool_result\|registerVirtualModel" \
  pi-mono/packages/coding-agent/src/core/extensions/types.ts
```

**[未验证]** 真实模型会话下的 `block`、`continue`、MCP 工具调用、虚拟模型派发；这些需要模型凭据与具体 provider。
本次只验证了“安装、TS 无构建加载、flag 注册、help 反射”。

---

## 12. 来源

| 来源 | URL | 用途 |
|---|---|---|
| pi 官方仓库 | https://github.com/earendil-works/pi | 源码、docs、CHANGELOG 的权威位置 |
| 旧仓库地址（仍可 clone） | https://github.com/badlogic/pi-mono | 本次 clone 使用；GitHub 重定向到新仓库 |
| 扩展系统 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md | 扩展形态、事件顺序、工具、MCP、UI |
| 扩展类型定义 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts | 事件/结果/API 的精确形状 |
| MCP | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md | 客户端、配置、exposure、优先级 |
| Pi packages | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md | 分发、安装、manifest、peerDependencies |
| 虚拟模型 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md | `route()`、thinkingLevels、state、cache |
| Settings | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md | `extensions` 字段、`defaultTools`、thinking 默认值 |
| Configuration | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md | `~/.pi/agent` 与 `.pi` 目录布局 |
| CLI | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md | `-e/--extension`、`pi install`、`pi mcp` |
| Windows | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md | 原生 Windows / WSL / Git Bash / PowerShell |
| CHANGELOG | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md | 版本、breaking changes、兼容性 |
| npm 包 | https://www.npmjs.com/package/@earendil-works/pi-coding-agent | `latest`/`legacy-node20` dist-tag |
| 安装脚本 | https://pi.dev/install.sh（Windows: https://pi.dev/install.ps1） | 官方安装入口 |
| MCP 规范 | https://modelcontextprotocol.io | MCP 传输/工具语义 |
| 过时镜像（反例） | https://mintlify.wiki/pt-act/pi-mono/api/coding-agent/extensions | 2026-03-03 生成，包名/事件已过时，勿作依据 |
| DSH LLM 适配器 | https://www.npmjs.com/package/@deepseek-ai/dsh-llm-pi-ai | 与 pi coding agent 的辨异；其仓库 `packages/llm/llm-pi-ai` |
| DSH 宿主说明（本仓库） | `CLAUDE.md` | DSH 四能力的宿主钩子名（`tools/post-execute`、`agent/pre-step`、`agent/turn-stopping`） |

**本地核对记录**：
- clone commit `58c0b02ce552adab76014e7ed712ab7981359aa8`，`packages/coding-agent/package.json` version `1.4.0`。
- `npm view @earendil-works/pi-coding-agent version dist-tags` → `latest: 1.4.0`、`legacy-node20: 0.74.2`。
- 本地安装后 `pi --version` → `1.4.0`；`pi --extension ./smoke-ext.ts --help` 输出含 `--reflex-smoke`。
- `@deepseek-ai/dsh-llm-pi-ai/package.json`：`dependencies.@earendil-works/pi-ai: ^1.1.0`，无 `pi-coding-agent`。

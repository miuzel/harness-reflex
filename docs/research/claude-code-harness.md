# Claude Code 插件形态与 hooks 契约调研

> 面向 v0.2.0「Claude Code 插件」的前置调研。目标：判断 Claude Code 能否承载 `packages/dsh-harness-reflex`
> 式的自动干预（剪枝、停滞、收尾核验、失效纠偏），以及应当以什么形态交付。
>
> - 文档快照：2026-10-22，抓取自官方文档站 `code.claude.com/docs`（`docs.claude.com` 会 301 到该站）。
> - 对照口径：`packages/dsh-harness-reflex` 以 v0.2.0 集成分支 `0.2.0-test`（含 `src/interventions.ts`，提交 `ece3846`）为准；
>   四项能力的内部分名为 `stagnation` / `prune` / `gate` / `closing`（见该分支 `src/config.ts` 的
>   `INTERVENTION_CAPABILITIES`）。当前发布基线 `96ee842` 尚未包含该文件，其工具面为 8 个 `reflex_*`
>   （见 `packages/dsh-harness-reflex/src/tools.ts`）；本报告第 5 节的差异判断以集成分支为准，并在需要处注明基线形状。
> - 标注约定：**【事实】** 有官方文档原文或本地源码支持；**【推断】** 由事实推导、官方未直接承诺；
>   **【未验证】** 本次未找到官方依据或未在本机实测。
> - 边界：只调研与写文档，不改代码、不改版本号、不提交 PR。

## 摘要（先给结论）

> 摘要中的判断均为**【推断】**（由第 1–6 节的事实与官方来源推导）；事实本身在正文中逐条标注。

1. **Claude Code 有三种可编程扩展面**：settings hooks（外部命令/HTTP/MCP 工具/prompt/agent）、
   **mods**（插件内进程内 JS 事件中间件，终端 v2.1.287+、Desktop 2.1.286+）、以及**MCP server**（工具面）。三者可同装在一个 plugin 里。
2. **能拒绝工具调用**：`PreToolUse` 的 `permissionDecision: "deny"`，或 mod 的 `tool.call` 返回 `{deny}`；
   且 deny 在 `bypassPermissions` / `--dangerously-skip-permissions` 下仍然生效。
3. **能改写工具输出**：`PostToolUse` 的 `updatedToolOutput`（工具已执行，只改模型看到的内容）；
   mod 的 `session.append` 可在 tool_result 落盘前改写。**不能撤销已发生的副作用。**
4. **能阻止收尾**：`Stop` 的 `decision: "block"`（或 exit 2）；有 8 次连续续跑上限，必须处理 `stop_hook_active`。
5. **模型 / 思考等级**：MCP **不能**；settings hook 只能**阻断/询问**切换；只有 mod 的
   `turn.step` 能 `next({...e, model})` / `next({...e, effort})`。结论：**只有插件内 mod 能设，MCP 只能提示用户。**
6. **与 DSH 的差集**：Claude Code 提供的是“生命周期缝隙 + 中间件”，不提供判定运行时、预算、原文保留、
   三态 observe。四项干预都能落，但**判定、状态、审计、成本控制要自带**；纯 MCP 形态一项都做不到。

---

## 1. 插件 / 扩展形态

### 1.1 可用的分发形态

**【事实】** Claude Code 的扩展面分为“独立配置”和“打包插件”两类：

| 形态 | 存放 / 加载方式 | 安装方式 | 官方来源 |
| --- | --- | --- | --- |
| `settings.json`（含 hooks、permissions、env 等） | `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、managed settings | 手写配置 | [Settings](https://code.claude.com/docs/en/settings) |
| settings hooks | `settings.json` 的 `hooks` 键，或 plugin 的 `hooks/hooks.json` | 随配置 / 随插件 | [Hooks reference](https://code.claude.com/docs/en/hooks) |
| Skills | `~/.claude/skills/`、`.claude/skills/`、plugin `skills/` | 随项目 / 随插件 | [Skills](https://code.claude.com/docs/en/skills) |
| Subagents | `.claude/agents/*.md`、plugin `agents/` | 随项目 / 随插件 | [Sub-agents](https://code.claude.com/docs/en/sub-agents) |
| MCP server | `.mcp.json`、`~/.claude.json`、`--mcp-config`、plugin `.mcp.json` | `claude mcp add ...` | [MCP](https://code.claude.com/docs/en/mcp) |
| Plugin（含 marketplace） | 目录 + `.claude-plugin/plugin.json`，从 marketplace 安装 | `/plugin install`、`claude plugin install`、`--plugin-dir` | [Plugins overview](https://code.claude.com/docs/en/plugins/overview)、[Install](https://code.claude.com/docs/en/plugins/install) |
| **Mods**（插件内 JS hooks） | plugin `hooks/hooks.json` 的 `modules: ["./register.js"]` | 同 plugin | [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) |

**【事实】** 一个 plugin 是一个“按单元安装/加载的目录”，可同时携带 skills、agents、settings hooks、mods、MCP server、
commands、LSP servers、themes、output styles、settings 默认值等组件；manifest 在 `.claude-plugin/plugin.json`
（manifest 本身可选，缺省时按标准目录发现）。来源：[Plugins overview](https://code.claude.com/docs/en/plugins/overview)、
[Plugin components](https://code.claude.com/docs/en/plugins/components)、
[Manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)。

**【事实】** 最小 mod 结构（`plugin.json` + `hooks/hooks.json` + `hooks/register.js`）：

```json
// hooks/hooks.json
{ "modules": ["./register.js"] }
```

register.js 导出 `register(on)`，用 `on('tool.call', ...)` 等注册事件处理器。来源：
[Mods overview](https://code.claude.com/docs/en/plugins/mods/overview#how-a-mod-works)、
[Mods reference](https://code.claude.com/docs/en/plugins/mods/reference#files)。

### 1.2 安装 / 分发命令

**【事实】** Marketplace 是可被 `claude plugin marketplace add` 的目录/仓库（含 `.claude-plugin/marketplace.json`）：

```bash
# 会话内
/plugin marketplace add owner/repo
/plugin install <plugin>@<marketplace>
# shell
claude plugin marketplace add owner/repo
claude plugin install <plugin>@<marketplace> --scope user|project|local
# 本地开发，不建 marketplace
claude --plugin-dir ./my-plugin
```

来源：[Install and manage plugins](https://code.claude.com/docs/en/plugins/install)、
[Plugin commands reference](https://code.claude.com/docs/en/plugins/cli-reference)。

**【事实】** MCP server 的四种传输：`stdio`、`http`（`streamable-http` 为别名）、`sse`（已废弃，HTTP 优先自动降级）、
`ws`。plugin 内的 `.mcp.json` 走同一 shape，工具名带 plugin 作用域：
`mcp__plugin_<plugin-name>_<server-name>__<tool>`。来源：[MCP](https://code.claude.com/docs/en/mcp#installing-mcp-servers)、
[MCP plugin-provided servers](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers)。

### 1.3 加载面矩阵（决定自动干预能否“到处生效”）

**【事实】**

| 运行面 | settings hooks | mods | plugin 自带 MCP |
| --- | --- | --- | --- |
| 终端 `claude` / IDE 终端 | 是 | 是 | 是 |
| VS Code 扩展 chat | 是 | 是（扩展 ≥2.1.299，部分特性需 2.1.304） | 是 |
| Desktop Code tab | 是 | 是（WSL 会话除外） | 是 |
| Desktop 的 WSL 会话 | 是 | **否**（该面不加载 plugin） | 否 |
| `claude -p` / Agent SDK | 是 | 是 | 是 |
| Cloud session | 部分（不读本地 `~/.claude/settings.json`） | 是（插件需能到达云会话） | 视插件是否到达 |
| Remote Control | 是 | 是 | 是 |

来源：[Where mods run](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run)、
[Hooks locations](https://code.claude.com/docs/en/hooks#hook-locations)。

**【推断】** 想“一次交付、所有面生效”只能靠 plugin 同时带 hooks + mod + MCP；但 WSL 桌面会话与企业策略
（`allowManagedHooksOnly`、`disableAllHooks`、`--safe-mode`）仍是作者不可控的断点。

---

## 2. hooks 契约（核心）

官方总参考：[Hooks reference](https://code.claude.com/docs/en/hooks)。所有 event 的公共输入字段、退出码语义、
JSON 输出、超时与并发都在该页。

### 2.1 调用模型

**【事实】** settings hook 的 handler 类型有五种：`command`（shell/exec 进程，stdin 收 JSON）、`http`（POST，body 为 JSON）、
`mcp_tool`（调用已配置 MCP server 的工具，其文本输出按 command stdout 处理）、`prompt`（单轮 LLM 判定）、
`agent`（子代理判定，experimental）。事件触发时**所有匹配 handler 并行执行**；prompt/agent 超过 12 个时并发上限 12。
来源：[Hook handler fields](https://code.claude.com/docs/en/hooks#hook-handler-fields)。

**【事实】** settings 文件、managed policy、plugin 的 hooks 也会在子代理内运行：子代理调用工具时同样触发
`PreToolUse`/`PostToolUse`，输入带 `agent_id`/`agent_type` 以区分是哪个子代理。来源：
[Hook locations](https://code.claude.com/docs/en/hooks#hook-locations)。

**【事实】** 默认**同步阻塞**主流程：文档原话 “By default, hooks block Claude's execution until they complete.”
`async: true` 只能后台跑且**不能做决策**（`decision`/`permissionDecision`/`continue` 无效）。
来源：[Run hooks in the background](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)。

### 2.2 PreToolUse —— 能否拒绝？**能**

**【事实】** 触发时机：Claude 生成工具参数之后、真正处理工具调用之前；对所有工具（除 `EndConversation`）生效，
包括 MCP 工具（`mcp__server__tool`）。`@` 引用的文件在构造 prompt 时直接插入，**不触发** PreToolUse（除非设
`CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` 让 Claude 走文件工具）。来源：
[PreToolUse](https://code.claude.com/docs/en/hooks#pretooluse)。

**stdin JSON（公共字段 + 事件字段）**

| 字段 | 含义 |
| --- | --- |
| `session_id` / `prompt_id` / `transcript_path` / `cwd` / `permission_mode` | 公共字段；`permission_mode` 为 `default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions` |
| `hook_event_name` | `"PreToolUse"` |
| `tool_name` | 工具名（如 `Bash`、`Edit`、`mcp__…`） |
| `tool_input` | 工具参数对象（如 Bash 的 `command`/`description`/`timeout`/`run_in_background`） |
| `tool_use_id` | 本次调用 id |
| `mcp_server` | 仅 MCP 工具；`{name, source}`，`source` ∈ `plugin`/`sdk`/配置 scope（v2.1.274+） |

来源：[PreToolUse input](https://code.claude.com/docs/en/hooks#pretooluse-input)、[Common input fields](https://code.claude.com/docs/en/hooks#common-input-fields)。

**stdout JSON（`hookSpecificOutput`）**

| 字段 | 作用 |
| --- | --- |
| `permissionDecision` | `allow` 跳过权限提示（个别动作除外）；`deny` 阻止调用；`ask` 弹确认；`defer` 结束回合待恢复（仅 `-p`） |
| `permissionDecisionReason` | `deny` 时给 Claude 看；`ask` 时给用户看；`allow`/`defer` 只进 debug log |
| `updatedInput` | 替换**整个** tool_input 后再执行；权限规则按替换后的输入评估 |
| `additionalContext` | 随工具结果注入 Claude 上下文 |

多个 PreToolUse 决策的优先级：`deny` > `defer` > `ask` > `allow`。来源：
[PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)。

**退出码**：`0` 成功（读 JSON）；`2` 阻止调用，stderr 作为 denial reason；其他退出码 = non-blocking error，
调用照常走权限流程。来源：[Exit code output](https://code.claude.com/docs/en/hooks#exit-code-output)、
[Exit code 2 behavior](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event)。

**【事实】** deny 在 `bypassPermissions` 和 `--dangerously-skip-permissions` 下**仍然生效**，PreToolUse 在权限模式检查之前触发。
来源：[Hooks guide 的 deny 说明](https://code.claude.com/docs/en/hooks-guide#hooks-and-permission-modes)（原文：
“a hook that returns `permissionDecision: "deny"` blocks the tool even in `bypassPermissions` mode or with
`--dangerously-skip-permissions`”）。

### 2.3 PostToolUse —— 能否改写输出？**能，但只改“模型看到的”**

**【事实】** 触发时机：工具**成功执行完之后**。stdin 为公共字段 + `tool_name`、`tool_input`、`tool_response`
（工具返回值）、`tool_use_id`、`duration_ms`（不含权限提示与 PreToolUse 用时）。来源：
[PostToolUse input](https://code.claude.com/docs/en/hooks#posttooluse-input)。

**stdout JSON（事件专属字段）**

| 字段（层级） | 作用 |
| --- | --- |
| 顶层 `decision: "block"` + `reason` | 把 reason 附在工具结果旁；**Claude 仍看到原始输出**。PostToolUse 不能阻止已发生的工具 |
| `hookSpecificOutput.updatedToolOutput` | 用给定值**替换工具输出**后再给 Claude；值必须匹配该工具的输出 shape |
| `hookSpecificOutput.updatedMCPToolOutput` | 仅 MCP 工具；官方建议优先用 `updatedToolOutput` |
| `hookSpecificOutput.additionalContext` | 在工具结果旁注入系统提醒 |
| `hookSpecificOutput.classifierContext` | 给 auto 模式分类器的短注记（不是给 Claude） |

来源：[PostToolUse decision control](https://code.claude.com/docs/en/hooks#posttooluse-decision-control)。

**【事实】** 关键边界：`updatedToolOutput` **只改 Claude 看到的内容**；文件写入、命令执行、网络请求已经发生，
遥测也已在 hook 之前记录。内置工具若替换值不匹配输出 schema 会被**静默忽略**（保留原输出）；MCP 工具输出不做 schema 校验。
来源：同上（Warning 段落）。

**【事实】** 工具**失败**走另一个事件 `PostToolUseFailure`，它只支持 `additionalContext`，**不能替换错误文本**；
来源：[PostToolUseFailure decision control](https://code.claude.com/docs/en/hooks#posttoolusefailure-decision-control)。

**退出码**：PostToolUse 的 exit 2 **不能**阻止（工具已跑），只把 stderr 给 Claude 看。来源：
[Exit code 2 behavior per event](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event)。

### 2.4 Stop —— 能否阻止收尾？**能（有上限）**

**【事实】** 触发时机：主 agent 完成回答时；用户中断不触发（改走别的路径），API 错误走 `StopFailure`。stdin 额外带：

| 字段 | 含义 |
| --- | --- |
| `stop_hook_active` | 已经因 stop hook 续跑过时为 `true`，用来防止死循环 |
| `last_assistant_message` | 本轮最后一条回答的文本，无需解析 transcript |
| `background_tasks` / `session_crons` | 区分“真的结束”与“在等后台任务/定时唤醒” |

来源：[Stop input](https://code.claude.com/docs/en/hooks#stop-input)。

**stdout JSON**

| 字段 | 作用 |
| --- | --- |
| `decision: "block"` + `reason`（必填） | 阻止 Claude 停止，`reason` 告诉它为什么继续 |
| `hookSpecificOutput.additionalContext` | 非错误反馈，继续对话；transcript 标为 `Stop hook feedback`（不显示 hook error） |

退出码 `2` 等价于 `reason`：stderr 作为继续理由。来源：
[Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control)。

**【事实】** 有 **8 次连续续跑上限**：stop hook 连续 8 次阻止后，Claude Code 强制结束本轮；计数在每次 Claude 调用工具时重置。
可用 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 调整。来源：[Stop input](https://code.claude.com/docs/en/hooks#stop-input)。

### 2.5 其余关键事件

**【事实】**

| 事件 | 时机 | 能否否决 / 能返回什么 |
| --- | --- | --- |
| `UserPromptSubmit` | prompt 提交后、Claude 处理前 | `decision: "block"` + `reason` 拦下 prompt；`additionalContext` 注入；**不能替换 prompt 文本**；默认超时 30s，且会阻塞模型处理 |
| `SessionStart` | 会话开始/恢复 | 无否决；可给 `additionalContext`、`initialUserMessage`、`sessionTitle`、`watchPaths`、`reloadSkills` |
| `SessionEnd` | 会话结束 | 无决策控制；默认预算 1.5s（可调） |
| `SubagentStop` | 子代理结束 | 同 Stop，可阻止子代理停止 |
| `PostToolBatch` | 一批并行工具全部完成、下一次模型请求前 | 可停止 agentic loop |
| `PreModelSwitch` | 应用模型切换前 | `permissionDecision` allow/deny/ask；`decision: "block"` 取消切换（v2.1.251+） |
| `Elicitation` / `ElicitationResult` | MCP server 请求用户输入时/返回前 | `action` accept/decline/cancel + `content` |

来源：[Hook events](https://code.claude.com/docs/en/hooks#hook-events) 各节。

### 2.6 权限模型：hook 与 `permissions.allow/deny`、bypass 的关系

**【事实】**

- **hook 的 deny 不被权限模式绕过**：PreToolUse 在权限模式检查之前触发；`deny` 在 `bypassPermissions` /
  `--dangerously-skip-permissions` 下仍阻止。来源：
  [Hooks guide](https://code.claude.com/docs/en/hooks-guide#hooks-and-permission-modes)。
- **权限规则优先于 hook 的 allow/ask**：PreToolUse 的决策**不会绕过** deny/ask 规则；匹配的 deny 规则仍然阻止，
  匹配的 ask 规则仍然提示。hook 的 `"allow"` 只是跳过提示，不改变规则。来源：
  [Precedence among rules, hooks, and mods](https://code.claude.com/docs/en/permissions#precedence-among-rules-hooks-and-mods)。
- **exit 2 的阻塞发生在权限规则评估之前**：即使有 allow 规则，hook exit 2 也先拦下。来源：同上。
- hook 进程本身不是工具调用，`permissions.allow/deny` 不 gate hook 是否运行；控制 hook 是否运行的是
  `disableAllHooks`、`allowManagedHooksOnly`、`--safe-mode`、项目信任等。来源：
  [Disable or remove hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks)、
  [Settings](https://code.claude.com/docs/en/settings)。
- mod 的 `tool.check` 在 PreToolUse 之后：默认情况下 mod 的 approve 不能翻掉 deny/ask 规则或 PreToolUse 的阻断；
  但在既无 managed settings 也无 Team/Enterprise 登录的会话里，mod 可以 approve 一个被 ask 规则或 PreToolUse
  阻断的调用。来源：[Extend permissions with hooks](https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks)。

**【推断】** 因此“用 PreToolUse deny 做硬门禁”比“用 mod tool.check 做硬门禁”在权限语义上更稳；mod 适合做会改写内容的
中间件，硬边界应同时用 hooks 兜底。

### 2.7 超时、并发、失败处理、阻塞

**【事实】**

| 项 | 值 |
| --- | --- |
| 默认超时 | `command`/`http`/`mcp_tool` 600s；`prompt` 30s；`agent` 60s |
| 更短默认 | `UserPromptSubmit`、`PreModelSwitch`、`PostModelSwitch` 降为 30s；`MessageDisplay` 10s；`SessionEnd` 共享 1.5s 预算 |
| 超时后果 | 取消 hook、丢弃输出；多数事件“fail-open”（动作照常），除非 handler 设 `onFailure: "block"`（v2.1.295+） |
| `PreModelSwitch` 特例 | 超时反而阻止模型切换 |
| 并发 | 同一事件匹配的 hook 并行；prompt/agent 同时最多 12 个 |
| 阻塞 | 默认同步阻塞 Claude 执行；`async: true` 不阻塞但不能决策 |
| 输出上限 | `additionalContext`/`systemMessage`/`initialUserMessage` 及普通 stdout 各 10,000 字符，超出落文件并给路径+预览 |

来源：[Common fields](https://code.claude.com/docs/en/hooks#common-fields)、[Timeouts](https://code.claude.com/docs/en/hooks#timeouts)、
[Exit code 2 behavior](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event)、
[JSON output 上限](https://code.claude.com/docs/en/hooks#json-output)。

**【事实】** Windows 无 Git Bash 时：shell-form 的 PreToolUse/PermissionRequest hook 失败/超时会**阻止调用**
（错误文本含 “Git Bash wasn't found …”）；exec form 用 `args` 时不会经过 shell，但 `.cmd`/`.bat` shim 不能直接 spawn。
来源：[Failed hooks on Windows without Git Bash](https://code.claude.com/docs/en/hooks#failed-hooks-on-windows-without-git-bash)。

### 2.8 hooks 结论速查

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| PreToolUse 能 deny 吗 | **能**，且 bypass 模式也拦得住 | [hook decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) |
| PostToolUse 能改写输出吗 | **能**，`updatedToolOutput` 替换模型可见结果；不能撤销副作用、不能改错误文本（错误走 `PostToolUseFailure`） | [PostToolUse](https://code.claude.com/docs/en/hooks#posttooluse-decision-control) |
| Stop 能阻止收尾吗 | **能**，`decision: "block"` 或 exit 2；有 8 次连续上限 | [Stop](https://code.claude.com/docs/en/hooks#stop-decision-control) |
| UserPromptSubmit 能改 prompt 吗 | **不能**，只能 block 或加 context | [UserPromptSubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit-decision-control) |
| 失败默认放行吗 | 是（fail-open），除非 `onFailure: "block"` | [Block the action when a hook fails](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) |
| 每次工具调用都要 fork 吗 | command hook 是；`if` 过滤可在不匹配时完全避免 spawn | [How a hook resolves](https://code.claude.com/docs/en/hooks#how-a-hook-resolves) |

---

## 3. MCP 面

官方参考：[Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)。

### 3.1 Claude Code 作为 MCP 客户端支持什么

**【事实】**

| 能力 | 支持情况 | 依据 |
| --- | --- | --- |
| tools | 支持；`tools/list` 发现、`tools/call` 调用 | [MCP](https://code.claude.com/docs/en/mcp#installing-mcp-servers) |
| resources | 支持；`@server:protocol://path` 引用，自动附加；也自动提供 list/read 工具 | [Use MCP resources](https://code.claude.com/docs/en/mcp#use-mcp-resources) |
| prompts | 支持；每个 prompt 变成 `/servername:promptname` 命令，也可 `/mcp__servername__promptname` | [Use MCP prompts as commands](https://code.claude.com/docs/en/mcp#use-mcp-prompts-as-commands) |
| elicitation | 支持；默认弹 form/URL 对话框，也可用 `Elicitation` hook 自动应答 | [Respond to MCP elicitation requests](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests) |
| roots | 支持；回答 `roots/list`，目录变化时发 `notifications/roots/list_changed` | [MCP](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server) |
| sampling | **官方文档未声明支持**；全部抓取页面无 sampling 条目 | **【未验证】**（按“不支持”设计更安全） |
| 动态工具/资源/提示列表 | 支持；server 发 `list_changed` 后交互会话刷新；`-p`/SDK 仅刷新工具列表 | [Dynamic tool updates](https://code.claude.com/docs/en/mcp#dynamic-tool-updates) |
| 工具搜索（延迟加载） | 默认开启；工具定义延迟到 `ToolSearch` 命中才加载；可用 `_meta["anthropic/alwaysLoad"]` 固定前置 | [Scale with MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) |

**【推断】** Claude Code 的“客户端能力”以 tools/resources/prompts/elicitation 为主；sampling 在官方 MCP 文档中没有出现，
按不可依赖处理（实现上不要靠 server→client 采样）。

### 3.2 工具命名与 allowlist

**【事实】**

- 普通 server：`mcp__<server>__<tool>`。
- plugin 内 server：`mcp__plugin_<plugin>_<server>__<tool>`；用裸 server 名写的 matcher/allow 规则**不会命中**。
- 权限规则：`mcp__<server>__*`（整个 server）或 `mcp__<server>__<tool>`（单工具）；server 名里的 `.`/空格会变成 `_`。
- hook matcher：`mcp__memory__.*` 匹配整个 server；裸 `mcp__memory` 是精确名，匹配不到任何工具。

来源：[Match MCP tools](https://code.claude.com/docs/en/hooks#match-mcp-tools)、
[MCP permission rules](https://code.claude.com/docs/en/permissions#mcp)。

### 3.3 输出限制与稳定性

**【事实】** 输出超过 10,000 tokens 提示；默认上限 25,000 tokens（`MAX_MCP_OUTPUT_TOKENS` 可调）；无 `maxResultSizeChars`
注解的文本结果超过 50,000 字符会落盘并在对话里换成文件路径；单工具可用 `_meta["anthropic/maxResultSizeChars"]`
提高到 500,000 字符上限；HTTP/SSE 单响应 16 MiB、WS 单消息 16 MiB 上限。来源：
[MCP output limits](https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings)。

**【事实】** server 断线会自动重连；首次发现请求失败会重试最多 3 次；超时/4xx/鉴权错误不重试。来源：
[Automatic reconnection](https://code.claude.com/docs/en/mcp#automatic-reconnection)、
[Failed discovery requests](https://code.claude.com/docs/en/mcp#failed-discovery-requests)。

---

## 4. 模型与思考等级：MCP / hook / mod 各自能做什么

### 4.1 Claude Code 的模型与 effort 配置面

**【事实】** 模型可由 `--model`、`/model`、settings `model`、`ANTHROPIC_MODEL` 等决定；effort 等级为
`low`/`medium`/`high`/`xhigh`/`max`（部分模型不支持），解析顺序为：显式选择（`CLAUDE_CODE_EFFORT_LEVEL`、
`--effort`、`/effort`）→ settings（按模型的 `modelSettings` 或顶层 `effortLevel`）→ 模型默认。
来源：[Model configuration](https://code.claude.com/docs/en/model-config)、[Adjust effort level](https://code.claude.com/docs/en/model-config#adjust-effort-level)。

**【事实】** hook 的公共输入里有 `effort: { level }`（在工具上下文事件如 PreToolUse/PostToolUse/Stop/SubagentStop 中），
也可从 `$CLAUDE_EFFORT` 环境变量读到；但**没有** `$CLAUDE_MODEL`。来源：
[Common input fields](https://code.claude.com/docs/en/hooks#common-input-fields)。

### 4.2 三条通道的结论

| 通道 | 能否影响模型选择 | 能否影响 effort | 结论 |
| --- | --- | --- | --- |
| **MCP server** | 不能：官方 MCP 文档与 Claude Code 客户端文档都没有“设置模型/effort”的字段（**【事实】**：文档未提供）；工具只能返回文本建议 | 不能 | **不能**（最多在工具结果里提示 Claude/用户） |
| **settings hook** | 只能阻断或要求确认：`PreModelSwitch` 的 `permissionDecision` allow/deny/ask、`decision: "block"`；**不能指定切到哪个模型** | 不能设置，只能读 `effort.level` | **只能阻断/提示** |
| **mod（进程内）** | 能：`turn.step` 里 `next({ ...e, model })` 改变该请求的模型；`agent.spawn` 可给子代理选模型 | 能：`turn.step` 里 `next({ ...e, effort })` | **能**（仅限 mod 加载的会话面） |

来源：[PreModelSwitch](https://code.claude.com/docs/en/hooks#premodelswitch)、
[Follow a turn（turn.step model/effort）](https://code.claude.com/docs/en/plugins/mods/events#follow-a-turn)、
[Mods events 表（turn.step / agent.spawn）](https://code.claude.com/docs/en/plugins/mods/reference#events)。

**【事实】** mod 的 `turn.step` 是 async generator，`yield* next(e)` 转发流式响应，`next({ ...e, model })` 或
`next({ ...e, effort })` 修改本次请求；`agent.spawn` 用 `next({ ...e, model })` 给子代理选模型。来源同上。

**【推断】** 如果 v0.2.0 的目标包含“每轮自适应 effort”，**只有 mod 载体能实现**；MCP 形态只能做“工具集”。
`turn.step` 的 effort 取值应落在 Claude Code 支持的等级上（`low`/`medium`/`high`/`xhigh`/`max`），
越界行为未在 mods 文档中说明 → **【未验证】**。

---

## 5. 与 DSH 插件的能力差集

### 5.1 对照口径：DSH 的四项自动干预

**【事实】** v0.2.0 集成分支的 `packages/dsh-harness-reflex/src/interventions.ts` 模块头给出完整映射：

| DSH hook | 能力 | 允许做什么 |
| --- | --- | --- |
| `tools/pre-execute` | `stagnation` | deny 一次正在重复的调用 |
| `tools/post-execute` | `prune` | 用缩减版替换超大结果 |
| `tools/post-execute` | `gate` | 把重复失败转成纠偏反馈（`kind: "block"` + feedback） |
| `agent/pre-step` | `stagnation` | 把纠偏文本附到下一条消息 |
| `agent/turn-stopping` | `closing` | 对“证据自相矛盾却要收尾”的回合提出异议（steering，不硬阻断） |

补充事实（同文件/同分支）：三态 `off`/`observe`/`active`；`observe` 完整检测+判定但不应用、模型完全不可见；
每次判定受 per-turn / per-session 预算约束；所有 hook 先 `await next()`、异常 fail-open；剪枝仅在原文字节被
session log 保留且替换确实变短后才记 `saved`，替换发布一个由 digest 派生的 locator，reader 可还原原文。
工具面（同分支 `src/tools.ts`）：5 个 `reflex_*`（choice/score/route/screen/gate，route 默认关），
剪枝/停滞/台账不占工具位。

### 5.2 四项能力逐条对照

**【推断】** 下表的“能做到吗”一列是由 §2/§3 的事实推导出的结论，最后一列给出支撑事实的官方文档。

| DSH 能力 | Claude Code 能做到吗 | 落点与做法 | 依据 |
| --- | --- | --- | --- |
| **剪枝（prune）** | **部分可做到** | 用 `PostToolUse` 的 `hookSpecificOutput.updatedToolOutput` 或 mod `session.append` 改写 tool_result；但“原文保留 + locator + 仅验证后记 saved”要自建（`$.store` 4 MiB / `$.fs` / 插件 data 目录）；MCP 形态完全做不到 | [PostToolUse](https://code.claude.com/docs/en/hooks#posttooluse-decision-control)、[session.append](https://code.claude.com/docs/en/plugins/mods/reference#session)、[mods limits](https://code.claude.com/docs/en/plugins/mods/reference#limits) |
| **停滞检测（stagnation）** | **可做到** | `PreToolUse` deny（硬）+ `PostToolUse`/`PostToolBatch` 的 `additionalContext`（软纠偏）；或 mod `tool.call` 返回 `{deny}`/`{result}` + `prompt.submit`/`session.append` 注入纠偏。判定与调用历史要自建（mod 内存/`$.store` 或 hook 侧文件/服务） | [PreToolUse](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)、[tool.call](https://code.claude.com/docs/en/plugins/mods/events#guard-or-change-a-tool-call) |
| **收尾核验（closing）** | **可做到（语义更强）** | `Stop` 的 `decision: "block"` 可硬性阻止收尾并给 reason；`additionalContext` 可做非错误反馈；需处理 `stop_hook_active` 与 8 次上限；证据要 hook 自己跨调用累积（transcript 异步、可能滞后） | [Stop](https://code.claude.com/docs/en/hooks#stop-decision-control) |
| **失效纠偏（gate）** | **部分可做到** | `PostToolUseFailure.additionalContext` 可加纠偏文本，但**不能替换错误**；成功结果的重复失败模式可在 `PostToolUse` 用 `decision: block`+`reason` 或 mod `session.append` 注入。无内置 System One 判定，需自建 | [PostToolUseFailure](https://code.claude.com/docs/en/hooks#posttoolusefailure-decision-control)、[PostToolUse](https://code.claude.com/docs/en/hooks#posttooluse-decision-control) |

**【推断】** 四项中“收尾核验”在 Claude Code 上比 DSH 更硬（Stop 能真阻断），但代价是 8 次上限与必须自己防死循环；
“剪枝”和“失效纠偏”最接近 DSH 的审计要求，因为都要额外做原文保留/纠偏文本落点；“停滞检测”最依赖自建状态。

### 5.3 工具面对照

**【推断】** 下表 Claude Code 侧为能力推导，不是某个官方“对照表”。

| 维度 | DSH `packages/dsh-harness-reflex`（0.2.0 集成线） | Claude Code 插件（可做到） |
| --- | --- | --- |
| 决策工具 | 5 个进程内 `reflex_*`（route 默认关） | MCP stdio server 暴露同等工具；模型通过 `mcp__<server>__<tool>` 调用 |
| 剪枝/停滞/台账 | 不占工具位：自动干预 + `/reflex-ledger` | 没有等价“自动层”；只能 hooks/mods 自建；台账需自建命令或工具 |
| 调用方式 | in-process，零子进程 | MCP 子进程（stdio）或 HTTP；每次调用有协议往返 |
| 上下文成本 | 工具定义在 registry 内 | 默认被 tool search 延迟；名字+server instructions 常驻，命中才加载描述 |
| 可控性 | 可注册/注销、严格参数校验 | 受 allowlist、`disabledMcpServers`、org 策略、tool search 影响 |

来源（Claude Code 侧）：[Tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)、
[MCP permission rules](https://code.claude.com/docs/en/permissions#mcp)。

### 5.4 综合判断

**【推断】** Claude Code 给的是“事件缝隙 + 中间件 + 工具面”，DSH 给的是“事件缝隙 + 判定运行时 + 预算 + 审计 +
三态模式”。把 DSH 的四项能力迁过去，**工程量大头不在 hooks 接线，而在**：

1. 跨调用的会话状态（DSH 有 per-agent `AgentState`，Claude Code 的 command hook 每次是新进程）；
2. 判定成本控制（DSH 有 per-turn/per-session judgment 预算与 verdict 复用，Claude Code 没有内建预算）；
3. 原文保留与可回溯（DSH 有 session log 插件记录通道与 digest locator，Claude Code 要自带存储）；
4. `observe` 的零模型可见性（Claude Code 没有现成的 observe 语义，必须自己保证“只记不应用”）。

---

## 6. 风险与限制

### 6.1 hooks 侧

- **稳定性**：事件表在持续扩张（本次快照已有 30+ 事件），部分事件/字段有明确版本门槛（`onFailure` v2.1.295、
  `mcp_server` v2.1.274、PreModelSwitch v2.1.251、mods v2.1.287）。**【事实】** 来源：
  [Hooks reference](https://code.claude.com/docs/en/hooks)、[Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)。
- **fail-open 风险**：hook 崩溃/超时默认放行；做门禁必须 `onFailure: "block"`，而该字段本身有版本门槛。**【事实】**
- **阻塞成本**：默认同步阻塞；每个匹配的 command hook 都 fork 进程。官方只给出“`if` 不匹配可避免 spawn”
  与 debug log 的耗时行，**没有**公布单次 fork 的固定毫秒数 → **【未验证】**。**【事实/未验证】**
- **Stop 死循环**：必须读 `stop_hook_active`；8 次连续上限是硬保护，但也意味着“无限续跑”不可实现。**【事实】**
- **输出上限**：注入文本 10k 字符上限，超出落文件；长证据要分片或落盘。**【事实】**
- **mod 执行预算**：单个事件的 hook 自身执行上限 10 秒（不含 `next` 与多数 API 调用），`.catch` 处理器 1 秒；
  不适合在 hook 内跑长判定。**【事实】** 来源：[Mods limits](https://code.claude.com/docs/en/plugins/mods/reference#limits)。
- **后台进程**：hook 先打印 allow 再起后台进程且不重定向 stdout/stderr，会被判定 “refusing to honor the suspect capture”
  并阻止调用。**【事实】**
- **`updatedInput` 竞态**：多个 PreToolUse hook 同时改同一工具参数时，最后完成者生效，顺序不确定；官方建议避免多个
  hook 改同一输入。**【事实】** 来源：[Hooks guide limitations](https://code.claude.com/docs/en/hooks-guide#limitations)。
- **SessionStart 的 `mcp_tool` hook 被跳过**：启动时 MCP server 尚未就绪，`SessionStart`/`Setup` 的
  `mcp_tool` 类型 hook 不执行（记 debug log）；启动期需要的能力用 `command` hook。**【事实】** 来源：
  [MCP tool hook fields](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields)。

### 6.2 MCP 侧

- **稳定性**：server 崩溃/重启、发现请求重试 3 次、超时/4xx 不重试；`-p`/SDK 下动态更新只刷新工具列表。**【事实】**
- **工具可见性变化**：tool search 默认开启，工具是延迟加载的；MCP server 必须把可搜索词写进描述/instructions，
  否则模型可能找不到工具。**【事实】**
- **输出限制**：25k tokens 默认、50k 字符落盘、单工具最高 500k 字符；大结果会被替换成文件路径。**【事实】**
- **无采样（sampling）**：官方文档未声明支持 → **【未验证】**，不要设计依赖 server 反向采样。

### 6.3 平台差异

- **Windows**：hooks 默认 shell 是 Git Bash；没有 Git Bash 时 shell-form 的 PreToolUse/PermissionRequest 失败/超时会
  **阻止调用**；文件路径是反斜杠，路径匹配要做分隔符归一化；exec form 不能直接 spawn `.cmd`/`.bat`。**【事实】**
  来源：[Failed hooks on Windows without Git Bash](https://code.claude.com/docs/en/hooks#failed-hooks-on-windows-without-git-bash)、
  [PreToolUse input 的 Windows 路径说明](https://code.claude.com/docs/en/hooks#pretooluse-input)。
- **macOS/Linux**：hook 没有控制终端，`/dev/tty` 不可用；通知要返回 `terminalSequence`。**【事实】** 来源：
  [Emit terminal notifications](https://code.claude.com/docs/en/hooks#emit-terminal-notifications)。
- **WSL**：Desktop 的 WSL 会话不加载 plugin（因此 mods 不运行）；云会话不读本地 `~/.claude/settings.json`。**【事实】**
- **stdio MCP server 的关闭时序也不同**：macOS/Linux 依次 SIGINT → 100ms 后 SIGTERM → 再 400ms 后 SIGKILL；
  Windows 先关 stdin，300ms 后结束进程树（v2.1.296+）。做清理逻辑要按平台处理。**【事实】** 来源：
  [How Claude Code stops a stdio server](https://code.claude.com/docs/en/mcp#how-claude-code-stops-a-stdio-server)。

### 6.4 安全与治理

- plugin/mod 以用户权限运行，mods 不在沙箱内；安装前应 `claude plugin validate` 审查 `hooks:`/`calls:`。**【事实】**
  来源：[Plugin security and trust](https://code.claude.com/docs/en/plugins/security)、
  [Decide whether to trust a mod](https://code.claude.com/docs/en/plugins/mods/overview#decide-whether-to-trust-a-mod)。
- 组织可用 `allowManagedHooksOnly`、`disableAllHooks`、`allowManagedModsOnly`、`--safe-mode` 关闭 hooks/mods；
  作者无法保证“装上就一定跑”。**【事实】** 来源：
  [Disable or remove hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks)、
  [Managed settings](https://code.claude.com/docs/en/permissions#managed-settings)。
- MCP 工具输出可携带 prompt injection；hook 的 `additionalContext` 也会进模型上下文，属于新的注入面。**【推断】**
  来源：[Protect against prompt injection](https://code.claude.com/docs/en/security#protect-against-prompt-injection)。

---

## 7. 三条最有价值的实现抓手

> 以下是**【推断/建议】**：基于前六节事实给出的实现路线，不是官方承诺。

### 抓手 1：一个 plugin，双载体 —— mod 做自动干预，MCP 做工具面

- **做什么**：同一插件目录内放 `hooks/hooks.json`（`modules: ["./register.js"]`，mod）+ `.mcp.json`（stdio server，
  暴露 `reflex_*` 工具）。mod 负责 `tool.call` / `session.append` / `prompt.submit` / `turn.step`；
  MCP 负责模型可主动调用的决策工具。
- **为什么**：mod 是**进程内**、有状态、可 deny/改写/加 context/改 model+effort，且 `claude -p`、Agent SDK 也运行；
  MCP 单独无法做任何自动干预。两者同 plugin 分发，用户一次 `/plugin install` 全拿到。
- **依据**：[Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)、
  [Mods events](https://code.claude.com/docs/en/plugins/mods/events)、
  [Plugin components](https://code.claude.com/docs/en/plugins/components)。
- **风险**：mods 需要 v2.1.287+；WSL 桌面会话不加载；企业可禁。

### 抓手 2：用 `session.append` + 自建 locator 复刻“剪枝/纠偏可回溯”契约

- **做什么**：在 tool_result 落盘前（mod `session.append`）或 `PostToolUse.updatedToolOutput` 替换为缩减文本，
  同时把原文写到 `CLAUDE_PLUGIN_DATA` 或 `$.store`，替换文本末尾附 `reflex locator: <digest>`；
  只有“原文确实落盘 + 替换确实更短”时才记 saved。
- **为什么**：Claude Code 没有 DSH 的 session log 插件记录通道与内建 locator；这是唯一能同时满足
  “省 token”与“可审计/可还原”的路径。`$.store` 有 4 MiB 上限、`$.fs` 单文件 4 MiB，需分片/压缩策略。
- **依据**：[session.append](https://code.claude.com/docs/en/plugins/mods/reference#session)、
  [PostToolUse](https://code.claude.com/docs/en/hooks#posttooluse-decision-control)、
  [Mods limits](https://code.claude.com/docs/en/plugins/mods/reference#limits)。

### 抓手 3：收尾核验用 settings `Stop` hook 做硬闸，mod 只做证据采集

- **做什么**：mod 在 `tool.call`/`session.append`/`turn.complete` 中累积“本轮完成声明 + 工具证据”，
  写入插件 store；`hooks/hooks.json` 的 `Stop` command hook 读取该状态，证据矛盾时返回
  `{"decision":"block","reason":"..."}`（或 `additionalContext`），并检查 `stop_hook_active`。
- **为什么**：Stop 的硬阻断只在 settings hook 上有文档保证；mod 的 `classic.Stop` 只被描述为观察。
  用 hook 做决策、mod 做状态，既避免每次 fork 读 transcript，又拿到硬闸。
- **依据**：[Stop](https://code.claude.com/docs/en/hooks#stop-decision-control)、
  [classic.Stop](https://code.claude.com/docs/en/plugins/mods/events#handle-the-settings-hook-events)、
  [stop_hook_active 与 8 次上限](https://code.claude.com/docs/en/hooks#stop-input)。
- **风险**：8 次连续上限；hook 进程与 mod 的状态共享需落到磁盘/store，不能只放内存。

---

## 8. 三条明确做不到的事

> 以下是**【推断】**（每条都附官方依据；其中第 3 条还受运行面策略影响）。

1. **在 Claude Code 里，纯 MCP server 做不到任何自动干预**：Claude Code 只把 server 当工具/资源/提示来源
   （另有 elicitation/roots），没有“工具调用前/后、回合收尾”的回调；server 看不到别的工具结果，
   也不能 deny 调用、改写输出或阻止收尾。要自动干预就必须装 hooks 或 mod。
   **依据**：[MCP](https://code.claude.com/docs/en/mcp)、[Hooks](https://code.claude.com/docs/en/hooks#hook-lifecycle)。
2. **MCP 与 settings hook 都不能设定模型 / 思考等级**：MCP 文档未提供对应字段；hook 的 `PreModelSwitch` 只能
   allow/deny/ask 或 block，不能指定目标模型，也不能设 effort。唯一通道是 mod 的 `turn.step`
   （`next({...e, model})` / `next({...e, effort})`）；没有 mod 的会话面只能提示用户。
   **依据**：[PreModelSwitch](https://code.claude.com/docs/en/hooks#premodelswitch)、
   [turn.step](https://code.claude.com/docs/en/plugins/mods/events#follow-a-turn)。
3. **做不到“全平台、全策略下都生效”的自动干预，也撤销不了已发生的副作用**：
   - `PostToolUse` 只能改模型看到的内容，文件/命令/网络副作用已经发生；
   - Desktop 的 WSL 会话不加载 plugin（mods 不跑），cloud 会话不读本地 settings；
   - 组织可用 `allowManagedHooksOnly` / `disableAllHooks` / `allowManagedModsOnly` / `--safe-mode` 关闭；
   - Stop 连续续跑有 8 次硬上限，不能无限阻止收尾。

   **依据**：[PostToolUse Warning](https://code.claude.com/docs/en/hooks#posttooluse-decision-control)、
   [Where mods run](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run)、
   [Hooks locations](https://code.claude.com/docs/en/hooks#hook-locations)、
   [Stop 上限](https://code.claude.com/docs/en/hooks#stop-input)。

---

## 9. 未验证清单（后续可补）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| MCP `sampling` 支持 | **未验证** | 官方 Claude Code MCP 文档无 sampling 条目；不要设计依赖 |
| mod `classic.Stop` 是否能返回 block | **未验证 / 倾向不能** | 文档只展示 observe 用法，`turn.complete` 只支持 `{text}`；硬阻断用 settings Stop |
| command hook 单次 fork 的固定耗时 | **未验证** | 官方只说明“默认阻塞”“`if` 可避免 spawn”，未给基准数字 |
| `turn.step` 传非法 effort 等级的后果 | **未验证** | docs 未写；应按支持等级裁剪 |
| `session.append` 改写后的内容在遥测/其他消费者中的可见性 | **未验证** | docs 只承诺“落盘前改写该行”；遥测在 hook 前记录的是原始值（PostToolUse 语境） |
| MCP prompts 在 `list_changed` 后内容是否重新拉取 | **未验证** | `list_changed` 只明确刷新列表；prompt 内容调用时获取更合理（**推断**） |
| Claude Code 版本兼容矩阵（插件最低版本） | **部分** | 文中已标注每个特性的版本门槛；完整矩阵需以 changelog 为准 |

---

## 10. 来源索引

**官方文档（快照 2026-10-22）**

- Hooks reference — https://code.claude.com/docs/en/hooks
- Hooks guide — https://code.claude.com/docs/en/hooks-guide
- Plugins overview — https://code.claude.com/docs/en/plugins/overview
- Plugin components — https://code.claude.com/docs/en/plugins/components
- Install and manage plugins — https://code.claude.com/docs/en/plugins/install
- Plugin manifest reference — https://code.claude.com/docs/en/plugins/manifest-reference
- Mods overview — https://code.claude.com/docs/en/plugins/mods/overview
- React to events with a mod — https://code.claude.com/docs/en/plugins/mods/events
- Mods reference — https://code.claude.com/docs/en/plugins/mods/reference
- MCP — https://code.claude.com/docs/en/mcp
- Permissions — https://code.claude.com/docs/en/permissions
- Model configuration — https://code.claude.com/docs/en/model-config
- Settings — https://code.claude.com/docs/en/settings
- Sub-agents — https://code.claude.com/docs/en/sub-agents
- Skills — https://code.claude.com/docs/en/skills

**本地可验证事实（v0.2.0 集成分支 `0.2.0-test`，提交 `ece3846`）**

- `packages/dsh-harness-reflex/src/interventions.ts`：模块头四能力映射；三态 off/observe/active；fail-open；
  per-turn/per-session 预算；剪枝 locator 与“验证后才记 saved”。
- `packages/dsh-harness-reflex/src/config.ts`：`INTERVENTION_CAPABILITIES = ['stagnation','prune','gate','closing']`。
- `packages/dsh-harness-reflex/src/tools.ts`：5 个工具（choice/score/route/screen/gate，route 默认关）。
- 发布基线 `96ee842` 的 `packages/dsh-harness-reflex/src/tools.ts`：8 个工具（含 prune/detect_stagnation/status_ledger），
  不含 `interventions.ts`。

> 说明：以上本地路径用 `git show ece3846:<path>` 可复查；`0.2.0-test` 是 v0.2.0 的集成分支。

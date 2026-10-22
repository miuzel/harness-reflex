# Claude Code 插件：mod + settings hooks + MCP

> v0.2.0 S3 的交付说明。设计依据：`docs/design/v0.2.0-harness-plugins.md` §2.3/§4.1/§4.2；
> 官方契约依据：`docs/research/claude-code-harness.md`。
> 插件目录：`packages/claude-reflex/`。
> 真机验证已做：Claude Code 2.1.307/2.1.308，经 `claude-kimi` 启动器跑 `scripts/claude-e2e.sh`，
> 9 条断言全过（`docs/claude-code.md` §6）。仍无法在本机覆盖的部分单独列在 §7 下半表，不冒充已通过。

## 1. 交付物与三件套

一个 plugin 目录同时携带三种组件（官方确认可同装）：

| 组件 | 文件 | 职责 | 默认 |
| --- | --- | --- | --- |
| **mod**（进程内） | `hooks/register.js`，由 `hooks/hooks.json` 的 `modules` 声明 | `turn.step` 的 effort 接线；`tool.call` 直通（后续进程内判定的挂载点） | 启用（需 Claude Code v2.1.287+） |
| **settings hooks** | `hooks/hooks.json` 的 `hooks` 键 | 剪枝 / 停滞 / 失效纠偏 / 收尾核验的**主执行路径**，每次事件 fork 一个 `harness-reflex hook <event>` 进程 | 启用 |
| **MCP server** | `.mcp.json` | 根包 stdio server 的 8 个 `reflex_*` 工具，原样暴露 | 启用 |

为什么自动干预放在 settings hooks 而不是 mod：`Stop` 的硬阻断只有 command hook 有官方保证；
mod 的 `classic.Stop` 只被描述为观察。mod 只保留 effort 与进程内挂载点，避免同一调用被两条路径重复判定。

### hooks 清单（逐事件 command / timeout）

`timeout` 的单位是秒；括号内是 S2 的内部判定预算（见 `src/hook/contract.ts`），两者刻意不相等：
内层必须在宿主杀死进程之前结束并 fail-open。

| 事件 | matcher | command | timeout | 作用 | 默认档位 |
| --- | --- | --- | --- | --- | --- |
| `PreToolUse` | `Bash\|Edit\|Write\|MultiEdit\|mcp__.*` | `harness-reflex hook pretooluse` | 1（预算 300 ms） | 重复调用 → `permissionDecision:"deny"` | **active** |
| `PostToolUse` | 同上 | `harness-reflex hook posttooluse` | 2（预算 800 ms） | 超大结果 → `updatedToolOutput` + locator | **active** |
| `PostToolUseFailure` | 同上 | `harness-reflex hook postfailure` | 1（预算 300 ms） | 连续失败 → `additionalContext` 纠偏 | **active** |
| `Stop` | 无 matcher | `harness-reflex hook stop` | 2（预算 1000 ms） | 证据矛盾 → `{"decision":"block"}` | **observe**（opt-in active） |
| `SubagentStop` | `__disabled_by_default__` | `harness-reflex hook substop` | 2（预算 1000 ms） | 同 Stop，作用于子代理 | **默认关闭** |
| `SessionStart` | 无 matcher | `harness-reflex hook sessionstart` | 2（预算 1200 ms） | 建会话、GC、告知当前档位 | 启用 |
| `SessionEnd` | 无 matcher | `harness-reflex hook sessionend` | 2（预算 1200 ms） | GC，静默 | 启用 |

`SubagentStop` 的 matcher 是一个不可能匹配任何 agent type 的哨兵字符串，因此命令虽然写进了配置，
**默认不会 spawn**。要启用：把该 matcher 改成 `*`（或具体的 agent type），并保持
`closing_mode` 至少为 `observe`。

`if` 过滤没有使用：Claude Code 的 `if` 只在工具事件生效，且无法表达「只在结果超大时」；
matcher 已经把非目标工具挡在 spawn 之前（官方说明：matcher 不匹配不会 spawn）。

## 2. 安装

前置：Node.js ≥ 18；`harness-reflex` 可执行文件在 `PATH` 中（hooks 与 MCP 都按这个名字启动）。

```bash
# 在仓库根目录
npm ci
npm run build
npm link                 # 或：npm i -g .
harness-reflex --help    # 确认可执行
```

### 2.1 本机开发：只为一次会话加载（推荐先用这个验证）

```bash
claude --plugin-dir "$PWD/packages/claude-reflex"
```

`--plugin-dir` 不写任何全局配置；关掉会话即卸载，适合第一次验证。也可与 `-p` 同用：

```bash
claude -p "list the files" --plugin-dir "$PWD/packages/claude-reflex"
```

### 2.2 长期安装：marketplace / plugin install

插件目录本身符合 Claude Code 的 plugin 结构（`.claude-plugin/plugin.json` + `hooks/` + `.mcp.json`）。
把它放进一个 marketplace 仓库后：

```bash
claude plugin marketplace add <owner>/<repo>
claude plugin install claude-reflex@<marketplace> --scope user
claude plugin validate packages/claude-reflex   # 可选：静态校验
```

> 本仓库当前没有发布 marketplace；上面是官方安装路径，未在本环境执行。

### 2.3 MCP 工具名

插件自带的 MCP server 会带 plugin 作用域：

```
mcp__plugin_claude-reflex_harness-reflex__reflex_choice
mcp__plugin_claude-reflex_harness-reflex__reflex_score
mcp__plugin_claude-reflex_harness-reflex__reflex_route
mcp__plugin_claude-reflex_harness-reflex__reflex_screen
mcp__plugin_claude-reflex_harness-reflex__reflex_gate
mcp__plugin_claude-reflex_harness-reflex__reflex_prune
mcp__plugin_claude-reflex_harness-reflex__reflex_detect_stagnation
mcp__plugin_claude-reflex_harness-reflex__reflex_status_ledger
```

用裸 server 名写的 matcher / allow 规则不会命中插件内的 server。如果你只把根包 `.mcp.json`
挂到项目（不装 plugin），名字则是 `mcp__harness-reflex__reflex_*`，并且**没有任何自动干预**。

## 3. 配置

### 3.1 三态与默认值

每个能力独立取 `off` / `observe` / `active`。`observe` 完整检测、判定、记账，但**不改变模型可见输出**。

| 能力 | 默认 | 说明 |
| --- | --- | --- |
| `stagnation`（`PreToolUse`） | `active` | 重复调用被 deny |
| `prune`（`PostToolUse`） | `active` | 超大结果替换为缩减版 + locator |
| `gate`（`PostToolUseFailure`） | `active` | 连续失败追加纠偏 |
| `closing`（`Stop`/`SubagentStop`） | `observe` | 只记录「本来会 block 什么」 |

### 3.2 怎么改

优先级从高到低：

1. `HARNESS_REFLEX_MODE=off|observe|active` — 全局覆盖，四个能力一起变；
2. `HARNESS_REFLEX_STAGNATION_MODE` / `HARNESS_REFLEX_PRUNE_MODE` / `HARNESS_REFLEX_GATE_MODE` / `HARNESS_REFLEX_CLOSING_MODE` — 单能力覆盖；
3. 插件的 `userConfig.closing_mode`（向导里配置，Claude Code 以 `CLAUDE_PLUGIN_OPTION_CLOSING_MODE` 传给 hook 进程）；
4. 默认值。

收尾核验 opt-in 成硬闸，二选一：

```bash
# 方式 A：插件配置向导里把 Closing verification mode 设为 active
# 方式 B：启动 claude 前设置环境变量（会覆盖向导值）
export HARNESS_REFLEX_CLOSING_MODE=active
```

`HARNESS_REFLEX_EFFORT`（或插件的 `effort_level` 选项）只影响 mod 的 `turn.step`，取值为
`off|low|medium|high|xhigh|max`；非法值按 `off` 处理（forward 原始请求）。

### 3.3 状态目录与账本

```
${HARNESS_REFLEX_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/harness-reflex}/
└── sessions/cc-<sha16>/
    ├── meta.json        {harness, sessionId, createdAt, harnessVersion, mode}
    ├── state.json       turnNo / 预算缓存（可删，会重算）
    ├── events.jsonl     工具观察（停滞窗口与收尾证据的唯一来源）
    ├── ledger.jsonl     决策与节省（权威账本）
    ├── originals/<digest>.txt   剪枝原文（locator = 该文件）
    └── decisions/<key>.json     幂等缓存
```

查看账本（当前没有单独的 `ledger --session` 子命令；`harness-reflex ledger` 是进程内账本，不是 hook 账本）：

```bash
STATE="${HARNESS_REFLEX_STATE_DIR:-$HOME/.local/state/harness-reflex}"
find "$STATE/sessions" -name ledger.jsonl -print
node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){for(const l of fs.readFileSync(f,"utf8").split("\n"))if(l.trim()){const r=JSON.parse(l);console.log(r.timestamp,r.event,r.type,r.applied?"APPLIED":"",r.skipReason??"",r.tokensSaved??"")}}' $(find "$STATE/sessions" -name ledger.jsonl)
```

`originals/<digest>.txt` 就是 locator 指向的原文；`retention` 为 `evicted` 时表示原文已被 LRU 驱逐，
这次剪枝不会记 `tokensSaved`（审计纪律：没有留存就不算节省）。

坏 JSON / 缺 `session_id` 的 stdin 无法归属到任何会话，因此只 fail-open（`{}` + stderr），
不会写会话账本——这是 S2 的既有边界，不是本插件新增的放行路径。

## 4. 限制（官方行为，不是本插件的取舍）

- **Stop 有 8 次连续续跑上限**：连续 block 8 次后 Claude Code 强制结束本轮；计数在工具调用时重置。
  本插件另有 `maxClosingBlocksPerTurn`（默认 2）与 `stop_hook_active` 放行，正常情况下远达不到 8 次。
- **WSL 桌面会话不加载 plugin**（mod 不跑；settings hooks 仍可能运行）；云会话不读本地 settings。
- **企业策略可整体关门**：`disableAllHooks`、`allowManagedHooksOnly`、`allowManagedModsOnly`、
  `--safe-mode`。作者无法保证「装上就一定跑」。
- **纯 MCP 形态没有任何自动干预**：server 看不到别的工具调用，不能 deny / 改写 / 阻断收尾。
- **MCP 与 settings hook 不能设模型 / effort**：只有 mod 的 `turn.step` 可以；本插件只在
  配置了 `effort_level` 时才改写 effort。
- **`PostToolUse` 只改模型看到的内容**：文件、命令、网络的副作用已经发生，撤销不了。
- **`PostToolUseFailure` 不能替换错误文本**，只能附加 `additionalContext`。
- **输出上限**：`additionalContext` / `systemMessage` / 普通 stdout 各 10,000 字符；长证据要落盘给 locator。
- **平台**：hook 的 `FileStateStore` 依赖 POSIX `mkdir` 锁、`rename` 与单写 `O_APPEND`，
  `win32` 上直接以非 0 退出（宿主按放行处理）。首发只保证 Linux / macOS / WSL2。
- **mods 有版本门槛**：`modules` 需要 Claude Code v2.1.287+；更老的版本只跑 hooks + MCP，effort 不生效。

## 5. 排障

| 症状 | 检查 |
| --- | --- |
| 所有 hook 都不跑 | `claude --debug` 看 hook 是否被注册；确认企业策略没有 `disableAllHooks` / `allowManagedHooksOnly`；确认插件已启用（`/plugin`）。 |
| hook 报「command not found」 | `harness-reflex` 不在 Claude Code 继承的 `PATH` 上。`which harness-reflex`，或把 `dist/cli` 加进 `PATH` 后重启会话。 |
| 剪枝 / 停滞没效果 | 先看账本是否有 `type:"prune"` / `"stagnation"` 记录。`skipReason` 会告诉你原因：`below-threshold`、`capability-off`、`intervention-cap`、`judgment-turn-cap`。 |
| Stop 从不 block | 默认就是 `observe`。把 `closing_mode` 设为 `active`，并确认 `last_assistant_message` 真的包含完成声明。 |
| 状态目录在哪 | `echo "${HARNESS_REFLEX_STATE_DIR:-$HOME/.local/state/harness-reflex}"`。目录不存在通常意味着 hook 根本没跑。 |
| 想清空状态 | 删除整个状态目录即可；`state.json` 删了会自动重算，`events.jsonl` / `ledger.jsonl` 是权威数据。 |
| observe 下模型输出变了 | 不应发生。先确认 `HARNESS_REFLEX_MODE=observe` 没有被更高优先级的单能力变量覆盖；再用 `scripts/claude-e2e.sh` 复现。 |
| mod 没加载 | 需要 v2.1.287+，且 WSL 桌面会话不加载 plugin。用 `claude --debug` 看 mod 是否 register。 |

## 6. e2e 脚本

```bash
scripts/claude-e2e.sh          # 0=全过、1=失败、2=缺少 claude 等前置
scripts/claude-e2e.sh --keep   # 保留临时 state / stream 文件
```

它做四件事：

1. **静态契约**（无需 claude）：manifest / hooks / `.mcp.json` / 7 事件形状 / observe diff=0 / 崩溃放行；
2. `claude plugin validate packages/claude-reflex`（子命令不存在时降级为 WARN）；
3. 跑三次真实 `claude -p`：无插件 baseline、`HARNESS_REFLEX_MODE=observe`、`CLOSING=active`；
4. 断言：Stop block 一次 + `stop_hook_active` 第二次放行、真实剪枝更短且 locator 可还原、
   observe 的模型可见工具结果与 baseline **逐字节相同**。

脚本所有路径都基于 `$PWD`/`BASH_SOURCE`，不写死用户目录；状态写临时目录并在退出时清理。
真实会话需要可用的模型凭据；脚本用 `--dangerously-skip-permissions` 让 prompt 里的 Bash 命令无需人工确认。

## 7. 已验证 / 未验证

### 7.1 真机已验证（Claude Code 2.1.307/2.1.308 经 `claude-kimi`）

| 已验证 | 证据 |
| --- | --- |
| 插件真的被加载、hooks 真的执行 | `--plugin-dir` 后状态目录出现 `sessions/cc-*/{state.json,meta.json,ledger.jsonl,events.jsonl}` |
| `claude plugin validate` | PASS（e2e Phase 1） |
| 会话内剪枝生效、原文可还原 | ledger `prune applied=true`；`originals/<digest>.txt` 与原始输出逐字节一致（`original=8239 retained=8240`） |
| 收尾核验真的拦、且第二次放行 | ledger `closing-block=1` + `stop-hook-active=1` |
| observe 零副作用 | baseline 与 observe 的模型可见结果逐字节相同（8239 bytes） |
| 静态契约 / 7 事件形状 / 坏 JSON 放行 / 超时放行 | `packages/claude-reflex/test/{structure,hooks}.test.mjs`、`src/hook/hook.test.ts` |
| `SubagentStop` 默认不 spawn | `structure.test.mjs` 哨兵 matcher 断言 |
| `.mcp.json` 的 server 返回根包 8 个工具 | `structure.test.mjs` 真实 `tools/list` 握手 |

### 7.2 仍未验证

| 未验证 | 原因 |
| --- | --- |
| 模型是否真的"看到" `updatedToolOutput` 的内容 | Claude Code 的 transcript 保留原文，只能证到 hook 输出正确 + 原文可还原，无法从外部证到模型读到的文本 |
| mod 的 `turn.step` effort 在 v2.1.287+ 真实生效 | 需要观测 mods 运行时；本机 mod 加载无报错，但未观测到 effort 真的改变请求 |
| WSL 桌面 / 企业策略下的加载面 | 取决于用户环境 |
| 收尾核验转 active 的误报率 | 需要更多真实模型行为样本 |

### 7.3 `/hooks` 为空 vs 钩子不生效（两种不同故障）

先分清两种现象，它们的根因不同：

| `/hooks` 里看到 | 含义 | 修法 |
| --- | --- | --- |
| `No hooks configured for this event` | 当前会话**没有加载插件**（`/hooks` 只反映本会话已加载的插件与 settings.json；插件没加载就什么都不显示） | 用 `--plugin-dir` 启动，或按 §2.2 安装 |
| `Hooks · 7 hooks on 7 events`，每条前面标 `[Plugin] ... harness-reflex@inline` | 插件已加载，钩子已注册 | 若功能仍不生效，看下一条 |

插件加载正常时，`/hooks` 的 `PreToolUse` 下面应是这样一行：

```
[Plugin] harness-reflex hook pretooluse   harness-reflex@inline · Bash|Edit|Write|MultiEdit|mcp__.* · command
```

**第二种故障：钩子注册了但跑不起来。** hooks 以裸名 `harness-reflex` 启动（`.mcp.json` 同理），
`PATH` 里没有这个可执行文件时，每次事件都在启动阶段失败，而失败是**静默的**——hooks 的约定
就是"出问题一律放行"。想看到原因必须开 debug：

```bash
claude --plugin-dir packages/claude-reflex --debug=hooks
# SessionEnd hook [harness-reflex hook sessionend] failed: Executable not found in $PATH: "harness-reflex"
```

所以正确顺序是 §2：先 `npm link`（或 `npm i -g harness-reflex`）确认 `harness-reflex --help` 能用，
再 `--plugin-dir`。

## 用自定义启动器跑 e2e（例如 `claude-kimi`）

本机把 claude 包在 zsh 函数里（`claude-kimi` 会先 export `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY` 再调 `claude`）时，直接跑脚本会得到 `Not logged in`。脚本支持把它当启动器：

```bash
cd packages/../..            # 仓库根
npm run build:all
CLAUDE_LAUNCHER=claude-kimi PATH="$PWD/dist/cli:$PATH" scripts/claude-e2e.sh
```

- `CLAUDE_LAUNCHER` 是 **zsh 函数名**（不是路径），脚本以 `zsh -ic '<fn> -p <flags>'` 调用它，**prompt 走 stdin**——因为 `claude-kimi` 内部是 `claude $*`，把含换行与引号的 prompt 作为参数会被重新分词。
- 函数在 stdout 打印的横幅（如 `starting claude with arguments ...`）会被过滤掉，只保留 `{...}` 的 stream-json 行。
- 需要临时状态目录时脚本会用仓库内 `tmp/`（不是 `/tmp`）：沙箱宿主可能不允许 hook 写 `/tmp`，状态写不进去会让断言看起来像"没生效"。
- 只想验静态契约与 `claude plugin validate`、不跑真实会话：`CLAUDE_LAUNCHER=... scripts/claude-e2e.sh` 在未登录时会以 exit 2 停下并说明。
- active 会话重试一次：模型是否真的执行那条失败命令、是否随后声称完成，属于模型行为而非插件行为；没出现完成声明时脚本换一个干净状态目录重跑。每次 attempt 用独立状态目录，且**只把最终采用的那次计为一条断言**，所以总结恒为 `9 passed`，不会因为重试变成 `10 passed`。

断言口径（真实会话部分）：

| 断言 | 依据 |
|---|---|
| 剪枝生效 | ledger 的 `prune applied=true` + `originals/<digest>.txt` 与原始输出逐字节一致；Claude Code 的 transcript 保留原文，所以不要求 transcript 出现 locator |
| 收尾阻断 | ledger 出现 `closing applied=true`，且随后 `stop_hook_active` 的重试被放行 |
| observe 零副作用 | observe 与"未装插件"的模型可见结果逐字节相同 |


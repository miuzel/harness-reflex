# Harness Reflex (System 1 Decision Runtime for Codex / Claude Code / AGY)

跨 Harness（**Codex CLI**、**Claude Code**、**Antigravity / AGY**）的 System 1 快速决策与 Jev API 兼容插件。

汲取社区优秀实践（`lldois/dsh-jev` 与 `HorusJiang/dsh-jev-tools`），并专注于两大核心护城河：**跨 Harness 原生兼容** 与 **停滞检测 / 工具剪枝 / 严格验收门禁**。

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
(POST /v1/choice    (max_tokens: 1,                 (用于测试、开发与        (Qwen / DeepSeek)
 /v1/gate 等)       next-token logprobs)             离线基准跑分)
```

1. **跨 Harness 零门槛适配**：
   - **Claude Code**：标准 MCP 协议（`.mcp.json`），提供 `reflex_gate`、`reflex_prune`、`reflex_detect_stagnation` 等工具。
   - **Codex CLI**：`.codex/config.json` 原生 MCP 挂载。
   - **Antigravity (AGY)**：支持全功能 Bundle 插件（`.agents/plugins/harness-reflex/`），内嵌 `plugin.json`、`mcp_config.json`、`hooks.json` 与 `rules/AGENTS.md`。

2. **吸收实证工程精髓**：
   - **Gate 反向 Fail-Closed**：证据不足或调用出错时落到 `escalate`，绝不允许“失败即放行”。
   - **Prune 容错 Fail-Open**：剪枝失败或置信度不足时原样放行，确保不破坏 Agent 执行链。
   - **排序不卡硬阈值**：原始概率仅用于 Top-K 优先推荐，避免校准漂移误伤。
   - **同轮判定 Latch**：相同声明与上下文不重复触发，避免浪费。
   - **台账与净收益追踪（Ledger）**：全量记录每次调用的延迟、节省 Token 与基线对比。

---

## 快速安装与配置

### 1. 构建
```bash
npm install
npm run build
```

### 2. 一键配置 Harness
```bash
# 自动为 Claude Code, Codex, Antigravity 全部生成配置文件与规则
node dist/cli/index.js setup all

# 或单独配置某一个
node dist/cli/index.js setup claude
node dist/cli/index.js setup codex
node dist/cli/index.js setup agy
```

### 3. 配置决策后端（可选）
默认使用本地快速模拟与启发式决策器（`<5ms` 延迟，零外部依赖）。如需接入真实模型：

```bash
# 方式 A：接入官方 Jev API
export REFLEX_BACKEND=jev
export JEV_API_KEY="your-api-key"
export JEV_BASE_URL="https://api.jev.ai"

# 方式 B：接入本地 / 远程 vLLM (支持 Qwen / DeepSeek 无权重改动的 next-token logits 读出)
export REFLEX_BACKEND=simple-jev
export VLLM_BASE_URL="http://localhost:8000"
```

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

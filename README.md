# Harness Reflex (System One Decision Runtime for Codex / Claude Code / AGY)

跨 Harness（**Codex CLI**、**Claude Code**、**Antigravity / AGY**）的 System One 快速决策与判定运行时插件。

统一支持各类 **System One API**（包括官方 Jev、vLLM/OpenAI logits 读出、自托管模型与本地启发式决策后端），让 Harness 在不调用笨重 System Two 推理的情况下，毫秒级实现门禁验证、上下文剪枝与死循环拦截。

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

2. **全套 System One 工具链（原生 MCP Tools 暴露给 Agent）**：
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

3. **离线拟合校准闭环（Isotonic PAVA & Platt 回归）**：
   - 内置 `calibrate` 引擎，可基于历史标注集拟合单调映射曲线，计算 ECE 误差并输出校准配置；
   - 线上运行时自动修正过度自信的模型原始概率，杜绝盲目放行。

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

### 3. 配置 System One 决策后端（可选）
默认内置本地快速启发式决策器（`<5ms` 延迟，零外部依赖）。可随时无缝切换到其他 System One API：

```bash
# 切换 Provider A：官方 Jev API
export SYSTEM_ONE_BACKEND=jev
export SYSTEM_ONE_API_KEY="your-api-key"
export SYSTEM_ONE_BASE_URL="https://api.jev.ai"

# 切换 Provider B：通用 open-weights 模型 logits 读出 (vLLM / simple-jev / OpenAI 兼容接口)
export SYSTEM_ONE_BACKEND=simple-jev
export SYSTEM_ONE_BASE_URL="http://localhost:8000"
export SYSTEM_ONE_MODEL="Qwen/Qwen2.5-7B-Instruct"

# 切换 Provider C：离线/本地基准模拟后端 (默认)
export SYSTEM_ONE_BACKEND=mock
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

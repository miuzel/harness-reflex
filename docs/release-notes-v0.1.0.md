# Harness Reflex v0.1.0 发布记录

> **状态：已发布**（2026-10-21）。正文以本文件为唯一真源；产物指纹见文末。
> 基线：`main` @ `2d43a42`，tag `v0.1.0`。

## v0.1.0 — 2026-10-21

- **自动干预四能力落地**：`stagnation`、`prune`、`gate`、`closing` 可在**模型没有调用任何工具**时由宿主钩子介入；`off` / `observe` / `active` 三态，每个能力还可单独用 `off` / `observe` / `active` / `inherit` 覆盖。`observe` 只记账不执行，`active` 才会拒绝重复调用、改写超长结果、把失败改写为纠正反馈、在收尾时对证据冲突提出异议。后台作业等待（`job_output` / `job_list`）按结构化形态豁免，不会被误判为停滞。
- **System One 逐段剪枝**：超过 `pruneJudgeMinChars`（默认 10 000 字符）的输出会按段交给 System One 判定取舍，而不是只做首尾截断；判定候选低于 `pruneFloorRatio`（默认 0.5）时用首尾上下文补足，并保留判定选中的中间诊断。原文先写入会话日志（`plugin:dsh-reflex/pruned-original`）再替换，替换文本带 `plugin:dsh-reflex/pruned-original#<digest>` 定位符，可用 `readPrunedOriginal()` 逐字节取回；保留失败则不替换、不虚报节省。
- **配置全部热生效**：System 1 后端与连接参数、`ledgerPath` 账本落点、`pruneThreshold`、虚拟 Provider 的启用与改名、候选池编辑、工具开关与 `toolPrefix`、推理强度与干预策略，保存后无需重启即可生效；路由生命周期与已注册的工具面同步收敛。
- **设置面板可解释性**：每个设置项补充 placeholder 与 `(?)` 帮助，说明取值、默认值与影响；自动干预与工具开关成为独立设置面，工具开关页给出推荐组合并解释每项用途；顶部状态收敛为单一图标，悬停显示当前模式。
- **工具面收敛到两套表面**：DSH 插件侧保留 **5 个可开关能力**（`choice` / `score` / `route` / `screen` / `gate`，默认注册 4 个，`route` 默认关闭）；`reflex_prune`、`reflex_detect_stagnation`、`reflex_status_ledger` 不再是 DSH 工具，改由自动干预与 `/reflex-ledger` 命令承载。stdio MCP 侧仍是自 v0.1.0 起冻结的 **8 个工具**，两套表面不逐项对齐。
- **决策账本改为命令**：DSH 内输入 `/reflex-ledger` 直接渲染本次激活的账本汇总（总调用、类型分布、平均时延、节省 token、门禁/停滞、最近 5 条），不占工具位、不发起模型回合；账本为空时显示“暂无记录”。`ledgerPath` 省略时仅内存，用户项目零污染。
- **自适应推理强度更克制**：`reflex` / `auto` 合并为一个自适应选项，留空表示不干预；只有本轮意图明确时才改写 `reasoningEffort`，低于置信度下限退回确定性线索投票，System One 异常时兜底而不是失败。虚拟模型路由继续带上下文感知与会话粘性，减少无谓切换造成的缓存失效。

### 安装 / 升级

```bash
# 插件（本版包名 dsh-system-one；tarball 命名为 dsh-system-one-0.1.0.tgz）
dsh plugin --profile web add --force ./release/dsh-system-one-0.1.0.tgz
# 根包（MCP 面）
npm install ./harness-reflex-0.1.0.tgz
```

- **同版本号重装必须 `--force`**；
- 本版无数据迁移；账本 JSONL 只追加，旧记录可直接读取；
- 0.1.0 计划两个包都发布：根包 `harness-reflex` 与插件 `dsh-system-one`；也可先走 **tarball / GitHub Release**。
  npm 上 `dsh-reflex` 已被第三方 `onesmash@0.3.0` 占用，因此插件改用非 scoped 的 `dsh-system-one`（registry 已确认 E404 可用）；
  发布前仍需负责人完成 `npm login`。

### 验证与产物

- **发布产物**（发布树实测；完整 SHA-256 记在 `release/SHA256SUMS` 与 `release/RELEASE-0.1.0.md`）：
  - `harness-reflex-0.1.0.tgz`：**73 entries**，约 **219 KiB**；根包内含本文档，任何文档编辑都会改变其字节，
    因此不在正文固化 sha256；
  - `dsh-system-one-0.1.0.tgz`：**102 entries**，约 **578 KiB**；
  - `SHA256SUMS` 随 Release 附件发布；连续两次打包 sha256 一致。
- **打包核验**：`scripts/release-pack.mjs` **27/27** 通过（结构审计、零死链、零未声明依赖、根包离线安装、`bin`、具名 import、stdio MCP 8 工具、插件 `apply()` 与检索 API）。
- **测试**（本次 0.1.0 工作树）：根包 113 pass / 0 fail；插件 419 pass / 0 fail；负向对照 51/51 注入故障被抓（50 测试 + 1 编译器）；三套 `--noEmit` exit 0。
- **平台真机门禁**：Linux/WSL2 已实测（隔离 `DSH_HOME` + tarball 安装 + `/dsh-reflex/api/health` 返回 `{"ok":true,"name":"dsh-reflex","version":"0.1.0"}` + `/panel` 可读）；原生 Windows、macOS **本版未验证**。
- **发布记录**：详见 [`docs/release-checklist-v0.1.0.md`](release-checklist-v0.1.0.md)。
- **可复现性**：同一构建树连续两次打包 sha256 一致；从 tag 发布树重新构建后需重新记录指纹。

### 已知限制

- 未加 scope 的 npm 包名 `dsh-reflex` 已被他人占用（`onesmash@0.3.0`），本版改用 `dsh-system-one`；非 scoped 包名已确认可用（E404），`npm login` 仍由负责人在发布前完成。
- 公开仓库与 tag 已创建：https://github.com/miuzel/harness-reflex/releases/tag/v0.1.0 ；商店（awesome-dsh-plugin）尚未提交。
- `active` 模式下的 14.5K 剪枝已在真实会话手工验证过一次（14534 → 6766 字符，省 1942 tokens，定位符可见）。
- 根 `README.md`、插件 `README.md`、`docs/dsh-plugin.md`、`USER_GUIDE.md` 及英文版已统一口径：
  MCP 8 工具 / DSH 5 个可开关（默认 4，`route` 关）/ 剪枝与停滞为自动干预 / 账本用 `/reflex-ledger`。

## 产物指纹

| 包 | 文件 | SHA256 |
|---|---|---|
| 插件 | `dsh-system-one-0.1.0.tgz` | `b9068caaef13e0c3914d2fa93c208f669c113427106c89c40a07d6fdac9cce6a` |
| 核心/MCP | `harness-reflex-0.1.0.tgz` | `1241bcfff3a425ec287d4f7cdccbd3304f39e62921ea2e06aac541678de1652c` |

## 从 0.1.0-alpha.2 升级

插件 npm 包名已改为 `dsh-system-one`。旧的 `dsh-reflex` 安装与新包是**两个不同插件**，配置不会自动迁移：安装新包后需要重新配置一次（System 1 后端与 API Key、干预模式、虚拟 Provider 候选池、工具开关）。

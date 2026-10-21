# 发布手册移植差异表（dsh-graph → harness-reflex）

> 对应产物：[`release-handbook.md`](release-handbook.md)、[`release-checklist-v0.1.0.md`](release-checklist-v0.1.0.md)、[`release-notes-v0.1.0.md`](release-notes-v0.1.0.md)。
> 目的：说明哪些沿用 `dsh-graph/docs/release-handbook.md` 的体例，哪些按本仓库事实改写，哪些明确不适用。
> 核对基准：`integration/v0.1.0` @ `8758f43`，2026-10-21。

## 1. 沿用（结构 / 思想，不照抄结论）

| dsh-graph 的做法 | 在本仓库的沿用 |
|---|---|
| 手册按“总体路径 → 阻塞清单 → 元数据 → 打包 → 发布树/tag → 渠道 → notes → 本地验收 → 兼容性 → 商店 → 回滚 → checklist”组织 | 采用同一骨架（0–11 节），保证评审者可逐节对照 |
| 阻塞清单逐条写“状态 + 证据/待办”，已完成与待办分开 | 保留；但每一条按本仓库重新取证，未照搬 B1–B8 结论 |
| 发布必须从 **tag 的独立 worktree** 构建，避免“发布物 ≠ tag 内容” | 保留；命令改为本仓库的 `npm run build:all` + `release-pack.mjs` |
| release notes 以 `docs/release-notes-v<版本>.md` 为唯一真源，线上正文由文件发布 | 保留；新增 `docs/release-notes-v0.1.0.md` |
| 发布后核对线上正文与真源逐字一致（仅末尾换行归一化） | 保留；命令改用本仓库占位仓库名 |
| 宿主兼容性必须多维判定，不能只看“装上了、起得来” | 保留三维度框架；维度内容改为本插件的“工具面 / MCP 面 / 真机自动干预” |
| awesome-dsh-plugin 的 YAML 字段、README 再生成、PR 自查清单 | 保留；条目名与描述改为 `harness-reflex` |
| 回滚保留上一版 tarball、tag 不移动、修复走补丁版本 | 保留；补充了 `release-pack.mjs` 会清空 `release/`，必须先归档旧 tarball 这一本仓库细节 |

## 2. 按本仓库改写（事实不同）

| 主题 | dsh-graph | 本仓库（已核对） |
|---|---|---|
| 包结构 | 单包（`dsh-graph`，host/client 合并） | **双包**：根 `harness-reflex`（core + stdio MCP + CLI）+ `packages/dsh-reflex`（DSH 插件 + 客户端面板） |
| 打包入口 | `bash scripts/build.sh` + `dist/` + `pnpm pack/publish` | **`node scripts/release-pack.mjs`**（`npm run release:pack`），产物直接落 `release/*.tgz` |
| 产物 | `dsh-graph-<v>.tgz` 单包 | `release/harness-reflex-<v>.tgz` + `release/dsh-reflex-<v>.tgz` + `SHA256SUMS` + `release-report.json` + `RELEASE-<v>.md` |
| 自检 | 冻结验收脚本 / dist freshness 测试 | **27 项自检**（构建新鲜度 2、产物/版本 4、结构审计 10、内容断言 4、安装冒烟 7） |
| 测试 | `scripts/run-tests.mjs` 等 | `npm test`（当前 113）、`npm run test:plugin`（当前 419）、`npm run test:mutation`（51/51） |
| 安装 | `dsh plugin --profile web add dsh-graph` | `dsh plugin --profile <p> add --force <tarball>`；同版本必须 `--force` |
| 健康检查 | `/api/dsh-graph` | `/dsh-reflex/api/health`（插件身份）+ `/dsh-reflex/api/panel`（快照：`systemOne` / `interventions` / `tools` 等） |
| 账本 | 看板/工具 | DSH 侧 `/reflex-ledger` 命令；MCP 侧 `reflex_status_ledger` 工具 |
| 工具面 | 单套 14 工具 | **两套**：MCP 8 工具；DSH 5 个可开关（默认 4，`route` 关），无 `reflex_prune` |
| 插件核心依赖 | 包内 `core/` 副本经 sync 脚本同步 | 插件 `dist/vendor/harness-reflex/**` 内联核心；tarball 安装**不依赖根包**（仅 zod/schemastery + Host peers） |
| 版本同步 | 单包 version + 常量 + 文档 | 根包/插件 `package.json`、`REFLEX_PLUGIN_VERSION`、两份指南、插件 README、`src/release-packaging.test.ts` 固定文件名、`package-lock.json`、重建 `client.js` |
| registry 现状 | 官方 registry 已发布过，仅登录态问题 | 根包名 `harness-reflex` 可用（404）；**插件名 `dsh-reflex` 已被他人占用（0.3.0）**，registry 直发被阻塞 |
| 推荐渠道 | 单包 registry 发布 | 0.1.0 先走 **tarball / GitHub Release 直发**；registry 待包名与凭据决策 |
| 发布正文模板 | 平台门禁指向 `docs/platform-gate.md` | 本仓库无该文件；平台结论直接写进 notes（Linux/WSL2 实测、Windows/macOS 未验证） |
| 商店前置 | 已有公开 repo / topic | 仓库尚未创建、无 remote/tag、无 awesome 条目；gh 已登录 `miuzel` |

## 3. 不适用（明确不要照抄）

| dsh-graph 内容 | 不适用原因 |
|---|---|
| `bash scripts/build.sh`、`docs/dist`、`dist/` 内 `pnpm publish` | 本仓库没有这些入口；发布物由 `release-pack.mjs` 直接打包，`dist/` 只是构建中间层 |
| `pnpm publish` / `npm publish dist` 流程 | 本仓库 0.1.0 走 tarball；且插件包名冲突，不能照抄 registry 直发 |
| `dsh-graph-host/` 目录、`sync-core.sh`、跨包 `boardPayload` 问题（B7） | 本仓库结构不同：插件 side 自带 vendor，根包与插件各自打包 |
| B8“发布包带 .ts 不可加载” | 本仓库发布 `dist/*.js` + `.d.ts`，release-pack 已断言无测试构建与死链；该阻塞不存在 |
| `GIT_SSH_COMMAND="ssh -F /dev/null"` 等本机 ssh 配置绕过 | 属 dsh-graph 作者环境特例，本仓库无此记录；不要写入通用流程 |
| `docs/platform-gate.md`、`docs/fixture-versioning-checklist.md` 等 dsh-graph 专属文档 | 本仓库没有这些文件；平台结论写 release notes，fixture/版本策略写本手册 |
| `dsh-graph` 包名、topic、商店条目 `miuzel__dsh-graph.yml` | 本仓库应为 `miuzel__harness-reflex.yml`，且当前尚未提交 |
| dsh-graph 的 B1–B8 阻塞项结论 | 本仓库对应项要么已具备（27 项自检、真机安装），要么是不同阻塞（包名冲突、无 remote），不得照搬 |

## 4. 章节映射

| dsh-graph 手册 | 本仓库手册 |
|---|---|
| §0 总体路径 | §0 总体路径 |
| §1 前置阻塞清单 | §1 前置阻塞清单 |
| §2 发布缺口补齐 | §2 版本号与包元数据 |
| §3 建 repo + topic | §4 发布树与 tag（拆出） |
| §4 发布（含 notes） | §5 渠道 + §6 notes 真源 |
| §5 本地验收 + §5.1 兼容性 | §7 全新 profile 验收 + §8 三维度判定 |
| §6 打包结构 | §3 打包与产物核验 |
| §7 商店上架 | §9 商店与 awesome |
| §8 总 checklist | §10 回滚 + §11 总 checklist |
| — | 新增 §10 回滚（本仓库需要明确 tarball 回滚路径） |

## 5. 0.1.0 版本号同步涉及的文件（仅描述，本次未改）

| 文件 | 需要处理的引用 |
|---|---|
| `package.json` | `"version": "0.1.0-alpha.2"` → `0.1.0` |
| `packages/dsh-reflex/package.json` | 同上 |
| `packages/dsh-reflex/src/panel-api.ts` | `REFLEX_PLUGIN_VERSION = '0.1.0-alpha.2'` |
| `USER_GUIDE.md` | 标题与 §13 等 3 处当前版本描述 |
| `docs/USER_GUIDE.en.md` | 3 处；修改后必须 `npm run build:all` 重新内嵌 |
| `packages/dsh-reflex/README.md` | 2 处；建议同时修正“依赖根包”的旧说法（实际为 vendor） |
| `src/release-packaging.test.ts` | 2 处硬编码 alpha.2 的产物文件名，bump 后不改会红 |
| `package-lock.json` | 根 `version` 当前是 `0.1.0`（已与 package.json 不一致）；用 `npm install --package-lock-only --ignore-scripts` 同步 |
| `packages/dsh-reflex/client.js` | 构建产物含版本字符串，重新构建，不手改 |
| `docs/dsh-plugin.md` | 8 处历史引用；只更新“当前版本”声明，历史章节保留 |

> 不存在的文件：本仓库没有 `pnpm-lock.yaml`（根用 `package-lock.json`，插件无独立 lock）；没有 `CHANGELOG.md`；没有 `LICENSE` 文件（`package.json` 声明 MIT，发布前是否补 LICENSE 由负责人决定）。

## 6. 本次实测指纹与复现性

2026-10-21 在 `integration/v0.1.0` @ `8758f43` 的隔离 worktree 构建并打包：

| 文件 | entries | 体积 |
|---|---:|---:|
| `harness-reflex-0.1.0-alpha.2.tgz` | 73 | 218 KiB |
| `dsh-reflex-0.1.0-alpha.2.tgz` | 102 | 577 KiB |

根包 entry 数从 69 变为 73，是因为本次新增的 4 份 `docs/release-*.md` 会按 `files: ["docs/**/*.md"]` 进入根包；插件包不含这些文档，条目数不变。具体 sha256 见 `release/SHA256SUMS`。**不在文档里固化根包 hash**：文档本身在根包内，任何后续编辑都会改变它；0.1.0 以发布树实测为准。

连续两次 `release-pack` 的 sha256 完全一致（同一构建树内本地可复现），但这些是 **alpha.2** 指纹，**不能**作为 0.1.0 的发布指纹。supervisor brief 中给出的旧指纹（插件 `ca4fac88…`、核心 `d8b791c3…`）与本次重建结果不同，说明 tarball 跨构建树并非字节可复现（`client.js`、文件 mtime/入口顺序都可能影响）；本手册与清单统一以**发布树实测**为准，不复用任何旧指纹。

> 注：supervisor brief 中给出的“当前 release 包”指纹（插件 `ca4fac88…`、核心 `d8b791c3…`）与本次重建结果不同。tarball 不是跨构建树字节可复现的（`client.js`、文件 mtime/入口顺序都可能影响），本手册与清单统一以**发布树实测**为准，不复用任何旧指纹。

## 7. 移植时发现、但本次不修改的仓库不一致（待负责人决定）

1. 根 `README.md`“DSH 插件注入 8 个 reflex_* 工具”与当前 5 工具面（默认 4）不一致；`USER_GUIDE.md` §9/§13 与 `docs/dsh-plugin.md` §14 才是现行口径。
2. `packages/dsh-reflex/README.md` 写“依赖 `harness-reflex ^0.1.0-alpha.2`”，但插件 `package.json` 无该依赖，tarball 内是 `dist/vendor/harness-reflex` 内联；需在 0.1.0 一并修正文案。
3. `docs/dsh-plugin.md` §1/§2 仍写“8 个原生工具”，§14 已声明此后以 5 工具为准；属历史章节，建议只加“已由 §14 覆盖”提示，不重写历史。
4. `package-lock.json` 根版本是 `0.1.0`，与 `package.json` 的 `0.1.0-alpha.2` 不一致；版本同步时必须重新生成。
5. `packages/dsh-reflex/client.js` 是 `files` 白名单内的必要产物，但当前分支未跟踪；需明确“发布树必须构建”还是“入库”，二者不能含糊。
6. `USER_GUIDE.md` §2 架构表仍写 `src/tools.ts 8 个 reflex_* 工具`，同文 §9/§13 已明确 DSH 侧是 5 个可开关、默认 4 个；本次发布文档以 §9/§13 为准，建议 0.1.0 一并统一该表述。

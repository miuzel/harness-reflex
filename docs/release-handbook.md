# Harness Reflex 发布手册（0.1.0）

> **适用范围**：本仓库 `harness-reflex`（根包）与 `packages/dsh-reflex`（DSH 宿主插件）的 0.1.0 发布。
> **状态**：0.1.0 代码面已收口——两包版本 `0.1.0`、插件改名 `dsh-harness-reflex`、文档统一口径、`release-pack` 27/27。
> **0.1.0 尚未发布**：tag / npm publish / GitHub Release / 商店提交仍为**待负责人**的人工 gate。
> **事实基准**：分支 `integration/v0.1.0` @ `9235039` + 本次 0.1.0 改动，核对日期 2026-10-21；环境 Node `v26.7.0`、npm `12.0.2`、pnpm `12.3.4`、dsh `0.2.1-rc.2`。
> **移植来源**：`dsh-graph` 的 `docs/release-handbook.md`（388 行）。本手册沿用了它的**章节骨架与门禁思想**，但所有命令、产物、阻塞项均按本仓库重写；差异明细见 [`release-handbook-porting-notes.md`](release-handbook-porting-notes.md)。
> **本手册不是发布许可**：文中所有“待负责人确认”项必须先关闭或明确豁免，才可进入第 4 节之后的发布动作。

---

## 0. 总体路径（负责人定案）

```
确认本手册与 0.1.0 清单
  → 版本号 alpha.2 → 0.1.0（已由本次执行完成）
  → 在 tag 的独立发布树构建 + 全套测试 + 打包 27 项核验
  → 记录 sha256，建 tag，推送仓库（负责人）
  → 发布渠道决策：tarball 直发（推荐）/ registry（当前被包名冲突阻塞）
  → 全新 profile 真机验收（安装、启动、面板、命令、自动干预）
  → GitHub Release 正文（以 docs/release-notes-v0.1.0.md 为真源）
  → awesome-dsh-plugin / 商店提交
  → 回滚演练与留档
```

当前只完成了“流程与清单落纸”：

- ✅ 打包链路、27 项自检、真机 tarball 安装链路已在本仓库实测；
- ✅ 版本号已升到 `0.1.0`（两包 + 常量 + 测试/文档引用），插件包名为 `dsh-harness-reflex`；
- ✅ 文档口径已统一为「MCP 8 / DSH 5 可开关（默认 4）/ 自动干预 / `/reflex-ledger`」；
- ⏳ tag / npm publish / GitHub Release / 商店均未执行（人工 gate，见 §5/§7）；
- ⚠️ npm 发布仍需负责人解决**登录态**（B5）；插件包名 `dsh-harness-reflex` 已在 registry 确认可用（E404）。

---

## 1. 前置阻塞清单（当前真实状态）

> 原则：**做过的写证据，没做的写待办**。不得把 dsh-graph 的 B1–B8 结论照搬过来。

| # | 阻塞 / 前置项 | 归属 | 状态 | 证据 / 待办 |
|---|---|---|---|---|
| B1 | 版本号同步到 `0.1.0` | 本次执行 | ✅ **已完成** | 根 `package.json`、`packages/dsh-reflex/package.json`、`panel-api.ts`、lock、测试/文档引用全部为 `0.1.0` |
| B2 | 打包与自检链路 | 本仓库 | ✅ **已具备** | `node scripts/release-pack.mjs` 实测 **27/27 checks passed**（2026-10-21，0.1.0） |
| B3 | 真机安装 / 启动 / 面板 | 本仓库 | ✅ **已具备（0.1.0）** | 隔离 `DSH_HOME` + tarball `dsh plugin --profile web add --force` 成功；`/dsh-reflex/api/health` 返回 `{"ok":true,"name":"dsh-reflex","version":"0.1.0"}`；`/panel` 可读；`/reflex-ledger` 可执行 |
| B4 | npm 插件包名最终定名 | 负责人 | ✅ **已决策并落地** | `dsh-reflex` 已被他人占用（0.3.0）；最终采用社区惯例 `dsh-` 前缀 + 项目名，非 scoped 的 `dsh-harness-reflex`。主管已在 registry 确认 `npm view dsh-harness-reflex` 返回 E404（可用）。命名教训见 §1.1 |
| B5 | npm 官方 registry 登录态 | 负责人（人工 gate） | ⚠️ **未登录** | `npm config get registry` = `https://registry.npmjs.org/`；`npm whoami` 返回 **E401**。发布前由负责人执行 `npm login` |
| B6 | Git remote / tag / 公开仓库 | 负责人 | ⏳ 待办 | 当前 `git remote -v` 为空、`git tag -l` 为空；`gh` 已登录 `miuzel`，但 `miuzel/harness-reflex` 尚不存在（GraphQL Could not resolve） |
| B7 | awesome-dsh-plugin / 商店收录 | 负责人（人工 gate） | ⏳ 待办 | `data/plugins/miuzel__harness-reflex.yml` 不存在（404）；仓库未建，不满足“仓库 ≥1 天、commits ≥10”的 CI 条件 |
| B8 | `packages/dsh-reflex/client.js` 未入库 | 负责人决策 | ⏳ 待办 | 该文件由 `npm run build:all` 生成、被插件 `files` 白名单收录，但当前分支未跟踪；发布树必须先构建。是否入库由负责人决定 |
| B9 | 既有文档的旧表述 | 本次执行 | ✅ **已完成** | 根/插件 README、`docs/dsh-plugin.md`、`USER_GUIDE.md`、`docs/USER_GUIDE.en.md` 已统一为「MCP 8 / DSH 5（默认 4）/ 自动干预 / `/reflex-ledger`」，并更新 `dsh-harness-reflex` 安装命令 |
| B10 | 平台验证范围 | 本仓库 | ⚠️ 部分 | 本轮只在 Linux/WSL2 实测；原生 Windows / macOS **本版未验证**，发布正文必须如实标注 |
| B11 | `src/release-packaging.test.ts` 固定产物名 | 本次执行 | ✅ **已完成** | 已改为按 `root.version` / `plugin.version` 动态生成，插件包名使用 `dsh-harness-reflex-<version>.tgz` |
| B12 | release notes 发布日期 | 负责人 | ⏳ 待办 | `docs/release-notes-v0.1.0.md` 日期为占位，发布时替换 |

**结论**：0.1.0 可以走“**本地/附件 tarball 直发**”路径，当前无硬阻塞；也可以走 npm registry 发布 `harness-reflex` 与 `dsh-harness-reflex`，前提是负责人先关闭 B5（登录）。

### 1.1 npm 命名教训（403 Package name too similar + 社区命名惯例）

0.1.0 期间插件包名试过多个候选，最终定名 `dsh-harness-reflex`；其中一次候选被 registry 以“**过于相似**”直接拒绝：

- npm 不只看**同名**，还会对与既有包**过于相似**的名字直接返回 `E403 Package name too similar to existing package`。被拒的候选是 `dsh-system-one`，registry 上已有 `dsh-systemone`——**两者只差一个连字符**，`npm publish` 当场失败（不是等到发布后才发现）。
- 候选名规则（缺一不可）：
  1. 先 `npm view <name> version`，**必须得到 404** 才算可用；有版本即被占用；
  2. 避免与既有包**仅差连字符 / 大小写 / 单复数 / 词序**（`foo-bar` vs `foobar` vs `foo-bar-s` 都算高风险）；
  3. 被 registry 拒过一次的名字**不要反复重试**（同样的 403 会一直复现），直接换名并同步全仓；
  4. 优先跟社区惯例走：DSH 生态的插件包用 **`dsh-` 前缀 + 项目名**（如 `dsh-graph`），本项目最终即取 `dsh-harness-reflex`；命名风格与生态一致比短名更重要。
- 落地检查：改名后必须同时核对 `package.json.name`、`cordis.patch.yml` 模块名、client bundle id（由包名派生）、产物 tarball 名、`release/SHA256SUMS`、`release/RELEASE-0.1.0.md` 与全部文档；而 Cordis 插件 `id`、`/dsh-reflex/api/*`、`data-reflex-*`、locale、目录名这些**身份标识不随包名改**。
- 本仓库历史候选（**均已废弃，不得再用于产物**）：`dsh-reflex`（被他人占用）、`dsh-system-one`（E403 过于相似）、`dsh-reflex-kit`（可用，但不符合 `dsh-` 前缀惯例，负责人定案前已弃用）。

---

## 2. 版本号与包元数据

### 2.1 当前元数据（核对自仓库）

| 项 | 根包 `harness-reflex` | 插件包 `dsh-harness-reflex` |
|---|---|---|
| 版本 | `0.1.0` | `0.1.0` |
| 入口 | `dist/index.js`；`bin.harness-reflex = dist/cli/index.js` | `dist/index.js`；Cordis `apply(ctx, config)` |
| 对外声明 | `exports`（`.` / `./mcp` / `./core/*`） | `exports`（`.` / `./testing` / `./client` / `./cordis.patch.yml` / `./locale/*.json`） |
| DSH 元数据 | — | `dsh.bundle.patch = ./cordis.patch.yml`；`dsh.client.platform = web`，`external = ['react']` |
| 运行时依赖 | 无（`dependencies` 为空） | `@deepseek-ai/schemastery ~3.18.5-alpha.2`、`zod ^4.0.0`；Host 模块走 `peerDependencies`；核心 vendored 进 `dist/vendor/harness-reflex` |
| 引擎 | `node >= 18` | `dsh < 0.2.2` |
| 包名可用性 | npm 查询 404（可用） | 非 scoped 名 `dsh-harness-reflex`（E404 可用）；`dsh-reflex` 已有他人 `0.3.0`（**不可用**） |

插件包**不依赖根包的运行时安装**：`dist/vendor/harness-reflex/**` 已内联核心（打包核验的 102 个 entry 可见）。因此两个 tarball 可独立安装；插件仍需要 DSH Host 提供 `@deepseek-ai/*`。

### 2.2 0.1.0 版本同步（本次已执行）

| 文件 | 处理 | 状态 |
|---|---|---|
| `package.json` | `version` → `0.1.0` | ✅ |
| `packages/dsh-reflex/package.json` | `name` → `dsh-harness-reflex`；`version` → `0.1.0` | ✅ |
| `packages/dsh-reflex/src/panel-api.ts` | `REFLEX_PLUGIN_VERSION = '0.1.0'` | ✅ |
| `packages/dsh-reflex/cordis.patch.yml` | `name` → `'dsh-harness-reflex'`（`id` 保持 `dsh-reflex`） | ✅ |
| `packages/dsh-reflex/src/client-bundle.ts` | `CLIENT_BUNDLE_ID` 从 `package.json.name` 派生（DSH loader 按包名注册） | ✅ |
| `USER_GUIDE.md` / `docs/USER_GUIDE.en.md` | 版本、包名、工具面、安装命令、路由 | ✅ |
| `packages/dsh-reflex/README.md` / 根 `README.md` / `docs/dsh-plugin.md` | 同上 | ✅ |
| `src/release-packaging.test.ts` | 按 manifest 版本与包名断言产物 | ✅ |
| `package-lock.json` | `npm install` 重新生成，根版本 `0.1.0` | ✅ |
| `packages/dsh-reflex/client.js` | `npm run build:all` 重建（bundle id = `dsh-harness-reflex`） | ✅ |

注意：**不要用 `npm version` 一步到位**——它会自动创建 commit/tag，而 tag 属于负责人 gate。建议 `npm pkg set version=0.1.0`。

---

## 3. 打包与产物核验

### 3.1 构建

```bash
npm install
npm run build:all
```

`build:all` = 根包 `tsc` → 软链本机 DSH 依赖 → 插件 Host 半边 `tsc` → 内嵌中英指南 → 客户端 TypeScript + 单文件 `client.js`。发布树必须重新构建：`client.js` 当前未入库，`scripts/release-pack.mjs` 的第一项检查就是“构建比源码新”。

### 3.2 打包入口与产物

```bash
node scripts/release-pack.mjs            # 只打包 + 核验（需先 build:all）
npm run release:pack                     # 同上（package.json 脚本）
npm run release                          # test:all + test:mutation + release:pack（推荐发布闸门）
```

产物（`release/`）：

| 产物 | 说明 |
|---|---|
| `release/harness-reflex-<version>.tgz` | 根包：核心运行时、CLI、stdio MCP server、适配器、`dist/`、README、USER_GUIDE、`docs/`、`experiments/` 源码 |
| `release/dsh-harness-reflex-<version>.tgz` | DSH 插件 `dsh-harness-reflex`（npm pack 命名）：`dist/`、内联核心 `dist/vendor/**`、`client.js`、`cordis.patch.yml`、`locale/` |
| `release/SHA256SUMS` | 两个 tarball 的 SHA-256 |
| `release/release-report.json` | 逐项核验记录（含 entry 列表、sha256、冒烟结果） |
| `release/RELEASE-<version>.md` | 由脚本生成的发布说明（机器产物，不是 release notes 真源） |

### 3.3 27 项自检的构成

脚本输出为 `27/27 checks passed`，分五组：

1. **构建新鲜度 2 项**：根包 / 插件的构建产物必须比源码新；
2. **产物与版本 4 项**：两个 tarball 存在，文件名版本与 `package.json` 一致；
3. **结构审计 10 项**（每包 5 项）：无 `node_modules` / 临时目录 / 测试构建 / 绝对开发路径；必需文件齐全；零死链；无未声明运行时依赖；
4. **内容断言 4 项**：`experiments` 只发源码、`client.js` 为单文件且 >100 KB、根包与插件内的指南摘要与仓库当前文档一致；
5. **安装冒烟 7 项**：根包离线 `npm install`、`bin` 可执行、具名 import、stdio MCP `tools/list` 恰好 **8 个工具**；插件解包后可 `import` 并暴露 `apply()` 与文档承诺的检索 API。

`--skip-install` 只用于结构审计排障，**发布候选必须跑完整 27 项**。

### 3.4 本次实测记录（0.1.0）

| 文件 | entry 数 | 体积 |
|---|---:|---:|
| `harness-reflex-0.1.0.tgz` | 73 | 219 KiB |
| `dsh-harness-reflex-0.1.0.tgz` | 102 | 578 KiB |

（2026-10-21 在 `integration/v0.1.0` + 本次 0.1.0 改动上构建。）具体 sha256 由 `release-pack.mjs` 写入 `release/SHA256SUMS` 与 `release/release-report.json`；发布树重跑后以该文件为准。

**本手册不固化根包指纹**：根包 `files` 含 `docs/**/*.md`，本文档本身就在包内，任何文档编辑都会改变根包 sha256；0.1.0 的正式指纹只能在发布树打包后记录。同一构建树连续两次打包结果一致（本地字节可复现）；发布记录以发布树实测为准。

> 若从**目录**发布到 npm（不建议），registry 会重新打包，线上 sha256 与本地不同；应按成员集合与逐文件内容对账。若直发 tarball，则按本地 sha256 记录并在 registry 侧核对 `dist.integrity`。

---

## 4. 发布树与 tag 策略

### 4.1 现状

- 仓库当前**没有 tag**，`main` 停在 `96ee842`，集成分支 `integration/v0.1.0` 在 `9235039`（0.1.0 改动在其后）；
- 发布动作（合并、tag、push）**只由负责人执行**；执行 attempt 不建/不推 tag。

### 4.2 推荐策略

1. 把 `integration/v0.1.0` 合并到 `main`（`--no-ff`），合并提交即发布提交；
2. 在该提交上创建 annotated tag `v0.1.0`；
3. 从 **tag 的独立 worktree** 构建、测试、打包，确保“发布物 = tag 内容”；
4. tag 只创建一次；发现产物问题走 `0.1.1`，**不移动已推送的 tag**。

```bash
# 负责人执行
git checkout main
git merge --no-ff integration/v0.1.0
git tag -a v0.1.0 -m "harness-reflex / dsh-harness-reflex v0.1.0"
git push origin main
git push origin v0.1.0

# 发布树（只读 tag 内容）
git worktree add --detach .worktrees/release-v0.1.0 v0.1.0
ln -sfn "$PWD/node_modules" .worktrees/release-v0.1.0/node_modules
git -C .worktrees/release-v0.1.0 rev-parse HEAD         # 必须等于 v0.1.0^{commit}
git rev-parse 'v0.1.0^{tree}'
git -C .worktrees/release-v0.1.0 rev-parse 'HEAD^{tree}' # 两行必须相同
```

在发布树里执行：

```bash
cd .worktrees/release-v0.1.0
npm run build:all
npm run test:all
npm run test:mutation
node scripts/release-pack.mjs
sha256sum release/*.tgz
```

发布树用完即删（`git worktree remove .worktrees/release-v0.1.0`），不要在其中继续开发。

---

## 5. 发布渠道：registry 直发 vs tarball 直发

### 5.1 推荐：0.1.0 先走 tarball 直发

理由：

- 当前实测唯一完整跑通的安装路径是 `dsh plugin --profile <p> add --force <tarball>`；
- 插件已改名非 scoped 的 `dsh-harness-reflex`（B4 落地，registry 已确认 E404 可用）；
- npm 登录态为 E401（B5），没有可用的发布凭据；
- tarball 路径能保证“**被测产物 == 发布产物**”，sha256 可直接进 release notes。

发布方式：把 `release/harness-reflex-0.1.0.tgz`、`release/dsh-harness-reflex-0.1.0.tgz`、`release/SHA256SUMS` 作为 GitHub Release 附件；安装文档写 tarball 命令。

### 5.2 registry 发布（已就绪，待负责人 gate）

- 根包 `harness-reflex`：npm 查询 404，名字可用；受 B5 登录态限制。
- 插件包 `dsh-harness-reflex`：非 scoped 名已落地（`package.json`、`cordis.patch.yml`、安装命令、文档均已同步），registry 已确认 E404 可用。
  发布前由负责人再执行一次 `npm view dsh-harness-reflex` 复核；若已被占用，退回只发根包、插件继续 tarball 分发。
- 若发布，直发已验字节的 tarball（不要 `cd dist && npm publish`）；`dsh-harness-reflex` 与 `harness-reflex` 都是**非 scoped** 名，**不需要 `--access public`**：

```bash
npm publish ./release/dsh-harness-reflex-0.1.0.tgz
npm publish ./release/harness-reflex-0.1.0.tgz
npm view dsh-harness-reflex dist.integrity   # 与 release/SHA256SUMS 对账
```

- 若 `npm publish` 返回 `E403 Package name too similar`，按 §1.1 直接换名，不要重复重试。
- 登录 gate（本次未执行）：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/   # 必须打印用户名
```

---

## 6. 发布正文（release notes）真源与模板

**真源**：`docs/release-notes-v0.1.0.md`（入 git、随版本评审）。线上正文必须由该文件发布，不手改线上。

```bash
gh release create v0.1.0 -R miuzel/harness-reflex \
  release/harness-reflex-0.1.0.tgz release/dsh-harness-reflex-0.1.0.tgz release/SHA256SUMS \
  --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md
```

发布后核对正文与真源逐字一致（唯一可接受差异：平台对文末换行的归一化）：

```bash
diff <(gh release view v0.1.0 -R miuzel/harness-reflex --json body --jq .body) docs/release-notes-v0.1.0.md
```

**必需小节**（缺一视为不完整）：

1. `## v0.1.0 — <发布日期>` + ≤5 条要点；
2. `### 安装 / 升级`：tarball 命令、同版本必须 `--force`、是否需要手工迁移；
3. `### 验证与产物`：平台门禁（Linux/WSL2 实测、Windows/macOS 未验证）、两个 tarball 的文件名/字节数/sha256、`release-report.json` 的 27/27、清单链接、可复现性说明；
4. `### 已知限制`：registry 包名冲突、未建 remote/tag、商店未提交等，按发布时真实状态写。

---

## 7. 本地全新 profile 验收

用一个隔离的 `DSH_HOME`，避免污染正在使用的宿主实例。以下命令已在本仓库实测通过（0.1.0 tarball）：

```bash
export DSH_HOME="$PWD/tmp/dsh-pub-check"
rm -rf "$DSH_HOME" && mkdir -p "$DSH_HOME"

# 1) 装 tarball；同版本必须 --force
dsh plugin --profile web add --force "$PWD/release/dsh-harness-reflex-0.1.0.tgz"

# 2) profile 组合里出现插件（config: {} 为默认配置）
dsh --profile web --dump-config | grep -A2 -- '- id: dsh-reflex'

# 3) 启动隔离实例
dsh web --no-open --port 3987 &

# 4) 健康与面板
curl -s http://127.0.0.1:3987/dsh-reflex/api/health
# 期望：{"ok":true,"name":"dsh-reflex","version":"<version>"}
curl -s http://127.0.0.1:3987/dsh-reflex/api/panel | head -c 400
# 期望字段：plugin / routing / effort / interventions / tools / systemOne
# tools.active 默认 4 个：reflex_choice、reflex_score、reflex_screen、reflex_gate
# interventions.mode 默认 observe
```

通过判据：

- `dsh plugin --profile web add --force` 成功且依赖解析完成；
- `--dump-config` 出现 `id: dsh-reflex`；
- 健康端点返回插件名与版本；
- 面板快照可解析，`tools.active` 与配置一致；`systemOne.health` 对 `mock` 后端**可能缺省**（in-process 后端不产生网关健康值，缺省不是故障）；
- `/reflex-ledger` 在真实会话中可用（见第 8 节与清单人工项）；
- 会话内触发一次 >10 000 字符的工具输出，`active` 模式下能看到 `plugin:dsh-reflex/pruned-original#...` 定位符，并可在面板「决策账本」看到 prune 记录。

清理：`kill %1; rm -rf "$DSH_HOME"`。面板路由只答 loopback（127.0.0.1）或已配对设备，远程访问返回 403 属预期。

---

## 8. 宿主兼容性判定（三维度）

宿主兼容性不能只看“装上了、起得来”。本插件按以下三个维度判定，缺一不得称为兼容：

| # | 维度 | 最小验证 | 失败形态 |
|---|---|---|---|
| 1 | **工具面（DSH）** | 面板 `tools.active` 与开关一致：默认 4 个，打开 `route` 后 5 个；`prune`/`detect_stagnation`/`status_ledger` **不作为工具出现**；越权参数被 Host 拒绝 | 工具未注册、旧工具残留、模型调用 `reflex_prune` 得到“未知工具” |
| 2 | **MCP 面（stdio）** | 解包 tarball 后跑 `stdio MCP tools/list` 恰好 **8 个工具**（release-pack 冒烟已覆盖） | 工具少/多、握手失败、入口解析错 |
| 3 | **真机自动干预** | `active` 模式下真实会话触发四能力之一：剪枝出现原文定位符、停滞拒绝重复调用、失败证据改写、收尾门禁异议；`observe` 只记账不执行 | 钩子未挂、只 observe、拒绝不生效、台账缺记录 |

**当前判定**：

- 维度 1/2：在 dsh `0.2.1-rc.2` + 隔离 profile 上已验证（`tools.active` 4 个、MCP 8 个）；
- 维度 3：自动化测试覆盖四个能力与 `off`/`observe`/`active` 三态，**但本轮没有在真实会话的 `active` 模式手工验一次剪枝**；发布前必须补做（清单 §5），否则 0.1.0 只能声明“observe 已验证、active 待真机确认”。

**明确禁止的错误表述**：DSH 面**没有** `reflex_prune`、`reflex_detect_stagnation`、`reflex_status_ledger` 工具；剪枝/停滞/收尾是自动干预，账本是 `/reflex-ledger` 命令。两套表面：MCP 8 工具，DSH 5 个可开关工具（默认 4 个）。

---

## 9. 商店与 awesome-dsh-plugin 上架

前置：公开仓库已建、已打 `dsh-plugin` topic、`package.json` 声明 `dsh.bundle`（本仓库已具备）、commits ≥10 且仓库创建 ≥1 天（当前仓库未建，**不满足**）。

条目文件：`data/plugins/miuzel__harness-reflex.yml`。

```yaml
url: https://github.com/miuzel/harness-reflex
name: miuzel/harness-reflex
category: dev            # 按实际选 dev / tools / workflow
description:
  en: System One decision runtime for dsh — automatic pruning, stagnation, gate and closing checks.
  zh: 面向 dsh 的 System One 决策运行时，提供自动剪枝、停滞检测、门禁与收尾核验。
```

提交步骤与 dsh-graph 相同：fork → 新增 yml → `npm ci && node scripts/generate-readme.mjs` → 提交 yml 与重生成的 README → 开 PR。PR 自查：

- [ ] 一个 `data/plugins/<owner>__<repo>.yml`；
- [ ] 已跑 README 生成脚本并提交；
- [ ] repo 的 `package.json` 有 `dsh.bundle`（本仓库 `dsh.bundle.patch` 已具备）；
- [ ] 仓库 ≥1 天、commits ≥10；
- [ ] category 合法、描述只讲功能；
- [ ] 仓库已打 `dsh-plugin` topic；
- [ ] 建议附截图（`data/screenshots.json`）。

**当前状态**：未提交。registry 发布不是上架的硬前提，但商店通常更偏好可 `npm install` 的包；若 B4 未解决，PR 需在描述中说明 tarball 安装方式，并接受维护者可能要求先解决包名问题。

---

## 10. 回滚策略

发布前先证明回滚路径可用：

1. **保留上一版**：上一版 `release/dsh-reflex-0.1.0-alpha.2.tgz` 与对应 sha256 不要删。注意 `release-pack.mjs` 每次运行都会**清空 `release/`**，所以必须在打 0.1.0 包之前把上一版 tarball 复制到 `tmp/release-archive/`（或仓库外的归档目录）；
2. **回滚安装**：

   ```bash
   dsh plugin --profile <p> add --force ./release/dsh-reflex-0.1.0-alpha.2.tgz
   # 重启 dsh 后核对
   curl -s http://127.0.0.1:<port>/dsh-reflex/api/health
   ```

3. **registry 已发布时**：优先发 `0.1.1` 修复；撤销用 `npm deprecate <pkg>@0.1.0 "reason"`，必要时调整 `dist-tag`；不要依赖 `npm unpublish`；
4. **tag 已推送**：不删除、不移动 tag；用补丁版本修正；
5. **数据面**：本插件无数据库迁移；账本 JSONL 只追加，回滚不会破坏旧记录；配置校验是 schema 路径校验，回滚后未知字段会被拒绝而不是静默忽略，必要时恢复上一份配置备份；
6. **回滚演练**：在发布前用隔离 `DSH_HOME` 从 0.1.0 退回上一版，并确认面板版本号与工具面恢复。

---

## 11. 总 checklist（详细命令见 0.1.0 清单）

- [ ] 版本号同步（根包、插件、常量、文档、测试引用、lock）
- [ ] `npm run build:all` 通过
- [ ] `npm test` / `npm run test:plugin` / `npm run test:mutation` 全绿
- [ ] `node scripts/release-pack.mjs` → 27/27
- [ ] 记录两个 tarball 的字节数、entry 数、sha256
- [ ] 发布树与 `v0.1.0` tag tree 相同
- [ ] 全新 profile 安装 / 启动 / 面板健康检查
- [ ] `/reflex-ledger` 与 14.5K 剪枝真机核验（active）
- [ ] 渠道决策（tarball 直发；registry 仅当 B4/B5 关闭）
- [ ] GitHub Release 正文来自 `docs/release-notes-v0.1.0.md`
- [ ] 回滚路径演练
- [ ] awesome-dsh-plugin PR（或明确本版不做）

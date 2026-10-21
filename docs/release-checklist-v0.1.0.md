# Harness Reflex 0.1.0 发布检查清单

> 配套手册： [`release-handbook.md`](release-handbook.md)。
> 用法：在仓库根逐节执行；`V=0.1.0`。标注 **[自动可验]** 的项有命令和机器判据；**[人工 gate]** 的项必须由负责人确认，不能由执行代理代替。
> 状态：**代码面已收口**（版本/改名/文档/打包自检已执行，见 §1–§4 的已勾项）；**发布动作未执行**（tag/npm/GitHub/商店仍勾选为负责人 gate）。
> 事实基准：`integration/v0.1.0` @ `9235039` + 本次 0.1.0 改动，2026-10-21。

```bash
cd /path/to/harness-reflex       # 仓库根
V=0.1.0
```

---

## 1. 版本号与元数据

> 版本号与包名变更已由执行代理完成；**tag / 发布动作**仍属负责人 gate。

- [x] 根包与插件包版本同步：

  ```bash
  npm pkg set version="$V"
  (cd packages/dsh-reflex && npm pkg set version="$V")
  node -p "require('./package.json').version + ' / ' + require('./packages/dsh-reflex/package.json').version"
  # 期望：0.1.0 / 0.1.0
  ```

- [x] 版本常量与测试引用同步（执行记录）：

  - `packages/dsh-reflex/src/panel-api.ts` → `REFLEX_PLUGIN_VERSION = '0.1.0'`
  - `src/release-packaging.test.ts` 产物名改为按 manifest 版本动态生成（插件包为 `dsh-system-one-<version>.tgz`）
  - `packages/dsh-reflex/package.json` → `name: dsh-system-one`、`cordis.patch.yml` 的 `name` 同步（`id` 不变）
  - `USER_GUIDE.md`、`docs/USER_GUIDE.en.md`、`packages/dsh-reflex/README.md` 的当前版本声明
  - `package-lock.json`：`npm install --package-lock-only --ignore-scripts`

- [x] 当前版本引用不再有 alpha.2 残留（只查会随版本变化的文件，发布文档本身可保留历史引用）：

  ```bash
  grep -n "0\.1\.0-alpha\.2" \
    package.json packages/dsh-reflex/package.json \
    packages/dsh-reflex/src/panel-api.ts src/release-packaging.test.ts \
    USER_GUIDE.md docs/USER_GUIDE.en.md packages/dsh-reflex/README.md
  # 期望：无输出
  ```

  通过判据：上述文件无 alpha.2；`docs/dsh-plugin.md` 的历史章节、本发布文档中的历史引用不计入。

- [ ] 包名/渠道现状复核（**负责人人工 gate**）：

  ```bash
  npm view dsh-system-one version  # 期望 404（非 scoped 名可用）；若已存在则必须换名
  npm view harness-reflex version      # 期望 404（根包名可用）
  npm whoami                           # 期望打印用户名；E401 即未登录
  ```

  通过判据：负责人已复核插件包名并明确 0.1.0 的发布渠道（tarball 直发 / registry）。

---

## 2. 构建与测试 [自动可验]

- [ ] 构建：

  ```bash
  npm run build:all
  ```

  通过判据：exit 0；`packages/dsh-reflex/client.js` 生成且 >100 000 字节。

- [ ] 根包测试：

  ```bash
  npm test
  ```

  通过判据：`fail 0`。当前基线：113 pass / 0 fail。

- [ ] 插件测试：

  ```bash
  npm run test:plugin
  ```

  通过判据：`fail 0`。当前基线：419 pass / 0 fail。

- [ ] 负向对照：

  ```bash
  npm run test:mutation
  ```

  通过判据：出现 `negative control OK: 51/51 injected faults were caught`（当前基线 50 测试 + 1 编译器）。版本变更后数字可变，但不得出现未捕获故障。

> 发布前打包会先检查“构建比源码新”。任何测试/构建之后的源码改动都必须重新 `npm run build:all`。

---

## 3. 打包与产物核验 [自动可验 + 人工记录]

- [ ] 归档上一版 tarball（`release-pack.mjs` 会清空 `release/`）：

  ```bash
  mkdir -p tmp/release-archive
  cp -a release/harness-reflex-0.1.0-alpha.2.tgz release/dsh-reflex-0.1.0-alpha.2.tgz \
        release/SHA256SUMS tmp/release-archive/ 2>/dev/null || true
  # 0.1.0 的插件产物名是 dsh-system-one-0.1.0.tgz
  (cd tmp/release-archive && sha256sum -c SHA256SUMS 2>/dev/null || true)
  ```

  通过判据：上一版 tarball 已存在于 `tmp/release-archive/`，作为回滚素材。

- [ ] 打包并跑 27 项自检：

  ```bash
  node scripts/release-pack.mjs
  ```

  通过判据：末行 `release-pack: 27/27 checks passed`，且 exit 0。

- [ ] 机器报告复核：

  ```bash
  node -e "const r=require('./release/release-report.json');\
    if(r.checks.length!==27) throw new Error('checks '+r.checks.length);\
    if(r.failures.length) throw new Error(r.failures.join(';'));\
    console.log('version',r.version,'artifacts',r.artifacts.map(a=>a.file+':'+a.entries).join(','))"
  ```

  通过判据：`checks=27`、`failures=[]`、`version=0.1.0`。

- [ ] 指纹与成员数记录：

  ```bash
  sha256sum release/*.tgz
  (cd release && sha256sum -c SHA256SUMS)
  tar -tzf release/harness-reflex-$V.tgz | wc -l
  tar -tzf release/dsh-system-one-$V.tgz | wc -l
  ```

  通过判据：`sha256sum -c` 两行 OK；把两个字节数、entry 数、sha256 抄进 release notes 与发布记录。**alpha.2 的旧指纹不得复用**。

---

## 4. 全新 profile 安装与启动 [自动可验]

```bash
export DSH_HOME="$PWD/tmp/dsh-pub-check"
rm -rf "$DSH_HOME" && mkdir -p "$DSH_HOME"
```

- [ ] 用 tarball 安装（同版本必须 `--force`）：

  ```bash
  dsh plugin --profile web add --force "$PWD/release/dsh-system-one-$V.tgz"
  ```

  通过判据：pnpm 安装成功；`dsh plugin` 输出 `+ dsh-system-one 0.1.0`（或等价的 file: 链接）。

- [ ] 组合树里出现插件：

  ```bash
  dsh --profile web --dump-config | grep -A2 -- '- id: dsh-reflex'
  ```

  通过判据：输出 `id: dsh-reflex` 且 `config` 节点存在。

- [ ] 启动隔离实例并核验健康/面板：

  ```bash
  dsh web --no-open --port 3987 & WEB_PID=$!
  sleep 6
  curl -s http://127.0.0.1:3987/dsh-reflex/api/health; echo
  curl -s http://127.0.0.1:3987/dsh-reflex/api/panel | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s);
      if(j.plugin.version!=="0.1.0") throw new Error("version "+j.plugin.version);
      if(!j.tools.active.includes("reflex_gate")) throw new Error("gate missing");
      if(j.tools.active.includes("reflex_prune")) throw new Error("reflex_prune must not be a DSH tool");
      if(!j.interventions || !j.systemOne) throw new Error("projection missing");
      console.log("panel ok:", j.plugin.version, j.tools.active.join(","), j.interventions.mode);
    })'
  kill $WEB_PID
  ```

  通过判据：

  - health 返回 `{"ok":true,"name":"dsh-reflex","version":"0.1.0"}`；
  - panel 解析通过，`tools.active` 默认含 `reflex_choice`、`reflex_score`、`reflex_screen`、`reflex_gate`，**不含** `reflex_prune`；
  - `interventions.mode` 为 `observe`（默认）；
  - `systemOne.active` 为 `mock-heuristic-v1`（无环境变量时）；`systemOne.health` 对 mock 缺省属正常。

- [ ] MCP 面仍是 8 工具：

  ```bash
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
    | SYSTEM_ONE_BACKEND=mock node dist/cli/index.js mcp 2>/dev/null \
    | tail -1 \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const t=JSON.parse(s).result.tools.map(x=>x.name).sort();
        if(t.length!==8) throw new Error("expected 8 tools, got "+t.length);
        console.log(t.join(","));
      })'
  ```

  通过判据：输出 8 个 `reflex_*` 工具：`reflex_choice`、`reflex_score`、`reflex_route`、`reflex_screen`、`reflex_gate`、`reflex_prune`、`reflex_detect_stagnation`、`reflex_status_ledger`。

---

## 5. 命令与真机自动干预 [人工 gate]

- [ ] `/reflex-ledger` 命令：

  在隔离 profile 的 web/TUI 会话里输入 `/reflex-ledger`。
  通过判据：Host 直接渲染账本汇总文本（总调用数、类型分布、时延、节省 token、门禁/停滞、最近 5 条）；账本为空时显示“暂无记录”而不是一排 0；**不产生工具调用、不发起模型回合**。

- [ ] 14.5K 剪枝真机验证（active 模式）：

  1. 在设置面板「Reflex → 自动干预」把 `mode` 设为 `active` 并保存（或按 profile patch 语法覆盖 `interventions.mode`）；
  2. 在会话里让 Agent 执行一条产生约 14.5K 字符的命令，例如：

     ```bash
     node -e "console.log(Array.from({length:205},(_,i)=>'progress '+i+' '+'.'.repeat(60)).join('\n'))"
     ```

  3. 检查会话：工具结果被改写且含 `plugin:dsh-reflex/pruned-original#<digest>` 定位符；面板「决策账本」出现 `prune` 记录，`applied=true`，`actualSavedTokens>0`。

  通过判据：出现定位符；可用 `readPrunedOriginal()` 按定位符读回逐字节原文；同一载荷重复出现时复用第一次的原件。若只看到 `observe` 的账本而无改写，说明 `mode` 未生效，**不得**判定通过。

- [ ] 四能力冒烟（active 模式，至少各一次）：

  | 能力 | 触发 | 通过判据 |
  |---|---|---|
  | stagnation | 连续重复同一调用 ≥ `repeatThreshold` | 第三次被拒绝并给出纠正，而非原样执行 |
  | prune | 上述 14.5K 输出 | 结果被替换且可定位原文 |
  | gate | 连续失败调用达阈值 | 结果被改写为纠正反馈 |
  | closing | 回合收尾声明与证据冲突 | 收到一次异议/纠正，而非静默通过 |

- [ ] 平台记录：Linux/WSL2 已实测；原生 Windows / macOS **本版未验证**（勾选此项表示已在 release notes 如实标注）。

---

## 6. 发布动作 [人工 gate]

- [ ] 合并与 tag（负责人）：

  ```bash
  git checkout main
  git merge --no-ff integration/v0.1.0
  git tag -a v0.1.0 -m "harness-reflex / dsh-system-one v0.1.0"
  git push origin main && git push origin v0.1.0
  ```

- [ ] 发布树与 tag 内容一致：

  ```bash
  git worktree add --detach .worktrees/release-v0.1.0 v0.1.0
  ln -sfn "$PWD/node_modules" .worktrees/release-v0.1.0/node_modules
  [ "$(git rev-parse 'v0.1.0^{tree}')" = "$(git -C .worktrees/release-v0.1.0 rev-parse 'HEAD^{tree}')" ]
  (cd .worktrees/release-v0.1.0 && npm run build:all && node scripts/release-pack.mjs)
  ```

  通过判据：tree 相等；发布树内 27/27 通过；记录发布树产物的 sha256。

- [ ] GitHub Release（正文真源 `docs/release-notes-v0.1.0.md`）：

  ```bash
  gh release create v0.1.0 -R miuzel/harness-reflex \
    release/harness-reflex-0.1.0.tgz release/dsh-system-one-0.1.0.tgz release/SHA256SUMS \
    --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md
  diff <(gh release view v0.1.0 -R miuzel/harness-reflex --json body --jq .body) \
       docs/release-notes-v0.1.0.md
  ```

  通过判据：release 创建成功；正文与真源逐字一致（仅末尾换行归一化）。

- [ ] registry（仅当 B4/B5 已关闭，**负责人 gate**）：`npm login` → `npm whoami` 打印用户名 → 发布 `harness-reflex` 与 `dsh-system-one` 的已验 tarball → `npm view <pkg> version` 与 `dist.integrity` 对账。未关闭则**明确记录“本版不发布到 registry”**，不得含糊。

- [ ] awesome-dsh-plugin PR：按手册 §9 提交 `data/plugins/miuzel__harness-reflex.yml` 与重生成的 README；通过判据：PR 模板清单全部勾选，CI（仓库年龄/commits）通过。

---

## 7. 回滚演练 [人工 gate]

- [ ] 用归档的上一版 tarball 回退：

  ```bash
  dsh plugin --profile web add --force "$PWD/tmp/release-archive/dsh-reflex-0.1.0-alpha.2.tgz"
  dsh web --no-open --port 3988 & RPID=$!
  sleep 6
  curl -s http://127.0.0.1:3988/dsh-reflex/api/health; echo
  kill $RPID
  ```

  通过判据：health 返回 `0.1.0-alpha.2`，面板可打开；随后可再 `--force` 装回 0.1.0。

- [ ] 回滚成本留档：账本 JSONL 只追加、无 schema 迁移；tag 已推送则不移动，修复走 `0.1.1`；registry 已发布则用 `npm deprecate` + 补丁版本，不依赖 unpublish。

---

## 8. 收尾

- [ ] 清理隔离环境：`rm -rf "$DSH_HOME" .worktrees/release-v0.1.0`
- [ ] 把本次实测的 tarball 字节数、entry 数、sha256、测试计数写进 `docs/release-notes-v0.1.0.md` 的「验证与产物」。
- [ ] 发布记录归档：`release/release-report.json`、`release/SHA256SUMS`、`release/RELEASE-0.1.0.md` 随 release 附件或 CI 产物保存。

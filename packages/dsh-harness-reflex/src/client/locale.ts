/**
 * Bilingual copy of the Reflex settings page.
 *
 * The page is registered with `locale: NS` and a `label: () => t('nav')`, so the
 * settings shell renders the navigation entry in the user's own language; every
 * string the page itself draws comes from here through the same `t`.
 *
 * @module dsh-reflex/client/locale
 */
import { GUIDE_DIGESTS, GUIDE_EN, GUIDE_SOURCES, GUIDE_ZH } from './guide.generated';

/** Dictionary namespace owned by the browser half of this plugin. */
export const NS = 'dsh-reflex.panel';

/** Chinese copy. */
export const zh = {
  nav: 'Reflex 决策运行时',
  title: 'Reflex · System One 决策运行时',
  subtitle: '虚拟模型池、自适应推理强度、System 1 后端与决策账本',
  systemOneDegraded:
    'System One 后端不可用（{reason}），决策已降级为本地压缩与确定性兜底；恢复后本提示自动消失。',
  systemOneDegradedUnknown: '未知原因',
  tabOverview: '概览',
  tabRouting: '虚拟 Provider',
  tabEffort: '推理强度',
  tabBackend: 'System 1 后端',
  tabInterventions: '自动干预',
  tabTools: '工具开关',
  tabLedger: '决策账本',
  tabGuide: '使用说明',

  stateLoading: '正在读取 Host 配置…',
  stateUnavailable: '当前 Host 未注册 reflex 配置命名空间，页面只显示只读状态。',
  stateError: '读取失败',
  stateNotServed: '未找到 reflex 命名空间（请确认 Host 半已加载并注册了配置项）。',
  readOnly: 'Host 配置文档为只读，写操作已禁用。',

  groupRouting: '虚拟 Provider 与模型池',
  groupEffort: '自适应推理强度',
  groupBackend: '决策后端连接',
  groupRuntime: '运行时',
  groupInterventions: '自动干预（三态与预算）',
  groupTools: '工具单项开关',
  groupDelegation: '子代理委派（宿主能力）',
  delegationIntro:
    '`reflex_delegate` 不是本插件自给自足的工具：它把任务交给宿主的 `subagent` 工具，并把 System One 判定的思考档位一起传过去。宿主只有在 `tool-subagent` 的 `modelSelection` 开启时才会发布 `reasoning_effort` 参数，所以这个开关默认关闭——不是忘了开，而是它需要先动一个不属于本插件的文件。',
  // Deliberately without the exact token `reflex_delegate`: the tools page labels
  // its switches by registered name, and two fields whose labels both contain
  // that name would be ambiguous to anyone (and to the page test) looking a
  // switch up by label.
  labelDelegationEnabled: '启用子代理委派（宿主能力开关）',
  helpDelegationEnabled:
    '用途：允许 reflex_delegate 注册，并同意把宿主的 modelSelection 开关写进 profile patch；格式：布尔开关；默认：关闭；范围：勾选＝明确同意开启宿主 modelSelection（否则思考档位传不进子代理），取消勾选＝停止委派，运行时不会自动帮你改回来。',
  delegationConsent:
    '勾选即明确同意：本插件会把 `tool-subagent` 的 `modelSelection: true` 写入宿主的 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）。只新增这一项，你原有的 patch 内容（模型、密钥、注释、`!!js` 表达式）逐字节保留，写入前会先备份一份 `.bak-dsh-reflex-*`。',
  delegationRowState: '宿主当前状态',
  delegationRowPatch: '宿主的 patch 文件',
  delegationRowPatchState: 'patch 中是否已要求开启',
  delegationRowRegistered: 'reflex_delegate 是否已注册',
  delegationStateReady: '已开启，档位可以传进子代理',
  delegationStateOff: '未开启：宿主委派工具没有 reasoning_effort 参数',
  delegationStateNoTool: '当前宿主没有委派工具，无从包装',
  // Distinct from `effectiveUnknown` on purpose: both mean "not read yet", but
  // they sit on different cards, and a sentence shared by two cards cannot be
  // used to assert that *this* card read its fact.
  delegationStateUnknown: '尚未探测：读不到 agent 作用域，不能据此判断开或关',
  delegationPatchUnknown: '未解析到 profile patch 路径',
  delegationPatchOn: '已要求开启',
  delegationPatchOff: '尚未要求开启',
  delegationOn: '已注册',
  delegationOff: '未注册',
  delegationRestartRequired:
    '已保存，重启 DSH 后生效：宿主的 `tool-subagent` 配置是启动时读取的，热更新只对本插件自己的 fiber 有效。在你重启之前，reflex_delegate 会保持未注册。文件：',
  delegationSavedRestart: '已保存，重启 DSH 后生效。',
  delegationSavedNoRestart: 'patch 已是所需状态，无需再写入。',
  delegationWriteRefused: '同意已记录，但宿主 patch 未写入成功：',
  delegationRevokeHint:
    '想撤销：取消勾选这个开关即可停止委派；若要连宿主开关一起去掉，删掉 patch 里 `tool-subagent` 下那行 `modelSelection: true`（或本插件新增的那一整条）。本插件不会替你改回来。',
  labelEnabled: '启用虚拟 Provider',
  labelVirtualProvider: '虚拟 Provider 名称',
  labelFallback: '兜底目标（provider:model）',
  labelMaxTaskChars: '任务文本预算（字符）',
  labelPools: '模型池',
  poolEmpty: '尚未配置任何虚拟模型。',
  poolModelId: '虚拟模型 ID',
  poolEntryProvider: '物理 Provider',
  poolEntryModel: '物理模型',
  poolEntryDescription: '能力说明',
  poolEntryTags: '标签（逗号分隔）',
  poolAddModel: '新增虚拟模型',
  poolAddEntry: '新增候选',
  poolRemoveModel: '删除该模型',
  poolRemoveEntry: '删除候选',
  poolMoveUp: '上移',
  poolMoveDown: '下移',
  poolCandidates: '候选',

  labelEffortSetting: '推理强度策略',
  labelEffortFallback: '兜底档位',
  labelEffortMinConfidence: '最小置信度',
  labelEffortEnabled: '启用自适应推理强度',
  effortDisabledHint: '关闭后不做自适应判定，也不注入 reflex 档位；调用方显式选择的具体档位原样下发。',
  effortUnset: '不干预',
  effortAdaptive: 'Reflex（自适应）',
  effortHint: '留空＝不干预；选择 Reflex＝每轮自适应。',
  effortLatest: '最近一次自适应决策',
  effortNoDecision: '本次激活尚未产生自适应决策。',
  effortDecisions: '自适应决策数',

  interventionsHint: 'off 完全不介入，observe 只检测并记录，active 才真正执行干预；能力项可选「继承主模式」。默认 observe。',
  labelInterventionMode: '主模式',
  interventionModeHint: '默认 observe：先观察记录，确认无误后再切到 active。',
  labelCapabilityStagnation: '停滞豁免',
  labelCapabilityPrune: '结果裁剪',
  labelCapabilityGate: '失败门禁',
  labelCapabilityClosing: '收尾异议',
  labelMaxInterventionsPerTurn: '每轮最大干预数',
  labelMaxJudgmentsPerTurn: '每轮最大判定数',
  labelMaxJudgmentsPerSession: '每会话最大判定数',
  labelRepeatThreshold: '重复阈值',
  labelFailureThreshold: '失败阈值',
  labelWindowSize: '窗口大小',
  labelInterventionMinConfidence: '最小置信度',
  labelPruneFloorRatio: '裁剪保留下限比例',
  labelPruneHeadChars: '裁剪保留头部字符数',
  labelPruneTailChars: '裁剪保留尾部字符数',
  labelPruneIntent: '裁剪判定意图',
  labelPruneJudgeMinChars: '逐段判定最小字符数',
  labelClaimMinConfidence: '完成声明置信度门槛',
  labelClosingEvidenceChars: '收尾证据字符预算',

  // (?) 就地提示：每条都写成「用途 / 格式 / 默认 / 留空或范围」四段，
  // field-guidance 测试会按段解析，并用 resolveConfig 实算的默认值对拍。
  helpAbout: '关于「{field}」的说明',
  helpSwitchOn: '开启',
  helpSwitchOff: '关闭',
  helpRoutingEnabled:
    '用途：决定是否安装 reflex 虚拟 Provider 接管模型路由；格式：布尔开关；默认：开启；留空：未写时按开启处理，关闭后模型调用直连物理 Provider。',
  helpVirtualProvider:
    '用途：虚拟 Provider 对外暴露的名字，模型池路由挂在它名下；格式：非空字符串，不能包含冒号；默认：reflex；范围：留空取默认，为空或含冒号会被配置校验拒绝。',
  helpFallback:
    '用途：所有候选池都无法回答时使用的物理兜底目标；格式：provider:model，例如 deepseek-official:deepseek-flash；默认：未设置；留空：不启用兜底、路由失败即失败关闭，且不能指回虚拟 Provider 自身。',
  helpMaxTaskChars:
    '用途：交给 System One 判定的任务文本长度上限；格式：正整数（字符数）；默认：400；范围：必须大于 0，超长文本会先截断再判定。',
  helpEffortEnabled:
    '用途：是否允许按轮自适应决定推理强度；格式：布尔开关；默认：开启；留空：未写时按开启处理，关闭后本层不生效，调用方显式选择的具体档位仍原样下发。',
  helpEffortSetting:
    '用途：决定是否启用自适应推理强度；格式：留空或 Reflex（自适应）；默认：不干预；留空：插件完全不改写 reasoningEffort，行为与未安装该功能一致，模型选择器里由插件注入的「Reflex (Auto)」档位仍可主动选中；选择 Reflex：每轮按 System 1 判定并下发；范围：想固定思考深度请在模型选择器里选择具体档位，可选项取决于目标模型声明的档位集合（例如 minimal、max 仅在模型声明后可选）。',
  helpEffortFallback:
    '用途：System One 与线索分类器都没有证据时使用的兜底档位；格式：一个自适应档位；默认：medium；范围：必须是已提供的自适应档位之一，留空按默认处理。',
  helpEffortMinConfidence:
    '用途：System One 的置信度达到多少才压过线索分类器；格式：小数；默认：0.3；范围：0~1，越界会被拒绝。',
  helpBackend:
    '用途：选择决策后端实现；格式：auto / mock / jev / vllm 之一；默认：auto；留空：按 auto 处理，由环境自动挑选可用后端。',
  helpBaseUrl:
    '用途：System One 网关或 OpenAI 兼容 logits 端点的地址；格式：http(s) URL；默认：未设置；留空：使用环境变量或后端内置默认地址（jev 为 https://api.typesafe.ai/v1/systemone，simple-jev 为 http://localhost:8000）。',
  helpModel:
    '用途：后端请求使用的模型 ID；格式：非空字符串；默认：未设置；留空：使用环境变量或后端内置默认模型（jev 为 jev-latest，simple-jev 为 Qwen/Qwen2.5-7B-Instruct）。',
  helpApiKeyEnv:
    '用途：存放 API Key 的环境变量名（不是密钥本身）；格式：大写环境变量名，例如 JEV_API_KEY；默认：未设置；留空：由后端按 SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY 依次兜底，密钥永远不会写进设置文档。',
  helpTimeoutMs:
    '用途：单次后端请求的超时时间；格式：毫秒整数；默认：未设置；留空：使用后端默认超时（jev 10000 ms、simple-jev 8000 ms），小于 100 会被拒绝。',
  helpToolPrefix:
    '用途：所有 reflex_* 工具注册名的前缀；格式：小写字母、数字与下划线；默认：reflex_；留空：按默认前缀注册，空字符串会被拒绝。',
  helpPruneThreshold:
    '用途：单个工具结果超过多少字符才触发裁剪；格式：非负整数（字符数）；默认：500；范围：小于 0 会被拒绝，0 表示不设阈值。',
  helpLedgerPath:
    '用途：决策账本 JSONL 的落盘路径；格式：相对或绝对路径；默认：未设置；留空：只保留在内存，进程退出即丢失。',
  helpCalibrationPath:
    '用途：应用到 choice 置信度上的离线校准曲线文件；格式：相对或绝对 JSON 路径；默认：未设置；留空：不做离线校准，直接使用原始置信度。',
  helpInterventionMode:
    '用途：自动干预的总开关语义；格式：off / observe / active 之一；默认：observe；留空：按 observe 处理，只检测并记录、不真正干预。',
  helpMaxInterventionsPerTurn:
    '用途：每轮最多执行多少次干预；格式：非负整数；默认：3；留空：按默认处理，0 表示本轮不执行干预。',
  helpMaxJudgmentsPerTurn:
    '用途：每轮最多做多少次 System One 判定；格式：非负整数；默认：3；留空：按默认处理。',
  helpMaxJudgmentsPerSession:
    '用途：整个会话最多做多少次 System One 判定；格式：非负整数；默认：20；留空：按默认处理。',
  helpRepeatThreshold:
    '用途：同一工具调用重复多少次才判定为停滞；格式：整数；默认：3；范围：最小 2，小于 2 会被拒绝。',
  helpFailureThreshold:
    '用途：连续失败多少次才触发失败门禁；格式：整数；默认：3；范围：最小 2，小于 2 会被拒绝。',
  helpInterventionMinConfidence:
    '用途：干预判定需要的最低置信度；格式：小数；默认：0.6；范围：0~1，越界会被拒绝（注意与推理强度组的 0.3 不同）。',
  helpWindowSize:
    '用途：判定重复/停滞时回看的历史窗口大小；格式：整数；默认：6；范围：最小 3，小于 3 会被拒绝。',
  helpPruneFloorRatio:
    '用途：裁剪后至少要保留原结果的比例；格式：0~1 的小数；默认：0.5；范围：越界会被拒绝。',
  helpPruneHeadChars:
    '用途：裁剪时固定保留的结果头部字符数；格式：非负整数；默认：400；留空：按默认处理，0 表示不保留头部。',
  helpPruneTailChars:
    '用途：裁剪时固定保留的结果尾部字符数；格式：非负整数；默认：400；留空：按默认处理，0 表示不保留尾部。',
  helpPruneIntent:
    '用途：交给裁剪判定判断哪些内容值得保留的意图描述；格式：自然语言短句；默认：extract diagnostics, relevant results and errors；留空：按默认意图处理。',
  helpPruneJudgeMinChars:
    '用途：工具结果达到多少字符才启用逐段 System One 判定；格式：整数（字符数）；默认：10000；范围：不得小于 pruneThreshold，倒挂会被配置校验拒绝。',
  helpClaimMinConfidence:
    '用途：完成声明语义判定的置信度门槛，低于它的句子不会进入收尾验证；格式：0~1 的小数；默认：0.5；范围：0~1，留空则按 Host 默认 0.5。',
  helpClosingEvidenceChars:
    '用途：交给收尾判定的证据总字符预算，超出按「诊断行 > 尾摘要 > 其余」优先级截断并记录 truncatedChars；格式：整数（字符数）；默认：2400；范围：最小 200，留空则按 Host 默认。',
  helpCapability:
    '用途：控制「{name}」这一路自动干预是否执行；格式：off / observe / active / inherit；默认：inherit；范围：留空即继承主模式（当前 {mode}），显式三态会覆盖主模式。',
  helpToolSwitch:
    '用途：{what}；格式：布尔开关（开启/关闭）；默认：{default}；留空：未写时按默认处理，关闭即从工具注册表下线，模型看不到该工具。',
  interventionsEffective: '当前生效（只读）',
  effectiveActing: '执行状态',
  effectiveUnknown: '尚未读取到运行时状态。',
  modeOff: '关闭（off）',
  modeObserve: '观察（observe）',
  modeActive: '执行（active）',
  modeInherit: '继承主模式',

  toolsHint:
    '按工具后缀开关（choice、score、route…）：关闭即从工具注册表下线，模型看不到该工具；开关与工具名前缀无关，改前缀不影响。默认开启 choice、score、screen、gate 四项，route 默认关闭，需要时再打开。',
  toolsEffective: '当前已注册（只读）',
  toolsAllClosed: '本插件当前未注册任何工具。',
  toolsApplyRecommended: '应用推荐组合',
  toolsRecommendedHint:
    '按下述建议填好 5 项：choice、score、screen、gate 开启，route 关闭（即默认组合）。这只是预填，仍需点“保存”才写回；与默认一致时不产生写入。',
  toolAdviceExpose: '建议暴露',
  toolAdviceOptional: '按需开启',
  toolsLedgerHint: '账本（调用数、时延、节省 token、门禁与停滞告警）不占用工具位：直接用 /reflex-ledger 命令，或看本面板的“账本”页。',

  toolWhat_choice: '在若干候选之间做一次快速概率选择，直接返回概率分布，不消耗生成 token。',
  toolWhen_choice: '需要在多个方案、分类或是否二选一里挑一个，又不想花生成 token 推理时（选架构、选分类、选 yes/no）。',
  toolWhat_score: '按给定标准给一段文本或代码打 0–1 的连续分。',
  toolWhen_score: '需要连续评分（质量、对齐度、置信度）而不是二选一时。',
  toolWhat_route: '按目标给候选工具、技能或方案做概率排序。',
  toolWhen_route: '候选很多、需要先缩小范围再动手时；属可选增强，默认关闭，需要时手动打开，不影响主流程。',
  toolWhat_screen: '检测不可信内容里的提示注入与指令覆盖。',
  toolWhen_screen: '读到网页、外部 PR 评论、第三方日志等不可信输入之后，先筛一遍再当作数据处理。',
  toolWhat_gate: '用真实输出与证据逐条核对断言，给出通过、矛盾或需升级的判定。',
  toolWhen_gate: '准备宣布完成或关闭任务之前，逐条核对验收判据与真实输出。',
  toolWhat_delegate: '把任务派给子代理，并由 System One 判定它该用多深的思考；权限、预设与递归限制仍由宿主的委派工具执行。',
  toolWhen_delegate: '要把一段自成一体的工作交给子代理、而合适思考档位并不明显时。它刻意没有思考档位参数，想精确指定请直接调用宿主的委派工具；本工具仅在宿主委派工具声明了 reasoning_effort（modelSelection 已开启）时才会注册。',

  labelBackend: '后端实现',
  labelBaseUrl: 'Base URL',
  labelModel: '模型 ID',
  labelApiKeyEnv: 'API Key 环境变量名',
  labelTimeoutMs: '超时（毫秒）',
  backendHint: '可填环境变量名，或在上方连接配置里直接保存 API Key（只写不读）。',
  backendFlatFoldRole: '兼容区：新配置请用上方连接配置',
  backendHintFlat:
    '兼容区：新连接请用上方「连接配置（可多套）」，这里只作为它未覆盖字段时的兜底。点标题可展开编辑。',
  backendFlatFoldedSummary: '已折叠（新配置请用上方连接配置）',
  backendActive: '当前生效实现',
  // Key readiness reports *where* the key came from, in four distinct states
  // (g-059): stored literal / the one named variable / named-but-empty (locked) /
  // a fallback variable that answered because nothing was named. Locking and
  // "nothing configured" must never share copy: they call for different fixes.
  apiKeyFromProfile: '密钥来自配置（只写，不回显）',
  apiKeyFromEnv: '密钥来自 {name}',
  apiKeyFromFallback: '密钥来自 {name}（回退：未指定变量名）',
  apiKeyMissing: '未配置密钥（未指定变量名；检查 SYSTEM_ONE_API_KEY / JEV_API_KEY / VLLM_API_KEY / OPENAI_API_KEY）',
  apiKeyLockedNamed:
    '已点名 {name}，但该变量未设置——密钥为空（点名即锁定，不会回退到 SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY）',
  profilesTitle: '连接配置（可多套）',
  profilesHint: '每套配置一个连接；选一套为当前激活。API Key 只写不读：保存后立即写入设置文档，页面只显示占位符。',
  profilesEmpty: '还没有连接配置。新增一套即可填写 baseURL、模型与 API Key。',
  profileActive: '已激活',
  profileInactive: '未激活',
  profileActivate: '设为激活',
  profileRemove: '删除',
  profileAdd: '新增配置',
  profileName: '配置名',
  profileKeyPlaceholder: '粘贴 API Key（留空表示不改动）',
  profileKeyStored: '已保存（只写，不回显）',
  profileKeyFromEnv: '来自环境变量 {name}',
  profileKeyFromFallback: '来自环境变量 {name}（回退：本配置未指定变量名）',
  profileKeyMissing: '未设置密钥（未指定变量名；检查 SYSTEM_ONE_API_KEY / JEV_API_KEY / VLLM_API_KEY / OPENAI_API_KEY）',
  profileKeyLocked: '已点名 {name}，但该变量未设置——密钥为空（不会回退到其他变量）',
  profileKeyPendingEnv: '保存后将从 {name} 读取（未保存）',
  profileKeyPendingLiteral: '保存后使用此密钥（未保存）',
  profileKeyMissingPending: '未配置密钥（保存后生效）',
  profileNeedName: '先填写配置名',
  profileNamePlaceholder: '（未命名）',
  profileUnnamedTag: '未命名',
  profileUnnamedHint: '这一行已填写内容，但还没有「配置名」：保存会整页被拦下，这一行也不会进入设置文档。请在行首标题处填写配置名。',
  profileNeedSave: '先保存再测试',
  profileWriteBlocked: '设置文档为只读，无法修改',
  profileRemoveRow: '只删除这一套配置',
  profileClearKey: '清除已存 Key',
  profileClearConfirm: '确认清除？',
  profileClearCancel: '取消清除',
  profileTest: '测试',
  profileTesting: '测试中…',
  profileTestOk: '连接正常',
  profileTestAuth: '密钥被拒绝',
  profileTestUnreachable: '无法连接',
  profileTestTimeout: '超时',
  profileTestBadResponse: '响应异常',
  profileTestMisconfigured: '配置不完整',
  profileLatency: '{ms} ms',
  activeProfileMissing: '激活的配置「{name}」不存在，当前使用扁平字段的回落配置。',

  labelToolPrefix: '工具名前缀',
  labelLedgerPath: '账本 JSONL 路径',
  labelPruneThreshold: '裁剪阈值（字符）',
  labelCalibrationPath: '校准曲线路径',
  unset: '未设置',

  ledgerTotal: '决策总数',
  ledgerTokens: '节省 token',
  ledgerCost: '估算节省成本',
  ledgerLatency: '平均时延',
  ledgerGates: '门禁通过 / 失败',
  ledgerStagnation: '停滞告警',
  ledgerRouting: '路由决策',
  ledgerRecent: '最近决策',
  ledgerEmpty: '账本为空。',
  ledgerLogPath: '落盘路径',
  ledgerMemoryOnly: '仅内存（未配置 JSONL 路径）',
  ledgerClear: '清空账本',
  ledgerClearConfirm: '再次点击确认清空（会删除落盘的 JSONL 文件）',
  ledgerCleared: '已清空 {count} 条记录',

  colTime: '时间',
  colType: '类型',
  colBackend: '后端',
  colLatency: '时延',
  colTokens: '节省 token',
  colDetail: '详情',

  typeGate: '门禁',
  typePrune: '裁剪',
  typeStagnation: '停滞',
  typeRoute: '路由',
  typeChoice: '选择',
  typeModelRoute: '模型路由',
  typeEffort: '强度决策',

  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  reset: '重置',
  refresh: '刷新',
  dirty: '有未保存的修改',
  clean: '已与 Host 一致',
  confirmRejected: 'Host 拒绝了本次写入',
  refreshFailed: '刷新失败',

  errVirtualProvider: '虚拟 Provider 名称不能为空',
  errMaxTaskChars: '任务文本预算必须是正整数',
  errPoolModel: '虚拟模型 ID 不能为空',
  errPoolDuplicate: '虚拟模型 ID 重复',
  errPoolProvider: '候选的物理 Provider 不能为空',
  errPoolModelName: '候选的物理模型不能为空',
  errPoolEmpty: '启用路由时至少要有一个含候选的模型池',
  errProfileName: '第 {row} 行连接配置填了内容却没有「配置名」：没有名字就没有保存路径，请填写配置名（或用「删除」去掉这一行）',
  errMinConfidence: '最小置信度必须是 0 到 1 之间的数字',
  errEffortSetting: '推理强度策略不在可选范围内',
  errBackend: '后端实现不在可选范围内',
  errTimeout: '超时必须是不小于 100 的整数',
  errToolPrefix: '工具名前缀不能为空',
  errPruneThreshold: '裁剪阈值必须是非负整数',
  errFallback: '兜底目标必须写成 provider:model',
  errInterventionMode: '干预主模式必须是 off / observe / active',
  errInterventionCapability: '能力项必须是 off / observe / active / inherit',
  errInterventionBudget: '预算与阈值必须是不小于各自下限的整数',
  errInterventionRatio: '该比例必须是 0 到 1 之间的数字',
  errPruneJudgeMinChars: '逐段判定最小字符数必须是不小于裁剪阈值的整数',
  errClaimMinConfidence: '完成声明置信度门槛必须是 0 到 1 之间的数字',
  errClosingEvidenceChars: '收尾证据字符预算必须是不小于 200 的整数',

  toneActive: '激活',
  toneInactive: '未激活',
  toneEnabled: '已启用',
  toneDisabled: '已停用',

  chipRoutingActive: '路由 · 已启用（{candidates} 候选）',
  chipRoutingInactive: '路由 · 未启用',
  chipRoutingTitleActive:
    '虚拟 Provider 路由已启用：请求会按模型池路由到候选物理模型，当前共 {candidates} 个候选。可在「虚拟 Provider」页调整启用状态、候选池或兜底目标。',
  chipRoutingTitleInactive:
    '虚拟 Provider 路由未启用（routing.enabled=false 或候选池为空）：请求直接使用所选物理模型。请在「虚拟 Provider」页启用路由并配置候选池。',
  chipEffortSet: '推理强度 · {level}',
  chipEffortUnset: '推理强度 · 未设置',
  chipEffortTitleSet:
    '已选择推理强度：每轮按 {level} 执行并随请求下发。可在模型选择器里改选其他档位，或在「推理强度」页选择 Reflex 自适应。',
  chipEffortTitleUnset:
    '无推理强度选择：插件不干预，使用模型默认档位。请在模型选择器里选择具体档位，或在「推理强度」页选择 Reflex 自适应。',
  chipBackend: '后端 · {backend}',
  chipBackendTitle:
    'System One 决策后端当前为 {backend}；密钥来自环境变量 {env}。可在「System 1 后端」页更换实现或调整连接。',
  chipBackendTitleFromProfile:
    'System One 决策后端当前为 {backend}；密钥来自连接配置里保存的 Key（只写，不回显）。可在「System 1 后端」页更换实现或调整连接。',
  chipBackendTitleFromFallback:
    'System One 决策后端当前为 {backend}；密钥来自环境变量 {env}（回退：连接配置没有指定变量名）。可在「System 1 后端」页指定变量名或直接保存 Key。',
  chipBackendTitleLockedKey:
    'System One 决策后端当前为 {backend}；已点名 {env}，但该变量未设置——密钥为空，且点名即锁定、不会回退到其他变量，决策会降级到本地兜底。请在「System 1 后端」页设置该变量，或改点名其他变量，或直接保存 Key。',
  chipBackendTitleMissingKey:
    'System One 决策后端当前为 {backend}；未指定变量名，且 SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY 均未取到密钥，决策会降级到本地兜底。请在「System 1 后端」页配置其中之一。',

  statusLabel: 'Reflex 运行状态：{routing}；{effort}；{backend}。悬停或聚焦查看完整说明。',
  statusRoutingActive: '路由已启用（{candidates} 候选）',
  statusRoutingInactive: '路由未启用',
  statusEffortSet: '推理强度 {level}',
  statusEffortUnset: '推理强度未设置',
  statusBackendOk: '后端 {backend} 正常',
  statusBackendMissingKey: '后端 {backend} 缺少 API Key，将降级',
  statusBackendDegraded: '后端 {backend} 不可用，已降级',

  // In-panel user guide: the body is the repository document itself, embedded
  // at build time by `scripts/embed-user-guide.mjs`.
  guideTitle: 'Harness Reflex 使用说明',
  guideIntro:
    '本页内嵌仓库中的 USER_GUIDE.md：安装与构建、System 1 后端接入、虚拟 Provider 模型池、自适应推理强度（reflex / auto）、设置面板用法，以及 MCP 工具与 DSH 原生工具对照。',
  guideHint: '文档语言跟随 DSH 界面语言切换（中文 / English）。修改 USER_GUIDE.md 后需重新执行 npm run build:all，否则本页仍是上一版。',
  guideProvenance: '文档来源 {source} · 摘要 {digest}',
  guideSource: GUIDE_SOURCES.zh,
  guideRevision: GUIDE_DIGESTS.zh.slice(0, 12),
  guideBody: GUIDE_ZH,

  rowTitle: 'Reflex 推理强度',
  rowDetails: '详情',
  rowStep: '步骤',
  rowThinking: '推理强度',
  rowSource: '来源',
  rowConfidence: '置信度',
  rowLatency: '耗时',
  rowRoute: '路由',
  rowRouteUnknown: '未知模型',
  rowSwitched: '已切换',
  rowSteps: '{count} 步',
  rowSupported: '目标档位',
  rowEvidence: '证据',
  rowDegraded: '降级原因',
  rowNone: '无',
  rowClearedShort: '未下发',
  rowHeldForCache: '保持模型以保活缓存',
  rowRouteStrategy: '路由策略',
  rowHeldForCacheDetail: '为避免 Prompt Cache 失效而保持当前模型 (Cache Affinity)',
  composerActual: '实际',
  composerHeldForCache: '缓存保活'
};

/** English copy; the key set must match {@link zh} exactly. */
export const en: Record<keyof typeof zh, string> = {
  nav: 'Reflex runtime',
  title: 'Reflex · System One decision runtime',
  subtitle: 'Virtual model pools, adaptive reasoning effort, System 1 backend, decision ledger',
  systemOneDegraded:
    'The System One backend is unavailable ({reason}); decisions have degraded to local template compression and deterministic fallbacks. This notice disappears automatically when the backend recovers.',
  systemOneDegradedUnknown: 'unknown error',
  tabOverview: 'Overview',
  tabRouting: 'Virtual provider',
  tabEffort: 'Reasoning effort',
  tabBackend: 'System 1 backend',
  tabInterventions: 'Interventions',
  tabTools: 'Tools',
  tabLedger: 'Decision ledger',
  tabGuide: 'Guide',

  stateLoading: 'Reading Host configuration…',
  stateUnavailable: 'This Host registers no reflex configuration namespace; the page stays read-only.',
  stateError: 'Read failed',
  stateNotServed: 'No reflex namespace found — check that the Host half is loaded and registered its configuration.',
  readOnly: 'The Host settings document is read-only; writes are disabled.',

  groupRouting: 'Virtual provider and model pools',
  groupEffort: 'Adaptive reasoning effort',
  groupBackend: 'Backend connection',
  groupRuntime: 'Runtime',
  groupInterventions: 'Automatic interventions (three-state and budgets)',
  groupTools: 'Per-tool switches',
  groupDelegation: 'Subagent delegation (host capability)',
  delegationIntro:
    '`reflex_delegate` is not self-contained: it hands the task to the host `subagent` tool together with the reasoning level System One decided. The host publishes a `reasoning_effort` argument only when `tool-subagent` has `modelSelection` on, so this switch starts off — not because it was forgotten, but because it needs a file outside this plugin.',
  // See the Chinese copy: no exact `reflex_delegate` token, so the tool switch
  // labelled by its registered name stays unambiguous.
  labelDelegationEnabled: 'Enable subagent delegation (host capability switch)',
  helpDelegationEnabled:
    'Use: allow reflex_delegate to register, and agree to write the host modelSelection switch into the profile patch; Format: boolean switch; Default: off; Range: ticking it is explicit consent to turn host modelSelection on (otherwise no level can reach the child); unticking stops delegation, and the runtime never turns it back on by itself.',
  delegationConsent:
    'Ticking this is explicit consent: the plugin writes `tool-subagent` `modelSelection: true` into the host profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`). Only that one field is added — your existing patch content (models, keys, comments, `!!js` expressions) is preserved byte for byte, and a `.bak-dsh-reflex-*` backup is written first.',
  delegationRowState: 'Host state',
  delegationRowPatch: 'Host patch file',
  delegationRowPatchState: 'Patch asks for it',
  delegationRowRegistered: 'reflex_delegate registered',
  delegationStateReady: 'On — a decided level reaches the child',
  delegationStateOff: 'Off — the host delegation tool has no reasoning_effort argument',
  delegationStateNoTool: 'This host exposes no delegation tool to wrap',
  delegationStateUnknown: 'Not probed — no agent scope was readable, so neither on nor off is claimed',
  delegationPatchUnknown: 'Profile patch path not resolved',
  delegationPatchOn: 'Asked for',
  delegationPatchOff: 'Not asked for',
  delegationOn: 'Registered',
  delegationOff: 'Not registered',
  delegationRestartRequired:
    'Saved — takes effect after you restart DSH: the host reads `tool-subagent` configuration at start-up, and hot updates only reach this plugin\'s own fiber. Until then reflex_delegate stays unregistered. File:',
  delegationSavedRestart: 'Saved — takes effect after you restart DSH.',
  delegationSavedNoRestart: 'The patch already has what it needs; nothing was written.',
  delegationWriteRefused: 'Consent recorded, but the host patch was not written:',
  delegationRevokeHint:
    'To undo: untick this switch to stop delegating; to remove the host switch too, delete the `modelSelection: true` line under `tool-subagent` (or the whole row this plugin added). The plugin will not set it back for you.',
  labelEnabled: 'Install the virtual provider',
  labelVirtualProvider: 'Virtual provider name',
  labelFallback: 'Fallback target (provider:model)',
  labelMaxTaskChars: 'Task-text budget (characters)',
  labelPools: 'Model pools',
  poolEmpty: 'No virtual model is configured yet.',
  poolModelId: 'Virtual model id',
  poolEntryProvider: 'Physical provider',
  poolEntryModel: 'Physical model',
  poolEntryDescription: 'Capability note',
  poolEntryTags: 'Tags (comma separated)',
  poolAddModel: 'Add virtual model',
  poolAddEntry: 'Add candidate',
  poolRemoveModel: 'Remove model',
  poolRemoveEntry: 'Remove candidate',
  poolMoveUp: 'Move up',
  poolMoveDown: 'Move down',
  poolCandidates: 'candidates',

  labelEffortSetting: 'Effort policy',
  labelEffortFallback: 'Fallback level',
  labelEffortMinConfidence: 'Minimum confidence',
  labelEffortEnabled: 'Enable adaptive reasoning effort',
  effortDisabledHint:
    'Off stops every adaptive decision and withdraws the injected reflex level; a concrete level the caller chose explicitly is still dispatched as written.',
  effortUnset: 'Leave untouched',
  effortAdaptive: 'Reflex (adaptive)',
  effortHint: 'Blank = leave untouched; Reflex = adaptive every turn.',
  effortLatest: 'Latest adaptive decision',
  effortNoDecision: 'No adaptive decision yet in this activation.',
  effortDecisions: 'Adaptive decisions',

  interventionsHint:
    'off stays out entirely, observe only detects and records, active actually performs the intervention; a capability may inherit the master mode. Default observe.',
  labelInterventionMode: 'Master mode',
  interventionModeHint: 'Default observe: watch and record first, switch to active once the record looks right.',
  labelCapabilityStagnation: 'Stagnation exemption',
  labelCapabilityPrune: 'Result pruning',
  labelCapabilityGate: 'Failure gate',
  labelCapabilityClosing: 'Turn-stop objection',
  labelMaxInterventionsPerTurn: 'Interventions per turn',
  labelMaxJudgmentsPerTurn: 'Judgments per turn',
  labelMaxJudgmentsPerSession: 'Judgments per session',
  labelRepeatThreshold: 'Repeat threshold',
  labelFailureThreshold: 'Failure threshold',
  labelWindowSize: 'Window size',
  labelInterventionMinConfidence: 'Minimum confidence',
  labelPruneFloorRatio: 'Prune floor ratio',
  labelPruneHeadChars: 'Prune head characters',
  labelPruneTailChars: 'Prune tail characters',
  labelPruneIntent: 'Prune judgment intent',
  labelPruneJudgeMinChars: 'Per-segment judge minimum characters',
  labelClaimMinConfidence: 'Completion-claim confidence floor',
  labelClosingEvidenceChars: 'Closing evidence character budget',

  // (?) guidance: each entry spells out use / format / default / blank-or-range.
  // The field-guidance test parses those segments and cross-checks the defaults
  // against resolveConfig instead of trusting this copy.
  helpAbout: 'About {field}',
  helpSwitchOn: 'on',
  helpSwitchOff: 'off',
  helpRoutingEnabled:
    'Use: whether the reflex virtual provider is installed to take over model routing; Format: boolean switch; Default: on; Blank: treated as on when omitted, and off sends calls straight to the physical provider.',
  helpVirtualProvider:
    'Use: the public name of the virtual provider that owns the model pools; Format: non-empty string without a colon; Default: reflex; Range: blank means the default, while an empty or colon-containing value is rejected by config validation.',
  helpFallback:
    'Use: the physical target used when no candidate pool can answer; Format: provider:model, e.g. deepseek-official:deepseek-flash; Default: not set; Blank: no fallback and routing fails closed, and it must not point back at the virtual provider.',
  helpMaxTaskChars:
    'Use: the character budget of the task text handed to System One; Format: positive integer (characters); Default: 400; Range: must be greater than 0, and longer text is truncated before the decision.',
  helpEffortEnabled:
    'Use: whether each turn may adapt its reasoning effort; Format: boolean switch; Default: on; Blank: treated as on when omitted, and off leaves this layer inactive while a concrete level the caller chose explicitly still passes through.',
  helpEffortSetting:
    'Use: whether adaptive reasoning effort runs; Format: blank, or Reflex (adaptive); Default: leave untouched; Blank: the plugin never rewrites reasoningEffort and the request behaves exactly as if this feature were not installed, while the "Reflex (Auto)" level injected into the model selector can still be chosen; choosing Reflex decides every turn through System 1; Range: to fix the thinking depth, choose a concrete level in the model selector, and the offered levels follow the target model\'s declared set (minimal or max are offered only when the model declares them).',
  helpEffortFallback:
    'Use: the level used when System One and the cue classifier both lack evidence; Format: one adaptive level; Default: medium; Range: must be an offered adaptive level, and blank means the default.',
  helpEffortMinConfidence:
    'Use: the System One confidence needed to override the cue classifier; Format: decimal; Default: 0.3; Range: 0 to 1, and out-of-range values are rejected.',
  helpBackend:
    'Use: choose the decision backend implementation; Format: one of auto / mock / jev / vllm; Default: auto; Blank: treated as auto, which picks an available backend from the environment.',
  helpBaseUrl:
    'Use: the System One gateway or OpenAI-compatible logits endpoint; Format: http(s) URL; Default: not set; Blank: use the environment or the backend default address (jev: https://api.typesafe.ai/v1/systemone, simple-jev: http://localhost:8000).',
  helpModel:
    'Use: the model id the backend asks for; Format: non-empty string; Default: not set; Blank: use the environment or the backend default model (jev: jev-latest, simple-jev: Qwen/Qwen2.5-7B-Instruct).',
  helpApiKeyEnv:
    'Use: the name of the environment variable holding the API key, never the key itself; Format: an uppercase environment variable name, e.g. JEV_API_KEY; Default: not set; Blank: the backend falls back in order to SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY, and the secret never enters the settings document.',
  helpTimeoutMs:
    'Use: the per-request backend timeout; Format: integer milliseconds; Default: not set; Blank: use the backend default (10000 ms for jev, 8000 ms for simple-jev), and values below 100 are rejected.',
  helpToolPrefix:
    'Use: the prefix of every registered reflex_* tool name; Format: lowercase letters, digits and underscores; Default: reflex_; Blank: register with the default prefix, and an empty string is rejected.',
  helpPruneThreshold:
    'Use: the character count above which a tool result is pruned; Format: non-negative integer (characters); Default: 500; Range: negative values are rejected, and 0 disables the threshold.',
  helpLedgerPath:
    'Use: the JSONL sink for the decision ledger; Format: relative or absolute path; Default: not set; Blank: keep the ledger in memory only, lost when the process exits.',
  helpCalibrationPath:
    'Use: the offline calibration curve applied to choice confidences; Format: relative or absolute JSON path; Default: not set; Blank: no offline calibration, and raw confidences are used.',
  helpInterventionMode:
    'Use: the master semantics of automatic interventions; Format: one of off / observe / active; Default: observe; Blank: treated as observe, which detects and records only and never acts.',
  helpMaxInterventionsPerTurn:
    'Use: how many interventions may run per turn; Format: non-negative integer; Default: 3; Blank: the default, where 0 runs none this turn.',
  helpMaxJudgmentsPerTurn:
    'Use: how many System One judgments may run per turn; Format: non-negative integer; Default: 3; Blank: the default.',
  helpMaxJudgmentsPerSession:
    'Use: how many System One judgments may run per session; Format: non-negative integer; Default: 20; Blank: the default.',
  helpRepeatThreshold:
    'Use: how often the same tool call must repeat before it counts as stagnation; Format: integer; Default: 3; Range: minimum 2, and smaller values are rejected.',
  helpFailureThreshold:
    'Use: how many consecutive failures trigger the failure gate; Format: integer; Default: 3; Range: minimum 2, and smaller values are rejected.',
  helpInterventionMinConfidence:
    'Use: the minimum confidence an intervention needs; Format: decimal; Default: 0.6; Range: 0 to 1, and out-of-range values are rejected (the effort group uses 0.3).',
  helpWindowSize:
    'Use: the history window examined for repetition and stagnation; Format: integer; Default: 6; Range: minimum 3, and smaller values are rejected.',
  helpPruneFloorRatio:
    'Use: the minimum fraction of the original result kept after pruning; Format: decimal from 0 to 1; Default: 0.5; Range: out-of-range values are rejected.',
  helpPruneHeadChars:
    'Use: head characters always kept when pruning; Format: non-negative integer; Default: 400; Blank: the default, where 0 keeps no head.',
  helpPruneTailChars:
    'Use: tail characters always kept when pruning; Format: non-negative integer; Default: 400; Blank: the default, where 0 keeps no tail.',
  helpPruneIntent:
    'Use: the intent description that tells the pruning judgment what is worth keeping; Format: a short natural-language phrase; Default: extract diagnostics, relevant results and errors; Blank: the default intent.',
  helpPruneJudgeMinChars:
    'Use: the result size that enables per-segment System One judging; Format: integer (characters); Default: 10000; Range: must not be smaller than pruneThreshold, and an inverted pair is rejected by config validation.',
  helpClaimMinConfidence:
    'Use: the confidence floor for the completion-claim semantic judgment, below which a sentence is not verified; Format: decimal in 0~1; Default: 0.5; Range: 0~1, blank keeps the Host default of 0.5.',
  helpClosingEvidenceChars:
    'Use: the character budget of the evidence handed to a closing judgment, truncated by priority diagnostic lines > tail summaries > rest with the dropped amount reported; Format: integer (characters); Default: 2400; Range: at least 200, blank keeps the Host default.',
  helpCapability:
    'Use: whether the "{name}" automatic intervention may run; Format: off / observe / active / inherit; Default: inherit; Range: blank inherits the master mode ({mode}), while an explicit state overrides it.',
  helpToolSwitch:
    'Use: {what}; Format: boolean switch (on / off); Default: {default}; Blank: treated as the default when omitted, and off unregisters the tool so the model never sees it.',
  interventionsEffective: 'Currently effective (read-only)',
  effectiveActing: 'Acting',
  effectiveUnknown: 'No runtime state read yet.',
  modeOff: 'Off',
  modeObserve: 'Observe',
  modeActive: 'Active',
  modeInherit: 'Inherit the master mode',

  toolsHint:
    'Switched by tool suffix (choice, score, route…): closing a tool unregisters it, so the model never sees it. Switches are keyed by suffix, not by name, so renaming the prefix changes nothing. choice, score, screen and gate are on by default; route starts off and is turned on when a deployment wants it.',
  toolsEffective: 'Currently registered (read-only)',
  toolsAllClosed: 'This plugin currently registers no tools.',
  toolsApplyRecommended: 'Apply recommended set',
  toolsRecommendedHint:
    'Prefills the five switches with the advice below: choice, score, screen and gate on, route off — the documented default. Nothing is written until you press Save, and a set that already matches the default writes nothing.',
  toolAdviceExpose: 'Suggested for the agent',
  toolAdviceOptional: 'Turn on when needed',
  toolsLedgerHint:
    'The ledger (call counts, latency, tokens saved, gate and stagnation results) does not take a tool slot: use the /reflex-ledger command, or the Ledger page of this panel.',

  toolWhat_choice: 'Makes one fast probabilistic choice among candidates and returns the distribution, spending no generation tokens.',
  toolWhen_choice: 'When one option has to be picked out of several approaches, categories or a yes/no, without spending generation tokens on it.',
  toolWhat_score: 'Rates a passage or a piece of code against given criteria on a 0–1 scale.',
  toolWhen_score: 'When a continuous score (quality, alignment, confidence) is needed rather than a yes/no.',
  toolWhat_route: 'Ranks candidate tools, skills or approaches against a goal.',
  toolWhen_route: 'When there are many candidates and the range should shrink before acting; an optional extra, off by default, turned on when a deployment wants it.',
  toolWhat_screen: 'Screens untrusted content for prompt injection and instruction overrides.',
  toolWhen_screen: 'Right after reading a web page, a foreign PR comment or a third-party log, before treating it as data.',
  toolWhat_gate: 'Checks claims against real output and evidence, answering pass, contradicted or escalate.',
  toolWhen_gate: 'Before declaring completion or closing a task: verify each acceptance criterion against real output.',
  toolWhat_delegate: 'Hands a task to a subagent and lets System One decide how deeply it should think; permissions, presets and recursion limits stay with the host delegation tool.',
  toolWhen_delegate: 'When a self-contained piece of work goes to a subagent and the right reasoning depth is not obvious. It deliberately has no reasoning-depth parameter: call the host delegation tool directly to pin one. It is only registered when the host delegation tool declares reasoning_effort (modelSelection enabled).',

  labelBackend: 'Backend implementation',
  labelBaseUrl: 'Base URL',
  labelModel: 'Model id',
  labelApiKeyEnv: 'API key environment variable',
  labelTimeoutMs: 'Timeout (ms)',
  backendHint: 'Name an environment variable here, or store the API key directly in a connection profile above (write-only).',
  backendFlatFoldRole: 'Compatibility area: configure new connections above',
  backendHintFlat:
    'Compatibility area: configure new connections in "Connections (multiple)" above; this block only serves as the fallback for fields no profile covers. Click the title to expand and edit.',
  backendFlatFoldedSummary: 'collapsed (use the connections above for new config)',
  backendActive: 'Effective implementation',
  apiKeyFromProfile: 'Key from the configuration (write-only, never shown)',
  apiKeyFromEnv: 'Key from {name}',
  apiKeyFromFallback: 'Key from {name} (fallback: no variable named)',
  apiKeyMissing:
    'No API key configured (no variable named; checks SYSTEM_ONE_API_KEY / JEV_API_KEY / VLLM_API_KEY / OPENAI_API_KEY)',
  apiKeyLockedNamed:
    '{name} is named, but that variable is unset — the key is empty (naming locks the lookup: it will not fall back to SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY)',
  profilesTitle: 'Connections (multiple)',
  profilesHint:
    'One connection per profile; pick one as active. The API key is write-only: it is stored on save and the page only ever shows a placeholder.',
  profilesEmpty: 'No connection profile yet. Add one to fill in its baseURL, model, and API key.',
  profileActive: 'Active',
  profileInactive: 'Inactive',
  profileActivate: 'Set active',
  profileRemove: 'Remove',
  profileAdd: 'Add profile',
  profileName: 'Name',
  profileKeyPlaceholder: 'Paste the API key (empty = leave unchanged)',
  profileKeyStored: 'Stored (write-only, never shown)',
  profileKeyFromEnv: 'From environment variable {name}',
  profileKeyFromFallback: 'From environment variable {name} (fallback: this profile names no variable)',
  profileKeyMissing: 'No API key (no variable named; checks SYSTEM_ONE_API_KEY / JEV_API_KEY / VLLM_API_KEY / OPENAI_API_KEY)',
  profileKeyLocked: '{name} is named but unset — the key is empty (no fallback to another variable)',
  profileKeyPendingEnv: 'Saved, the key will be read from {name} (not saved yet)',
  profileKeyPendingLiteral: 'Saved, this key will be used (not saved yet)',
  profileKeyMissingPending: 'No API key configured (takes effect once saved)',
  profileNeedName: 'Name this profile first',
  profileNamePlaceholder: '(unnamed)',
  profileUnnamedTag: 'Unnamed',
  profileUnnamedHint: 'This row has content but no name yet: saving stops the whole page and this row never reaches the settings document. Type the name in the row title.',
  profileNeedSave: 'Save it before testing',
  profileWriteBlocked: 'The settings document is read-only',
  profileRemoveRow: 'Remove this profile only',
  profileClearKey: 'Clear stored key',
  profileClearConfirm: 'Confirm clear?',
  profileClearCancel: 'Cancel clear',
  profileTest: 'Test',
  profileTesting: 'Testing…',
  profileTestOk: 'Connected',
  profileTestAuth: 'Key rejected',
  profileTestUnreachable: 'Unreachable',
  profileTestTimeout: 'Timed out',
  profileTestBadResponse: 'Bad response',
  profileTestMisconfigured: 'Incomplete configuration',
  profileLatency: '{ms} ms',
  activeProfileMissing: 'The active profile "{name}" does not exist; the flat fallback settings are in use.',

  labelToolPrefix: 'Tool-name prefix',
  labelLedgerPath: 'Ledger JSONL path',
  labelPruneThreshold: 'Prune threshold (characters)',
  labelCalibrationPath: 'Calibration curve path',
  unset: 'not set',

  ledgerTotal: 'Total decisions',
  ledgerTokens: 'Tokens saved',
  ledgerCost: 'Estimated cost saved',
  ledgerLatency: 'Average latency',
  ledgerGates: 'Gates passed / failed',
  ledgerStagnation: 'Stagnation alerts',
  ledgerRouting: 'Routing decisions',
  ledgerRecent: 'Recent decisions',
  ledgerEmpty: 'The ledger is empty.',
  ledgerLogPath: 'JSONL sink',
  ledgerMemoryOnly: 'In memory only (no JSONL path configured)',
  ledgerClear: 'Clear ledger',
  ledgerClearConfirm: 'Click again to confirm (deletes the JSONL sink)',
  ledgerCleared: 'Cleared {count} entries',

  colTime: 'Time',
  colType: 'Type',
  colBackend: 'Backend',
  colLatency: 'Latency',
  colTokens: 'Tokens saved',
  colDetail: 'Detail',

  typeGate: 'gate',
  typePrune: 'prune',
  typeStagnation: 'stagnation',
  typeRoute: 'route',
  typeChoice: 'choice',
  typeModelRoute: 'model-route',
  typeEffort: 'effort',

  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  reset: 'Reset',
  refresh: 'Refresh',
  dirty: 'Unsaved changes',
  clean: 'In step with the Host',
  confirmRejected: 'The Host refused this write',
  refreshFailed: 'Refresh failed',

  errVirtualProvider: 'The virtual provider name cannot be empty',
  errMaxTaskChars: 'The task-text budget must be a positive integer',
  errPoolModel: 'A virtual model id cannot be empty',
  errPoolDuplicate: 'Duplicate virtual model id',
  errPoolProvider: 'A candidate provider cannot be empty',
  errPoolModelName: 'A candidate model cannot be empty',
  errPoolEmpty: 'Routing needs at least one pool with a candidate',
  errProfileName: 'Connection row {row} has content but no name: an unnamed row has no path to save to. Give it a name (or remove the row)',
  errMinConfidence: 'Minimum confidence must be a number between 0 and 1',
  errEffortSetting: 'The effort policy is not one of the offered choices',
  errBackend: 'The backend implementation is not one of the offered choices',
  errTimeout: 'The timeout must be an integer of at least 100',
  errToolPrefix: 'The tool-name prefix cannot be empty',
  errPruneThreshold: 'The prune threshold must be a non-negative integer',
  errFallback: 'The fallback target must read provider:model',
  errInterventionMode: 'The intervention master mode must be off / observe / active',
  errInterventionCapability: 'A capability setting must be off / observe / active / inherit',
  errInterventionBudget: 'Budgets and thresholds must be integers at or above their own minimum',
  errInterventionRatio: 'This ratio must be a number in [0, 1]',
  errPruneJudgeMinChars: 'The per-segment judge minimum must be an integer at least the prune threshold',
  errClaimMinConfidence: 'The completion-claim confidence floor must be a number in [0, 1]',
  errClosingEvidenceChars: 'The closing evidence budget must be an integer of at least 200',

  toneActive: 'live',
  toneInactive: 'not live',
  toneEnabled: 'enabled',
  toneDisabled: 'disabled',

  chipRoutingActive: 'Routing · enabled (candidates: {candidates})',
  chipRoutingInactive: 'Routing · disabled',
  chipRoutingTitleActive:
    'Virtual Provider routing is enabled: requests are routed to candidate physical models from the pools, currently {candidates} candidates. Change the switch, pools, or fallback on the "Virtual Provider" page.',
  chipRoutingTitleInactive:
    'Virtual Provider routing is disabled (routing.enabled=false or the candidate pools are empty): requests use the selected physical model directly. Enable routing and configure a pool on the "Virtual Provider" page.',
  chipEffortSet: 'Reasoning effort · {level}',
  chipEffortUnset: 'Reasoning effort · not set',
  chipEffortTitleSet:
    'A reasoning effort is selected: every turn dispatches {level} with the request. Change it in the model selector, or choose Reflex adaptive on the "Reasoning effort" page.',
  chipEffortTitleUnset:
    'No reasoning effort is selected: the plugin does not intervene and the model default level applies. Choose a concrete level in the model selector, or Reflex adaptive on the "Reasoning effort" page.',
  chipBackend: 'Backend · {backend}',
  chipBackendTitle:
    'System One decision backend is {backend}; the key comes from environment variable {env}. Change the implementation or connection on the "System 1 backend" page.',
  chipBackendTitleFromProfile:
    'System One decision backend is {backend}; the key comes from the connection profile (write-only, never shown). Change the implementation or connection on the "System 1 backend" page.',
  chipBackendTitleFromFallback:
    'System One decision backend is {backend}; the key comes from environment variable {env} (fallback: the connection names no variable). Name one, or store a key, on the "System 1 backend" page.',
  chipBackendTitleLockedKey:
    'System One decision backend is {backend}; {env} is named but unset — the key is empty, and naming locks the lookup so it will not fall back to another variable; decisions degrade to the local fallback. Set that variable, name a different one, or store a key on the "System 1 backend" page.',
  chipBackendTitleMissingKey:
    'System One decision backend is {backend}; no variable is named and none of SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY holds a key, so decisions degrade to the local fallback. Set one of them on the "System 1 backend" page.',

  statusLabel: 'Reflex status: {routing}; {effort}; {backend}. Hover or focus for the full explanation.',
  statusRoutingActive: 'routing enabled ({candidates} candidates)',
  statusRoutingInactive: 'routing disabled',
  statusEffortSet: 'reasoning effort {level}',
  statusEffortUnset: 'reasoning effort not set',
  statusBackendOk: 'backend {backend} healthy',
  statusBackendMissingKey: 'backend {backend} missing its API key, will degrade',
  statusBackendDegraded: 'backend {backend} unavailable, degraded',

  // In-panel user guide; see the Chinese dictionary for the embedding contract.
  guideTitle: 'Harness Reflex user guide',
  guideIntro:
    'This page embeds the repository document docs/USER_GUIDE.en.md: install and build, System 1 backends, the virtual provider pools, adaptive reasoning effort (reflex / auto), the settings panel, and the MCP ↔ DSH native tool mapping.',
  guideHint: 'The document follows the DSH interface language (English / 中文). After editing the guide, re-run npm run build:all or this page keeps the last build.',
  guideProvenance: 'Document {source} · revision {digest}',
  guideSource: GUIDE_SOURCES.en,
  guideRevision: GUIDE_DIGESTS.en.slice(0, 12),
  guideBody: GUIDE_EN,

  rowTitle: 'Reflex effort',
  rowDetails: 'Details',
  rowStep: 'Step',
  rowThinking: 'Effort',
  rowSource: 'Source',
  rowConfidence: 'Confidence',
  rowLatency: 'Latency',
  rowRoute: 'Route',
  rowRouteUnknown: 'unknown model',
  rowSwitched: 'switched',
  rowSteps: '{count} steps',
  rowSupported: 'Declared levels',
  rowEvidence: 'Evidence',
  rowDegraded: 'Degraded',
  rowNone: 'none',
  rowClearedShort: 'not sent',
  rowHeldForCache: 'held for cache',
  rowRouteStrategy: 'Routing strategy',
  rowHeldForCacheDetail: 'Held current model to preserve upstream prompt cache (Cache Affinity)',
  composerActual: 'Actual',
  composerHeldForCache: 'Cache Affinity'
};

/** Copy table of this namespace. */
export interface ReflexPanelCopy {
  [key: string]: string;
}

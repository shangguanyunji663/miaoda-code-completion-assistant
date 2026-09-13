# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [Unreleased]（分支 feat/3-d-capability-guard）

**D 底座加固——能力配置防静默失败**：prompt 是 AI 行为的唯一入口，但配置损坏此前要到运行时才暴露，占位符拼写错误甚至永远静默（`renderTemplate` 对未传变量渲染为空串，AI 收到残缺 prompt 无任何报错）。

### Added

- **能力 JSON 加载前校验 `src/capability-schema.mjs`**（零依赖，不引入 Ajv）：必填字段（`id` / `formValue.prompt` / `paramsSchema`）、prompt 占位符 ⊆ `paramsSchema.properties`（抓拼写错误）、`required` ⊆ `properties`（抓声明漂移）。`ai.mjs` 的 `readCapability` 首次读取时自动全量预检（fail-fast）；新增 CLI 命令 `npm run caps-check` 手动校验（不连浏览器、不调 AI）
- **启动自检 CDP 调试端口 `src/port-check.mjs`**（node:net 零依赖）：watch / lite / course 启动时探测调试端口并给出人话状态——就绪打勾，无响应则指引（推荐先双击 start-my-edge.bat，或说明将自动拉起独立浏览器兜底）。真机反馈驱动：跳过受控浏览器直接运行时，故障要到连接时才暴露。冒烟实测就绪/无响应两条路径
- **单测 22→29 项**（新增 `test/capability-schema.test.mjs`）：真实 7 能力文件全通过的回归闸 + 缺字段 / 占位符拼写 / required 漂移 / 坏文件聚合报错四类用例

### Fixed

- **`code_reflection_fixer_1.json` 声明漂移（校验器上线后首个真实命中）**：prompt 使用 `{{input.terminal_state}}` 但 `paramsSchema.properties` 未声明——`ai.mjs` 三处调用实际已传该变量，仅元数据缺失，补声明后运行时行为不变
- `.gitignore` 补 `.mimosa/`（Mimosa 安全扫描插件本地运行状态，此前以未跟踪目录形式刷屏 git 状态面板）

### Notes

- 验证：`npm test` 29/29 通过；`npm run lint` 零问题；`caps-check` 对真实 7 个能力文件通过；故障注入（坏 JSON / 占位符拼写 / required 漂移）均按预期启动即报并定位到文件
- 文档同步：`shared/capabilities/README.md` 中渲染函数名由 `renderPrompt` 修正为 `renderTemplate`（以 `ai.mjs:28` 实际实现为准，该名称为历史笔误）
- 分支说明落地：根 README 顶部与同学指南第七节标明本分支与 master 的差异（能力配置校验 + caps-check），并注明**无新增依赖**、切换分支无需重装

## [1.1.0] - 2026-09-10

**工程化基建版本**：补单测、统一日志落盘、接入 lint 与格式化、修正元数据与忽略规则。业务逻辑零变更，但**新增的首批单测当场暴露并修复了一个真实的判定缺陷**——`detectVerdict` 会把 EduCoder 的「0 组不匹配」误判为未通过，白白触发整轮反思重试。

### Added

- **统一日志层 `src/logger.mjs`**：此前 `act` / `ai` / `loop` / `perceive` 四处各自定义 `log`（实现还不一致），现统一为 `createLogger(scope)`。控制台保持原有 `[scope] msg` 形态不变，**同时落盘到 `agent/logs/agent-<日期>.log`**（含完整时间戳与 INFO/WARN/ERROR 级别）。此前常驻模式跑完关掉终端窗口日志即丢失，而排查方法论（见 `docs/TROUBLESHOOTING.md`）恰恰依赖事后回溯。落盘失败只降级不中断——日志系统绝不能拖垮主流程；可用 `LOG_TO_FILE=0` 关闭
- **核心纯函数单测（22 项，`test/ai.test.mjs`）**：覆盖 `detectVerdict` / `sanitizeShellSubmission` / `spliceIntoTemplate` / `renderTemplate` / `parseAnswers`。零新增依赖（Node 内置 `node:test`），`npm test` 运行。其中 `sanitizeShellSubmission` 的「命令内部冒号不被误当标签分隔符」是 0.9.1 `lastIndexOf` 缺陷的回归用例
- **ESLint + Prettier**：`eslint.config.js`（flat config）+ `.prettierrc`，新增 `npm run lint` / `format` / `format:check`。配置刻意只开推荐集 + 少量高风险规则，并对 `page.evaluate` 内的浏览器上下文代码声明 browser globals，避免 60 处 `no-undef` 误报淹没真问题
- **`package.json` 元数据**：补 `engines`（README 声称 Node 18+ 但此前无约束）、`license`、`repository`、`author`

### Fixed

- **`detectVerdict` 零失败误判（1.1.0 最重要修复）**：否定词表含 `/不匹配/`，而 EduCoder 结果面板的「共 3 组测试，0 组不匹配」语义是**全部通过**，字面却命中否定词 → 被短路判为未通过，触发无谓的反思重试循环。新增 `ZERO_FAIL_PATTERNS`（`/0\s*组不匹配/`、`/全部匹配/`）**先于**否定短路判定。该函数在 `loop.mjs` 三处终判（218 / 380 / 525）被调用，修复直接生效
- `config.mjs`：`thinkingCapMs` 缩进错乱（在 `ai` 对象内却顶到 `timeoutMs` 层级）
- `ai.mjs:621`：正则多余转义 `[*\#]` → `[*#]`（行为等价，仅为消除 lint 噪声）
- `cli.mjs:149`：解构未使用的循环下标 `i`
- **`shared/capabilities/*.json`**：清除 7 个配置里的 `createdBy: 7575625665181912282`（平台账号 ID，此前已随公开仓库外发）。字段经核查仅 `formValue.prompt` 与 `formValue.modelParams` 被代码读取，删除无副作用；`createdAt` / `updatedAt` 等平台导出字段保留
- **`agent/.gitignore`**：此前忽略 `package-lock.json`，与根 `.gitignore` 注释「keep package-lock.json for consistent installs」直接矛盾，导致依赖版本未锁定。现修正并纳入版本控制

### Changed

- 四处重复 `log` 定义 → 统一 `createLogger(scope)`，并额外提供 `.warn()` / `.error()`
- 全量按 Prettier 风格格式化 `src/` 与 `test/`（纯格式变更，无语义改动）

### Notes

- 验证：`eslint src/ test/` 零问题；`npm test` 22/22 通过；9 个 `.mjs` 语法校验通过；`node src/cli.mjs` 冒烟正常（配置读取、浏览器探测与自动拉起均工作）
- 边界：单测仅覆盖与浏览器无关的纯函数，涉及 CDP / 页面交互的部分仍依赖真机验证，未声称已覆盖
- 未做：`solveOnce`（`loop.mjs:182`，392 行单函数）拆分仍属高风险重构，建议等测试更充分后再动

## [1.1.1] - 2026-09-11

代码栏数据库命令题通用加固：执行层 echo 包裹兜底 + 题面例子命令形态守则 + 结果面板遮挡点击修复。由 2026-09-11 真机（MongoDB 地理位置索引题：AI 反复输出裸命令、且把题面例子的 `db.runCommand` 换成 `aggregate $geoNear` 导致输出格式不符）驱动。

### Changed

- **执行层 echo 双引号包裹兜底（`ai.mjs` `wrapDbCommandsInEcho` + `loop.mjs` 接入）**：AI 即使不遵守守则输出裸 db 命令，提交前确定性包裹为 `echo "…"`（裸 `$` 转义、幂等）。触发条件收紧保证通用性——**仅当代码栏主体是 `db.` 命令集**（≥70% 非空行为 `db.`/`use` 命令、且非编程语言特征开头），不误伤 Python/Java/Node 脚本、字符串字面量、MySQL 的 SELECT/use 等
- **生成/反思守则强化（prompt 单一数据源）**：「严格按题面『相关知识/例子』给出的命令形态书写」（如 `db.runCommand({geoNear:...})`，禁止换成 `aggregate $geoNear`——输出格式由命令形态决定，平台按题面例子的返回结构比对）；反思侧「实际输出格式与预期不符（results/stats/ok vs 扁平文档）→ 检查是否用了题面例子之外的 API 形态」
- **结果面板遮挡点击通用处理（`act.mjs`）**：`clickByKeywords` 点击被拦截（`evaluate-result-container` 拦截 pointer events）时，自动收起结果面板（标题/面板左上角/Escape）后重试，重试失败换候选
- **TROUBLESHOOTING 新增 C-10**（结果面板遮挡点击）；C-9 预防补充「严格按题面例子命令形态」

### Notes

- 验证：索引题 AI 按守则直接生成 echo + runCommand（1243 字符，wrap 幂等跳过）；wrap 触发/幂等/误伤 7 组用例全过（裸命令包裹、已 echo 不重复、Python/Node/MySQL/字符串不触发、`$` 转义）
- 平台机制边界如实标注：echo 提取实测于 EduCoder Mongo 题；MySQL/其它平台未实测（但「bash+eval 双执行」平台的裸命令都会 bash 报错，echo 是通用 bash 包装）

## [1.0.0] - 2026-09-10

**首个稳定版本**：完整破译 EduCoder 平台「命令行插入 + 代码栏查询」类题目的评测机制，并让 Agent 学会完整解题流程。由 2026-09-10 真机 20+ 次评测 + 抓包（`update_file`/`game_status`）+ 已通过题反推驱动，第 2、3 关当场验证通过。

### 平台机制破译（1.0.0 核心成果）

- **双重执行**：代码栏内容（含 Begin/End）提交为 `step2/query.sh`，平台先 bash 执行（裸 REPL 语句的 `(`/`{`/`[` 必报 syntax error，stderr 进实际输出标签前），再对每个测试点做 mongo shell eval（输出在标签后，只提取 `echo "..."` 双引号内容并反转义 `\$`→`$`）；`matchRule=full` 完全匹配
- **评测环境共享终端数据库**：题面要求「先在命令行插入文档」是必需步骤——评测时 `db` 指向题面指定的库，**未插入则查询结果为空**（第 3 关实测：`db.educoder.count()` 插入前 0、插入后 4）。早前「评测环境预置数据、无需插入」的判断被证伪
- **通过格式**：命令行插入题面文档 → 代码栏用 `echo "` 双引号包裹裸查询（分号 `;` 分隔、`$` 写成 `\$`）；heredoc / `mongo` 命令前缀 / `: ` 前缀实测全失败

### Changed

- **生成守则重写（`code_completion_generator_1` 第 7 条）**：命令列「先决条件——题面要求先在命令行插入文档时必须先插入（评测环境干净库）」+「代码栏用 echo 双引号包裹裸查询（分号分隔、\$ 转义）」；0.9.2 的「仅 \$ 转义」与 0.9.4 的 heredoc 守则被实测证伪
- **反思守则重写（`code_reflection_fixer_1` 第 4 条）**：按报错形态分流（`step2/query.sh: syntax error` → echo 双引号重写；`@(shell eval)` → 检查 echo 内查询/转义/分号；**查询结果为空 → 优先检查命令行是否已插入题面文档**）
- **mixed 分支强化（`loop.mjs`）**：数据准备约束明确「必须 insert/insertMany 插入题面文档到指定库，严禁跳过」；终端未出现时警告改为「未插入则查询结果为空」，不再误称「平台可能预置数据」
- **TROUBLESHOOTING C-9 重写**：记录双重执行机制、评测环境共享终端、echo 双引号通过格式与实测失败形态

### Notes

- 验证：第 2 关（$limit/$sort/$skip）与第 3 关（$group/$first/$avg/$unwind/$sum）真实评测通过（实际输出与预期逐字符一致，弹出通过弹窗）
- 本版本整合 0.9.x 全部能力：混合题路由与数据准备自愈、客户端可用性实测、评测判定加固、shell 护栏、思考硬闸、刷新触发、课程自动驾驶

## [0.9.4] - 2026-09-10

客户端探测时序修复 + 代码栏数据库命令 heredoc 守则。由 2026-09-10 真机截图驱动：① 终端明明有 `MISS:mongosh`/`HAVE:mongo` 回显，探测却报「未捕获 HAVE/MISS 行」——读取早于回显渲染；② 代码栏裸 REPL 语句即使把 `$` 写成 `\$` 仍报 bash syntax error——`(`、`{`、`[` 是 bash 语法字符，转义 `$` 只解决变量展开，解决不了语法冲突。

### Fixed

- **客户端探测时序（act.mjs）**：`probeTerminalClients` 原来用 `isTerminalAtPrompt` 当完成信号——探测命令刚粘贴时 xterm 的 DOM 渲染未落定，`.xterm-rows` 最后一行仍是旧提示符 `root@…:#`，判定「已回到提示符」立即 break，读取发生在回显之前（命令实际执行了、回显最终也渲染出来，却报未捕获）。改为轮询读取回显直到捕获 HAVE/MISS 行（上限 5s），不再依赖提示符信号

### Changed

- **代码栏数据库命令题 heredoc 守则（prompt 单一数据源）**：0.9.2 的「$ 写成 \$」守则不完整——bash 对 `(`（子 shell）、`{`（花括号块）、`[ ]`（测试语法）照样报 syntax error。`code_completion_generator_1` 第 7 条与 `code_reflection_fixer_1` 第 4 条重写：禁止把 REPL 语句裸写在代码栏，统一改用「客户端 + 单引号定界 heredoc」形态（`mongo <<'MONGOSH'` … `MONGOSH`，正文原样、bash 零解析，mongo / mongosh / mysql / redis-cli / psql 均支持）；题面转义说明（如「$ 前加转义符 \」「格式如 \;」）降级为语句顺序与分隔的参考
- **代码分支注入客户端实测（loop.mjs / ai.mjs）**：`clientFact` 提升为函数级，mixed 分支探测的结论注入代码生成（additional_requirements）与代码反思（`reflectAndFix` 新增 `terminalState` 参数 → 反思 prompt 新增 `{{input.terminal_state}}` 小节）——AI 拿到「本机只有 mongo 没有 mongosh」这类硬事实，heredoc 能选对客户端

### Notes

- 验证：`node --check` 全过；两个能力 JSON 可解析且 `createdBy` 等原字段原样保留（重建走纯文本替换 prompt 行，避免 JSON 精度丢失）；渲染冒烟确认 heredoc 守则与 terminal_state 占位符落位；端到端表现待该题重跑复测

## [0.9.3] - 2026-09-10

文档同步 + 冗余清理。0.9.2 落库后对全仓文档做一次一致性体检：以代码实际实现为准修正文档间矛盾表述，补齐 0.9.2 变更在文档侧的映射（配置项、工作流、踩坑手册），并清理本地旧会话日志。纯文档与清理变更，不涉及 Agent 行为。

### Changed

- **配置模板同步（agent/.env.example）**：补 `AI_REASONING_EFFORT` / `AI_ENABLE_THINKING` / `AI_THINKING_CAP_MS` / `AI_TIMEOUT_MS` 四项（默认值与 `config.mjs` 逐一核对）；`MAX_RETRY` 4→10、`EVAL_TIMEOUT_MS` 60000→25000，消除模板与实现默认值漂移
- **agent/README.md**：配置表补 4 个新配置项并核准全部默认值；工作流补混合题（mixed）流程、客户端可用性实测、shell 护栏、`$` 转义守则；设计要点新增第 7、8 条；已知限制同步 0.9.2 变化
- **README.md**：目录结构补 `inspect-dom.mjs`；踩坑数 12→14；修正三处与代码矛盾的表述——感知行补「混合题」、作答行改为「优先经编辑器 API 写入（键盘为回退，0.9.2 起与 act.mjs 实测行为一致）」、`task_router_1` 描述补 mixed
- **AGENTS.md**：模块说明同步 mixed 分流与 `detectTerminalEnv`/`probeTerminalClients`/`sanitizeShellSubmission`/`inspect-dom.mjs`；命令清单补 `course-probe`；Windows 入口补 `start-browser.bat`；约束补「环境事实靠实测，不靠模型记忆」与 0.9.2 转义守则
- **shared/capabilities/README.md**：`task_router_1` 用途补混合题（mixed）；新增 0.9.2 数据库命令转义守则说明（生成第 7 条 / 反思第 4 条）
- **agent/docs/TROUBLESHOOTING.md**：新增 C-8（mongosh 不存在 + 子命令被敲进 bash：客户端实测、【实测禁令】、别名替换、输入期反思自愈）与 C-9（代码栏内容被当 bash 脚本执行，裸 `$` 触发 syntax error 的生成/反思守则）

### Notes

- **矛盾修正原则**：文档间冲突一律以代码实际实现为准。本次唯一修正是根 README「代码题用键盘写入编辑器」→「优先编辑器 API、键盘为回退」，与 `act.mjs` 及 AGENTS.md/agent/README 的既有表述冲突，已统一
- **清理**：删除 `.workbuddy/memory/` 下 9-08/9-09 旧会话日志（该目录已被 .gitignore 排除，属本地工作区数据）；`agent/.browser-profile*/`、`agent/dumps/`、`agent/logs/` 为 gitignored 运行产物，保持不提交
- 验证：CHANGELOG 0.9.2/0.9.3 条目与当前代码行为逐项核对；全部内部链接/锚点指向的文件存在；「混合题」「客户端可用性实测」「转义守则」等术语跨文档一致；capabilities 目录实为 7 个 JSON，各文档计数一致

## [0.9.2] - 2026-09-10

混合题终端数据准备自愈 + 代码栏数据库命令转义守则。由 2026-09-10 真机截图（MongoDB 混合题：先命令行插入文档、再代码栏写查询）驱动——同一题终端与代码栏两处失败，全部根因经截图实锤定位。

### Added

- **混合题数据准备装备对齐 cmdline（loop.mjs）**：公共 helper `probeDbClients` / `applyCommandGuards` / `formatInputErrors`（cmdline 分支行为不变），mixed 分支数据准备接入客户端可用性实测（mongosh 不存在、仅 mongo 可用这类硬事实进 prompt）、【实测禁令】、执行层别名替换（`mongosh`→`mongo`，模型不听话也确定性改对）与 shell 护栏清洗。事故场景（真机截图）：旧版 mixed 裸调 generateCommands，AI 在无事实依据下输出本机不存在的 `mongosh`，后续 `use test2` / `db.educoder.remove({})` / `insertMany(...)` 被逐条敲进 bash 全部报错，插入文档失败且无任何重试
- **混合题数据准备输入期报错反思自愈（≤2 轮）**：第一轮若键入/执行即报错（入口命令不存在、子命令被敲进 bash），把输入期报错 + 终端回显喂回 `reflectCommands` 反思一轮后重做，避免「插入失败 → 代码查询空结果」连锁失败；两轮用尽按当前状态继续并日志明示

### Changed

- **代码栏数据库命令题转义守则（prompt 单一数据源）**：`code_completion_generator_1` 实现要求新增第 7 条——「在代码栏中编写数据库操作命令」类任务且题面给出执行/转义说明（如「测试时 $ 前加转义符 \」、「格式如 \;」）时，命令中的 `$` 一律写成 `\$`、命令分隔按题面示例，平台会把代码栏内容当 shell 脚本执行、裸 `$` 让脚本解析失败（bash syntax error）；`code_reflection_fixer_1` 解读守则新增第 4 条——`query.sh: line N: syntax error near unexpected token` 归因 `$` 未按题面转义/命令形态非脚本可执行，按题面转义说明重写。事故场景（真机截图）：AI 照搬裸语句 `db.educoder.aggregate([{$limit:3}])`，平台放进 `query.sh` 用 bash 执行报 syntax error，而题面已明确要求转义

### Notes

- 验证：`node --check` 全过、两个能力 JSON 可解析、渲染后新守则落位确认；端到端表现待该题重跑复测
- 0.9.1 为同日热修（反思全貌可见 + shell 护栏 + 混合题路由 + 评测判定加固），当时仅 bump package.json、CHANGELOG 未补条目，本次未回填以保持最小改动

## [0.9.0] - 2026-09-10

反思链路的速度与记忆：思考硬闸、终端环境感知、跨轮事实记忆、意图路由纠偏、评测判定提速。全部由 2026-09-10 凌晨真机连续排障驱动，每项修复均有真机日志/截图实锤。

### Added

- **🔴 思考硬闸 `AI_THINKING_CAP_MS`（默认 20s，0=不设限）**：流式响应中「仍在思考、正文 0 字」持续超限即主动断流，重试强制关思考——端点忽略思考参数时的最后防线。事故场景：反思调用思考 30s→1.2 万字、60s→2.5 万字击穿 16384 预算 → 空正文判失败 → 静默重试，单次反思拖到 2~3 分钟。真机验证：5037 字思考被 20s 硬闸截断 → 关思考重试 28.3s 完成生成，反思全程降至 6~8s
- **chat() 思考开关双通道 + 按调用覆盖**：新增 `opts.enableThinking`；关思考时同发 `chat_template_kwargs.enable_thinking=false`（vLLM/SGLang 系）与顶层 `enable_thinking=false`（DashScope/硅基流动系）并移除 `reasoning_effort`——0.7.0 的 `reasoningEffort:'low'` 反思降档实测被端点静默忽略（2.5 万字思考与「low 有界」探测结论直接矛盾），两个反思调用改传 `enableThinking:false`。硬闸仅对流式生效（整体 JSON 兜底路径无法中途拦截，注释已标注）
- **重试透明化**：chat() 重试前打印上一轮失败原因（含 finish_reason 与思考尾部）——此前 catch 静默吞错，用户只见「第 2/2 轮」凭空重开，失败原因不可见
- **终端环境感知 `detectTerminalEnv`（perceive.mjs）**：按 xterm 末行提示符形态识别 bash / mongosh（提取当前库名；裸 `>` 需近期输出有 mongo 痕迹防误报）/ mysql / redis / psql / neo4j / unknown，生成与反思前各探测一次，环境事实与书写约束注入 prompt（bash 严禁直接敲 use/db.xxx、REPL 内禁止重复进入与混写 bash）；识别为启发式，失败如实标 unknown 交模型自行判断
- **客户端可用性实测 `probeTerminalClients`（act.mjs）**：bash 环境且题干涉数据库时实测 mongosh/mongo/mysql/redis-cli/psql（`HAVE:/MISS:` 前缀行解析，终端定位逻辑抽公共 `findVisibleTerminal`）。事故场景：本机只有 `mongo` 没有 `mongosh`，无记忆的反思在两者间来回摇摆（第 2 轮用对 mongo、第 3 轮又退回 mongosh）——实测清单进 prompt 根治
- **跨轮事实记忆（反思不再是"带新证据的重试"）**：输入期 `command not found` 命令累积为【实测禁令】（只收干净词法名滤大表达式碎片）、各轮反思一句话分析沉淀为【历史教训】（Reflexion 式教训链，逐轮注入、尾部 6 条防膨胀）——反思每轮独立调用无记忆导致的"第 N 轮改对、第 N+1 轮退回"摇摆根治
- **分支逃生舱**：命令行 ≥2 轮命令全部跑通（无输入期报错）而评测轮轮失败 → 判定疑似意图路由误判，自动转代码分支重做；转入后编辑器模板为空则防呆终止。事故场景（用户定位根因）：MongoDB 题要求在代码模块中编写脚本，被误判 cmdline 全程跑偏
- **意图路由判定规则重写 + 第二证据（task_router_1）**：题干/「编程要求」含「在代码文件/代码模块/编辑器中编写、补全、编写脚本」等表述一律判 code（数据库脚本文件也是 code，不等于命令行题）；编辑器现有模板（`probe.code`，截 600 字）作为第二证据传入；含糊判 code（与解析层 `/\bcmdline\b/` 保守回落一致）。真机复测：该 MongoDB 题已正确判定 code、生成 4.7s、setValue 写入成功

### Changed

- **评测判定提速 + 弹窗时序加固（waitEvalResult 重写）**：轮询 800→400ms；「恭喜您通过本关」弹窗从"文本稳定后查一次"改为每轮轮询即时查（新增 `isPassModalVisible` 助手）；面板命中确定性成功词（全部通过/评测通过/答案正确/accepted/恭喜/0 组不匹配）且无失败词立即判过，不等稳定采样；文本无成功词时继续等弹窗至多 4s，面板未捕获（best 空）也查。通过题从 ~10s 误报未通过 → 弹窗出现秒判通过
- **反思提示词新增「当前终端状态」「历史教训」段**（cmdline_runner_1 第 12 条 / cmdline_reflection_fixer_1 第 4 条与自查清单扩充，prompt 单一数据源约定不变）：环境一致纪律（以当前 shell 语法书写、REPL 内不重复进入、换环境先 exit、bash 禁写数据库子命令）与教训吸收约束
- 生成/反思四处日志动态显示思考截断阈值（替代固定「推理模型可能需要 1~3 分钟」）

### Fixed

- **🔴「恭喜您通过本关」弹窗在场却判"未通过（未命中任何成功信号）"**：0.6.0 引入的弹窗兜底只在面板文本稳定后单次查询，晚于弹窗实际出现时点——见 Changed 首条，重写为轮询内即时查 + 迟到弹窗 4s 等待
- **补记（c71b312/c2739e1，已提交未入账）：题干提取剥离页眉导航噪声**——READ_PROBLEM 最长文本块头部混入 ~200 字平台页眉（用户名/积分/实验计时/菜单标签），关思考模型（0.8.0 默认）对头部噪声更敏感；从首个「第N关/本关任务」行起保留（通用启发式无平台硬编码），真机验证 5428→5361 字符且任务内容完整性全保留

### Notes

- 真机验证（2026-09-10 00:16~01:04 连续排障）：思考硬闸截断 → 关思考重试生成 28.3s、反思 6~8s；意图路由对该 MongoDB 题正确判 code；客户端探测/禁令/教训链就绪，完整通过链路待下一题复测
- 边界如实标注：逃生舱在真 cmdline 题内容性失败时可能多跑一轮代码分支（「模板为空」防呆可挡大部分误伤）；反思治的是有证据可依的事实性/结构性错误，预期输出本身不可见的题不在其能力范围
- 代码题分支（reflectAndFix）尚未对称接入教训链，待命令行题验证有效后跟进
- 版本号维持 0.x（1.0 待更多题量持续稳定后发布）

## [0.8.0] - 2026-09-09

`chat()` 流式化：推理模型的思考/正文实时可见，AI 调用不再有黑箱等待。

### Added

- **chat() 流式改造（SSE）**：`stream:true` + 逐块解析 `delta.content` / `delta.reasoning_content`；每 30s 心跳汇报「思考 X 字、正文 Y 字｜最新思考尾部…」——推理模型的长思考全程可见，等待不再是黑箱
- **空闲超时替代绝对超时**：手动 AbortController，每收到一块数据就重置计时——流式长生成不会被误杀，端点挂起/断流才触发（报 `AI 响应空闲超时`）
- **兼容兜底**：个别端点 `stream:true` 仍回整体 JSON 时自动走原解析路径

### Changed

- **生成预算封顶 16384**：`cmdline_runner_1` / `code_completion_generator_1` 32768→16384——马拉松思考改为"快速截断 → 带思考尾部的明确报错 → 重试"，配合流式可见性可控性更好；反思保持 32768，quiz 16384，路由 8192

### Fixed

- **ensureTaskPage 未覆盖 SPA 页内结果视图（0.7.0 缺口，真机实测）**：平台首次评测后有时把工作区顶换成全屏「实际输出」视图——**URL 保持 `/tasks/...` 不变**，0.7.0 的 URL 判据永不触发，只能用户手动返回，反思/重试全在错误视图上。现补充页内检测（编辑器与终端同时不可见 + 页面含「实际输出」「查看效果」）与三级关闭（class 含 close 的页面上部图标 → 点「查看效果」→ Escape），每步验证工作区真实恢复（编辑器或终端重新可见）；工作区可见时绝不误触发（活体验证）

### Notes

- 流式 SSE 解析与「思考尾部」诊断已 CDP/真机双验证（小预算调用返回完整思考尾部，证明解析链路正确）；完整任务链路待真机复测
- 预算耗尽时的报错现在自带思考尾部，可直接定位模型"卡在哪"

## [0.7.0] - 2026-09-09

评测后导航自愈 + AI 调用日志统一（真机反馈驱动）。

### Added

- **评测后自动返回题目页**：新增 `ensureTaskPage`（act.mjs）——评测后平台跳转到全屏「实际输出」结果页时，先抓结果页文本尾部作为反思证据，再按题目 URL 模式（`TASK_URL_PATTERN`）在浏览器上下文找回原题目页（bringToFront）或 `goBack` 后退；命令行/代码两分支失败路径接入，证据以「=== 评测结果页 ===」并入反思材料——不再需要用户手动返回
- **反思进度日志**：反思调用前预告静默期（与生成同款），完成输出耗时——消除"抓取明细后长时间无输出"的观感

### Changed

- **AI 调用日志统一**：四处调用点（生成命令/生成代码/命令反思/代码反思）统一为「正在调用 AI X（第 N 次）…推理模型可能需要 1~3 分钟」→「AI X 完成（第 N 次，…，耗时 X.Xs）」格式，实际耗时全部可见
- **推理模型预算再上调（复杂任务实测 8192 被思考独占耗尽）**：命令行生成/反思、代码生成/反思 8192/16384→**32768**，quiz 选择/批量 8192→16384，意图路由保持 8192——agnes-2.0-flash 对多集合文档操作类任务仅思考即可耗尽 8192，`finish_reason=length` 且 `content` 为空
- **反思降本三件套（输入瘦身 + effort 降档 + 输出约束）**：反思题干按「编程要求」锚取前后段（~1500 字，非全量 5361）、终端回显尾部 5000→2000、反思调用 effort 降档 low（chat() 支持按调用覆盖推理分级）、两个反思提示词加简洁约束（命令行：只写一句话分析；代码：分析 ≤3 句）——反思耗时与思考量预计减半以上，8192 预算从"被击穿"变为宽裕
- **推理模型思考默认关闭（根治思考拖垮/耗尽类问题）→ 升级为推理分级**：请求附 `reasoning_effort`（默认 **medium**，探测实证：思考 1612 字有界且多步命令完整覆盖，对比全开马拉松 74955 字、全关漏要求）；`AI_REASONING_EFFORT` 可调 low/medium/high；`AI_ENABLE_THINKING=0` 全关（极简场景）。真机验证：medium 默认档 mongo 查询任务 4.7s 完成
- **预算回归务实值（思考分级后输出可控）**：命令行生成/反思、代码生成/反思 32768→8192，quiz 批量 16384→4096，quiz 单题 16384→1024，意图路由 8192→512——预算回归"输出兜底"本位（均为预期输出的 3~5 倍余量）
- **回退「中文 \uXXXX 转义」生成规则（方案 2 实测净有害）**：该规则要求模型逐字计算 Unicode 码位，真机实测双重伤害——码位错误（丰 → `\u5346`，正确为 U+4E30）导致键入成功但落库数据与预期不匹配；中文多时码位计算思考暴涨击穿预算（间歇性 `finish_reason=length`）。中文键入由执行层合成 paste 事件承担（已真机验证），生成层恢复明文中文；预算上调（32768/16384）保留作为余量

### Notes

- 补充修复（b5ded98）：结果面板捕获排除内嵌终端/编辑器容器——嵌套放宽后"跨终端区+结果面板"包裹器卷入持续滚动的终端回显，捕获文本永不稳定、判定长时间不出
- `ensureTaskPage` 的 URL 判据复用 `TASK_URL_PATTERN`（换平台改这里）；上下文找不回题目页时 goBack 兜底，仍失败则按当前页面继续并打日志，不中断流程
- 结果页证据为全页 innerText 尾部 3000 字符；导航自愈与反思进度日志的端到端表现待真机验证

## [0.6.0] - 2026-09-09

命令行题可靠性增强：终端证据全量入反思、键入提速、运维知识沉淀进提示词。与 0.5.0 同日迭代，均源于真机排障。

### Fixed

- **🔴 终端键入中文丢字（MongoDB 题 `name:""` 反思循环不收敛的执行层根因）**：`keyboard.type` 对 CJK 被 xterm 丢弃（实测 `insert {_id:1,name:"李小红"}` 落库为 `name:""`）——反思诊断正确但执行层每次都坏，原理上无法收敛。非 ASCII 行改走**合成 paste 事件**直入 xterm 粘贴管线（CDP 真机验证中文完整上屏，测试残留已清理）；备选链 insertText / 剪贴板 API / execCommand 均实测不可用，已记录在代码注释。合成粘贴失败时回退 keyboard.type 并告警
- **🔴 通过判定漏报（评测成功却判"未命中任何成功信号"）**：成功面板的"1/1 全部通过"挂在深层容器，被标记路径 60 层嵌套上限排除，只抓到无判定词的页脚 → 保守误判未通过。标记路径嵌套上限放宽至 500（整页包裹器因含"任务描述"签名仍被排除）；`waitEvalResult` 新增兜底信号——捕获文本无成功词但页面出现「恭喜您通过本关」庆祝弹窗（平台权威通过宣告）时判为通过
- **🔴 heredoc 正文缩进被剥（MongoDB 双实例题第二断层）**：`parseCommandLines` 的 `l.trim()` 剥掉行首缩进，heredoc 写入的 YAML 被拍成扁平键值对 → mongod 报 `Unrecognized option: enabled`。改为仅去行尾空白、保留行首缩进；`Unrecognized option` 加入输入期报错特征表
- **🔴 命令解析器咬掉 `cat > ` 前缀（命令行题反复失败、反思永不收敛的最终根因）**：提示符剥离正则 `/^[\w.:@~-]+\s*[>#]\s+/` 把 `cat > file <<'EOF'` 误判为提示符形态，剥掉前缀后路径被 bash 当程序执行 → `No such file or directory`。按提示符形态分别匹配（`user@host:#`、`bash-5.1#`、已知 REPL 名 `testdb>/mongo>/mysql>` 等），重定向命令不再误伤；顺带修正 `(x)>` 括号形态缺口。13 用例回归全 PASS

### Changed

- **自适应命令间隔**（替代固定 1200ms）：回车后轮询终端最后非空行，提示符（`#`/`$`/`>`）返回即下一条——快命令 ~200ms 放行，慢命令等输出滚完，前台阻塞类由 `TERMINAL_GAP_MAX_MS`（默认 2500）兜底；键速 25→10ms/字符。32 条快命令场景总耗时约 50s→15s
- `MAX_RETRY` 单题反思重试上限 2→10（用户配置；失败题最坏耗时与 token 消耗随重试线性放大，配合失败差异明细使用，让每轮反思有据可依而非盲试）
- `agent/.env.local` 生效值：`EVAL_TIMEOUT_MS` 60000→30000、`MAX_RETRY` 4→10（`config.mjs` 默认值同步对齐）

### Added

- **命令行题反思可见全部终端显示**：`readTerminalText` 抓取时点移至反思时（评测等待期间终端持续滚动——服务启动/连接超时类报错在键入完成后数秒才出现，键入后立即抓会漏）；按行 `textContent` 读取修复词间空格丢失（innerText 实测把 "No such file" 读成 "Nosuchfile"）；尾部 5000 字符以「终端回显（本轮全部显示内容）」并入反思材料——不止输入的命令，本轮终端显示的一切都在
- **输入期报错检测**：`runTerminalCommands` 每条命令执行完做行级差分（新增 `readTerminalLines`），新增回显行命中报错特征（command not found / No such file / SyntaxError / Error: / exception / Traceback / refused / timeout / 错误 / 失败等）立即记为 `命令 N 输入期报错` 并打日志；评测失败时以「=== 输入期报错 ===」优先并入反思材料
- **命令行提示词防御加固（MongoDB 双实例题复盘产出，`mkdir -p` 父目录缺失类根治）**：`cmdline_runner_1` 新增生成期要求——写文件/建配置必须先 `mkdir -p` 父目录并 `ls` 验证、多行文件用单条 heredoc 写入（EOF 独占一行顶格）、服务启动前配置与数据目录必须就绪、启动后紧跟连通/进程检查、**JS 类 shell（mongo 等）中中文值一律 `\uXXXX` 转义代替明文（键入保真双保险：执行层合成 paste + 生成层转义）**；`cmdline_reflection_fixer_1` 自查清单新增三条失败映射——`No such file or directory` → 父目录缺失（mkdir 后重写并验证）、`Connection refused` → 回查服务启动命令自身的报错（配置缺失 / dbPath 目录缺失）后再启动验证、**插入的中文值变空串 → JS shell 改用 `\uXXXX` 转义重写**

### Notes

- ✅ **端到端验证通过（2026-09-09 19:58，MongoDB 双实例 cmdline 题真机实测）**：`mkdir -p` → heredoc 写入带缩进配置（`ls -l` 确认 192×2 字节落盘）→ `mongod -f` fork 启动 → `ping` 连通 → 评测通过，修复后全链路一次跑通；此前连续三轮失败的 `cat >` 前缀咬字与缩进剥除两个断层均确认修复
- 其余验证：全部源文件 `node --check` 与模块导入冒烟、命令解析器 13+6 用例回归全 PASS、结果面板标记与平台 Monaco 全局结构经 CDP 只读探测确认
- 版本号维持 0.x；单题跑通 ≠ 统计性成功率，1.0 待更多题量持续稳定后发布

## [0.5.0] - 2026-09-09

推理模型适配与「写入 → 评测 → 反思」全链路加固。当日多轮真机排障驱动，全部根因经 CDP 只读探测与用户截图实锤定位。

### Fixed

- **推理模型 max_tokens 预算耗尽（lite 全链路失败的首要根因）**：AI_MODEL 换用推理模型（先输出 `reasoning_content` 再输出 `content`，思考与回答共享预算）后，意图路由 16 token 预算全被思考耗尽、`content` 恒空 → 确定性失败。`task_router_1` 16→8192，其余能力配置整体调大（quiz/cmdline 2048/4096→8192，代码生成/反思 8192→16384）；`classifyProblemIntent` 弃硬编码改读能力配置，消除参数双份漂移
- **写入排版错乱（代码题作答失败主因）**：Monaco 的 formatOnPaste/autoIndent 会把 `insertText` 进来的预缩进 Python 逐行重排（阶梯状缩进 → 评测 IndentationError）。`writeEditorCode` 改为分层写入：优先编辑器/平台 API——CDP 实探发现平台把 monaco 命名空间暴露为大写 `window.Monaco`（另有平台自有设值入口 `window.updateMonacoValue`），命名空间按 `window.monaco ?? window.Monaco` 解析，逐级尝试 monaco/CM5 `setValue` → 平台 setter，键盘路径降为回退；每次写入后做「去空白逐字符相等」强验证。`AGENTS.md` / `agent/README.md` 写入约束同步改写
- **评测结果面板误抓题干（60s 空等与"空结果"误报根因）**：题干区也含"测试说明/运行"等宽泛关键词且以长度优势在"取最长匹配块"启发式下稳定胜出，题干文本评测前后不变 → 判变化逻辑失效。`READ_EVAL_PANEL` 改为结果面板专属标记优先（`共有N组测试集` / `本关最大执行时间` / `测试结果`，含"任务描述"签名的题干块直接排除），旧关键词启发式降为兜底
- **"同错复现"空等**：新评测结果与点击前面板完全一致（同代码同错误）时"等变化"永远等不到——结果标记命中且连续 3 次采样稳定（约 5s）即直接采用，不再烧满超时预算后误报"空结果"
- **测试集明细抓空**：`collectTestSetDetails` 曾命中纯标签行迷你容器（仅百余字符空壳喂给反思）；增加正文门槛（预期+实际去空白 ≥20 字符），采集为空时强制展开全部折叠头重采自愈
- **回读验证 ReferenceError**：写入回读验证引用 perceive.mjs 中不存在的 `log` 致运行时中断评测；补 `[perceive]` logger。回读升级为 Monaco 模型 API 优先（view-lines 虚拟渲染只含可见行、长代码回读必然偏短的假阴性根治），未暴露全局时退回可见区近似读取
- `agent/.env.local` 生效值 `EVAL_TIMEOUT_MS` 60000→30000（`config.mjs` 默认 25000 不变）

### Added

- **评测失败差异增强**：新增 `collectTestSetDetails`（act.mjs）——失败后自动展开「测试集N」折叠块，结构化抓取预期输出 vs 实际输出（多 frame 扫描、防误折叠已展开块、剔除「展示原始输出」/页脚噪音、8 组×1200 字符上限）；代码题与命令行题的反思均携带
- **命令行题反思可见终端回显**：新增 `readTerminalText`（perceive.mjs）——读取 xterm 终端回显并入命令行题反思材料，输入/执行期错误不再只留在终端里
- **代码题反思携带实际提交代码**：`spliceIntoTemplate` 后的提交版（实际写入并评测的那份）作为 `previous_code` 传给反思，替代 AI 原始输出
- **请求超时**：新增 `AI_TIMEOUT_MS`（默认 5 分钟），端点挂起按失败重试，loop 不再永久停摆
- **生成期可观测性**：代码/命令生成前预告静默期（推理模型 1~3 分钟）、完成后输出耗时；写入日志标注写入方式（API/键盘）与回读验证结果

### Notes

- 已验证：全部源文件 `node --check` 与模块导入冒烟、7 个能力 JSON 可解析、结果面板标记与测试集切分算法按 CDP 只读探测的真实页面结构验证、平台 Monaco 全局结构实探确认
- 端到端作答成功率取决于 AI 生成质量，本版本未做统计性验证；版本号维持 0.x（1.0 待端到端稳定性验证后再发布）

## [0.4.0] - 2026-09-09

### Added

- **命令行题型支持（cmdline）**：面向头歌类平台的数据库/运维任务（右侧含「命令行」标签 + xterm 终端）。每次作答先读左侧题干，由 AI 意图路由器（`task_router_1`）按**题干内容**判定该题是写代码文件（code）还是敲命令行（cmdline）——判定依据与当前激活的 tab 无关，判定后自动切换到对应工作区
- `ai.mjs` 新增 `classifyProblemIntent`（意图路由）、`generateCommands`（命令生成，`cmdline_runner_1`）、`reflectCommands`（命令行反思，`cmdline_reflection_fixer_1`）、`parseCommandLines`（剥 markdown 围栏 / 注释行 / `$` 与 REPL 提示符，含 `testdb>`、`root@host:~#` 形态，8 用例单测通过）
- `act.mjs` 新增 `switchTaskTab`（切换「命令行/代码文件」标签，激活态自检跳过；结构依据真实 dump：`div[class*="item___"]` + 激活类 `active`）与 `runTerminalCommands`（真实键盘逐条键入 xterm，每条回车间隔 1.2s，遵循 DRY_RUN 守卫）
- `perceive.mjs` 新增 `waitForTerminal` / `waitForEditor`（切 tab 后内容懒渲染的轻量轮询等待）
- `loop.mjs` `solveOnce` 重构：选择题/填空题仍按结构信号直接作答；代码/命令行题统一先意图判定 → 切 tab → 分流执行，两分支均保留反思修正循环（`MAX_RETRY` 轮）；命令行 tab 激活时编辑器 DOM 不存在（懒渲染），原实现会误判走代码分支导致评测不匹配
- 新增能力配置：`shared/capabilities/task_router_1.json`、`cmdline_runner_1.json`、`cmdline_reflection_fixer_1.json`（prompt 单一数据源约定不变）

### Added（lite 刷新触发模式）

- **刷新触发模式 `npm run lite`**（新增 `start-lite.bat` 双击入口，纯 ASCII）：常驻监听下**刷新任意题目页（F5）即重新自动作答**。做题流程与 watch 完全一致（生成 → 评测 → 失败反思修复 → 重评，最多 `MAX_RETRY` 轮），同样不替用户翻页
- 与 watch 模式的核心区别：watch 按 URL 去重、同一题只做一次；lite 每次刷新都重做——反思重试仍未通过时，用户刷新页面即可让 agent 重新完整作答（刷新 = 人工触发的重做信号）
- `loop.mjs` 新增 `liteLoop`：以 `window.__liteHandled` 注入标记检测页面刷新（刷新销毁执行环境、标记消失即触发；SPA 软导航不销毁 `window` 不会误触发），作答前先补标记防止同一轮询周期内重复触发；轮询间隔 / 题目 URL 模式 / 渲染超时复用 watch 的 `WATCH_POLL_MS` / `TASK_URL_PATTERN` / `READY_TIMEOUT_MS`，零新增配置

## [0.3.0] - 2026-09-09

### Added

- **课程自动驾驶模式 `npm run course`**（新增 `start-course.bat` 双击入口，纯 ASCII）：遍历「课堂实验 → 板块 → 开始学习」逐关作答。评测通过自动点「下一关」；点击后 URL 与关卡序号均无变化即判定本小板块做完 → 任务页右上角「退出」→ 作业详情页左上角返回 → 回列表继续下一块。进度 `n/n` 的已完成卡片自动跳过；支持新标签页进入关卡（作答完自动关闭）
- `perceive.mjs` 新增课程列表感知：`collectCards`（卡片标题 + `n/n` 进度）、`collectSections`（左侧板块菜单）
- `act.mjs` 新增课程导航动作：`readTaskNo` / `waitTaskAdvance`（SPA 切关的 URL/序号双判据）、`clickExitTask`（电源图标启发式）、`clickBackArrow`（找不到时退化为浏览器后退）、`clickContinueChallenge`、`clickStartLearning`
- 新增配置：`NAV_TIMEOUT_MS`（默认 10000）、`LIST_TIMEOUT_MS`（默认 15000）、`MAX_BOARDS_PER_SECTION`（默认 50）
- **新增 `my-edge` 命令 / `start-my-edge.bat`**：以"用户自己的浏览器配置"重启并带调试端口——目录联接（junction，无需管理员）绕过 Chromium/Edge 136+ 默认目录调试禁令，账号/历史/插件全保留；含 3 秒倒计时关闭运行中的实例（同 profile 旧实例会合并新命令导致端口失效）
- `connectBrowser` 支持自动拉起：连不上调试端口时自动启动独立 profile 浏览器并重连（`AUTO_LAUNCH=0` 关闭），watch/course 单 bat 即可跑
- **新增只读诊断命令 `npm run course-probe`**：在课程列表页打印识别到的板块/卡片并导出 `dumps/course-*.json`，course 卡住时用于精调识别规则
- course 卡片点击加固：采集时在真实可点节点打 `data-agent-target` 标记（替代 nth 文本序号，避免隐藏同名节点导致错位）；点击超时不抛异常；点击后 12 秒内未发生导航（新标签页/URL 变化）则记日志跳过该卡片，不再静默空转
- 点击目标明确为「开始学习」按钮本身（书本图标+文字的可点容器）：从文本叶子向上找 `cursor:pointer` 的最近祖先打标记；`course-probe` 输出附带按钮 tag/class 便于与真实页面核对
- `ai.mjs` 新增 `spliceIntoTemplate`：代码题写入前以**原始模板**为权威，把 AI 生成的代码体拼回 Begin/End 标记之间，平台脚手架字节级不变，消除"写入后不符合平台格式"（标记识别要求 ≥3 装饰符串，避免误判 Redis 事务里的 `BEGIN`）
- **平台兼容性明确化**：支持任意 EduCoder 系平台（学校私有部署 / 官方 www.educoder.net）——识别全部基于 URL 路径与页面启发式、与域名无关（实测 `/tasks/<id>/<num>/<slug>` 双站匹配）；新增 README「平台兼容性」节

### Changed

- 提速：`MAX_RETRY` 4→2、`EVAL_TIMEOUT_MS` 60000→25000、`chat()` 默认重试 3→2；单题最坏耗时约降一半以上

### Fixed

- **course 列表页采集三大真实结构缺陷**（经 CDP 连真实列表页逐级插桩定位，已回归验证：9 卡片 + 17 板块全识别、按钮标记正中 `actionIcon` 容器）：
  1. 卡片行上爬判据失效：按钮为三层同文本嵌套容器（`actionIcon > flexBox > div`，innerText 均为"开始学习"），旧"父文本严格更长"判据第一步即断，row 停在叶子 → 0 卡片。改为"当前行不含进度 n/n 且父级仍含开始学习就继续爬"
  2. 图标字体字符污染匹配：菜单项/按钮 innerText 带私有区字符（如 `\uE8B5`），`startsWith('课堂实验')` 恒假。统一 `clean()`（剔除非字母数字空白字符）后比对；标题提取改用原始 innerText 按行切分（norm 会吞换行致整行成标题）
  3. `collectSections` 两处硬伤：contains 去重误用全量元素集做排除（任何容器都含别的元素 → 恒为空），修正为仅对通过匹配的集合去重；子板块是 `role="button"` 可拖拽 div（react-rbd），选择器补 `[role="button"]`
  另：`collectCards`/`clickStartLearning` 支持 iframe 回退；匹配前剔除字母/数字/空白以外字符（附单测）；`course-probe` 与 course 主流程在 0 卡片时自动输出候选节点 JSON 转义采样并导出结构快照
- **评测结果"空结果"误判与等待过长**：旧版 `waitEvalResult` 每轮跑全页探测（probePage 多次 evaluate，单轮秒级延迟）且只扫主 frame、候选仅 `div/section/pre/article`，结果渲染在 iframe 或带 `result/output/console` 类名的容器里时永远抓空 → 白等满 `EVAL_TIMEOUT_MS` 后保守判"未通过"。现改为轻量探针 `readEvalPanel`：每轮单次 evaluate、全 iframe 扫描、候选扩至含 result/output/eval/console/modal/message/toast 类名容器与 `code/pre`，轮询间隔 1200→800ms；出结果后 ~2.4s 内即可判定，仍抓空时打印 dump 指引
- **成功判定补裸「通过」兜底**：EduCoder 结果文风如「测试集1 通过」，旧肯定词表（全部通过/测试通过/AC…）一个都命中不了、会误判未通过。否定词（未通过/没有通过/不通过/未全部通过…）仍优先短路，走到兜底才判通过；4 组用例单测 PASS
- **watch 空白页诊断**：题目区 15 秒未渲染且页面文本近空时，日志明确提示"多半是该平台未登录，请在调试浏览器登录一次"（实测 educoder.net 对匿名用户渲染空壳、无跳转无提示），替代误导性的单纯"跳过本页"
- watch 模式启动时把已打开的题目页预标记为"已处理"，导致"页面已打开却不作答"；现启动即作答当前页，作答后才去重
- `README.md` 配置表与实际默认值漂移（`DEBUG_PORT` 9222→9333、`MAX_RETRY`、`EVAL_TIMEOUT_MS`），已同步

### Known Issues

- course 列表采集已在真实页面验证（9 卡片 / 17 板块 / 按钮正中 actionIcon），但**完整端到端（点开始学习→逐关作答→退出返回）尚未跑通验证**；「退出」电源图标与返回箭头仍为启发式，首次全流程运行时留意日志，卡住即 `npm run dump` 反馈

## [0.2.0] - 2026-09-09

项目聚焦为纯浏览器自动解题 Agent：移除手动粘贴式的 React 工作台前端，agent 成为唯一主体。

### Removed

- **前端手动工作台整体移除**：`src/`（页面与 shadcn 组件）、`index.html`、`vite.config.ts`、`tsconfig*.json`、`components.json`、`eslint.config.mjs`、`scripts/`、`public/`、`setup.bat`、根 `package.json` / `package-lock.json` / `node_modules`、`.githooks/`、`shared/plugin-types.ts`
- 根 `.env.local` / `.env.example`（前端专用的 `VITE_AI_*` 配置，含密钥副本）：agent 只读 `agent/.env.local`，本次一并清理以减少密钥暴露面

### Changed

- 根 `README.md` 重写为自动解题 Agent 的定位与快速开始；完整文档仍以 `agent/README.md` 为准
- `AGENTS.md` 重写：项目性质、模块清单、命令与约束（删除前端相关条目，新增"浏览器须由用户双击 bat 启动"）
- `shared/capabilities/README.md`：消费方收敛为 agent，去除对已删类型定义文件的引用
- `agent/README.md` 与源码注释：消除"主项目"措辞，prompt 路径统一表述为仓库根 `shared/capabilities/`

### Notes

- agent 不受影响：`agent/src/config.mjs:108` 解析的 `capabilitiesDir` 指向 `../shared/capabilities`，依赖为 `agent/node_modules`（仅 playwright-core）。已验证 8 个模块语法检查通过、全部导入正常。
- 前端历史版本保留在 git 提交 `3cc19d3`，需要时可 `git checkout 3cc19d3 -- src/ package.json` 取回。

## [0.1.0] - 2026-09-08

浏览器自动解题 Agent 子系统从零建成，并在校内评测平台（Ant Design 结构）上完成真实联调：第 1 关「Redis持久化」已成功自动提交。

### Added

- **浏览器执行层子系统 `agent/`**，与主项目分工：主项目提供交互工作台与 AI prompt 定义，agent 负责感知页面、自动作答、提交评测、反思重试
- **AI 调用层 `agent/src/ai.mjs`**
  - OpenAI 兼容接口调用，带指数退避重试
  - prompt 单一数据源：直接读取主项目 `shared/capabilities/*.json` 并渲染 `{{input.xxx}}` 占位符，不在 agent 内复制 prompt
  - `detectVerdict()`：加固版成功判定（否定词优先短路 + 整词匹配 + 不确定判负），修复主项目 `detectSuccess` 的「未通过」误判问题
- **页面感知层 `agent/src/perceive.mjs`**
  - 编辑器探测（Monaco / Ace / CodeMirror5 / CodeMirror6 / textarea / contenteditable）
  - 题干启发式提取（排除编辑器后取最长且偏左的文本块）
  - 结构化多小题提取（`ul.choose-container > li`），题型自动分类（code / choice / blank）
- **执行层 `agent/src/act.mjs`**：写入编辑器（键盘输入而非改 DOM）、点击评测/翻页、等待结果、批量勾选
- **编排层 `agent/src/loop.mjs`**：生成 → 评测 → 失败反思 → 成功翻页 的完整循环；Watch 常驻监听模式
- **CLI `agent/src/cli.mjs`**：`browser | probe | dump | once | run | watch | models` 七个命令
- **新增 AI 能力配置 `shared/capabilities/`**
  - `quiz_answer_selector_1.json`：单题选择题/填空题作答
  - `quiz_batch_answer_1.json`：整页多小题批量作答（输出约定「题号:字母」，多选连写）
- **启动脚本**：`start-browser.bat`（关 Edge → 独立 profile 调试实例）、`start-watch.bat`（常驻监听）
- **文档**：`agent/README.md`、`agent/docs/TROUBLESHOOTING.md`（问题排查手册）、本文件

### Watch 常驻监听模式（推荐用法）

- 程序常驻，每 2 秒遍历所有标签页；用户切到新的题目页即自动作答并点「评测」
- 不替用户点「下一关」，导航权在用户手里
- URL 去重（`TASK_URL_PATTERN`，默认 `/tasks/[^/]+/\d+/[A-Za-z0-9]+`）；启动时已打开的题目页跳过，避免重复提交
- 依据实测放弃 `visibilityState` 方案（CDP 下全部返回 visible），改为全量遍历 + URL 去重

### Fixed

- **成功判定误判**：`"未通过，3组不匹配"` 在朴素 `includes` 匹配下会命中「通过」。`detectVerdict` 改为否定词优先，已验证该用例判 false
- **AI 空响应被放行**：上游偶发返回 200 + 空字符串，原重试逻辑只在抛错时触发。现 `chat()` 判空抛错触发重试，`answerBatch()` 解析为空再重试一次
- **选项文本提取为空**：Ant Design 下选项文本挂在 `a.flex-container` 而非 `label`，`closest('label').innerText` 为空串。感知与勾选均改为 `a` 层定位
- **翻页按钮漏匹配**：「下一关」是 `<a class="ghost-link">` 而非 button。`clickByKeywords` 覆盖 button / link / 精确文本三级定位
- **过早读取空题干**：SPA 异步渲染导致翻页后立即 probe 拿到空内容。新增 `waitTaskReady()` 轮询等待题目区渲染完成

### Security

- `agent/.env.local`（API 密钥）、`agent/.browser-profile*`（浏览器登录态）、`agent/dumps/`、`agent/logs/` 均已在 `.gitignore` 中排除，不得提交

### Known Issues

- 浏览器须由用户双击 bat 启动：执行环境会清理命令派生的子进程，脚本启动的浏览器活不过命令边界（Edge/Chrome 均如此）
- Edge 启动增强会把新实例合并进已有实例并丢弃调试参数，故启动前必须关闭全部 Edge 进程
- Windows 保留端口区间内无法 bind 调试端口（本机 9137-9236 被保留），默认改用 9333 并自动顺延
- 代码题的编辑器写入已在策略上支持 Monaco/Ace/CodeMirror，但**尚未在真实代码题页面验证**
- 评测结果捕获依赖页面文本面板；若结果渲染在弹窗/图片中可能读不到（第 1 关联调时即出现此现象，提交实际成功但结果文本为空）

详见 `agent/docs/TROUBLESHOOTING.md`。

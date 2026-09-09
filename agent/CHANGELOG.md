# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [0.7.0] - 2026-09-09

评测后导航自愈 + AI 调用日志统一（真机反馈驱动）。

### Added

- **评测后自动返回题目页**：新增 `ensureTaskPage`（act.mjs）——评测后平台跳转到全屏「实际输出」结果页时，先抓结果页文本尾部作为反思证据，再按题目 URL 模式（`TASK_URL_PATTERN`）在浏览器上下文找回原题目页（bringToFront）或 `goBack` 后退；命令行/代码两分支失败路径接入，证据以「=== 评测结果页 ===」并入反思材料——不再需要用户手动返回
- **反思进度日志**：反思调用前预告静默期（与生成同款），完成输出耗时——消除"抓取明细后长时间无输出"的观感

### Changed

- **AI 调用日志统一**：四处调用点（生成命令/生成代码/命令反思/代码反思）统一为「正在调用 AI X（第 N 次）…推理模型可能需要 1~3 分钟」→「AI X 完成（第 N 次，…，耗时 X.Xs）」格式，实际耗时全部可见
- **推理模型预算再上调（复杂任务实测 8192 被思考独占耗尽）**：命令行生成/反思、代码生成/反思 8192/16384→**32768**，quiz 选择/批量 8192→16384，意图路由保持 8192——agnes-2.0-flash 对多集合文档操作类任务仅思考即可耗尽 8192，`finish_reason=length` 且 `content` 为空
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

# AGENTS.md

面向在此仓库工作的开发代理（Agent）的项目说明。

## 项目性质

**浏览器自动解题 Agent**：通过 CDP 连接用户已登录的 Edge/Chrome，自动感知评测网页上的题目，AI 生成答案后自动作答、提交评测、失败反思重试。

项目主体是 `agent/`（Node + playwright-core；不下载浏览器，走 CDP 连接用户自己的浏览器）。
早期版本另有一个手动粘贴式的 React 工作台前端，已于 2026-09-09 移除，历史版本见 git 提交 `3cc19d3`。

## 核心模块（`agent/src/`）

- `config.mjs` — 配置层，读 `agent/.env.local`
- `ai.mjs` — OpenAI 兼容调用 + `detectVerdict()` 加固版成功判定；`classifyProblemIntent()` 意图路由（code / cmdline / mixed）；`spliceIntoTemplate()` 模板拼接（标记按序归位 + 完整代码直通 + 标记不成对直通 + 缩进保留）；chat 流式思考控制（硬闸/停滞检测/字数配额/首轮关思考）；prompt 读 `shared/capabilities/*.json`（首次读取自动触发全量预检）
- `capability-schema.mjs` — 能力 JSON 加载前校验（必填字段、prompt 占位符 ⊆ paramsSchema.properties、required 一致性），防"占位符拼写错误静默渲染为空串"
- `browser.mjs` — `connectOverCDP` + 四级挑页链选目标标签页（`pickTargetPageWithMeta`：TARGET_URL_HINT → TASK_URL_PATTERN 形状 → 内容级特征 → 首个非空白；URL 层多命中报错防解错页；CDP 下 visibilityState 不可用，见 TROUBLESHOOTING C-4/C-11）+ 连接前临时摘除代理环境变量
- `task-url.mjs` — 题目页 URL 识别共享小模块（`taskKey`/`isTaskUrl`，正则编译带缓存；watch/lite 与挑页链共用 `TASK_URL_PATTERN` 单旋钮）
- `browser-session.mjs` — 常驻进程的浏览器会话管理（懒连接 + 互斥串行 + 断线重连），供 web-server 复用
- `control.mjs` — 运行控制层：`StopRequested` + `beginRun`/`endRun` + `requestStop`/`checkStop`/`isStopping` + `onStop` 订阅（在途 AI 请求 abort）+ `stopState`（供 `/api/status` 展示运行阶段）。停止请求有**轮次隔离**（记住"发出时跑的是第几轮"，只对该轮生效），中断是**协作式**的——靠各层检查点抛异常，不取消 playwright 调用
- `web-server.mjs` — 网页工作台（零新增依赖 node:http + 单文件原生前端，仅绑 127.0.0.1）：`GET /`、`GET /api/status`（每次请求比对 `.env.local` 模型差异热生效；含运行态 `run`）、`POST /api/probe`（只读）、`POST /api/solve`（真实提交；被停止时返回 HTTP 200 + `stopped:true`）、`POST /api/stop`（手动打断在途解题，**刻意不走浏览器互斥队列**）、`GET /api/logs`（环形缓冲增量轮询）、`/api/config`（页面写回模型名到 `.env.local`）
- `launch-browser.mjs` — 启动带调试端口的浏览器，含 Windows 保留端口区间自动顺延
- `perceive.mjs` — 页面感知：编辑器探测、题干提取、题型分类（选择/填空按结构信号；代码/命令行/混合由 AI 按题干意图判定）、按钮枚举、课程列表卡片/板块收集、终端环境识别（`detectTerminalEnv`：bash/mongosh/mysql/redis/psql/neo4j）、内容级判题（`looksLikeTaskPage`：强代码编辑器/评测面板标记/评测按钮，挑页链兜底用）
- `act.mjs` — 执行层：写入代码、勾选选项、点击评测、等待结果、翻页、课程导航（退出/返回/开始学习/跳转检测）、切换「命令行/代码文件」工作区标签、向 xterm 终端逐条键入命令、客户端可用性实测（`probeTerminalClients`）、shell 护栏清洗（`sanitizeShellSubmission`）
- `loop.mjs` — 编排：生成 → 评测 → 反思循环；`solveOnce` 整体包 `beginRun`/`endRun`（`endRun` 在 `finally`，成功/失败/被停止三态运行态都不悬空）并在各阶段埋 `checkStop` 检查点（意图判定、切工作区、每轮重试开头、**提交评测前**、反思调用前、重载题目页前）；`watchLoop` 常驻监听；`liteLoop` 刷新触发监听；`courseLoop` 课程自动驾驶；混合题先在命令行做数据准备（输入期报错反思自愈）再落代码分支；代码反思教训链（`lessons` 逐轮注入防横跳）与连续同类报错重载兜底（同一异常 ≥3 轮自动重载题目页重取原始模板，上限 2 次；1.4.3 起重载后先做 `looksLikeOwnDraft` 草稿判据，本平台拿回草稿即不覆盖存档并停用兜底——`slimForReflection` / `looksLikeOwnDraft` 为可单测的纯函数导出）
- `cli.mjs` — CLI 入口：`browser | my-edge | probe | dump | caps-check | once | run | watch | lite | course | course-probe | models`；`caps-check` 同时校验能力配置与平台事实档案（`capability-schema.mjs` + `platform-facts-schema.mjs`）
- `inspect-dom.mjs` — 只读 DOM 诊断脚本（关键字命中上下文扫描 + 评测面板结构核对，精调判定规则用）

## 常用命令（均在 `agent/` 目录下执行）

- `npm run probe` — 检查配置、浏览器连接与页面识别（**新平台接入必跑**）
- `npm run dump` — 导出页面结构快照到 `agent/dumps/`（写站点定制规则前先跑）
- `npm run caps-check` — 校验配置类 JSON（编辑 `shared/capabilities/` 或 `shared/platform-facts.json` 后先跑）：能力配置（占位符 ⊆ `paramsSchema.properties`、`required` 一致性）+ 平台事实档案结构（事实段必须带 evidence/date、推断类字样不得混入事实、待验证项只能在 `unknowns`）；`ai.mjs` 加载能力时也会自动预检能力配置
- `npm run once` — 只解当前一题；`npm run run` — 连续解题自动翻页；`npm run watch` — 常驻监听（推荐）；`npm run lite` — 刷新触发：刷新题目页即重做（含反思循环）
- `npm run my-edge` — 以"用户自己的 Edge 配置"重启并带调试端口（junction 绕过 136+ 默认目录限制，保留登录态；会先关闭运行中的 Edge）
- `npm run course` — 课程自动驾驶：遍历「课堂实验→板块→开始学习」逐关完成（前置：浏览器已打开课程列表页）
- `npm run course-probe` — 只读诊断课程列表页识别（不点击），course 卡住时先跑
- `npm run models` — 列出可用文本模型
- `npm run web` — 网页工作台 `http://127.0.0.1:8787`（仅本机可访问：探测 / 解题 / 日志流）
- Windows 用户入口：双击 `agent/start-my-edge.bat`（自己的 Edge）、`agent/start-browser.bat`（独立 profile）、`agent/start-watch.bat`、`agent/start-lite.bat`、`agent/start-course.bat`、`agent/start-web.bat`（网页工作台）

## 约束

- **prompt 单一数据源**：AI 行为的 prompt 只存在于 `shared/capabilities/*.json`，agent 直接读取并渲染 `{{input.xxx}}`。**不得在 agent 内复制 prompt 造成两份漂移**。改 AI 行为优先改 JSON，而非代码。
- **不硬编码站点 selector**：识别全部走通用启发式（编辑器按 Monaco/Ace/CodeMirror/textarea 优先级探测；题干取排除编辑器后最长且偏左的文本块）。针对具体平台调整前先 `npm run dump` 拿真实结构，不要凭假设写规则。
- **数据库/命令行题的环境事实靠实测，不靠模型记忆**：客户端存在性（mongosh/mongo/mysql/redis-cli/psql）与终端形态（bash/REPL）一律实测后进 prompt，缺失客户端做执行层别名替换；**混合题先命令行插入题面文档到指定库（评测环境共享终端数据库，未插入则查询结果为空），代码栏数据库命令题用 `echo "` 双引号包裹裸查询（分号 `;` 分隔、`$`→`\$`）**——平台对代码栏双重执行（bash 环节 + 提取 echo 引号内容做数据库 eval），heredoc/裸语句/`mongo` 前缀实测全失败（1.0.0 生成/反思守则）。
- **写入优先编辑器 API，键盘为回退**：Monaco/CodeMirror5 先 `model.setValue`/`cm.setValue`（触发内容变化事件、平台自动保存不受影响，且字节级精确——实测 Monaco 的 formatOnPaste/autoIndent 会把 insertText 进来的预缩进 Python 逐行重排致评测不匹配）；API 不可用再走 `点击 → Ctrl+A → Delete → insertText`；写入后回读验证；写完点编辑器外部并静置。
- **模板拼接以原始模板为权威 + 兜底直通**：代码题写入 = `spliceIntoTemplate(原始模板, AI 输出)`——仅替换 Begin/End 标记间代码体（按序逐对）、保留行首缩进；**标记不成对或 AI 输出为完整代码（≥2 个模块级语句）时整体直通**（平台只按执行结果评测，宁可整体写入 AI 完整实现，绝不按不可信标记丢函数）；模板存档在函数作用域，连续同类报错 ≥3 轮自动重载题目页重取平台原始模板（1.3.0，购物车/令牌题 IndentationError 死循环根治）——**但该兜底的前提是"重载后编辑器恢复为原始模板"**：EduCoder 系平台持久化草稿、无「恢复初始代码」，重载只能拿回上一轮自提交的草稿，故 1.4.3 加重载后草稿判据（`looksLikeOwnDraft`），命中则保留原存档并停用兜底，绝不拿草稿覆盖干净模板。
- **浏览器连接**：连不上调试端口时自动拉起独立 profile 浏览器（`AUTO_LAUNCH=0` 关闭）；要接管"用户自己的 Edge"须用 `my-edge`（junction 绕过 136+ 默认目录禁令，且必须先关闭运行中的实例——同 profile 旧实例会合并新命令）。沙箱/受限执行环境里脚本拉起的浏览器活不过命令边界，需由资源管理器（双击 bat）启动。
- **手动停止是「协作式中断」，不是 Promise 取消**：中断只能靠 `control.mjs` 的 `checkStop` 在检查点抛 `StopRequested`（playwright 调用无法安全取消，硬断会留下半写入的编辑器/半条命令）。因此**新增长时间等待或新循环时必须补检查点**，否则工作台的「停止做题」会卡到该步骤自然结束；`/api/stop` 不得改走 `withBrowserSession`（队列被在途解题占着，排队等于"点了没反应"）；`beginRun`/`endRun` 必须成对出现（`endRun` 放 `finally`），否则运行态悬空会让按钮永远停在"运行中"。
- **平台事实优先于模型记忆（含 Python 库 API 与运行环境）**：优先级链 = 平台报错回显/实测 > 题面示例写法 > 模板已有代码形态 > 题面描述 > "官方文档/最新版本"的模型记忆；冲突一律以前者为准。教学平台的运行环境常显著落后（**实测 2026-09-20**：Python 2 + 旧版 redis-py——`zadd(key, member, score)` 是「先成员后分值」与 Redis 官方文档相反、`open()` 不接受 `encoding=`、字典式 `zadd(key,{member:score})` 直接报 `ZADD requires an equal number of values and scores`、`int('0\n')` 才能容错换行）。既有原则「数据库/命令行题的环境事实靠实测不靠模型记忆」此前只覆盖 CLI 客户端，**现已扩展到 Python API 形态与运行环境**；prompt 侧对应生成器第 24 条 / 反思器第 11 条。边界：该优先级只用于「接口形态/语法/环境/输出格式/数据格式」；**算法逻辑与题面明文要求仍须正确实现**，不得以"更合理"为名偏离题面。
- **平台事实单一数据源 = `shared/platform-facts.json`**：所有"平台实测事实"（运行时版本、库 API 形态、评测比对方式、编辑器行为）**只在这里维护**，由 `ai.mjs` 的 `buildPlatformFactsBlock()` 统一注入到每个能力 prompt 末尾（`readCapability` 是唯一注入点，新增能力自动继承）。规则：① 只写实测过的条目，必须带 evidence 与 date；② 推断/待验证写进 `unknowns`，不得混入事实；③ 不缓存、每次读盘（改完即刻生效）；④ 缺文件/坏 JSON 只降级告警，不阻断主流程。**新增事实一律加在这里，不要再散落成 prompt 规则**。
- **prompt 规则默认「通用」，限定作用域必须写明理由**：一条只写给某类任务的好规则，在其他任务里等于不存在。本项目已**两次**栽在同一处——生成器规则 10 与反思器规则 1 都曾把"预期输出不是你要输出的内容"限定为「命令类 / shell 类评测」，于是 Python 代码题（自动补全）里模型合理地判定该规则与本题无关，自己在函数里 print 了评测程序要打印的行，连续多轮反思都在改逻辑、真凶却是多打的 print。**新增规则一律先按通用写；确实只适用某类的，在规则内显式说明适用范围与原因**，并优先考虑把"事实"下沉到 `shared/platform-facts.json`（事实天然通用）。
- **安全**：端点 / 密钥 / 模型名等个人配置只允许存在于 `agent/.env.local`（已被 .gitignore 排除），源码与 `.env.example` 中不得出现真实值；`agent/.browser-profile*/`（登录态）、`agent/dumps/`（含个人信息的页面快照）、`agent/logs/` 同样严禁提交。
- **如实标注验证边界**：未验证的能力不得在文档中声称可用。

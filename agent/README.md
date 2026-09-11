# 浏览器自动解题 Agent

> 配套文档：变更日志见 [`CHANGELOG.md`](CHANGELOG.md)；环境与代码踩坑记录见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。AI 能力配置（prompt）的单一数据源在仓库根 `shared/capabilities/`，说明见其目录 README。

连接你已登录的 Edge/Chrome，自动读取评测页面上的题目要求、在编辑器写入答案、点击评测、读取结果、失败后反思重试、通过后翻到下一题。

各层职责：

| 层 | 位置 | 职责 |
|---|---|---|
| AI 能力定义 | 仓库根 `shared/capabilities/*.json` | prompt 单一数据源，Agent 直接读取复用 |
| 浏览器执行层 | 本目录 `agent/` | 感知页面、自动作答、点评测、翻页、反思循环 |
| 用户入口 | `start-my-edge.bat` / `start-browser.bat` / `start-watch.bat` / `start-lite.bat` / `start-course.bat` | 用自己的 Edge 启动、独立 profile 启动、常驻监听、刷新触发、课程自动驾驶 |

## 前置条件

- Node.js 18+（用到内置 `fetch`）
- Edge 或 Chrome（Edge 已实测可用，路径自动探测）

## 首次使用

```bash
cd agent
npm install

# 1. 配置密钥
cp .env.example .env.local   # 然后编辑 .env.local 填入 AI_API_KEY

# 2. 启动带调试端口的浏览器，二选一：
#    - 双击 start-my-edge.bat：重启"你自己的 Edge"（账号/历史/插件全保留，推荐）
#    - 双击 start-browser.bat：全新独立 profile（首次需重新登录各站点）
#    偷懒方案：不启动也行，直接看第 4 步——watch 连不上会自动拉起浏览器

# 3. 在弹出的浏览器里登录评测网站，打开任意一道题目页

# 4. 回到终端，检查识别情况
npm run probe
```

> **关键坑**：`--remote-debugging-port` 必须与**独立的 `--user-data-dir`** 配合使用。
> Chromium 系浏览器若发现同 profile 已有实例在跑，会把新启动命令转交给已有进程，
> 导致调试端口实际不生效。`npm run browser` 已自动处理（profile 位于 `agent/.browser-profile`）。
> 代价是该 profile 是全新的，**需要重新登录一次**，之后登录态持久保存，无需重复登录。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run browser` | 启动带调试端口的浏览器（独立 profile） |
| `npm run my-edge` | **重启"你自己的 Edge"并带调试端口**：junction 绕过 136+ 默认目录限制，账号/历史全保留（会先关闭正在运行的 Edge，3 秒倒计时） |
| `npm run probe` | 检查配置 + 页面识别情况（**首次必跑**，用于确认题目和编辑器被正确识别） |
| `npm run dump` | 导出页面结构快照到 `agent/dumps/*.json`，用于针对具体站点精调识别规则 |
| `npm run caps-check` | 校验能力配置 JSON：必填字段、prompt 占位符与 `paramsSchema` 声明一致性（编辑 `shared/capabilities/` 后先跑） |
| `npm run once` | 只解当前这一题 |
| `npm run run` | 连续解题，通过后自动点「下一关」翻页 |
| `npm run watch` | **常驻监听**：切到新题目页就自动作答（推荐，导航权在你手里） |
| `npm run lite` | **刷新触发**：刷新题目页即重新作答，同一题可反复重做（见下方专节） |
| `npm run course` | **课程自动驾驶**：遍历「课堂实验→板块→开始学习」，逐关作答直至板块做完（见下方专节） |
| `npm run course-probe` | 只读诊断课程列表页：打印识别到的板块/卡片并导出快照，**course 卡住时先跑这个** |
| `npm run models` | 列出可用文本模型 |
| `npm run mcp` | 以 stdio 启动 MCP Server：把解题能力暴露给 ZCode / Claude Desktop 等宿主（见下方「MCP 接入」） |
| `npm test` | 运行核心纯函数单测（29 项，Node 内置 `node:test`，零新增依赖） |
| `npm run lint` | ESLint 静态检查（`eslint.config.js`） |
| `npm run format` | 按 Prettier 风格格式化 `src/` 与 `test/` |
| `npm run format:check` | 只检查格式不写入，适合放进 CI |

## 日志

统一由 `src/logger.mjs` 输出：控制台保持 `[模块] 消息` 形态，同时**落盘到 `logs/agent-<日期>.log`**（含时间戳与 INFO/WARN/ERROR 级别）。常驻模式（watch / lite）跑完关掉窗口后仍可回溯。设 `LOG_TO_FILE=0` 可关闭落盘。设 `LOG_STREAM=stderr` 可把控制台输出切到 stderr（MCP Server 已内置，stdout 必须专用于 JSON-RPC）。

## MCP 接入

`npm run mcp` 以 stdio 传输启动 MCP Server（`src/mcp-server.mjs`），把解题能力暴露为三个工具，供 MCP 宿主（ZCode / Claude Desktop / Cursor 等）调用：

| 工具 | 作用 | 风险 |
|---|---|---|
| `probe_page` | 只读感知当前评测页（题型 / 编辑器 / 题干摘要 / 可点击元素） | 只读 |
| `solve_current_task` | 解当前题：感知 → AI 生成/作答 → 提交评测 → 失败反思重试 | **会真实提交评测** |
| `list_models` | 列出 AI 端点可用文本模型 | 只读 |

宿主配置示例（stdio，路径按实际仓库位置修改）：

```json
{
  "mcpServers": {
    "miaoda-agent": {
      "command": "node",
      "args": ["D:\\path\\to\\miaoda-code-completion-assistant\\agent\\src\\mcp-server.mjs"]
    }
  }
}
```

设计边界（v1）：编排（生成 → 评测 → 反思循环）留在 agent 侧，不暴露原子浏览器操作与 chat 原语（`act.mjs` 的领域适配是核心资产）；工具调用全进程串行（一次只做一题）；浏览器连接懒建立、跨调用复用，CDP 断开自动重连（`browser.close()` 对 CDP 连接仅断开、不杀浏览器进程）；`courseLoop` 跑批暂不暴露。

验证边界：stdio 协议握手、`tools/list`、`tools/call`（list_models 实调 AI 端点）与「EOF 排空后退出」均已实测；`probe_page` / `solve_current_task` 依赖真实浏览器（带调试端口且已登录评测站），请在宿主中实测。

## 配置项（`agent/.env.local`）

| 变量 | 说明 | 默认 |
|---|---|---|
| `AI_BASE_URL` | OpenAI 兼容端点（含 `/v1`），必填 | 无默认，统一在 `.env.local` 配置 |
| `AI_API_KEY` | 密钥，必填 | 无默认 |
| `AI_MODEL` | 模型名，`npm run models` 查看全部，必填 | 无默认 |
| `AI_TEMPERATURE` | 采样温度 | `0.3` |
| `AI_MAX_TOKENS` | 单次生成的最大 token 数 | `8192` |
| `AI_REASONING_EFFORT` | 推理分级：`low` / `medium` / `high`（medium 实测思考有界且多步命令完整；off 会漏多步要求） | `medium` |
| `AI_ENABLE_THINKING` | `1` = 开启思考走分级；`0` = 思考全关（极简任务） | `1` |
| `AI_THINKING_CAP_MS` | 思考硬闸：流式响应"仍在思考、正文 0 字"持续超时即断流并重试关思考；`0` = 不设限 | `20000` |
| `AI_TIMEOUT_MS` | 单次 AI 请求超时，端点挂起按失败重试，避免 loop 永久停摆 | `300000` |
| `DEBUG_PORT` | 调试端口 | `9333` |
| `CDP_ENDPOINT` | CDP 连接地址，留空由 `DEBUG_PORT` 拼出 | `http://127.0.0.1:9333` |
| `USER_DATA_DIR` | 独立 profile 目录（须与日常使用 profile 隔离，否则调试端口不生效） | `agent/.browser-profile` |
| `EDGE_PATH` / `BROWSER_PATH` | 浏览器路径，留空自动探测 | 自动 |
| `TARGET_URL_HINT` | 评测页 URL 特征片段，多标签页时用于定位 | 留空取第一个 |
| `AUTO_LAUNCH` | 连不上调试端口时自动拉起浏览器（独立 profile） | `1` |
| `WATCH_POLL_MS` | watch/lite：标签页轮询间隔 | `2000` |
| `TASK_URL_PATTERN` | 题目页 URL 正则（换平台改这里） | `/tasks/[^/]+/\d+/[A-Za-z0-9]+` |
| `READY_TIMEOUT_MS` | 等题目区渲染完成的超时 | `15000` |
| `MAX_RETRY` | 单题最大反思重试次数 | `10` |
| `EVAL_TIMEOUT_MS` | 等待评测结果上限 | `25000` |
| `COOLDOWN_MS` | 每题间隔，避免触发平台风控 | `1500` |
| `TERMINAL_TYPE_DELAY_MS` | 命令行题：每字符键入延迟 | `10` |
| `TERMINAL_GAP_MIN_MS` / `TERMINAL_GAP_MAX_MS` | 命令行题：回车后等提示符返回的最短/最长时间（自适应） | `200` / `2500` |
| `MAX_TASKS` | 连续解题上限，`0` 不限 | `0` |
| `DRY_RUN` | `1` = 只感知与生成，不写入不点击 | `0` |
| `NAV_TIMEOUT_MS` | course：点「下一关」后等待跳转上限 | `10000` |
| `LIST_TIMEOUT_MS` | course：退出/返回后等列表页重现上限 | `15000` |
| `MAX_BOARDS_PER_SECTION` | course：单板块处理卡片数防呆上限 | `50` |
| `LOG_STREAM` | 控制台日志输出流；设 `stderr` 用于常驻协议进程（MCP Server 内置切换，stdout 专用于 JSON-RPC） | 未设置（stdout） |

## 工作流程

```
probe（感知）→ 生成/作答 → 写入编辑器 → 静置保存 → 点击评测
      ↑                                                    │
      └──────── 失败：reflectAndFix 反思修复 ←── 未通过 ─────┤
                                                           │
                                              通过 → 点击下一题 → 回到 probe
```

- **题型自动分类**：选择题/填空题按结构信号识别（`choice` 检测到 radio/checkbox、`blank` 检测到文本输入框）；代码题、**命令行题**与**混合题**先读左侧题干做 **AI 意图判定**（`task_router_1`：`code` 写代码文件 / `cmdline` 敲命令 / `mixed` 先命令行数据准备再写代码栏），判定后自动切换到对应工作区 tab 再执行
- **代码题**：生成 → 评测 → 失败则带着「题目 + 上一版代码 + 评测输出」反思修复 → 重评，最多 `MAX_RETRY` 次
- **命令行题**（头歌类平台的数据库/运维任务）：生成命令序列 → 逐条真实键入 xterm 终端（每条回车后自适应等提示符返回，`TERMINAL_GAP_MIN_MS`~`TERMINAL_GAP_MAX_MS`；含中文的命令由执行层合成 paste 事件直入 xterm 保证键入保真，纯 ASCII 走键盘逐字符）→ 评测；未通过时由 `cmdline_reflection_fixer_1` 结合评测输出重新生成完整命令序列再重试。bash 环境且题干涉数据库时，先实测客户端可用性（mongosh 是否存在这类硬事实进 prompt、缺失者入禁令并执行层别名替换），避免子命令被敲进 bash
- **混合题**（如「先命令行插入文档、再代码栏写查询」）：**先命令行插入题面文档到指定库（必需，1.0.0 实测评测环境共享终端数据库、未插入则查询结果为空）**，再落入代码分支作答；代码栏数据库命令题用 `echo "` 双引号包裹裸查询（分号 `;` 分隔、`$`→`\$`，1.0.0 生成/反思守则——平台对代码栏双重执行：bash 环节 + 提取 echo 引号内内容做数据库 eval）
- **选择题/填空题**：直接作答后评测；当前版本不做多轮反思

## 常驻监听模式（推荐用法）

启动：`npm run watch`，或双击 `start-watch.bat`。

- 程序**一直运行**，每 2 秒检查一次浏览器的所有标签页
- 你手动切到哪个题目页，它就自动做哪一题（勾选 + 点击「评测」）
- **它不会替你点「下一关」**——导航权始终在你手里
- 启动时**当前已打开的题目页会立即作答**；作答过的页面（按 URL 去重）不重复作答

适用：想自己控制进度，只把「读题 + 选答案 + 点评测」这一步自动化。

识别规则由 `TASK_URL_PATTERN` 决定，默认匹配 `/tasks/<courseId>/<num>/<slug>`。
换平台时改 `.env.local` 里的这个正则即可。

> 实测注意：CDP 连接下所有标签页的 `document.visibilityState` **全部返回
> `visible`**，无法据此判断"用户正在看哪个标签"。因此改为遍历所有标签页 +
> URL 去重的方案。

## 刷新触发模式（lite）

启动：`npm run lite`，或双击 `start-lite.bat`。

- 程序**一直运行**，轮询所有标签页；**刷新任意题目页（F5）即重新自动作答**
- 做题流程与 watch 完全一致：生成 → 评测 → 失败反思修复 → 重评（最多 `MAX_RETRY` 轮）
- 与 watch 的区别：watch 按 URL 去重，同一题只做一次；**lite 每次刷新都重做**——
  反思重试仍未通过时，F5 即可让 agent 换个思路重新完整做一遍
- 同样**不替你点「下一关」**，导航权在你手里

适用：想让 agent 自动重试同一道题（刷新 = 人工触发的重做），而不是自动翻页推进。

实现说明：在页面 `window` 上注入 `__liteHandled` 标记，刷新会销毁执行环境、
标记随之消失，轮询据此判定"这是一次新的刷新"。SPA 软导航不销毁 `window`，
不会误触发。轮询间隔复用 `WATCH_POLL_MS`。

## 课程自动驾驶模式（course）

启动：`npm run course`，或双击 `start-course.bat`。**前置**：先在受控浏览器里打开「课堂实验」列表页（有「开始学习」卡片的那一页）。

全自动完成一整个课程的实验，流程与你手工操作一致：

1. 读取左侧「课堂实验」下的板块菜单，逐个点开
2. 每个板块下逐张卡片点「开始学习」（进度 `n/n` 已全部完成的自动跳过）
3. 进入小板块后逐关作答：评测通过 → 点「下一关」
4. 点「下一关」后 URL 与关卡序号**都没有变化** → 判定本小板块做完
5. 点任务页右上角「退出」→ 作业详情页左上角返回箭头 → 回列表继续下一块

边界与注意（如实标注）：

- 「退出」是电源图标（无文字），按 `title/aria/class` 启发式定位；返回箭头找不到时自动退化为浏览器后退
- 点「开始学习」后若落在作业详情页，会自动点「继续挑战」进入关卡；若新开标签页，则在新页作答后自动关闭
- 若某关最终未通过（`MAX_RETRY` 次反思后仍失败），平台通常不放开「下一关」入口，循环自然终止并跳到下一块
- **course 模式尚未端到端验证**。列表卡片/板块菜单/退出图标均为通用启发式识别，首次运行前建议先在列表页 `npm run dump` 确认结构；识别不准时把 dump 结果反馈后精调规则

## 平台兼容性

- **支持任意 EduCoder 系平台**：学校私有部署（如 `172.22.226.31`）与官方 [`www.educoder.net`](https://www.educoder.net) 共用同一套 TPI 任务页前端，识别全部基于 URL 路径与页面启发式、**与域名无关**（默认 `TASK_URL_PATTERN` 同时匹配两种站点的 `/tasks/<id>/<num>/<slug>`）
- **硬前提——调试浏览器对每个平台登录一次**：实测 educoder.net 任务页对未登录状态渲染空白壳（无跳转、无提示）。`start-browser.bat` 的独立 profile 登录态持久保存，每个新站点登录一次即可；watch 遇到空白页会打日志提示
- 结果判定兼容 EduCoder 文风（“测试集1 通过”这类裸「通过」也判通过；否定词如“未通过/不匹配”仍优先短路）

## 设计要点

1. **prompt 单一数据源**：Agent 直接读取仓库根 `shared/capabilities/*.json` 中的 prompt 并渲染 `{{input.xxx}}` 占位符，不在 Agent 里复制 prompt，避免两份漂移。题型分流：选择/填空按结构信号分类（`classifyTask`），代码/命令行由 `task_router_1.json` 按题干意图判定后分流至各自生成与反思配置。加载前自动校验配置（必填字段、占位符 ⊆ `paramsSchema.properties`、`required` 一致性，`src/capability-schema.mjs`）——占位符拼写错误此前会静默渲染为空串，现启动即报。
2. **成功判定加固**：朴素 `includes` 匹配会让 `"未通过"` 命中 `"通过"`、`"AC"` 命中任意含 ac 的英文单词。Agent 的 `detectVerdict` 改为**否定词优先短路 + 整词匹配**，不确定时一律判未通过；否定词筛完后裸「通过」也判通过（兼容 EduCoder 的「测试集1 通过」文风）。
3. **模板拼接防格式错**：代码题写入前以**编辑器原始模板**为权威，把 AI 代码体拼回 Begin/End 标记之间（`spliceIntoTemplate`），平台脚手架字节级不变——不依赖 AI 完整复现标记。
4. **写入优先编辑器 API，键盘为回退**：Monaco/CodeMirror5 先 `setValue`（触发 change 事件与平台自动保存、字节级精确）；实测 Monaco 的 formatOnPaste/autoIndent 会把 insertText 进来的预缩进 Python 逐行重排致评测不匹配，故 API 不可用才退回 `点击 → Ctrl+A → Delete → insertText`。直接改 DOM 常导致平台评测到旧代码（本约束本意）。
5. **写入后静置**：写完后点击编辑器外部并等待 `COOLDOWN_MS`，触发平台自动保存。
6. **不硬编码站点 selector**：全部走启发式识别，换平台无需改代码；识别不准时用 `npm run dump` 导出快照再加规则。文本比对前统一剔除图标字体私有区字符（`clean()`），避免"开始学习"这类按钮匹配失败。
7. **数据库/命令行题的环境事实靠实测，不靠模型记忆**：bash 环境且题干涉数据库时先 `probeTerminalClients` 实测客户端可用性（mongosh 不存在、仅 mongo 可用这类硬事实进 prompt），缺失客户端入【实测禁令】并做执行层别名替换（`mongosh`→`mongo`）；命令写前过 shell 护栏清洗（中文标签行/全角分号）；生成与反思前各探测一次终端环境（bash/mongosh/mysql/redis/psql/neo4j），环境书写约束注入 prompt。
8. **代码栏数据库命令题按题面转义守则输出**：平台可能把代码栏内容当 shell 脚本执行（真机事故：裸 `db.educoder.aggregate([{$limit:3}])` 被 `query.sh` 用 bash 执行报 syntax error）。生成/反思 prompt 均内置守则——题面给转义说明（如「$ 前加转义符 \」）时严格照做（`$`→`\$`），并提示终端不可用时混合题跳过数据准备。

## 已知限制与边界（如实标注）

- **接管"你自己的浏览器"的限制**：调试端口必须在浏览器**启动时**带上，正在运行的普通 Edge 无法被事后接入；且 Chromium/Edge 136+ 禁止在**默认**用户目录上开调试端口。`my-edge` 命令用目录联接（junction，无需管理员）绕过后者——以联接路径加载你的真实配置。注意三点：① 会先关闭正在运行的 Edge（3 秒倒计时，标签页可会话恢复）；② 之后**从任务栏正常打开的 Edge 不带端口**，接管前需重跑本命令；③ 连不上调试端口时 watch/course 会自动拉起独立 profile 浏览器兜底（可用 `AUTO_LAUNCH=0` 关闭）
- **调试端口避开 Windows 保留区间**：本机 `9137-9236` 被系统保留，使用 9222 会触发 `bind() ... (0x271D)` 且 devtools 无法启动。现在默认 9333，启动脚本还会读 `netsh` 保留区间自动顺延。
- **连接时强制绕过代理**：环境若配置了 `http_proxy`，Playwright 的 `connectOverCDP` 会走代理去连 127.0.0.1 并返回 502（此时浏览器其实是好的）。连接层已做临时摘除代理变量处理。
- **真实站点验证程度**：已在真实 EduCoder 站点（校内私有部署）完成第 1 关代码题端到端联调（自动提交成功），课程列表页采集亦经真实页面回归验证（9 卡片 / 17 板块）。页面识别规则仍基于通用启发式，**新平台/新题型首次使用大概率需要 `npm run dump` 后针对性调整**。
- **题型覆盖不完整**：选择题与填空题目前只做单轮作答，未实现失败反思；多空填空题按换行分隔的约定依赖模型遵循指令，存在模型不按格式输出的风险。
- **混合题依赖终端可用与命令行插入**：混合题（先命令行插入、再代码栏作答）数据准备失败且反思自愈两轮用尽时按当前状态继续；**评测环境共享终端数据库，题面要求「先在命令行插入文档」是必需步骤，未插入则代码栏查询结果为空**（1.0.0 实测）；平台对代码栏双重执行（bash + 数据库 eval），代码栏数据库命令题需 `echo "` 双引号包裹裸查询（分号分隔、`$`→`\$`）——生成/反思守则已覆盖（1.0.0），但遇到平台自定义执行形态仍需按实测调整。
- **编辑器写入策略**在部分自研编辑器（非 Monaco/Ace/CodeMirror/textarea）上可能失效，此时 `probe` 会显示「编辑器：未识别」。
- **评测结果捕获**依赖页面上存在含「评测/测试/结果/输出」等关键词的面板；若平台把结果渲染在 canvas 或图片里，无法读取。
- **平台合规**：自动提交与自动翻页作用于你的真实账号，是否违反目标平台的使用条款需你自行评估。本工具不绕过任何登录校验，仅操作你已登录的页面。

## 安全与隐私

配置统一原则：**端点、密钥、模型名等一切个人配置只存在于 `.env.local`**，源码与模板文件（`.env.example`）中不落真实值。

以下路径已被根 `.gitignore` 排除，**严禁提交**：

- `agent/.env.local` — API 端点与密钥
- `agent/.browser-profile*/` — 浏览器独立 profile，含评测平台登录 Cookie
- `agent/dumps/` — 页面结构快照，含姓名、学号等个人信息
- `agent/logs/` — 浏览器与运行日志，可能含页面 URL 与个人数据

首次接入新平台建议先设 `DRY_RUN=1` 跑一轮，确认识别与生成正确后再关闭。

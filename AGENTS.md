# AGENTS.md

面向在此仓库工作的开发代理（Agent）的项目说明。

## 项目性质

**浏览器自动解题 Agent**：通过 CDP 连接用户已登录的 Edge/Chrome，自动感知评测网页上的题目，AI 生成答案后自动作答、提交评测、失败反思重试。

项目主体是 `agent/`（Node + playwright-core；不下载浏览器，走 CDP 连接用户自己的浏览器）。
早期版本另有一个手动粘贴式的 React 工作台前端，已于 2026-09-09 移除，历史版本见 git 提交 `3cc19d3`。

## 核心模块（`agent/src/`）

- `config.mjs` — 配置层，读 `agent/.env.local`
- `ai.mjs` — OpenAI 兼容调用 + `detectVerdict()` 加固版成功判定；`classifyProblemIntent()` 意图路由（code / cmdline / mixed）；prompt 读 `shared/capabilities/*.json`（首次读取自动触发全量预检）
- `capability-schema.mjs` — 能力 JSON 加载前校验（必填字段、prompt 占位符 ⊆ paramsSchema.properties、required 一致性），防"占位符拼写错误静默渲染为空串"
- `browser.mjs` — `connectOverCDP` + 多标签页遍历（连接前临时摘除代理环境变量）
- `browser-session.mjs` — 常驻进程的浏览器会话管理（懒连接 + 互斥串行 + 断线重连），供 mcp-server 等复用
- `mcp-server.mjs` — MCP Server 入口（stdio）：`probe_page` / `solve_current_task` / `list_models` 三工具；编排留在 agent 侧，不暴露原子浏览器操作与 chat 原语
- `launch-browser.mjs` — 启动带调试端口的浏览器，含 Windows 保留端口区间自动顺延
- `perceive.mjs` — 页面感知：编辑器探测、题干提取、题型分类（选择/填空按结构信号；代码/命令行/混合由 AI 按题干意图判定）、按钮枚举、课程列表卡片/板块收集、终端环境识别（`detectTerminalEnv`：bash/mongosh/mysql/redis/psql/neo4j）
- `act.mjs` — 执行层：写入代码、勾选选项、点击评测、等待结果、翻页、课程导航（退出/返回/开始学习/跳转检测）、切换「命令行/代码文件」工作区标签、向 xterm 终端逐条键入命令、客户端可用性实测（`probeTerminalClients`）、shell 护栏清洗（`sanitizeShellSubmission`）
- `loop.mjs` — 编排：生成 → 评测 → 反思循环；`watchLoop` 常驻监听；`liteLoop` 刷新触发监听；`courseLoop` 课程自动驾驶；混合题先在命令行做数据准备（输入期报错反思自愈）再落代码分支
- `cli.mjs` — CLI 入口：`browser | my-edge | probe | dump | caps-check | once | run | watch | lite | course | course-probe | models`
- `inspect-dom.mjs` — 只读 DOM 诊断脚本（关键字命中上下文扫描 + 评测面板结构核对，精调判定规则用）

## 常用命令（均在 `agent/` 目录下执行）

- `npm run probe` — 检查配置、浏览器连接与页面识别（**新平台接入必跑**）
- `npm run dump` — 导出页面结构快照到 `agent/dumps/`（写站点定制规则前先跑）
- `npm run caps-check` — 校验能力配置 JSON（编辑 `shared/capabilities/` 后先跑；`ai.mjs` 加载时也会自动预检）
- `npm run once` — 只解当前一题；`npm run run` — 连续解题自动翻页；`npm run watch` — 常驻监听（推荐）；`npm run lite` — 刷新触发：刷新题目页即重做（含反思循环）
- `npm run my-edge` — 以"用户自己的 Edge 配置"重启并带调试端口（junction 绕过 136+ 默认目录限制，保留登录态；会先关闭运行中的 Edge）
- `npm run course` — 课程自动驾驶：遍历「课堂实验→板块→开始学习」逐关完成（前置：浏览器已打开课程列表页）
- `npm run course-probe` — 只读诊断课程列表页识别（不点击），course 卡住时先跑
- `npm run models` — 列出可用文本模型
- `npm run mcp` — 以 stdio 启动 MCP Server，宿主接入配置见 `agent/README.md`「MCP 接入」
- Windows 用户入口：双击 `agent/start-my-edge.bat`（自己的 Edge）、`agent/start-browser.bat`（独立 profile）、`agent/start-watch.bat`、`agent/start-lite.bat`、`agent/start-course.bat`

## 约束

- **prompt 单一数据源**：AI 行为的 prompt 只存在于 `shared/capabilities/*.json`，agent 直接读取并渲染 `{{input.xxx}}`。**不得在 agent 内复制 prompt 造成两份漂移**。改 AI 行为优先改 JSON，而非代码。
- **不硬编码站点 selector**：识别全部走通用启发式（编辑器按 Monaco/Ace/CodeMirror/textarea 优先级探测；题干取排除编辑器后最长且偏左的文本块）。针对具体平台调整前先 `npm run dump` 拿真实结构，不要凭假设写规则。
- **数据库/命令行题的环境事实靠实测，不靠模型记忆**：客户端存在性（mongosh/mongo/mysql/redis-cli/psql）与终端形态（bash/REPL）一律实测后进 prompt，缺失客户端做执行层别名替换；**混合题先命令行插入题面文档到指定库（评测环境共享终端数据库，未插入则查询结果为空），代码栏数据库命令题用 `echo "` 双引号包裹裸查询（分号 `;` 分隔、`$`→`\$`）**——平台对代码栏双重执行（bash 环节 + 提取 echo 引号内容做数据库 eval），heredoc/裸语句/`mongo` 前缀实测全失败（1.0.0 生成/反思守则）。
- **写入优先编辑器 API，键盘为回退**：Monaco/CodeMirror5 先 `model.setValue`/`cm.setValue`（触发内容变化事件、平台自动保存不受影响，且字节级精确——实测 Monaco 的 formatOnPaste/autoIndent 会把 insertText 进来的预缩进 Python 逐行重排致评测不匹配）；API 不可用再走 `点击 → Ctrl+A → Delete → insertText`；写入后回读验证；写完点编辑器外部并静置。
- **浏览器连接**：连不上调试端口时自动拉起独立 profile 浏览器（`AUTO_LAUNCH=0` 关闭）；要接管"用户自己的 Edge"须用 `my-edge`（junction 绕过 136+ 默认目录禁令，且必须先关闭运行中的实例——同 profile 旧实例会合并新命令）。沙箱/受限执行环境里脚本拉起的浏览器活不过命令边界，需由资源管理器（双击 bat）启动。
- **安全**：端点 / 密钥 / 模型名等个人配置只允许存在于 `agent/.env.local`（已被 .gitignore 排除），源码与 `.env.example` 中不得出现真实值；`agent/.browser-profile*/`（登录态）、`agent/dumps/`（含个人信息的页面快照）、`agent/logs/` 同样严禁提交。
- **如实标注验证边界**：未验证的能力不得在文档中声称可用。

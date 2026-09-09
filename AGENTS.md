# AGENTS.md

面向在此仓库工作的开发代理（Agent）的项目说明。

## 项目性质

**浏览器自动解题 Agent**：通过 CDP 连接用户已登录的 Edge/Chrome，自动感知评测网页上的题目，AI 生成答案后自动作答、提交评测、失败反思重试。

项目主体是 `agent/`（Node + playwright-core；不下载浏览器，走 CDP 连接用户自己的浏览器）。
早期版本另有一个手动粘贴式的 React 工作台前端，已于 2026-09-09 移除，历史版本见 git 提交 `3cc19d3`。

## 核心模块（`agent/src/`）

- `config.mjs` — 配置层，读 `agent/.env.local`
- `ai.mjs` — OpenAI 兼容调用 + `detectVerdict()` 加固版成功判定；prompt 读 `shared/capabilities/*.json`
- `browser.mjs` — `connectOverCDP` + 多标签页遍历（连接前临时摘除代理环境变量）
- `launch-browser.mjs` — 启动带调试端口的浏览器，含 Windows 保留端口区间自动顺延
- `perceive.mjs` — 页面感知：编辑器探测、题干提取、题型分类（选择/填空按结构信号；代码/命令行由 AI 按题干意图判定）、按钮枚举、课程列表卡片/板块收集
- `act.mjs` — 执行层：写入代码、勾选选项、点击评测、等待结果、翻页、课程导航（退出/返回/开始学习/跳转检测）、切换「命令行/代码文件」工作区标签、向 xterm 终端逐条键入命令
- `loop.mjs` — 编排：生成 → 评测 → 反思循环；`watchLoop` 常驻监听；`liteLoop` 刷新触发监听；`courseLoop` 课程自动驾驶
- `cli.mjs` — CLI 入口：`browser | my-edge | probe | dump | once | run | watch | lite | course | course-probe | models`

## 常用命令（均在 `agent/` 目录下执行）

- `npm run probe` — 检查配置、浏览器连接与页面识别（**新平台接入必跑**）
- `npm run dump` — 导出页面结构快照到 `agent/dumps/`（写站点定制规则前先跑）
- `npm run once` — 只解当前一题；`npm run run` — 连续解题自动翻页；`npm run watch` — 常驻监听（推荐）；`npm run lite` — 刷新触发：刷新题目页即重做（含反思循环）
- `npm run my-edge` — 以"用户自己的 Edge 配置"重启并带调试端口（junction 绕过 136+ 默认目录限制，保留登录态；会先关闭运行中的 Edge）
- `npm run course` — 课程自动驾驶：遍历「课堂实验→板块→开始学习」逐关完成（前置：浏览器已打开课程列表页）
- `npm run models` — 列出可用文本模型
- Windows 用户入口：双击 `agent/start-my-edge.bat`（自己的 Edge）、`agent/start-watch.bat`、`agent/start-lite.bat`、`agent/start-course.bat`

## 约束

- **prompt 单一数据源**：AI 行为的 prompt 只存在于 `shared/capabilities/*.json`，agent 直接读取并渲染 `{{input.xxx}}`。**不得在 agent 内复制 prompt 造成两份漂移**。改 AI 行为优先改 JSON，而非代码。
- **不硬编码站点 selector**：识别全部走通用启发式（编辑器按 Monaco/Ace/CodeMirror/textarea 优先级探测；题干取排除编辑器后最长且偏左的文本块）。针对具体平台调整前先 `npm run dump` 拿真实结构，不要凭假设写规则。
- **写入用键盘而非改 DOM**：`点击 → Ctrl+A → Delete → insertText`，以触发编辑器 change 事件与平台自动保存；写入后点编辑器外部并静置。
- **浏览器连接**：连不上调试端口时自动拉起独立 profile 浏览器（`AUTO_LAUNCH=0` 关闭）；要接管"用户自己的 Edge"须用 `my-edge`（junction 绕过 136+ 默认目录禁令，且必须先关闭运行中的实例——同 profile 旧实例会合并新命令）。沙箱/受限执行环境里脚本拉起的浏览器活不过命令边界，需由资源管理器（双击 bat）启动。
- **安全**：端点 / 密钥 / 模型名等个人配置只允许存在于 `agent/.env.local`（已被 .gitignore 排除），源码与 `.env.example` 中不得出现真实值；`agent/.browser-profile*/`（登录态）、`agent/dumps/`（含个人信息的页面快照）、`agent/logs/` 同样严禁提交。
- **如实标注验证边界**：未验证的能力不得在文档中声称可用。

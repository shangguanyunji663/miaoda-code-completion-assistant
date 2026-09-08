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
- `perceive.mjs` — 页面感知：编辑器探测、题干提取、题型分类、按钮枚举
- `act.mjs` — 执行层：写入代码、勾选选项、点击评测、等待结果、翻页
- `loop.mjs` — 编排：生成 → 评测 → 反思循环；`watchLoop` 常驻监听
- `cli.mjs` — CLI 入口：`browser | probe | dump | once | run | watch | models`

## 常用命令（均在 `agent/` 目录下执行）

- `npm run probe` — 检查配置、浏览器连接与页面识别（**新平台接入必跑**）
- `npm run dump` — 导出页面结构快照到 `agent/dumps/`（写站点定制规则前先跑）
- `npm run once` — 只解当前一题；`npm run run` — 连续解题自动翻页；`npm run watch` — 常驻监听（推荐）
- `npm run models` — 列出可用文本模型
- Windows 用户入口：双击 `agent/start-browser.bat` 与 `agent/start-watch.bat`

## 约束

- **prompt 单一数据源**：AI 行为的 prompt 只存在于 `shared/capabilities/*.json`，agent 直接读取并渲染 `{{input.xxx}}`。**不得在 agent 内复制 prompt 造成两份漂移**。改 AI 行为优先改 JSON，而非代码。
- **不硬编码站点 selector**：识别全部走通用启发式（编辑器按 Monaco/Ace/CodeMirror/textarea 优先级探测；题干取排除编辑器后最长且偏左的文本块）。针对具体平台调整前先 `npm run dump` 拿真实结构，不要凭假设写规则。
- **写入用键盘而非改 DOM**：`点击 → Ctrl+A → Delete → insertText`，以触发编辑器 change 事件与平台自动保存；写入后点编辑器外部并静置。
- **浏览器须由用户双击 bat 启动**：实测由脚本 spawn 的浏览器会在命令结束时被一并终止（Edge/Chrome 均如此）。
- **安全**：端点 / 密钥 / 模型名等个人配置只允许存在于 `agent/.env.local`（已被 .gitignore 排除），源码与 `.env.example` 中不得出现真实值；`agent/.browser-profile*/`（登录态）、`agent/dumps/`（含个人信息的页面快照）、`agent/logs/` 同样严禁提交。
- **如实标注验证边界**：未验证的能力不得在文档中声称可用。

# 浏览器自动解题 Agent

> 配套文档：变更日志见 [`CHANGELOG.md`](CHANGELOG.md)；环境与代码踩坑记录见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。AI 能力配置（prompt）的单一数据源在仓库根 `shared/capabilities/`，说明见其目录 README。

连接你已登录的 Edge/Chrome，自动读取评测页面上的题目要求、在编辑器写入答案、点击评测、读取结果、失败后反思重试、通过后翻到下一题。

各层职责：

| 层 | 位置 | 职责 |
|---|---|---|
| AI 能力定义 | 仓库根 `shared/capabilities/*.json` | prompt 单一数据源，Agent 直接读取复用 |
| 浏览器执行层 | 本目录 `agent/` | 感知页面、自动作答、点评测、翻页、反思循环 |
| 用户入口 | `start-browser.bat` / `start-watch.bat` | 启动带调试端口的浏览器、启动常驻监听 |

## 前置条件

- Node.js 18+（用到内置 `fetch`）
- Edge 或 Chrome（Edge 已实测可用，路径自动探测）

## 首次使用

```bash
cd agent
npm install

# 1. 配置密钥
cp .env.example .env.local   # 然后编辑 .env.local 填入 AI_API_KEY

# 2. 启动带调试端口的浏览器 —— 双击 start-browser.bat
#    （会打开一个全新窗口；不要关掉它）
#    备选：npm run browser（见下方"已知限制"第 4 条，某些环境下不持久）

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
| `npm run browser` | 启动带调试端口的浏览器 |
| `npm run probe` | 检查配置 + 页面识别情况（**首次必跑**，用于确认题目和编辑器被正确识别） |
| `npm run dump` | 导出页面结构快照到 `agent/dumps/*.json`，用于针对具体站点精调识别规则 |
| `npm run once` | 只解当前这一题 |
| `npm run run` | 连续解题，通过后自动点「下一关」翻页 |
| `npm run watch` | **常驻监听**：切到新题目页就自动作答（推荐，导航权在你手里） |
| `npm run models` | 列出可用文本模型 |

## 配置项（`agent/.env.local`）

| 变量 | 说明 | 默认 |
|---|---|---|
| `AI_BASE_URL` | OpenAI 兼容端点（含 `/v1`），必填 | 无默认，统一在 `.env.local` 配置 |
| `AI_API_KEY` | 密钥，必填 | 无默认 |
| `AI_MODEL` | 模型名，`npm run models` 查看全部，必填 | 无默认 |
| `AI_TEMPERATURE` | 采样温度 | `0.3` |
| `DEBUG_PORT` | 调试端口 | `9222` |
| `EDGE_PATH` / `BROWSER_PATH` | 浏览器路径，留空自动探测 | 自动 |
| `TARGET_URL_HINT` | 评测页 URL 特征片段，多标签页时用于定位 | 留空取第一个 |
| `MAX_RETRY` | 单题最大反思重试次数 | `4` |
| `EVAL_TIMEOUT_MS` | 等待评测结果上限 | `60000` |
| `COOLDOWN_MS` | 每题间隔，避免触发平台风控 | `1500` |
| `MAX_TASKS` | 连续解题上限，`0` 不限 | `0` |
| `DRY_RUN` | `1` = 只感知与生成，不写入不点击 | `0` |

## 工作流程

```
probe（感知）→ 生成/作答 → 写入编辑器 → 静置保存 → 点击评测
      ↑                                                    │
      └──────── 失败：reflectAndFix 反思修复 ←── 未通过 ─────┤
                                                           │
                                              通过 → 点击下一题 → 回到 probe
```

- **题型自动分类**：`code`（检测到 Monaco/Ace/CodeMirror/textarea）、`choice`（检测到 radio/checkbox）、`blank`（文本输入框）
- **代码题**：生成 → 评测 → 失败则带着「题目 + 上一版代码 + 评测输出」反思修复 → 重评，最多 `MAX_RETRY` 次
- **选择题/填空题**：直接作答后评测；当前版本不做多轮反思

## 常驻监听模式（推荐用法）

启动：`npm run watch`，或双击 `start-watch.bat`。

- 程序**一直运行**，每 2 秒检查一次浏览器的所有标签页
- 你手动切到哪个题目页，它就自动做哪一题（勾选 + 点击「评测」）
- **它不会替你点「下一关」**——导航权始终在你手里
- 处理过的页面不重复作答；启动时已打开的题目页会跳过，避免重复提交

适用：想自己控制进度，只把「读题 + 选答案 + 点评测」这一步自动化。

识别规则由 `TASK_URL_PATTERN` 决定，默认匹配 `/tasks/<courseId>/<num>/<slug>`。
换平台时改 `.env.local` 里的这个正则即可。

> 实测注意：CDP 连接下所有标签页的 `document.visibilityState` **全部返回
> `visible`**，无法据此判断"用户正在看哪个标签"。因此改为遍历所有标签页 +
> URL 去重的方案。

## 设计要点

1. **prompt 单一数据源**：Agent 直接读取仓库根 `shared/capabilities/*.json` 中的 prompt 并渲染 `{{input.xxx}}` 占位符，不在 Agent 里复制 prompt，避免两份漂移。新增的题型走 `quiz_answer_selector_1.json`。
2. **成功判定加固**：朴素 `includes` 匹配会让 `"未通过"` 命中 `"通过"`、`"AC"` 命中任意含 ac 的英文单词。Agent 的 `detectVerdict` 改为**否定词优先短路 + 整词匹配**，且**不确定时一律判未通过**（保守策略宁可多试一轮，也不错报成功）。
3. **写入用键盘而非改 DOM**：`点击 → Ctrl+A → Delete → insertText`，能触发编辑器 change 事件与平台自动保存。直接改 DOM 常导致平台评测到旧代码。
4. **写入后静置**：写完后点击编辑器外部并等待 `COOLDOWN_MS`，触发平台自动保存。
5. **不硬编码站点 selector**：全部走启发式识别，换平台无需改代码；识别不准时用 `npm run dump` 导出快照再加规则。

## 已知限制与边界（如实标注）

- **浏览器需由用户手动启动**：实测在本机执行环境中，由 Agent 脚本 spawn 的浏览器会在该条命令结束时被一并终止（Edge 与 Chrome 均如此，跨命令后端口即 ECONNREFUSED）。因此请**双击 `start-browser.bat`** 启动，浏览器由资源管理器拉起才能跨命令存活。`npm run browser` 保留作为自动化入口，在不受此限制的环境中可用。
- **调试端口避开 Windows 保留区间**：本机 `9137-9236` 被系统保留，使用 9222 会触发 `bind() ... (0x271D)` 且 devtools 无法启动。现在默认 9333，启动脚本还会读 `netsh` 保留区间自动顺延。
- **连接时强制绕过代理**：环境若配置了 `http_proxy`，Playwright 的 `connectOverCDP` 会走代理去连 127.0.0.1 并返回 502（此时浏览器其实是好的）。连接层已做临时摘除代理变量处理。
- **尚未在真实评测站点上端到端验证**。当前只完成了连通性验证：AI 通道可用（实测 `agnes-2.0-flash` 约 3.4s）、Edge 路径探测正常、CDP 连接与错误提示正常。页面识别规则是基于通用启发式写的，**首次在新平台上大概率需要 `npm run dump` 后针对性调整**。
- **题型覆盖不完整**：选择题与填空题目前只做单轮作答，未实现失败反思；多空填空题按换行分隔的约定依赖模型遵循指令，存在模型不按格式输出的风险。
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

# 编程题自动解题 Agent

连接你已登录的浏览器，自动读取评测网页上的题目，AI 生成答案后自动填入编辑器 / 勾选选项、自动点击评测；未通过则带着「题目 + 上一版代码 + 评测输出」反思修复后重评，直至通过。

不绕过任何登录校验，只操作你自己已登录的页面。

## 它能做什么

| 环节 | 行为 |
|---|---|
| 感知 | 提取题干、自动判别题型（代码 / 选择 / 填空）、定位编辑器与按钮 |
| 作答 | 代码题用键盘写入编辑器（触发平台自动保存）；选择题/填空题批量勾选填入 |
| 评测 | 自动点击「评测」，等待结果，判定通过与否 |
| 迭代 | 未通过 → 反思修复 → 重新评测，最多 `MAX_RETRY` 轮 |
| 常驻 | `watch` 模式下你切到哪道题就做哪道题，**不替你点「下一关」**，导航权在你手里 |

## 快速开始（Windows）

```bash
cd agent
npm install                      # 只需一次，依赖仅 playwright-core

cp .env.example .env.local       # 编辑 .env.local，填 AI_BASE_URL / AI_API_KEY / AI_MODEL
```

然后双击两个 bat（**不要用命令行启动浏览器**——脚本拉起的浏览器活不过命令边界）：

1. **`agent/start-browser.bat`** — 关闭所有 Edge，以独立 profile + 调试端口启动。窗口不要关。
2. 在弹出的浏览器里**登录评测平台**，打开任意一道题目页。
3. **`agent/start-watch.bat`** — 常驻监听，之后切到新题目页即自动作答。

首次接入新平台务必先跑 `npm run probe` 确认识别正确；识别不准用 `npm run dump` 导出页面结构再调规则。

## 命令（均在 `agent/` 下执行）

| 命令 | 作用 |
|---|---|
| `npm run probe` | 检查配置 + 页面识别情况（**首次必跑**） |
| `npm run watch` | **常驻监听**：切到新题目页就自动作答（推荐） |
| `npm run once` | 只解当前这一题 |
| `npm run run` | 连续解题，通过后自动翻页 |
| `npm run dump` | 导出页面结构快照到 `agent/dumps/`，用于精调识别规则 |
| `npm run models` | 列出可用文本模型 |
| `npm run browser` | 命令行启动带调试端口的浏览器（某些环境下不持久，优先用 bat） |

## 目录结构

```
├── agent/                    浏览器自动执行层（项目主体）
│   ├── src/                  config / ai / browser / launch-browser / perceive / act / loop / cli
│   ├── docs/                 TROUBLESHOOTING.md 问题排查手册
│   ├── start-browser.bat     启动带调试端口的浏览器（双击）
│   ├── start-watch.bat       启动常驻监听（双击）
│   ├── .env.local            密钥与运行参数（已被 git 忽略）
│   └── README.md             完整文档（配置项、工作流、已知限制）
└── shared/capabilities/      AI prompt 单一数据源（4 个能力配置）
```

改 AI 行为请只改 `shared/capabilities/*.json`，agent 直接读取渲染，**不要在 agent 内复制 prompt**。

## 关键注意

- **浏览器必须双击 bat 启动**：实测由 Agent 脚本 spawn 的浏览器会在命令结束时被一并终止。
- **调试端口避开 Windows 保留区间**：本机 9137-9236 被系统保留，默认用 9333，启动脚本会读 `netsh` 自动顺延。
- **新平台先干跑**：`.env.local` 设 `DRY_RUN=1` 跑一轮，确认识别与生成正确后再关闭。
- **合规**：自动提交作用于你的真实账号，是否违反目标平台使用条款请自行评估。

## 文档

- `agent/README.md` — 完整文档：配置项、工作流、设计要点、已知限制与安全
- `agent/docs/TROUBLESHOOTING.md` — 12 个真实踩坑（环境级 + 代码级）与排查方法论
- `agent/CHANGELOG.md` — 变更日志

## 说明

早期版本包含一个手动粘贴式的 React 工作台前端，现已移除（项目聚焦自动执行层）。历史版本见 git 提交 `3cc19d3`。

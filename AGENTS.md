# AGENTS.md

面向在此仓库工作的开发代理（Agent）的项目说明。

## 项目性质

AI 驱动的编程题解题工作台，由两部分组成：

**1. 主项目（前端 SPA）** —— 交互式工作台，核心业务逻辑：

- `src/pages/HomePage/HomePage.tsx` — 状态管理与 AI 调用编排
- `src/pages/HomePage/sections/InputPanelSection.tsx` — 输入区
- `src/pages/HomePage/sections/CodeOutputPanelSection.tsx` — 输出区
- `shared/capabilities/*.json` — AI 能力插件配置（代码补全 / 反思修复 / 选择题作答 / 批量作答，共 4 个）

**2. 浏览器自动执行层（`agent/`，可选子系统）** —— Node + playwright-core 通过 CDP 连接用户浏览器，自动感知题目、作答、提交评测、反思重试。详见 `agent/README.md` 与 `agent/CHANGELOG.md`。

## 常用命令

主项目（仓库根目录）：

- `npm run dev` — 启动 Vite dev server（端口 8001，见 scripts/dev.mjs）
- `npm run build` — 构建（输出 dist/output 等，见 scripts/build.sh）
- `npm run typecheck` — TypeScript 检查
- `npm run lint` — typecheck + eslint

agent 子系统（`cd agent` 后）：

- `npm run probe` — 检查配置、浏览器连接与页面识别（新平台接入必跑）
- `npm run dump` — 导出页面结构快照到 `agent/dumps/`（写站点定制规则前先跑）
- `npm run once` — 只解当前一题；`npm run run` — 连续解题自动翻页；`npm run watch` — 常驻监听（推荐）
- `npm run models` — 列出可用文本模型
- Windows 下用户入口：双击 `agent/start-browser.bat` 与 `agent/start-watch.bat`

## 约束

- 代码补全/反思逻辑必须保留真实 AI 能力调用（capabilityClient），禁止改为 mock。
- 修改 AI 行为时优先调整 `shared/capabilities/*.json` 中的 prompt，而非组件代码。agent 侧同样直接读取该目录渲染 prompt，**不得在 agent 内复制 prompt 造成两份漂移**。
- UI 组件位于 `src/components/ui/`，遵循 shadcn 规范；别名 `@/*` → `src/*`，`@shared/*` → `shared/*`。
- **安全**：API 端点/密钥/模型名等个人配置只允许存在于 `.env.local`（已被 .gitignore 排除），源码与模板文件中不得出现真实值；`agent/.browser-profile*/`（登录态）、`agent/dumps/`（含个人信息的页面快照）、`agent/logs/` 同样严禁提交。
- agent 的站点识别规则基于通用启发式；针对具体平台调整前，先 `npm run dump` 拿真实结构，不要凭假设写选择器。

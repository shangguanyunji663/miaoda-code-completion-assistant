# 编程题自动补全与评测迭代助手 (miaoda-code-completion-assistant)

一个 AI 驱动的编程题解题工作台：粘贴题目描述与代码模板，AI 自动在 `Begin/End` 标记之间补全代码；把评测平台的评测结果粘贴回来，AI 反思失败原因并迭代修正，直到全部通过。

## 功能

- **5 步工作流引导**：粘贴题目与模板 → AI 生成补全代码 → 复制到平台评测 → 粘贴评测结果 → AI 反思重试
- **AI 代码补全**：真实 AI 能力（`@official-plugins/ai-text-generate` 插件），流式输出完整代码
- **AI 反思修复**：结合题目 + 上一版代码 + 评测结果，先分析失败原因再生成修正代码
- **版本历史**：每次生成自动追加新版本，可切换回看
- **一键复制**：复制完整代码粘贴到评测平台
- **成功信号识别**：识别「全部通过 / Accepted / 0组不匹配」等关键词，自动标记迭代完成（agent 侧使用加固版判定，见 `agent/docs/TROUBLESHOOTING.md` C-1）
- **本地持久化**：题目、模板、版本历史存于 `scopedStorage`，刷新不丢失
- **浏览器自动执行层（`agent/`）**：可选子系统。常驻监听评测页面，自动识别题目、批量作答、提交评测、失败反思重试；支持选择题与代码填空。详见 `agent/README.md`

## 技术栈

- React 19 + TypeScript + Vite 8
- Tailwind CSS 4 + shadcn/ui (new-york, neutral)
- @lark-apaas/client-toolkit-lite（`capabilityClient` / `scopedStorage` / `logger`）
- 路由：react-router-dom 7

## 目录结构

```
miaoda-code-completion-assistant/
├── index.html / package.json / vite.config.ts / tsconfig*.json / components.json
├── .githooks/               git pre-commit 钩子
├── scripts/                 dev.mjs / build.sh / setup-git-hooks.mjs
├── public/                  favicon.svg 等静态资源
├── shared/
│   ├── plugin-types.ts      AI 插件类型定义
│   ├── capabilities/        AI 能力插件配置（代码补全 / 反思修复 / 选择题作答 / 批量作答）
│   └── static/              私有静态资源（空）
├── agent/                   浏览器自动执行层（可选子系统，独立运行）
│   ├── src/                 config / ai / browser / launch-browser / perceive / act / loop / cli
│   ├── docs/                TROUBLESHOOTING.md 问题排查手册
│   ├── start-browser.bat    启动带调试端口的浏览器（双击使用）
│   ├── start-watch.bat      启动常驻监听模式（双击使用）
│   └── CHANGELOG.md         agent 子系统变更日志
└── src/
    ├── index.tsx / app.tsx / index.css / tailwind-theme.css / typography.css
    ├── data/iteration.ts    数据模型与成功关键词
    ├── lib/utils.ts         工具函数（成功检测、markdown 代码提取）
    ├── hooks/use-mobile.ts
    ├── components/ui/       shadcn 组件（本项目用到 7 个）
    └── pages/
        ├── HomePage/        主页面 + 5 个 section
        └── NotFoundPage/
```

## 本地运行

环境要求：Node.js 18+。

```bash
# Windows 一键（等价于下面三步）
setup.bat

# 或手动执行：
npm install
npx shadcn@latest add button card select textarea label badge sonner --yes
npm run dev
```

启动后访问 `http://localhost:8001`。

## 重要说明

1. **AI 能力依赖平台运行时**：`capabilityClient.load(...)` 需要妙搭（miaoda）平台的插件运行环境注入。在纯本地 Vite 环境中，AI 调用会因缺少平台运行时失败；UI、步骤条、版本历史、复制、成功识别等纯前端功能可正常运行。如需本地完整跑通 AI，请把 `src/pages/HomePage/HomePage.tsx` 中的 `capabilityClient` 调用替换为你的 OpenAI / 豆包 API HTTP 请求（`shared/capabilities/*.json` 中的 prompt 可直接复用）。
2. **shadcn 组件**：本仓库已包含项目实际用到的 7 个组件（button / card / select / textarea / label / badge / sonner），无需再手动添加；`npx shadcn@latest add` 仅用于按需补齐其他组件。
3. **与评测平台配合**：生成代码后粘贴到平台编辑器时，**先点击编辑器外部（或稍等 2-3 秒）让平台自动保存完成，再点「评测」**，否则可能评测到旧代码。
4. **未包含的文件**：`package-lock.json`（由 `npm install` 生成）、平台私有配置 `.spark_project`、`public/icons.svg`（社交媒体图标 sprite，对业务无影响）。favicon 使用简化版替换了原始 SVG。

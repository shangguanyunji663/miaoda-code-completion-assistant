# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

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

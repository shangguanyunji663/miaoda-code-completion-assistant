# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [0.3.0] - 2026-09-09

### Added

- **课程自动驾驶模式 `npm run course`**（新增 `start-course.bat` 双击入口，纯 ASCII）：遍历「课堂实验 → 板块 → 开始学习」逐关作答。评测通过自动点「下一关」；点击后 URL 与关卡序号均无变化即判定本小板块做完 → 任务页右上角「退出」→ 作业详情页左上角返回 → 回列表继续下一块。进度 `n/n` 的已完成卡片自动跳过；支持新标签页进入关卡（作答完自动关闭）
- `perceive.mjs` 新增课程列表感知：`collectCards`（卡片标题 + `n/n` 进度）、`collectSections`（左侧板块菜单）
- `act.mjs` 新增课程导航动作：`readTaskNo` / `waitTaskAdvance`（SPA 切关的 URL/序号双判据）、`clickExitTask`（电源图标启发式）、`clickBackArrow`（找不到时退化为浏览器后退）、`clickContinueChallenge`、`clickStartLearning`
- 新增配置：`NAV_TIMEOUT_MS`（默认 10000）、`LIST_TIMEOUT_MS`（默认 15000）、`MAX_BOARDS_PER_SECTION`（默认 50）
- **新增 `my-edge` 命令 / `start-my-edge.bat`**：以"用户自己的浏览器配置"重启并带调试端口——目录联接（junction，无需管理员）绕过 Chromium/Edge 136+ 默认目录调试禁令，账号/历史/插件全保留；含 3 秒倒计时关闭运行中的实例（同 profile 旧实例会合并新命令导致端口失效）
- `connectBrowser` 支持自动拉起：连不上调试端口时自动启动独立 profile 浏览器并重连（`AUTO_LAUNCH=0` 关闭），watch/course 单 bat 即可跑
- **新增只读诊断命令 `npm run course-probe`**：在课程列表页打印识别到的板块/卡片并导出 `dumps/course-*.json`，course 卡住时用于精调识别规则
- course 卡片点击加固：采集时在真实可点节点打 `data-agent-target` 标记（替代 nth 文本序号，避免隐藏同名节点导致错位）；点击超时不抛异常；点击后 12 秒内未发生导航（新标签页/URL 变化）则记日志跳过该卡片，不再静默空转
- 点击目标明确为「开始学习」按钮本身（书本图标+文字的可点容器）：从文本叶子向上找 `cursor:pointer` 的最近祖先打标记；`course-probe` 输出附带按钮 tag/class 便于与真实页面核对
- `ai.mjs` 新增 `spliceIntoTemplate`：代码题写入前以**原始模板**为权威，把 AI 生成的代码体拼回 Begin/End 标记之间，平台脚手架字节级不变，消除"写入后不符合平台格式"（标记识别要求 ≥3 装饰符串，避免误判 Redis 事务里的 `BEGIN`）
- **平台兼容性明确化**：支持任意 EduCoder 系平台（学校私有部署 / 官方 www.educoder.net）——识别全部基于 URL 路径与页面启发式、与域名无关（实测 `/tasks/<id>/<num>/<slug>` 双站匹配）；新增 README「平台兼容性」节

### Changed

- 提速：`MAX_RETRY` 4→2、`EVAL_TIMEOUT_MS` 60000→25000、`chat()` 默认重试 3→2；单题最坏耗时约降一半以上

### Fixed

- **course 列表页采集三大真实结构缺陷**（经 CDP 连真实列表页逐级插桩定位，已回归验证：9 卡片 + 17 板块全识别、按钮标记正中 `actionIcon` 容器）：
  1. 卡片行上爬判据失效：按钮为三层同文本嵌套容器（`actionIcon > flexBox > div`，innerText 均为"开始学习"），旧"父文本严格更长"判据第一步即断，row 停在叶子 → 0 卡片。改为"当前行不含进度 n/n 且父级仍含开始学习就继续爬"
  2. 图标字体字符污染匹配：菜单项/按钮 innerText 带私有区字符（如 `\uE8B5`），`startsWith('课堂实验')` 恒假。统一 `clean()`（剔除非字母数字空白字符）后比对；标题提取改用原始 innerText 按行切分（norm 会吞换行致整行成标题）
  3. `collectSections` 两处硬伤：contains 去重误用全量元素集做排除（任何容器都含别的元素 → 恒为空），修正为仅对通过匹配的集合去重；子板块是 `role="button"` 可拖拽 div（react-rbd），选择器补 `[role="button"]`
  另：`collectCards`/`clickStartLearning` 支持 iframe 回退；匹配前剔除字母/数字/空白以外字符（附单测）；`course-probe` 与 course 主流程在 0 卡片时自动输出候选节点 JSON 转义采样并导出结构快照
- **评测结果"空结果"误判与等待过长**：旧版 `waitEvalResult` 每轮跑全页探测（probePage 多次 evaluate，单轮秒级延迟）且只扫主 frame、候选仅 `div/section/pre/article`，结果渲染在 iframe 或带 `result/output/console` 类名的容器里时永远抓空 → 白等满 `EVAL_TIMEOUT_MS` 后保守判"未通过"。现改为轻量探针 `readEvalPanel`：每轮单次 evaluate、全 iframe 扫描、候选扩至含 result/output/eval/console/modal/message/toast 类名容器与 `code/pre`，轮询间隔 1200→800ms；出结果后 ~2.4s 内即可判定，仍抓空时打印 dump 指引
- **成功判定补裸「通过」兜底**：EduCoder 结果文风如「测试集1 通过」，旧肯定词表（全部通过/测试通过/AC…）一个都命中不了、会误判未通过。否定词（未通过/没有通过/不通过/未全部通过…）仍优先短路，走到兜底才判通过；4 组用例单测 PASS
- **watch 空白页诊断**：题目区 15 秒未渲染且页面文本近空时，日志明确提示"多半是该平台未登录，请在调试浏览器登录一次"（实测 educoder.net 对匿名用户渲染空壳、无跳转无提示），替代误导性的单纯"跳过本页"
- watch 模式启动时把已打开的题目页预标记为"已处理"，导致"页面已打开却不作答"；现启动即作答当前页，作答后才去重
- `README.md` 配置表与实际默认值漂移（`DEBUG_PORT` 9222→9333、`MAX_RETRY`、`EVAL_TIMEOUT_MS`），已同步

### Known Issues

- course 列表采集已在真实页面验证（9 卡片 / 17 板块 / 按钮正中 actionIcon），但**完整端到端（点开始学习→逐关作答→退出返回）尚未跑通验证**；「退出」电源图标与返回箭头仍为启发式，首次全流程运行时留意日志，卡住即 `npm run dump` 反馈

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

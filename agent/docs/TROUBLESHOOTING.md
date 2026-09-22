# 问题排查手册（TROUBLESHOOTING）

本文档收录本项目开发与联调过程中遇到的真实问题。每条按「现象 → 根因 → 解决 → 预防」组织，全部经过实机验证，非理论推测。遇到同类问题先查这里。

- 环境级问题：与操作系统、浏览器、网络代理相关，换机器可能复现
- 代码级问题：与本项目实现相关，改动代码前应先读对应条目
- 排查方法论：通用的定位思路，优先级高于逐条比对

---

## 一、环境级问题

### E-1. CDP 调试端口连不上：`bind() ... (0x271D)`

**现象**：浏览器进程正常启动、独立 profile 目录也生成了，但调试端口死活连不上。Node 侧只能看到 `fetch failed` 或 `ECONNREFUSED`，毫无头绪。

**根因**：浏览器自身日志里写着：

```
bind() returned an error: 以一种访问权限不允许的方式做了一个访问套接字的尝试。(0x271D)
Cannot start http server for devtools.
```

`0x271D` = `WSAEACCESS(10013)`。该端口落在 **Windows 保留端口区间**（excludedportrange）内——本机实测 `9137-9236` 被保留，9222 正中区间。这类保留区间通常由 Hyper-V / Docker / WSL 引入。

**解决**：

1. 查保留区间：`netsh interface ipv4 show excludedportrange protocol=tcp`
2. 换到区间外的端口。本项目默认 **9333**（避开 `9137-9236` 与 `10317-10416`）
3. `agent/src/launch-browser.mjs` 的 `pickAvailablePort()` 会在启动前自动读取保留区间并顺延

**预防**：不要假设任何端口可用；选端口前先查一次保留区间。

**教训**：netsh 输出的是**范围**（如 `9137  9236`），不是精确值。逐端口比对必须做区间判断——第一版实现用 `grep 9222` 精确匹配行内容，误判为"端口未被保留"。

---

### E-2. Playwright 连接 CDP 报 502，但浏览器明明是好的

**现象**：`connectOverCDP` 报 `Unexpected status 502 ... This does not look like a DevTools server`，但用 Node 原生 `fetch` 直连同一个端口的 `/json/version` 能拿到正常响应。

**根因**：环境配置了 `http_proxy=http://127.0.0.1:53470`。

- Node 内置 `fetch`（undici）**默认不读**代理环境变量 → 直连成功
- Playwright 的 `connectOverCDP` **会读**代理变量 → 连 `127.0.0.1` 也走代理 → 代理转发失败返回 502

502 是代理制造的**假故障**，与浏览器无关。

**解决**：`agent/src/browser.mjs` 的 `withoutProxy()`——连接前临时摘除所有代理环境变量，连接成功后立即恢复（已建立的 WebSocket 不受后续环境变量变化影响）。

**预防**：任何"连本地服务却报 502/504"的场景，先检查代理环境变量。

---

### E-3. 脚本启动的浏览器活不过命令边界

**现象**：同一条命令内"启动浏览器 + 探测"完全正常；换一条命令再探测就 `ECONNREFUSED`。Edge 和 Chrome 都如此。

**已排除**：`detached: true + unref()`、`cmd /c start`、沙箱内外运行——**全部无效**。

**根因**：本执行环境在每条命令结束时清理其派生的子进程，与浏览器本身无关。

**解决**：由**资源管理器**拉起浏览器才能跨命令存活。提供 `start-browser.bat` 供用户双击启动；`npm run browser` 保留为自动化入口，但在受此限制的环境中不持久。

**预防**：需要"跨命令存活"的进程（浏览器、常驻监听），一律由用户手动启动，脚本只负责"准备好一切"。

---

### E-4. Edge 进程合并：调试参数被静默丢弃

**现象**：双击启动脚本后，Edge 窗口打开了，进程数增加了，但没有任何进程带 `--remote-debugging-port`，端口也从未被 bind。

**诊断**（决定性证据）：

```
EDGE_TOTAL=16
WITH_DEBUG_PORT=0        ← 无一带调试端口
WITH_AGENT_PROFILE=0     ← 无一带独立 profile
```

**根因**：Edge 的启动增强（Startup Boost）/ 单实例机制。**即使指定了完全不同的 `--user-data-dir`**，新实例仍被并入已有实例，命令行参数静默丢弃。已尝试 `--disable-features=StartupBoost`，不能保证绕过。

**解决**：启动前**必须关闭所有 Edge 进程**（包括后台常驻）。`start-browser.bat` 已内置：

1. 检测 `msedge.exe` 是否在跑
2. 警告 + 6 秒倒计时（可 Ctrl+C 中止）
3. `taskkill /F /IM msedge.exe /T`
4. **轮询等待进程完全退出**（taskkill 返回 ≠ 进程已消失，不等待干净仍会被合并）
5. 再启动调试实例

**预防**：与 E-3 一起构成当前标准流程：`start-browser.bat`（关 Edge → 起调试实例）→ 登录 → `start-watch.bat`（常驻监听）。自动化期间**不要手动开 Edge**，否则会把调试实例挤掉。

**替代方案**：Chrome 与 Edge 是不同进程树，同时运行互不合并。若必须"边上网边自动刷题"，用 Chrome 启动调试实例即可，代码零改动（两者同为 Chromium，CDP 协议一致）。

---

### E-5. Edge 自身日志是最快的排查入口

**现象**：以上 E-1 / E-4 的根因，Node 侧全部无法直接观测。

**解决**：让浏览器自己写日志。两种方式：

```bash
# 方式一：Chromium 参数（推荐，launch-browser.mjs 已内置）
msedge.exe --enable-logging --log-file=<path>

# 方式二：spawn 时把 stdio 落盘（非 Windows 或直接 spawn 时可用）
spawn(exe, args, { stdio: ['ignore', logFd, logFd] })
```

**教训**：浏览器起不来时，**先拿浏览器自己的 stderr**，比在 Node 侧猜快得多。本次三个环境坑里有两个是日志直接给出的答案。`agent/logs/browser.log` 在启动失败时会被 `waitForCdp` 自动打印尾部。

---

## 二、代码级问题

### C-1. 朴素关键词匹配导致"未通过"被判成功

**现象**：旧版 `detectSuccess`（朴素 `includes` 关键词匹配）用 `includes` 匹配成功关键词，`"未通过，3组不匹配"` 会命中 `"通过"`，`"AC"` 会命中任意含 ac 的英文单词。

**解决**：`agent/src/ai.mjs` 的 `detectVerdict` 采用三段式：

1. **否定词优先短路**：命中「未通过 / 失败 / 错误 / Wrong Answer / WA...」直接判负
2. **肯定词匹配 + 裸「通过」兜底**：`AC`、`pass` 用 `\b` 边界；否定词筛完后仍出现的裸「通过」判通过——兼容 EduCoder 的「测试集1 通过」文风（0.3.0 补入，见 `agent/src/ai.mjs` 的 `POSITIVE_PATTERNS` 末位）
3. **不确定判负**：没有命中任何信号时保守判 false，宁可多试一轮也不错报成功

已验证用例：`"未通过，3组不匹配" → false` ✓（朴素 `includes` 实现会误判为 true）。

**预防**：涉及"成功/失败"二分类的字符串匹配，否定词检测必须在肯定词之前。

---

### C-2. AI 偶发返回 200 + 空字符串，空内容被当正常结果放行

**现象**：第一次干跑时，4 道题的批量答案整体为空，但 AI 调用没有报任何错。单独重试又完全正常。

**根因**：上游中转服务偶发返回 `200 OK` + `choices[0].message.content === ""`。`chat()` 的重试逻辑只在**抛错**时触发，空字符串被当成正常结果直接返回。

**解决**（两层防御）：

1. `chat()` 内：`typeof content !== 'string' || !content.trim()` 视为失败，抛错触发既有的指数退避重试
2. `answerBatch()` 内：解析出的答案 map 为空时再整体重试一次（防模型输出不符合格式的整段解释文字）

**预防**：对外部 API 的任何返回值，先判"业务上是否可用"，再谈解析。HTTP 200 ≠ 内容有效。

---

### C-3. Ant Design 结构下 `closest('label')` 拿到空文本

**现象**：`probe` 显示 13 个 radio 的 label 全是空字符串，但页面明明有选项文本。

**根因**：该平台（Ant Design）的选项结构是：

```html
<div class="option">
  <a class="flex-container">              ← 选项文本在这层
    <label class="ant-radio-wrapper">
      <span class="ant-radio">
        <input type="radio">
        <span class="ant-radio-inner"></span>
      </span>
    </label>
    <div>A、执行 SAVE 命令</div>           ← 文本实际在这里
  </a>
</div>
```

`label` 只包裹 input 和装饰 span，文本是 `a` 的**兄弟节点**，所以 `closest('label').innerText` 为空。

**解决**：`perceive.mjs` 的 `READ_QUESTIONS` 按 `ul.choose-container > li` 结构化提取，文本从 `a` 层取；`act.mjs` 的 `applyAnswers` 点击目标也是 `a`。

**预防**：写 DOM 提取规则前先 dump 真实结构，不要按"标准库文档"假设。

---

### C-4. CDP 下 `document.visibilityState` 全部返回 visible

**现象**：浏览器开着 5 个标签页，逐一 `evaluate(() => document.visibilityState)` 全部返回 `'visible'`，无法判断用户正在看哪个。

**根因**：CDP 远程连接下标签页的可见性上报不可靠（可能与窗口管理模式有关）。

**解决**：放弃 visibility 方案，改为**遍历所有标签页 + URL 去重**（`loop.mjs` 的 `findNewTaskPage`）：只要出现新的题目 URL 就处理一次。

**预防**：依赖浏览器运行时状态做决策前，先在目标环境实测一遍。

**延伸（1.2.0）**：同一结论约束了挑页链的设计——`pickTargetPageWithMeta` 无法"优先挑用户正在看的标签"，因此 `TARGET_URL_HINT` / `TASK_URL_PATTERN` 两级**命中多个一律报错列出全部**（附各页 URL），让用户自己关多余标签，而不是静默猜第一个。见下 C-11。

---

### C-11. 多标签页时探测/解题选错页面（挑页链）

**现象**（1.2.0 前的真机场景）：浏览器开着 5 个标签页，课程列表页在标签栏第一位、题目页（`…/tasks/XBLSCWNL/4879/fs7w4pziklnc`）在第四位；工作台点「探测页面」永远探到课程列表页。

**根因**：旧 `pickTargetPage` 逻辑是「`TARGET_URL_HINT` 子串匹配 → 第一个非 about:blank 页」，`.env.local` 里 `TARGET_URL_HINT=` 为空值时直接走兜底，永远选中标签序第一个；CDP 又拿不到"哪个标签在前台"（见 C-4）。

**解决**：`pickTargetPageWithMeta` 四级挑页链——① `TARGET_URL_HINT`（显式指定；多命中报错列出、零命中告警降级）；② 内置题目页 URL 形状正则（复用 `TASK_URL_PATTERN`，eduCoder 官网/校内同构，零配置识别）；③ 内容级兜底 `looksLikeTaskPage`（强代码编辑器 / 评测结果面板标记 / 评测按钮；纯 textarea 不算防误报）；④ 第一个非空白页。每级命中打日志（层级 + URL），HTTP 响应带 `pickedBy`。

**诊断**：挑页报错信息里会列出全部命中页 URL；`npm run probe` 的日志会显示命中层级。报"命中了 N 个标签页"时关掉多余的题目页标签即可；平台题目页 URL 不是 `/tasks/` 形状的改 `.env.local` 的 `TARGET_URL_HINT` 特征片段。

**预防**：多候选场景下绝不静默取第一个——要么报错列出，要么日志高亮降级路径；新增挑页层级时先想清楚 C-4 的约束。

---

### C-5. 「下一关」是 `<a>` 不是 `<button>`，`getByRole('button')` 漏匹配

**现象**：`clickByKeywords(['下一题','下一关',...])` 找不到翻页按钮，但页面上明明有。

**根因**：该平台「评测」是 `<button class="btn-run">`，而「上一关 / 下一关」是 `<a class="ghost-link">`。只查 button 角色会漏掉链接。

**解决**：`clickByKeywords` 依次尝试三种定位：`getByRole('button')` → `getByRole('link')` → `getByText(exact)`。

**预防**：按钮定位逻辑必须覆盖 button / link / 纯文本三级，不要假设元素类型。

---

### C-6. Ant Design 异步渲染导致过早读取拿到空题干

**现象**：翻到新题目页立刻 probe，题干为空或只有骨架。

**根因**：页面加载后题目区是 React 异步渲染的，`domcontentloaded` 时还没有内容。

**解决**：`loop.mjs` 的 `waitTaskReady()`——轮询等待 `ul.choose-container` 或任一编辑器选择器出现（上限 `READY_TIMEOUT_MS`，默认 15s），出现后再 probe。

**预防**：SPA 页面的一切内容读取前先等"特征元素出现"，不要依赖 load 事件。

---

### C-7. 一关多道小题，单题单答设计不足

**现象**：该平台一关内有 4 道小题（3 单选 + 1 多选，共 13 radio + 5 checkbox），原有"识别一个选项 → AI 答一个 → 勾一个"的流程覆盖不了。

**解决**：

1. 新增能力配置 `shared/capabilities/quiz_batch_answer_1.json`：一次提交全部小题，输出约定格式「题号:字母」（多选连写，如 `3:AC`）
2. `ai.answerBatch()` + `ai.parseAnswers()`：解析为 `Record<题号, 字母串>`，解析为空自动重试
3. `act.applyAnswers()`：按「题号 → li 序号、字母 → a 序号」定位点击，并在点击前**校验该 a 的文本确实以对应字母开头**——顺序若与字母不符会明确报错，而不是默默点错

**预防**：作答与勾选解耦，且勾选必须有"防错位校验"。

---

### C-8. mongosh 不存在 + 数据库子命令被逐条敲进 bash（混合题数据准备全灭）

**现象**：MongoDB 混合题（先命令行插入文档、再代码栏写查询），AI 生成的首条命令 `mongosh` 报 `command not found`，后续 `use test2` / `db.educoder.remove({})` / `insertMany(...)` 仍被逐条敲进 bash 全部报错——插入文档失败且无任何重试，评测自然全红。真机截图实锤（2026-09-10）。

**根因**：
1. 混合题分支当时**未接客户端实测**：生成 prompt 里没有"本机只有 mongo、没有 mongosh"这一硬事实，AI 在无依据下猜 mongosh
2. 入口命令（REPL 客户端）失败后，后续子命令仍被顺序键入外层 bash——REPL 上下文丢失，`db.xxx` 全成 bash 语法错误

**解决**（0.9.2，`loop.mjs`）：
1. bash 环境且题干涉数据库时 `probeTerminalClients` 实测客户端（`HAVE:/MISS:` 前缀行解析），结论进 prompt、缺失客户端入【实测禁令】
2. 执行层别名替换（`mongosh`→`mongo`）——模型不听话也确定性改对；命令过 `sanitizeShellSubmission` 护栏清洗
3. 混合题数据准备输入期报错反思自愈（≤2 轮）：把输入期报错 + 终端回显喂回反思，重做而非静默继续

**预防**：客户端存在性是硬事实，一律实测进 prompt，不依赖模型记忆；入口命令失败时要能识别并中止后续 REPL 子命令，或反思一轮自愈。

---

### C-9. 代码栏数据库命令题：裸 REPL 语句必报 syntax error，需 `echo "..."` 双引号包裹

**现象**：数据库查询题在代码栏 Begin/End 之间直接写 `db.educoder.aggregate([{$limit:3}]);...`（即使 `$` 已写成 `\$`），评测报：

```
step2/query.sh: line 2: syntax error near unexpected token '[{$limit:3}]'
```

改写为 heredoc / `: ` 前缀 / `mongo` 命令前缀后，又报 `SyntaxError: missing ; before statement @(shell eval):1:8`（数据库 eval 解析失败）或空标签。多种形态实测全失败。

**根因**：平台对代码栏内容（提交为 `step2/query.sh`）做**双重执行**：

1. **bash 执行**：裸 REPL 语句的 `(`、`{`、`[` 是 bash 语法字符，必然 syntax error（stderr 进实际输出，位于 3 个测试点标签之前）
2. **数据库 eval**：每测试点把命令交给 mongo shell eval（输出在标签后）——只提取 `echo "..."` 双引号内的内容并反转义 `\$`→`$`

heredoc 会让 eval 因 `mongo test2` 相邻标识符报错；`: ` 前缀会让 eval 因 label 语法报错（被吞成空标签）；裸命令卡在 bash 环节。

**关键前提——评测环境共享终端数据库**：题面要求「先在命令行插入文档」是**必需步骤**（1.0.0 实测，第 3 关 `db.educoder.count()` 插入前 0、插入后 4）。评测时 `db` 指向题面指定的库，**未插入则查询结果为空**。早前「评测环境预置数据、无需插入」的判断（0.9.5）被证伪。

**解决**（1.0.0，真机验证通过，第 2/3 关）：**先命令行插入题面文档，再在代码栏用 `echo "` 双引号包裹全部裸查询命令**，命令以分号 `;` 分隔、`$` 写成 `\$`：

```
# 命令行（终端）：插入题面文档（mongo test3 --eval 'db.educoder.insertMany([...])'）
# 代码栏：
echo "
db.educoder.aggregate([{\$limit:3}]);db.educoder.aggregate([{\$sort:{learning_num:1}}]);db.educoder.aggregate([{\$skip:2}])
"
```

- bash 环节：`echo "..."` 是合法 bash，双引号内 `\$` 不展开，零 stderr
- 数据库环节：平台提取引号内命令 → 反转义 → 分号切分 → 逐条 eval → 输出与预期一致（真实评测通过，弹出「恭喜您通过本关」）
- 已同步 `code_completion_generator_1` 第 7 条 / `code_reflection_fixer_1` 第 4 条 / `loop.mjs` mixed 分支

**预防**：代码栏数据库命令题（EduCoder 系）完整流程 = **先命令行插入题面文档到指定库 → 代码栏 echo 双引号包裹裸查询（分号分隔 + `\$` 转义）**；**严格按题面「相关知识/例子」给出的命令形态书写**（如 `db.runCommand({geoNear:...})`，禁止换成 `aggregate $geoNear`——输出格式由命令形态决定，平台按题面例子的返回结构比对，2026-09-11 索引题实测）；查询结果为空先查「命令行是否已插入」；报错带 `step2/query.sh: syntax error` 或 `@(shell eval)` 检查是否缺失 echo 包裹；0.9.2 的「仅 `$` 转义」与 0.9.4 的 heredoc 结论均不完整——转义只解决 bash 变量展开，`(`/`{` 仍需靠 echo 双引号规避。执行层 `wrapDbCommandsInEcho` 会对「主体是 db. 命令集」的提交自动包裹（1.1.0，不误伤编程题/Node 脚本/MySQL 命令）。

### C-10. 评测结果面板遮挡「评测/翻页」按钮，点击被拦截

**现象**：上一次评测后结果面板展开，下次点击「评测」（或「下一题」）时 Playwright 报：

```
locator.click: Timeout 8000ms exceeded.
<div class="evaluate-result-container">…</div> … intercepts pointer events
```

**根因**：评测结果容器（`evaluate-result-container` / `[class*="evaluate-result"]` 等）展开后覆盖了按钮区域，真实点击被面板拦截。

**解决**（1.1.0，`act.mjs`）：`clickByKeywords` 点击被拦截时自动**收起结果面板后重试**——按优先级：① 点击面板内标题行（含「测试结果/测试集/评测结果」字样，多数平台点击标题可收起/展开切换）；② 点击面板左上角（避开内容区）；③ Escape 兜底。收起后重试点击目标按钮；重试仍失败则换下一个候选。

**预防**：任何「上一轮结果/弹窗遮挡按钮」的场景都适用同一处理；面板不存在时零副作用。

**1.5.0 补充（点不动不等于没有按钮）**：`clickByKeywords` 曾把"重扫窗口内始终点不动"与"页面根本没有这个按钮"合并成同一个失败，loop 一律 `no-eval-button` 终止整题——真机后果是**刚写入的代码连一次评测都没拿到**（见 C-12 的事故链）。现在返回值带 `exists`，两者分别记为 `eval-button-busy` / `no-eval-button`；且「评测」按钮的重扫窗口从 20s 提到 `EVAL_CLICK_WAIT_MS`（默认 150s）——**上一轮评测仍在进行时平台就是不让点**，等它跑完才是正确处置；按钮确实不存在时按 `absentGraceMs` 快速失败，不白等 150s。

---

### C-12. 把上一轮遗留的结果面板当成本轮反馈（假证据反思）

**现象**（2026-09-22 真机，Redis 优先级队列关，日志完整留痕）：

```
12:16:31 已点击「评测」
12:16:35 结果面板文本与点击前一致（同错复现），连续 3 次稳定后直接采用
12:16:39 第 1 次评测：未通过
12:17:36 反思分析：…评测耗时恰为120秒上限后终止…三个队列名都已被 blpop 从有序集合中隐式删除…
12:17:37 写入反思后的代码
12:17:46 / 12:18:02 / 12:18:19 点击「评测」被拦截
12:18:27 未找到评测按钮，终止本题
```

四条可疑信号，事后逐条查证：

1. 点击后**只等了 4 秒**——该题面板自报「本关最大执行时间：120 秒」，本轮评测当时根本没跑完；"与点击前一致"采信的是**上一次提交（甚至用户手动提交）的遗留面板**。
2. 反思因此把面板里的「本关最大执行时间 120 秒」反推成"本轮超时"，并断言「列表弹空后队列名会被 blpop 从有序集合中隐式删除」——**这个机制不存在**（`blpop` 只让空列表消失，有序集合成员与它无关）。
3. 反思给出的"更正确版本"用了 `conn.blpop(*task_lists, 10)`：PEP 448 的「解包后再接位置实参」是 Python 3.5+ 语法，平台运行时是 Python 2（见 C-13）——**连编译都过不了**；同一段还写了 `if not task_lists: continue` 的零等待热自旋，恰好是它声称在修的"死循环"。
4. 第 2 轮的点击落在第 1 轮仍在评测的页面上 → 被拦截 → 整题作废，改坏的代码反而一次都没被评测。

**根因**：等待预算小于平台自报的执行时间，加上「同错复现」捷径的 3 秒闸门——**Agent 把没观测到的东西当成了观测结果**。这不是模型问题，是证据链问题：只要反馈可以是被误采的遗留文本，反思就会用编造的机制填补空白。

**解决**（1.5.0）：

- `waitEvalResult(page, timeoutMs, { codeUnchanged })`——**只有本轮提交与上次送进评测的文本逐字节相同**才允许采信"面板与点击前一致"；代码变了就等满预算，返回带 `=== 本轮评测结果未确认 ===` 首行的文本，`verdictOf()` 一律判未通过（遗留面板写着「全部通过」也不判过）。
- 预算按面板「本关最大执行时间 N 秒」动态抬高（`max(配置预算, N + EVAL_GRACE_MS)`，`EVAL_BUDGET_CAP_MS` 兜底），评测中途新读到的面板同样能延长。
- `stale` 轮次的反思诊断**不进教训链**（改记一条"本轮未取得平台反馈"的事实），也不参与"连续同类报错重载"的签名计数。
- prompt 侧：反思器第 11/12 条要求「改动必须由本轮证据驱动」「机制断言必须引用报错原文/题面原文/平台事实档案」，材料标注未确认时**原样输出上一版代码**。

**排查方式**：日志里「结果面板文本与点击前一致」出现在点击后几秒内 = 高概率是遗留面板；对照 `agent/logs/agent-*.log` 的时间戳与面板自报执行时间即可判定。

---

### C-13. Python 3 语法写进 Python 2 平台：一轮评测只为换一个 SyntaxError

**现象**：代码逻辑正确、反思也"改对了"，评测却始终失败；面板里是 `SyntaxError: invalid syntax`，行号指向 `f(*a, x)` / `f"..."` / `def f(x: int) -> int:` 这类行。

**根因**：平台运行时是 Python 2（实测依据见 `shared/platform-facts.json` 的 `runtime` 段），而模型的默认输出面是 Python 3。禁用清单：PEP 448 解包后接位置实参（3.5+）、f-string（3.6+）、`:=`（3.8+）、类型注解与 `def f(a, *, b)`、`nonlocal`、`yield from`、`async/await`、`raise X from Y`、`except*`、字面量内 `[*a]`/`{**d}`、无参 `super()`。
**代价不对称**：本地检出是毫秒级，交给平台检出要「写入 + 一整轮评测（最长 120 秒）+ 一轮反思」。

**解决**（1.5.0）：

- `agent/src/py2-guard.mjs`：字符串/注释掩码 + 括号栈，只报"必定 SyntaxError"的形态，写入前拦截并打回反思修正（材料明确标注"本地守卫、未提交评测"，至多 2 次后照旧提交）。
- 清单的单一数据源仍是 `shared/platform-facts.json` 的 `python2_syntax` 段（两侧 prompt 自动继承）；守卫只负责"看得见摸得着"的那部分，措辞依据写在段里。
- 多键命令的正确形态：题面「相关知识」里的 `conn.blpop('blist', 'alist', 5)` 是 **Redis 命令语义**，不是 redis-py 签名——按旧版客户端把键**集合成一个列表**传：`conn.blpop(list(keys), timeout=10)`。

**预防**：任何"平台运行时比模型默认面旧"的项目都适用同一套——环境事实下沉到事实档案 + 提交前本地确定性检查，别用评测轮次换语法教训。

---

## 三、排查方法论

1. **先拿浏览器自己的日志**。Node 侧的报错往往是二手信息（见 E-5）。`--enable-logging --log-file=` 是 Chromium 系通用的。
2. **怀疑代理**。本地端口连不上时，先用 `curl --noproxy '*'` 直连一次排除代理干扰（见 E-2）。注意 Node `fetch` 默认不走代理而 Playwright 走，**同一个 URL 两种工具结果不同本身就是线索**。
3. **同一命令内验证 vs 跨命令验证**。浏览器类问题要区分"功能坏了"还是"进程死了"——在同一条命令里启动+探测能跑通，说明功能没问题，是进程存活问题（见 E-3）。
4. **对照实验定位归属**。Edge 不行就换 Chrome 试（见 E-4 与 E-3 的区分），Chrome 也不行说明是通用环境问题，Chrome 行说明是 Edge 特有机制。
5. **DOM 规则必须来自真实 dump**。`npm run dump` 导出结构快照，按快照写选择器；`probe` 的输出只能说明"识别到了什么"，不能说明"页面长什么样"。
6. **每个修复写回归用例**。`detectVerdict` 修复时顺带验证了 5 组文本用例，包括朴素 `includes` 匹配会误判的那条。

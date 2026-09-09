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

## 三、排查方法论

1. **先拿浏览器自己的日志**。Node 侧的报错往往是二手信息（见 E-5）。`--enable-logging --log-file=` 是 Chromium 系通用的。
2. **怀疑代理**。本地端口连不上时，先用 `curl --noproxy '*'` 直连一次排除代理干扰（见 E-2）。注意 Node `fetch` 默认不走代理而 Playwright 走，**同一个 URL 两种工具结果不同本身就是线索**。
3. **同一命令内验证 vs 跨命令验证**。浏览器类问题要区分"功能坏了"还是"进程死了"——在同一条命令里启动+探测能跑通，说明功能没问题，是进程存活问题（见 E-3）。
4. **对照实验定位归属**。Edge 不行就换 Chrome 试（见 E-4 与 E-3 的区分），Chrome 也不行说明是通用环境问题，Chrome 行说明是 Edge 特有机制。
5. **DOM 规则必须来自真实 dump**。`npm run dump` 导出结构快照，按快照写选择器；`probe` 的输出只能说明"识别到了什么"，不能说明"页面长什么样"。
6. **每个修复写回归用例**。`detectVerdict` 修复时顺带验证了 5 组文本用例，包括朴素 `includes` 匹配会误判的那条。

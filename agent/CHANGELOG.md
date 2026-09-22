# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [1.5.0] - 2026-09-22（分支 feat/2-c-web-service）

**一条被日志完整记下的连锁失效**（2026-09-22 真机，Redis 优先级队列关 `tasks/XBLSCWNL/4870`）。四个环节各自"看起来正常"，串起来让一道题的三轮反思全部建立在假证据上：

```
12:16:31 点击「评测」
12:16:35 判"未通过"            ← 只等了 4 秒，读到的是上一轮遗留面板
12:17:37 写入反思后的代码
12:17:46 / 12:18:02 / 12:18:19 点「评测」三次全被拦截   ← 第 1 轮的 120s 评测还在跑
12:18:27 未找到评测按钮，终止本题                      ← 第二版代码从未被评测
```

根因不是"AI 太笨"，而是**Agent 把没观测到的东西当成了观测结果**：等待预算 30s < 平台自报的本关最大执行时间 120s，「同错复现」捷径又在 3 秒闸门后采信了与点击前逐字符相同的面板；反思于是拿遗留文本编出了一个不存在的机制（"列表弹空后队列名会被 blpop 从有序集合隐式删除"），并给出在 Python 2 下**连语法都不过**的 `conn.blpop(*task_lists, 10)`（PEP 448 属 Python 3.5+）与零等待热自旋 `if not task_lists: continue`；紧接着第 2 轮点击落在仍在评测的页面上被拦截，重扫窗口 20s 到点即放弃 → 整题作废。

### Fixed

- **陈旧结果面板不再当本轮结论（`act.mjs` `waitEvalResult` 第 3 参数 `opts.codeUnchanged`）**：「同错复现」捷径此前只看"文本带结果面板标记 + 3 次采样稳定 + 已过 3 秒"，代码换了也照采。现在**只有本轮提交与上次送进评测的文本逐字节相同**才允许走捷径（`loop.mjs` 新增 `lastEvaluatedCode` / `lastEvaluatedCommands` 记账）；代码变了就等满预算，返回带 `STALE_EVAL_PREFIX` 首行的文本，由 `loop.mjs` 的 `verdictOf()` 统一判为未通过（遗留面板里写着「全部通过」也不能判过）。最短等待闸门 3s → 可配 `EVAL_UNCHANGED_MIN_MS`（默认 10s）
- **等待预算覆盖平台自报执行时间（`act.mjs` 新增纯函数 `parsePlatformMaxSeconds` / `evalDeadlineAt`）**：面板「本关最大执行时间：N 秒」这一栏就是本轮评测的最坏耗时；旧版固定 `EVAL_TIMEOUT_MS=30000` 在 120 秒的题目上必然中途放弃。现按 `max(配置预算, N + EVAL_GRACE_MS)` 抬高，`EVAL_BUDGET_CAP_MS` 兜住离谱自报值，评测中途新读到的面板也能继续延长
- **评测按钮点不动不再终止整题（`act.mjs` `clickByKeywords` 返回 `exists`）**：`sawAny` 此前只进日志、不进返回值，loop 只能把"点不动"和"页面没有按钮"一起当 `no-eval-button` 终止。现在两者分开（`eval-button-busy` / `no-eval-button`），`clickEval` 的重扫窗口 20s → `EVAL_CLICK_WAIT_MS`（默认 150s，覆盖上一轮评测仍在跑的情形），窗口内每轮补 `checkStop` 检查点，且按钮压根不存在时按 `absentGraceMs` 快速失败不拖满窗口
- **推测不得进教训链（`loop.mjs`）**：`stale` 轮次的反思诊断只打日志、不写入 `lessons`，改写一条事实性教训（"本轮未取得平台反馈，该轮改动均未验证"）——旧版会把编造的机制当真教训传给后面每一轮；同理 `stale` 轮不参与"连续同类报错重载"的签名计数（报错来自遗留面板，不是本轮）

### Added

- **`src/py2-guard.mjs`（新增，零依赖）+ 写入前本地语法守卫**：`checkPython2Syntax(code)` 检出「Python 2 下必定 SyntaxError」的 Python 3 形态——PEP 448（`f(*a, x)`）、f-string、`:=`、参数/返回值/变量注解、`def f(a, *, b)`、`nonlocal`、`yield from`、`async/await`、`raise X from Y`、`except*`、字面量内 `[*a]`/`{**d}`、无参 `super()`。实现是「字符串/注释掩码 + 括号栈」两轮：掩码保留等长与换行（行号可回溯，顺带在扫描前缀时抓 f-string），栈上区分 call/def/group/list/brace 帧，只在**实参起始位置**判解包，因此 `f(a * b)`、`x = (a\n * 2)` 的乘号与切片 `a[1::2]` 都不误报。取向是**宁漏不误报**（误报会让模型来回改本来正确的代码——本项目反复吃过横跳的亏），非 Python 提交整体跳过，检查器自身异常一律放行。命中即在 `loop.mjs` 打回反思修正（材料明确标注"未提交评测"，至多 `PY_GUARD_MAX=2` 次），不过则照旧提交
- **提交流水线抽出为 `finalizeSubmission(template, code)`（`loop.mjs`）**：拼接 → 空区域打点 → shell 护栏清洗 → echo 包裹，反思修正与守卫打回共用同一条路径；`isFragment` 残缺判据同步提为模块级 `isFragmentCode` 供守卫路径复用
- **反思/生成 prompt 加固（`shared/capabilities/`）**：反思器新增第 11 条「改动必须由本轮证据驱动」（材料标注"结果未确认/未捕获输出"时**原样输出上一版代码**，严禁以"更优/更优雅"为由改动未报错代码）、第 12 条「机制断言必须有出处」、第 13 条 Python 2 语法禁区、第 14 条「循环不得零等待空转」；原「事实优先级」归位为第 15 条（此前误挂在输出小节之后）。生成器规则 11 补「题面相关知识的 Python 片段是命令语义、不是 redis-py 可调用签名」，规则 15 的 py3 语法清单补全（含 PEP 448 与 `super()`）并加入热自旋禁令
- **`shared/platform-facts.json` 新增 `python2_syntax` 段与 `redis_py.cmd_examples_not_python_signature`**：语法禁区清单下沉到事实档案（单一数据源，两侧 prompt 自动继承），按 `_readme` 纪律标注依据（runtime 段实测 Python 2 + PEP 448 归属），并把两条尚未真机留证的条目（多键 blpop 的实际回显、`blpop(list(keys), timeout=10)` 形态）放进 `unknowns`
- **新增单测 20 项**：`test/py2-guard.test.mjs` 10 项（事故原文 / py2 合法综合样本零误报 / 字符串注释掩码 / 非 Python 跳过 / fail-open）+ `test/eval-freshness.test.mjs` 7 项（假时钟驱动，覆盖 30s/120s 量级预算也只跑几十毫秒）+ `test/click-fallback.test.mjs` 追加 3 项（`exists` 语义 / 快速失败 / 重扫窗口量级）

### Notes

- 验证：`npm test` **101/101**（改动前 81）；`npm run caps-check` 通过（7 个能力文件 + 事实档案）；`npx eslint src/` 通过；`npm run format:check` 全绿。守卫规则另按事故原文与 8 组对照样本逐条核验（`blpop(*lists, 10)` 命中、`blpop(list(lists), timeout=10)` 干净）
- **未验证边界**：本轮所有改动均为离线改动，**尚未在真机上跑过这道题**——`python2_syntax` 段与多键 blpop 的正确形态仍缺平台回显（已登记 `unknowns`）；守卫的实际打回效果需下次真机观察日志中的「本地语法守卫拦下 N 处」行确认；`EVAL_CLICK_WAIT_MS=150s` 是"上一轮评测仍在进行"假设下的取值，真机若表现为人机争抢按钮需再调
- 既有欠债不变：`npm run lint` 仍有 `test/ai.test.mjs` 的 `no-regex-spaces` 1 项（1.4.3 已登记，非本次引入，未一并改动）


## [1.4.4] - 2026-09-20（分支 feat/2-c-web-service）

**文档与格式收口**（无行为改动）：① 补齐 `shared/capabilities/README.md` 缺失的「加载前校验（fail-fast）」条目——该机制自 1.1.x 就在 `readCapability` 里跑，但本分支的 README 一直没写，属文档落后于代码；② `src/ai.mjs` / `src/loop.mjs` / `test/ai.test.mjs` 三文件不符合仓库自身的 `.prettierrc`（`printWidth: 100` 超宽未换行、多余括号、缺 `trailingComma`、个别引号风格），跑了 `npm run format` 归一；③ 修正 README 版本徽章滞后（写 1.3.0，实际 1.4.3）。

三处均经字符级核对确认**语义完全不变**（非空白差异仅 6 个新增尾逗号与 2 处引号风格），并通过全量单测。

## [1.4.3] - 2026-09-20（分支 feat/2-c-web-service）

**两处"静默失效"收口**：① 重载兜底在本平台不是"无效"而是"主动把干净模板换成污染草稿"；② 平台事实档案此前不在 caps-check 覆盖范围内，坏 JSON 只在运行时降级为空串。两者同属一类问题——**失效不产生错误、只产生更差的结果**。均为离线改动，无真机步骤。

### Fixed

- **重载兜底会覆盖干净模板存档（`loop.mjs`）**：旧判据是「重载后 `fresh.code` 非空即视为重取成功」。但本平台持久化草稿且无「恢复初始代码」，重载拿回的正是**上一轮自己提交的草稿**——于是走 `codeProbe = fresh` 把函数作用域里的干净原始模板**覆盖成污染草稿**，再强制基于它重新生成。净效果是拼接基准从"干净"降级为"污染"，比不触发更糟（1.4.1 CHANGELOG 第 53 行仅记为"无效"，措辞偏轻，此处更正）。现新增纯函数判据 `looksLikeOwnDraft(fresh, lastSubmitted)`：按"去空行 + 逐行 trim"归一化后精确相等即判定草稿（平台通常原样保存），不等时再用行集重合度 ≥0.85 且长度比 ≥0.85 防御轻量规整；命中则**保留原存档、不重新生成**，并把 `reloadCount` 置满以停用兜底、按反思继续。重载上限提为具名常量 `RELOAD_MAX`
- **判据取"实际拿回的内容"而非读 `platform-facts.json` 的 `editor.draft_persisted_by_platform`（设计取舍）**：① 平台行为可能随题目容器变化，实测内容永远比配置可信；② 事实档案是给 AI 的提示材料，不应同时充当代码分支开关（否则改一处风险面翻倍）

### Added

- **`src/platform-facts-schema.mjs`（新增，零依赖）**：把 `shared/platform-facts.json` 的填写纪律变成可执行的校验——事实段必须带证据（段级 `evidence` 或逐条 `<名>_evidence`）与 `date`(YYYY-MM-DD)；事实段内不得出现"待验证/未验证/待确认/推断"字样，也不得内嵌 `unknowns` 字段；`unknowns` 必须是字符串数组；顶层非 `_` 前缀字段必须是事实段对象。规则**全部取自该文件自己的 `_readme`**，不新增约定
- **`caps-check` 覆盖事实档案（`cli.mjs`）**：此前只校验 `shared/capabilities/*.json`，事实档案是盲区——坏 JSON 时 `buildPlatformFactsBlock` 仅在运行时降级为空串 + 告警一次，**prompt 静默退回「无平台事实」而解题链路不报错**（与 `capability-schema.mjs` 头注里"占位符拼错 → 静默渲染空串"同构）。现 fail-fast 并打印两行通过信息；文件路径收敛到 `cfg.paths.platformFactsFile`（`config.mjs`），`ai.mjs` 与 `cli.mjs` 共用一份真相
- **新增单测 16 项**：`test/reload-draft-guard.test.mjs` 6 项（草稿识别 / 空白与 CRLF 差异 / 原始模板不误判 / 同模板不同实现不误判 / 近似判据两条硬约束 / 空输入不判草稿）+ `test/platform-facts-schema.test.mjs` 10 项（真实档案通过 + 逐条故障注入）

### Notes

- 验证：`npm test` **81/81**；`npm run caps-check` 通过（7 个能力文件 + 事实档案）；`npm run lint` 与 `npm run format:check` 对本次新增/修改文件均通过
- **如实标注（本次未修，属既有欠债）**：`npm run format:check` 仍报 `src/ai.mjs`、`src/loop.mjs`、`test/ai.test.mjs` 三处漂移（经与 `HEAD` blob 逐一对齐确认为**本次改动之前**既有，非本次引入；`src/loop.mjs` 现存 2 处、`src/ai.mjs` 4 处、`test/ai.test.mjs` 3 处，均为长行未折行）；`npm run lint` 另有 `test/ai.test.mjs:202` 的 `no-regex-spaces` 1 项。跑一次 `npm run format` 与 `--fix` 即可清账，但会把这批无关重排混进本次语义修复，故留待单独提交
- **未验证边界**：本平台"重载无效"的结论来自 2026-09-20 单题真机实测（草稿持久化 + 无重置按钮）；`looksLikeOwnDraft` 的近似判据阈值（0.85）为防御性取值，**尚无真机样本覆盖到该分支**（真机命中应为精确相等分支）
- **package.json 版本对齐**：此前停留在 `1.4.1`（1.4.2 漏 bump），本次一并对齐到 `1.4.3`

## [1.4.2] - 2026-09-20（分支 feat/2-c-web-service）

**平台事实档案（单一数据源 + 统一注入）**。同一类根因（平台是老版本、与官方文档冲突）在两天内**连续两题复发**（IP 地址库、自动补全），说明"把事实散落成 prompt 规则"这条路必然漏——本次就漏在生成端。故收敛为**一处维护、处处注入**。

### Added

- **`shared/platform-facts.json`（新增，平台事实单一数据源）**：结构化记录**已实测**的平台事实（每条带 evidence 原文与 date）——Python 2 运行时、旧版 redis-py 的 `zadd` 实参顺序「先成员后分值」与「不支持字典写法」、`zrevrangebyscore(max,min)`、`open()` 无 `encoding=`、`zrank` 从 0 起、`zrange` 闭区间且返回 bytes、**评测方独占 stdout**、**返回 bytes 与 unicode 的 repr 形态差异**、编辑器草稿会被平台持久化且无「恢复初始代码」按钮。另设 `unknowns` 数组承载**待验证项**，与事实严格分离（防止把推断写成事实）
- **统一注入（`ai.mjs` `buildPlatformFactsBlock()` + `readCapability`）**：所有能力 prompt 在渲染后自动追加「### 平台事实（本平台实测结论，优先于任何官方文档与既有记忆）」段——**单一注入点，将来新增能力不会漏**。刻意**不缓存**（每次读盘），与既有"prompt 热生效"风格一致；文件缺失/损坏时降级为空串 + 告警一次，不阻断主流程
- **单测 `test/platform-facts.test.mjs`（3 项）**：事实档案可读且含关键事实 / **每个**能力 prompt 都带事实块（防新增能力漏注入）/ 注入不破坏原有 prompt 规则

### Notes

- 验证：`npm test` **65/65**；`npm run caps-check` 通过
- **真机实证（自动补全题，`/tasks/XBLSCWNL/4871/...`）**：按事实档案重写后**一次提交即通过**（`检测到「恭喜您通过本关」弹窗`）。同时判定三个此前只是"疑似"的结论：① `zadd(key, member, score)`（题面示例顺序）正确，字典写法与 Redis 官方顺序均失败；② **代码绝不能自己 print** 评测程序要打印的行（`The start/end range…` / `Add a few candidate word…`），函数内自加 print 会造成重复行 → 逐行比对失败；③ **返回 bytes 原样**（`['what', …]`），decode 成 unicode 会打印 `[u'what', …]` → 不匹配
- 边界：`buildPlatformFactsBlock` 的注入是**全量**的（不做任务相关性筛选），prompt 会因此变长（当前约 +1.6k 字符）；若后续能力数量继续增长，可考虑按能力裁剪。`caps-check` 目前**未**覆盖 `platform-facts.json` 的结构校验（只有 JSON 解析失败会被 `buildPlatformFactsBlock` 警告），留作后续

## [1.4.1] - 2026-09-20（分支 feat/2-c-web-service）

**真机根因修复：反思题干被截断 + 写入降级改坏代码 + 生成守则缺口**。题目 `/tasks/XBLSCWNL/4872/...`「使用Redis实现IP地址库」连续两次会话、20+ 轮全部失败；用「导出真实评测面板 → 在提交版本里注入探针」的方式逐条定位到 5 条独立根因，修复后**第 1 次评测即通过**。

### Fixed

- **反思题干被截断，要求细则整体丢失（`loop.mjs` `slimForReflection`，主因）**：双锚点用 `indexOf` 取**首次**出现，而评测页题干顶部有目录（"任务描述 相关知识 … 编程要求 测试说明"），两个锚点同时命中目录 → 窗口退化成题干开头约 1600 字，恰好切掉「编程要求」正文。本题因此丢失三条硬要求（"城市ID 加 _ 加当前行索引值做为成员"、"分值小于等于…分值最大的成员"、"去除 _ 及其之后"），反思 AI 看不到要求，反把**正确的** `city_id + "_" + str(count)` 判为"多余的_行号、破坏了城市 ID 的直接存储语义"主动删掉，越改越错。改为 `lastIndexOf` 取正文锚点 + 尾窗 1600→2400（实测窗口 1685→2125 字，要求与预期输出全部覆盖）
- **Monaco API 写入假阴性 → 降级键盘 → autoIndent 改坏缩进（`perceive.mjs`）**：回读用"去空白逐字符相等"强校验，平台异步重建模型时回读会略短（实测 950/967 非空白字符，其实是同一份代码）→ 判失败 → 降级 `keyboard.insertText` → Monaco autoIndent 逐行重排，给预缩进 Python 多加一层缩进 → 下轮评测 `IndentationError: unexpected indent`，反思还去追"不可见非法空白字符"这个幻影，白烧两轮。现：回读 ≥80% 即判为已写入（近似回读不再降级）；确实要降级时先 `updateOptions({autoIndent:'none',formatOnType:false,formatOnPaste:false})` 从源头消除
- **`spliceIntoTemplate` 直通模式丢编码声明（`ai.mjs`）**：直通分支整体采用 AI 输出，文件头全靠 AI 自觉复述模板；平台是 **Python 2**，缺 `#-*- coding:utf-8 -*-` 时任何中文注释都报 `SyntaxError: Non-ASCII character '\xe5' ... no encoding declared`。新增 `withTemplateLeadingDecl`：直通且 AI 输出前两行无声明的，补回模板声明行（幂等）

### Changed

- **生成器 prompt 新增 11~23 条、第 7 条收紧（`code_completion_generator_1`）**：① API 形态以题面「相关知识/示例」为准、禁止替换版本签名（真题：题面示例 `conn.zadd("testzset","member2",3)` 三参数旧式，模型改用 redis-py 3.x+ 字典写法 → `ZADD requires an equal number of values and scores`）；② 过滤/取值条件按题面字面实现，禁止把 `isdigit()` 当唯一放行条件（会把 IP 格式数据整份滤掉 → 写入 0 条）；③ 成员/分值语义禁止"简化"；④ 返回值与边界值同题面；⑤ Python 2 禁 f-string、注释一律英文、禁加题面未要求的 print（评测按 stdout 逐行比对）；⑥ 多组测试集必须全格式成立；⑦ 逐列取值加 `len(row)` 守卫、先过滤后取列；⑧ 禁用裸 `except: pass`；⑨ 题干末尾混入的编辑器旧代码与评测面板不是题面要求；⑩ **入参可能带尾随换行（`'14.134.0.0\n'`），不得用 `isdigit()` 拒绝平台合法输入**；⑪ 不得添加题面未要求的严格校验；⑫ 题面规定的实现手法（如"迭代法"）照做，不要换成位运算等等价写法
- **反思器 prompt 新增 6~10 条（`code_reflection_fixer_1`）**：改代码前先逐条核对题面硬性要求、禁止以"更简洁/多余"为由偏离；多组测试集逐组核对、某组为 0/空先怀疑过滤条件；禁用裸 except；stdout 逐行比对不得增输出；**查询类函数返回 None/空时先检查入参是否带换行**

### Notes

- 验证：`npm test` **59/59**（新增 `test/slim-for-reflection.test.mjs` 3 项，钉死"锚点必须落在正文章节"）；`npm run caps-check` 通过；`node --check` 全过
- 真机留证（面板原始文本 + 注入探针）：修复前 20+ 轮全败，失败签名依次为 `SyntaxError: Non-ASCII character`（直通丢声明）→ `ZADD requires an equal number of values and scores`（字典写法）→ `IndentationError`（写入降级）→ `IndexError: list index out of range`（短行先读 row[2]）→ `Redis ip2city sorted set ranges: 80008` 但查询返回 `None`；探针最终定位 `in='14.134.0.0\n' ip_int=None`
- 环境事实（首次留证）：该平台为 **Python 2 + 旧版 redis-py**（`zadd(key, member, score)` 三参数旧式写法、`zrevrangebyscore` 报 `min or max is not a float` 说明它按 float 解析）；评测含多组测试集，会打印有序集合基数逐项比对，面板末尾还有 `conn.delete(*to_del)` 清理（集合为空时会报 `wrong number of arguments for 'del' command`）
- 平台特性（如实标注，未修）：`probePage` 抽到的「题干」会混入编辑器现存代码与上一次评测结果面板（本题题干 3011→4551 字随编辑器内容变化），已用 prompt 第 ⑨ 条缓解，但从源头剥离需改 `perceive.mjs` 的题干抽取规则，留作后续

- **按钮点击加「有界重扫窗口」（`act.mjs` `clickByKeywords`，并顺手修掉一个误判）**：真机偶发「评测」按钮三次点击都被拦截（疑似被结果面板遮挡）→ 旧实现直接放弃 → `loop` 判 `未找到评测按钮` **终止整题**；但实测该按钮**存在且可见**（`评测 @1608,941 visible=true`），页面上也没有真实遮罩（唯一命中项是 Monaco 内部的 `margin-view-overlays`），属渲染/收起面板的瞬时态。现：`clickByKeywords` 增加有界重扫窗口（`settleMs`，每 `settleStepMs` 重扫一轮，到点即止，**绝不死循环**），`clickEval` 取 20s（本题成败关口，宁可等不可误判）、`clickNext` 取 4s（没有「下一题」是正常终止条件）；并把失败日志拆成「按钮不存在」与「按钮存在但始终未点中」两种——两者的排查方向完全不同（旧版统一报「未找到」，误导排查）。新增 `test/click-fallback.test.mjs` 3 项（首轮被拦截次轮点中 / 始终点不动时有界放弃 / 按钮不存在时不点击）。**边界（同轮真机实测，如实标注）**：该重扫窗口能覆盖"瞬时竞态"，但**对"持续遮挡态"无效**——实测同一页面状态连续重扫 20s 仍点不动（新日志正确报出「按钮存在但始终未点中」，而非旧版的「未找到」），**必须重载页面**才能恢复：重载后同一次运行「第 1 次评测即通过」。故本改动解决的是"误判 + 排查方向"，并为后续"点不动 → 重载并重试"的恢复策略铺好了判据（当前未实现，不声称已修）

### 补充（同日续查：另有 3 条根因，均真机留证）

- **题干/模板抽取有损（`perceive.mjs` `READ_CODE` 的 monaco 分支，最隐蔽）**：读的是 `.view-lines`——Monaco 虚拟渲染**只含当前可见行**。实测同一份代码：Monaco 模型真值 **1508 字符 / 3 对标记**，而 `probePage().code` 只读到 **861 字符 / 2 对标记**。被截断的模板一路污染：喂给 AI 的 `code_template` 残缺、模板标记计数错乱（拼接判据跟着错）、题干里混入半截代码。**已改为优先用 Monaco 模型 API 取全文，模型 API 不可用才退回可见区**（与 `writeEditorCode` 的回读策略一致——那里早已优先模型 API）；修复后复验提取与真值完全一致
- **日志假信号修复（`loop.mjs`）**：`拼接方式：模板 N 对标记` 用 `match(/\bbegin\b/i)` **漏了 `g` 标志**，只返回首个匹配 → 恒打印"1 对标记"。曾被它误导去追"模板被截断"（实际是日志缺陷）。已改为带 `g` 的计数。教训：**日志里的计数/告警本身也是代码，必须验证其正确性**
- **平台 `zadd` 实参顺序与 Redis 官方文档相反（prompt 已钉死）**：题面示例 `conn.zadd("testzset","member2",3)` 是「先成员后分值」；模型按官方 `ZADD key score member` 写成 `zadd(key, score, member)` → traceback 原文 `ResponseError: value is not a valid float`。生成器规则 11 已补"以题面示例的实参顺序为唯一依据，不得按官方文档顺序"

### 平台事实（未修，如实标注）

- **编辑器草稿被平台持久化**：`page.reload()` 与重新 `goto` 同一题目页**都拿不回平台原始模板**（实测：写入 482 字符原始模板后再次 goto，编辑器仍是上一次的 891 字符草稿）⇒ `loop.mjs` 的"连续同错 ≥3 轮重载题目页重取原始模板"兜底在本平台**无效**
- **页面无"恢复初始代码"按钮**（可点击元素仅 上一关 / 自测运行 / 评测 + 章节标签）⇒ 模板一旦被污染无法经 UI 复原。后续建议：从题干代码块提取原始模板作为兜底基准，或新增"清空编辑器"动作

## [1.4.0] - 2026-09-20（分支 feat/2-c-web-service）

**人工制动闸：网页工作台可手动停止解题**。评测反复不通过时，反思重试会一路烧到 `MAX_RETRY`（默认 10 轮；单轮含推理模型思考 + 25s 评测等待，最坏可挂十几分钟）。本版本给工作台加「■ 停止做题」按钮：置位中断标志后，解题链路在下一个检查点退出——**不再提交下一次评测、不再发起下一次 AI 调用**，在途的 AI 流式请求直接断流。

### Added

- **`src/control.mjs`（新增，运行控制层）**：`StopRequested` 异常 + `beginRun`/`endRun` 运行态 + `requestStop`/`checkStop`/`isStopping` + `onStop` 订阅（供在途请求 abort）+ `stopState` 快照。两条硬契约：① **未请求停止时检查点绝不抛**（不误杀正常解题）；② **轮次隔离**——停止请求记住"它发出时正在跑的是第几轮"，只对该轮生效，因此"点停止的同时又点了新解题"既不会误杀新任务，也不会让停止被静默吞掉（刻意不用时间戳比较：同毫秒内先后发生的事件无法靠时间区分）
- **检查点全链路埋入**：`loop.mjs`（`solveOnce` 整体包 `beginRun`/`endRun`，`endRun` 在 `finally` 保证运行态不悬空；题干意图判定、切换工作区、混合题数据准备每轮、命令行/代码反思循环每轮开头、写入编辑器前、**提交评测前**、两类反思调用前、重载题目页前）；`act.mjs`（`waitEvalResult` 轮询循环——单步最长的 25s 静默期、`runTerminalCommands` 逐条命令边界、`settle`）；`ai.mjs`（`chat` 每个重试轮开头）
- **在途 AI 请求即时断流（`ai.mjs`）**：`chat` 内 `onStop` 订阅在停止信号到达时 `ac.abort()`——推理模型 60~120s 的思考不必等自然结束；`catch` 内**优先判 `isStopping()`** 并抛 `StopRequested`，避免 abort 产生的 `AbortError` 被误描述成"端点空闲超时"再进入 800ms 退避重试
- **`POST /api/stop`（`web-server.mjs`）**：刻意**不走**浏览器操作互斥队列（否则请求会被在途解题挡在队尾，表现为"点了没反应"）。无运行中任务时明确返回 `stopped:false` + 原因且**不置标志**——避免"点了停止其实没停"的假反馈，也避免污染下一次解题
- **运行态可见（`GET /api/status` → `run`）**：`running` / `phase`（当前阶段，随检查点推进）/ `stopping` / `runningMs`；前端据此显示"运行中：等待评测结果"并实时校正按钮状态
- **控制台「■ 停止做题」按钮（`public/index.html`）**：仅真实解题期间可点（只读探测不开放），已请求停止则按钮变灰并提示"正在停止…"；停止**不是错误**——`/api/solve` 以 HTTP 200 + `stopped:true` 返回并附中断阶段（`stoppedAt`）
- **单测 `test/control.test.mjs`（6 项）**：检查点放行 + 顺带推进阶段、`StopRequested` 载荷与可判定标记、**轮次隔离**、运行态快照、订阅通知与退订、订阅者抛错不阻断停止流程

### Changed

- **CLI 各循环对手动停止优雅收场**：`run` / `course` 捕获 `StopRequested` 后打印已完成进度并正常退出（浏览器照常断开）；`watch` / `lite` 只中断当前这一题，监听继续（该页已在 `processed` 中，不会重复作答）

### Notes

- 验证：`npm test` 54/54（较 1.3.0 新增 6 项）；`node --check` 全过；`npm run caps-check` 不受影响（未改任何 prompt 与能力 JSON）
- 中断时延：停止发生在**当前步骤结束时**，最长约一次评测等待（`EVAL_TIMEOUT_MS`，默认 25s）；在途 AI 流式请求为即时断开
- 边界（如实标注）：检查点是**协作式**中断——playwright 的页面调用无法安全取消，故刻意不在点击/键入中途打断（否则会留下半写入的编辑器或半条终端命令），`writeEditorCode` / `clickEval` 等单次动作会先跑完再退。前端按钮 → `/api/stop` → 中断 → `stopped:true` 的完整链路**尚未在真机带调试端口的浏览器上实测**（需已登录评测站的环境），请按下方步骤自测确认
- 自测路径：双击 `start-web.bat` → 在受控浏览器打开题目页 → 点「解当前题」→ 日志出现「正在调用 AI …」或「等待评测结果」时点「■ 停止做题」→ 期望：按钮变「正在停止…」、日志出现「已收到「停止做题」请求——当前阶段：…」并在该步骤结束后出现「已停止当前解题：已手动停止，中断于「…」阶段」、结果区显示 `"stopped": true`

## [1.3.0] - 2026-09-15

**反思链路确定性 + 模板拼接兜底 + 模型配置双向同步**。本版本解决两个真机死循环：① 模板标记不成对/缩进被剥导致的 `IndentationError` 永续反思（购物车题）；② AI 对 Redis `zincrby` 参数顺序凭记忆反复横跳 3 轮（频率日志题）。核心思路：**拼接基准以"原始模板"为权威且可被重载纠正；反思以"报错回显的命令/测试输入"为证据，不再让 AI 凭记忆猜 API 签名；思考控制从"等超时"升级为"停滞/超字数主动断流"**。

### Added

- **完整代码直通（`ai.mjs` `spliceIntoTemplate`）**：AI 输出含 ≥2 个模块级语句（`import / from / def / class / @`）即视为"自成一体的完整代码"，直接返回 AI 输出、不再按标记归位——平台只按执行结果评测，整体直通最接近 AI 给出的正确完整实现。配套：**模板标记不成对（Begin ≠ End）同样整体直通**（2026-09-15 购物车题真机实证：模板 `get_cart_info` 只有 Begin 无 End，按标记归位会把 AI 输出中该函数实现整体丢弃 → 恒空函数体 → IndentationError 死循环）；新增单测 7 项覆盖（29→对应文件 36 项，全仓 48 项，下同）
- **代码反思教训链（`loop.mjs` / `ai.mjs` `reflectAndFix`）**：cmdline 分支本有的 Reflexion 式教训链对称接入代码分支——每轮反思诊断沉淀进 `lessons` 注入下一轮，根治"这轮改对了、下轮又退回"的横跳（频率日志题 zincrby 参数顺序 3 轮横跳即无记忆导致）。反思 prompt 新增 `{{input.lessons}}` 段（`code_reflection_fixer_1`）
- **Redis 报错解读守则（prompt 单一数据源，`code_reflection_fixer_1` 第 5 条）**：报错形如 `Command # N (ZINCRBY ...) ... value is not a valid float` → 括号内为本次实际执行的 Redis 命令，对照官方语法（`ZINCRBY key increment member` / `ZADD key score member`）核对参数位置，increment 位传了成员则交换实参——**严禁凭记忆猜 redis-py 版本签名**；`ZADD requires an equal number of values and scores` → 改题面模板示例给的三参数旧式写法
- **思考停滞检测 + 思考字数配额（`ai.mjs` chat 流式）**：正文 0 字时，① 思考长度 `AI_THINKING_STALL_MS`（默认 45s）无增长判为空转主动断流重试关思考；② 思考累计达 `AI_THINKING_MAX_CHARS`（默认 24000 字）强制断流重试关思考（防御弱推理模型无限思考烧光预算）。事故：实证思考 40986 字正文 0、`finish_reason=length`，纯时间硬闸只能傻等
- **长度兜底强化**：`finish_reason=length` 且正文为空时强制关思考重试（预算被思考吃光时空正文 = 思考过度而非模型瘫痪，关思考重试能快速出正文）
- **首轮默认关思考（`AI_FIRST_PASS_THINKING=0`，时间优先）**：首次生成关思考 5~10s 出初稿，失败后才动用反思轮的 high 思考档一次修对
- **模型配置双向同步（`web-server.mjs` + `public/index.html`）**：`/api/status` 每次请求比对 `.env.local`，手改文件自动检测差异并热生效（无需重启工作台）；新增 `/api/config` 支持页面写回模型名到 `.env.local`；页面模型输入框实时显示当前生效值——页面改、文件改两向同步
- **连续同类报错重载兜底（`loop.mjs` 代码分支）**：同一 Python 异常（如 `IndentationError`）连续 ≥3 轮 → 自动 `page.reload()` 重载题目页取回平台原始模板 → 重新探测更新存档 → 从干净模板重新生成，重载至多 2 次防死循环——配合函数作用域存档，模板污染可自愈

### Fixed

- **模板拼接缩进被剥（2026-09-15 实证真正根因）**：旧 `spliceIntoTemplate` 用 `trim()` 提取代码体，把首行前导空格整体剥掉（AI 输出 `    return ...` 拼完变顶格 `return ...`），评测 `IndentationError` 且反思"每次都改对、拼接次次剥掉"表象同源。改为**仅清理行尾空白、行首缩进原样保留**（`keepIndent` 逐行处理）——含 Begin/End 位于函数体内部（4 空格缩进）的场景
- **多标记模板只替换第一个块**：部分题目模板含多对 Begin/End 标记（如 Redis 令牌管理题三个函数各一对），旧实现只取第一对替换，后几个函数的实现被整体丢弃 → 评测 IndentationError 且反思死循环。改为按出现顺序逐对对应替换（AI 未带标记时整段填第一个块兼容旧行为）
- **残缺反思产物提交评测**：思考超限断流→强制关思考的重试轮偶发输出 45~207 字符碎片（无顶层语句），旧版"按现状提交"会把垃圾代码写进编辑器制造新语法错误、把下一轮带偏。现检测到即**不提交、自动重试一次**；重试仍残缺则丢弃，退回上一版完整代码提交兜底
- **`code_reflection_fixer_1` 缺 `lessons` 声明**：capability-schema 校验曾把反思 prompt 的 `{{input.lessons}}` 当占位符缺失告警——paramsSchema 补 `lessons` 属性（同步 `reflectAndFix` 渲染）

### Changed

- **思考硬闸默认值 20000 → 120000ms（时间优先调优）**：目标"最短时间通过"，high 档正常思考常达 60~120s，120s 内放行真思考；配合新增的停滞/字数双检测兜住空转与马拉松，而非生砍思考时间（5 分钟请求超时兜底终局）。`AI_THINKING_CAP_MS` 仍可调、`0` 关闭
- **`config.mjs`**：新增 `AI_THINKING_STALL_MS`（默认 45000）/ `AI_THINKING_MAX_CHARS`（默认 24000）/ `AI_FIRST_PASS_THINKING`（默认 0）；`.env.example` 同步补全配置项并校准 `AI_THINKING_CAP_MS` 默认值为 120000（此前 20000 与实现漂移）
- **反思/生成配置默认值**：`AI_THINKING_CAP_MS` 生效值随 `.env.local`（用户侧）；代码反思保持 `reasoningEffort: 'high'`（2026-09-15 实证：low 档近乎无思考、只能顺着评测文本说表面错误，high 档真正推演输出差异根因）

### Notes

- 验证：`npm test` 48/48（含完整的模板拼接直通/缩进/多标记/不成对、教训链渲染等用例）；`npm run caps-check` 通过（7 个能力文件占位符一致）；`node --check` 全过
- 真机实证：① 购物车题在模板标记不成对时，新直通逻辑一次通过（AI 输出 860 字符整体直通、第 1 次评测即"恭喜您通过本关"）；② 频率日志题在加入 Redis 守则 + 教训链后，`zincrby` 参数顺序不再横跳（此前 10 轮/约 4 分钟，含 3 轮同因横跳 + 1 轮残缺产物白费）
- 边界（如实标注）：重载兜底依赖平台重载后编辑器恢复为原始模板（真机实测 EduCoder 如此，其他平台待验证）；思考停滞/字数双检测只对流式通道生效（整体 JSON 兜底路径无中途流可掐）；`AI_FIRST_PASS_THINKING=1` 对需要深度推理的首题（如复杂算法）可能更稳，时间/质量权衡未见统计性结论

## [1.2.0] - 2026-09-13（分支 feat/2-c-web-service）

本版本两块内容：① 网页工作台（方案 C 最小落地）；② 智能挑页——`pickTargetPage` 升级为四级挑页链，eduCoder 官网与校内部署的题目页（`/tasks/<courseId>/<数字>/<串>`）**零配置自动识别**，不再依赖"第一个标签页就是题目页"的运气。由真机场景驱动：用户开着 5 个标签页（课程列表在前、题目页在后），工作台探测/解题永远选中最左边的课程列表页。

### Added

- **四级挑页链 `pickTargetPageWithMeta`（`src/browser.mjs`）**：① `TARGET_URL_HINT`（显式指定，最高优先；唯一命中即选，**多命中报错列出全部**防解错页，零命中告警后降级——旧版直接抛错）；② 内置题目页 URL 形状正则（复用 `TASK_URL_PATTERN`，与 watch/lite 同旋钮同源不漂移）；③ **内容级兜底**：URL 全落空时逐标签页跑单次探测 `looksLikeTaskPage`（强代码编辑器 Monaco/Ace/CM5/CM6——纯 textarea 不算，防普通网页评论框误报；评测结果面板专属标记；可见的评测/自测按钮），命中多个取标签序第一个并列日志；④ 最终兜底（历史行为：第一个非空白页）。每级命中都打日志（层级 + URL），消除"静默选错页"。`pickTargetPage` 保留为兼容薄包装
- **共享识别模块 `src/task-url.mjs`**：`taskKey`/`isTaskUrl` 从 `loop.mjs` 下沉（browser→loop 会成环），正则编译带缓存；`loop.mjs` 保留 `taskKey` 再导出兼容
- **`looksLikeTaskPage`（`src/perceive.mjs`）**：内容级轻量判题，每个 frame 一次 `evaluate`（逐页约百毫秒级），判据全部沿用既有通用启发式、不硬编码站点 selector
- **工作台挑页透明化**：`/api/probe` 响应新增 `pickedBy`（命中层级）与多候选时的 `candidates`；`/api/solve` 响应新增 `url` + `pickedBy`——工作台上能看到"解的是哪页、怎么选中的"
- **配置项文档补全**：`.env.example` 补上缺失的 `TASK_URL_PATTERN` 条目；`TARGET_URL_HINT` 注释改写为挑页链语义（平台题目页 URL 不是 `/tasks/` 形状时在此改特征片段）
- **`printConfig`**：新增 `TASK_URL_PATTERN` 行；`TARGET_URL_HINT` 未配置时提示自动识别而非"选第一个标签页"

### Changed

- **配置**：`agent/.env.local` 设 `TARGET_URL_HINT=/tasks/`（双保险 + 显式声明；清空即回到全自动识别）
- **版本**：`package.json` 1.1.1 → 1.2.0（工作台状态面板 `/api/status` 的 version 字段随之更新）

**网页工作台（方案 C 最小落地）**：把解题能力以本机 HTTP 服务 + 网页形式暴露。响应"多人使用/网页访问"的需求——注意这是**仅本机访问**的最小形态，真正的多用户需要浏览器池与账号隔离，不在本期范围。

### Added（网页工作台）

- **HTTP 服务 `src/web-server.mjs`**（Node 内置 `node:http`，零新增依赖）：`GET /` 静态页、`GET /api/status`（只读状态，不触发浏览器连接）、`POST /api/probe`（只读感知）、`POST /api/solve`（解当前题，编排/反思循环留在 agent 侧）、`GET /api/logs?since=n`（内存环形缓冲最近 200 条，增量轮询）。安全边界：仅绑定 `127.0.0.1`、端点固定无参数、不做任何用户 URL 抓取、不新增密钥面（AI 配置复用 `.env.local`）
- **单文件原生前端 `public/index.html`**：状态面板 + 探测/解题按钮 + 实时日志流。无 React、无构建链——尊重 2026-09-09 移除 React 工作台的决策，本服务刻意不重建该栈
- **双击入口 `start-web.bat`**（与既有 5 个 bat 同风格）；新增 `npm run web` 与配置项 `WEB_PORT`（默认 `8787`）
- **启动自检 CDP 调试端口 `src/port-check.mjs`**（node:net 零依赖）：watch / lite / course 启动时探测调试端口并给出人话状态（就绪打勾 / 无响应指引）；web 启动页在 listen 回调后同样自检——浏览器是懒连接，此刻不查的话"没开受控浏览器"要到点按钮才暴露。真机反馈驱动，冒烟实测就绪/无响应两条路径
- **logger 日志汇点 `addLogSink`**（`src/logger.mjs`，约 15 行）：常驻 UI 进程订阅日志流用，汇点异常只吞不外抛

### Added（能力配置校验——回灌自分支 feat/3-d-capability-guard）

- **能力 JSON 加载前校验 `src/capability-schema.mjs`**（零依赖，不引入 Ajv）：必填字段（`id` / `formValue.prompt` / `paramsSchema`）、prompt 占位符 ⊆ `paramsSchema.properties`（抓拼写错误——渲染时静默替换为空串）、`required` ⊆ `properties`（抓声明漂移）。`ai.mjs` 的 `readCapability` 首次读取时自动全量预检（fail-fast）；新增 CLI 命令 `npm run caps-check` 手动校验（不连浏览器、不调 AI）
- **单测 34→41 项**（新增 `test/capability-schema.test.mjs` 7 项）：真实 7 能力文件全通过的回归闸 + 四类故障注入用例
- 修复存量声明漂移：`code_reflection_fixer_1.json` 补声明 `terminal_state`（`ai.mjs` 实际已传该变量，仅元数据缺失，运行时行为不变）

### Fixed

- **`clientFact` 变量遮蔽（`src/loop.mjs`）**：cmdline 分支内同名局部变量遮蔽了函数级实测结论——命令行题触发「逃生舱」转代码分支时，`generateCode`/`reflectAndFix` 拿到的是空串，cmdline 阶段实测的客户端可用性事实（本机只有 mongo 没 mongosh 等）被静默丢弃。现 cmdline / mixed / 代码三分支共享同一份
- **死代码清理（`src/perceive.mjs`）**：删除 `findClickable`（循环首关键词即 return 的逻辑性死代码、全仓库无调用方）、`readEditorCode`（死导出且内部走全量 probePage 代价失当）、`PROBLEM_SIGNATURE`（恒 false 尸体常量）；文件头 EXPORTS 清单同步。纯删除，无行为变更
- **`src/web-server.mjs`**：`/api/probe` 的 `candidates` 组装逐页 try 包裹 `url()`——标签页销毁瞬间取 URL 抛错不再使整个探测请求 500

### Notes

- 验证：`npm test` 41/41（22 项核心纯函数 + 12 项挑页链 + 7 项能力配置校验，hint 唯一/多命中报错/零命中降级、URL 正则唯一/多命中报错、内容级兜底、探测异常跳过、最终回退等用例以假 page 对象覆盖）+ `npm run lint` 零问题；HTTP 真实链路冒烟——`/api/status` 报 `1.2.0`、无浏览器时调 `/api/probe` 触发自动拉起并完整走通「CDP 连接 → 挑页链 → probePage」，响应含 `pickedBy: "first-page"`（Tier 4 回退在真机上按预期工作）。**边界（如实标注）**：`url-pattern` / `content` 两层对真实题目页的命中需带登录态的调试浏览器开着题目页，留用户日常实测；多候选报错（同时开多个题目页）为设计行为，同上
- CDP 下 `document.visibilityState` 对所有标签页返回 visible（TROUBLESHOOTING C-4 实测），"优先挑用户正在看的标签"不可行，故多命中一律报错列出而非猜测
- `src/browser-session.mjs` 与分支 `feat/1-ad-mcp-server` 内容一致（懒连接 + 互斥串行 + 断线重连），两分支合并预期零冲突；`logger.mjs` 的 `emit` 两分支均有改动，合并时取并集即可
- 文档同步：`shared/capabilities/README.md` 中渲染函数名由 `renderPrompt` 修正为 `renderTemplate`（以 `ai.mjs:28` 实际实现为准，历史笔误）
- 分支说明落地：根 README 顶部、同学指南第七节、agent/README「网页工作台」均标明本分支与 master 的差异（网页工作台），并注明**无新增依赖**、切换分支无需重装
- 版本差异提示：本分支 = master 基线 + 网页工作台 + 四级挑页链 + 能力配置校验（回灌自 `feat/3-d-capability-guard`），**无新增依赖**，从其他分支切换后无需重新 `npm install`；MCP 出口层仅存在于 `feat/1-ad-mcp-server`（有新增依赖 `@modelcontextprotocol/sdk`，切换后需先 `npm install`）。各版本差异以该分支根 README 顶部「分支说明」为准，同学视角的版本选择见《同学使用指南》第七节

## [1.1.1] - 2026-09-11

代码栏数据库命令题通用加固：执行层 echo 包裹兜底 + 题面例子命令形态守则 + 结果面板遮挡点击修复。由 2026-09-11 真机（MongoDB 地理位置索引题：AI 反复输出裸命令、且把题面例子的 `db.runCommand` 换成 `aggregate $geoNear` 导致输出格式不符）驱动。

### Changed

- **执行层 echo 双引号包裹兜底（`ai.mjs` `wrapDbCommandsInEcho` + `loop.mjs` 接入）**：AI 即使不遵守守则输出裸 db 命令，提交前确定性包裹为 `echo "…"`（裸 `$` 转义、幂等）。触发条件收紧保证通用性——**仅当代码栏主体是 `db.` 命令集**（≥70% 非空行为 `db.`/`use` 命令、且非编程语言特征开头），不误伤 Python/Java/Node 脚本、字符串字面量、MySQL 的 SELECT/use 等
- **生成/反思守则强化（prompt 单一数据源）**：「严格按题面『相关知识/例子』给出的命令形态书写」（如 `db.runCommand({geoNear:...})`，禁止换成 `aggregate $geoNear`——输出格式由命令形态决定，平台按题面例子的返回结构比对）；反思侧「实际输出格式与预期不符（results/stats/ok vs 扁平文档）→ 检查是否用了题面例子之外的 API 形态」
- **结果面板遮挡点击通用处理（`act.mjs`）**：`clickByKeywords` 点击被拦截（`evaluate-result-container` 拦截 pointer events）时，自动收起结果面板（标题/面板左上角/Escape）后重试，重试失败换候选
- **TROUBLESHOOTING 新增 C-10**（结果面板遮挡点击）；C-9 预防补充「严格按题面例子命令形态」

### Notes

- 验证：索引题 AI 按守则直接生成 echo + runCommand（1243 字符，wrap 幂等跳过）；wrap 触发/幂等/误伤 7 组用例全过（裸命令包裹、已 echo 不重复、Python/Node/MySQL/字符串不触发、`$` 转义）
- 平台机制边界如实标注：echo 提取实测于 EduCoder Mongo 题；MySQL/其它平台未实测（但「bash+eval 双执行」平台的裸命令都会 bash 报错，echo 是通用 bash 包装）

## [1.1.0] - 2026-09-10

**工程化基建版本**：补单测、统一日志落盘、接入 lint 与格式化、修正元数据与忽略规则。业务逻辑零变更，但**新增的首批单测当场暴露并修复了一个真实的判定缺陷**——`detectVerdict` 会把 EduCoder 的「0 组不匹配」误判为未通过，白白触发整轮反思重试。

### Added

- **统一日志层 `src/logger.mjs`**：此前 `act` / `ai` / `loop` / `perceive` 四处各自定义 `log`（实现还不一致），现统一为 `createLogger(scope)`。控制台保持原有 `[scope] msg` 形态不变，**同时落盘到 `agent/logs/agent-<日期>.log`**（含完整时间戳与 INFO/WARN/ERROR 级别）。此前常驻模式跑完关掉终端窗口日志即丢失，而排查方法论（见 `docs/TROUBLESHOOTING.md`）恰恰依赖事后回溯。落盘失败只降级不中断——日志系统绝不能拖垮主流程；可用 `LOG_TO_FILE=0` 关闭
- **核心纯函数单测（22 项，`test/ai.test.mjs`）**：覆盖 `detectVerdict` / `sanitizeShellSubmission` / `spliceIntoTemplate` / `renderTemplate` / `parseAnswers`。零新增依赖（Node 内置 `node:test`），`npm test` 运行。其中 `sanitizeShellSubmission` 的「命令内部冒号不被误当标签分隔符」是 0.9.1 `lastIndexOf` 缺陷的回归用例
- **ESLint + Prettier**：`eslint.config.js`（flat config）+ `.prettierrc`，新增 `npm run lint` / `format` / `format:check`。配置刻意只开推荐集 + 少量高风险规则，并对 `page.evaluate` 内的浏览器上下文代码声明 browser globals，避免 60 处 `no-undef` 误报淹没真问题
- **`package.json` 元数据**：补 `engines`（README 声称 Node 18+ 但此前无约束）、`license`、`repository`、`author`

### Fixed

- **`detectVerdict` 零失败误判（1.1.0 最重要修复）**：否定词表含 `/不匹配/`，而 EduCoder 结果面板的「共 3 组测试，0 组不匹配」语义是**全部通过**，字面却命中否定词 → 被短路判为未通过，触发无谓的反思重试循环。新增 `ZERO_FAIL_PATTERNS`（`/0\s*组不匹配/`、`/全部匹配/`）**先于**否定短路判定。该函数在 `loop.mjs` 三处终判（218 / 380 / 525）被调用，修复直接生效
- `config.mjs`：`thinkingCapMs` 缩进错乱（在 `ai` 对象内却顶到 `timeoutMs` 层级）
- `ai.mjs:621`：正则多余转义 `[*\#]` → `[*#]`（行为等价，仅为消除 lint 噪声）
- `cli.mjs:149`：解构未使用的循环下标 `i`
- **`shared/capabilities/*.json`**：清除 7 个配置里的 `createdBy: 7575625665181912282`（平台账号 ID，此前已随公开仓库外发）。字段经核查仅 `formValue.prompt` 与 `formValue.modelParams` 被代码读取，删除无副作用；`createdAt` / `updatedAt` 等平台导出字段保留
- **`agent/.gitignore`**：此前忽略 `package-lock.json`，与根 `.gitignore` 注释「keep package-lock.json for consistent installs」直接矛盾，导致依赖版本未锁定。现修正并纳入版本控制

### Changed

- 四处重复 `log` 定义 → 统一 `createLogger(scope)`，并额外提供 `.warn()` / `.error()`
- 全量按 Prettier 风格格式化 `src/` 与 `test/`（纯格式变更，无语义改动）

### Notes

- 验证：`eslint src/ test/` 零问题；`npm test` 22/22 通过；9 个 `.mjs` 语法校验通过；`node src/cli.mjs` 冒烟正常（配置读取、浏览器探测与自动拉起均工作）
- 边界：单测仅覆盖与浏览器无关的纯函数，涉及 CDP / 页面交互的部分仍依赖真机验证，未声称已覆盖
- 未做：`solveOnce`（`loop.mjs:182`，392 行单函数）拆分仍属高风险重构，建议等测试更充分后再动

## [1.0.0] - 2026-09-10

**首个稳定版本**：完整破译 EduCoder 平台「命令行插入 + 代码栏查询」类题目的评测机制，并让 Agent 学会完整解题流程。由 2026-09-10 真机 20+ 次评测 + 抓包（`update_file`/`game_status`）+ 已通过题反推驱动，第 2、3 关当场验证通过。

### 平台机制破译（1.0.0 核心成果）

- **双重执行**：代码栏内容（含 Begin/End）提交为 `step2/query.sh`，平台先 bash 执行（裸 REPL 语句的 `(`/`{`/`[` 必报 syntax error，stderr 进实际输出标签前），再对每个测试点做 mongo shell eval（输出在标签后，只提取 `echo "..."` 双引号内容并反转义 `\$`→`$`）；`matchRule=full` 完全匹配
- **评测环境共享终端数据库**：题面要求「先在命令行插入文档」是必需步骤——评测时 `db` 指向题面指定的库，**未插入则查询结果为空**（第 3 关实测：`db.educoder.count()` 插入前 0、插入后 4）。早前「评测环境预置数据、无需插入」的判断被证伪
- **通过格式**：命令行插入题面文档 → 代码栏用 `echo "` 双引号包裹裸查询（分号 `;` 分隔、`$` 写成 `\$`）；heredoc / `mongo` 命令前缀 / `: ` 前缀实测全失败

### Changed

- **生成守则重写（`code_completion_generator_1` 第 7 条）**：命令列「先决条件——题面要求先在命令行插入文档时必须先插入（评测环境干净库）」+「代码栏用 echo 双引号包裹裸查询（分号分隔、\$ 转义）」；0.9.2 的「仅 \$ 转义」与 0.9.4 的 heredoc 守则被实测证伪
- **反思守则重写（`code_reflection_fixer_1` 第 4 条）**：按报错形态分流（`step2/query.sh: syntax error` → echo 双引号重写；`@(shell eval)` → 检查 echo 内查询/转义/分号；**查询结果为空 → 优先检查命令行是否已插入题面文档**）
- **mixed 分支强化（`loop.mjs`）**：数据准备约束明确「必须 insert/insertMany 插入题面文档到指定库，严禁跳过」；终端未出现时警告改为「未插入则查询结果为空」，不再误称「平台可能预置数据」
- **TROUBLESHOOTING C-9 重写**：记录双重执行机制、评测环境共享终端、echo 双引号通过格式与实测失败形态

### Notes

- 验证：第 2 关（$limit/$sort/$skip）与第 3 关（$group/$first/$avg/$unwind/$sum）真实评测通过（实际输出与预期逐字符一致，弹出通过弹窗）
- 本版本整合 0.9.x 全部能力：混合题路由与数据准备自愈、客户端可用性实测、评测判定加固、shell 护栏、思考硬闸、刷新触发、课程自动驾驶

## [0.9.4] - 2026-09-10

客户端探测时序修复 + 代码栏数据库命令 heredoc 守则。由 2026-09-10 真机截图驱动：① 终端明明有 `MISS:mongosh`/`HAVE:mongo` 回显，探测却报「未捕获 HAVE/MISS 行」——读取早于回显渲染；② 代码栏裸 REPL 语句即使把 `$` 写成 `\$` 仍报 bash syntax error——`(`、`{`、`[` 是 bash 语法字符，转义 `$` 只解决变量展开，解决不了语法冲突。

### Fixed

- **客户端探测时序（act.mjs）**：`probeTerminalClients` 原来用 `isTerminalAtPrompt` 当完成信号——探测命令刚粘贴时 xterm 的 DOM 渲染未落定，`.xterm-rows` 最后一行仍是旧提示符 `root@…:#`，判定「已回到提示符」立即 break，读取发生在回显之前（命令实际执行了、回显最终也渲染出来，却报未捕获）。改为轮询读取回显直到捕获 HAVE/MISS 行（上限 5s），不再依赖提示符信号

### Changed

- **代码栏数据库命令题 heredoc 守则（prompt 单一数据源）**：0.9.2 的「$ 写成 \$」守则不完整——bash 对 `(`（子 shell）、`{`（花括号块）、`[ ]`（测试语法）照样报 syntax error。`code_completion_generator_1` 第 7 条与 `code_reflection_fixer_1` 第 4 条重写：禁止把 REPL 语句裸写在代码栏，统一改用「客户端 + 单引号定界 heredoc」形态（`mongo <<'MONGOSH'` … `MONGOSH`，正文原样、bash 零解析，mongo / mongosh / mysql / redis-cli / psql 均支持）；题面转义说明（如「$ 前加转义符 \」「格式如 \;」）降级为语句顺序与分隔的参考
- **代码分支注入客户端实测（loop.mjs / ai.mjs）**：`clientFact` 提升为函数级，mixed 分支探测的结论注入代码生成（additional_requirements）与代码反思（`reflectAndFix` 新增 `terminalState` 参数 → 反思 prompt 新增 `{{input.terminal_state}}` 小节）——AI 拿到「本机只有 mongo 没有 mongosh」这类硬事实，heredoc 能选对客户端

### Notes

- 验证：`node --check` 全过；两个能力 JSON 可解析且 `createdBy` 等原字段原样保留（重建走纯文本替换 prompt 行，避免 JSON 精度丢失）；渲染冒烟确认 heredoc 守则与 terminal_state 占位符落位；端到端表现待该题重跑复测

## [0.9.3] - 2026-09-10

文档同步 + 冗余清理。0.9.2 落库后对全仓文档做一次一致性体检：以代码实际实现为准修正文档间矛盾表述，补齐 0.9.2 变更在文档侧的映射（配置项、工作流、踩坑手册），并清理本地旧会话日志。纯文档与清理变更，不涉及 Agent 行为。

### Changed

- **配置模板同步（agent/.env.example）**：补 `AI_REASONING_EFFORT` / `AI_ENABLE_THINKING` / `AI_THINKING_CAP_MS` / `AI_TIMEOUT_MS` 四项（默认值与 `config.mjs` 逐一核对）；`MAX_RETRY` 4→10、`EVAL_TIMEOUT_MS` 60000→25000，消除模板与实现默认值漂移
- **agent/README.md**：配置表补 4 个新配置项并核准全部默认值；工作流补混合题（mixed）流程、客户端可用性实测、shell 护栏、`$` 转义守则；设计要点新增第 7、8 条；已知限制同步 0.9.2 变化
- **README.md**：目录结构补 `inspect-dom.mjs`；踩坑数 12→14；修正三处与代码矛盾的表述——感知行补「混合题」、作答行改为「优先经编辑器 API 写入（键盘为回退，0.9.2 起与 act.mjs 实测行为一致）」、`task_router_1` 描述补 mixed
- **AGENTS.md**：模块说明同步 mixed 分流与 `detectTerminalEnv`/`probeTerminalClients`/`sanitizeShellSubmission`/`inspect-dom.mjs`；命令清单补 `course-probe`；Windows 入口补 `start-browser.bat`；约束补「环境事实靠实测，不靠模型记忆」与 0.9.2 转义守则
- **shared/capabilities/README.md**：`task_router_1` 用途补混合题（mixed）；新增 0.9.2 数据库命令转义守则说明（生成第 7 条 / 反思第 4 条）
- **agent/docs/TROUBLESHOOTING.md**：新增 C-8（mongosh 不存在 + 子命令被敲进 bash：客户端实测、【实测禁令】、别名替换、输入期反思自愈）与 C-9（代码栏内容被当 bash 脚本执行，裸 `$` 触发 syntax error 的生成/反思守则）

### Notes

- **矛盾修正原则**：文档间冲突一律以代码实际实现为准。本次唯一修正是根 README「代码题用键盘写入编辑器」→「优先编辑器 API、键盘为回退」，与 `act.mjs` 及 AGENTS.md/agent/README 的既有表述冲突，已统一
- **清理**：删除 `.workbuddy/memory/` 下 9-08/9-09 旧会话日志（该目录已被 .gitignore 排除，属本地工作区数据）；`agent/.browser-profile*/`、`agent/dumps/`、`agent/logs/` 为 gitignored 运行产物，保持不提交
- 验证：CHANGELOG 0.9.2/0.9.3 条目与当前代码行为逐项核对；全部内部链接/锚点指向的文件存在；「混合题」「客户端可用性实测」「转义守则」等术语跨文档一致；capabilities 目录实为 7 个 JSON，各文档计数一致

## [0.9.2] - 2026-09-10

混合题终端数据准备自愈 + 代码栏数据库命令转义守则。由 2026-09-10 真机截图（MongoDB 混合题：先命令行插入文档、再代码栏写查询）驱动——同一题终端与代码栏两处失败，全部根因经截图实锤定位。

### Added

- **混合题数据准备装备对齐 cmdline（loop.mjs）**：公共 helper `probeDbClients` / `applyCommandGuards` / `formatInputErrors`（cmdline 分支行为不变），mixed 分支数据准备接入客户端可用性实测（mongosh 不存在、仅 mongo 可用这类硬事实进 prompt）、【实测禁令】、执行层别名替换（`mongosh`→`mongo`，模型不听话也确定性改对）与 shell 护栏清洗。事故场景（真机截图）：旧版 mixed 裸调 generateCommands，AI 在无事实依据下输出本机不存在的 `mongosh`，后续 `use test2` / `db.educoder.remove({})` / `insertMany(...)` 被逐条敲进 bash 全部报错，插入文档失败且无任何重试
- **混合题数据准备输入期报错反思自愈（≤2 轮）**：第一轮若键入/执行即报错（入口命令不存在、子命令被敲进 bash），把输入期报错 + 终端回显喂回 `reflectCommands` 反思一轮后重做，避免「插入失败 → 代码查询空结果」连锁失败；两轮用尽按当前状态继续并日志明示

### Changed

- **代码栏数据库命令题转义守则（prompt 单一数据源）**：`code_completion_generator_1` 实现要求新增第 7 条——「在代码栏中编写数据库操作命令」类任务且题面给出执行/转义说明（如「测试时 $ 前加转义符 \」、「格式如 \;」）时，命令中的 `$` 一律写成 `\$`、命令分隔按题面示例，平台会把代码栏内容当 shell 脚本执行、裸 `$` 让脚本解析失败（bash syntax error）；`code_reflection_fixer_1` 解读守则新增第 4 条——`query.sh: line N: syntax error near unexpected token` 归因 `$` 未按题面转义/命令形态非脚本可执行，按题面转义说明重写。事故场景（真机截图）：AI 照搬裸语句 `db.educoder.aggregate([{$limit:3}])`，平台放进 `query.sh` 用 bash 执行报 syntax error，而题面已明确要求转义

### Notes

- 验证：`node --check` 全过、两个能力 JSON 可解析、渲染后新守则落位确认；端到端表现待该题重跑复测
- 0.9.1 为同日热修（反思全貌可见 + shell 护栏 + 混合题路由 + 评测判定加固），当时仅 bump package.json、CHANGELOG 未补条目，本次未回填以保持最小改动

## [0.9.0] - 2026-09-10

反思链路的速度与记忆：思考硬闸、终端环境感知、跨轮事实记忆、意图路由纠偏、评测判定提速。全部由 2026-09-10 凌晨真机连续排障驱动，每项修复均有真机日志/截图实锤。

### Added

- **🔴 思考硬闸 `AI_THINKING_CAP_MS`（默认 20s，0=不设限）**：流式响应中「仍在思考、正文 0 字」持续超限即主动断流，重试强制关思考——端点忽略思考参数时的最后防线。事故场景：反思调用思考 30s→1.2 万字、60s→2.5 万字击穿 16384 预算 → 空正文判失败 → 静默重试，单次反思拖到 2~3 分钟。真机验证：5037 字思考被 20s 硬闸截断 → 关思考重试 28.3s 完成生成，反思全程降至 6~8s
- **chat() 思考开关双通道 + 按调用覆盖**：新增 `opts.enableThinking`；关思考时同发 `chat_template_kwargs.enable_thinking=false`（vLLM/SGLang 系）与顶层 `enable_thinking=false`（DashScope/硅基流动系）并移除 `reasoning_effort`——0.7.0 的 `reasoningEffort:'low'` 反思降档实测被端点静默忽略（2.5 万字思考与「low 有界」探测结论直接矛盾），两个反思调用改传 `enableThinking:false`。硬闸仅对流式生效（整体 JSON 兜底路径无法中途拦截，注释已标注）
- **重试透明化**：chat() 重试前打印上一轮失败原因（含 finish_reason 与思考尾部）——此前 catch 静默吞错，用户只见「第 2/2 轮」凭空重开，失败原因不可见
- **终端环境感知 `detectTerminalEnv`（perceive.mjs）**：按 xterm 末行提示符形态识别 bash / mongosh（提取当前库名；裸 `>` 需近期输出有 mongo 痕迹防误报）/ mysql / redis / psql / neo4j / unknown，生成与反思前各探测一次，环境事实与书写约束注入 prompt（bash 严禁直接敲 use/db.xxx、REPL 内禁止重复进入与混写 bash）；识别为启发式，失败如实标 unknown 交模型自行判断
- **客户端可用性实测 `probeTerminalClients`（act.mjs）**：bash 环境且题干涉数据库时实测 mongosh/mongo/mysql/redis-cli/psql（`HAVE:/MISS:` 前缀行解析，终端定位逻辑抽公共 `findVisibleTerminal`）。事故场景：本机只有 `mongo` 没有 `mongosh`，无记忆的反思在两者间来回摇摆（第 2 轮用对 mongo、第 3 轮又退回 mongosh）——实测清单进 prompt 根治
- **跨轮事实记忆（反思不再是"带新证据的重试"）**：输入期 `command not found` 命令累积为【实测禁令】（只收干净词法名滤大表达式碎片）、各轮反思一句话分析沉淀为【历史教训】（Reflexion 式教训链，逐轮注入、尾部 6 条防膨胀）——反思每轮独立调用无记忆导致的"第 N 轮改对、第 N+1 轮退回"摇摆根治
- **分支逃生舱**：命令行 ≥2 轮命令全部跑通（无输入期报错）而评测轮轮失败 → 判定疑似意图路由误判，自动转代码分支重做；转入后编辑器模板为空则防呆终止。事故场景（用户定位根因）：MongoDB 题要求在代码模块中编写脚本，被误判 cmdline 全程跑偏
- **意图路由判定规则重写 + 第二证据（task_router_1）**：题干/「编程要求」含「在代码文件/代码模块/编辑器中编写、补全、编写脚本」等表述一律判 code（数据库脚本文件也是 code，不等于命令行题）；编辑器现有模板（`probe.code`，截 600 字）作为第二证据传入；含糊判 code（与解析层 `/\bcmdline\b/` 保守回落一致）。真机复测：该 MongoDB 题已正确判定 code、生成 4.7s、setValue 写入成功

### Changed

- **评测判定提速 + 弹窗时序加固（waitEvalResult 重写）**：轮询 800→400ms；「恭喜您通过本关」弹窗从"文本稳定后查一次"改为每轮轮询即时查（新增 `isPassModalVisible` 助手）；面板命中确定性成功词（全部通过/评测通过/答案正确/accepted/恭喜/0 组不匹配）且无失败词立即判过，不等稳定采样；文本无成功词时继续等弹窗至多 4s，面板未捕获（best 空）也查。通过题从 ~10s 误报未通过 → 弹窗出现秒判通过
- **反思提示词新增「当前终端状态」「历史教训」段**（cmdline_runner_1 第 12 条 / cmdline_reflection_fixer_1 第 4 条与自查清单扩充，prompt 单一数据源约定不变）：环境一致纪律（以当前 shell 语法书写、REPL 内不重复进入、换环境先 exit、bash 禁写数据库子命令）与教训吸收约束
- 生成/反思四处日志动态显示思考截断阈值（替代固定「推理模型可能需要 1~3 分钟」）

### Fixed

- **🔴「恭喜您通过本关」弹窗在场却判"未通过（未命中任何成功信号）"**：0.6.0 引入的弹窗兜底只在面板文本稳定后单次查询，晚于弹窗实际出现时点——见 Changed 首条，重写为轮询内即时查 + 迟到弹窗 4s 等待
- **补记（c71b312/c2739e1，已提交未入账）：题干提取剥离页眉导航噪声**——READ_PROBLEM 最长文本块头部混入 ~200 字平台页眉（用户名/积分/实验计时/菜单标签），关思考模型（0.8.0 默认）对头部噪声更敏感；从首个「第N关/本关任务」行起保留（通用启发式无平台硬编码），真机验证 5428→5361 字符且任务内容完整性全保留

### Notes

- 真机验证（2026-09-10 00:16~01:04 连续排障）：思考硬闸截断 → 关思考重试生成 28.3s、反思 6~8s；意图路由对该 MongoDB 题正确判 code；客户端探测/禁令/教训链就绪，完整通过链路待下一题复测
- 边界如实标注：逃生舱在真 cmdline 题内容性失败时可能多跑一轮代码分支（「模板为空」防呆可挡大部分误伤）；反思治的是有证据可依的事实性/结构性错误，预期输出本身不可见的题不在其能力范围
- 代码题分支（reflectAndFix）尚未对称接入教训链，待命令行题验证有效后跟进
- 版本号维持 0.x（1.0 待更多题量持续稳定后发布）

## [0.8.0] - 2026-09-09

`chat()` 流式化：推理模型的思考/正文实时可见，AI 调用不再有黑箱等待。

### Added

- **chat() 流式改造（SSE）**：`stream:true` + 逐块解析 `delta.content` / `delta.reasoning_content`；每 30s 心跳汇报「思考 X 字、正文 Y 字｜最新思考尾部…」——推理模型的长思考全程可见，等待不再是黑箱
- **空闲超时替代绝对超时**：手动 AbortController，每收到一块数据就重置计时——流式长生成不会被误杀，端点挂起/断流才触发（报 `AI 响应空闲超时`）
- **兼容兜底**：个别端点 `stream:true` 仍回整体 JSON 时自动走原解析路径

### Changed

- **生成预算封顶 16384**：`cmdline_runner_1` / `code_completion_generator_1` 32768→16384——马拉松思考改为"快速截断 → 带思考尾部的明确报错 → 重试"，配合流式可见性可控性更好；反思保持 32768，quiz 16384，路由 8192

### Fixed

- **ensureTaskPage 未覆盖 SPA 页内结果视图（0.7.0 缺口，真机实测）**：平台首次评测后有时把工作区顶换成全屏「实际输出」视图——**URL 保持 `/tasks/...` 不变**，0.7.0 的 URL 判据永不触发，只能用户手动返回，反思/重试全在错误视图上。现补充页内检测（编辑器与终端同时不可见 + 页面含「实际输出」「查看效果」）与三级关闭（class 含 close 的页面上部图标 → 点「查看效果」→ Escape），每步验证工作区真实恢复（编辑器或终端重新可见）；工作区可见时绝不误触发（活体验证）

### Notes

- 流式 SSE 解析与「思考尾部」诊断已 CDP/真机双验证（小预算调用返回完整思考尾部，证明解析链路正确）；完整任务链路待真机复测
- 预算耗尽时的报错现在自带思考尾部，可直接定位模型"卡在哪"

## [0.7.0] - 2026-09-09

评测后导航自愈 + AI 调用日志统一（真机反馈驱动）。

### Added

- **评测后自动返回题目页**：新增 `ensureTaskPage`（act.mjs）——评测后平台跳转到全屏「实际输出」结果页时，先抓结果页文本尾部作为反思证据，再按题目 URL 模式（`TASK_URL_PATTERN`）在浏览器上下文找回原题目页（bringToFront）或 `goBack` 后退；命令行/代码两分支失败路径接入，证据以「=== 评测结果页 ===」并入反思材料——不再需要用户手动返回
- **反思进度日志**：反思调用前预告静默期（与生成同款），完成输出耗时——消除"抓取明细后长时间无输出"的观感

### Changed

- **AI 调用日志统一**：四处调用点（生成命令/生成代码/命令反思/代码反思）统一为「正在调用 AI X（第 N 次）…推理模型可能需要 1~3 分钟」→「AI X 完成（第 N 次，…，耗时 X.Xs）」格式，实际耗时全部可见
- **推理模型预算再上调（复杂任务实测 8192 被思考独占耗尽）**：命令行生成/反思、代码生成/反思 8192/16384→**32768**，quiz 选择/批量 8192→16384，意图路由保持 8192——agnes-2.0-flash 对多集合文档操作类任务仅思考即可耗尽 8192，`finish_reason=length` 且 `content` 为空
- **反思降本三件套（输入瘦身 + effort 降档 + 输出约束）**：反思题干按「编程要求」锚取前后段（~1500 字，非全量 5361）、终端回显尾部 5000→2000、反思调用 effort 降档 low（chat() 支持按调用覆盖推理分级）、两个反思提示词加简洁约束（命令行：只写一句话分析；代码：分析 ≤3 句）——反思耗时与思考量预计减半以上，8192 预算从"被击穿"变为宽裕
- **推理模型思考默认关闭（根治思考拖垮/耗尽类问题）→ 升级为推理分级**：请求附 `reasoning_effort`（默认 **medium**，探测实证：思考 1612 字有界且多步命令完整覆盖，对比全开马拉松 74955 字、全关漏要求）；`AI_REASONING_EFFORT` 可调 low/medium/high；`AI_ENABLE_THINKING=0` 全关（极简场景）。真机验证：medium 默认档 mongo 查询任务 4.7s 完成
- **预算回归务实值（思考分级后输出可控）**：命令行生成/反思、代码生成/反思 32768→8192，quiz 批量 16384→4096，quiz 单题 16384→1024，意图路由 8192→512——预算回归"输出兜底"本位（均为预期输出的 3~5 倍余量）
- **回退「中文 \uXXXX 转义」生成规则（方案 2 实测净有害）**：该规则要求模型逐字计算 Unicode 码位，真机实测双重伤害——码位错误（丰 → `\u5346`，正确为 U+4E30）导致键入成功但落库数据与预期不匹配；中文多时码位计算思考暴涨击穿预算（间歇性 `finish_reason=length`）。中文键入由执行层合成 paste 事件承担（已真机验证），生成层恢复明文中文；预算上调（32768/16384）保留作为余量

### Notes

- 补充修复（b5ded98）：结果面板捕获排除内嵌终端/编辑器容器——嵌套放宽后"跨终端区+结果面板"包裹器卷入持续滚动的终端回显，捕获文本永不稳定、判定长时间不出
- `ensureTaskPage` 的 URL 判据复用 `TASK_URL_PATTERN`（换平台改这里）；上下文找不回题目页时 goBack 兜底，仍失败则按当前页面继续并打日志，不中断流程
- 结果页证据为全页 innerText 尾部 3000 字符；导航自愈与反思进度日志的端到端表现待真机验证

## [0.6.0] - 2026-09-09

命令行题可靠性增强：终端证据全量入反思、键入提速、运维知识沉淀进提示词。与 0.5.0 同日迭代，均源于真机排障。

### Fixed

- **🔴 终端键入中文丢字（MongoDB 题 `name:""` 反思循环不收敛的执行层根因）**：`keyboard.type` 对 CJK 被 xterm 丢弃（实测 `insert {_id:1,name:"李小红"}` 落库为 `name:""`）——反思诊断正确但执行层每次都坏，原理上无法收敛。非 ASCII 行改走**合成 paste 事件**直入 xterm 粘贴管线（CDP 真机验证中文完整上屏，测试残留已清理）；备选链 insertText / 剪贴板 API / execCommand 均实测不可用，已记录在代码注释。合成粘贴失败时回退 keyboard.type 并告警
- **🔴 通过判定漏报（评测成功却判"未命中任何成功信号"）**：成功面板的"1/1 全部通过"挂在深层容器，被标记路径 60 层嵌套上限排除，只抓到无判定词的页脚 → 保守误判未通过。标记路径嵌套上限放宽至 500（整页包裹器因含"任务描述"签名仍被排除）；`waitEvalResult` 新增兜底信号——捕获文本无成功词但页面出现「恭喜您通过本关」庆祝弹窗（平台权威通过宣告）时判为通过
- **🔴 heredoc 正文缩进被剥（MongoDB 双实例题第二断层）**：`parseCommandLines` 的 `l.trim()` 剥掉行首缩进，heredoc 写入的 YAML 被拍成扁平键值对 → mongod 报 `Unrecognized option: enabled`。改为仅去行尾空白、保留行首缩进；`Unrecognized option` 加入输入期报错特征表
- **🔴 命令解析器咬掉 `cat > ` 前缀（命令行题反复失败、反思永不收敛的最终根因）**：提示符剥离正则 `/^[\w.:@~-]+\s*[>#]\s+/` 把 `cat > file <<'EOF'` 误判为提示符形态，剥掉前缀后路径被 bash 当程序执行 → `No such file or directory`。按提示符形态分别匹配（`user@host:#`、`bash-5.1#`、已知 REPL 名 `testdb>/mongo>/mysql>` 等），重定向命令不再误伤；顺带修正 `(x)>` 括号形态缺口。13 用例回归全 PASS

### Changed

- **自适应命令间隔**（替代固定 1200ms）：回车后轮询终端最后非空行，提示符（`#`/`$`/`>`）返回即下一条——快命令 ~200ms 放行，慢命令等输出滚完，前台阻塞类由 `TERMINAL_GAP_MAX_MS`（默认 2500）兜底；键速 25→10ms/字符。32 条快命令场景总耗时约 50s→15s
- `MAX_RETRY` 单题反思重试上限 2→10（用户配置；失败题最坏耗时与 token 消耗随重试线性放大，配合失败差异明细使用，让每轮反思有据可依而非盲试）
- `agent/.env.local` 生效值：`EVAL_TIMEOUT_MS` 60000→30000、`MAX_RETRY` 4→10（`config.mjs` 默认值同步对齐）

### Added

- **命令行题反思可见全部终端显示**：`readTerminalText` 抓取时点移至反思时（评测等待期间终端持续滚动——服务启动/连接超时类报错在键入完成后数秒才出现，键入后立即抓会漏）；按行 `textContent` 读取修复词间空格丢失（innerText 实测把 "No such file" 读成 "Nosuchfile"）；尾部 5000 字符以「终端回显（本轮全部显示内容）」并入反思材料——不止输入的命令，本轮终端显示的一切都在
- **输入期报错检测**：`runTerminalCommands` 每条命令执行完做行级差分（新增 `readTerminalLines`），新增回显行命中报错特征（command not found / No such file / SyntaxError / Error: / exception / Traceback / refused / timeout / 错误 / 失败等）立即记为 `命令 N 输入期报错` 并打日志；评测失败时以「=== 输入期报错 ===」优先并入反思材料
- **命令行提示词防御加固（MongoDB 双实例题复盘产出，`mkdir -p` 父目录缺失类根治）**：`cmdline_runner_1` 新增生成期要求——写文件/建配置必须先 `mkdir -p` 父目录并 `ls` 验证、多行文件用单条 heredoc 写入（EOF 独占一行顶格）、服务启动前配置与数据目录必须就绪、启动后紧跟连通/进程检查、**JS 类 shell（mongo 等）中中文值一律 `\uXXXX` 转义代替明文（键入保真双保险：执行层合成 paste + 生成层转义）**；`cmdline_reflection_fixer_1` 自查清单新增三条失败映射——`No such file or directory` → 父目录缺失（mkdir 后重写并验证）、`Connection refused` → 回查服务启动命令自身的报错（配置缺失 / dbPath 目录缺失）后再启动验证、**插入的中文值变空串 → JS shell 改用 `\uXXXX` 转义重写**

### Notes

- ✅ **端到端验证通过（2026-09-09 19:58，MongoDB 双实例 cmdline 题真机实测）**：`mkdir -p` → heredoc 写入带缩进配置（`ls -l` 确认 192×2 字节落盘）→ `mongod -f` fork 启动 → `ping` 连通 → 评测通过，修复后全链路一次跑通；此前连续三轮失败的 `cat >` 前缀咬字与缩进剥除两个断层均确认修复
- 其余验证：全部源文件 `node --check` 与模块导入冒烟、命令解析器 13+6 用例回归全 PASS、结果面板标记与平台 Monaco 全局结构经 CDP 只读探测确认
- 版本号维持 0.x；单题跑通 ≠ 统计性成功率，1.0 待更多题量持续稳定后发布

## [0.5.0] - 2026-09-09

推理模型适配与「写入 → 评测 → 反思」全链路加固。当日多轮真机排障驱动，全部根因经 CDP 只读探测与用户截图实锤定位。

### Fixed

- **推理模型 max_tokens 预算耗尽（lite 全链路失败的首要根因）**：AI_MODEL 换用推理模型（先输出 `reasoning_content` 再输出 `content`，思考与回答共享预算）后，意图路由 16 token 预算全被思考耗尽、`content` 恒空 → 确定性失败。`task_router_1` 16→8192，其余能力配置整体调大（quiz/cmdline 2048/4096→8192，代码生成/反思 8192→16384）；`classifyProblemIntent` 弃硬编码改读能力配置，消除参数双份漂移
- **写入排版错乱（代码题作答失败主因）**：Monaco 的 formatOnPaste/autoIndent 会把 `insertText` 进来的预缩进 Python 逐行重排（阶梯状缩进 → 评测 IndentationError）。`writeEditorCode` 改为分层写入：优先编辑器/平台 API——CDP 实探发现平台把 monaco 命名空间暴露为大写 `window.Monaco`（另有平台自有设值入口 `window.updateMonacoValue`），命名空间按 `window.monaco ?? window.Monaco` 解析，逐级尝试 monaco/CM5 `setValue` → 平台 setter，键盘路径降为回退；每次写入后做「去空白逐字符相等」强验证。`AGENTS.md` / `agent/README.md` 写入约束同步改写
- **评测结果面板误抓题干（60s 空等与"空结果"误报根因）**：题干区也含"测试说明/运行"等宽泛关键词且以长度优势在"取最长匹配块"启发式下稳定胜出，题干文本评测前后不变 → 判变化逻辑失效。`READ_EVAL_PANEL` 改为结果面板专属标记优先（`共有N组测试集` / `本关最大执行时间` / `测试结果`，含"任务描述"签名的题干块直接排除），旧关键词启发式降为兜底
- **"同错复现"空等**：新评测结果与点击前面板完全一致（同代码同错误）时"等变化"永远等不到——结果标记命中且连续 3 次采样稳定（约 5s）即直接采用，不再烧满超时预算后误报"空结果"
- **测试集明细抓空**：`collectTestSetDetails` 曾命中纯标签行迷你容器（仅百余字符空壳喂给反思）；增加正文门槛（预期+实际去空白 ≥20 字符），采集为空时强制展开全部折叠头重采自愈
- **回读验证 ReferenceError**：写入回读验证引用 perceive.mjs 中不存在的 `log` 致运行时中断评测；补 `[perceive]` logger。回读升级为 Monaco 模型 API 优先（view-lines 虚拟渲染只含可见行、长代码回读必然偏短的假阴性根治），未暴露全局时退回可见区近似读取
- `agent/.env.local` 生效值 `EVAL_TIMEOUT_MS` 60000→30000（`config.mjs` 默认 25000 不变）

### Added

- **评测失败差异增强**：新增 `collectTestSetDetails`（act.mjs）——失败后自动展开「测试集N」折叠块，结构化抓取预期输出 vs 实际输出（多 frame 扫描、防误折叠已展开块、剔除「展示原始输出」/页脚噪音、8 组×1200 字符上限）；代码题与命令行题的反思均携带
- **命令行题反思可见终端回显**：新增 `readTerminalText`（perceive.mjs）——读取 xterm 终端回显并入命令行题反思材料，输入/执行期错误不再只留在终端里
- **代码题反思携带实际提交代码**：`spliceIntoTemplate` 后的提交版（实际写入并评测的那份）作为 `previous_code` 传给反思，替代 AI 原始输出
- **请求超时**：新增 `AI_TIMEOUT_MS`（默认 5 分钟），端点挂起按失败重试，loop 不再永久停摆
- **生成期可观测性**：代码/命令生成前预告静默期（推理模型 1~3 分钟）、完成后输出耗时；写入日志标注写入方式（API/键盘）与回读验证结果

### Notes

- 已验证：全部源文件 `node --check` 与模块导入冒烟、7 个能力 JSON 可解析、结果面板标记与测试集切分算法按 CDP 只读探测的真实页面结构验证、平台 Monaco 全局结构实探确认
- 端到端作答成功率取决于 AI 生成质量，本版本未做统计性验证；版本号维持 0.x（1.0 待端到端稳定性验证后再发布）

## [0.4.0] - 2026-09-09

### Added

- **命令行题型支持（cmdline）**：面向头歌类平台的数据库/运维任务（右侧含「命令行」标签 + xterm 终端）。每次作答先读左侧题干，由 AI 意图路由器（`task_router_1`）按**题干内容**判定该题是写代码文件（code）还是敲命令行（cmdline）——判定依据与当前激活的 tab 无关，判定后自动切换到对应工作区
- `ai.mjs` 新增 `classifyProblemIntent`（意图路由）、`generateCommands`（命令生成，`cmdline_runner_1`）、`reflectCommands`（命令行反思，`cmdline_reflection_fixer_1`）、`parseCommandLines`（剥 markdown 围栏 / 注释行 / `$` 与 REPL 提示符，含 `testdb>`、`root@host:~#` 形态，8 用例单测通过）
- `act.mjs` 新增 `switchTaskTab`（切换「命令行/代码文件」标签，激活态自检跳过；结构依据真实 dump：`div[class*="item___"]` + 激活类 `active`）与 `runTerminalCommands`（真实键盘逐条键入 xterm，每条回车间隔 1.2s，遵循 DRY_RUN 守卫）
- `perceive.mjs` 新增 `waitForTerminal` / `waitForEditor`（切 tab 后内容懒渲染的轻量轮询等待）
- `loop.mjs` `solveOnce` 重构：选择题/填空题仍按结构信号直接作答；代码/命令行题统一先意图判定 → 切 tab → 分流执行，两分支均保留反思修正循环（`MAX_RETRY` 轮）；命令行 tab 激活时编辑器 DOM 不存在（懒渲染），原实现会误判走代码分支导致评测不匹配
- 新增能力配置：`shared/capabilities/task_router_1.json`、`cmdline_runner_1.json`、`cmdline_reflection_fixer_1.json`（prompt 单一数据源约定不变）

### Added（lite 刷新触发模式）

- **刷新触发模式 `npm run lite`**（新增 `start-lite.bat` 双击入口，纯 ASCII）：常驻监听下**刷新任意题目页（F5）即重新自动作答**。做题流程与 watch 完全一致（生成 → 评测 → 失败反思修复 → 重评，最多 `MAX_RETRY` 轮），同样不替用户翻页
- 与 watch 模式的核心区别：watch 按 URL 去重、同一题只做一次；lite 每次刷新都重做——反思重试仍未通过时，用户刷新页面即可让 agent 重新完整作答（刷新 = 人工触发的重做信号）
- `loop.mjs` 新增 `liteLoop`：以 `window.__liteHandled` 注入标记检测页面刷新（刷新销毁执行环境、标记消失即触发；SPA 软导航不销毁 `window` 不会误触发），作答前先补标记防止同一轮询周期内重复触发；轮询间隔 / 题目 URL 模式 / 渲染超时复用 watch 的 `WATCH_POLL_MS` / `TASK_URL_PATTERN` / `READY_TIMEOUT_MS`，零新增配置

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

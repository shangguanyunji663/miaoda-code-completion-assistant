// EXPORTS: clickEval, waitEvalResult, clickNext, answerChoice, fillBlank, settle,
//          readTaskNo, waitTaskAdvance, clickExitTask, clickBackArrow,
//          clickContinueChallenge, clickStartLearning, switchTaskTab, runTerminalCommands,
//          collectTestSetDetails
// 执行层：所有真实点击 / 输入动作。受 DRY_RUN 控制——干跑时只打日志不动页面。

import { cfg } from './config.mjs';
import { readEvalPanel, isTerminalAtPrompt, readTerminalLines } from './perceive.mjs';

// 按钮文本关键词（按优先级排序，模糊匹配）。
// 不同平台用词不同，这里给一份较全的兜底列表，实际按站点精调时改这里即可。
export const BTN_EVAL = ['评测', '评 测', '提交评测', '提交', '运行', '运行评测', '判题', '测评'];
export const BTN_NEXT = ['下一题', '下一关', '下一个', '下一节', '继续', '下一页', '下一任务'];

function log(msg) {
  console.log(`[act] ${msg}`);
}

/** 干跑守卫：dryRun 时记录并返回 false，不执行真实动作 */
function guard(action) {
  if (cfg.loop.dryRun) {
    log(`DRY_RUN 跳过：${action}`);
    return false;
  }
  return true;
}

/** 按关键词列表点击第一个可见按钮 */
async function clickByKeywords(page, keywords, label) {
  for (const kw of keywords) {
    // 按角色优先级尝试。实测该评测平台上「评测」是 <button>，而「上一关/下一关」
    // 是 <a>（class ghost-link），只查 button 会漏掉后者，因此必须覆盖 link。
    // 最后退化为精确文本匹配，兜住非标准角色元素。
    const candidates = [
      page.getByRole('button', { name: kw, exact: false }),
      page.getByRole('link', { name: kw, exact: false }),
      page.getByText(kw, { exact: true }),
    ];
    for (const loc of candidates) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        if (!guard(`点击「${label}」（匹配词：${kw}）`)) return { clicked: false, keyword: kw };
        await el.click({ timeout: 8000 });
        log(`已点击「${label}」（匹配词：${kw}）`);
        return { clicked: true, keyword: kw };
      }
    }
  }
  log(`未找到「${label}」按钮（尝试词：${keywords.join('/')}）`);
  return { clicked: false, keyword: null };
}

/**
 * 写入代码后的静置：点击编辑器外部触发平台自动保存，再等待若干秒。
 * 依据：README 第 65 行明确提示「先点击编辑器外部或稍等 2-3 秒让平台自动保存完成，
 * 再点评测，否则可能评测到旧代码」。
 */
export async function settle(page) {
  if (!guard('写入后静置')) return;
  await page.mouse.click(5, 5).catch(() => {});
  await page.waitForTimeout(cfg.loop.cooldownMs);
}

/** 点击「评测」按钮 */
export async function clickEval(page) {
  return clickByKeywords(page, BTN_EVAL, '评测');
}

/** 点击「下一题」按钮 */
export async function clickNext(page) {
  return clickByKeywords(page, BTN_NEXT, '下一题');
}

/**
 * 等待评测结果出现并稳定。
 * 策略：用轻量探针（readEvalPanel，含 iframe 扫描）轮询结果面板文本，
 * 直到与点击前不同、且连续 3 次采样保持不变。
 * 相比旧版逐轮跑全页探测（probePage，每轮多次 evaluate、秒级延迟），
 * 现在每轮只做一次 evaluate，出结果后 ~2.4s 内即可判定。
 * @returns {Promise<string>} 评测结果文本
 */
export async function waitEvalResult(page, timeoutMs = cfg.loop.evalTimeoutMs) {
  const before = await readEvalPanel(page);
  const start = Date.now();
  const deadline = start + timeoutMs;
  let last = before;
  let stableCount = 0;
  let best = '';
  // 与 readEvalPanel 的结果标记策略配套：判定捕获文本是否带结果面板特征
  const hasResultMarker = (t) =>
    /共有\s*\d+\s*组测试集|本关最大执行时间|测试结果/.test(t ?? '');

  while (Date.now() < deadline) {
    await page.waitForTimeout(800);
    const now = await readEvalPanel(page);
    if (now && now !== before) {
      if (now === last) {
        stableCount++;
        if (stableCount >= 3) {
          best = now;
          break;
        }
      } else {
        stableCount = 1;
      }
      best = now;
      last = now;
    } else if (now && hasResultMarker(now) && Date.now() - start > 3000) {
      // 同错复现场景（2026-09-09 实测 60s 空等）：新评测结果与点击前面板
      // 完全一致（同代码同错误），"等变化"永远等不到。文本带结果面板标记
      // 且连续 3 次采样稳定即直接采用，避免烧满超时预算后误报"空结果"。
      stableCount++;
      if (stableCount >= 3) {
        best = now;
        log('结果面板文本与点击前一致（同错复现），连续 3 次稳定后直接采用');
        break;
      }
    }
  }

  if (!best) {
    log(
      `${Math.round(timeoutMs / 1000)}s 内未捕获到评测结果文本（提交本身可能已成功）。` +
        '请在题目页保持该状态立即执行 npm run dump，把 dumps JSON 发给开发侧按真实结构精调结果面板识别',
    );
  }
  return best;
}

/**
 * 作答单选题：按选项文本匹配并点击。
 * 同时兼容两种 DOM：Ant Design 下文本挂在 `a` 上，朴素结构下挂在 `label` 上。
 */
export async function answerChoice(page, optionText) {
  const norm = (s) => String(s).replace(/\s+/g, '').replace(/^[A-Za-z][.、:：]\s*/, '');
  const target = norm(optionText);

  for (const sel of ['a', 'label']) {
    const items = page.locator(sel);
    const n = await items.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = items.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      // 只考虑内部含 radio/checkbox 的选项容器，避免点到导航链接
      if ((await el.locator('input[type="radio"], input[type="checkbox"]').count()) === 0) continue;
      const t = norm(await el.innerText().catch(() => ''));
      if (t && (t.includes(target) || target.includes(t))) {
        if (!guard(`选择选项「${t.slice(0, 30)}」`)) return { answered: false };
        await el.click({ timeout: 5000 });
        log(`已选择选项：${t.slice(0, 40)}`);
        return { answered: true, text: t };
      }
    }
  }
  log(`未匹配到选项：${optionText}`);
  return { answered: false };
}

/**
 * 按 AI 批量答案勾选整页选择题。
 *
 * 定位策略：题号 → ul.choose-container 的第 N 个 li；选项字母 → 该 li 内第 M 个 a
 * （A=0, B=1...）。不依赖字母文本解析，但会校验该 a 的文本确实以对应字母开头，
 * 顺序若与页面不符会直接报错而不是默默点错。
 *
 * @param {import('playwright-core').Page} page
 * @param {Array<{no:number, options:string[], multi:boolean, stem:string}>} questions
 * @param {Record<number,string>} answersMap 形如 {1:'A', 3:'AC'}
 */
export async function applyAnswers(page, questions, answersMap) {
  const ul = page.locator('ul.choose-container');
  const results = [];

  for (const q of questions) {
    const letters = answersMap[q.no];
    if (!letters) {
      results.push({ no: q.no, ok: false, reason: 'AI 未给出答案' });
      continue;
    }
    const li = ul.locator('> li').nth(q.no - 1);
    for (const ch of letters) {
      const idx = ch.charCodeAt(0) - 65; // A -> 0
      if (idx < 0 || idx >= q.options.length) {
        results.push({ no: q.no, letter: ch, ok: false, reason: '字母超出选项范围' });
        continue;
      }
      const a = li.locator('a').nth(idx);
      const txt = ((await a.innerText().catch(() => '')) || '').replace(/\s+/g, '');
      if (!txt.toUpperCase().startsWith(ch)) {
        results.push({
          no: q.no,
          letter: ch,
          ok: false,
          reason: `第 ${idx + 1} 个选项文本不以 ${ch} 开头（实际：${txt.slice(0, 20)}），疑似页面顺序与字母不对应`,
        });
        continue;
      }
      if (!guard(`勾选第 ${q.no} 题 ${ch}（${txt.slice(0, 30)}）`)) {
        results.push({ no: q.no, letter: ch, ok: true, dryRun: true });
        continue;
      }
      await a.click({ timeout: 5000 });
      log(`第 ${q.no} 题已勾选 ${ch}：${txt.slice(0, 40)}`);
      results.push({ no: q.no, letter: ch, ok: true });
    }
  }
  return results;
}

/**
 * 作答填空题：写入第一个可见文本输入框
 */
export async function fillBlank(page, text) {
  const inputs = page.locator('input[type="text"], input:not([type])');
  const n = await inputs.count().catch(() => 0);
  if (n === 0) {
    log('未找到文本填空输入框');
    return { filled: false };
  }
  const el = inputs.first();
  if (!guard(`填入答案「${String(text).slice(0, 30)}」`)) return { filled: false };
  await el.click({ timeout: 5000 }).catch(() => {});
  await el.fill(String(text));
  log(`已填入：${String(text).slice(0, 40)}`);
  return { filled: true };
}

// ---- 课程自动驾驶（course）模式的导航动作 ----

/**
 * 读取当前关卡序号（页面文本中的「第 N 关」），非关卡页返回 null。
 * 用于「下一关」是否跳转的判定：课程平台切关多为 SPA 局部刷新，URL 不变，
 * 只有关卡标题里的序号会变，因此 URL 与序号任一变化即算跳转成功。
 */
export async function readTaskNo(page) {
  return page
    .evaluate(() => {
      const m = (document.body?.innerText ?? '').match(/第\s*(\d+)\s*关/);
      return m ? Number(m[1]) : null;
    })
    .catch(() => null);
}

/**
 * 等待「下一关」产生跳转：URL 或关卡序号任一变化即算成功。
 * @param {{url: string, taskNo: number|null}} before 点击前快照
 * @returns {Promise<boolean>} true=已跳转；false=超时未变（判定板块做完）
 */
export async function waitTaskAdvance(page, before, timeoutMs = cfg.course.navTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const taskNo = await readTaskNo(page);
    if (page.url() !== before.url) return true;
    if (before.taskNo != null && taskNo != null && taskNo !== before.taskNo) return true;
  }
  return false;
}

/** 点击任务页右上角「退出」（电源图标；无文字，按 title/aria/class 启发式定位） */
export async function clickExitTask(page) {
  const candidates = [
    () => page.locator('[title*="退出"], [aria-label*="退出"]').first(),
    () => page.locator('.anticon-power, [class*="power"], [class*="logout"]').first(),
    () => page.getByText('退出', { exact: true }).first(),
  ];
  for (const make of candidates) {
    const loc = make();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (!guard('点击任务页右上角「退出」')) return { clicked: false };
    await loc.click({ timeout: 8000 });
    log('已点击「退出」');
    return { clicked: true };
  }
  log('未找到「退出」按钮（可 npm run dump 后补充规则）');
  return { clicked: false };
}

/** 点击作业详情页左上角返回箭头；找不到时退化为浏览器历史后退 */
export async function clickBackArrow(page) {
  const candidates = [
    () =>
      page
        .locator('.anticon-arrow-left, [aria-label*="arrow-left"], [class*="arrow-left"]')
        .first(),
    () =>
      page.locator('[class*="page-header"] [class*="back"], a[class*="back"], [class*="back-arrow"]').first(),
  ];
  for (const make of candidates) {
    const loc = make();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (!guard('点击左上角返回箭头')) return { clicked: false };
    await loc.click({ timeout: 8000 });
    log('已点击左上角返回箭头');
    return { clicked: true };
  }
  if (!guard('浏览器后退（返回箭头未找到）')) return { clicked: false };
  await page.goBack({ timeout: 10000 }).catch(() => {});
  log('未找到返回箭头，已执行浏览器后退兜底');
  return { clicked: true, fallback: true };
}

/** 点击作业详情页的「继续挑战」进入关卡页（存在才点） */
export async function clickContinueChallenge(page) {
  for (const kw of ['继续挑战', '开始挑战']) {
    const loc = page.getByText(kw, { exact: true }).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (!guard(`点击「${kw}」进入关卡`)) return { clicked: false };
    await loc.click({ timeout: 8000 });
    log(`已点击「${kw}」进入关卡`);
    return { clicked: true };
  }
  return { clicked: false };
}

/**
 * 点击列表页第 index 个「开始学习」。
 * 定位用 collectCards 打下的 data-agent-target 标记（而非 nth 文本序号），
 * 避免页面里存在隐藏的同名文本节点时序号错位点到不可见元素上。
 * 卡片可能在 iframe 里，因此主 frame 找不到标记时逐 frame 查找。
 */
export async function clickStartLearning(page, index) {
  const sel = `[data-agent-target="${index}"]`;
  const targets = [
    page.locator(sel).first(),
    ...page.frames().map((f) => f.locator(sel).first()),
  ];
  for (const loc of targets) {
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (!guard(`点击「开始学习」#${index + 1}`)) return { clicked: false };
    try {
      await loc.click({ timeout: 10000 });
    } catch (e) {
      log(`「开始学习」点击失败：${String(e.message).slice(0, 120)}`);
      return { clicked: false };
    }
    log(`已点击「开始学习」#${index + 1}`);
    return { clicked: true };
  }
  log(`「开始学习」#${index + 1} 标记丢失（页面可能已重渲染），下一轮会重新采集`);
  return { clicked: false };
}

/**
 * 切换右侧工作区标签（「命令行」/「代码文件」），按题干意图分流后调用。
 * 结构依据 2026-09-09 真实页面 dump：标签项为 div[class*="item___"]（CSS modules
 * 哈希前缀稳定），内含 <span>命令行</span> / <span>代码文件</span>，激活态类含 active。
 * 已激活时不动页面，直接返回。
 * @param {import('playwright-core').Page} page
 * @param {string} tabText '命令行' | '代码文件'
 * @returns {Promise<{clicked: boolean, active: boolean, found: boolean}>}
 */
export async function switchTaskTab(page, tabText) {
  const sel = '[class*="item___"]';
  let target = page.locator(sel, { hasText: tabText }).first();
  if (!(await target.isVisible().catch(() => false))) {
    // 退化：非 CSS modules 结构的站点，退回精确文本节点本身
    target = page.getByText(tabText, { exact: true }).first();
  }
  if (!(await target.isVisible().catch(() => false))) {
    log(`未找到「${tabText}」标签（可能该平台无此结构）`);
    return { clicked: false, active: false, found: false };
  }

  // 激活态判定：目标项自身 class 含 active（激活项无需点击）
  const cls = (await target.getAttribute('class').catch(() => '')) ?? '';
  if (/active/i.test(cls)) {
    return { clicked: false, active: true, found: true };
  }
  // 激活类可能挂在子 span 上，再看一眼内部
  const innerActive = await target
    .locator('[class*="active"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (innerActive) {
    return { clicked: false, active: true, found: true };
  }

  if (!guard(`切换标签「${tabText}」`)) {
    return { clicked: false, active: false, found: true };
  }
  await target.click({ timeout: 8000 }).catch(() => {});
  log(`已切换到「${tabText}」标签`);
  return { clicked: true, active: true, found: true };
}

/**
 * 向 xterm 终端逐条键入命令（每条后回车）。
 * 写入方式遵循项目约束：真实键盘输入（type 逐字符触发 xterm 的 keydown 捕获），
 * 不改 DOM。命令间隔为**自适应**：回车后轮询终端最后非空行，提示符返回
 * （bash `#`/`$`、REPL `>`）即立即下一条——快命令 ~200ms 放行、慢命令等输出
 * 滚完；上限 gapMaxMs 兜底前台阻塞类命令。替代旧版固定 1200ms（32 条命令
 * 仅间隔就 ~38s，且对秒级快命令纯浪费、对慢命令又不够）。
 * @param {import('playwright-core').Page} page
 * @param {string[]} commands 按执行顺序的命令列表
 * @param {{typeDelay?: number, gapMin?: number, gapMax?: number}} opts
 * @returns {Promise<{executed: number, dryRun?: boolean, reason?: string,
 *   termErrors?: Array<{no: number, cmd: string, errs: string[]}>}>}
 *   termErrors：输入期报错（键入/执行即报错的命令与回现行），供反思材料使用
 */
export async function runTerminalCommands(page, commands, opts = {}) {
  const typeDelay = opts.typeDelay ?? cfg.terminal.typeDelayMs;
  const gapMin = opts.gapMin ?? cfg.terminal.gapMinMs;
  const gapMax = opts.gapMax ?? cfg.terminal.gapMaxMs;
  if (!guard(`终端键入 ${commands.length} 条命令`)) {
    return { executed: 0, dryRun: true };
  }
  // 逐 frame 找可见 xterm 终端（实测在主 frame，遍历以兼容 iframe 嵌入的站点）
  let target = null;
  for (const f of [page.mainFrame(), ...page.frames().filter((x) => x !== page.mainFrame())]) {
    const loc = f.locator('.xterm-screen').first();
    if (await loc.isVisible().catch(() => false)) {
      target = loc;
      break;
    }
  }
  if (!target) {
    log('未找到可见的 xterm 终端（.xterm-screen），无法键入命令');
    return { executed: 0, reason: 'terminal-not-found' };
  }

  await target.click({ timeout: 8000 }).catch(() => {}); // 聚焦终端
  // 输入期报错检测（2026-09-09 用户要求）：每条命令执行完做行级差分，
  // 新增回显行命中报错特征立即记录并打日志，随返回值交给反思材料
  const ERROR_PATTERN =
    /(command not found|not found|No such file|SyntaxError|Syntax error|Error:|error:|exception|Traceback|refused|timed? ?out|无法识别|错误|失败)/i;
  let prevCount = 0;
  const termErrors = [];
  for (let ci = 0; ci < commands.length; ci++) {
    const cmd = commands[ci];
    await page.keyboard.type(cmd, { delay: typeDelay });
    await page.keyboard.press('Enter');
    // 自适应等待：先给最短间隔让回显落定，再轮询提示符返回
    await page.waitForTimeout(gapMin);
    const deadline = Date.now() + gapMax;
    while (Date.now() < deadline) {
      if (await isTerminalAtPrompt(page)) break;
      await page.waitForTimeout(150);
    }
    // 行级差分：只检查本条命令新增的回显行
    const lines = await readTerminalLines(page);
    const newLines = lines
      .slice(prevCount)
      .map((s) => s.trimEnd())
      .filter(Boolean);
    prevCount = lines.length;
    const errs = newLines.filter((l) => ERROR_PATTERN.test(l));
    if (errs.length) {
      termErrors.push({ no: ci + 1, cmd, errs });
      log(`命令 ${ci + 1} 输入期报错（${errs.length} 行）：${errs[0].slice(0, 100)}`);
    }
  }
  log(
    `已向终端键入 ${commands.length} 条命令（自适应间隔 ${gapMin}~${gapMax}ms、键速 ${typeDelay}ms/字符${termErrors.length ? `，输入期报错 ${termErrors.length} 条` : ''}）`,
  );
  return { executed: commands.length, termErrors };
}

/**
 * 在浏览器上下文执行：采集已展开的「测试集N」区块，抽取预期/实际输出。
 * 策略：找同时含三要素（测试集N 标题 + 预期输出 + 实际输出）的元素，
 * 按文本长度升序取最小容器（嵌套包裹去重），按标签位置切分两栏文本。
 * 截断上限为字面量（evaluate 序列化约束）：单栏 1200 字符、最多 8 组。
 */
const COLLECT_TEST_SETS = () => {
  const NOISE_TAIL = ['本关最大执行时间', '显示/隐藏测试结果', '下一关'];
  const cut = (s) => {
    for (const kw of NOISE_TAIL) {
      const k = s.indexOf(kw);
      if (k >= 0) s = s.slice(0, k);
    }
    return s.trim();
  };
  const all = Array.from(document.querySelectorAll('div, section, li, td'))
    .filter((el) => {
      const t = el.innerText ?? '';
      return t.includes('预期输出') && t.includes('实际输出') && /测试集\s*\d+/.test(t);
    })
    .sort((a, b) => (a.innerText?.length ?? 0) - (b.innerText?.length ?? 0));
  const picked = [];
  for (const el of all) {
    // 升序遍历后，后到的元素要么是已选块的外层包裹、要么是并列块；包含即去重
    if (picked.some((p) => p._el.contains(el) || el.contains(p._el))) continue;
    const t = el.innerText ?? '';
    const title = (t.match(/测试集\s*\d+/) || [''])[0];
    const iE = t.indexOf('预期输出');
    const iA = t.indexOf('实际输出');
    if (iE < 0 || iA < 0 || iA === iE) continue;
    // 右栏「展示原始输出」是链接文本混在栏目头行，按 token 剔除而非截断；
    // 左右栏 DOM 顺序一般 预期在前，但按实际出现位置切分以兼容颠倒的渲染顺序
    let expected = '';
    let actual = '';
    if (iE < iA) {
      expected = cut(t.slice(iE + 4, iA)).slice(0, 1200);
      actual = cut(t.slice(iA + 4).replace(/展示原始输出/g, '')).slice(0, 1200);
    } else {
      actual = cut(t.slice(iA + 4, iE).replace(/展示原始输出/g, '')).slice(0, 1200);
      expected = cut(t.slice(iE + 4)).slice(0, 1200);
    }
    if (!expected && !actual) continue;
    // 只认带正文的区块：纯标签行迷你容器（只有栏目头+耗时行、无实际内容）
    // 会以"最小容器"胜出，喂给反思的只是百余字符的空壳（2026-09-09 实测）
    const bodyLen = (expected + actual).replace(/\s+/g, '').length;
    if (bodyLen < 20) continue;
    picked.push({ _el: el, title, expected, actual });
    if (picked.length >= 8) break;
  }
  return picked.map(({ title, expected, actual }) => ({ title, expected, actual }));
};

/**
 * 展开「测试集N」折叠块并抓取每组的 预期输出 / 实际输出 明细。
 *
 * 背景：首次评测大概率不匹配，而定位失败的关键证据（预期 vs 实际差异）
 * 收在默认折叠的「测试集N」块里——只靠 readEvalPanel 的面板摘要（甚至空文本）
 * 喂反思等于盲改。本函数把折叠块逐个展开后结构化抽取差异。
 *
 * 通用启发式（不硬编码站点 selector）：
 *   - 折叠头：文本匹配 /测试集\s*\d+/ 的叶子元素（EduCoder 系文风）；
 *   - 展开判定：向上爬 ≤10 层祖先，容器文本含 预期输出/实际输出 即已展开，
 *     跳过不点（避免把已展开的块点收起）；父级容器文本较长的不算叶子；
 *   - 结果可能在 iframe 内：与 readEvalPanel 一致逐 frame 扫描。
 *
 * @param {import('playwright-core').Page} page
 * @param {{maxSets?: number, perSetCap?: number, totalCap?: number}} opts
 * @returns {Promise<string>} 拼装好的差异明细文本；页面无该结构时返回 ''（零影响）
 */
export async function collectTestSetDetails(page, opts = {}) {
  const maxSets = opts.maxSets ?? 8;
  const perSetCap = opts.perSetCap ?? 1200;
  const totalCap = opts.totalCap ?? 8000;
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];

  // 1) 展开：只点「未展开」的折叠头（已展开的容器文本含 预期输出/实际输出）；
  //    force=true 无视展开判定全部点一遍（采集为空时用于纠正误判后重试）。
  //    dryRun 下跳过点击，仅采集已展开内容。
  const expandAll = async (force) => {
    let clicked = 0;
    for (const f of frames) {
      const headers = f.locator('text=/测试集\\s*\\d+/');
      const n = await headers.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 20); i++) {
        const h = headers.nth(i);
        if (!(await h.isVisible().catch(() => false))) continue;
        if (!force) {
          const info = await h
            .evaluate((el) => {
              const own = (el.textContent ?? '').trim();
              const leaf = own.length > 0 && own.length <= 24;
              let expanded = false;
              let p = el.parentElement;
              for (let d = 0; d < 10 && p; d++) {
                const t = p.innerText ?? '';
                if (t.includes('预期输出') || t.includes('实际输出')) {
                  expanded = true;
                  break;
                }
                p = p.parentElement;
              }
              return { leaf, expanded };
            })
            .catch(() => null);
          if (!info?.leaf || info.expanded) continue;
        }
        await h.click({ timeout: 3000 }).catch(() => {});
        clicked++;
        await page.waitForTimeout(400);
      }
    }
    return clicked;
  };

  const collectAll = async () => {
    const sets = [];
    for (const f of frames) {
      const part = await f.evaluate(COLLECT_TEST_SETS).catch(() => []);
      sets.push(...part);
      if (sets.length >= maxSets) break;
    }
    return sets;
  };

  let clicked = 0;
  if (guard('展开测试集折叠块')) clicked = await expandAll(false);
  if (clicked > 0) await page.waitForTimeout(600); // 等最后一批展开渲染落定

  let sets = await collectAll();
  // 采集为空（折叠态被误判为已展开等场景）：强制全点一遍再采一次自愈
  if (!sets.length && guard('强制展开全部折叠块')) {
    const clicked2 = await expandAll(true);
    if (clicked2 > 0) {
      await page.waitForTimeout(600);
      sets = await collectAll();
    }
  }
  if (!sets.length) return '';

  // 标签行切分后会残留「——」装饰破折号行，过滤纯符号行保持喂给反思的文本干净
  const dropDashLines = (s) =>
    s
      .split(/\r?\n/)
      .filter((l) => !/^[—\-–\s]*$/.test(l))
      .join('\n')
      .trim();
  const text = sets
    .slice(0, maxSets)
    .map(
      (s) =>
        `【${s.title || '测试集'}】\n预期输出：\n${dropDashLines(s.expected.slice(0, perSetCap))}\n实际输出：\n${dropDashLines(s.actual.slice(0, perSetCap))}`,
    )
    .join('\n\n');
  log(`已展开 ${clicked} 个折叠块，抓取 ${sets.length} 组预期/实际输出明细（${text.length} 字符）`);
  return text.slice(0, totalCap);
}

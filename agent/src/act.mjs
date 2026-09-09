// EXPORTS: clickEval, waitEvalResult, clickNext, answerChoice, fillBlank, settle,
//          readTaskNo, waitTaskAdvance, clickExitTask, clickBackArrow,
//          clickContinueChallenge, clickStartLearning, switchTaskTab, runTerminalCommands
// 执行层：所有真实点击 / 输入动作。受 DRY_RUN 控制——干跑时只打日志不动页面。

import { cfg } from './config.mjs';
import { readEvalPanel } from './perceive.mjs';

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
  const deadline = Date.now() + timeoutMs;
  let last = before;
  let stableCount = 0;
  let best = '';

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
 * 不改 DOM。执行间隙留出命令运行时间（数据库类命令可能较慢）。
 * @param {import('playwright-core').Page} page
 * @param {string[]} commands 按执行顺序的命令列表
 * @param {{gapMs?: number}} opts 每条命令后的等待，默认 1200ms
 * @returns {Promise<{executed: number, dryRun?: boolean, reason?: string}>}
 */
export async function runTerminalCommands(page, commands, opts = {}) {
  const gapMs = opts.gapMs ?? 1200;
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
  for (const cmd of commands) {
    await page.keyboard.type(cmd, { delay: 25 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(gapMs);
  }
  log(`已向终端键入 ${commands.length} 条命令（每条间隔 ${gapMs}ms）`);
  return { executed: commands.length };
}

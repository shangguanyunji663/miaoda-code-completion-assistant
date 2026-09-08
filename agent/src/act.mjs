// EXPORTS: clickEval, waitEvalResult, clickNext, answerChoice, fillBlank, settle
// 执行层：所有真实点击 / 输入动作。受 DRY_RUN 控制——干跑时只打日志不动页面。

import { cfg } from './config.mjs';
import { probePage } from './perceive.mjs';

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
 * 策略：轮询页面评测面板文本，直到与点击前不同、且连续 3 次采样保持不变。
 * @returns {Promise<string>} 评测结果文本
 */
export async function waitEvalResult(page, timeoutMs = cfg.loop.evalTimeoutMs) {
  const before = (await probePage(page).catch(() => ({ evalPanel: '' }))).evalPanel ?? '';
  const deadline = Date.now() + timeoutMs;
  let last = before;
  let stableCount = 0;
  let best = '';

  while (Date.now() < deadline) {
    await page.waitForTimeout(1200);
    const now = (await probePage(page).catch(() => ({ evalPanel: '' }))).evalPanel ?? '';
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

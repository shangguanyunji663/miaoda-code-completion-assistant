// EXPORTS: clickEval, clickByKeywords, waitEvalResult, clickNext, answerChoice, fillBlank, settle,
//          readTaskNo, waitTaskAdvance, clickExitTask, clickBackArrow,
//          clickContinueChallenge, clickStartLearning, switchTaskTab, runTerminalCommands,
//          collectTestSetDetails, dismissPassModal, ensureTaskPage,
//          STALE_EVAL_PREFIX, isStaleEvalText, parsePlatformMaxSeconds, evalDeadlineAt
// 执行层：所有真实点击 / 输入动作。受 DRY_RUN 控制——干跑时只打日志不动页面。

import { cfg } from './config.mjs';
import { createLogger } from './logger.mjs';
import { checkStop } from './control.mjs';
import { readEvalPanel, isTerminalAtPrompt, readTerminalLines } from './perceive.mjs';
import { isFailureEcho, absentPathsFromEcho, isDeadCommand } from './cmd-evidence.mjs';

// 按钮文本关键词（按优先级排序，模糊匹配）。
// 不同平台用词不同，这里给一份较全的兜底列表，实际按站点精调时改这里即可。
export const BTN_EVAL = ['评测', '评 测', '提交评测', '提交', '运行', '运行评测', '判题', '测评'];
export const BTN_NEXT = ['下一题', '下一关', '下一个', '下一节', '继续', '下一页', '下一任务'];

const log = createLogger('act');

/** 干跑守卫：dryRun 时记录并返回 false，不执行真实动作 */
function guard(action) {
  if (cfg.loop.dryRun) {
    log(`DRY_RUN 跳过：${action}`);
    return false;
  }
  return true;
}

/** 陈旧面板返回值的固定首行：loop 据此把判定强制为"未通过"，绝不把上一轮
 *  遗留面板当成本轮结果（见 waitEvalResult 的 1.5.0 说明）。 */
export const STALE_EVAL_PREFIX = '=== 本轮评测结果未确认 ===';

/** 评测文本是否为"未观测到本轮结果"的陈旧返回 */
export function isStaleEvalText(text) {
  return String(text ?? '').startsWith(STALE_EVAL_PREFIX);
}

/** 从结果面板文本解析平台自报的「本关最大执行时间：N 秒」，解析不到返回 0。
 *  平台这一栏就是本轮评测可能的最长耗时：本地预算若小于它，等待会在评测
 *  中途放弃（2026-09-22 事故根因之一：Redis 阻塞类题 120 秒 vs 本地 30 秒）。 */
export function parsePlatformMaxSeconds(text) {
  const m = /本关最大执行时间[^\d]{0,10}(\d+)\s*秒/.exec(String(text ?? ''));
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * 计算评测等待的截止时间戳（毫秒）。取「配置预算」与「平台自报上限 + 收尾余量」
 * 的较大者，并用 cap 兜住（面板文本可能自报离谱数值）。
 * @returns {{deadlineAt: number, extended: boolean}}
 */
export function evalDeadlineAt(startAt, baseTimeoutMs, panelText, capMs, graceMs) {
  const sec = parsePlatformMaxSeconds(panelText);
  if (!sec) return { deadlineAt: startAt + baseTimeoutMs, extended: false };
  const want = Math.min(capMs, sec * 1000 + graceMs);
  if (want <= baseTimeoutMs) return { deadlineAt: startAt + baseTimeoutMs, extended: false };
  return { deadlineAt: startAt + want, extended: want > baseTimeoutMs };
}

/**
 * 收起评测结果面板（1.1.0，通用遮挡处理）。
 * 展开的评测结果容器（evaluate-result-container 等）会拦截评测/翻页按钮的点击
 * （Playwright 报 "intercepts pointer events"）。按优先级尝试：① 点击容器内的
 * 标题行（含「测试结果/测试集/评测结果」字样，多数平台点击标题可收起/展开切换）；
 * ② 点击容器左上角（避开内容区）；③ Escape 兜底。零副作用：面板不存在时直接返回。
 * @returns {Promise<boolean>} 是否尝试了收起动作
 */
async function dismissResultPanel(page) {
  const selectors = [
    '.evaluate-result-container',
    '[class*="evaluate-result"]',
    '[class*="result-panel"]',
    '[class*="test-result"]',
  ];
  for (const sel of selectors) {
    const panel = page.locator(sel).first();
    if (!(await panel.isVisible().catch(() => false))) continue;
    const header = panel.locator('text=/测试结果|测试集|评测结果|运行结果/').first();
    if (await header.isVisible().catch(() => false)) {
      await header.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }
    await panel.click({ position: { x: 20, y: 20 }, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    return true;
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  return false;
}

/** 按关键词列表点击第一个可见按钮 */
export async function clickByKeywords(page, keywords, label, opts = {}) {
  // 重扫窗口（毫秒）：短暂遮挡/渲染竞态时自愈；0 表示只试一轮（旧行为）
  const settleMs = opts.settleMs ?? 6000;
  const stepMs = opts.settleStepMs ?? 2000;
  // 「一轮扫下来什么都没见到」的容忍窗口：超过它就认定页面本来没有这个按钮，
  // 不再拖满 settleMs（点不动 ≠ 不存在，两者的处置与耗时完全不同）
  const absentGraceMs = opts.absentGraceMs ?? Math.min(settleMs, 6000);
  const start = Date.now();
  const deadline = start + settleMs;
  let sawAny = false;
  for (let round = 1; ; round++) {
    checkStop(`点击「${label}」`);
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
          sawAny = true;
          if (!guard(`点击「${label}」（匹配词：${kw}）`)) return { clicked: false, keyword: kw };
          let clicked = false;
          try {
            await el.click({ timeout: 8000 });
            clicked = true;
          } catch {
            // 被评测结果面板遮挡：收起面板后重试一次（1.1.0 通用处理）
            log(`点击「${label}」被拦截（疑似被评测结果面板遮挡），收起后重试`);
            await dismissResultPanel(page);
            clicked = await el
              .click({ timeout: 8000 })
              .then(() => true)
              .catch(() => false);
          }
          if (!clicked) continue; // 重试仍失败，换下一个候选
          log(`已点击「${label}」（匹配词：${kw}）`);
          return { clicked: true, keyword: kw, exists: true };
        }
      }
    }
    // 整轮都没点中：等一会儿再重扫（1.4.1 加，2026-09-20 真机事故）
    // 现象：连续三次「点击被拦截」后即放弃 → loop 判「未找到评测按钮」终止整题；
    // 但实测该按钮**存在且可见**（`评测 @1608,941 visible=true`），页面上也没有真实遮罩
    //（唯一命中项是 Monaco 内部的 margin-view-overlays），属渲染/收起面板的瞬时态。
    // 给一个有界重扫窗口，比误判"没有评测按钮"而整题作废划算。
    if (Date.now() >= deadline) break;
    if (!sawAny && Date.now() - start >= absentGraceMs) break;
    await dismissResultPanel(page);
    log(`「${label}」本轮未点中（第 ${round} 轮），${Math.round(stepMs / 1000)}s 后重扫`);
    await page.waitForTimeout(stepMs);
  }
  // 区分两种失败：按钮根本不存在 vs 存在但一直点不动——排查方向完全不同
  log(
    sawAny
      ? `「${label}」按钮存在但始终未点中（疑似平台仍在评测中/被遮挡），放弃本次点击`
      : `未找到「${label}」按钮（尝试词：${keywords.join('/')}）`,
  );
  return { clicked: false, keyword: null, exists: sawAny };
}

/**
 * 写入代码后的静置：点击编辑器外部触发平台自动保存，再等待若干秒。
 * 依据：README 第 65 行明确提示「先点击编辑器外部或稍等 2-3 秒让平台自动保存完成，
 * 再点评测，否则可能评测到旧代码」。
 */
export async function settle(page) {
  if (!guard('写入后静置')) return;
  checkStop('写入后静置');
  await page.mouse.click(5, 5).catch(() => {});
  await page.waitForTimeout(cfg.loop.cooldownMs);
}

/** 点击「评测」按钮。
 * 重扫窗口默认给到「平台自报最大执行时间 + 余量」量级（1.5.0）：上一轮评测仍在
 * 进行时平台会让评测按钮不可点，旧版 20s 窗口到点就放弃 → loop 判「未找到评测
 * 按钮」终止整题，刚写入的代码连一次评测都没拿到（2026-09-22 真机事故）。
 * 按钮压根不存在时按 absentGraceMs 快速失败，不拖满窗口。 */
export async function clickEval(page) {
  return clickByKeywords(page, BTN_EVAL, '评测', {
    settleMs: cfg.loop.evalClickMs,
    settleStepMs: cfg.loop.evalClickStepMs,
    absentGraceMs: Math.min(cfg.loop.evalClickMs, 8000),
  });
}

/** 点击「下一题」按钮 */
export async function clickNext(page) {
  return clickByKeywords(page, BTN_NEXT, '下一题', { settleMs: 4000, settleStepMs: 2000 });
}

/**
 * 等待评测结果出现并稳定。
 * 策略：用轻量探针（readEvalPanel，含 iframe 扫描）轮询结果面板文本，
 * 直到与点击前不同、且连续 3 次采样保持不变。
 * 相比旧版逐轮跑全页探测（probePage，每轮多次 evaluate、秒级延迟），
 * 现在每轮只做一次 evaluate，通过类结果可秒级判定（弹窗/成功词即时返回）。
 *
 * 1.5.0 两条硬约束（2026-09-22 真机事故：Redis 优先级队列题）：
 *  ① **预算必须覆盖平台自报的本关最大执行时间**——旧版固定 30s，而该题评测要跑
 *    120s，等待在评测中途就放弃；
 *  ② **本轮代码与上一轮不同时，绝不采信"与点击前一致"的面板文本**——那份文本是
 *    上一轮（甚至用户手动提交）的遗留，把它当本轮结果会让反思基于假证据编造
 *    机制（实测反思据此写下"队列名被 blpop 从有序集合中隐式删除"这种不存在的
 *    原理）。此时等满预算，返回值加 STALE_EVAL_PREFIX 首行，由 loop 判为未通过
 *    并把"未观测到结果"如实写进反思材料。
 * @param {string} [timeoutMs] 本地等待预算下限
 * @param {{codeUnchanged?: boolean}} [opts] codeUnchanged=true 表示本次提交的
 *   文本与上一次评测的完全相同（同错复现允许走捷径）
 * @returns {Promise<string>} 评测结果文本
 */
export async function waitEvalResult(page, timeoutMs = cfg.loop.evalTimeoutMs, opts = {}) {
  const codeUnchanged = opts.codeUnchanged === true;
  const before = await readEvalPanel(page);
  const start = Date.now();
  let { deadlineAt: deadline } = evalDeadlineAt(
    start,
    timeoutMs,
    before,
    cfg.loop.evalBudgetCapMs,
    cfg.loop.evalGraceMs,
  );
  if (deadline > start + timeoutMs) {
    log(
      `面板自报本关最大执行时间 ${parsePlatformMaxSeconds(before)}s，` +
        `评测等待预算 ${Math.round(timeoutMs / 1000)}s → ${Math.round((deadline - start) / 1000)}s`,
    );
  }
  let last = before;
  let lastSample = '';
  let stableCount = 0;
  let best = '';
  // 与 readEvalPanel 的结果标记策略配套：判定捕获文本是否带结果面板特征
  const hasResultMarker = (t) => /共有\s*\d+\s*组测试集|本关最大执行时间|测试结果/.test(t ?? '');
  const hasSuccessWord = (t) => /通过|成功|accepted|恭喜/i.test(t ?? '');
  // 面板出现确定性成功词且无任何失败词 → 立即采用，不等稳定采样（省 1.5~2.5s）。
  // 不用裸「通过」：EduCoder 系逐测试集写「测试集N 通过」，中途采样会误判。
  const isDefiniteSuccess = (t) =>
    !!t &&
    /(全部通过|评测通过|测试通过|答案正确|accepted|恭喜|0\s*组不匹配)/i.test(t) &&
    !/(不匹配|未通过|没有通过|失败|错误|异常|wrong\s*answer|time\s*limit|runtime\s*error|compile\s*error)/i.test(
      t,
    );

  while (Date.now() < deadline) {
    // 手动停止检查点：评测等待最长 25s，是单步里最长的静默期，
    // 用户点停止后应当在这里就断，而不是等满超时再走下一步
    checkStop('等待评测结果');
    await page.waitForTimeout(400); // 2026-09-10：800→400ms，判定延迟减半
    // 「恭喜您通过本关」弹窗是平台权威通过宣告：出现即判过并立即返回。
    // （2026-09-10 真机实测：弹窗带入场动画、可能早于面板文本稳定出现，
    // 旧版只在稳定后查一次导致"弹窗已庆祝、判定却是未通过"）
    if (await isPassModalVisible(page)) {
      log('检测到「恭喜您通过本关」弹窗，立即判为通过');
      return `${best}\n恭喜您通过本关`;
    }
    // 结构化通过标记（class=test-result.success）：比文本匹配更硬的证据
    if (await hasStructPassMark(page)) {
      log('检测到结构化通过标记（test-result.success），立即判为通过');
      return '全部通过（结构标记 test-result.success）';
    }
    const now = await readEvalPanel(page);
    lastSample = now || lastSample;
    // 评测中途才出现的面板也可能自报更长的执行时间：预算随之延长
    if (now) {
      const d2 = evalDeadlineAt(
        start,
        timeoutMs,
        now,
        cfg.loop.evalBudgetCapMs,
        cfg.loop.evalGraceMs,
      );
      if (d2.deadlineAt > deadline) {
        deadline = d2.deadlineAt;
        log(`评测等待预算延长至 ${Math.round((deadline - start) / 1000)}s（面板自报执行时间）`);
      }
    }
    if (now && now !== before) {
      best = now;
      if (isDefiniteSuccess(now)) {
        log('面板文本命中确定性成功词，立即判为通过（不等稳定采样）');
        return now;
      }
      if (now === last) {
        stableCount++;
        if (stableCount >= 3) {
          break;
        }
      } else {
        stableCount = 1;
      }
      last = now;
    } else if (
      now &&
      hasResultMarker(now) &&
      codeUnchanged &&
      Date.now() - start >= cfg.loop.evalUnchangedMinMs
    ) {
      // 同错复现场景（2026-09-09 实测 60s 空等）：重交**同一份代码**，新结果与
      // 点击前面板完全一致，"等变化"永远等不到。文本带结果面板标记、且已过最短
      // 等待（1.5.0：3s→可配 10s，4 秒时平台多半还没跑完）且连续 3 次采样稳定，
      // 才直接采用——代码变了就不允许走这条路（见函数头注 ②）。
      stableCount++;
      if (stableCount >= 3) {
        best = now;
        log('代码与上一轮相同且结果面板文本一致（同错复现），连续 3 次稳定后直接采用');
        break;
      }
    }
  }

  // 兜底信号（2026-09-09 新增，2026-09-10 加强）：文本无成功词时不再只查一次
  // 弹窗，而是继续等至多 4s——弹窗可能晚于面板稳定才弹出（本次事故根因）。
  // 面板全程未捕获（best 为空）也要查：弹窗在场的判定价值高于"空结果"。
  if (!hasSuccessWord(best)) {
    const modalDeadline = Date.now() + 4000;
    while (Date.now() < modalDeadline) {
      if (await isPassModalVisible(page)) {
        best = `${best}\n恭喜您通过本关`;
        log('捕获文本无成功词，但检测到「恭喜您通过本关」弹窗，判为通过');
        break;
      }
      if (await hasStructPassMark(page)) {
        best = `${best}\n全部通过（结构标记 test-result.success）`;
        log('捕获文本无成功词，但检测到结构化通过标记，判为通过');
        break;
      }
      await page.waitForTimeout(300);
    }
  }

  const spentSec = Math.round((Date.now() - start) / 1000);
  if (!best) {
    // 全程未观测到面板变化：本轮结果不可知。带标记返回遗留文本（或空串），
    // 由 loop 判未通过并如实告诉反思"没有本轮证据"——宁可多跑一轮，也不能
    // 拿上一轮的报错去"修"这一版的代码（2026-09-22 事故：反思据陈旧面板编出
    // 不存在的机制，改出的代码在 Python 2 下连语法都不过）
    if (!codeUnchanged && lastSample && hasResultMarker(lastSample)) {
      log(
        `${spentSec}s 内结果面板与点击前完全一致：本轮评测结果未观测到，` +
          '不把遗留面板当本轮结论（陈旧面板已如实标注给反思）',
      );
      return (
        `${STALE_EVAL_PREFIX}\n` +
        `本轮提交与上一轮不同，但等待 ${spentSec}s 期间结果面板文本未发生任何变化——` +
        '本轮评测结果**未被观测到**（可能仍在评测中）。以下文本是点击评测之前就已存在的遗留内容，' +
        '只能作为"平台此前对该题的反馈"参考，**严禁**据此推断本轮的失败原因；' +
        '没有可引用的本轮报错原文时，请输出与上一版完全相同的代码，不要凭推测改动。\n\n' +
        `--- 遗留面板内容（非本轮结果）---\n${lastSample}`
      );
    }
    log(
      `${spentSec}s 内未捕获到评测结果文本（提交本身可能已成功）。` +
        '请在题目页保持该状态立即执行 npm run dump，把 dumps JSON 发给开发侧按真实结构精调结果面板识别',
    );
  }
  return best;
}

/** 「恭喜您通过本关」庆祝弹窗是否在场（平台权威通过宣告）。
 * 真机 DOM 实锤（2026-09-10 DevTools）：横幅文字是烘焙在 PNG 里的图片
 * （<div class="evaluate-result-body"><img src="data:image/png;base64,..." alt="通关">），
 * 文本节点不存在，getByText 原理上不可能命中——唯一可编程痕迹是 alt="通关"。
 * 故按 img[alt*=通关] 检测，文本匹配仅作其他平台变体的兜底。逐 frame 扫描。 */
async function isPassModalVisible(page) {
  for (const f of [page.mainFrame(), ...page.frames().filter((x) => x !== page.mainFrame())]) {
    const img = await f
      .locator('img[alt*="通关"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (img) return true;
    const text = await f
      .getByText('恭喜您通过', { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (text) return true;
  }
  return false;
}

/** 结构化通过标记：p.test-result.success（2026-09-10 真机 DOM 实锤：
 * right-panel 结果行 <p class="test-result success"><span class="count">全部通过</span>）。
 * class 直接编码通过状态，优先级高于一切文本启发式。逐 frame 扫描。 */
async function hasStructPassMark(page) {
  for (const f of [page.mainFrame(), ...page.frames().filter((x) => x !== page.mainFrame())]) {
    const hit = await f
      .locator('p.test-result.success')
      .first()
      .isVisible()
      .catch(() => false);
    if (hit) return true;
  }
  return false;
}

/**
 * 作答单选题：按选项文本匹配并点击。
 * 同时兼容两种 DOM：Ant Design 下文本挂在 `a` 上，朴素结构下挂在 `label` 上。
 */
export async function answerChoice(page, optionText) {
  const norm = (s) =>
    String(s)
      .replace(/\s+/g, '')
      .replace(/^[A-Za-z][.、:：]\s*/, '');
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
      page
        .locator('[class*="page-header"] [class*="back"], a[class*="back"], [class*="back-arrow"]')
        .first(),
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
  const targets = [page.locator(sel).first(), ...page.frames().map((f) => f.locator(sel).first())];
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

/** 在所有 frame 中找可见 xterm 终端；返回 { loc, frame } 或 null */
async function findVisibleTerminal(page) {
  for (const f of [page.mainFrame(), ...page.frames().filter((x) => x !== page.mainFrame())]) {
    const loc = f.locator('.xterm-screen').first();
    if (await loc.isVisible().catch(() => false)) {
      return { loc, frame: f };
    }
  }
  return null;
}

// 合成 paste 事件：对 xterm 隐藏 textarea（.xterm-helper-textarea）派发
// 带 clipboardData 的 paste——直达 xterm 粘贴管线，中文/Unicode 完整上屏。
// （2026-09-09 CDP 真机实测：keyboard.type 会把 CJK 丢成空串——name:""
// 事故根源；insertText 被 xterm 忽略；剪贴板 API/execCommand 在无用户
// 手势下写不进。合成 paste：中文+英文完整上屏。）
const XTERM_PASTE = (text) => {
  const ta = document.querySelector('.xterm-helper-textarea');
  if (!ta) return false;
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  ta.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
  );
  return true;
};

/**
 * 求「本次终端快照相对上次快照**新增**的行」（零依赖纯函数，2026-09-23 C-19）。
 * 为什么不能拿行数当游标：xterm 的可见行是 `.xterm-rows` 里的**滑动窗口**——屏幕滚满后
 * 行数不再增长，`lines.slice(prevCount)` 恒为空；而**首次调用** `prevCount = 0` 时它等于
 * 整屏历史。两个方向都错：前者让第 2 条起的命令**从来没被检出过任何报错**，后者让上一轮
 * 遗留在屏幕上的报错**冒充"命令 1 的报错"**。真机账单：全部日志 18 次「输入期报错」
 * 无一例外归到"命令 1"（跨 mongo / redis / 服务启动 / python 多种错误），就是这条。
 * 判据：终端内容只在尾部追加，滚动只是把窗口右移 ⇒ 上一次快照的**末 k 行**必然等于
 * 本次快照的**开 k 行**（k 为重叠长度）；取最大的 k，其后即为新增行。
 * 找不到任何重叠（整屏被一条命令刷掉，或终端被 clear）时保守返回本次全部行——
 * 那种情况下可见内容确实主要由这条命令产生。
 * @param {string[]} prev 上一次快照（两侧必须用同一种归一化）
 * @param {string[]} now 本次快照
 * @returns {string[]} 新增的行
 */
function overlapLen(p, n) {
  for (let k = Math.min(p.length, n.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (p[p.length - k + i] !== n[i]) {
        same = false;
        break;
      }
    }
    if (same) return k;
  }
  return 0;
}

export function newTerminalLines(prev, now) {
  const p = prev ?? [];
  const n = now ?? [];
  if (!p.length) return n.slice();
  // 两种对法，取重叠更长的那个（重叠越长 ⇒ 判为"新增"的行越少 ⇒ 越保守，不会误报）：
  // ① 连末行一起对——末行没被改写时（未滚动、或上一条命令的输出尚未落到提示符行）；
  // ② 去掉 prev 的末行再对——**末行是光标行**，下一条命令的键入会就地改写它
  //   （`root@a:~# ` → `root@a:~# ls`），此时它不再是平移关系，必须排除。
  const k = Math.max(overlapLen(p, n), overlapLen(p.slice(0, -1), n));
  return k > 0 ? n.slice(k) : n.slice();
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
 * @param {{typeDelay?: number, gapMin?: number, gapMax?: number, silent?: boolean}} opts
 * @returns {Promise<{executed: number, dryRun?: boolean, reason?: string,
 *   termErrors?: Array<{no: number, cmd: string, errs: string[]}>,
 *   skipped?: Array<{no: number, cmd: string, hit: string}>}>}
 *   termErrors：输入期报错（键入/执行即报错的命令与回现行），供反思材料使用；
 *   skipped：被判定"必败"而**没有键入**的命令（操作数已由序列中前一条命令实测为不存在），
 *   同样进反思材料。`silent`（只读取证）不参与跳过——对不存在的目录敲 find 拿报错
 *   正是取证要的东西（见函数内注释）。
 */
export async function runTerminalCommands(page, commands, opts = {}) {
  const typeDelay = opts.typeDelay ?? cfg.terminal.typeDelayMs;
  const gapMin = opts.gapMin ?? cfg.terminal.gapMinMs;
  const gapMax = opts.gapMax ?? cfg.terminal.gapMaxMs;
  if (!guard(`终端键入 ${commands.length} 条命令`)) {
    return { executed: 0, dryRun: true };
  }
  // 逐 frame 找可见 xterm 终端（实测在主 frame，遍历以兼容 iframe 嵌入的站点）
  const term = await findVisibleTerminal(page);
  if (!term) {
    log('未找到可见的 xterm 终端（.xterm-screen），无法键入命令');
    return { executed: 0, reason: 'terminal-not-found' };
  }
  const target = term.loc;
  const targetFrame = term.frame;

  await target.click({ timeout: 8000 }).catch(() => {}); // 聚焦终端
  // 输入期检测（2026-09-09 用户要求；1.6.20 起判据移入 cmd-evidence.mjs）：
  // 每条命令执行完做行级差分，新增回显行命中失败特征即记录并交反思材料。
  // 移出去的原因是判据不再只有一条"错误措辞"正则——还得认"**退出码 0 但工具自述没干活**"
  // 那一档（`don't know what to do with subdirectory …, skipping...` + `done`），
  // 真机里这条最强线索因为不带 error 字样而从未进过反思材料，模型连猜三轮空目录。
  // 输入期报错检测的游标：**不能拿行数当游标**（见 newTerminalLines 的说明）。
  // 改为持有上一次的整份可见行快照，逐条按内容求差；基线必须在键入**之前**取——
  // 否则第 1 条命令的窗口会包含整屏历史（2026-09-23 C-19）。
  let prevLines = (await readTerminalLines(page)).map((s) => s.trimEnd());
  const termErrors = [];
  // 「必败命令」跳过（1.6.24，用户点名的白费功夫）：序列里前面的命令已经把某个路径实测
  // 成"不存在"，后面引用同一路径的命令就必然同样失败——照敲只是白等 200~2500ms 的自适应
  // 间隔、白刷一屏回显，还让"这一轮到底改了什么"变得更难判。真机 2026-09-25：第 1 条
  // `find /opt` 就摊出 /opt 是空的，后面 9 条 mongorestore 仍照敲，12/17 条报错。
  // 只读取证（silent）不参与跳过：对不存在的目录敲 find、拿回报错，本身就是取证目的。
  const absent = [];
  const skipped = [];
  for (let ci = 0; ci < commands.length; ci++) {
    // 检查点放在命令边界：不在键入中途断，避免终端留下半条命令
    checkStop(`终端键入第 ${ci + 1}/${commands.length} 条`);
    const cmd = commands[ci];
    if (!opts.silent) {
      const d = isDeadCommand(cmd, absent, commands.slice(ci));
      if (d.dead) {
        skipped.push({ no: ci + 1, cmd, hit: d.hit });
        log(`命令 ${ci + 1} 跳过（操作数 ${d.hit} 已实测不存在，敲了必败）：${cmd.slice(0, 90)}`);
        continue;
      }
    }
    // 非 ASCII 行（中文文件名/数据值等）走合成 paste；纯 ASCII 仍走键盘
    // 逐字符（快且稳）。合成 paste 失败回退 keyboard.type 并告警（该路径
    // 中文会丢字，输入期报错检测会捕获后续异常）
    if (/[^\x00-\x7F]/.test(cmd)) {
      const pasted = await targetFrame.evaluate(XTERM_PASTE, cmd).catch(() => false);
      if (!pasted) {
        log(`命令 ${ci + 1} 合成粘贴失败，回退 keyboard.type（中文可能丢字）`);
        await page.keyboard.type(cmd, { delay: typeDelay });
      }
    } else {
      await page.keyboard.type(cmd, { delay: typeDelay });
    }
    await page.keyboard.press('Enter');
    // 自适应等待：先给最短间隔让回显落定，再轮询提示符返回
    await page.waitForTimeout(gapMin);
    const deadline = Date.now() + gapMax;
    while (Date.now() < deadline) {
      if (await isTerminalAtPrompt(page)) break;
      await page.waitForTimeout(150);
    }
    // 行级差分：只检查本条命令**新增**的回显行
    const nowLines = (await readTerminalLines(page)).map((s) => s.trimEnd());
    const newLines = newTerminalLines(prevLines, nowLines).filter((s) => s.trim());
    prevLines = nowLines;
    for (const p of absentPathsFromEcho(cmd, newLines)) {
      if (!absent.includes(p)) absent.push(p);
    }
    const errs = newLines.filter((l) => isFailureEcho(l));
    if (errs.length) {
      termErrors.push({ no: ci + 1, cmd, errs });
      // 只读取证一类调用方（loop 的 probeMissingPaths）刻意不刷日志：它的 `find`
      // 命中不存在的目录时必然回显 No such file or directory，那是**证据**不是故障
      if (!opts.silent) {
        // 窗口行数一并打出来：它是"归因是否可信"的判据（窗口 ≫ 该条命令的输出量 = 可疑）
        log(
          `命令 ${ci + 1} 输入期异常（${errs.length} 行，本条窗口 ${newLines.length} 行）：${errs[0].slice(0, 100)}`,
        );
      }
    }
  }
  const typed = commands.length - skipped.length;
  log(
    opts.silent
      ? `已向终端键入 ${typed} 条只读取证命令`
      : `已向终端键入 ${typed} 条命令（自适应间隔 ${gapMin}~${gapMax}ms、键速 ${typeDelay}ms/字符${termErrors.length ? `，输入期异常 ${termErrors.length} 条` : ''}${skipped.length ? `，跳过必败 ${skipped.length} 条` : ''}）`,
  );
  return { executed: typed, skipped, termErrors };
}

/**
 * 实测本机可用的命令行客户端（MongoDB/MySQL/Redis 等）。
 * 背景（2026-09-10 真机日志）：本机只有 mongo 没有 mongosh，AI 反复输出
 * mongosh 吃 command not found；反思每轮独立无记忆，模型在 mongo/mongosh
 * 之间来回摇摆。这里在 bash 提示符下实测一轮客户端清单，把硬事实写进
 * prompt——探测是确定性的，不依赖模型记住上一轮。
 * 仅在 bash 提示符下调用（REPL 内探测无意义）；探测命令只在终端留几行
 * 回显，无副作用。识别用 HAVE:/MISS: 前缀行，与普通输出无歧义。
 * @param {string[]} clients 待探测的客户端命令名
 * @returns {Promise<{have: string[], miss: string[], fact: string}>}
 *   fact 为注入 prompt 的中文结论（空串表示探测失败/无结论）
 */
export async function probeTerminalClients(
  page,
  clients = ['mongosh', 'mongo', 'mysql', 'redis-cli', 'psql'],
) {
  const term = await findVisibleTerminal(page);
  if (!term) return { have: [], miss: [], fact: '' };
  const probeCmd = `for c in ${clients.join(' ')}; do command -v $c >/dev/null 2>&1 && echo "HAVE:$c" || echo "MISS:$c"; done`;
  await term.loc.click({ timeout: 5000 }).catch(() => {}); // 聚焦终端
  const pasted = await term.frame.evaluate(XTERM_PASTE, probeCmd).catch(() => false);
  if (pasted) {
    await page.keyboard.press('Enter').catch(() => {});
  } else {
    await page.keyboard.type(probeCmd, { delay: 5 }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
  // 该探测命令瞬时完成。轮询读取回显，直到捕获 HAVE/MISS 行或超时（上限 5s）。
  // 不能用 isTerminalAtPrompt 做完成信号：探测命令刚粘贴时若 DOM 渲染未落定，
  // 最后一行仍是旧提示符 `root@…:#`，isTerminalAtPrompt 会立即误判 break，
  // 读取发生在回显之前——真机表现即「终端明明有 HAVE/MISS 回显却报未捕获」
  // （2026-09-10 截图实锤）。
  const deadline = Date.now() + 5000;
  let have = [];
  let miss = [];
  while (Date.now() < deadline) {
    const got = [];
    for (const l of await readTerminalLines(page)) {
      const m = l.trim().match(/^(HAVE|MISS):(\S+)$/);
      if (m) got.push(m);
    }
    if (got.length) {
      for (const m of got) {
        const bucket = m[1] === 'HAVE' ? have : miss;
        if (!bucket.includes(m[2])) bucket.push(m[2]);
      }
      break;
    }
    await page.waitForTimeout(150);
  }
  const fact = have.length
    ? `【客户端实测】本机可用的命令行客户端：${have.join('、')}${miss.length ? `；实测不存在的命令（严禁输出）：${miss.join('、')}` : ''}。操作某数据库必须用上述可用的客户端进入其 shell。`
    : miss.length
      ? `【客户端实测】以下命令本机全部不存在：${miss.join('、')}。数据库客户端可能未安装或未在 PATH 中，不要盲目输出它们；先依据任务说明检查安装/启动。`
      : '';
  return { have, miss, fact };
}

/**
 * 重置实验环境（2026-09-23，用户指路 + 只读 DOM 探针确认结构）。
 * 入口：命令行标签栏右侧的**工具栏按钮**（`a[title="工具栏"]`，图标 `icon-gongjuxiang`，
 * 用户口中的"公文包"）→ 弹出「功能」菜单 → 点「重置环境」→ 确认。
 * **为什么必须有它**：平台会自动重置**实验环境**（文件系统 + 数据库 + 终端会话），
 * 而"刷新题目页"只重载前端、**不恢复环境**——真机事故里 agent 把平台提供的
 * `/home/example/person.json` 覆盖成自编数据、库也空了，靠刷新页面永远救不回来。
 * 说明：重置会清掉容器内的数据与终端会话（已导入的数据会丢失），只在"环境确实坏了"时调用。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function resetTaskEnv(page) {
  if (!guard('重置实验环境')) return { ok: false, reason: 'dry-run' };
  // ① 打开「功能」菜单（title 锚定，不用带 hash 的 CSS module 类名）
  const trigger = page.locator('[title="工具栏"]').first();
  if (!(await trigger.count().catch(() => 0))) return { ok: false, reason: 'no-toolbar-button' };
  await trigger.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(600);
  // ② 菜单项「重置环境」（文本锚定）
  const item = page.getByText('重置环境', { exact: true }).first();
  if (!(await item.isVisible().catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'no-reset-menu-item' };
  }
  await item.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(600);
  // ③ 确认弹窗（Ant Design Modal：确定 / 确认 / 重置）：有就点，没有就继续
  for (const name of ['确定', '确认', '重置']) {
    const btn = page.getByRole('button', { name, exact: true }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      break;
    }
  }
  log('已触发「重置环境」——容器文件系统与数据库恢复初始状态（终端会话会重建）');
  return { ok: true };
}

/**
 * 通过后关闭「恭喜您通过本关」庆祝弹窗（2026-09-09 用户新增需求）。
 * 弹窗不关会一直遮挡编辑器与结果面板；关闭后 watch/lite 自然回到等待态
 * （watch 等切换下一题、lite 等刷新），导航权保留给用户——本函数只关
 * 弹窗，绝不触发任何导航。
 * 关闭顺序：「完成」按钮（平台标准收尾动作）→ ⊗ 关闭叉（class 含
 * close/Close 的可见元素）→ Escape 兜底；每步失败静默，不影响主流程。
 * 页面无弹窗时直接返回，零副作用。
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{dismissed: boolean, way?: string, reason?: string}>}
 */
export async function dismissPassModal(page) {
  const marker = page.getByText('恭喜您通过', { exact: false }).first();
  if (!(await marker.isVisible().catch(() => false))) {
    return { dismissed: false, reason: 'no-modal' };
  }
  // ① 「完成」按钮：平台标准收尾动作（按钮角色优先，退化为精确文本）
  const doneCandidates = [
    page.getByRole('button', { name: '完成', exact: true }),
    page.getByText('完成', { exact: true }),
  ];
  for (const c of doneCandidates) {
    if (
      await c
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      if (!guard('点击「完成」关闭通过弹窗')) return { dismissed: false, reason: 'dry-run' };
      await c
        .first()
        .click({ timeout: 3000 })
        .catch(() => {});
      log('已点击「完成」关闭通过弹窗，返回等待态');
      return { dismissed: true, way: 'done-button' };
    }
  }
  // ② 关闭叉：class 含 close/Close 的可见元素（⊗ 图标容器）
  const x = page.locator('[class*="close"], [class*="Close"]').first();
  if (await x.isVisible().catch(() => false)) {
    if (!guard('点击关闭叉关闭通过弹窗')) return { dismissed: false, reason: 'dry-run' };
    await x.click({ timeout: 3000 }).catch(() => {});
    log('已点击关闭叉关闭通过弹窗，返回等待态');
    return { dismissed: true, way: 'close-icon' };
  }
  // ③ Escape 兜底（多数模态层监听键盘退出）
  if (!guard('Escape 关闭通过弹窗')) return { dismissed: false, reason: 'dry-run' };
  await page.keyboard.press('Escape').catch(() => {});
  log('通过弹窗未找到关闭控件，已尝试 Escape');
  return { dismissed: false, reason: 'escape' };
}

/**
 * 评测后确保回到题目页（v0.7.0，2026-09-09 用户新增）。
 * 背景：有时首次评测提交后平台会跳转到全屏「实际输出」结果页，后续
 * 反思/重试/再评测都必须回到题目页，此前只能用户手动返回。
 * 流程：仍在题目页（URL 命中 taskUrlPattern）→ 原样返回零副作用；
 * 不在 → 先抓结果页文本尾部作为反思证据，再 ① 在浏览器上下文中按
 * 题目 URL 模式找回原题目页并 bringToFront，② 找不到则 goBack 后退；
 * 两路都失败时原样返回（调用方按现有流程继续，并有日志提示）。
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{page: import('playwright-core').Page, navigated: boolean, evidence: string}>}
 */
export async function ensureTaskPage(page) {
  const pattern = new RegExp(cfg.watch.taskUrlPattern);
  if (pattern.test(page.url())) {
    // —— SPA 页内「实际输出」结果视图（v0.8 实测：URL 不变，工作区被顶掉，
    //    0.7.0 的 URL 判据对此失效）——判据：编辑器与终端都不可见 + 页面
    //    同时含「实际输出」「查看效果」。关闭尝试逐级降级，每步验证工作区
    //    真实恢复（编辑器或终端重新可见）才算成功。
    const st = await page
      .evaluate(() => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const ed = document.querySelector('.monaco-editor');
        const xt = document.querySelector('.xterm-screen');
        const t = document.body ? document.body.innerText : '';
        return {
          workspace: (ed && vis(ed)) || (xt && vis(xt)),
          inResultView: t.includes('实际输出') && t.includes('查看效果'),
        };
      })
      .catch(() => ({ workspace: true, inResultView: false }));
    if (st.inResultView && !st.workspace) {
      let evidence = '';
      try {
        const t = await page.evaluate(() => (document.body ? document.body.innerText : ''));
        if (t.trim()) evidence = t.trim().slice(-3000);
      } catch {}
      const workspaceBack = () =>
        page
          .evaluate(() => {
            const vis = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const ed = document.querySelector('.monaco-editor');
            const xt = document.querySelector('.xterm-screen');
            return (ed && vis(ed)) || (xt && vis(xt));
          })
          .catch(() => true);
      // 尝试 1：⊗ 关闭（class 含 close/Close、位于页面上部的可见元素）
      const closes = page.locator('[class*="close"], [class*="Close"]');
      const n = await closes.count().catch(() => 0);
      for (let k = 0; k < Math.min(n, 8); k++) {
        const c = closes.nth(k);
        if (!(await c.isVisible().catch(() => false))) continue;
        const box = await c.boundingBox().catch(() => null);
        if (!box || box.top > 300 || box.width > 80) continue;
        if (!guard('关闭「实际输出」结果视图（关闭图标）')) break;
        await c.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600);
        if (await workspaceBack()) {
          log('已关闭「实际输出」结果视图，工作区已恢复');
          return { page, navigated: false, evidence, resultViewClosed: true };
        }
      }
      // 尝试 2：点「查看效果」（假设为视图开关）
      const ck = page.getByText('查看效果', { exact: true }).first();
      if (await ck.isVisible().catch(() => false)) {
        if (guard('点击「查看效果」退出结果视图')) {
          await ck.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(600);
          if (await workspaceBack()) {
            log('已通过「查看效果」退出结果视图，工作区已恢复');
            return { page, navigated: false, evidence, resultViewClosed: true };
          }
        }
      }
      // 尝试 3：Escape 兜底
      if (guard('Escape 退出结果视图')) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
        if (await workspaceBack()) {
          log('已通过 Escape 退出结果视图，工作区已恢复');
          return { page, navigated: false, evidence, resultViewClosed: true };
        }
      }
      log('「实际输出」结果视图未能关闭，按当前页面继续');
      return { page, navigated: false, evidence };
    }
    return { page, navigated: false, evidence: '' };
  }
  // 已跳转：先抓结果页文本尾部作为反思证据，再返回题目页
  let evidence = '';
  try {
    const t = await page.evaluate(() => document.body?.innerText ?? '');
    if (t.trim()) evidence = t.trim().slice(-3000);
  } catch {}
  const back = page
    .context()
    .pages()
    .find((p) => pattern.test(p.url()));
  if (back) {
    await back.bringToFront().catch(() => {});
    log('评测后平台跳转到结果页，已定位回原题目页');
    return { page: back, navigated: true, evidence };
  }
  await page.goBack({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (pattern.test(page.url())) {
    log('评测后平台跳转到结果页，已后退返回原题目页');
    return { page, navigated: true, evidence };
  }
  log(`未能返回原题目页（当前：${page.url().slice(0, 80)}），按当前页面继续`);
  return { page, navigated: false, evidence };
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
    // ① 首选：**DOM 结构锚定**（2026-09-23 真机实测）。本平台把两个栏目标记并排渲染在同一
    //    行（`<p><span>—— 预期输出 ——</span><span>—— 实际输出 ——</span></p>`），两份正文
    //    既不跟在各自标记之后、也不分列两栏，而是**整块挂在标题行的下一个兄弟元素**里，
    //    且是**两个并列子元素**（实测：两个 div 各 552 字符，第 1 个=预期、第 2 个=实际）。
    //    此时按 innerText 位置切分会把"预期段"切成两个标记之间的「——」并被清空，而两份
    //    正文被 actual 一并吞掉 ⇒ expected 空 ⇒ 差异定位与容器格式反解**同时失效**
    //    （2026-09-23 事故根因，1.6.6 的"同行标记"修复并未覆盖这一形态）。
    //    锚点只用文本（带 hash 的 CSS module 类名会变，不可写死），结构不符则回退 ②。
    const titleEl = Array.from(el.querySelectorAll('*'))
      .filter((x) => {
        const s = x.innerText ?? '';
        return s.includes('预期输出') && s.includes('实际输出');
      })
      .sort((a, b) => (a.innerText?.length ?? 0) - (b.innerText?.length ?? 0))[0];
    const cols = titleEl?.nextElementSibling
      ? Array.from(titleEl.nextElementSibling.children)
          .map((c) => (c.innerText ?? '').trim())
          .filter(Boolean)
      : [];
    // 并列双栏的判据：**两列互不含对方栏目标记**（2026-09-23 修正）。
    // 旧判据是"两列文本量级相当（比例 > 0.3）"，本意是防止把"标题行 + 单块正文"误判成双栏——
    // 但 `cols.length >= 2` 已经挡掉了那种结构，比例门槛只剩副作用：**实际输出比预期短得多
    // 时（提交报错、查询全空，正是最需要看差异的时候）比例必然 < 0.3**，于是正确配对被拒、
    // 回退到按 innerText 位置切分，预期段只剩标记之间的「——」⇒ expected 为空 ⇒
    // 「本地差异定位未启用：预期或实际段正文为空」。
    // 真机证据：2026-09-23 同关面板两列为 [预期 2492 字符, 实际 267 字符]，比例 0.107 被拒；
    // 全历史该签名出现 16 次（09-22 三次、09-23 十三次），是"反思盲改"的常驻来源。
    const colsOk =
      cols.length >= 2 && !cols[0].includes('实际输出') && !cols[1].includes('预期输出');
    // ② 回退：标记与正文相邻的旧写法（按出现位置切分，兼容颠倒的渲染顺序）
    if (colsOk) {
      expected = cut(cols[0].replace(/展示原始输出/g, '')).slice(0, 2000);
      actual = cut(cols[1].replace(/展示原始输出/g, '')).slice(0, 2000);
    } else if (iE < iA) {
      expected = cut(t.slice(iE + 4, iA)).slice(0, 2000);
      actual = cut(t.slice(iA + 4).replace(/展示原始输出/g, '')).slice(0, 2000);
    } else {
      actual = cut(t.slice(iA + 4, iE).replace(/展示原始输出/g, '')).slice(0, 2000);
      expected = cut(t.slice(iE + 4)).slice(0, 2000);
    }
    if (!expected && !actual) continue;
    // 测试输入：位于「测试输入」标签之后、预期输出来临之前（2026-09-15 补充：
    // 反射要结合"针对什么输入"理解失败场景，不能再只喂预期/实际输出）
    let input = '';
    const iI = t.indexOf('测试输入');
    if (iI >= 0) {
      const start = iI + 4; // 跳过「测试输入」标签本身
      const end = iE < iA ? iE : iA; // 测试输入出现在预期/实际输出来临之前
      if (end > start) input = cut(t.slice(start, end)).slice(0, 500);
    }
    // 只认带正文的区块：纯标签行迷你容器（只有栏目头+耗时行、无实际内容）
    // 会以"最小容器"胜出，喂给反思的只是百余字符的空壳（2026-09-09 实测）
    const bodyLen = (expected + actual).replace(/\s+/g, '').length;
    if (bodyLen < 20) continue;
    picked.push({ _el: el, title, expected, actual, input });
    if (picked.length >= 8) break;
  }
  return picked.map(({ title, expected, actual, input }) => ({ title, expected, actual, input }));
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
  const perSetCap = opts.perSetCap ?? 2000;
  const totalCap = opts.totalCap ?? 12000;
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
        `【${s.title || '测试集'}】${s.input ? `\n测试输入：\n${dropDashLines(s.input)}` : ''}\n预期输出：\n${dropDashLines(s.expected.slice(0, perSetCap))}\n实际输出：\n${dropDashLines(s.actual.slice(0, perSetCap))}`,
    )
    .join('\n\n');
  log(`已展开 ${clicked} 个折叠块，抓取 ${sets.length} 组预期/实际输出明细（${text.length} 字符）`);
  // 预期段为空是"面板渲染方式与抓取假设不符"的上游征兆：它会让**本地差异定位与容器格式
  // 反解同时失效**（两者都以差异分类为输入），而下游只会各报一句"未启用"。这里直接点出
  // 是抓取侧的问题，避免复盘时把两处失效当成两个独立故障（2026-09-23 事故审计结论）。
  const emptyExp = sets.filter((s) => !s.expected.trim()).length;
  if (emptyExp) {
    log.warn(
      `${emptyExp}/${sets.length} 组明细的「预期输出」段为空——面板渲染方式可能与抓取假设` +
        '不符，本地差异定位与容器格式反解都会因此失效，请核对页面结构',
    );
  }
  return text.slice(0, totalCap);
}

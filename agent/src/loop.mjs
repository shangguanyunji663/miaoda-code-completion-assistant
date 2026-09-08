// EXPORTS: solveOnce, runLoop
// 主编排：感知 → 生成/作答 → 提交评测 → 读结果 → 失败反思 → 成功翻页。
//
// 单题流程（代码题）：
//   probe → generateCode → writeEditor → settle → clickEval → waitResult
//        → passed? 结束 : reflectAndFix → 回到 writeEditor（最多 MAX_RETRY 次）
// 选择题 / 填空题走 answerQuestion 分支，题型由 perceive.classifyTask 判定。

import { cfg } from './config.mjs';
import { connectBrowser, pickTargetPage } from './browser.mjs';
import { probePage, writeEditorCode } from './perceive.mjs';
import { clickEval, clickNext, waitEvalResult, settle, answerChoice, fillBlank, applyAnswers } from './act.mjs';
import { generateCode, reflectAndFix, answerQuestion, answerBatch, detectVerdict, spliceIntoTemplate } from './ai.mjs';

const log = (m) => console.log(`[loop] ${m}`);

/**
 * 解当前页面这一道题
 * @param {import('playwright-core').Page} page
 * @param {object} probe probePage 的结果
 */
export async function solveOnce(page, probe) {
  const problem = (probe.problem ?? '').trim();
  if (!problem) {
    log('未提取到题目文本，跳过（可先执行 npm run dump 检查页面结构）');
    return { ok: false, reason: 'no-problem' };
  }

  const kind = probe.taskType;
  log(`题型=${kind} 编辑器=${probe.editor?.type ?? '无'} 题干长度=${problem.length}`);

  if (kind === 'choice' || kind === 'blank') {
    const qs = probe.questions ?? [];
    if (qs.length > 0) {
      // 结构化多小题：一次性交给 AI 批量作答，再逐项勾选
      log(`识别到 ${qs.length} 道小题（其中多选 ${qs.filter((q) => q.multi).length} 道）`);
      const { map, raw } = await answerBatch({ questions: qs, reference: problem });
      log(`AI 批量答案：${raw.replace(/\s+/g, ' ').slice(0, 150)}`);
      const applied = await applyAnswers(page, qs, map);
      const okCount = applied.filter((r) => r.ok).length;
      log(`已勾选 ${okCount}/${applied.length} 项`);
      for (const r of applied.filter((x) => !x.ok)) {
        log(`  未勾选：第 ${r.no} 题 ${r.letter ?? ''} —— ${r.reason}`);
      }
    } else {
      // 回退：页面非结构化容器，退化成单题作答
      const options = (probe.inputs?.choiceLabels ?? []).join('\n');
      const ans = await answerQuestion({ question: problem, options, questionType: kind });
      log(`AI 答案：${String(ans).slice(0, 60)}`);
      if (kind === 'choice') await answerChoice(page, ans);
      else await fillBlank(page, ans);
    }

    await settle(page);
    await clickEval(page);
    const ev = await waitEvalResult(page);
    const v = detectVerdict(ev);
    log(`评测判定：${v.passed ? '通过' : '未通过'}（${v.reason}）`);
    return { ok: v.passed, kind, verdict: v, evalText: ev };
  }

  // ---- 代码题：生成 → 评测 → 反思循环 ----
  let code = null;
  let lastEval = '';

  for (let attempt = 1; attempt <= cfg.loop.maxRetry; attempt++) {
    if (code === null) {
      code = await generateCode({
        problem,
        codeTemplate: probe.code ?? '',
      });
      log(`第 ${attempt} 次生成代码（${code.length} 字符）`);
    } else {
      log(`第 ${attempt} 次尝试（沿用反思后的代码，${code.length} 字符）`);
    }

    if (!code || !code.trim()) {
      log('生成代码为空，终止本题');
      return { ok: false, kind, reason: 'empty-code' };
    }

    await writeEditorCode(page, spliceIntoTemplate(probe.code, code));
    await settle(page);

    const clicked = await clickEval(page);
    if (!clicked.clicked) {
      log('未找到评测按钮，终止本题');
      return { ok: false, kind, reason: 'no-eval-button' };
    }

    lastEval = await waitEvalResult(page);
    const v = detectVerdict(lastEval);
    log(`第 ${attempt} 次评测：${v.passed ? '通过' : '未通过'}（${v.reason}）`);

    if (v.passed) {
      return { ok: true, kind, attempts: attempt, verdict: v, code };
    }

    if (attempt === cfg.loop.maxRetry) break;

    const fixed = await reflectAndFix({
      problem,
      previousCode: code,
      evalResult: lastEval || '（未捕获到评测输出，请根据题目要求重新审视实现）',
    });
    if (fixed.analysis) log(`反思分析：${String(fixed.analysis).replace(/\s+/g, ' ').slice(0, 160)}`);
    if (!fixed.code) {
      log('反思未产出代码，终止本题');
      break;
    }
    code = fixed.code;
  }

  return { ok: false, kind, attempts: cfg.loop.maxRetry, evalText: lastEval };
}

/**
 * 连续解题主循环
 * @param {{once?: boolean}} opts once=true 只做一题
 */
export async function runLoop(opts = {}) {
  const { browser, context } = await connectBrowser();
  const page = await pickTargetPage(context);
  log(`已连接页面：${page.url()}`);

  const summary = [];
  let solved = 0;

  try {
    while (true) {
      const probe = await probePage(page);
      const r = await solveOnce(page, probe);
      summary.push(r);
      if (r.ok) solved++;

      if (opts.once) break;
      if (cfg.loop.maxTasks > 0 && summary.length >= cfg.loop.maxTasks) {
        log(`已达 MAX_TASKS=${cfg.loop.maxTasks}，停止`);
        break;
      }

      const next = await clickNext(page);
      if (!next.clicked) {
        log('未找到「下一题」，循环结束');
        break;
      }
      await page.waitForTimeout(cfg.loop.cooldownMs);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log(`完成：共 ${summary.length} 题，通过 ${solved} 题`);
  return { total: summary.length, solved, summary };
}

/**
 * 遍历所有标签页，找出第一个尚未处理过的题目页。
 *
 * 注意：这里刻意没有用 document.visibilityState 判断"用户正在看哪个标签"。
 * 实测在 CDP 连接下，本机 5 个标签页全部返回 visible，无法据此区分活动标签，
 * 因此改用「遍历所有标签 + URL 去重」：只要出现新的题目 URL 就处理一次。
 */
function findNewTaskPage(context, processed) {
  for (const p of context.pages()) {
    try {
      const key = taskKey(p.url());
      if (key && !processed.has(key)) return { page: p, key };
    } catch {
      /* 页面可能已关闭或正在销毁 */
    }
  }
  return null;
}

/**
 * 等待题目区渲染完成。
 * 该平台页面加载后题目是异步渲染的（Ant Design），过早 probe 会拿到空题干，
 * 因此轮询等待题目容器或代码编辑器出现再开始。
 */
async function waitTaskReady(page, timeoutMs = cfg.watch.readyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(
        () =>
          !!document.querySelector('ul.choose-container') ||
          !!document.querySelector(
            '.monaco-editor, .ace_editor, .CodeMirror, .cm-editor, textarea',
          ),
      )
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/** 从 URL 中提取题目唯一键；非题目页返回 null */
export function taskKey(url) {
  try {
    const m = String(url ?? '').match(new RegExp(cfg.watch.taskUrlPattern));
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * 常驻监听模式：程序一直运行，检测到用户切换到新的题目页就自动作答。
 *
 * 与 run 模式的区别：run 自己点「下一关」翻页；watch 只做题、不翻页，
 * 导航权始终在用户手里。这正是"切到哪儿做哪儿"的用法。
 */
export async function watchLoop() {
  const { browser, context } = await connectBrowser();
  log('监听已启动：当前打开或新切换到的题目页即自动作答（Ctrl+C 退出）');
  log(`轮询间隔 ${cfg.watch.pollMs}ms，题目页 URL 模式 ${cfg.watch.taskUrlPattern}`);

  const processed = new Set();
  let busy = false;
  let solved = 0;

  const shutdown = async () => {
    log(`正在退出，本次累计通过 ${solved} 题`);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 起步即处理当前已打开的题目页：不预标记，交给下方轮询在首轮自然捕获并作答，
  // 作答后记入 processed，避免同一页被反复提交。这样做到"打开页面即做题"，
  // 之后切到新 URL 才会触发下一题。
  log('提示：当前已打开的题目页将立即作答，切到新题目页也会自动作答');

  while (true) {
    if (!busy) {
      try {
        const hit = findNewTaskPage(context, processed);
        if (hit) {
          processed.add(hit.key);
          busy = true;
          log(`检测到题目页：${hit.key}`);
          try {
            await hit.page.waitForLoadState('domcontentloaded').catch(() => {});
            if (!(await waitTaskReady(hit.page))) {
              log('题目区未在超时内渲染，跳过本页');
            } else {
              const probe = await probePage(hit.page);
              const r = await solveOnce(hit.page, probe);
              if (r?.ok) solved++;
              log(`本题结束：${r?.ok ? '通过' : '未通过'}（累计通过 ${solved}）`);
            }
          } catch (e) {
            log(`处理异常：${e.message}`);
          } finally {
            busy = false;
          }
          log('等待你切换到下一题...');
        }
      } catch (e) {
        log(`轮询异常：${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, cfg.watch.pollMs));
  }
}

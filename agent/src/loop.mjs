// EXPORTS: solveOnce, runLoop, watchLoop, liteLoop, courseLoop
// 主编排：感知 → 意图判定 → 生成/作答 → 提交评测 → 读结果 → 失败反思 → 成功翻页。
//
// 单题流程（代码题 / 命令行题，按题干意图分流）：
//   probe → classifyProblemIntent(题干) → 切换到对应工作区（命令行 / 代码文件）
//     code:    generateCode → writeEditor → settle → clickEval → waitResult
//              → passed? 结束 : reflectAndFix → 回到 writeEditor（最多 MAX_RETRY 次）
//     cmdline: generateCommands → 逐条键入 xterm → settle → clickEval → waitResult
//              → passed? 结束 : reflectCommands → 重新键入（最多 MAX_RETRY 次）
// 选择题 / 填空题走 answerQuestion 分支，题型由 perceive.classifyTask 判定。

import { cfg } from './config.mjs';
import { connectBrowser, pickTargetPage } from './browser.mjs';
import {
  probePage,
  writeEditorCode,
  collectCards,
  collectSections,
  collectCardCandidates,
  dumpCourseProbe,
  waitForTerminal,
  waitForEditor,
} from './perceive.mjs';
import {
  clickEval,
  clickNext,
  waitEvalResult,
  settle,
  answerChoice,
  fillBlank,
  applyAnswers,
  readTaskNo,
  waitTaskAdvance,
  clickExitTask,
  clickBackArrow,
  clickContinueChallenge,
  clickStartLearning,
  switchTaskTab,
  runTerminalCommands,
  collectTestSetDetails,
} from './act.mjs';
import {
  generateCode,
  reflectAndFix,
  answerQuestion,
  answerBatch,
  detectVerdict,
  spliceIntoTemplate,
  classifyProblemIntent,
  generateCommands,
  reflectCommands,
} from './ai.mjs';

const log = (m) => console.log(`[loop] ${m}`);

/**
 * 解当前页面这一道题。
 * 选择/填空题按结构信号直接作答；代码题与命令行题先按题干内容做 AI 意图判定
 * （classifyProblemIntent），再自动切到对应工作区（代码文件 / 命令行）执行，
 * 两条分支均含反思修正循环（最多 cfg.loop.maxRetry 轮）。
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

  // ---- 代码题 / 命令行题：先读题干判意图，再分流到对应工作区 ----
  // 判定依据是题干要求本身（AI 意图路由），而非当前激活的 tab；
  // 判定后若工作区 tab 不符则自动切换（命令行 / 代码文件）。
  const intent = await classifyProblemIntent({ problem });
  log(`题干意图判定：${intent === 'cmdline' ? '命令行操作（cmdline）' : '代码编写（code）'}`);

  if (intent === 'cmdline') {
    const tab = await switchTaskTab(page, '命令行');
    if (tab.found && tab.clicked) await settle(page);
    if (!(await waitForTerminal(page))) {
      log('命令行终端未在超时内出现，终止本题（可 npm run dump 检查页面）');
      return { ok: false, kind: 'cmdline', reason: 'no-terminal' };
    }

    let cmds = null;
    let lastEval = '';
    for (let attempt = 1; attempt <= cfg.loop.maxRetry; attempt++) {
      if (cmds === null) {
        // 生成期间无中间日志可打，必须提前预告静默期，否则推理模型 1~2 分钟
        // 的思考+生成会被用户当成"卡死/不作答"。
        log('正在调用 AI 生成命令…（推理模型先思考后作答，可能需要 1~2 分钟）');
        const t0 = Date.now();
        cmds = await generateCommands({ problem });
        log(
          `第 ${attempt} 次生成命令（${cmds.length} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：${cmds
            .slice(0, 4)
            .join(' ; ')
            .slice(0, 140)}`,
        );
        if (!cmds.length) {
          log('生成命令为空，终止本题');
          return { ok: false, kind: 'cmdline', reason: 'empty-commands' };
        }
      }

      const r = await runTerminalCommands(page, cmds);
      if (!r.executed) {
        log('终端键入失败，终止本题');
        return { ok: false, kind: 'cmdline', reason: r.reason ?? 'terminal-input-failed' };
      }
      await settle(page);

      const clicked = await clickEval(page);
      if (!clicked.clicked) {
        log('未找到评测按钮，终止本题');
        return { ok: false, kind: 'cmdline', reason: 'no-eval-button' };
      }
      lastEval = await waitEvalResult(page);
      const v = detectVerdict(lastEval);
      log(`第 ${attempt} 次评测：${v.passed ? '通过' : '未通过'}（${v.reason}）`);
      if (!v.passed) {
        // 失败差异增强：展开「测试集N」折叠块抓预期/实际明细喂给反思。
        // 没有差异证据的反思等于盲改（页面无该结构时返回空串，零影响）。
        const detail = await collectTestSetDetails(page);
        if (detail) {
          lastEval = `${lastEval || '（面板文本未捕获，以下为折叠块明细）'}\n\n=== 测试集明细 ===\n${detail}`;
        }
      }
      if (v.passed) {
        return { ok: true, kind: 'cmdline', attempts: attempt, verdict: v, commands: cmds };
      }
      if (attempt === cfg.loop.maxRetry) break;

      const fixed = await reflectCommands({
        problem,
        previousCommands: cmds,
        evalResult: lastEval || '（未捕获到评测输出，请对照任务要求自查命令）',
      });
      if (fixed.analysis) log(`反思分析：${String(fixed.analysis).slice(0, 160)}`);
      if (!fixed.commands?.length) {
        log('反思未产出命令，终止本题');
        break;
      }
      cmds = fixed.commands;
    }
    return { ok: false, kind: 'cmdline', evalText: lastEval };
  }

  // ---- 代码题：确保「代码文件」工作区激活后，生成 → 评测 → 反思循环 ----
  const tab = await switchTaskTab(page, '代码文件');
  if (tab.found && tab.clicked) await settle(page);
  if (!(await waitForEditor(page))) {
    log('代码编辑器未在超时内出现，终止本题');
    return { ok: false, kind: 'code', reason: 'no-editor' };
  }
  const codeProbe = await probePage(page); // 切 tab 后重新探测，拿最新模板

  let code = null;
  let lastEval = '';

  for (let attempt = 1; attempt <= cfg.loop.maxRetry; attempt++) {
    if (code === null) {
      // 同命令行分支：预告静默期 + 统计耗时，消除"切完 tab 就没动静"的观感
      log('正在调用 AI 生成代码…（推理模型先思考后作答，可能需要 1~3 分钟）');
      const t0 = Date.now();
      code = await generateCode({
        problem,
        codeTemplate: codeProbe.code ?? '',
      });
      log(
        `第 ${attempt} 次生成代码（${code.length} 字符，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
      );
    } else {
      log(`第 ${attempt} 次尝试（沿用反思后的代码，${code.length} 字符）`);
    }

    if (!code || !code.trim()) {
      log('生成代码为空，终止本题');
      return { ok: false, kind: 'code', reason: 'empty-code' };
    }

    await writeEditorCode(page, spliceIntoTemplate(codeProbe.code, code));
    await settle(page);

    const clicked = await clickEval(page);
    if (!clicked.clicked) {
      log('未找到评测按钮，终止本题');
      return { ok: false, kind: 'code', reason: 'no-eval-button' };
    }

    lastEval = await waitEvalResult(page);
    const v = detectVerdict(lastEval);
    log(`第 ${attempt} 次评测：${v.passed ? '通过' : '未通过'}（${v.reason}）`);

    if (!v.passed) {
      // 同命令行分支：失败时先抓「测试集N」预期/实际差异明细再反思
      const detail = await collectTestSetDetails(page);
      if (detail) {
        lastEval = `${lastEval || '（面板文本未捕获，以下为折叠块明细）'}\n\n=== 测试集明细 ===\n${detail}`;
      }
    }

    if (v.passed) {
      return { ok: true, kind: 'code', attempts: attempt, verdict: v, code };
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

  return { ok: false, kind: 'code', attempts: cfg.loop.maxRetry, evalText: lastEval };
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
  // 超时诊断：区分「页面空白（多半是该平台未登录，如 www.educoder.net 对
  // 匿名用户渲染空壳）」与「渲染了但不是做题页」
  const info = await page
    .evaluate(() => ({
      textLen: (document.body.innerText || '').trim().length,
      url: location.href,
    }))
    .catch(() => null);
  if (info && info.textLen < 20) {
    log(
      `页面渲染为空（${info.url.slice(0, 80)}）——多半是该平台未登录：` +
        '请在调试浏览器里登录一次该站点（登录态会持久保存），然后重新触发',
    );
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

/**
 * 刷新触发（lite）模式：常驻监听，用户刷新题目页即重新自动作答。
 *
 * 与 watch 的区别：watch 按 URL 去重，同一题 URL 只做一次，刷新同页不重触发；
 * lite 以「页面刷新」为触发信号——当反思修正循环仍未能通过时，用户 F5 刷新
 * 即可让 agent 重新完整做一遍（生成 → 评测 → 反思修正循环，与 watch 同一套
 * solveOnce 流程）。只做题、不翻页，导航权始终在用户手里。
 *
 * 触发实现：在页面 window 上注入 __liteHandled 标记；刷新会销毁执行环境，
 * 标记随之消失，轮询发现「URL 匹配题目页 && 标记不存在」即触发一轮作答，
 * 作答开始前先补标记防止同一轮询周期内重复触发。SPA 软导航不销毁 window，
 * 不会误触发。
 */
export async function liteLoop() {
  const { browser, context } = await connectBrowser();
  log('刷新触发模式已启动：刷新任意题目页即自动重做（Ctrl+C 退出）');
  log(`轮询间隔 ${cfg.watch.pollMs}ms，题目页 URL 模式 ${cfg.watch.taskUrlPattern}`);

  let busy = false;
  let solved = 0;
  let rounds = 0;

  const shutdown = async () => {
    log(`正在退出，本次累计作答 ${rounds} 轮，通过 ${solved} 题`);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const markHandled = (page) =>
    page.evaluate(() => {
      window.__liteHandled = true;
    }).catch(() => {});

  const isFresh = (page) =>
    page
      .evaluate(() => !window.__liteHandled)
      .catch(() => false);

  while (true) {
    if (!busy) {
      for (const page of context.pages()) {
        if (busy) break;
        let key = null;
        try {
          key = taskKey(page.url());
        } catch {
          continue; // 页面可能已关闭或正在销毁
        }
        if (!key) continue;
        if (!(await isFresh(page))) continue;

        busy = true;
        try {
          await markHandled(page); // 先打标，防止同一轮询周期内重复触发
          log(`检测到题目页刷新：${key}`);
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          if (!(await waitTaskReady(page))) {
            log('题目区未在超时内渲染，跳过本轮（可执行 npm run dump 检查页面结构）');
          } else {
            const probe = await probePage(page);
            const r = await solveOnce(page, probe);
            rounds++;
            if (r?.ok) solved++;
            log(`本轮结束：${r?.ok ? '通过' : '未通过'}（累计作答 ${rounds} 轮，通过 ${solved}）`);
            if (!r?.ok) log('提示：反思重试已用尽仍未通过，刷新本页可让 agent 重新完整作答');
          }
        } catch (e) {
          log(`处理异常：${e.message}`);
        } finally {
          busy = false;
        }
      }
    }
    await new Promise((r) => setTimeout(r, cfg.watch.pollMs));
  }
}

// ---- 课程自动驾驶（course）模式 ----

/** 在所有标签页中找含「开始学习」的列表页；找不到返回 null */
async function findListPage(context) {
  for (const p of context.pages()) {
    const has = await p
      .locator('text="开始学习"')
      .first()
      .isVisible()
      .catch(() => false);
    if (has) return p;
  }
  return null;
}

/**
 * 完成一个小板块内的所有关卡：做题 → 评测通过点「下一关」→ 点击后
 * URL/关卡序号均无变化即止（说明本板块关卡已做完）。
 * 「下一关」找不到（通常因为本关未通过，平台不放开入口）同样结束本板块。
 */
async function solveBoard(page) {
  let attempts = 0;
  let passed = 0;
  while (true) {
    if (!(await waitTaskReady(page))) {
      log('题目区未在超时内渲染（可能不是做题页），结束本板块');
      break;
    }
    const probe = await probePage(page);
    const r = await solveOnce(page, probe);
    attempts++;
    if (r?.ok) passed++;

    const before = { url: page.url(), taskNo: await readTaskNo(page) };
    const next = await clickNext(page);
    if (!next.clicked) {
      log('未找到「下一关」，本板块结束');
      break;
    }
    if (!(await waitTaskAdvance(page, before))) {
      log('「下一关」未跳转，判定本板块关卡已全部完成');
      break;
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  return { attempts, passed };
}

/** 退出当前小板块：任务页右上角「退出」→ 详情页左上角返回 → 等列表页出现 */
async function exitBoard(page) {
  await clickExitTask(page);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
  await clickBackArrow(page);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const deadline = Date.now() + cfg.course.listTimeoutMs;
  while (Date.now() < deadline) {
    const has = await page
      .locator('text="开始学习"')
      .first()
      .isVisible()
      .catch(() => false);
    if (has) return;
    await page.waitForTimeout(800);
  }
  log('警告：返回后未见「开始学习」列表（页面结构可能不同，可 npm run dump 检查）');
}

/**
 * 课程自动驾驶：遍历「课堂实验 → 板块 → 卡片(开始学习)」，逐关作答直至全部完成。
 *
 * 单块流程：点「开始学习」→（可能落在作业详情页则先点「继续挑战」）→ solveBoard
 * → 任务页右上角「退出」→ 详情页左上角返回 → 回列表继续下一块。
 * 已完成卡片（进度 n/n）自动跳过；点击「开始学习」若新开标签页则在新页作答后关闭。
 */
export async function courseLoop() {
  const { browser, context } = await connectBrowser();
  log('课程模式：自动遍历 课堂实验 → 板块 → 开始学习，逐关作答');
  const summary = { boards: 0, passed: 0, attempts: 0 };

  try {
    const listPage = await findListPage(context);
    if (!listPage) {
      log('未找到含「开始学习」的列表页：请先在该浏览器打开课堂实验列表页，再运行 course');
      return summary;
    }
    log(`列表页：${listPage.url()}`);

    const processed = new Set();
    const sections = await collectSections(listPage);
    const sectionNames = sections.length > 0 ? sections : ['课堂实验'];
    log(`左侧板块 ${sectionNames.length} 个：${sectionNames.join('、')}`);

    for (const sec of sectionNames) {
      // 点板块（文本去掉尾部数量角标，如 "Redis初步体验 1" -> "Redis初步体验"）
      const secBase = sec.replace(/\s*\d+\s*$/, '');
      const loc = listPage.getByText(secBase, { exact: false }).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        await loc.click({ timeout: 8000 }).catch(() => {});
        await listPage.waitForTimeout(1200);
      }

      for (let i = 0; i < cfg.course.maxBoardsPerSection; i++) {
        // 切板块后卡片异步渲染，最多等 5 秒
        let cards = [];
        for (let t = 0; t < 5 && cards.length === 0; t++) {
          cards = await collectCards(listPage);
          if (cards.length === 0) await listPage.waitForTimeout(1000);
        }
        if (cards.length === 0) {
          log(`板块「${secBase}」未识别到「开始学习」卡片，自动导出诊断信息：`);
          try {
            const cands = await collectCardCandidates(listPage);
            if (cands.length === 0) {
              log('  页面上没有任何含「开始学习」的候选节点（列表可能在 shadow DOM/特殊容器/iframe 中）');
            }
            for (const c of cands.slice(0, 8)) {
              log(`  候选 <${c.tag} class="${c.cls}"> text=${c.text}`);
            }
            const { file } = await dumpCourseProbe(listPage, cards, sections);
            log(`  结构快照已导出：${file}`);
            log('  把上面候选行的 text= 原样发回，即可一次性精调识别规则');
          } catch (e) {
            log(`  诊断导出失败：${e.message}`);
          }
          break;
        }
        const next = cards.find(
          (c) =>
            !processed.has(c.title) &&
            !(c.done != null && c.total != null && c.total > 0 && c.done >= c.total),
        );
        if (!next) break;

        processed.add(next.title);
        log(
          `—— 小板块：${next.title}${next.total ? `（进度 ${next.done ?? 0}/${next.total}）` : ''}`,
        );
        const idx = cards.indexOf(next);
        const beforeUrl = listPage.url();
        const beforePages = new Set(context.pages());
        const clicked = await clickStartLearning(listPage, idx);
        if (!clicked.clicked) continue;

        // 等待导航：新标签页出现或本标签 URL 变化；两者都没发生说明平台
        // 没有响应点击（可能点到了非可点节点），明确记日志后跳过该卡片
        let boardPage = null;
        {
          const deadline = Date.now() + 12000;
          while (Date.now() < deadline) {
            const np = [...context.pages()].find((p) => !beforePages.has(p));
            if (np) {
              boardPage = np;
              break;
            }
            if (listPage.url() !== beforeUrl) {
              boardPage = listPage;
              break;
            }
            await listPage.waitForTimeout(500);
          }
        }
        if (!boardPage) {
          log(`「开始学习」点击后 12 秒内未发生导航，跳过卡片：${next.title}`);
          continue;
        }
        await boardPage.waitForLoadState('domcontentloaded').catch(() => {});
        await clickContinueChallenge(boardPage);

        const r = await solveBoard(boardPage);
        summary.boards++;
        summary.passed += r.passed;
        summary.attempts += r.attempts;
        log(`小板块结束：${next.title}（通过 ${r.passed}/${r.attempts} 关）`);

        await exitBoard(boardPage);
        if (boardPage !== listPage) await boardPage.close().catch(() => {});
      }
    }

    log(
      `课程模式完成：处理 ${summary.boards} 个小板块，通过 ${summary.passed}/${summary.attempts} 关`,
    );
  } finally {
    await browser.close().catch(() => {});
  }
  return summary;
}

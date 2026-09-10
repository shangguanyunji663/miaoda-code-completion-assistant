// EXPORTS: solveOnce, runLoop, watchLoop, liteLoop, courseLoop
// 主编排：感知 → 意图判定 → 生成/作答 → 提交评测 → 读结果 → 失败反思 → 成功翻页。
//
// 单题流程（代码题 / 命令行题 / 混合题，按题干意图分流）：
//   probe → classifyProblemIntent(题干) → 切换到对应工作区（命令行 / 代码文件）
//     code:    generateCode → 护栏清洗 → writeEditor → settle → clickEval → waitResult
//              → passed? 结束 : reflectAndFix → 回到 writeEditor（最多 MAX_RETRY 次）
//     cmdline: generateCommands → 护栏清洗 → 逐条键入 xterm → settle → clickEval → waitResult
//              → passed? 结束 : reflectCommands → 重新键入（最多 MAX_RETRY 次）
//     mixed:   generateCommands(仅数据准备) → 键入终端（输入期报错反思自愈，≤2 轮）→ 落入 code 分支
// 选择题 / 填空题走 answerQuestion 分支，题型由 perceive.classifyTask 判定。

import { cfg } from './config.mjs';
import { createLogger } from './logger.mjs';
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
  readTerminalText,
  detectTerminalEnv,
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
  dismissPassModal,
  ensureTaskPage,
  probeTerminalClients,
} from './act.mjs';
import {
  generateCode,
  reflectAndFix,
  answerQuestion,
  answerBatch,
  detectVerdict,
  spliceIntoTemplate,
  sanitizeShellSubmission,
  wrapDbCommandsInEcho,
  classifyProblemIntent,
  generateCommands,
  reflectCommands,
} from './ai.mjs';

const log = createLogger('loop');

/** 题干命中这些关键词才做客户端可用性探测（纯 bash 文件任务不浪费一轮键入） */
const NEEDS_DB = /(mongodb|mongosh|\bmongo\b|mysql|redis|psql|postgres|数据库|集合)/i;

/**
 * 执行层命令别名：首词被实测禁令命中时的确定性替换。
 * mongosh→mongo：mongosh 是 MongoDB 4.4+ 的 Node 客户端，本平台（Ubuntu 16.04 +
 * MongoDB 4.0）只有 legacy mongo shell——它是 mongosh 的功能子集，题面操作
 * （use / db.xxx / show users 等）完全兼容。只在首词命中【实测禁令】时替换，
 * heredoc 正文与其余命令不动。
 */
const COMMAND_ALIASES = { mongosh: 'mongo' };

/** 从输入期报错行提取 command not found 的命令名（仅收干净词法名，滤掉大表达式碎片） */
function extractMissingCommands(termErrors) {
  const out = new Set();
  for (const te of termErrors ?? []) {
    for (const line of te.errs ?? []) {
      const m = line.match(/(\S+):\s*command not found/);
      if (m && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(m[1])) out.add(m[1]);
    }
  }
  return [...out];
}

/** 跨轮禁令：反思每轮独立无记忆，实测事实必须写进 prompt 才能跨轮生效 */
function banNote(banned) {
  return banned.size
    ? `\n【实测禁令】以下命令在本机不存在（terminal 实测 command not found），本轮严禁再输出，涉及同类操作时改用实测可用的等价客户端：${[...banned].join('、')}`
    : '';
}

/**
 * 客户端可用性实测（cmdline 与 mixed 分支共用）。
 * bash 环境且题干涉及数据库时才探测：实测结论注入 prompt（clientFact），
 * 缺失客户端即刻入禁令（bannedCmds），供执行层别名替换与下一轮生成使用。
 * @returns {Promise<{clientFact: string, have: string[], miss: string[]}>}
 *   clientFact 为注入 prompt 的中文结论；未触发探测或探测无结论时为空串
 */
async function probeDbClients(page, envGen, problem, bannedCmds) {
  if (envGen.kind === 'bash' && NEEDS_DB.test(problem)) {
    const probe = await probeTerminalClients(page);
    if (probe.fact) {
      for (const c of probe.miss) bannedCmds.add(c);
      log(
        `客户端探测：${probe.have.length ? `可用 ${probe.have.join('、')}` : '全部不可用'}${probe.miss.length ? `｜不存在 ${probe.miss.join('、')}` : ''}`,
      );
      return { clientFact: probe.fact, have: probe.have, miss: probe.miss };
    }
    // 静默失败必须显性化（2026-09-10 真机：探测无结论时无日志，无法诊断）
    log('客户端探测未取得结论（终端回显未捕获 HAVE/MISS 行）');
  }
  return { clientFact: '', have: [], miss: [] };
}

/**
 * 执行层兜底（cmdline 与 mixed 分支共用）：
 * ① 首词命中实测禁令且别名表有等价客户端时确定性替换（"劝"不动就"改"）；
 * ② shell 护栏清洗（中文标签行/全角分号），清洗说明留档供反思。
 * @param {string[]} cmds 生成的命令
 * @param {Set<string>} bannedCmds 实测不存在的命令集
 * @returns {{cmds: string[], sanitizeNote: string}} sanitizeNote 为空串表示未清洗
 */
function applyCommandGuards(cmds, bannedCmds) {
  const replaced = cmds.map((c, i) => {
    const m = c.match(/^(\S+)([\s\S]*)$/);
    const alias = m && bannedCmds.has(m[1]) ? COMMAND_ALIASES[m[1]] : null;
    if (!alias) return c;
    log(`执行层替换：命令 ${i + 1} 首词 ${m[1]}（实测不存在）→ ${alias}`);
    return alias + m[2];
  });
  const changes = [];
  const cleaned = replaced.map((c) => {
    const s = sanitizeShellSubmission(c);
    if (s.changes.length) changes.push(...s.changes);
    return s.code;
  });
  if (changes.length) {
    log(`shell 护栏清洗 ${changes.length} 处：${changes.slice(0, 3).join('；')}`);
  }
  return { cmds: cleaned, sanitizeNote: changes.map((n) => `- ${n}`).join('\n') };
}

/** 把输入期报错结构化为反思材料文本（命令号 + 回现行） */
function formatInputErrors(termErrors) {
  return (termErrors ?? [])
    .map((e) => `命令 ${e.no}: ${e.cmd}\n${e.errs.map((l) => `  ${l}`).join('\n')}`)
    .join('\n');
}

/**
 * 反思用瘦身题干（0.9.1 双锚点扩窗）：以「编程要求」与「测试说明」两段为锚，
 * 覆盖要求明细 + 评测机制说明（约 2600 字窗口）。
 * 教训（2026-09-10 真机）：旧版单锚 ±窗口只有 ~1500 字，本题的「测试说明」
 * （"平台会把你在代码行编写的命令传到数据库执行"）落在窗口外——反思 AI
 * 不懂评测机制，把预期输出面板的中文标签当成了输出要求，酿成灾难性修正。
 */
function slimForReflection(p) {
  const anchors = ['编程要求', '测试说明'];
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  for (const a of anchors) {
    const i = p.indexOf(a);
    if (i !== -1) {
      start = Math.min(start, i);
      end = Math.max(end, i);
    }
  }
  if (start === Number.POSITIVE_INFINITY) return p.slice(0, 3000);
  return p.slice(Math.max(0, start - 400), Math.min(p.length, end + 1600));
}

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
    if (v.passed) {
      // 通过收尾：关闭庆祝弹窗（如有），返回等待用户操作
      await dismissPassModal(page);
    }
    return { ok: v.passed, kind, verdict: v, evalText: ev };
  }

  // ---- 代码题 / 命令行题：先读题干判意图，再分流到对应工作区 ----
  // 判定依据是题干要求本身（AI 意图路由），而非当前激活的 tab；
  // 判定后若工作区 tab 不符则自动切换（命令行 / 代码文件）。
  const intent = await classifyProblemIntent({ problem, codeTemplate: probe.code ?? '' });
  log(
    `题干意图判定：${intent === 'cmdline' ? '命令行操作（cmdline）' : intent === 'mixed' ? '命令行准备 + 代码栏作答（mixed）' : '代码编写（code）'}`,
  );

  // 分支逃生舱状态：命令行多轮跑通仍评测不匹配 → 疑似路由误判，转代码分支
  let cmdlineFallback = false;
  let cmdlineEvalText = '';
  // 客户端可用性实测结论（函数级）：mixed 分支数据准备阶段探测一次，落代码
  // 分支后注入生成/反思 prompt——代码栏数据库命令题要用实测可用的客户端
  //（本机只有 mongo 没有 mongosh 这类硬事实），并支撑 heredoc 守则落地
  let clientFact = '';

  // ---- 混合题（0.9.1）：题干同时要求"命令行操作 + 代码栏编写"（如先在
  // 命令行插入文档、再在 Begin-End 写查询）。旧版二选一路由在此二难：
  // 判 code 则数据准备缺失（查询无结果），判 cmdline 则查询写进终端而
  // 评测只认代码栏。处置：先在命令行完成数据准备（至多两轮、含输入期
  // 报错反思自愈），再落入代码分支常规作答；终端不可用则警告跳过。
  if (intent === 'mixed') {
    const tab = await switchTaskTab(page, '命令行');
    if (tab.found && tab.clicked) await settle(page);
    if (await waitForTerminal(page)) {
      const envGen = await detectTerminalEnv(page);
      log(`终端环境识别：${envGen.kind}${envGen.db ? `（当前库 ${envGen.db}）` : ''}`);
      // 与 cmdline 分支同装备：客户端实测（mongosh 是否存在这类硬事实）+ 禁令。
      // 真机事故（2026-09-10）：旧版此处裸调 generateCommands，AI 在无事实依据下
      // 输出不存在的 mongosh，后续 use/db.xxx 子命令被逐条敲进 bash 全部报错，
      // 插入文档失败且无任何重试。
      const bannedCmds = new Set();
      clientFact = (await probeDbClients(page, envGen, problem, bannedCmds)).clientFact;
      const PREP_EXTRA =
        '本次只输出题干中「命令行操作部分」的数据准备命令（如 use 库、插入文档）。' +
        '题干要求写在右侧代码栏 Begin-End 中的查询/程序命令严禁包含在这里——那部分另行处理，平台评测只认代码栏内容。';
      let prep = await generateCommands({
        problem,
        extra: PREP_EXTRA,
        terminalState: `${envGen.desc}${clientFact ? `\n${clientFact}` : ''}${banNote(bannedCmds)}`,
      });
      if (prep.length) {
        // 数据准备最多两轮：第一轮若输入期报错（入口命令不存在、子命令被敲进
        // bash 等），反思一轮自愈后重做，避免"插入失败 → 代码查询空结果"连锁失败
        for (let p = 1; p <= 2 && prep.length; p++) {
          const guarded = applyCommandGuards(prep, bannedCmds);
          log(`混合题前置：向终端键入 ${guarded.cmds.length} 条数据准备命令（第 ${p} 轮）`);
          const r = await runTerminalCommands(page, guarded.cmds);
          if (r.executed) await settle(page);
          const inputErrors = formatInputErrors(r.termErrors);
          if (!inputErrors) break;
          log(
            `混合题前置数据准备第 ${p} 轮输入期报错${p === 1 ? '，反思自愈后重试' : '，两轮用尽按当前状态继续'}：\n${inputErrors}`,
          );
          if (p === 2) break;
          for (const c of extractMissingCommands(r.termErrors)) bannedCmds.add(c);
          const envNow = await detectTerminalEnv(page);
          const termEcho = await readTerminalText(page);
          const fixed = await reflectCommands({
            problem: slimForReflection(problem),
            previousCommands: guarded.cmds,
            evalResult:
              `（数据准备命令在终端执行阶段报错，尚未进入平台评测；平台只评测右侧代码栏内容，必须先把这些数据准备命令修对再继续。）\n\n` +
              `=== 输入期报错 ===\n${inputErrors}${termEcho ? `\n\n=== 终端回显 ===\n…${termEcho.slice(-1500)}` : ''}`,
            terminalState: `${envNow.desc}${clientFact ? `\n${clientFact}` : ''}${banNote(bannedCmds)}`,
          });
          if (!fixed.commands?.length) break;
          prep = fixed.commands;
        }
      } else {
        log('混合题前置：命令行数据准备生成结果为空，跳过，直接代码栏作答');
      }
    } else {
      log(
        '混合题前置：终端未出现，跳过命令行准备（评测环境共享终端数据库，未插入数据时代码栏查询结果为空）',
      );
    }
    // 不 return，落入下方代码分支
  }

  if (intent === 'cmdline') {
    const tab = await switchTaskTab(page, '命令行');
    if (tab.found && tab.clicked) await settle(page);
    if (!(await waitForTerminal(page))) {
      log('命令行终端未在超时内出现，终止本题（可 npm run dump 检查页面）');
      return { ok: false, kind: 'cmdline', reason: 'no-terminal' };
    }

    let cmds = null;
    let lastEval = '';
    let sanitizeNote = ''; // shell 护栏清洗记录（喂给反思，供其理解上一轮实际提交内容）
    const bannedCmds = new Set(); // 本题内累积的 command not found 命令（跨反思轮生效）
    let clientFact = ''; // 客户端可用性实测结论（bash 环境下探测一次）
    const lessons = []; // 各轮反思的诊断结论（Reflexion 式教训链，跨轮注入）
    let roundsCleanRun = 0; // 命令全部跑通（无输入期报错）的轮数——逃生舱判据
    for (let attempt = 1; attempt <= cfg.loop.maxRetry; attempt++) {
      if (cmds === null) {
        // 生成期间无中间日志可打，必须提前预告静默期，否则推理模型
        // 的思考+生成会被用户当成"卡死/不作答"。日志格式四处 AI 调用统一。
        log(
          `正在调用 AI 生成命令（第 ${attempt} 次）…${cfg.ai.thinkingCapMs > 0 ? `思考超 ${Math.round(cfg.ai.thinkingCapMs / 1000)}s 未出正文将自动截断重试` : '推理模型可能需要 1~3 分钟'}`,
        );
        const t0 = Date.now();
        // 环境感知：生成前先探测终端当前 shell（bash / mongosh / …），
        // 把事实与该环境的书写约束注入 prompt，防止 AI 搞错环境
        const envGen = await detectTerminalEnv(page);
        log(`终端环境识别：${envGen.kind}${envGen.db ? `（当前库 ${envGen.db}）` : ''}`);
        // 客户端实测：bash 环境且题干涉及数据库时，实测本机有哪些客户端
        //（mongosh 不存在只有 mongo 这类事实，靠实测不靠模型记忆）
        if (!clientFact) {
          const pr = await probeDbClients(page, envGen, problem, bannedCmds);
          clientFact = pr.clientFact;
        }
        cmds = await generateCommands({
          problem,
          terminalState: `${envGen.desc}${clientFact ? `\n${clientFact}` : ''}${banNote(bannedCmds)}`,
        });
        log(
          `AI 生成命令完成（第 ${attempt} 次，${cmds.length} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：${cmds
            .slice(0, 4)
            .join(' ; ')
            .slice(0, 140)}`,
        );
        if (!cmds.length) {
          log('生成命令为空，终止本题');
          return { ok: false, kind: 'cmdline', reason: 'empty-commands' };
        }
      }

      // 执行层兜底（0.9.1 真机：模型无视【实测禁令】仍逐轮输出 mongosh）+ shell 护栏
      // 清洗（中文标签行/全角分号）。生成与反思产出的命令都经过这一处，
      // 替换/清洗后输入期报错检测照常生效。
      const guarded = applyCommandGuards(cmds, bannedCmds);
      cmds = guarded.cmds;
      sanitizeNote = guarded.sanitizeNote;

      const r = await runTerminalCommands(page, cmds);
      if (!r.executed) {
        log('终端键入失败，终止本题');
        return { ok: false, kind: 'cmdline', reason: r.reason ?? 'terminal-input-failed' };
      }
      // 输入期 command not found → 跨轮禁令（AI 每轮独立调用，事实要有记忆）
      const missing = extractMissingCommands(r.termErrors);
      if (missing.length) {
        for (const c of missing) bannedCmds.add(c);
        log(`实测不存在的命令（已加入禁令）：${missing.join('、')}`);
      } else {
        roundsCleanRun++;
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
        // v0.7.0：评测后平台可能跳转到全屏「实际输出」结果页——先抓证据、
        // 返回题目页，再继续后续反思（此前需用户手动返回）
        const nav = await ensureTaskPage(page);
        if (nav.navigated) page = nav.page;
        if (nav.evidence) {
          lastEval = `${lastEval || ''}\n\n=== 评测结果页 ===\n${nav.evidence}`;
        }
        // 失败差异增强：展开「测试集N」折叠块抓预期/实际明细喂给反思。
        // 没有差异证据的反思等于盲改（页面无该结构时返回空串，零影响）。
        const detail = await collectTestSetDetails(page);
        if (detail) {
          lastEval = `${lastEval || '（面板文本未捕获，以下为折叠块明细）'}\n\n=== 测试集明细 ===\n${detail}`;
        }
        // 输入期报错优先呈现（键入/执行即报错的命令与回现行，键入时逐条检测）
        const inputErrors = formatInputErrors(r.termErrors);
        if (inputErrors) {
          lastEval = `${lastEval || '（评测输出未捕获，以下为输入期报错）'}\n\n=== 输入期报错 ===\n${inputErrors}`;
        }
        // 终端回显在反思时点抓取（而非键入后立刻抓）：sleep/服务启动/连接
        // 超时类命令的报错可能在键入完成后数秒才陆续输出，评测等待期间
        // 终端持续滚动，此时抓取 = 本轮全部显示内容，而非只有输入的命令
        //（2026-09-09 用户明确要求）
        const termEcho = await readTerminalText(page);
        if (termEcho) {
          lastEval = `${lastEval || '（评测输出未捕获，以下为终端回显）'}\n\n=== 终端回显（本轮全部显示内容） ===\n…${termEcho.slice(-2000)}`;
        }
      }
      if (v.passed) {
        // 通过收尾：关闭庆祝弹窗（如有），返回等待用户操作
        await dismissPassModal(page);
        return { ok: true, kind: 'cmdline', attempts: attempt, verdict: v, commands: cmds };
      }
      if (attempt === cfg.loop.maxRetry) break;

      log(
        `正在调用 AI 命令反思（第 ${attempt} 次）…${cfg.ai.thinkingCapMs > 0 ? `思考超 ${Math.round(cfg.ai.thinkingCapMs / 1000)}s 未出正文将自动截断重试` : '推理模型可能需要 1~3 分钟'}`,
      );
      const rt0 = Date.now();
      // 环境感知：反思前重新探测——上一轮序列执行完终端可能已在某个 REPL
      // 内部，重出的命令必须从这个真实状态出发（不重复进入、不混写语法）
      const envNow = await detectTerminalEnv(page);
      log(`终端环境识别：${envNow.kind}${envNow.db ? `（当前库 ${envNow.db}）` : ''}`);
      const fixed = await reflectCommands({
        problem: slimForReflection(problem),
        previousCommands: cmds,
        evalResult: `${lastEval || '（未捕获到评测输出，请对照任务要求自查命令）'}${sanitizeNote ? `\n\n=== 提交前自动清洗记录（已生效于上一轮实际执行的命令） ===\n${sanitizeNote}` : ''}`,
        terminalState: `${envNow.desc}${clientFact ? `\n${clientFact}` : ''}${banNote(bannedCmds)}`,
        lessons: lessons.slice(-6),
      });
      log(`AI 命令反思完成（第 ${attempt} 次，耗时 ${((Date.now() - rt0) / 1000).toFixed(1)}s）`);
      if (fixed.analysis) {
        // 全量打印（0.9.1）：旧版 slice(0,160) 把诊断拦腰截断，用户看到的
        // 是"说到一半的反思"，无法判断 AI 是真没想全还是没显示全——
        // 分析本身已被 prompt 约束为一句话，全量打印成本可忽略
        log(`反思分析：${String(fixed.analysis).replace(/\s+/g, ' ')}`);
        // 诊断沉淀进教训链：反思每轮独立无记忆，把上一轮确诊的原因带进下一轮，
        // 防止"第 N 轮改对了、第 N+1 轮又退回"的摇摆（真机实证：mongo↔mongosh）
        lessons.push(String(fixed.analysis));
      }
      if (!fixed.commands?.length) {
        log('反思未产出命令，终止本题');
        break;
      }
      cmds = fixed.commands;
    }
    // 分支逃生舱（2026-09-10 用户实证）：本题题干要求在代码模块中编写
    // MongoDB 脚本，意图路由误判 cmdline，命令跑通但评测始终不匹配。
    // 误判特征：≥2 轮命令全部跑通（无输入期报错）而评测轮轮失败。
    // 命中即转代码分支重做，而不是按命令行题失败收场。
    if (roundsCleanRun < 2) {
      return { ok: false, kind: 'cmdline', evalText: lastEval };
    }
    cmdlineFallback = true;
    cmdlineEvalText = lastEval;
    log('命令行多轮跑通仍评测不匹配——疑似实际要求代码模块作答，转代码分支');
  }

  // ---- 代码题：确保「代码文件」工作区激活后，生成 → 评测 → 反思循环 ----
  const tab = await switchTaskTab(page, '代码文件');
  if (tab.found && tab.clicked) await settle(page);
  if (!(await waitForEditor(page))) {
    log('代码编辑器未在超时内出现，终止本题');
    return { ok: false, kind: 'code', reason: 'no-editor' };
  }
  const codeProbe = await probePage(page); // 切 tab 后重新探测，拿最新模板

  // 逃生舱防呆：转代码分支后发现编辑器模板为空 → 该题本来就没有代码文件可写，
  // 转过去只会凭空生成，按命令行题失败收场（模板非空才继续）
  if (cmdlineFallback && !(codeProbe.code ?? '').trim()) {
    log('代码文件模板为空，转代码分支无意义，终止本题');
    return { ok: false, kind: 'cmdline', evalText: cmdlineEvalText };
  }

  let code = null;
  let lastEval = '';
  let sanitizeNote = ''; // shell 护栏清洗记录（喂给反思，供其理解上一轮实际提交内容）

  for (let attempt = 1; attempt <= cfg.loop.maxRetry; attempt++) {
    if (code === null) {
      // 同命令行分支：预告静默期 + 统计耗时，消除"切完 tab 就没动静"的观感
      log(
        `正在调用 AI 生成代码（第 ${attempt} 次）…${cfg.ai.thinkingCapMs > 0 ? `思考超 ${Math.round(cfg.ai.thinkingCapMs / 1000)}s 未出正文将自动截断重试` : '推理模型可能需要 1~3 分钟'}`,
      );
      const t0 = Date.now();
      code = await generateCode({
        problem,
        codeTemplate: codeProbe.code ?? '',
        // 注入客户端实测事实（mixed 题：本机有 mongo 没 mongosh 等），
        // 支撑生成守则第 7 条 heredoc 形态选对客户端
        extra: clientFact ? `\n${clientFact}` : '',
      });
      log(
        `AI 生成代码完成（第 ${attempt} 次，${code.length} 字符，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
      );
    } else {
      log(`第 ${attempt} 次尝试（沿用反思后的代码，${code.length} 字符）`);
    }

    if (!code || !code.trim()) {
      log('生成代码为空，终止本题');
      return { ok: false, kind: 'code', reason: 'empty-code' };
    }

    // 实际提交评测的是"模板拼接后"的版本；反思必须带上它而不是 AI 原始
    // 输出，否则 AI 审的是一份没提交过的文本（2026-09-09 用户指出）
    let submitted = spliceIntoTemplate(codeProbe.code, code);
    // shell 书写护栏（0.9.1）：数据库脚本题（模板含 db. 调用）中，AI 偶发把
    // 中文标签拼在命令前（"输出集合前3条文档: db.educoder…"）——送进 shell
    // eval 必报 SyntaxError: illegal character。写入前确定性清洗：
    // 剥标签留命令 / 剔除裸中文行 / 全角分号转半角；普通编程题零触发。
    const san = sanitizeShellSubmission(submitted);
    if (san.changes.length) {
      submitted = san.code;
      sanitizeNote = san.changes.map((n) => `- ${n}`).join('\n');
      log(`shell 护栏清洗 ${san.changes.length} 处：${san.changes.slice(0, 3).join('；')}`);
    }
    // 数据库命令题 echo 双引号包裹兜底（1.0.1）：平台对代码栏双重执行（bash 环节 +
    // 提取 echo 引号内内容做数据库 eval），AI 即使被守则要求仍可能输出裸命令 →
    // bash 报错污染实际输出。这里确定性包裹（幂等：已包裹/普通编程题零触发）。
    const wrap = wrapDbCommandsInEcho(submitted);
    if (wrap.wrapped) {
      submitted = wrap.code;
      log('数据库命令题 echo 双引号包裹兜底（bash 环节零噪音，平台提取引号内命令 eval）');
    }
    await writeEditorCode(page, submitted);
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
      // v0.7.0：评测后平台可能跳转到全屏结果页——抓证据、返回题目页再反思
      const nav = await ensureTaskPage(page);
      if (nav.navigated) page = nav.page;
      if (nav.evidence) {
        lastEval = `${lastEval || ''}\n\n=== 评测结果页 ===\n${nav.evidence}`;
      }
      // 同命令行分支：失败时先抓「测试集N」预期/实际差异明细再反思
      const detail = await collectTestSetDetails(page);
      if (detail) {
        lastEval = `${lastEval || '（面板文本未捕获，以下为折叠块明细）'}\n\n=== 测试集明细 ===\n${detail}`;
      }
    }

    if (v.passed) {
      // 通过收尾：关闭庆祝弹窗（如有），返回等待用户操作
      await dismissPassModal(page);
      return { ok: true, kind: 'code', attempts: attempt, verdict: v, code };
    }

    if (attempt === cfg.loop.maxRetry) break;

    log(
      `正在调用 AI 代码反思（第 ${attempt} 次）…${cfg.ai.thinkingCapMs > 0 ? `思考超 ${Math.round(cfg.ai.thinkingCapMs / 1000)}s 未出正文将自动截断重试` : '推理模型可能需要 1~3 分钟'}`,
    );
    const rt0 = Date.now();
    const fixed = await reflectAndFix({
      problem: slimForReflection(problem),
      // 反思看的是实际提交评测的代码（模板拼接后、经护栏清洗、写入验证的版本）
      previousCode: submitted,
      evalResult: `${lastEval || '（未捕获到评测输出，请根据题目要求重新审视实现）'}${sanitizeNote ? `\n\n=== 提交前自动清洗记录（已生效于上一轮实际提交的代码） ===\n${sanitizeNote}` : ''}`,
      // 注入客户端实测事实：反思守则第 4 条按它选 heredoc 的客户端名
      terminalState: clientFact,
    });
    log(`AI 代码反思完成（第 ${attempt} 次，耗时 ${((Date.now() - rt0) / 1000).toFixed(1)}s）`);
    if (fixed.analysis) {
      // 全量打印（0.9.1）：旧版 slice(0,160) 把诊断拦腰截断（见图 1 事故：
      // "根据"SyntaxError: missing…"源" 戛然而止），用户无法判断是真截断
      // 还是 AI 没想全。分析被 prompt 约束 3 句话内，全量打印成本可忽略
      log(`反思分析：${String(fixed.analysis).replace(/\s+/g, ' ')}`);
    }
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
    page
      .evaluate(() => {
        window.__liteHandled = true;
      })
      .catch(() => {});

  const isFresh = (page) => page.evaluate(() => !window.__liteHandled).catch(() => false);

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
              log(
                '  页面上没有任何含「开始学习」的候选节点（列表可能在 shadow DOM/特殊容器/iframe 中）',
              );
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

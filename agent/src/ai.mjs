// EXPORTS: chat, readCapability, renderTemplate, buildPlatformFactsBlock,
//          generateCode, reflectAndFix, answerQuestion, parseAnswers, answerBatch,
//          classifyProblemIntent, generateCommands, reflectCommands, parseCommandLines,
//          detectVerdict, listChatModels, extractCodeFromMarkdown, splitAnalysisAndCode,
//          spliceIntoTemplate, emptyMarkerBlocks, stripNonCodeLines, findSquashedHeredocs,
//          findDataFileOverwrites, sanitizeShellSubmission, wrapDbCommandsInEcho,
//          wrapBareDbStatementsForShell, submissionBody, statementPrescribesQuoteForm,
//          looksLikeDbScript, splitStatements, stripDestructiveDbStatements,
//          parseImportTarget, parseDeclaredCommandCount, detectSubmissionFormViolations,
//          detectQuoteFormViolation, detectDbCollectionRefViolation, detectEscapeViolation,
//          detectCommandCountViolation, detectShellInvocationViolation
// AI 调用层。
// 设计要点：
//   1. prompt 单一数据源 —— 直接读取仓库根 shared/capabilities/*.json 中的 prompt 模板，
//      不做复制粘贴，避免 prompt 多份漂移。
//   2. 成功判定在此做了加固（见 detectVerdict 注释），比朴素关键词
//      匹配更保守，避免 "未通过" 命中 "通过" 这类误判。

import fs from 'node:fs';
import path from 'node:path';
import { cfg, assertAiReady } from './config.mjs';
import { createLogger } from './logger.mjs';
import { checkStop, isStopping, onStop, StopRequested } from './control.mjs';
import { assertCapabilitiesValid } from './capability-schema.mjs';

const CAP_DIR = cfg.paths.capabilitiesDir;

// 全量预检只跑一次：任一能力 JSON 损坏/占位符拼写错误，在首次用到能力时即整体报出，
// 而不是等渲染出残缺 prompt 后静默失败（见 capability-schema.mjs 头注）。
let capabilitiesChecked = false;

/**
 * 平台事实档案（`shared/platform-facts.json`）→ 注入每个能力 prompt 末尾。
 *
 * 背景（2026-09-20 真机，同一类根因连续两题复发）：平台运行环境显著落后于官方文档
 * （Python 2 + 旧版 redis-py：`zadd` 是「先成员后分值」、不支持字典写法、`open()` 无
 * `encoding=`），而这类"事实"此前只能散落在各条 prompt 规则里——**新增场景就要改多处、
 * 且必然漏**（本次就漏在生成端）。现收敛为单一数据源 + 统一注入：
 * 「没有哪个能力会忘记平台事实，新增事实只改那一处」。
 *
 * 取舍：**不缓存**，每次调用重读磁盘——与 readCapability 一致，保证手改事实文件即刻生效
 *（本项目的既定风格：prompt/事实都是热生效）。文件缺失或损坏时降级为空串并告警一次，
 * 不阻断主流程（事实是增强信息，不是运行必需）。
 * @returns {string} 事实块（含标题）；读取失败返回空串
 */
let factsWarned = false;
let factsLogged = false;
export function buildPlatformFactsBlock() {
  const file = cfg.paths.platformFactsFile;
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    // `_readme` 是给维护者的填写规则，对模型是纯噪音——注入前剥掉（文件本身不动）
    delete obj._readme;
    const body = JSON.stringify(obj, null, 2);
    if (!factsLogged) {
      factsLogged = true;
      log(
        `已加载平台事实档案 ${path.basename(file)}（${body.length} 字符），将注入所有能力 prompt`,
      );
    }
    return (
      '### 平台事实（本平台**实测**结论，优先于任何官方文档与你的既有记忆；' +
      '涉及接口形态 / 语法 / 运行环境 / 输出格式 / 数据格式时一律以此为准）\n' +
      body
    );
  } catch (e) {
    if (!factsWarned) {
      factsWarned = true;
      log.warn(`平台事实档案读取失败（${file}）：${e.message} —— 本次不注入该段`);
    }
    return '';
  }
}

export function readCapability(id) {
  if (!capabilitiesChecked) {
    assertCapabilitiesValid(CAP_DIR);
    capabilitiesChecked = true;
  }
  const p = path.join(CAP_DIR, `${id}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`找不到能力配置文件：${p}`);
  }
  const cap = JSON.parse(fs.readFileSync(p, 'utf8'));
  // 统一注入平台事实（见 buildPlatformFactsBlock 头注）：单一注入点，能力新增不会漏
  const facts = buildPlatformFactsBlock();
  if (facts && cap?.formValue?.prompt) {
    cap.formValue.prompt = `${cap.formValue.prompt}\n\n${facts}`;
  }
  return cap;
}

/** 渲染 {{input.xxx}} 占位符；缺失变量渲染为空串（与原平台行为一致） */
export function renderTemplate(tpl, vars = {}) {
  return String(tpl ?? '').replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key]),
  );
}

const log = createLogger('ai');

/** OpenAI 兼容 chat/completions：SSE 流式接收（思考/正文进度实时可见），带指数退避重试 */
export async function chat(messages, opts = {}) {
  assertAiReady();
  const url = `${cfg.ai.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: opts.model ?? cfg.ai.model,
    messages,
    temperature: opts.temperature ?? cfg.ai.temperature,
    max_tokens: opts.maxTokens ?? cfg.ai.maxTokens,
    stream: true,
  };
  // 推理分级（v0.8.1 探测实证，真机数据）：全关 → 多步任务漏要求；
  // 默认档 → 思考马拉松 74955 字击穿预算；medium → 思考 1612 字有界且
  // 命令覆盖全部要求。AI_REASONING_EFFORT 可调 low/medium/high；
  // AI_ENABLE_THINKING=0 全关（极简场景）。
  // 思考硬闸 AI_THINKING_CAP_MS（默认 20s，0=不设限）：流式响应中"仍在
  // 思考、正文 0 字"持续超限即主动断流，重试强制关思考——端点忽略思考
  // 开关时的最后防线（2026-09-10 反思思考 2.5 万字击穿预算事故）。
  // 注意：整体 JSON 兜底路径（非流式端点）无法中途拦截，硬闸仅对流式生效。
  const effort = opts.reasoningEffort ?? cfg.ai.reasoningEffort;
  const capMs = cfg.ai.thinkingCapMs;
  const thinkMaxChars = cfg.ai.thinkingMaxChars; // 思考字数配额（0=禁用）
  let forceThinkingOff = false; // 上一轮思考超限 → 重试强制关思考

  const maxAttempts = opts.maxAttempts ?? 2;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    // 手动停止检查点：已请求停止时不再发起新的请求（也不做退避重试）
    checkStop('调用 AI');
    // 思考开关按轮次计算：调用级/全局关闭，或上一轮思考超限时强制关闭。
    // 关思考双通道同发：chat_template_kwargs（vLLM/SGLang 系）+ 顶层
    // enable_thinking（DashScope/硅基流动系），端点认哪个用哪个，
    // 不认的键按约定忽略；两种都无效时由思考硬闸兜底截断。
    const thinkingOn = (opts.enableThinking ?? cfg.ai.enableThinking) && !forceThinkingOff;
    if (!thinkingOn) {
      body.chat_template_kwargs = { enable_thinking: false };
      body.enable_thinking = false;
      delete body.reasoning_effort;
    } else if (effort) {
      body.reasoning_effort = effort;
    }
    const t0 = Date.now();
    const stallMs = cfg.ai.thinkingStallMs;
    let content = '';
    let reasoning = '';
    let finish = '';
    let capped = false; // 本次轮次是否因思考超限（时间硬闸）被主动断流
    let stalled = false; // 本次轮次是否因思考停滞（无进展空转）被主动断流
    let thinkExceeded = false; // 本次轮次是否因思考超字数配额被主动断流
    let prevReasoningLen = 0;
    let lastGrowTs = Date.now(); // 思考长度最后一次增长的时刻（停滞检测用）
    // 空闲超时 + 心跳：每收到一块数据就重置空闲计时——"有输出就不断流"，
    // 端点挂起/断流才触发超时（AbortSignal.timeout 是绝对超时，会误杀长生成）；
    // 心跳每 30s 汇报已接收的思考/正文量与最新思考尾部，长思考全程可见
    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(), cfg.ai.timeoutMs);
    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(), cfg.ai.timeoutMs);
    };
    const hb = setInterval(() => {
      log(
        `AI 流式响应中（第 ${i + 1}/${maxAttempts} 轮，已 ${Math.round((Date.now() - t0) / 1000)}s）｜思考 ${reasoning.length} 字、正文 ${content.length} 字${reasoning ? '｜…' + reasoning.slice(-60).replace(/\s+/g, ' ') : ''}`,
      );
    }, 30000);
    // 手动停止联动（1.4.0）：工作台点「停止做题」即 abort 在途流——
    // 推理模型的思考常达 60~120s，等它自然结束再停等于没停
    const offStop = onStop(() => ac.abort());
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.ai.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 防御：部分端点对超过模型单次输出上限的 max_tokens 会直接报 400
        //（vLLM 系常见）。命中特征时把预算降到保守值 16384，让下一次重试
        // 立即生效（16384 为实测端点接受的档位；不能降到更小否则思考又挤没正文）
        if (
          res.status === 400 &&
          body.max_tokens > 16384 &&
          /(max_tokens|max_output_tokens|max_model_len|context)/i.test(text)
        ) {
          body.max_tokens = 16384;
        }
        throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      // 兼容兜底：个别端点无视 stream:true 一次性回整体 JSON——走原解析
      const ctype = res.headers.get('content-type') ?? '';
      if (!ctype.includes('event-stream')) {
        const j = await res.json().catch(() => ({}));
        const msg = j?.choices?.[0]?.message ?? {};
        content = typeof msg.content === 'string' ? msg.content : '';
        reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
        finish = j?.choices?.[0]?.finish_reason ?? '';
      } else {
        // SSE 解析：逐行取 data: 载荷，累计 delta 的思考与正文
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let j;
            try {
              j = JSON.parse(payload);
            } catch {
              continue;
            }
            const d = j?.choices?.[0]?.delta ?? {};
            if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
            if (typeof d.content === 'string') content += d.content;
            if (j?.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
            bumpIdle();
            // 思考停滞检测（2026-09-15）：思考长度有增长即视为有进展，持续重新计时；
            // 正文 0 字且思考连续 stallMs 无增长 → 空转/卡死（如对题干信号矛盾反复
            // "重新审视"），提前断流重试（强制关思考）。只掐"无进展"，正常深思考
            // 的思考会持续增长，不受影响。
            if (reasoning.length > prevReasoningLen) {
              prevReasoningLen = reasoning.length;
              lastGrowTs = Date.now();
            }
            if (stallMs > 0 && !content && reasoning && Date.now() - lastGrowTs > stallMs) {
              stalled = true;
              ac.abort();
            }
            // 思考字数配额（2026-09-15）：正文 0 字、思考累计超 thinkMaxChars →
            // 判定"喂不饱的无限思考"（端点 max_tokens 是思考+正文共享预算，弱推理
            // 模型会一直想到烧光 length），提前断流、重试强制关思考保底出正文
            if (thinkMaxChars > 0 && !content && reasoning.length > thinkMaxChars) {
              thinkExceeded = true;
              ac.abort();
            }
            // 思考硬闸：只在"还在思考、正文零字"阶段计时；正文一旦开流
            // 就不再限制（避免误杀正常生成长度）
            if (capMs > 0 && !content && reasoning && Date.now() - t0 > capMs) {
              capped = true;
              ac.abort();
            }
          }
        }
      }
      // 空正文必须视为失败：finish_reason=length 且思考有内容 = 预算被思考
      // 耗尽（确定性失败，重试无效——但必须强制关思考再试：预算被思考吃光
      // 时空正文=思考过度而非模型瘫痪，关思考重试能快速出正文）
      if (!content.trim()) {
        if (finish === 'length') forceThinkingOff = true;
        const hint =
          finish === 'length'
            ? `finish_reason=length：max_tokens=${body.max_tokens} 预算耗尽（思考 ${reasoning.length} 字），重试将强制关思考｜思考尾部：${reasoning.slice(-120).replace(/\s+/g, ' ')}`
            : '流式响应结束但无正文内容';
        throw new Error(`AI 返回内容为空（${hint}）`);
      }
      return {
        content,
        raw: { finish_reason: finish, reasoning_length: reasoning.length },
      };
    } catch (err) {
      // 手动停止优先级最高：abort 抛出的同样是 AbortError，若不先判会
      // 被下面的"空闲超时"分支误描述成端点挂起，并进入 800ms 退避后重试
      if (isStopping()) {
        throw new StopRequested(`AI 调用已中断（手动停止，已累计思考 ${reasoning.length} 字）`);
      }
      if (thinkExceeded) {
        forceThinkingOff = true;
        err = new Error(
          `思考超配额：正文 0 字且思考已 ${reasoning.length} 字（上限 ${thinkMaxChars}），弱推理模型无限思考风险，已主动断流；重试将强制关思考（AI_THINKING_MAX_CHARS 可调，0=关闭配额）`,
        );
      } else if (stalled) {
        forceThinkingOff = true;
        err = new Error(
          `思考停滞：正文 0 字且思考 ${stallMs / 1000}s 无增长（思考已 ${reasoning.length} 字），疑似空转循环，已主动断流；重试将强制关思考（AI_THINKING_STALL_MS 可调，0=关闭停滞检测）`,
        );
      } else if (capped) {
        forceThinkingOff = true;
        err = new Error(
          `思考超限：${Math.round(capMs / 1000)}s 内正文仍为 0 字（思考已 ${reasoning.length} 字），已主动断流；重试将强制关思考（AI_THINKING_CAP_MS 可调，0=关闭硬闸）`,
        );
      } else if (err?.name === 'AbortError') {
        err = new Error(
          `AI 响应空闲超时（${cfg.ai.timeoutMs}ms 无任何数据）：端点可能挂起，可用 AI_TIMEOUT_MS 调大`,
        );
      }
      lastErr = err;
      if (i < maxAttempts - 1) {
        // 失败原因必须当场可见，否则重试表现为"莫名其妙又开了一轮"
        //（空正文的 err.message 已含 finish_reason 与思考尾部，足够定位）
        log(`第 ${i + 1}/${maxAttempts} 轮失败：${err.message}`);
        await new Promise((r) => setTimeout(r, 800 * 2 ** i));
      }
    } finally {
      offStop();
      clearTimeout(idle);
      clearInterval(hb);
    }
  }
  throw new Error(`AI 调用失败（已重试 ${maxAttempts} 次）：${lastErr?.message}`);
}

/**
 * 代码补全：复用 code_completion_generator_1 的 prompt 与参数
 * @param {{problem: string, codeTemplate: string, extra?: string, requirementContract?: string}} args
 *   requirementContract（1.6.0）由 `requirement-contract.mjs` 从题干切分后渲染；传空串时
 *   prompt 里的「题面对齐表」要求自动落空（那条指令的前提就是"清单非空"）
 * @returns {Promise<{code: string, alignment: string}>} code = 第一个围栏块；
 *   alignment = 围栏块之前的全部文字——对齐表就在这里，交给 validateAlignment 机器校验
 */
export async function generateCode({
  problem,
  codeTemplate,
  extra = '',
  requirementContract = '',
}) {
  const cap = readCapability('code_completion_generator_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    problem_description: problem,
    code_template: codeTemplate,
    additional_requirements: extra,
    requirement_contract: requirementContract,
  });
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature,
    maxTokens: cap.formValue?.modelParams?.maxTokens,
    // 首轮快速出稿：默认关思考（时间优先，见 cfg.firstPassThinking）；
    // 失败后的反思轮（reflectAndFix）才动用 high 思考档一次修对
    enableThinking: cfg.ai.firstPassThinking,
  });
  const raw = String(content ?? '');
  const fence = raw.indexOf('```');
  return {
    code: extractCodeFromMarkdown(raw),
    alignment: fence >= 0 ? raw.slice(0, fence) : raw,
  };
}

/**
 * 选择题 / 填空题作答：复用 quiz_answer_selector_1 的 prompt 与参数
 * @returns {Promise<string>} 纯答案文本（选择题返回选项原文，填空题返回填空内容）
 */
export async function answerQuestion({ question, options = '', questionType = 'choice' }) {
  const cap = readCapability('quiz_answer_selector_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    question,
    options,
    question_type: questionType,
  });
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature ?? 0.2,
    maxTokens: cap.formValue?.modelParams?.maxTokens ?? 2048,
  });
  // 该 prompt 约定"只输出答案"，此处再剥一层可能存在的 markdown 标记，双重保险
  return content
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```$/, '')
    .trim();
}

/**
 * 解析批量作答输出。约定格式为每行「题号:字母」，如 "3:ABE"。
 * 容忍全角冒号、多余空格与大小写。解析失败时返回空 map，调用方据此降级。
 * @returns {{map: Record<number,string>, raw: string}}
 */
export function parseAnswers(text) {
  const map = {};
  const re = /(\d{1,3})\s*[:：]\s*([A-Za-z]+)/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    map[Number(m[1])] = m[2].toUpperCase();
  }
  return { map, raw: String(text ?? '').trim() };
}

/**
 * 批量选择题作答：一次提交整页所有小题
 * @param {{questions: Array<{no:number, stem:string, options:string[], multi:boolean}>, reference?: string}} args
 * @returns {Promise<{map: Record<number,string>, raw: string}>}
 */
export async function answerBatch({ questions, reference = '' }) {
  const cap = readCapability('quiz_batch_answer_1');
  const bank = questions
    .map(
      (q) =>
        `${q.no}. [${q.multi ? '多选' : '单选'}] ${q.stem}\n` +
        q.options.map((o) => '   ' + o).join('\n'),
    )
    .join('\n\n');

  const prompt = renderTemplate(cap.formValue.prompt, {
    question_bank: bank,
    reference,
  });
  // 解析出空结果时重试一次：模型偶发会给出不符合格式的输出（如整段解释文字）。
  // 直接返回空 map 会让整页题目全部跳过，代价太大。
  let last = { map: {}, raw: '' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content } = await chat([{ role: 'user', content: prompt }], {
      temperature: cap.formValue?.modelParams?.temperature ?? 0.2,
      maxTokens: cap.formValue?.modelParams?.maxTokens ?? 2048,
    });
    last = parseAnswers(content);
    if (Object.keys(last.map).length > 0) return last;
    console.warn(`[ai] 批量作答第 ${attempt} 次未解析出答案，原始输出：${last.raw.slice(0, 150)}`);
  }
  return last;
}

/**
 * 反思修复：复用 code_reflection_fixer_1 的 prompt 与参数
 * @returns {Promise<{analysis: string, code: string}>}
 */
export async function reflectAndFix({
  problem,
  previousCode,
  evalResult,
  terminalState = '',
  lessons = [],
  requirementContract = '',
}) {
  const cap = readCapability('code_reflection_fixer_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    problem_description: problem,
    previous_code: previousCode,
    evaluation_result: evalResult,
    terminal_state: terminalState,
    requirement_contract: requirementContract,
    // 教训链（与 reflectCommands 的 lessons 同构）：各轮已确诊的原因注入本
    // 轮 prompt，防"这轮改对了、下轮又退回"的摇摆（2026-09-15：zincrby 参数
    // 顺序 3 轮横跳就是反思无记忆导致的）
    lessons: lessons.map((l, i) => `第${i + 1}轮教训：${l}`).join('\n'),
  });
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature ?? 0.4,
    maxTokens: cap.formValue?.modelParams?.maxTokens,
    reasoningEffort: 'high', // 反思升档（2026-09-15）：low 档+思考硬闸曾让反思近乎无思考，
    // 只能顺着评测文本说表面错误；high 档配合放宽后的 60s 思考硬闸，真正推演输出差异根因
  });
  return splitAnalysisAndCode(content);
}

/** 从 AI 输出中抽取 markdown 代码块 */
export function extractCodeFromMarkdown(markdown) {
  const m = String(markdown ?? '').match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (m && m[1]) return m[1].trim();
  return String(markdown ?? '').trim();
}

/**
 * 模板拼接：把 AI 生成的代码体拼回平台原始模板的 Begin/End 标记之间，
 * 保证平台脚手架（含 Begin/End 标记、缩进、注释前缀）字节级不变。
 *
 * 背景：generateCode 把整段含标记的代码交给 AI，并依赖模型完整复现标记。
 * 实测模型常漏掉 / 改写标记，导致平台判定"不符合格式"。此处以「原始模板」为权威，
 * AI 只负责标记之间的代码体，从根上消除格式错。
 *
 * 多标记模板（2026-09-15 事故修复）：部分题目的模板含多对 Begin/End 标记
 * （如 Redis 令牌管理题三个函数各一对）。旧实现只取第一对替换，导致
 * AI 输出里后几个函数的实现被整体丢弃、模板其余块保持空白 → 评测
 * IndentationError 且反思死循环。现按出现顺序逐对对应替换。
 *
 * 缩进保持（2026-09-15 实测复现，真正根因）：模板 Begin/End 行位于函数体
 * 内（如 4 空格缩进），代码体必须保留行首缩进。旧实现用 trim() 提取代码体，
 * 会把首行前导空格整体剥掉——AI 输出 `    return ...`，拼完变顶格
 * `return ...`，评测 IndentationError 与「AI 没反思」表象同源：反思每次都
 * 改对，但拼接次次把缩进剥掉。现改为仅清理行尾空白、行首缩进原样保留。
 *
 * @param {string} originalTemplate 写入前从编辑器读取的原始模板（含 Begin/End 标记）
 * @param {string} aiOutput AI 返回的完整输出（可能含标记，也可能仅含代码体）
 * @returns {string} 可直接写入编辑器的最终代码
 */
/**
 * 检出"被压成一行的 heredoc"（1.6.11）。
 *
 * 由来（2026-09-23 真机，MongoDB 复制集搭建关）：模型把配置文件写成
 *   `cat > /etc/test/mongod1.conf <<'EOF' ; port=20001 ; dbpath=… ; EOF`
 * 但 heredoc 的正文**必须另起行**、以独占一行的结束标记收尾。用 `;` 连接时，shell 会把
 * **后续所有命令**都当作 heredoc 正文一直吞到遇见一行 `EOF`——配置文件写不全、后面的
 * `mongod -f` / `rs.initiate` 全都没执行，最后却表现为"评测连主节点报 not master"，
 * 复盘时极易被误诊成"终端连错了节点"（该关连续 12 轮都栽在这个误诊上）。
 *
 * 判据收得很紧（宁漏不误报）：同一行里既有 heredoc 起始（`<<TAG` / `<<'TAG'` / `<<"TAG"`），
 * **又**出现 `;`。正常的 heredoc 首行只有 `cat > f <<'EOF'`（不含分号），不会命中；
 * `<<<`（here-string）也不会命中（`<<` 后面紧跟 `<`，不匹配标识符首字符）。
 * 这里只**检出**、不改写——正文自身可能含分号，硬拆会误伤。
 * @param {string[]} cmds 命令数组（一条命令一个元素）
 * @returns {number[]} 命中的下标（0 起）
 */
/**
 * 检出"覆盖题面声明为**现有输入**的文件"的命令（零依赖纯函数，2026-09-23 真机）。
 * 背景：题面写「现有 person.json 文件内容如下…」时，该文件**由平台提供**；模型却用
 * `cat > /home/example/person.json <<'EOF'` 重建了一份**自己编的数据**（6 条、hobbies 还是
 * 字符串），随后 mongoimport 导入的是错数据 ⇒ 8 条查询全部落空，而且**平台的数据源被覆盖**
 * （破坏性，且无法从题面文本复原——数据只在截图里）。这类动作没有"靠 prompt 自觉"的余地。
 * 判据（两条同时成立才剔除，宁漏不误伤）：①题面里该路径出现在「现有/已有/内容如下」近旁；
 * ②命令是写该路径的形态（`> path` / `>> path` / `tee path` / `sed -i … path`）。
 * @param {string[]} cmds
 * @param {string} problem 当次题干
 * @returns {{kept: string[], dropped: Array<{cmd: string, path: string}>}}
 */
export function findDataFileOverwrites(cmds, problem) {
  const text = String(problem ?? '');
  if (!text || !Array.isArray(cmds) || !cmds.length) return { kept: cmds ?? [], dropped: [] };
  // 题面把某个文件称作"现有输入"：①该路径近旁出现「现有/已有/内容如下」；②或题面出现
  // 「现有 person.json 文件内容如下」这类**只给文件名**的措辞——此时按 basename 认路径
  //（真机题面就是这么写的：文件名在"现有… 文件内容如下"里，完整路径在后面另一行）。
  const namedFiles = [
    ...text.matchAll(/(?:现有|已有|已存在)\s*([\w.-]+\.(?:json|csv|txt|dat|log|xml))/g),
  ].map((m) => m[1]);
  const protectedPaths = [];
  const re = /[\w./-]*\/[\w./-]+\.(?:json|csv|txt|dat|log|xml)\b/g;
  for (const m of text.matchAll(re)) {
    const around = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
    const base = m[0].split('/').pop();
    if (/现有|已有|已存在|内容如下|如下文件/.test(around) || namedFiles.includes(base)) {
      protectedPaths.push(m[0]);
    }
  }
  if (!protectedPaths.length) return { kept: cmds.slice(), dropped: [] };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kept = [];
  const dropped = [];
  for (const cmd of cmds) {
    const hit = protectedPaths.find((p) => {
      const P = esc(p);
      const byRedirect = new RegExp('>>?\\s*[\'"]?' + P + '(?![\\w./-])').test(cmd);
      const byTee = new RegExp('\\btee\\b[^;|]*[\'"]?' + P + '(?![\\w./-])').test(cmd);
      const bySedInplace = /\bsed\b/.test(cmd) && /(^|\s)-i(\s|$)/.test(cmd) && cmd.includes(p);
      return byRedirect || byTee || bySedInplace;
    });
    if (hit) dropped.push({ cmd, path: hit });
    else kept.push(cmd);
  }
  return { kept, dropped };
}

/**
 * 题面是否明文规定了提交形态（引号 / `$` 转义）——**共享判据**（零依赖纯函数）。
 *
 * 存在理由（2026-09-24 真机，同一道题烧掉第 5/6/7 轮）：`wrapDbCommandsInEcho` 每轮把
 * 模型写的裸数据库语句确定性包成 `echo "`，紧接着 `detectQuoteFormViolation` 又把这个
 * `echo "` 判成违反题面「不要使用双引号改用单引号」并喂给反思 ⇒ 模型下一轮删掉包裹、
 * 执行层再包回去、再判违约……提交文本逐字节相同，永远解不开。两层必须用同一个判据，
 * 否则 Agent 是在跟自己吵架，而不是在跟平台要答案。
 * @param {string} problem 当次题干
 * @returns {boolean}
 */
export function statementPrescribesQuoteForm(problem) {
  return /不要使用双引号|改用\s*单引号|使用单引号/.test(String(problem ?? ''));
}

/**
 * 取提交文本里 Begin/End 之间的正文（无标记时整段即正文）。兜底与判据共用，
 * 保证两者看到的是同一段文本。
 * @param {string} text
 * @returns {{body: string, head: string, tail: string}|null} null = 无 Begin/End 标记
 */
export function submissionBody(text) {
  const src = String(text ?? '');
  const m = src.match(
    /^([\s\S]*?#\*+\s*Begin\s*\*+?#\s*\n?)([\s\S]*?)(\n?#\*+\s*End\s*\*+?#[\s\S]*)$/i,
  );
  if (!m) return { body: src, head: '', tail: '', bare: true };
  return { body: m[2], head: m[1], tail: m[3], bare: false };
}

/**
 * 剥掉**外层**的 echo 包裹形态，只留数据库语句本身（零依赖纯函数）。
 * 三种写法都要认：`echo "` 独占一行、`echo "db.x…"` 同行、`echo 'db.x…'` 同行。
 * 外层引号属平台机制（把引号内内容交数据库 eval），**不是**题面所禁的"双引号"——
 * 题面那句「不要使用双引号改用单引号」针对的是语句内部的字符串字面量（`sex:"男"`）。
 * @param {string} line
 * @returns {string} 去外层包裹后的语句文本
 */
function stripOuterEcho(line) {
  let t = String(line ?? '').trim();
  if (/^echo\s+["']$/.test(t)) return '';
  if (t === '"' || t === "'") return '';
  t = t.replace(/^echo\s+["']/, '');
  if (/["']$/.test(t)) t = t.slice(0, -1);
  return t;
}

/**
 * 题面明文要求语句内用单引号、而提交在数据库语句**内部**用了双引号 —— 机器判据。
 *
 * 1.6.19 收窄作用域：旧版把外层 `echo "` 一起判成违约，于是"外层包裹"这一平台机制
 * 与题面要求被混为一谈，并与 `wrapDbCommandsInEcho` 互相抵消（见该函数注释）。
 * 现在只看剥掉外层包裹之后的语句文本：残留 `"`（含 `\"`）才是真违约。
 * @param {string} code 实际提交文本
 * @param {string} problem 当次题干
 * @returns {string} 违规说明（空串 = 无违规）
 */
export function detectQuoteFormViolation(code, problem) {
  const c = String(code ?? '');
  if (!c || !statementPrescribesQuoteForm(problem)) return '';
  const sub = submissionBody(c);
  const offenders = sub.body
    .split(/\r?\n/)
    .map(stripOuterEcho)
    .filter((l) => l.includes('"'));
  if (!offenders.length) return '';
  return (
    `题面明文要求「不要使用双引号改用单引号」，而**数据库语句内部**仍用了双引号：` +
    `${offenders[0].slice(0, 90)}。只把语句里的字符串字面量改成单引号` +
    `（例：sex:"男" → sex:'男'）；**外层 echo 的双引号包裹属平台机制，保持原样不要动**。`
  );
}

/**
 * `db.<库名>.<集合名>` 形态判据（零依赖纯函数，2026-09-23 真机）。
 * 在数据库 shell 里 `db.<库名>` **已经是一个集合对象**，再往下一层取属性得到 undefined，
 * `.find()` 必报 TypeError；而这类异常走 **stderr、不进评测输出** ⇒ 现象是"标签后什么都没有"，
 * 极易被误读成"数据没导入"（2026-09-23 真机就这样烧了 8 轮）。
 * 合法形态只有 `db.<集合名>`、`db.getCollection('x')`、`db.getSiblingDB('db').<集合名>`——
 * 后两者中间不是"裸标识符.裸标识符."，本判据不误伤。
 * @param {string} code
 * @returns {string} 违规说明（空串 = 无违规）
 */
export function detectDbCollectionRefViolation(code) {
  const c = String(code ?? '');
  const re = /\bdb\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\./g;
  const bad = [...c.matchAll(re)].map((m) => m[0].trim());
  if (!bad.length) return '';
  const fix = bad[0].replace(/db\s*\.\s*[A-Za-z_$][\w$]*\s*\./, 'db.');
  return `提交里出现 \`${bad[0]}\` —— **\`db.<库名>.<集合名>\` 不是合法形态**：在数据库 shell 里 \`db.<库名>\` 已经是一个**集合**，再往下一层取属性得到 undefined，\`.find()\` **不会报错，而是静默指向另一个（通常为空的）集合** —— 真机只读探针实测 typeof db.mydb3.test === object、db.test.count() = 0，所有查询因此「跟没有数据一样」，既不报错也无输出、最难查。请写成 \`${fix}\`（只保留集合名；库由评测环境预选，无需 use / getSiblingDB）。`;
}

/**
 * 题面要求「$ 前加 \」而提交里有未转义操作符 —— 机器判据（零依赖纯函数，2026-09-23）。
 * 成因：平台把代码栏内容包进外层引号再交数据库 shell `eval`，`$` 会被外层展开，
 * 所以题面才要求写成 `\$`。漏转义的后果是操作符被吃掉或提前展开（整轮白跑）。
 * @param {string} code
 * @param {string} problem
 * @returns {string} 违规说明（空串 = 无违规 / 题面没这条要求）
 */
export function detectEscapeViolation(code, problem) {
  const p = String(problem ?? '');
  const c = String(code ?? '');
  if (!p || !c) return '';
  if (!/(?:\$\s*前加|即使用\s*\\\$|\$\s*写成\s*\\\$)/.test(p)) return '';
  const OPS =
    /(?<!\\)\$(?:or|and|not|nor|all|in|nin|mod|size|exists|type|regex|gt|gte|lt|lte|ne|eq|elemMatch|expr|slice|push|addToSet|inc|set|unset)\b/g;
  const hits = [...c.matchAll(OPS)].map((m) => m[0]);
  if (!hits.length) return '';
  const uniq = [...new Set(hits)].slice(0, 5);
  return `题面明文要求「$ 前加反斜杠转义」，而提交里有未转义的操作符：${uniq.map((h) => `'` + h + `'`).join('、')}。全部改写成转义形态（操作符前加一个反斜杠：$all 写成 反斜杠+$all，$or 同理）——平台会以引号包裹代码再交数据库 eval，$ 不转义会被外层吃掉。`;
}

/**
 * 这段正文是不是「数据库 shell 脚本」形态（零依赖纯函数）。
 * 与 `wrapDbCommandsInEcho` 的触发判据同源思路：**行级 ≥70%** 才认，避免误伤
 * Python/Java 编程题（那里的 `list.remove(x)`、`Statement.execute()` 都不该被切）。
 * 允许整行以 `echo "` / `echo '` 开头（平台机制的外层包裹）。
 * @param {string} body
 * @returns {boolean}
 */
export function looksLikeDbScript(body) {
  const lines = String(body ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // 真机形态是 `echo "` 独占一行、正文若干行、`"` 收尾——两头的包裹行不含语句，
    // 计入分母会把比例稀释到 0.7 以下（1.6.19 单测抓到的假阴性）
    .filter((l) => !/^(?:echo\s+["']|["'])$/.test(l));
  if (!lines.length) return false;
  const hit = lines.filter((l) =>
    /^(?:echo\s+["'])?\s*(?:db\s*\.|show\s|use\s|mongo(?:import|export|restore|dump)?\b)/.test(l),
  ).length;
  return hit / lines.length >= 0.7;
}

/**
 * 按 `;` **与换行**切出语句，并保留每条在原文中的偏移（零依赖纯函数）。
 *
 * 为什么两种分隔符都要认（1.6.19，落地自查抓到的两处缺陷）：
 * ① 只认 `;` 时，"一条命令一行"的正文会被当成**一整条**——条数核对报出"提交只有 1 条"，
 *    把本来正确的产物打回去反复重生成；
 * ② 更坏的是破坏性剔除：整段只有一条"语句"时，只要它含 remove/mongoimport，
 *    **整段都被切掉**，连着把同段里其余正确查询一起销毁。
 * 分号不做字符串内豁免：平台本身按分号切分逐条 eval，与之对齐才不会出现"我们数 8 条、
 * 平台只认 7 条"这种两套口径。
 * @param {string} text
 * @returns {Array<{sql: string, start: number, end: number}>}
 */
export function splitStatements(text) {
  const s = String(text ?? '');
  const out = [];
  let from = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i !== s.length && s[i] !== ';' && s[i] !== '\n') continue;
    const raw = s.slice(from, i);
    if (raw.trim()) out.push({ sql: raw.trim(), start: from, end: i });
    from = i + 1;
  }
  return out;
}

/** 删数据 / 覆盖平台数据的语句与 shell 命令（只应存在于命令行，代码栏里出现即拦下） */
const DESTRUCTIVE_DB_STMT =
  /\.\s*(?:remove|drop|dropDatabase|dropCollection|deleteMany|deleteOne|truncate)\s*\(|^\s*(?:echo\s+["'])?\s*(?:mongo(?:import|export|restore|dump)\b|rm\s+)/;

/**
 * 剔除代码栏里的**破坏性语句**（零依赖纯函数，2026-09-24 真机）。
 *
 * 事故：第 4 轮反思给出策略「首行执行 mongoimport 导入数据」，于是 Begin-End 里同时出现
 * `mongoimport`（在 eval 环节必定失败：`bad JSON array format`）与 `db.test.remove({})`
 * （**必定成功**：`WriteResult({"nRemoved": 8})`）。结果平台提供的 8 条文档被我方删光，
 * 此后每一轮 count 都是 0，而反思读到的现象是"查询全空"，遂一路去改查询形态。
 * 与 2026-09-23 那次「cat > 覆盖平台提供的 person.json」同类：**平台的数据源一旦被
 * 自己改坏，后续所有评测反馈都不再反映模型的代码**，且无法从题面文本复原。
 * 终端侧那次已有 `findDataFileOverwrites` 兜着，代码栏侧此前是空白。
 *
 * 只**切除**命中的那一段原文（其余字节与外层 echo 形态不动），这样条数核对与 echo 兜底
 * 看到的仍是同一份文本。语句以 `;` 或换行为界（见 `splitStatements`）：逐行
 * `echo 'mongoimport …'` 这种"一行一条"的写法必须整行删掉，不能只删引号内的内容——
 * 那会留下不成对的引号，把后面每一条正确查询一起毁掉（1.6.19 落地自查抓到）。
 * @param {string} text 整段提交内容（含 Begin/End 注释）
 * @returns {{code: string, dropped: string[]}}
 */
export function stripDestructiveDbStatements(text) {
  const src = String(text ?? '');
  const sub = submissionBody(src);
  if (!sub || !looksLikeDbScript(sub.body)) return { code: src, dropped: [] };
  const hits = splitStatements(sub.body).filter((s) => DESTRUCTIVE_DB_STMT.test(s.sql));
  if (!hits.length) return { code: src, dropped: [] };
  let body = sub.body;
  // 从后往前切，避免前面的偏移失效
  for (const h of hits.slice().reverse()) {
    body = body.slice(0, h.start) + body.slice(h.end);
  }
  body = body
    .replace(/(echo\s*["'])\s*;+/g, '$1')
    .replace(/(?:^|\n)\s*;+/g, '\n')
    .replace(/^\s*;+/, '')
    .replace(/;{2,}/g, ';');
  return {
    code: `${sub.head}${body}${sub.tail}`,
    dropped: hits.map((h) => h.sql.slice(0, 80)),
  };
}

/** 中文数字 → 阿拉伯数字（只覆盖题面常见的「八 / 十一 / 二十」量级，认不出返回 null） */
function cnNumber(s) {
  const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const t = String(s ?? '');
  if (/^\d+$/.test(t)) return Number(t);
  if (t === '十') return 10;
  if (Object.prototype.hasOwnProperty.call(D, t)) return D[t];
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (!m) return null;
  return (m[1] ? D[m[1]] : 1) * 10 + (m[2] ? D[m[2]] : 0);
}

/**
 * 题面明写的命令条数（零依赖纯函数）：「上述操作共有八条命令」→ 8。
 * 题面没写就返回 null——这条判据只在题面自己给了数字时才生效，跨平台 fail-open。
 * @param {string} problem
 * @returns {number|null}
 */
export function parseDeclaredCommandCount(problem) {
  const t = String(problem ?? '');
  const m = t.match(
    /共(?:有)?\s*([0-9]{1,3}|[零一二两三四五六七八九十]{1,3})\s*条\s*(?:命令|查询|语句|操作)/,
  );
  if (!m) return null;
  const n = cnNumber(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 提交的语句段数与题面声明条数是否一致 —— 机器判据（零依赖纯函数，2026-09-24 真机）。
 *
 * 为什么必须机器判：真机提交的 7 条对 8 个标签，平台按**位置**把结果塞进标签，于是
 * `0` 出现在「查找name != 韩*开头的人的信息」这一标签下、最后一个标签后面空着——
 * 现象是"22 处差异"，看起来像查询写错，实际是少答一条。模型这次漏答有客观原因：
 * 题面自己把第 7 条写成了「查找查找name != 韩*开头的人的个数」（叠字），读起来像把
 * 第 6 条合并进去了。契约层本应拦住漏答，但它切出 12 条、`missing_item` ×12 触发了
 * "判定依据不可靠，停止打回"的止损，等于没有检查。题面既然白纸黑字给了数字，
 * 数一遍分号段就是确定性判据，不需要模型自觉。
 * @param {string} submitted 实际提交文本
 * @param {string} problem 当次题干
 * @returns {string} 违规说明（空串 = 无违规 / 题面未声明条数）
 */
export function detectCommandCountViolation(submitted, problem) {
  const c = String(submitted ?? '');
  const declared = parseDeclaredCommandCount(problem);
  if (!declared || !c) return '';
  const sub = submissionBody(c);
  if (!looksLikeDbScript(sub.body)) return '';
  // 与条数口径对齐：先把外层 echo 包裹剥成纯语句，再按分号切
  const sql = sub.body.split(/\r?\n/).map(stripOuterEcho).filter(Boolean).join('\n');
  const actual = splitStatements(sql).length;
  if (actual === declared) return '';
  return (
    `题面明文写了「共 ${declared} 条命令」，而提交里只有 ${actual} 条（按分号/换行切分）` +
    (actual < declared ? '，漏答' : '，多出') +
    `。平台是**按位置**把每条命令的输出塞进对应的结果标签的——少一条会让后面每一个标签` +
    `整体错位，现象是"全部结果都对不上"，与查询写错无关。` +
    `请对照题面的要求清单补齐/删减到正好 ${declared} 条，一条命令一段，顺序照题面。`
  );
}

/**
 * 代码栏里的 shell 调用形态判据（零依赖纯函数，1.6.21）：heredoc 起始（`<<'EOF'` 类）、
 * `mongo`/`mongosh` 命令前缀、行首 `:` 前缀。这三类形态在本平台实测全部失败（平台对代码栏
 * 先过 bash、再把引号内内容交数据库 eval；`mongo …`/heredoc 在 bash 环节报语法错或把后续
 * 内容当正文吞掉），代码栏里只该写数据库语句本身——外层包裹由执行层统一加，导入/写文件等
 * shell 操作只属于「命令行」。此前这三条只有 prompt 纪律（生成器规则 10、反思器守则 4），
 * 而 `findSquashedHeredocs` 只管终端命令数组、`wrapDbCommandsInEcho` 甚至会把含 heredoc 的
 * 正文整段包进 echo——是"能机器判定的不要交给 prompt"剩下的最后一个没落地的形态禁令。
 *
 * 门控：仅当正文整体是数据库脚本形态（looksLikeDbScript）才启用——Java/C++ 的 `<<` 位移、
 * 普通 shell 脚本整体跳过（宁漏不误报）；`mongoimport` 类已被 stripDestructiveDbStatements
 * 剔除，不在本判据重复点名。只**检出**不改写：heredoc 正文可能含分号，硬拆有误伤风险
 * （与 findSquashedHeredocs 同一取舍）。
 * @param {string} code 实际提交文本
 * @returns {string} 违规说明（空串 = 无违规 / 非 db 脚本正文）
 */
export function detectShellInvocationViolation(code) {
  const c = String(code ?? '');
  if (!c) return '';
  const sub = submissionBody(c);
  if (!looksLikeDbScript(sub.body)) return '';
  const offenders = sub.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^#/.test(l) &&
        !/^\/\//.test(l) &&
        (/<<-?['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(l) ||
          /^(?:mongo|mongosh)\b/.test(l) ||
          l.startsWith(':')),
    );
  if (!offenders.length) return '';
  return (
    `代码栏里混入了 shell 调用形态（heredoc 起始 / mongo 命令前缀 / 行首冒号前缀）：` +
    `${offenders[0].slice(0, 90)}。本平台对代码栏先过 bash、再把引号内内容交数据库 eval，` +
    `这三类形态实测全部失败（bash 报语法错或 eval 解析错）。代码栏里只写数据库语句本身` +
    `（外层包裹由执行层统一加，不用你管）；写文件、导入数据等 shell 操作只属于「命令行」。`
  );
}

/**
 * 把裸写的数据库 shell 语句包成一次性客户端调用（零依赖纯函数，2026-09-24 真机）。
 *
 * 事故：混合题的「命令行数据准备」里，模型把 `show dbs`、`use mydb3`、
 * `db.test.find({age:20,sex:'男'})` **直接打进 bash**——bash 不是 mongo REPL，
 * 前者 `command not found`、后者 `syntax error near unexpected token`，两轮准备额度
 * 全烧在这些噪音上（12:53:24 与 12:53:32）。终端环境是实测出来的（`detectTerminalEnv`
 * 已给出 bash），所以"该不该包"不需要模型判断，交给代码。
 *
 * 引号策略：语句内没有 `'` 时用单引号包（bash 完全不做展开，最稳）；含 `'` 时改用双引号
 * 并转义 `\ ` ` $` 与 `"`——`$` 不转义会被 bash 当变量吃掉，那正是题面在代码栏要求 `\$`
 * 的同一个原因。
 * @param {string[]} cmds 准备命令列表
 * @param {{db?: string}} [opt] 题面声明的目标库名（`use X` 也用它兜底）
 * @returns {{cmds: string[], wrapped: Array<{no: number, from: string, to: string}>}}
 */
export function wrapBareDbStatementsForShell(cmds, opt = {}) {
  const list = Array.isArray(cmds) ? cmds : [];
  const wrapped = [];
  const out = [];
  list.forEach((raw, i) => {
    const stmt = String(raw ?? '').trim();
    const useM = stmt.match(/^use\s+([A-Za-z_][\w$]*)\s*;?$/);
    if (useM) {
      // bash 里没有 `use`（实测 `-bash: use: command not found`）；库名改由每条被包裹的
      // 语句自带（--quiet <db>），这行整体丢弃即可。
      wrapped.push({ no: i + 1, from: stmt, to: `（丢弃：库名已随每条 mongo --eval 传入）` });
      return;
    }
    if (!/^(?:db\s*\.|show\s)/.test(stmt)) {
      out.push(raw);
      return;
    }
    const db = opt.db || '';
    const prefix = `mongo${db ? ` --quiet ${db}` : ''}`;
    const evalArg = stmt.includes("'")
      ? `"${stmt.replace(/[\\`$"]/g, (ch) => (ch === '"' ? '\\"' : `\\${ch}`))}"`
      : `'${stmt}'`; // 无单引号时用单引号包：bash 完全不做展开，最稳
    const to = `${prefix} --eval ${evalArg}`;
    wrapped.push({ no: i + 1, from: stmt.slice(0, 60), to: to.slice(0, 90) });
    out.push(to);
  });
  return { cmds: out, wrapped };
}

/**
 * 提交形态的一次性机器体检（把上面几条汇总，供 loop 在提交点统一调用）。
 * 全部对「拼接+护栏后的最终文本」执行（1.6.21 起随 finalizeSubmission 每次拼接重检）；
 * 代码栏 shell 调用形态判据（1.6.21）也在此列。
 * @param {string} code 实际提交文本
 * @param {string} problem 当次题干
 * @returns {string[]} 每条为一句可读的违约说明（空数组 = 无违规）
 */
export function detectSubmissionFormViolations(code, problem) {
  return [
    detectQuoteFormViolation(code, problem),
    detectDbCollectionRefViolation(code),
    detectEscapeViolation(code, problem),
    detectCommandCountViolation(code, problem),
    detectShellInvocationViolation(code),
  ].filter(Boolean);
}

/**
 * 从题面解析「导入到数据库 X 中的 Y 集合」的目标库/集合（零依赖纯函数，2026-09-23）。
 * 用途：导入完成后**实测**该集合的条数，把「数据到底有没有落库」从猜测变成事实。
 * @param {string} problem
 * @returns {{db: string, coll: string}|null}
 */
export function parseImportTarget(problem) {
  const t = String(problem ?? '');
  const m = t.match(/数据库\s*([A-Za-z_][\w$]*)\s*中的?\s*([A-Za-z_][\w$]*)\s*集合/);
  return m ? { db: m[1], coll: m[2] } : null;
}

export function findSquashedHeredocs(cmds) {
  const out = [];
  (cmds ?? []).forEach((c, i) => {
    const s = String(c ?? '');
    if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(s) && s.includes(';')) out.push(i);
  });
  return out;
}

/**
 * 剔除"必定不是 Python 语法"的说明性整行（1.6.9）。
 *
 * 由来（2026-09-23 真机，微博用户/动态关）：模型把 16 行「题面对齐表」连同表头一起写进了
 * Begin-End 区域，`spliceIntoTemplate` 原样拼进模板后提交 → `SyntaxError: invalid syntax`
 * 落在表格行上，白烧一轮评测（该轮反思才自己诊断回来："代码中混入了表格性质的说明文字"）。
 * 表格行不以 `#` 开头、含 `|` 与中文，在 Python 2 里**必定**编译失败——属"能机器判定"的一类，
 * 不该交给模型自觉，也不该用一轮 120 秒的评测去发现。
 *
 * 判据收得很紧（宁漏不误报，与 py2-guard 同纪律）：
 *   · **一律保留 `#` 开头的行**——`#` 注释在 Python 2 里合法（`### 小标题` 同样是注释，
 *     模板自带的中文注释也在这里被保住）；
 *   · 只认五类形态：Markdown 表格行、表格分隔行、「编号 | …」表头、
 *     「N | … | …」数据行、代码围栏。
 * 合法 Python 的位或表达式（`x = a | b`）既不以 `|`/数字开头、也不成表格形态，不会命中。
 *
 * @returns {{text: string, dropped: number, samples: string[]}} samples 供日志留痕（最多 2 条）
 */
export function stripNonCodeLines(text) {
  const lines = String(text ?? '').split('\n');
  const kept = [];
  const samples = [];
  for (const l of lines) {
    if (isNonCodeLine(l)) {
      if (samples.length < 2 && l.trim()) samples.push(l.trim().slice(0, 60));
      continue;
    }
    kept.push(l);
  }
  return { text: kept.join('\n'), dropped: lines.length - kept.length, samples };
}

function isNonCodeLine(l) {
  if (/^\s*#/.test(l)) return false; // 注释合法，保留
  if (/^\s*```/.test(l)) return true; // 代码围栏
  if (/^\s*\|.*\|\s*$/.test(l)) return true; // | a | b |
  if (/^\s*[|｜]\s*[-:\s|｜]+[|｜]\s*$/.test(l)) return true; // |---|---|
  if (/^\s*编号\s*[|｜]/.test(l)) return true; // 编号 | 题面原文摘录 | …
  if (/^\s*\d+\s*[|｜]\s*\S+.*[|｜]/.test(l)) return true; // 1 | … | … |
  return false;
}

export function spliceIntoTemplate(originalTemplate, aiOutput) {
  const orig = String(originalTemplate ?? '');
  const ai = String(aiOutput ?? '');

  // 完整代码直通（2026-09-15 真机实证 + 2026-09-15 标记可信方案）：
  // 触发条件任意一个满足 → 直接返回 AI 完整输出，不按标记归位：
  // 1. 模板本身标记不成对（Begin ≠ End 数量）：模板本身不完整，标记归位必丢函数
  // 2. AI 输出含 ≥2 个模块级语句（import/from/def/class/@）：AI 已完整复刻结构
  // 两种情况都意味着标记已不可信，标记归位只会丢代码、报 IndentationError。
  // 平台只按执行结果评测，整体直通最接近 AI 给出的正确完整实现。
  const matchesBegin = (orig.match(/\bbegin\b.*[*=#-]{3,}/i) || []).length;
  const matchesEnd = (orig.match(/\bend\b.*[*=#-]{3,}/i) || []).length;
  const topLevelStatements = (ai.match(/^(import |from |def |class |@)\S/m) || []).length;
  if (matchesBegin !== matchesEnd || topLevelStatements >= 2) {
    // 直通也必须带头部编码声明：平台是 Python 2，丢声明 + 中文注释 = SyntaxError
    return withTemplateLeadingDecl(orig, ai);
  }

  const origPairs = collectMarkerPairs(orig);
  // 原始模板无标记：纯编辑器，直接信任 AI 输出（已做 markdown 抽取）
  if (!origPairs.length) return withTemplateLeadingDecl(orig, ai);

  const aiPairs = collectMarkerPairs(ai);
  const origLines = orig.split(/\r?\n/);
  const aiLines = ai.split(/\r?\n/);

  // 保留行首缩进、仅去行尾空白（见函数头注释：缩进被 trim 剥掉是死循环真正根因）
  const keepIndent = (lines) => lines.map((l) => l.replace(/\s+$/, '')).join('\n');
  const origBody = (pair) => keepIndent(origLines.slice(pair[0] + 1, pair[1]));

  // 逐块取代码体：AI 带有标记时按序一一对应
  let bodies;
  if (!aiPairs.length) {
    // AI 未复现模板标记且不是完整代码（单语句片段）→ 整段填第一个块（兼容旧行为）
    bodies = origPairs.map((pair, i) => (i === 0 ? keepIndent(aiLines) : origBody(pair)));
  } else {
    bodies = origPairs.map((pair, i) =>
      i < aiPairs.length
        ? keepIndent(aiLines.slice(aiPairs[i][0] + 1, aiPairs[i][1]))
        : origBody(pair),
    );
  }

  // 逐块重组：模板行按原样保留（Begin/End 行字节不变），仅替换块内代码体
  const out = [];
  let next = 0;
  for (let i = 0; i < origPairs.length; i++) {
    const [b, e] = origPairs[i];
    out.push(...origLines.slice(next, b + 1)); // 含 Begin 行
    out.push(bodies[i]);
    out.push(origLines[e]); // End 行
    next = e + 1;
  }
  out.push(...origLines.slice(next));
  return out.join('\n');
}

/**
 * 直通模式下补回模板的前导声明（shebang / 编码声明）。
 *
 * 背景（2026-09-20 真机实证）：评测平台跑的是 **Python 2**，源文件缺少
 * `#-*- coding:utf-8 -*-` 时，任何中文注释都会触发
 * `SyntaxError: Non-ASCII character '\xe5' ... but no encoding declared`。
 * 而「完整代码直通」分支整体采用 AI 输出，文件头全靠 AI 自觉复述模板——
 * 实测 AI 有时会省略这两行。这里做确定性兜底：模板前两行是注释且含编码声明、
 * AI 输出前两行没有时，把模板声明行补回（AI 已自带则原样返回，幂等）。
 * @param {string} originalTemplate 平台原始模板
 * @param {string} aiOutput 直通采用的 AI 输出
 * @returns {string} 保证带编码声明的完整代码
 */
function withTemplateLeadingDecl(originalTemplate, aiOutput) {
  const out = String(aiOutput ?? '').trim();
  if (/coding\s*[:=]/.test(out.split(/\r?\n/).slice(0, 2).join('\n'))) return out;
  const tplLines = String(originalTemplate ?? '').split(/\r?\n/);
  const decl = [];
  for (let i = 0; i < Math.min(2, tplLines.length); i++) {
    const t = tplLines[i].trim();
    if (!t || t.startsWith('#')) decl.push(tplLines[i].replace(/\s+$/, ''));
    else break;
  }
  // 只补"模板前导里确实有编码声明"的情况：否则可能把无关注释塞进 AI 代码
  if (!decl.length || !/coding\s*[:=]/.test(decl.join('\n'))) return out;
  return [...decl, out].join('\n');
}

/**
 * 检测 Begin/End 区域内是否缺少实质代码（只有注释/空白视为空）。
 * 供提交前校验：AI 漏补全某些区域时在日志打点，提示反思轮对照模板补全。
 * @param {string} text
 * @returns {number[]} 空区域的序号（从 1 起）
 */
export function emptyMarkerBlocks(text) {
  const pairs = collectMarkerPairs(text);
  const lines = String(text ?? '').split(/\r?\n/);
  const empty = [];
  pairs.forEach(([b, e], i) => {
    const hasCode = lines.slice(b + 1, e).some((l) => {
      const t = l.trim();
      return t && !t.startsWith('#');
    });
    if (!hasCode) empty.push(i + 1);
  });
  return empty;
}

/**
 * 收集文本中所有平台 Begin/End 标记行号对（按出现顺序），每个 Begin 匹配其
 * 后第一个 End。行匹配规则与旧 findMarkerLine 一致：行内同时含 begin/end
 * 关键字与一个 ≥3 的装饰符串（* / = / # / -），以区分平台标记与代码里可能
 * 出现的 begin/end 关键字（如 Redis 事务里的 "BEGIN"）。
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function collectMarkerPairs(text) {
  const deco = /[*=#-]{3,}/;
  const lines = String(text ?? '').split(/\r?\n/);
  const begins = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (/\bbegin\b/i.test(line) && deco.test(line)) begins.push(i);
    else if (/\bend\b/i.test(line) && deco.test(line)) ends.push(i);
  });
  const pairs = [];
  let e = 0;
  for (const b of begins) {
    while (e < ends.length && ends[e] <= b) e++;
    if (e < ends.length) pairs.push([b, ends[e++]]);
  }
  return pairs;
}

/** 分离反思输出中的「分析」与「代码」两部分 */
export function splitAnalysisAndCode(markdown) {
  const s = String(markdown ?? '');
  const m = s.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (m && m[1]) {
    return { analysis: s.slice(0, m.index ?? 0).trim(), code: m[1].trim() };
  }
  return { analysis: s.trim(), code: '' };
}

// ---- 成功判定 ----
// 加固说明：朴素 includes 关键词匹配存在两类误判：
//   1. "未通过" / "没有通过" 会命中 "通过"，导致失败被判成成功；
//   2. "AC" 是子串，英文文本中 "AC" 出现频率高（如 "ACCEPT"、"back" 中的 ac）。
// 这里先做否定式短路，再匹配肯定词，且 "AC" 要求整词匹配。

// 零失败信号：语义是「全部通过」，但字面含否定词表里也出现的「不匹配」。
// 必须**先于**否定词短路判定，否则 EduCoder 常见的「共 3 组测试，0 组不匹配」
// 会被误判为未通过，白白触发整轮反思重试（1.1.0 单测暴露）。
const ZERO_FAIL_PATTERNS = [/0\s*组不匹配/, /全部匹配/];

const NEGATIVE_PATTERNS = [
  /未通过/,
  /没有通过/,
  /不通过/,
  /未全部通过/,
  /失败/,
  /错误/,
  /异常/,
  /不匹配/,
  /wrong\s*answer/i,
  /\bWA\b/,
  /time\s*limit/i,
  /runtime\s*error/i,
  /compile\s*error/i,
];

const POSITIVE_PATTERNS = [
  /全部通过/,
  /答案正确/,
  /0\s*组不匹配/,
  /恭喜.{0,4}通过/,
  /评测通过/,
  /测试通过/,
  /accepted/i,
  /\ball\s*passed\b/i,
  /\bAC\b/,
  /\bpass(ed)?\b/i,
  // 兜底：裸「通过」。否定词（未通过/没有通过/不通过/未全部通过…）已在
  // 上面短路，走到这里还出现的「通过」就是真通过——EduCoder 系结果文本
  // 常写作「测试集1 通过」，旧词表一个都命中不了，会误判未通过。
  /通过/,
];

/**
 * @returns {{passed: boolean, reason: string}} passed 为 true 表示判定为通过；
 *   reason 说明判定依据，便于日志排错。不确定时一律判 false（保守策略）。
 */
export function detectVerdict(text) {
  const s = String(text ?? '').trim();
  if (!s) return { passed: false, reason: '空结果' };

  for (const re of ZERO_FAIL_PATTERNS) {
    const m = s.match(re);
    if (m) return { passed: true, reason: `零失败信号「${m[0]}」` };
  }
  for (const re of NEGATIVE_PATTERNS) {
    const m = s.match(re);
    if (m) return { passed: false, reason: `命中否定词「${m[0]}」` };
  }
  for (const re of POSITIVE_PATTERNS) {
    const m = s.match(re);
    if (m) return { passed: true, reason: `命中肯定词「${m[0]}」` };
  }
  return { passed: false, reason: '未命中任何成功信号，保守判为未通过' };
}

/** 列出可用文本模型，便于挑选 AI_MODEL */
export async function listChatModels() {
  assertAiReady();
  const res = await fetch(`${cfg.ai.baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${cfg.ai.apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // 注意：端点类型字段不可全信。实测 agnes-2.0-flash 标记为 "openai-video"，
  // 但 chat/completions 完全可用且延迟很低；而 agnes-video-* / agnes-image-* 才是
  // 真正的媒体生成模型。因此这里按 id 名称排除媒体模型，端点类型只做宽松匹配。
  const mediaSkip = /(image|video|flux|kolors|banana)/i;
  const otherSkip = /(embed|rerank|bge|asr|tts|ocr|speech|voice)/i;
  return (json?.data ?? [])
    .filter((m) => (m?.supported_endpoint_types ?? []).some((t) => String(t).startsWith('openai')))
    .filter((m) => !mediaSkip.test(m.id))
    .filter((m) => !otherSkip.test(m.id))
    .map((m) => m.id)
    .sort();
}

// ---- 命令行题（cmdline）：意图判定 / 命令生成 / 反思修复 ----

/**
 * 按题干内容判定任务意图（决定"写代码文件"还是"在命令行执行命令"）。
 * 用户要求：以题干要求为准，而不是当前激活的 tab。
 * 0.9.1 新增 mixed：题干同时含命令行操作步骤与代码栏编写要求（如"先在
 * 命令行插入文档，再在 Begin-End 中写查询"）——旧版二选一路由在此二难。
 * @returns {Promise<'code'|'cmdline'|'mixed'>}
 */
export async function classifyProblemIntent({ problem, codeTemplate = '' }) {
  const cap = readCapability('task_router_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    problem_description: problem,
    // 编辑器现有模板是强信号：有脚手架/Begin-End 标记 → 大概率代码题
    //（初始探测时编辑器可能在隐藏 tab 里，取不到就传空串，仅靠题干判定）
    code_template: String(codeTemplate ?? '').slice(0, 600),
  });
  // 预算从能力配置读取（单一数据源）。max_tokens 只是上限、不预扣费用：
  // 推理模型（输出 reasoning_content）会先花预算思考，过小的上限会让
  // content 恒为空（finish_reason=length），重试也无法恢复。
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature ?? 0,
    maxTokens: cap.formValue?.modelParams?.maxTokens ?? 2048,
  });
  // 只认 cmdline / mixed；其余（code/无法解析/超长噪声）一律保守回落代码题
  const m = String(content ?? '').match(/\b(cmdline|mixed)\b/i);
  return m ? m[1].toLowerCase() : 'code';
}

/** 解析命令序列输出：剥 markdown 围栏，跳过空行、注释行与提示符行。
 * @param {string} text
 * @returns {string[]}
 */
export function parseCommandLines(text) {
  // 剥 ``` 围栏：**逐行**剥，不能只剥首尾（2026-09-23 真机）。模型按小节输出时会给
  // 多组围栏，首尾剥法留下的段间围栏被当成命令**键入真实终端**——日志实录「命令 5: ```」
  // 「命令 6: ```bash」，随后 mongo 报 `SyntaxError: unterminated string literal @(shell):1:2`，
  // 混合题的数据准备两轮全灭（导入因此从未成功）。
  // 判据：整行只有围栏 + 可选语言名；任何真实 shell 命令都不可能只是一行围栏。
  const t = String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*```[A-Za-z0-9_+-]*\s*$/.test(l))
    .join('\n')
    .trim();
  return (
    t
      .split(/\r?\n/)
      // 只去行尾空白：行首缩进必须保留——heredoc 写 YAML/配置时缩进即语法，
      // 上一版 l.trim() 把缩进剥成扁平键值对 → mongod 报 Unrecognized option
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => {
        const s = l.trim();
        return s && !s.startsWith('#') && !s.startsWith('//');
      })
      // 提示符剥离（2026-09-09 修复）：旧通用式 /^[\w.:@~-]+\s*[>#]\s+/ 会把
      // `cat > file <<'EOF'` 误判为 REPL 提示符，剥掉 "cat > " 前缀致写文件
      // 命令全灭（-bash: …: No such file or directory），且反射重试永远复现
      // ——解析器确定性缺陷是反思无法收敛的根因。现按提示符形态分别匹配，
      // 一律要求提示符字符紧跟词尾（中间无空格），`cat > file`、`sort > out`
      // 等重定向命令不再被误伤：
      .map((l) =>
        l
          .replace(/^\([^)]*\)[>#]\s*/, '') // (x)> / (connect)> 括号形态
          .replace(/^\$\s*/, '') // $ 提示符
          .replace(/^[\w.:@~-]*@[\w.:@~-]*[#$]\s*/, '') // user@host:# / user@host:$
          .replace(/^(?:ba|z|da)?sh-\d[\d.]*[#$]\s*/, '') // bash-5.1# / sh-4.4#
          .replace(
            // 已知 REPL 名（> 紧跟词尾，无空格）
            /^(?:testdb|mongosh|mongo|mysql|redis-cli|redis|psql|neo4j|cypher-shell|hbase|influx|sqlite3?|duckdb)[>#]\s*/i,
            '',
          ),
      )
      .filter((l) => l.length > 0)
  );
}

/**
 * 命令行题命令生成：复用 cmdline_runner_1 的 prompt 与参数
 * @returns {Promise<string[]>} 按执行顺序排列的命令
 */
export async function generateCommands({ problem, extra = '', terminalState = '' }) {
  const cap = readCapability('cmdline_runner_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    problem_description: problem,
    additional_requirements: extra,
    terminal_state: terminalState,
  });
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature ?? 0.2,
    maxTokens: cap.formValue?.modelParams?.maxTokens ?? 4096,
  });
  return parseCommandLines(content);
}

/**
 * 命令行题反思修复：复用 cmdline_reflection_fixer_1 的 prompt 与参数
 * @returns {Promise<{analysis: string, commands: string[]}>}
 */
export async function reflectCommands({
  problem,
  previousCommands,
  evalResult,
  terminalState = '',
  lessons = [],
}) {
  const cap = readCapability('cmdline_reflection_fixer_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    problem_description: problem,
    previous_commands: (previousCommands ?? []).join('\n'),
    eval_result: evalResult,
    terminal_state: terminalState,
    lessons: lessons.map((l, i) => `第${i + 1}轮教训：${l}`).join('\n'),
  });
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature ?? 0.2,
    maxTokens: cap.formValue?.modelParams?.maxTokens ?? 4096,
    // 反思直接关思考：同 reflectAndFix——预期/实际明细已在提示词中，长思考
    // 只会穷举假设并击穿预算（2026-09-10 实测 2.5 万字思考、正文恒 0）
    enableThinking: false,
  });
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 约定第一行为「分析: ...」，解析失败时整体当命令处理（分析行会被提示符过滤兜不住，故显式剥）
  let analysis = '';
  let body = lines;
  if (lines.length && /^(分析|analysis)\s*[:：]/i.test(lines[0])) {
    analysis = lines[0].replace(/^(分析|analysis)\s*[:：]\s*/i, '');
    body = lines.slice(1);
  }
  const commands = parseCommandLines(body.join('\n'));
  return { analysis, commands };
}

/**
 * 数据库命令题 echo 双引号包裹兜底（1.0.1，确定性规则、不依赖模型自觉）。
 *
 * 背景（2026-09-11 真机，EduCoder 平台机制破译后）：平台对代码栏内容（提交为
 * query.sh）双重执行——① bash 环节：裸 REPL 语句的 ( { [ 必报 syntax error，stderr
 * 进实际输出（3 个测试点标签之前）；② 数据库 eval 环节：每测试点只提取 echo "..."
 * 双引号内的命令、反转义 \$→$、分号切分逐条执行（输出在标签后）。AI 即使被生成
 * 守则要求，仍可能输出裸命令（不包 echo）→ bash 报错污染实际输出导致不匹配。
 * 与其烧一轮评测等反思猜，不如提交前确定性包裹。
 *
 * 触发条件（避免误伤普通编程题）：内容含 db.<集合>.<方法>( 的数据库命令
 * （insert/insertMany/aggregate/runCommand/createIndex/find/update/remove/drop/count 等）
 * 且整段尚未被 echo 包裹。包裹时把裸 $ 转义为 \$（echo 双引号内防 bash 展开；
 * 平台 eval 会反转义还原），已转义的 \$ 保持不变（幂等）。
 *
 * @param {string} text 整段提交内容（含 Begin/End 注释）
 * @returns {{code: string, wrapped: boolean}}
 */
export function wrapDbCommandsInEcho(text) {
  const src = String(text ?? '');
  // 触发条件收紧（1.1.0 通用性）：仅当「代码栏主体是 db.<集合>.<方法>( 数据库命令集」
  // 且未被 echo 包裹时才包裹——避免误伤编程题（Python/Java/Node 脚本里可能含 db.
  // 调用或字符串字面量）与其它平台命令（SELECT/use 等）。判据：
  //  ① 行级统计：与破坏性剔除/形态判据**共用同一份** looksLikeDbScript（≥70% 数据库
  //    语句行；1.6.21 前这里内联的统计只认 db./use，与共享判据分叉——含 show dbs 的
  //    正文会被判成"db 脚本"却不会被包裹）；
  //  ② 排除明显编程语言特征（函数/类/导入/赋值/控制流等）开头。
  const sub = submissionBody(src);
  const lines = sub.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { code: src, wrapped: false };
  if (
    /^(def |function |class |import |from |const |let |var |#include|public |private |static |print\(|console\.|System\.out|cout|return )/.test(
      lines[0],
    )
  ) {
    return { code: src, wrapped: false };
  }
  if (!looksLikeDbScript(sub.body)) return { code: src, wrapped: false };
  if (/echo\s*"/.test(src)) return { code: src, wrapped: false };
  const escapeDollar = (s) => s.replace(/(?<!\\)\$/g, '\\$');
  if (!sub.bare) {
    const wrapped = `echo "\n${escapeDollar(sub.body)}\n"`;
    return { code: `${sub.head}${wrapped}${sub.tail}`, wrapped: true };
  }
  return { code: `echo "\n${escapeDollar(src)}\n"`, wrapped: true };
}

/**
 * shell/数据库脚本书写护栏（0.9.1，确定性规则、不依赖模型自觉）。
 *
 * 背景（2026-09-10 真机事故）：反思 AI 把评测面板的中文标签（"输出集合前3条
 * 文档: "）误判为输出要求，把「中文标签: 命令」整行写进代码栏——平台把代码栏
 * 内容逐行送 mongo shell eval，行首中文直接报 `SyntaxError: illegal character
 * @(shell eval):1:9`（列号 = 标签第 9 字，与三条报错逐一吻合）。
 * 与其烧一轮评测等反思猜，不如提交前确定性清洗。
 *
 * 触发条件（避免误伤普通编程题）：内容含 db.<集合>. 调用 / mongo 痕迹。
 * 普通编程题（Python/Java 等，中文字符串输出合法）零触发。
 *
 * 规则（逐行）：
 *   1. 全角分号「；」→「;」（题干字面常写"以分号；隔开"，照抄即非法）；
 *   2. 非注释行行首为 CJK（裸中文标签行）→ 取最后一个全/半角冒号之后的
 *      命令部分（以 ASCII 字母/$/_ 开头才认）；取不到则整行剔除；
 *   3. 注释行（// /* * #）与字符串字面量中的中文不受影响（不触发行首规则）。
 *
 * @param {string} text 单条命令或整段提交内容
 * @returns {{code: string, changes: string[]}} changes 为空数组表示未触发
 */
export function sanitizeShellSubmission(text) {
  const src = String(text ?? '');
  if (!/\bdb\s*\.|\bmongo(?:sh)?\b/i.test(src)) return { code: src, changes: [] };
  const changes = [];
  const out = src.split(/\r?\n/).map((line) => {
    const t = line.trim();
    // 注释行不处理（mongo shell 认 // 与 /* */ 注释；# 行可能是 heredoc 约定）
    if (!t || /^\/\//.test(t) || /^\/\*/.test(t) || /^[*#]/.test(t)) return line;
    let cur = line;
    if (cur.includes('；')) {
      cur = cur.replace(/；/g, '; ');
      changes.push(`全角分号「；」→「;」（原文：${t.slice(0, 50)}）`);
    }
    // 行首 CJK（含全角标点）：裸中文标签行
    if (/^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(cur.trim())) {
      // 取「第一个」冒号作为标签分隔符：标签必然位于命令之前，而命令内部
      // 也会出现冒号（如 sort({learning_num:1})）——用 lastIndexOf 会被
      // 命令自身的冒号截走，把整条合法命令误剔（0.9.1 测试 c2 实证）
      const idxFull = cur.indexOf('：');
      const idxHalf = cur.indexOf(':');
      const idx = Math.min(...[idxFull, idxHalf].filter((i) => i >= 0));
      const rest = Number.isFinite(idx) ? cur.slice(idx + 1).trim() : '';
      if (rest && /^[A-Za-z_$]/.test(rest)) {
        changes.push(`剥离中文标签「${t.slice(0, 24)}…」→ 仅保留命令部分「${rest.slice(0, 40)}」`);
        cur = rest;
      } else {
        changes.push(`剔除裸中文行「${t.slice(0, 40)}」（shell 脚本中该行非法）`);
        return '';
      }
    }
    return cur;
  });
  return { code: out.join('\n'), changes };
}

// EXPORTS: chat, generateCode, reflectAndFix, extractCodeFromMarkdown,
//          splitAnalysisAndCode, detectVerdict, listChatModels,
//          classifyProblemIntent, generateCommands, reflectCommands, parseCommandLines
// AI 调用层。
// 设计要点：
//   1. prompt 单一数据源 —— 直接读取仓库根 shared/capabilities/*.json 中的 prompt 模板，
//      不做复制粘贴，避免 prompt 多份漂移。
//   2. 成功判定在此做了加固（见 detectVerdict 注释），比朴素关键词
//      匹配更保守，避免 "未通过" 命中 "通过" 这类误判。

import fs from 'node:fs';
import path from 'node:path';
import { cfg, assertAiReady } from './config.mjs';

const CAP_DIR = cfg.paths.capabilitiesDir;

function readCapability(id) {
  const p = path.join(CAP_DIR, `${id}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`找不到能力配置文件：${p}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 渲染 {{input.xxx}} 占位符；缺失变量渲染为空串（与原平台行为一致） */
export function renderTemplate(tpl, vars = {}) {
  return String(tpl ?? '').replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key]),
  );
}

function log(msg) {
  console.log(`[ai] ${msg}`);
}

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
  let forceThinkingOff = false; // 上一轮思考超限 → 重试强制关思考

  const maxAttempts = opts.maxAttempts ?? 2;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
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
    let content = '';
    let reasoning = '';
    let finish = '';
    let capped = false; // 本次轮次是否因思考超限被主动断流
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
        //（vLLM 系常见）。命中特征时把预算降到保守值 8192，让下一次重试
        // 立即生效。
        if (
          res.status === 400 &&
          body.max_tokens > 8192 &&
          /(max_tokens|max_output_tokens|max_model_len|context)/i.test(text)
        ) {
          body.max_tokens = 8192;
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
      // 耗尽（确定性失败，重试无效），把思考尾部带出来便于定位
      if (!content.trim()) {
        const hint =
          finish === 'length'
            ? `finish_reason=length：max_tokens=${body.max_tokens} 预算耗尽（思考 ${reasoning.length} 字），请调大该调用的 maxTokens｜思考尾部：${reasoning.slice(-120).replace(/\s+/g, ' ')}`
            : '流式响应结束但无正文内容';
        throw new Error(`AI 返回内容为空（${hint}）`);
      }
      return {
        content,
        raw: { finish_reason: finish, reasoning_length: reasoning.length },
      };
    } catch (err) {
      if (capped) {
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
      clearTimeout(idle);
      clearInterval(hb);
    }
  }
  throw new Error(`AI 调用失败（已重试 ${maxAttempts} 次）：${lastErr?.message}`);
}

/**
 * 代码补全：复用 code_completion_generator_1 的 prompt 与参数
 * @returns {Promise<string>} 完整可提交代码
 */
export async function generateCode({ problem, codeTemplate, extra = '' }) {
  const cap = readCapability('code_completion_generator_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    problem_description: problem,
    code_template: codeTemplate,
    additional_requirements: extra,
  });
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature,
    maxTokens: cap.formValue?.modelParams?.maxTokens,
  });
  return extractCodeFromMarkdown(content);
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
    console.warn(
      `[ai] 批量作答第 ${attempt} 次未解析出答案，原始输出：${last.raw.slice(0, 150)}`,
    );
  }
  return last;
}

/**
 * 反思修复：复用 code_reflection_fixer_1 的 prompt 与参数
 * @returns {Promise<{analysis: string, code: string}>}
 */
export async function reflectAndFix({ problem, previousCode, evalResult }) {
  const cap = readCapability('code_reflection_fixer_1');
  const prompt = renderTemplate(cap.formValue.prompt, {
    problem_description: problem,
    previous_code: previousCode,
    evaluation_result: evalResult,
  });
  const { content } = await chat([{ role: 'user', content: prompt }], {
    temperature: cap.formValue?.modelParams?.temperature ?? 0.4,
    maxTokens: cap.formValue?.modelParams?.maxTokens,
    reasoningEffort: 'low', // 反思降档：证据已在提示词中，low 档思考足够且更快
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
 * @param {string} originalTemplate 写入前从编辑器读取的原始模板（含 Begin/End 标记）
 * @param {string} aiOutput AI 返回的完整输出（可能含标记，也可能仅含代码体）
 * @returns {string} 可直接写入编辑器的最终代码
 */
export function spliceIntoTemplate(originalTemplate, aiOutput) {
  const orig = String(originalTemplate ?? '');
  const ai = String(aiOutput ?? '');

  const origBegin = findMarkerLine(orig, 'Begin');
  const origEnd = findMarkerLine(orig, 'End');
  // 原始模板无标记：纯编辑器，直接信任 AI 输出（已做 markdown 抽取）
  if (origBegin < 0 || origEnd < 0 || origEnd <= origBegin) {
    return ai.trim();
  }

  const origLines = orig.split(/\r?\n/);
  const head = origLines.slice(0, origBegin + 1); // 含 Begin 标记行
  const tail = origLines.slice(origEnd);           // 含 End 标记行

  // 从 AI 输出里取标记之间的代码体；若 AI 也未带标记，则把整段当作代码体
  const aiBegin = findMarkerLine(ai, 'Begin');
  const aiEnd = findMarkerLine(ai, 'End');
  let body;
  if (aiBegin >= 0 && aiEnd >= 0 && aiEnd > aiBegin) {
    body = ai.split(/\r?\n/).slice(aiBegin + 1, aiEnd).join('\n');
  } else {
    body = ai;
  }

  return [...head, body.trim(), ...tail].join('\n');
}

/**
 * 定位 Begin/End 标记行号。
 * 容错：不限定 # 注释前缀、星号数量；但要求行内同时含一个 ≥3 的装饰符串
 * （* / = / # / -），以区分平台标记与代码里可能出现的 begin/end 关键字
 * （如 Redis 事务里的 "BEGIN"）。
 * @returns {number} 行号，未找到返回 -1
 */
function findMarkerLine(text, keyword) {
  const kw = keyword === 'Begin' ? /\bbegin\b/i : /\bend\b/i;
  const deco = /[*=#-]{3,}/;
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (kw.test(lines[i]) && deco.test(lines[i])) return i;
  }
  return -1;
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
 * @returns {Promise<'code'|'cmdline'>}
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
  // 只认 cmdline 为命令行；其余（code/无法解析/超长噪声）一律保守回落代码题
  return /\bcmdline\b/i.test(content.trim()) ? 'cmdline' : 'code';
}

/** 解析命令序列输出：剥 markdown 围栏，跳过空行、注释行与提示符行。
 * @param {string} text
 * @returns {string[]}
 */
export function parseCommandLines(text) {
  let t = String(text ?? '').trim();
  // 剥 ``` 围栏（宽容处理不配对的围栏）
  t = t.replace(/^```(?:sh|shell|bash|console)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  return t
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
        .replace(/^\([^)]*\)[>#]\s*/, '')                     // (x)> / (connect)> 括号形态
        .replace(/^\$\s*/, '')                                // $ 提示符
        .replace(/^[\w.:@~-]*@[\w.:@~-]*[#$]\s*/, '')         // user@host:# / user@host:$
        .replace(/^(?:ba|z|da)?sh-\d[\d.]*[#$]\s*/, '')       // bash-5.1# / sh-4.4#
        .replace(                                             // 已知 REPL 名（> 紧跟词尾，无空格）
          /^(?:testdb|mongosh|mongo|mysql|redis-cli|redis|psql|neo4j|cypher-shell|hbase|influx|sqlite3?|duckdb)[>#]\s*/i,
          '',
        ),
    )
    .filter((l) => l.length > 0);
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
export async function reflectCommands({ problem, previousCommands, evalResult, terminalState = '', lessons = [] }) {
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

// EXPORTS: chat, generateCode, reflectAndFix, extractCodeFromMarkdown,
//          splitAnalysisAndCode, detectVerdict, listChatModels
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

/** OpenAI 兼容 chat/completions，带指数退避重试 */
export async function chat(messages, opts = {}) {
  assertAiReady();
  const url = `${cfg.ai.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: opts.model ?? cfg.ai.model,
    messages,
    temperature: opts.temperature ?? cfg.ai.temperature,
    max_tokens: opts.maxTokens ?? cfg.ai.maxTokens,
    stream: false,
  };

  const maxAttempts = opts.maxAttempts ?? 3;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.ai.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      // 空内容必须视为失败：上游偶发会返回 200 + 空字符串，若不判空会被当成
      // 正常结果放行（实测曾导致批量答案整体为空）。判空后可触发下面的重试。
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`AI 返回内容为空：${JSON.stringify(json).slice(0, 300)}`);
      }
      return { content, raw: json };
    } catch (err) {
      lastErr = err;
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** i));
      }
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
  });
  return splitAnalysisAndCode(content);
}

/** 从 AI 输出中抽取 markdown 代码块 */
export function extractCodeFromMarkdown(markdown) {
  const m = String(markdown ?? '').match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (m && m[1]) return m[1].trim();
  return String(markdown ?? '').trim();
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

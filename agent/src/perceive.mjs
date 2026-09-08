// EXPORTS: probePage, readEditorCode, findClickable, writeEditorCode, dumpProbe
// 页面感知层。
//
// 设计原则：**不硬编码任何站点 selector**。所有识别走启发式——
//   - 编辑器：按优先级探测 Monaco / Ace / CodeMirror5 / CodeMirror6 / textarea
//   - 题目区：在排除编辑器容器后，取 innerText 最长且在视口左侧的块
//   - 题型：按页面上存在的输入控件分类（单选/复选/文本填空/代码编辑器）
//   - 按钮：只返回文本与可点击性，实际点击交给 act.mjs 用 Playwright locator 完成
// 这样同一套代码能适配不同评测平台；遇到识别不准的站点，用 `npm run dump` 导出快照
// 后再针对性加规则。

import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.mjs';

/** 在浏览器上下文执行：探测编辑器类型 */
const DETECT_EDITOR = () => {
  const q = (s) => document.querySelector(s);
  if (q('.monaco-editor')) return { type: 'monaco', hint: '.monaco-editor' };
  if (q('.ace_editor')) return { type: 'ace', hint: '.ace_editor' };
  if (q('.CodeMirror')) return { type: 'codemirror5', hint: '.CodeMirror' };
  if (q('.cm-editor')) return { type: 'codemirror6', hint: '.cm-editor' };
  const ta = q('textarea');
  if (ta) return { type: 'textarea', hint: 'textarea' };
  const ce = q('[contenteditable="true"]');
  if (ce) return { type: 'contenteditable', hint: '[contenteditable="true"]' };
  return null;
};

/** 在浏览器上下文执行：按编辑器类型读取当前代码 */
const READ_CODE = (type) => {
  const q = (s) => document.querySelector(s);
  switch (type) {
    case 'codemirror5': {
      const el = q('.CodeMirror');
      if (el?.CodeMirror?.getValue) return el.CodeMirror.getValue();
      return el?.innerText ?? '';
    }
    case 'codemirror6': {
      const el = q('.cm-content');
      return el?.innerText ?? '';
    }
    case 'monaco': {
      const el = q('.view-lines');
      return el?.innerText ?? '';
    }
    case 'ace': {
      const el = q('.ace_content');
      return el?.innerText ?? '';
    }
    case 'textarea': {
      return q('textarea')?.value ?? '';
    }
    case 'contenteditable': {
      return q('[contenteditable="true"]')?.innerText ?? '';
    }
    default:
      return '';
  }
};

/** 在浏览器上下文执行：提取题目正文（启发式：排除编辑器后取最长文本块） */
const READ_PROBLEM = () => {
  const editorRoots = Array.from(
    document.querySelectorAll(
      '.monaco-editor, .ace_editor, .CodeMirror, .cm-editor, textarea, [contenteditable="true"]',
    ),
  );
  const isInsideEditor = (el) => editorRoots.some((r) => r === el || r.contains(el));

  const candidates = Array.from(
    document.querySelectorAll('article, main, section, aside, div, td'),
  ).filter((el) => {
    if (isInsideEditor(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 60) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    return true;
  });

  let best = null;
  let bestScore = -1;
  for (const el of candidates) {
    const text = (el.innerText ?? '').trim();
    if (text.length < 40) continue;
    // 评分：文本长度为主，左侧位置加权（题目要求通常在左栏）
    const r = el.getBoundingClientRect();
    const leftBonus = r.left < window.innerWidth * 0.5 ? 1.35 : 1;
    // 惩罚嵌套过深的容器（往往是最外层 wrapper）
    const depthPenalty = 1 / (1 + 0.02 * (el.querySelectorAll('*').length / 50));
    const score = text.length * leftBonus * depthPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = { text, rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
    }
  }
  return best;
};

/** 在浏览器上下文执行：统计输入控件，用于题型分类 */
const READ_INPUTS = () => {
  const radios = document.querySelectorAll('input[type="radio"]').length;
  const checks = document.querySelectorAll('input[type="checkbox"]').length;
  const texts = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).length;
  const labels = Array.from(document.querySelectorAll('input[type="radio"]')).map((r) => {
    const lab = r.closest('label')?.innerText ?? document.querySelector(`label[for="${r.id}"]`)?.innerText ?? '';
    return lab.trim().slice(0, 120);
  });
  return { radios, checks, texts, choiceLabels: labels };
};

/**
 * 在浏览器上下文执行：结构化提取每道小题（题干 + 选项 + 单选/多选）
 *
 * 针对 Ant Design 风格的选择题容器：
 *   ul.choose-container > li > [div(题干), div.option > a.flex-container > label > input]
 * 关键点：选项文本挂在 `a` 上，不在 `label` 内（label 只包裹 input + 装饰 span），
 * 所以必须从 `a` 层取文本，否则拿到的全是空串。
 * 若页面不是该结构，返回空数组，由调用方回退到通用逻辑。
 */
const READ_QUESTIONS = () => {
  const ul = document.querySelector('ul.choose-container');
  if (!ul) return [];
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  return Array.from(ul.children).map((li, i) => {
    const kids = Array.from(li.children);
    const stem = norm(kids[0]?.innerText);
    const optWrap = kids.find((k) => k.querySelector('input'));
    const anchors = Array.from(optWrap?.querySelectorAll('a') ?? []);
    const options = anchors
      .map((a) => ({ text: norm(a.innerText), type: a.querySelector('input')?.type ?? '' }))
      .filter((o) => o.text && o.type);
    return {
      no: i + 1,
      stem,
      options: options.map((o) => o.text),
      multi: options.some((o) => o.type === 'checkbox'),
    };
  }).filter((q) => q.options.length > 0);
};

/** 在浏览器上下文执行：列出可点击元素的文本（供按钮定位与 dump 排错） */
const READ_CLICKABLES = () => {
  const out = [];
  const sel = 'button, a, [role="button"], input[type="button"], input[type="submit"], .btn, [class*="btn"]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    if (!text) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 40),
      cls: (el.className || '').toString().slice(0, 60),
      visible: r.width > 0 && r.height > 0,
    });
  }
  return out.slice(0, 80);
};

/** 在浏览器上下文执行：尝试抓取评测结果面板文本 */
const READ_EVAL_PANEL = () => {
  const kw = ['评测', '测试', '结果', '运行', '输出', '通过', '用例', 'result', 'output', 'console'];
  const cands = Array.from(document.querySelectorAll('div, section, pre, article')).filter((el) => {
    const t = (el.innerText ?? '').trim();
    if (t.length < 10 || t.length > 4000) return false;
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 30;
  });
  let best = null;
  let bestLen = 0;
  for (const el of cands) {
    const t = (el.innerText ?? '').trim();
    const hit = kw.some((k) => t.includes(k));
    if (!hit) continue;
    // 取最长的匹配块（结果面板通常内容最多）
    if (t.length > bestLen && el.querySelectorAll('div,section,pre').length < 12) {
      bestLen = t.length;
      best = t;
    }
  }
  return best;
};

/**
 * 探测当前页面（含所有 frame）的完整结构快照
 * @param {import('playwright-core').Page} page
 */
export async function probePage(page) {
  // 编辑器可能在 iframe 内，遍历所有 frame 找第一个带编辑器的
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  let editor = null;
  let editorFrameIdx = -1;

  for (let i = 0; i < frames.length; i++) {
    try {
      const ed = await frames[i].evaluate(DETECT_EDITOR);
      if (ed) {
        editor = ed;
        editorFrameIdx = i;
        break;
      }
    } catch {
      /* frame 可能已 detach，忽略 */
    }
  }

  const main = page.mainFrame();
  const problem = await main.evaluate(READ_PROBLEM).catch(() => null);
  const inputs = await main.evaluate(READ_INPUTS).catch(() => ({ radios: 0, checks: 0, texts: 0, choiceLabels: [] }));
  const questions = await main.evaluate(READ_QUESTIONS).catch(() => []);
  const clickables = await main.evaluate(READ_CLICKABLES).catch(() => []);
  const evalPanel = await main.evaluate(READ_EVAL_PANEL).catch(() => null);

  let code = '';
  if (editor && editorFrameIdx >= 0) {
    code = await frames[editorFrameIdx]
      .evaluate(READ_CODE, editor.type)
      .catch(() => '');
  }

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    editor,
    editorFrameIdx,
    code,
    problem: problem?.text ?? '',
    problemRect: problem?.rect ?? null,
    inputs,
    questions,
    clickables,
    evalPanel: evalPanel ?? '',
    taskType: classifyTask({ editor, inputs }),
  };
}

/**
 * 题型分类
 * @returns {'code'|'choice'|'blank'|'unknown'}
 */
export function classifyTask({ editor, inputs }) {
  const { radios = 0, checks = 0, texts = 0 } = inputs ?? {};
  if (editor && (editor.type === 'monaco' || editor.type === 'ace' || editor.type.startsWith('codemirror') || editor.type === 'textarea')) {
    return 'code';
  }
  if (radios > 0 || checks > 0) return 'choice';
  if (texts > 0) return 'blank';
  return 'unknown';
}

/**
 * 读取编辑器当前代码
 * @param {import('playwright-core').Page} page
 */
export async function readEditorCode(page) {
  const p = await probePage(page);
  return p.code ?? '';
}

/**
 * 在页面上按文本查找可点击元素，返回 Playwright locator（未点击）
 * 按关键词顺序匹配，返回第一个命中的
 * @param {import('playwright-core').Page} page
 * @param {string[]} keywords 如 ['评测','提交','运行']
 */
export function findClickable(page, keywords) {
  for (const kw of keywords) {
    const loc = page.getByRole('button', { name: kw, exact: false }).first();
    // 先不 await，交给调用方决定是否点击/计数
    return { keyword: kw, locator: loc };
  }
  return null;
}

/**
 * 写入代码到编辑器。
 * 策略：聚焦 → 全选 → 键盘插入。对 CodeMirror / Monaco / textarea 均适用，
 * 且能触发编辑器的 change 事件与平台自动保存（比直接改 DOM 更可靠）。
 * @param {import('playwright-core').Page} page
 * @param {string} code
 */
export async function writeEditorCode(page, code) {
  const probe = await probePage(page);
  if (!probe.editor) throw new Error('未识别到代码编辑器，无法写入');

  const target = probe.editorFrameIdx === 0
    ? page.mainFrame()
    : page.frames()[probe.editorFrameIdx] ?? page.mainFrame();

  const selectorMap = {
    monaco: '.monaco-editor .view-lines',
    ace: '.ace_editor .ace_content',
    codemirror5: '.CodeMirror .CodeMirror-lines',
    codemirror6: '.cm-editor .cm-content',
    textarea: 'textarea',
    contenteditable: '[contenteditable="true"]',
  };
  const sel = selectorMap[probe.editor.type];
  if (!sel) throw new Error(`不支持的编辑器类型：${probe.editor.type}`);

  const el = target.locator(sel).first();
  await el.click({ timeout: 10000 });
  // 全选后整体覆盖输入
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(code);
  return { type: probe.editor.type, length: code.length };
}

/**
 * 导出页面结构快照到 agent/dumps/，用于针对具体站点精调规则
 * @param {import('playwright-core').Page} page
 */
export async function dumpProbe(page, tag = 'probe') {
  const probe = await probePage(page);
  const dir = cfg.paths.dumpDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${tag}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(probe, null, 2), 'utf8');
  return { file, probe };
}

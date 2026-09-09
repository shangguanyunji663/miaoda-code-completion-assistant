// EXPORTS: probePage, readEditorCode, findClickable, writeEditorCode, dumpProbe,
//          collectCards, collectSections, collectCardCandidates, readEvalPanel, dumpCourseProbe
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
  const kw = ['评测', '测试', '结果', '运行', '输出', '通过', '用例', '不匹配', '错误', 'result', 'output', 'console', 'error'];
  // 除常规容器外，补充按 class 关键词匹配的候选：结果区常挂在
  // result/output/eval/console/modal/message/toast 之类的类名上
  const sel =
    'div, section, pre, article, code, [class*="result"], [class*="output"], [class*="eval"], [class*="console"], [class*="message"], [class*="modal"], [class*="panel"], [class*="toast"]';
  const cands = Array.from(document.querySelectorAll(sel)).filter((el) => {
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
    // 取最长的匹配块（结果面板通常内容最多）；嵌套上限放宽到 20，兼容弹窗结构
    if (t.length > bestLen && el.querySelectorAll('div,section,pre').length < 20) {
      bestLen = t.length;
      best = t;
    }
  }
  return best;
};

/**
 * 轻量读取评测结果面板：只扫结果区，不跑全页探测。
 * 与 probePage 的区别：probe 每次要取题干/输入控件/可点击元素等一大堆，
 * 单轮轮询要执行多次 evaluate（重页面上秒级）；本函数每个 frame 只执行一次
 * evaluate，轮询延迟从秒级降到百毫秒级。主 frame 优先，其次各 iframe——
 * 部分平台把评测输出渲染在 iframe 里，只扫主页面会一直拿空。
 */
export async function readEvalPanel(page) {
  const main = page.mainFrame();
  const frames = [main, ...page.frames().filter((f) => f !== main)];
  for (const f of frames) {
    try {
      const t = await f.evaluate(READ_EVAL_PANEL);
      if (t) return t;
    } catch {
      /* frame 可能已 detach，跳过 */
    }
  }
  return '';
}

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

// ---- 课程列表页感知（course 模式） ----

/**
 * 在浏览器上下文执行：收集列表页所有「开始学习」卡片。
 * 返回 [{ title, done, total }]：title 取卡片文本中最长的一行（标题必然比
 * 状态徽标/作者/日期/进度长）；done/total 解析 "0/6" 型进度，全等时调用方跳过。
 */
const COLLECT_CARDS = () => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // 剔除字母/数字/空白以外的字符（图标字体私有区字符、emoji 等），再归一空白
  const clean = (s) => norm(String(s ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' '));
  // 先用 textContent 粗筛（不触发 layout），再 innerText 精确比对
  // （大页面上对数千节点逐个取 innerText 会强制重排，非常慢）
  const nodes = Array.from(
    document.querySelectorAll('a, button, span, div, li, p, i, em, b, td'),
  )
    .filter((el) => (el.textContent || '').includes('开始学习'))
    // 不能用 innerText 直接全等：图标字体（Ant Design 等用私有区字符）会混进
    // innerText，如 "\uE87D开始学习"；有的站点还用 letter-spacing 排版产生空格。
    // 剔除非字母数字字符后再去掉全部空白比对，两种情况都能命中
    .filter((el) => clean(el.innerText).replace(/\s/g, '') === '开始学习');
  // 只保留最内层命中节点，避免父子重复计数
  const leaves = nodes.filter((el) => !nodes.some((o) => o !== el && el.contains(o)));
  const out = [];
  for (const el of leaves) {
    // 向上爬到卡片行。旧判据"父文本严格更长"在按钮的三层同文本嵌套容器上
    // （actionIcon > flexBox > div，innerText 全是"开始学习"）第一步就断掉，
    // row 停在叶子上 → 标题过滤后为空 → 0 卡片（真实页面实测踩坑）。
    // 新判据：当前行还不含进度 n/n 且父级仍含「开始学习」就继续爬，
    // 停在第一个含进度的祖先（即 info/listItem 卡片行）。
    let row = el;
    for (let i = 0; i < 12 && row.parentElement; i++) {
      if (/\d\s*\/\s*\d/.test(norm(row.innerText))) break;
      const pt = norm(row.parentElement.innerText);
      if (!pt.includes('开始学习')) break;
      row = row.parentElement;
    }
    // 必须用原始 innerText 按行切分后再逐行归一：norm 会把 \n 吞成空格，
    // 导致整个卡片行变成一行、最长行过滤失效（真实页面实测踩坑）
    const lines = (row.innerText || '').split('\n').map(norm).filter(Boolean);
    const meta = /^(提交中|补交中|已截止|开始学习)$/;
    const title = lines
      .filter(
        (l) => !meta.test(l) && !/^20\d{2}-\d{2}-\d{2}/.test(l) && !/^\d+\s*\/\s*\d+$/.test(l),
      )
      .reduce((a, b) => (b.length >= a.length ? b : a), '');
    const prog = norm(row.innerText).match(/(\d+)\s*\/\s*(\d+)/);
    if (title) {
      // 点击目标是「开始学习」按钮本身（书本图标+文字的可点容器 actionIcon），
      // 不是整张卡片行：从文本叶子向上找 cursor:pointer 的最近祖先，最多 2 层
      // （实测结构 div > aside.flexBox > div.actionIcon，正好落在按钮容器上，
      // 爬太多层会误标整个标题行）
      let target = el;
      try {
        for (let i = 0; i < 2 && target.parentElement; i++) {
          const p = target.parentElement;
          if (getComputedStyle(p).cursor === 'pointer') target = p;
          else break;
        }
      } catch {
        /* 取不到样式就保持文本叶子 */
      }
      target.setAttribute('data-agent-target', String(out.length));
      out.push({
        title,
        done: prog ? Number(prog[1]) : null,
        total: prog ? Number(prog[2]) : null,
        btnTag: target.tagName.toLowerCase(),
        btnCls: String(target.className || '').slice(0, 80),
      });
    }
  }
  return out;
};

/**
 * 在浏览器上下文执行：收集左侧「课堂实验」下的板块名列表。
 * 定位：找文本以「课堂实验」开头的最内层元素，向上爬最多 5 层容器，
 * 收集容器内 a/li 的短文本（排除 课堂实验/通知公告 自身），>=2 条即认定是板块菜单。
 */
const COLLECT_SECTIONS = () => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // 菜单项里同样嵌着图标字体字符（innerText 形如 "\uE8B5课堂实验"），
  // startsWith 前必须先剔除字母/数字/空白以外的字符，否则 header 永远找不到
  const clean = (s) => norm(String(s ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' '));
  const els = Array.from(document.querySelectorAll('a, li, span, div'));
  // ⚠️ contains 去重必须只对「同样通过匹配的集合 m2」做：
  // 若对整个 els 做包含排除，任何容器都含别的元素 → m3 恒为空（真实页面实测踩坑）
  const m2 = els.filter(
    (el) =>
      (el.textContent || '').includes('课堂实验') && clean(el.innerText).startsWith('课堂实验'),
  );
  const header = m2.filter((el) => !m2.some((o) => o !== el && el.contains(o))).pop();
  if (!header) return [];
  let cont = header.parentElement;
  for (let d = 0; d < 5 && cont; d++) {
    const seen = new Set();
    const items = [];
    // 子板块是带 role="button" 的可拖拽 div（react-rbd），不是 a/li，
    // 必须一起查，否则侧栏永远采不到（真实页面实测踩坑）
    for (const el of cont.querySelectorAll('[role="button"], a, li')) {
      const t = clean(el.innerText);
      if (!t || t.startsWith('课堂实验') || t.startsWith('通知公告')) continue;
      // 去掉尾部数量角标后按基本名去重（draggable 与其内部 a 文本会重复）
      const base = t.replace(/\s*\d+\s*$/, '');
      if (!base || base.length > 30 || seen.has(base)) continue;
      seen.add(base);
      items.push(base);
    }
    if (items.length >= 2) return items;
    cont = cont.parentElement;
  }
  return [];
};

/** 收集列表页卡片（course 模式）；主 frame 无结果时依次尝试各 iframe */
export async function collectCards(page) {
  const main = page.mainFrame();
  const frames = [main, ...page.frames().filter((f) => f !== main)];
  for (const f of frames) {
    try {
      const r = await f.evaluate(COLLECT_CARDS);
      if (r && r.length > 0) return r;
    } catch {
      /* frame 可能已 detach，跳过 */
    }
  }
  return [];
}

/** 诊断用：采样含「开始学习」的节点；text 走 JSON 转义，可暴露图标字体等不可见字符 */
const COLLECT_CANDIDATES = () => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  return Array.from(document.querySelectorAll('a, button, span, div, li'))
    .filter((el) => (el.textContent || '').includes('开始学习'))
    .slice(0, 40)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 80),
      text: JSON.stringify(norm(el.innerText)).slice(0, 140),
    }));
};

/** 诊断：列出「开始学习」候选节点的真实文本形态（course-probe 用） */
export async function collectCardCandidates(page) {
  return page.evaluate(COLLECT_CANDIDATES).catch(() => []);
}

/** 收集左侧板块名列表（course 模式）；解析失败返回空数组 */
export async function collectSections(page) {
  return page.evaluate(COLLECT_SECTIONS).catch(() => []);
}

/** 导出课程列表页快照（含板块与卡片识别结果）到 agent/dumps/，用于精调规则 */
export async function dumpCourseProbe(page, cards, sections, tag = 'course') {
  const probe = await probePage(page);
  const dir = cfg.paths.dumpDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${tag}-${ts}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ url: page.url(), title: probe.title, sections, cards, probe }, null, 2),
    'utf8',
  );
  return { file };
}

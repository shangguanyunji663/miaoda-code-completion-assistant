// EXPORTS: checkPython2Syntax
// 写入前本地语法守卫：检出「Python 2 下必然编译失败」的 Python 3 语法。
//
// 为什么要本地查（2026-09-22 真机事故，Redis 优先级队列题）：平台运行时是
// Python 2，一个 SyntaxError 的代价是「一次写入 + 一整轮评测（本关最大执行时间
// 120 秒）+ 一轮反思」，而本地检出是免费的毫秒级检查。该轮反思给出的"修正版"
// 里 `conn.blpop(*task_lists, 10)` 正是这种错误——`*解包后再接位置参数` 是
// PEP 448（Python 3.5+）语法，Python 2 直接 SyntaxError；同时它还写了
// `if not task_lists: continue` 的零等待热自旋。两条都属于"本地一眼可判"。
//
// 边界（有意为之）：
// ① 只报「Python 2 语法层面必定失败」的构造，宁漏不误报——误报会让模型来回改
//    本来正确的代码（本项目反复吃过"横跳"的亏）；
// ② 非 Python 提交（shell / 数据库命令 / Java）整体跳过；
// ③ 检查器自身异常一律放行（fail-open），守卫不得阻断主流程。

const PY3_RULES = {
  pep448_positional_after_star:
    '调用里 *解包 之后又出现位置参数（如 f(*a, 10)）——PEP 448，Python 3.5+ 才有；Python 2 请写成 f(*(list(a) + [10])) 或 f(a, 10)',
  pep448_multi_star:
    '同一次调用里出现多个 *解包 或多个 **解包——Python 3.5+ 语法，Python 2 只允许一个 * 加一个 **',
  star_in_display:
    '列表/字典字面量里的 * 或 ** 解包（如 [*a, *b]、{**d, "k": 1}）——Python 3.5+ 语法，Python 2 请在 Python 层合并',
  dict_double_star:
    '字典字面量里的 **d 解包——Python 3.5+ 语法，Python 2 请用 d.update(...) 或 dict(d, **other)',
  fstring: 'f-string 字面量（f"..."）——Python 3.6+ 语法，Python 2 请用 % 或 .format()',
  walrus: '海象运算符 := ——Python 3.8+ 语法',
  param_annotation: '函数参数类型注解（def f(x: int)）——Python 3 语法，Python 2 请去掉注解',
  kw_only_marker:
    '仅关键字参数分隔符 def f(a, *, b) ——Python 3 语法，Python 2 请改用 dict/默认值参数',
  return_annotation: '函数返回值注解（-> T）——Python 3 语法，Python 2 请去掉注解',
  var_annotation: '变量注解（x: int = 1）——Python 3.6+ 语法',
  nonlocal: 'nonlocal 关键字——Python 3 语法，Python 2 请用可变容器（list/dict）传递状态',
  yield_from: 'yield from ——Python 3.3+ 语法，Python 2 请写 for 循环',
  async_await: 'async / await ——Python 3.5+ 语法',
  bare_super:
    '无参 super() ——Python 3 语法，Python 2 必须写 super(类名, self)（否则运行时 TypeError）',
  raise_from: 'raise X from Y ——Python 3 语法',
  except_star: 'except*（PEP 654）——Python 3.11+ 语法',
};

/** 把字符串字面量与注释替换成等长空白（保留换行），使后续规则只看代码骨架；
 *  顺带在扫描前缀时抓出 f-string（掩码后就看不见引号内容了）。 */
function maskLiterals(src) {
  let masked = '';
  const found = [];
  const isIdent = (c) => !!c && /[\w.]/.test(c);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      masked += blank(src.slice(i, j));
      i = j;
      continue;
    }
    const prefix = isIdent(src[i - 1])
      ? null
      : /^[rbufRBUF]{1,2}(?=['"])/.exec(src.slice(i, i + 3));
    if (prefix || c === "'" || c === '"') {
      const p = prefix ? prefix[0] : '';
      let j = i + p.length;
      const q = src[j];
      if (q !== "'" && q !== '"') {
        masked += c;
        i++;
        continue;
      }
      const delim = src.slice(j, j + 3) === q.repeat(3) ? q.repeat(3) : q;
      let k = j + delim.length;
      while (k < src.length) {
        if (src[k] === '\\') {
          k += 2;
          continue;
        }
        if (src.startsWith(delim, k)) {
          k += delim.length;
          break;
        }
        k++;
      }
      const text = src.slice(i, k);
      if (/[fF]/.test(p)) found.push({ index: i, rule: 'fstring', text });
      masked += blank(text);
      i = k;
      continue;
    }
    masked += c;
    i++;
  }
  return { masked, found };
}

const blank = (s) => s.replace(/[^\n]/g, ' ');

/** 索引 → 1 起始行号 */
function lineOf(index, lineStarts) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * 括号栈扫描：一次遍历同时得到
 *  ① 每个位置的括号深度（供逐行规则判断是否处于续行/字面量内部）
 *  ② 调用/字面量实参层面的 Python 3 独有语法
 * 只关心「实参起始位置」上的记号，因此 `f(a * b)` 的乘号不会被误判为解包；
 * 分组括号（`x = (a\n * 2)`）不按调用处理，避免把换行后的乘号当解包。
 */
function scanFrames(masked) {
  const hits = [];
  const depth = new Int32Array(masked.length);
  const stack = [];
  /** 前一个非空白记号（跳过空格与换行） */
  const prevToken = (idx) => {
    let j = idx - 1;
    while (j >= 0 && /[\s]/.test(masked[j])) j--;
    return { ch: j < 0 ? '' : masked[j], at: j };
  };
  /** 是否处在「实参/元素起始」位置：前面是空白 + 开括号 / 逗号 / 行首 */
  const atArgStart = (idx) => {
    let j = idx - 1;
    while (j >= 0 && (masked[j] === ' ' || masked[j] === '\t')) j--;
    const p = j < 0 ? '' : masked[j];
    return p === '' || p === '(' || p === ',' || p === '\n' || p === '[' || p === '{';
  };
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') {
      const before = masked.slice(Math.max(0, i - 40), i);
      let kind = 'group';
      if (c === '(') {
        if (/\bdef\s+[\w.]*\s*$/.test(before)) kind = 'def';
        else {
          const p = prevToken(i);
          // 调用形态：标识符 / 属性链 / 下标 之后紧跟 (
          if (/[\w)\]]/.test(p.ch)) kind = 'call';
        }
      } else if (c === '[') kind = 'list';
      else kind = 'brace';
      stack.push({ kind, star: 0, dstar: 0 });
      depth[i] = stack.length;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      depth[i] = stack.length;
      continue;
    }
    depth[i] = stack.length;
    const frame = stack[stack.length - 1];
    if (!frame) continue;

    // * / ** 出现在实参（或字面量元素）起始位置
    if (c === '*' && atArgStart(i)) {
      const dbl = masked[i + 1] === '*';
      const run = dbl ? 2 : 1;
      if (frame.kind === 'list' || frame.kind === 'brace') {
        hits.push({ index: i, rule: dbl ? 'dict_double_star' : 'star_in_display' });
      } else if (frame.kind === 'def') {
        // def f(a, *, b) → 仅关键字参数分隔符，Python 3 独有
        if (/^\s*[,)]/.test(masked.slice(i + run))) hits.push({ index: i, rule: 'kw_only_marker' });
      }
      if (frame.kind === 'call' || frame.kind === 'def') {
        if (dbl) frame.dstar++;
        else frame.star++;
        if (frame.star > 1 || frame.dstar > 1) hits.push({ index: i, rule: 'pep448_multi_star' });
      }
      i += run - 1;
      continue;
    }
    // 解包之后的位置实参（既不是 * 也不是 name= 关键字实参）
    if (
      (frame.kind === 'call' || frame.kind === 'def') &&
      frame.star + frame.dstar > 0 &&
      (/[A-Za-z0-9_'"[-]/.test(c) || c === '(' || c === '[' || c === '{') &&
      atArgStart(i)
    ) {
      const isKeyword = /^[A-Za-z_]\w*\s*=(?!=)/.test(masked.slice(i, i + 40));
      if (!isKeyword) hits.push({ index: i, rule: 'pep448_positional_after_star' });
    }
  }
  return { hits, depth };
}

/** 是否像 Python 代码：模板里有 def/class/import/python shebang 才启用守卫，
 *  shell 与数据库命令题、Java 题一律跳过（这些语言的 `:` `*` 语义完全不同）。 */
function looksLikePython(src) {
  if (/^#!.*\bpython/i.test(src)) return true;
  if (/coding[:=]\s*utf-?8/i.test(src)) return true;
  return (
    /(^|\n)\s*(?:def |class |print\s*\()/m.test(src) ||
    /\bimport\s+\w/.test(src) ||
    /(^|\n)\s*print\s+[^(\n=]/m.test(src) // Python 2 的 print 语句本身即强信号
  );
}

/** 单行规则：在掩码文本上跑，括号深度为 0 的行才允许注解类判定 */
function scanLineRules(masked, depth) {
  const hits = [];
  const lines = masked.split('\n');
  let offset = 0;
  const push = (idx, rule) => hits.push({ index: idx, rule });
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const base = offset;
    offset += line.length + 1;
    let m;
    // 海象 := （`:` 后直接跟 `=` 或空白后跟 `=`；切片的 `a[1::2]`、`a[b:]` 不匹配）
    if ((m = /(?<![:=<>!]):\s*=(?!=)/.exec(line))) push(base + m.index, 'walrus');
    if ((m = /(?<![\w-])->/.exec(line))) push(base + m.index, 'return_annotation');
    if ((m = /\bnonlocal\b/.exec(line))) push(base + m.index, 'nonlocal');
    if ((m = /\byield\s+from\b/.exec(line))) push(base + m.index, 'yield_from');
    if ((m = /\b(?:async\s+def|await)\b/.exec(line))) push(base + m.index, 'async_await');
    if ((m = /\bsuper\s*\(\s*\)/.exec(line))) push(base + m.index, 'bare_super');
    if ((m = /\braise\s+[\w.]+\s*\(\s*\)\s*from\b|\braise\s+\w+\s+from\b/.exec(line)))
      push(base + m.index, 'raise_from');
    if ((m = /\bexcept\s*\*/.exec(line))) push(base + m.index, 'except_star');
    // 变量注解：只在括号深度为 0 的行判（避免把字典字面量元素当注解）
    const lineDepth = depth[Math.min(base, depth.length - 1)];
    if (
      lineDepth === 0 &&
      (m = /^[ \t]*(?!\d)[a-z_]\w*[ \t]*:[ \t]*(?![=\d'"{[])[A-Za-z_][\w.]*/.exec(line))
    )
      push(base + m.index, 'var_annotation');
  }
  return hits;
}

/** def 参数注解：在 def 的括号帧内，实参起始处出现 `name:` 即 Python 3 语法 */
function scanDefAnnotations(masked) {
  const hits = [];
  const re = /\bdef\s+[\w.]*\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m;
  while ((m = re.exec(masked))) {
    const inner = m[1];
    for (const arg of splitTopLevel(inner)) {
      const t = arg.trim();
      if (!t) continue;
      if (/^[A-Za-z_]\w*\s*:/.test(t) || /^\*\*?\s*[A-Za-z_]\w*\s*:/.test(t)) {
        hits.push({
          index: m.index + (m[0].length - inner.length) + arg.indexOf(t),
          rule: 'param_annotation',
        });
      }
    }
  }
  return hits;
}

/** 按顶层逗号切分（忽略嵌套括号内的逗号） */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 检查 Python 提交中的 Python 3 独有语法。
 * @param {string} code 实际要写入编辑器的完整文本
 * @returns {{ok: boolean, skipped?: string, problems: Array<{line:number,col:number,rule:string,hint:string,snippet:string}>}}
 */
export function checkPython2Syntax(code) {
  const src = String(code ?? '');
  if (!src.trim()) return { ok: true, skipped: 'empty', problems: [] };
  if (!looksLikePython(src)) return { ok: true, skipped: 'not-python', problems: [] };
  try {
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
    const { masked, found } = maskLiterals(src);
    const { hits, depth } = scanFrames(masked);
    const all = [...found, ...hits, ...scanLineRules(masked, depth), ...scanDefAnnotations(masked)];
    const seen = new Set();
    const problems = [];
    for (const h of all.sort((a, b) => a.index - b.index)) {
      const ln = lineOf(h.index, lineStarts);
      const key = `${ln}:${h.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line0 = lineStarts[ln - 1] ?? 0;
      const nextNl = src.indexOf('\n', line0);
      problems.push({
        line: ln,
        col: h.index - line0 + 1,
        rule: h.rule,
        hint: PY3_RULES[h.rule] ?? h.rule,
        snippet: src
          .slice(line0, nextNl === -1 ? src.length : nextNl)
          .trim()
          .slice(0, 120),
      });
    }
    return { ok: problems.length === 0, problems };
  } catch (e) {
    // fail-open：守卫自身异常不得阻断作答
    return { ok: true, skipped: `guard-error: ${e?.message ?? e}`, problems: [] };
  }
}

/** 把检查结果渲染成喂给模型的中文说明 */
export function formatPython2Problems(problems, limit = 8) {
  return (problems ?? [])
    .slice(0, limit)
    .map((p) => `- 第 ${p.line} 行｜${p.hint}\n  ${p.snippet}`)
    .join('\n');
}

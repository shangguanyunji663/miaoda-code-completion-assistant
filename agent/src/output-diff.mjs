// EXPORTS: splitExpectedActual, diffOutputs, describeOutputDiff
// 输出差异定位器（1.6.4）：把"预期 vs 实际"的实质差异**算出来**再交给反思，而不是
// 丢两坨几千字符的文本让模型自己找不同。
//
// 触发事故（2026-09-22 检索式解析关，16:58–17:07，5 轮全未通过）：唯一的实质差异是
// 一个 list 里两个元素的顺序——预期 `['refactoring', 'refactor']`、实际
// `['refactor', 'refactoring']`。反思依次猜过"剥 + 前缀""分组触发条件""加 sort()
// 按字典序"，而第 4 轮的输出与第 3 轮逐字节相同（sort 是空操作：refactor <
// refactoring 本就是升序）。真正原因要到第五轮才可能推出：**预期里
// `['code','coding']` 要升序、`['refactoring','refactor']` 要降序，二者不可能同时
// 成立为排序策略** → 既非插入序也非字典序 → 典型来源是 Python 2 的 set 迭代顺序被
// `list()` 转出来的结果（题面通篇用「集合」二字，相关知识还专门教了 set/add/list()）。
// 这段排除推理是确定性可算的，不该指望模型在 2.4 万字思考里自己想到。
//
// 能力边界（如实）：只处理"逐行比对"型反馈里能定位到的差异；顺序假设只覆盖
// 升序/降序两种，都不自洽时给出"疑似集合哈希序"的**提示**而非断言（真值要靠改一次
// 提交验证）。容器类型不匹配、乱码/换行差异等只报字符位置，不下结论。

const TOKEN_RE = /'[^']*'|"[^"]*"|[A-Za-z0-9_.]+/g;

const tokensOf = (line) => line.match(TOKEN_RE) ?? [];
const sameMultiset = (a, b) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/** 行首位置（含该行） */
const lineStart = (s, i) => (i <= 0 ? 0 : s.lastIndexOf('\n', i - 1) + 1);
/** 该行结束位置（换行符之后） */
const lineEnd = (s, i) => {
  const nl = s.indexOf('\n', i);
  return nl < 0 ? s.length : nl + 1;
};

/** 从面板/明细文本里取最后一对「预期输出」「实际输出」段落（标记行本身不进正文） */
export function splitExpectedActual(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  const iExp = s.lastIndexOf('预期输出');
  const iAct = s.lastIndexOf('实际输出');
  if (iExp < 0 || iAct < 0 || iAct <= iExp) return null;
  const clean = (x) =>
    String(x ?? '')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.trim() && !/^[—\-–\s]*$/.test(l))
      .join('\n');
  return {
    expected: clean(s.slice(lineEnd(s, iExp), lineStart(s, iAct))),
    actual: clean(s.slice(lineEnd(s, iAct))),
  };
}

/**
 * 逐行比对，定位实质差异并给类型标签。
 * @returns {{pairs: Array<{kind:string, expected:string, actual:string, note:string}>, summary: string}}
 */
export function diffOutputs(expected, actual) {
  const eLines = String(expected ?? '')
    .split('\n')
    .filter((l) => l.trim());
  const aLines = String(actual ?? '')
    .split('\n')
    .filter((l) => l.trim());
  const pairs = [];
  // 按"这一行在对方有没有一模一样的"做朴素对齐：没有的按出现顺序两两配对分析
  const usedA = new Set();
  const eOpen = [];
  eLines.forEach((l, i) => {
    const j = aLines.findIndex((al, k) => al === l && !usedA.has(k));
    if (j >= 0) usedA.add(j);
    else eOpen.push({ l, i });
  });
  const aOpen = aLines.map((l, i) => ({ l, i })).filter((x) => !usedA.has(x.i));

  if (!eOpen.length && !aOpen.length) return { pairs, summary: '逐行完全一致' };

  for (let k = 0; k < Math.max(eOpen.length, aOpen.length); k++) {
    const e = eOpen[k]?.l ?? '';
    const a = aOpen[k]?.l ?? '';
    if (!e || !a) {
      pairs.push({
        kind: 'MISSING_OR_EXTRA',
        expected: e,
        actual: a,
        note: e ? '实际输出缺这一行' : '实际输出多出一行（常见于复制了评测程序打印的行）',
      });
      continue;
    }
    const te = tokensOf(e);
    const ta = tokensOf(a);
    if (sameMultiset(te, ta)) {
      const squeeze = (x) => x.replace(/\s+/g, '');
      if (squeeze(e) === squeeze(a)) {
        pairs.push({
          kind: 'WHITESPACE',
          expected: e,
          actual: a,
          note: '内容与顺序都相同，只差空白（空格数/缩进/换行）——逐行比对仍算不同，按预期那一行的空白照抄',
        });
      } else {
        pairs.push({
          kind: 'ORDER_ONLY',
          expected: e,
          actual: a,
          note: '元素集合完全相同，仅顺序不同',
        });
      }
      continue;
    }
    let pos = 0;
    while (pos < Math.min(e.length, a.length) && e[pos] === a[pos]) pos++;
    pairs.push({
      kind: 'VALUE_DIFF',
      expected: e,
      actual: a,
      note: `第 ${pos + 1} 个字符起不同（预期 …${JSON.stringify(e.slice(Math.max(0, pos - 12), pos + 18))}｜实际 …${JSON.stringify(a.slice(Math.max(0, pos - 12), pos + 18))}）`,
    });
  }

  // 顺序差异的三种假设做机械排除：预期是否整体等于字典升序 / 整体等于字典降序
  const orderPairs = pairs.filter((p) => p.kind === 'ORDER_ONLY');
  const ascFits = orderPairs.every((p) => isSorted(tokensOf(p.expected)));
  const descFits = orderPairs.every((p) => isSorted(tokensOf(p.expected).slice().reverse()));
  let summary = `定位到 ${pairs.length} 处实质差异`;
  if (orderPairs.length && !ascFits && !descFits) {
    summary +=
      '；顺序差异无法用任何统一的排序策略解释（部分行要升序、部分行要降序）' +
      '——最可能是 Python 2 的 set 迭代顺序被 list() 转出（题面用「集合」字样的收集处就该用 set()）';
  } else if (orderPairs.length && ascFits && !descFits) {
    summary += '；预期顺序符合字典升序（实现用插入序时改为 sorted()）';
  } else if (orderPairs.length && descFits && !ascFits) {
    summary += '；预期顺序符合字典降序';
  }
  return { pairs, summary };
}

function isSorted(t) {
  for (let i = 1; i < t.length; i++) if (t[i - 1] > t[i]) return false;
  return true;
}

/** 渲染成注入反思材料的中文段（结构不符/无差异时返回空串，零影响） */
export function describeOutputDiff(detailText) {
  try {
    const sa = splitExpectedActual(detailText);
    if (!sa || !sa.expected || !sa.actual) return '';
    const { pairs, summary } = diffOutputs(sa.expected, sa.actual);
    if (!pairs.length) return '';
    const lines = pairs
      .slice(0, 6)
      .map(
        (p, i) =>
          `${i + 1}. [${p.kind}] ${p.note}\n   预期：${clip(p.expected)}\n   实际：${clip(p.actual)}`,
      );
    return (
      `=== 本地差异定位（程序逐行比对所得，非平台输出）===\n${summary}\n` +
      `${lines.join('\n')}\n` +
      '要求：① 只针对上面定位到的差异改实现，不要顺手改其它已被证明一致的部分；' +
      '② 标 ORDER_ONLY 时，先按 summary 给的假设顺序检验容器类型——题面用「集合」字样的收集处应真用 set() 再 list() 转换，而不是给 list 加 sort()；' +
      '③ 标 WHITESPACE 时，逐字符照抄预期那一行的空白（两个空格/制表符/全半角都算不同），不要改逻辑；' +
      '④ 同一处顺序问题已改过一次仍不变时，说明当前容器/排序假设是错的，换假设而不是再调一次 sort 参数。'
    );
  } catch {
    return '';
  }
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

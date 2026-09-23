// EXPORTS: splitExpectedActual, diffOutputs, describeOutputDiff, diffSkipReason,
//          analyzeOutputDiff, dictKeyOrder, innerLists, serverErrorHints
// 输出差异定位器（1.6.4 / 1.6.5 / 1.6.7）：把"预期 vs 实际"的实质差异**算出来**再交给
// 反思，而不是丢两坨几千字符的文本让模型自己找不同。
//
// 两次于同一处失分催生本模块（2026-09-22 真机），两处成因已在同一天的容器只读实测中定案
// （事实正文见 shared/platform-facts.json 的 python_stdlib / redis_py / evaluation 段）：
//  ① 检索式解析关（16:58–17:07，5 轮未过）：唯一实质差异是 list 里两个元素的顺序，
//     预期 `['refactoring', 'refactor']`、实现 `['refactor', 'refactoring']`。模型依次
//     猜"剥 + 前缀""分组条件""加 sort() 字典序"——第 4 轮加 sort 后输出逐字节相同
//     （refactor < refactoring 本就升序，sort 是空操作）。真相可机械排除：同关预期里
//     `['code','coding']` 要升序、`['refactoring','refactor']` 要降序，两种排序策略不
//     可能同时成立 → 既非插入序也非字典序 → Python 2 的 **set 迭代顺序**被 list() 转出。
//     实测确证（非推测）：容器内 `list(set(['code','coding']))` → `['code','coding']`、
//     `list(set(['refactor','refactoring']))` → `['refactoring','refactor']`，三组顺序与
//     该关预期逐字吻合。
//  ② 微博用户/动态关（18:10–18:16，4 轮未过）：差异是**字典键的打印顺序**。模型第 2、
//     3 轮都在"调整 hmset 里字典字面量的键顺序"，两轮输出逐字节相同。真实链路是评测程序
//     一侧：`str(conn.hgetall(k))` → redis-py 按 Redis 回包序（= 写入序）构造**普通 py2
//     dict** → 打印时再按 py2 哈希表序输出。所以打印序 = f(键集合, 写入序)，两次打乱。
//     实测：6 键的 720 种写入序只落在 4 种打印结果上，预期序占其中 120 种，而"按题面示意
//     顺序写入"恰好打印成真机那版乱序——纯 Python 模拟预测的键序与实际输出逐字吻合。
//     教训（1.6.6 的错误结论由此产生）：字面量书写序确实是空操作，但由"改 OrderedDict 后
//     输出仍相同"推不出"代码改不了键序"——两种写法**恰好落在同一格**。方向可修、结果不可
//     凭推理算出，这类要**算**不要猜：容器一条 `python -c` 就能反解出该按什么顺序写。
//     这一类必须与 ① 分开定性，否则会把"该用 set()"的错误结论喂给模型。
//
// 能力边界（如实）：只处理"逐行比对"型反馈里能定位到的差异；排序假设只覆盖"整体升序 /
// 整体降序"两种全局策略，都不自洽时给出"set 迭代顺序"的结论（① 已实测确证）。识别不出
// 预期/实际结构时整层静默（fail-open），但会经 diffSkipReason 把"为什么没启用"打进日志
// ——静默失效必须可见。

const TOKEN_RE = /'[^']*'|"[^"]*"|[A-Za-z0-9_.]+/g;
/** 字典 repr 的键值对：`'login_name': 'testuser'`（值可为带引号串或裸数字/词） */
const PAIR_RE = /'([^']*)'\s*:\s*('[^']*'|"[^"]*"|[A-Za-z0-9_.+-]+)/g;

/** 预期/实际的标记写法（跨平台兼容：面板、折叠块明细、中文简写都认） */
const EXPECTED_MARKERS = [/预期输出/g, /【预期】/g, /^\s*预期\s*[:：]/gm];
const ACTUAL_MARKERS = [/实际输出/g, /实验输出/g, /【实际】/g, /^\s*实际\s*[:：]/gm];

const tokensOf = (line) => line.match(TOKEN_RE) ?? [];
const pairsOf = (line) => [...String(line).matchAll(PAIR_RE)].map((m) => [m[1], m[2]]);

/**
 * 一行 Python 字典 repr 里的**键顺序**（非字典行返回空数组）。
 * 供容器反解（format-probe）取"要把哈希打印成这个顺序"的目标序列。
 */
export const dictKeyOrder = (line) => pairsOf(line).map((p) => p[0]);

/**
 * 一行里所有**最内层** `[...]` 组的字符串元素（用于逐组验证 set 假设）。
 * 例：`(['a','b'], ['c']), ['d']` → [['a','b'], ['c'], ['d']]
 */
export function innerLists(line) {
  return [...String(line).matchAll(/\[([^[\]]*)\]/g)]
    .map((m) => [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]))
    .filter((a) => a.length);
}
const sameMultiset = (a, b) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
/** 同一批键值对、只有键的先后不同 → 键顺序问题（不是内容问题） */
function keysOnlyReordered(e, a) {
  const pe = pairsOf(e);
  const pa = pairsOf(a);
  if (pe.length < 2 || pa.length < 2) return false;
  const flat = (ps) =>
    ps
      .map((p) => p.join('\u0000'))
      .sort()
      .join('\u0001');
  if (flat(pe) !== flat(pa)) return false;
  return pe.map((p) => p[0]).join(',') !== pa.map((p) => p[0]).join(',');
}

/** 最后一次出现某个标记的位置；返回 {index, end}，end 已跳过冒号以便兼容"标记与正文同一行" */
function lastMarker(s, list) {
  let hit = null;
  for (const re of list) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (!hit || m.index > hit.index) {
        let end = m.index + m[0].length;
        while (end < s.length && (s[end] === ' ' || s[end] === '\t')) end++;
        if (s[end] === ':' || s[end] === '：') {
          end++;
          while (end < s.length && (s[end] === ' ' || s[end] === '\t')) end++;
        }
        hit = { index: m.index, end };
      }
    }
  }
  return hit;
}

const cleanBlock = (x) =>
  String(x ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[—\-–\s]*$/.test(l))
    .join('\n');

/** 从面板/明细文本里取最后一对「预期输出」「实际输出」段落。
 *  正文 = 标记（含冒号）之后 到 下一个标记之前；纯破折号/空白残渣由 cleanBlock 丢掉，
 *  因此"标记独占一行"与"标记后同行就接正文"两种面板写法都能解析。 */
export function splitExpectedActual(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  const exp = lastMarker(s, EXPECTED_MARKERS);
  const act = lastMarker(s, ACTUAL_MARKERS);
  if (!exp || !act || act.index <= exp.index) return null;
  return {
    expected: cleanBlock(s.slice(exp.end, act.index)),
    actual: cleanBlock(s.slice(act.end)),
  };
}

/**
 * 逐行比对，定位实质差异并给类型标签。
 * @returns {{pairs: Array<{kind:string, expected:string, actual:string, note:string}>, summary: string}}
 */
export function diffOutputs(expected, actual) {
  const eLines = cleanBlock(expected).split('\n').filter(Boolean);
  const aLines = cleanBlock(actual).split('\n').filter(Boolean);
  const pairs = [];
  // 朴素对齐："这一行在对方有一模一样的"就算一致，剩下的按出现顺序两两配对分析
  const usedA = new Set();
  const eOpen = [];
  eLines.forEach((l) => {
    const j = aLines.findIndex((al, k) => al === l && !usedA.has(k));
    if (j >= 0) usedA.add(j);
    else eOpen.push(l);
  });
  const aOpen = aLines.map((l, i) => ({ l, i })).filter((x) => !usedA.has(x.i));
  if (!eOpen.length && !aOpen.length) return { pairs, summary: '逐行完全一致' };

  for (let k = 0; k < Math.max(eOpen.length, aOpen.length); k++) {
    const e = eOpen[k] ?? '';
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
    const squeeze = (x) => x.replace(/\s+/g, '');
    if (squeeze(e) === squeeze(a)) {
      pairs.push({
        kind: 'WHITESPACE',
        expected: e,
        actual: a,
        note: '内容与顺序都相同，只差空白（空格数/缩进/换行）——逐行比对仍算不同，按预期那一行的空白照抄',
      });
      continue;
    }
    if (keysOnlyReordered(e, a)) {
      pairs.push({
        kind: 'DICT_ORDER',
        expected: e,
        actual: a,
        note: `键值内容一一对应，只有键的先后不同（预期 ${pairsOf(e)
          .map((p) => p[0])
          .join(' → ')}｜实际 ${pairsOf(a)
          .map((p) => p[0])
          .join(' → ')}）`,
      });
      continue;
    }
    if (sameMultiset(tokensOf(e), tokensOf(a))) {
      pairs.push({
        kind: 'ORDER_ONLY',
        expected: e,
        actual: a,
        note: '元素集合完全相同，仅顺序不同',
      });
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
  return { pairs, summary: summarize(pairs) };
}

/** 对定位到的差异做机械的"顺序假设排除"，给出结论性提示 */
function summarize(pairs) {
  const dictPairs = pairs.filter((p) => p.kind === 'DICT_ORDER');
  const orderPairs = pairs.filter((p) => p.kind === 'ORDER_ONLY');
  let summary = `定位到 ${pairs.length} 处实质差异`;
  if (dictPairs.length) {
    summary +=
      '；其中字典键顺序差异的成因已实测确定：打印顺序 = 评测程序 `str(conn.hgetall(k))` 一侧的 ' +
      'Python 2 哈希表序，链路为「被测代码写入字段的先后 → Redis 按写入序回包 → redis-py 构造普通 ' +
      'dict → 按表序打印」，即打印序是 f(键集合, 写入序) 的两次打乱结果。所以：**改字典字面量的书写' +
      '顺序基本是空操作**（送进 hmset 前已被打乱一次），**改逐字段 hset / OrderedDict 的写入先后才真的换结果**' +
      '——但不是"按预期顺序写就按预期顺序打印"，实测 6 个键的 720 种写入顺序只落在 4 种打印结果上。' +
      '处置：① 每轮只换一种写入顺序并写清预期；② 同一键序连续两轮不变 = 上次改动是空操作，别再重交同类；' +
      '③ 该按什么顺序写要**算**不要猜：容器终端跑 `python -c "print dict([(k,i) for k,i in ' +
      'zip(顺序,range(n))]).keys()" 反解；④ 键集合须与参考实现一致（评测程序 `pop(x, "404")` 掉的字段' +
      '就是参考写了而预期输出里看不到的字段，漏写会连带改变其余字段落位）';
  }
  if (orderPairs.length) {
    const asc = orderPairs.every((p) => isSorted(tokensOf(p.expected)));
    const desc = orderPairs.every((p) => isSorted(tokensOf(p.expected).slice().reverse()));
    if (!asc && !desc) {
      summary +=
        '；列表元素顺序无法用任何统一的排序策略解释（部分行要升序、部分行要降序）——这是 Python 2 的 ' +
        '**set 迭代顺序**被 list() 转出（2026-09-22 容器实测：`list(set(["code","coding"]))` → ' +
        '`["code","coding"]`、`list(set(["refactor","refactoring"]))` → `["refactoring","refactor"]`，' +
        '与该关预期逐字吻合）。正解：题面用「集合」字样的收集处真用 set() 再 list() 转换，' +
        '**绝不要加 sort()/sorted()**（两组顺序不可能同时由排序得到）';
    } else if (asc && !desc) {
      summary += '；列表顺序符合字典升序（实现用插入序时改为 sorted()）';
    } else if (desc && !asc) {
      summary += '；列表顺序符合字典降序';
    }
  }
  return summary;
}

function isSorted(t) {
  for (let i = 1; i < t.length; i++) if (t[i - 1] > t[i]) return false;
  return true;
}

/** 内部：解析 + 比对，返回 {status:'diff'|'same'|'no-structure', reason, pairs, summary} */
export function analyzeOutputDiff(detailText) {
  const sa = splitExpectedActual(detailText);
  if (!sa) {
    return {
      status: 'no-structure',
      reason: '明细里找不到「预期输出 / 实际输出」标记，无法逐行定位',
    };
  }
  if (!sa.expected || !sa.actual) {
    return { status: 'no-structure', reason: '预期或实际段正文为空（面板结构异常）' };
  }
  const { pairs, summary } = diffOutputs(sa.expected, sa.actual);
  if (!pairs.length)
    return { status: 'same', reason: '逐行完全一致（差异在标记之外）', pairs, summary };
  return { status: 'diff', reason: '', pairs, summary };
}

/**
 * 服务端报错的解读（1.6.11）。
 *
 * 这些报错指向"**被测服务**没搭成题面要求的形态"，而不是"你终端连错了对象"——
 * 2026-09-23 真机（MongoDB 复制集搭建关）连续 12 轮都栽在后一个误诊上：评测输出里的
 * `not master and slaveOk=false` 是**评测程序连的那个端口**拒绝写，反思却一直在
 * `exit` + 重连自己的会话（改的只是自己的终端，改不动被评测的服务）。
 * 判据是确定性的（报错原文即可匹配），所以做成代码而不是 prompt 守则。
 */
const SERVER_ERROR_HINTS = [
  [
    /not master and slaveOk=false|NotMasterNoSlaveOk/i,
    '· 实际输出里的 `not master and slaveOk=false`（NotMasterNoSlaveOk）是**服务端**在从节点上拒绝写操作。' +
      '评测程序连的是**你搭建的服务**，所以它出现说明**被评测的那个端口当前不是主节点**：' +
      '优先查「服务有没有起来 / 复制集有没有初始化成功 / 配置文件写没写对 / 端口与 replSet 名称是否一致」，' +
      '**不要**把它当成"我终端连错了节点"而反复 exit 重连——那样改的只是你自己的会话，改不动被评测的服务。',
  ],
  [
    /child process failed, exited with error number/i,
    '· `child process failed, exited with error number …` 是 mongod 进程**启动失败**（配置路径、数据目录、端口被占用）。' +
      '先读题面指定的 logpath 日志末尾定位，而不是继续调整客户端命令。',
  ],
  [
    /Connection refused|ECONNREFUSED/i,
    '· `Connection refused` 说明目标服务根本没在监听——先确认服务启动成功（进程 / 日志），再谈后面的操作。',
  ],
];

/** 命中即返回解读段（未命中返回空串，零打扰） */
export function serverErrorHints(text) {
  const s = String(text ?? '');
  const hit = SERVER_ERROR_HINTS.filter(([re]) => re.test(s)).map(([, msg]) => msg);
  return hit.length ? `${hit.join('\n')}\n` : '';
}

/** 注入反思材料的中文段；未定位到差异时返回空串（零打扰） */
export function describeOutputDiff(detailText) {
  try {
    const a = analyzeOutputDiff(detailText);
    if (a.status !== 'diff') return '';
    const lines = a.pairs
      .slice(0, 6)
      .map(
        (p, i) =>
          `${i + 1}. [${p.kind}] ${p.note}\n   预期：${clip(p.expected)}\n   实际：${clip(p.actual)}`,
      );
    return (
      `=== 本地差异定位（程序逐行比对所得，非平台输出）===\n${a.summary}\n` +
      `${lines.join('\n')}\n` +
      serverErrorHints(detailText) +
      '要求：① 只针对上面定位到的差异改实现，不要顺手改其它已被证明一致的部分；' +
      '② DICT_ORDER = 键的打印顺序问题：能改，但**改字典字面量的书写顺序是空操作**，要改就改**写入顺序**（逐字段 hset 或 OrderedDict 的元素先后）；' +
      '目标顺序按 summary 给的办法算出来再写，算不出就明确说明"这是 4 选 1 的哈希落位、本轮换了另一种写入顺序"，禁止在同方向重复重交；' +
      '③ ORDER_ONLY = 元素顺序问题：按 summary 的假设检验容器类型（题面用「集合」字样处应真用 set() 再 list()，已实测确证），而不是给 list 加 sort()；' +
      '④ WHITESPACE = 逐字符照抄预期那一行的空白，不要改逻辑；' +
      '⑤ 同一处顺序问题已改过一次仍不变时，说明当前假设是错的，换假设而不是再调一次参数。'
    );
  } catch {
    return '';
  }
}

/** 未启用差异定位时的原因（供 loop 打日志——静默失效必须可见）；已定位到差异则返回空串 */
export function diffSkipReason(detailText) {
  try {
    const a = analyzeOutputDiff(detailText);
    return a.status === 'diff' ? '' : a.reason;
  } catch {
    return '';
  }
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

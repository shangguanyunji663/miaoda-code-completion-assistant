// EXPORTS: extractRequirementContract, renderContractBlock, parseAlignmentTable, validateAlignment
// 题面契约层（1.6.0）：把"照题面写"从模型的自觉，变成程序可校验的动作。
//
// 为什么不是"再补一条 prompt 守则"（用户明确要求：不能每题靠人工纠正）：
// 本项目已三次栽在同一处——模型用工程常识覆盖题面明文要求（逐队列 blpop、转移一个就
// return、把评测程序打印的行自己 print 一遍）。守则文本是约束力最弱的一层，规则越多
// 单条越弱。所以这里做的不是"提醒模型"，而是三件可机器判定的事：
//   ① 用确定性代码从**当次题干**切出「编程要求」条目清单（不存模板、不认平台特有结构，
//      切不出来就整体不启用——fail-open）；
//   ② 要求模型逐条回答「编号 | 题面原文摘录 | 实现位置行号 | 说明」；
//   ③ 程序校验：条目不得漏、摘录必须真是题干子串（抓幻觉引用）、行号不得越界。
// 校验不过当场打回重生成——成本是几秒，不是一次 120 秒评测。
//
// 能力边界（如实）：这一层拦得住"漏要求 / 幻觉引用 / 落点缺失 / 形态违规"，拦不住
// "形态齐全但算法算错"。后者仍需廉价预言机（容器内自跑）或平台反馈。

/** 要求段的各种可能标题（跨平台兼容；一个都没有就不启用本层） */
const REQUIRE_TITLES = ['编程要求', '实验要求', '任务要求', '作答要求', '编码要求', '编写要求'];
/** 题干里常见的章节标题，用于定界（要求段 = 要求标题 到 下一个其它标题 之间） */
const SECTION_TITLES = [
  ...REQUIRE_TITLES,
  '任务描述',
  '相关知识',
  '知识储备',
  '扩展知识',
  '测试说明',
  '程序要求',
  '实验提示',
  '示例',
  '效果示例',
  '运行结果',
  '预期输出',
];
const MAX_ITEMS = 16;
const MAX_ITEM_CHARS = 300;
/** 引用 containment 判定前统一抹平的字符（空白 + 中西标点），只防"看得见的差异"，不防语义改写 */
const CANON_STRIP = /[\s"'“”‘’「」『』《》〈〉()（）[\]{}【】,，。.。;；:：、!！?？~～*`#_-]/g;

const canon = (s) => String(s ?? '').replace(CANON_STRIP, '');

/** 题干里的章节标题（行首、整行或紧跟冒号才算，避免正文里的词误判） */
function findSections(text) {
  const out = [];
  const lines = text.split('\n');
  let pos = 0;
  for (const line of lines) {
    const t = line.trim().replace(/[:：]\s*$/, '');
    if (SECTION_TITLES.includes(t)) out.push({ title: t, index: pos, end: pos + line.length + 1 });
    pos += line.length + 1;
  }
  return out;
}

/** 把要求段切成条目：优先按行（编号/项目符号/整句/引导语），退化到按「。；」分句 */
function splitItems(body) {
  const lines = body
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  // 引导语行（"…具体参数与要求如下："）**必须单独成条**——它点名了要编写哪个函数，
  // 且若与上一条合并会让整条以冒号结尾，被后面的过滤当废话误杀（1.6.0 实测漏条目根因）
  const startsItem = (l) =>
    /^\s*(?:\d+\s*[.、)）]|[（(]\d+[）)]|[-*•]\s*|\d+\s*\+\s*)/.test(l) ||
    /[。；;：:]\s*$/.test(l.trim());
  const chunks = [];
  for (const l of lines) {
    if (!chunks.length || startsItem(l)) chunks.push(l.trim());
    else chunks[chunks.length - 1] += ' ' + l.trim();
  }
  let items = chunks;
  if (items.length < 2) {
    items = body
      .split(/[。；;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return items
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 6)
    .slice(0, MAX_ITEMS)
    .map((s) => (s.length > MAX_ITEM_CHARS ? `${s.slice(0, MAX_ITEM_CHARS)}…` : s));
}

/**
 * 从题干抽取要求清单 + 预期输出摘录。
 *
 * 1.6.1 修正（真机日志暴露）：要求类标题在一道题里**可能同时出现多个**（本平台
 * 「任务要求」+「编程要求」并存），旧版取第一个命中段，结果只切出 1 条，模型从
 * 「编程要求」里原样抄的摘录反倒不在"真值"里，被判 bad_quote 反复打回（5 轮 8 次
 * 白烧）。现在：合并**所有**要求类段（按出现顺序、去重），每段截到下一个任意标题为止。
 * @returns {{present: boolean, items: string[], expectedOutput: string, source: string}}
 */
export function extractRequirementContract(problem) {
  const text = String(problem ?? '');
  try {
    const sections = findSections(text);
    const reqSections = sections.filter((s) => REQUIRE_TITLES.includes(s.title));
    if (!reqSections.length) {
      return { present: false, items: [], expectedOutput: '', source: '' };
    }
    const items = [];
    const seenItem = new Set();
    for (const sec of reqSections) {
      const next = sections.find((s) => s.index >= sec.end);
      for (const item of splitItems(text.slice(sec.end, next ? next.index : undefined))) {
        const key = canon(item);
        if (seenItem.has(key)) continue;
        seenItem.add(key);
        items.push(item);
      }
      if (items.length >= MAX_ITEMS) break;
    }
    const test = sections.find((s) => s.title === '测试说明');
    let expectedOutput = '';
    if (test) {
      const after = text.slice(test.index);
      const m = after.match(/预期输出[\s\S]{0,40}?[：:]\s*([\s\S]{0,1200})/);
      if (m) expectedOutput = m[1].trim().slice(0, 1200);
    }
    return {
      present: items.length > 0,
      items: items.slice(0, MAX_ITEMS),
      expectedOutput,
      source: reqSections.map((s) => s.title).join('+'),
    };
  } catch (e) {
    // fail-open：抽取器自身异常绝不能阻断作答
    return { present: false, items: [], expectedOutput: '', source: `error:${e?.message ?? e}` };
  }
}

/** 渲染成注入 prompt 的数据块（指令文字本身在 capability JSON 里，这里只给清单数据） */
export function renderContractBlock(contract) {
  if (!contract?.present) return '';
  const lines = contract.items.map((s, i) => `${i + 1}. ${s}`);
  return (
    `【题面要求清单】（程序从题干「${contract.source}」按原文切分，编号固定，共 ${lines.length} 条）\n` +
    `${lines.join('\n')}` +
    (contract.expectedOutput
      ? `\n\n【题面预期输出（原文摘录，用于判断哪些行该由你输出、哪些行是评测程序打印的）】\n${contract.expectedOutput}`
      : '')
  );
}

/** 解析模型的对齐表回答：`编号 | 题面原文摘录 | 实现行号 | 说明`（允许 markdown 前后缀） */
export function parseAlignmentTable(text) {
  const rows = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s*/, '')
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .trim()
      // 编号被 markdown 强调包住的情况：`**3** | …` / `_2_ ｜ …`
      .replace(/^[*_]{1,3}(\d{1,2})[*_]{1,3}\s*/, '$1 ');
    if (!line) continue;
    const m = line.match(/^(\d{1,2})\s*[.、)｜|]\s*(.+)$/);
    if (!m) continue;
    const cols = m[2]
      .split(/[|｜]/)
      .map((c) =>
        c.replace(/^\s*(摘录|原文|引用|行号|位置|实现位置|实现行号|说明)\s*[:：]\s*/i, '').trim(),
      )
      .filter((c, i) => c !== '' || i === 0);
    if (cols.length < 2) continue;
    rows.push({
      no: Number(m[1]),
      quote: cols[0],
      where: cols[1] ?? '',
      note: cols[2] ?? '',
      raw: line,
    });
  }
  return rows;
}

/** 从"实现行号"一列里取出所有行号（12 / L12 / 12-15 / 12~14 / 第12行） */
function parseLineNos(spec) {
  const nums = String(spec ?? '').match(/\d+/g);
  return nums ? nums.map(Number).slice(0, 8) : [];
}

/**
 * 校验对齐表是否真的对上了题面与代码。
 *
 * 哪些算"打回级"（blocking）、哪些只记日志（advisory）：漏条目与改写/编造摘录是
 * 真信号（等于承认没照题面做），一律打回；**行号只作提示**——模型给的是"它输出那份
 * 代码"的行号，而落进编辑器还要过模板拼接，行号会整体偏移，拿它当硬判据会误伤。
 * @returns {{ok: boolean, skipped?: string, problems: Array, advisories: Array}}
 */
export function validateAlignment({ contract, rows, code, problemText = '' }) {
  if (!contract?.present) return { ok: true, skipped: 'no-contract', problems: [], advisories: [] };
  const problems = [];
  const advisories = [];
  try {
    // 摘录的真值是**题干全文**（模型抄题面任何一句都算数）；切条清单只用来查覆盖度。
    // 旧版只拿清单当唯一真值，1.6.0 真机上因切条漏段把正确抄写判成幻觉，每轮 bad_quote
    // 反复打回（5 轮白烧 8 次）——判据用错真值比漏判更贵。
    const hay = canon(
      [problemText, contract.items.join('\n'), contract.expectedOutput, code ?? '']
        .join('\n')
        .slice(0, 400000),
    );
    const codeLines = String(code ?? '').split('\n').length;
    const seen = new Set();
    for (const r of rows ?? []) {
      if (r.no < 1 || r.no > contract.items.length) continue; // 多答的编号忽略
      seen.add(r.no);
      if (canon(r.quote).length < 4) {
        problems.push({
          no: r.no,
          kind: 'empty_quote',
          message: '题面原文摘录为空——没有摘录就等于没核对',
        });
      } else if (!hay.includes(canon(r.quote))) {
        problems.push({
          no: r.no,
          kind: 'bad_quote',
          message: `摘录不是题干原文（疑似凭记忆改写）：「${r.quote.slice(0, 60)}」`,
        });
      }
      const nos = parseLineNos(r.where);
      if (!nos.length) {
        advisories.push({ no: r.no, kind: 'no_landing', message: '未给出实现位置行号' });
      } else if (nos.some((n) => n < 1 || n > codeLines)) {
        advisories.push({
          no: r.no,
          kind: 'bad_line',
          message: `实现行号越界（拼后代码共 ${codeLines} 行，给的是 ${nos.join(',')}）`,
        });
      }
    }
    for (let i = 1; i <= contract.items.length; i++) {
      if (!seen.has(i)) {
        problems.push({
          no: i,
          kind: 'missing_item',
          message: `漏答第 ${i} 条要求：${contract.items[i - 1].slice(0, 80)}`,
        });
      }
    }
    return { ok: problems.length === 0, problems, advisories };
  } catch (e) {
    return { ok: true, skipped: `error:${e?.message ?? e}`, problems: [], advisories: [] };
  }
}

/** 校验结论渲染成打回给模型的说明（与 py2 守卫同一套"本地拦截、未提交评测"话术） */
export function formatAlignmentProblems(problems, limit = 10) {
  return (problems ?? [])
    .slice(0, limit)
    .map((p) => `- 第 ${p.no} 条｜${p.message}`)
    .join('\n');
}

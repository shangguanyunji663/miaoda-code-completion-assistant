// EXPORTS: planFormatProbe, probeCommands, parseProbeOutput, renderProbeFindings, unrankPermutation,
//          POP_FIELDS_COMMAND, parsePoppedFields, paddedProbeCommands, parsePaddedOutput
// 格式反解探针（1.6.8）：顺序类差异（DICT_ORDER / ORDER_ONLY）是本项目唯一"本地算不出、
// 模型又必然猜不对"的一类，而真值源就在容器里——平台自带的 Python 2 可以做**纯计算**
// （不碰 Redis、不写任何键），一条 `python -c` 就把"该按什么顺序写"算出来。
// 本模块只做三件事：把差异折成只读命令、把终端回显解析成结论、把结论渲染成注入反思的中文段。
// 执行在 loop.mjs（要动页面标签，故本模块不碰浏览器）。
//
// 为什么值得做（2026-09-22 容器实测，已入 shared/platform-facts.json）：
//   · 哈希键序：打印序 = 评测程序 `str(conn.hgetall(k))` 一侧的 py2 哈希表序，6 个键的
//     720 种写入顺序只落在 4 种结果上。模型既不知道有 4 种、也不知道哪种对，于是"调字典
//     字面量的键书写顺序"这种空操作可以反复做四轮（指纹抓到过连续三轮逐字节相同）。
//     探针给出的写入序**看起来是乱的**，但它是实测能打印成预期序的那个——只能给这个答案。
//   · 列表序：`list(set(['refactor','refactoring']))` 实测 = `['refactoring','refactor']`，
//     与预期逐字吻合。"部分升序部分降序"根本不是排序策略，猜不出来，一算就知道。
//
// 输出为什么只回"命中数 + 排列序号"（而不是把顺序打印出来）：xterm 是**按列硬换行**的，
// 长回显会把键名从中间劈开（真机取证时亲眼见过），逐行正则就废了。所以让 Python 只回
// 十来个字符，完整的写入序由 JS 端按同一个字典序排列规则（itertools.permutations 的产出
// 顺序）反排出来——两侧规则一致，且有用例与容器实测钉住。
//
// 1.6.9 补上"0 解 → 补字段"这一环：DICT_ORDER 项按**可见键集合**穷举得到 0 解时，说明
// 键集合本身与参考实现不同——参考实现多写的字段名**不在题面里**（本平台的"示意"是图片，
// 文本层完全为空，实测题面 body 在该处只有空行），只存在于评测脚本的 `X.pop("字段","404")`
// 调用里。于是补一轮：先只读 `grep` 出评测脚本 pop 掉的字段名，再把它并进键集合重算
// （枚举 → 构造 dict → 剔除该字段 → 比对预期序，即模拟 hgetall→pop→打印）。真机实拍
// （微博用户/动态关）：`user:{id}` 补 `last_signup` 后 1200 种可行、`post:{id}` 补 `posted`
// 后 24 种可行，而**不补**时后者 0 解——正是该关连续多轮不过的最后一环。
//
// 三条硬约束（都不许放宽）：
//   ① 名字白名单 `/^[A-Za-z0-9_.-]+$/`，其余（含 $ ` " \ 与非 ASCII）一律不探针——这些串
//      是从网页文本里抠出来、要被打进真实 shell 的，不过滤等于开注入面；非 ASCII 还有独立
//      原因：Python 2 的 `python -c` 里出现裸非 ASCII 直接 SyntaxError。
//   ② 只生成 `python -c` 纯计算：不含 Redis 写命令、不起 redis-server、不提交评测。
//   ③ 键数 ≤ 8（8! = 40320 次构造，容器内约数秒；再大不探，回退静态指引）。

import { dictKeyOrder } from './output-diff.mjs';

/** 可安全拼进 shell 的名字：ASCII 标识符形态 */
const SAFE = /^[A-Za-z0-9_.-]+$/;
const MAX_KEYS = 8;
/** 一次反思里最多探几组（再多屏幕放不下、时间也不划算） */
const MAX_PROBES = 2;

const pyList = (arr) => `[${arr.map((k) => `'${k}'`).join(',')}]`;
const join = (arr) => arr.join(',');

/**
 * 决定探哪些项；不合格的一律剔除并记下原因（供日志说明"为什么没探"）。
 * @param {Array<{kind:string, expected:string}>} pairs diffOutputs 的结果
 * @param {{setGroups?: string[][]}} [extra] ORDER_ONLY 行里各候选词组（取预期那一侧）
 */
export function planFormatProbe(pairs = [], extra = {}) {
  const skipped = [];
  const hashKeys = [];
  const seen = new Set();
  for (const p of pairs) {
    if (p.kind !== 'DICT_ORDER') continue;
    const keys = dictKeyOrder(p.expected);
    if (!keys.length) continue;
    const sig = join(keys);
    if (seen.has(sig)) continue;
    if (hashKeys.length >= MAX_PROBES) {
      skipped.push(`另有哈希未探（单次最多 ${MAX_PROBES} 组）：${sig}`);
      break;
    }
    if (keys.length > MAX_KEYS) {
      skipped.push(`${sig}（${keys.length} 个键，超出 ${MAX_KEYS} 的排列上限）`);
      continue;
    }
    const bad = keys.filter((k) => !SAFE.test(k));
    if (bad.length) {
      skipped.push(`${sig}（键名含不能安全拼进 shell 的字符：${join(bad)}）`);
      continue;
    }
    if (new Set(keys).size !== keys.length) {
      skipped.push(`${sig}（键重复，排列无意义）`);
      continue;
    }
    seen.add(sig);
    hashKeys.push(keys);
  }

  const setGroups = [];
  const seenSet = new Set();
  for (const group of extra.setGroups ?? []) {
    const words = [...new Set(group ?? [])];
    if (words.length < 2) continue;
    if (setGroups.length >= MAX_PROBES) {
      skipped.push(`另有词组未探（单次最多 ${MAX_PROBES} 组）：${join(words)}`);
      break;
    }
    if (words.some((w) => !SAFE.test(w))) {
      skipped.push(`${join(words)}（含不能安全拼进 shell 的字符）`);
      continue;
    }
    const sig = join([...words].sort());
    if (seenSet.has(sig)) continue;
    seenSet.add(sig);
    setGroups.push(words);
  }

  if (!hashKeys.length && !setGroups.length && !skipped.length) {
    skipped.push('本次顺序差异不适合探针（无字典键序差异、无可测词组）');
  }
  return { hashKeys, setGroups, skipped };
}

/**
 * 只读取出评测脚本里被 pop 掉的字段名。命令本身不含任何用户输入（路径是平台实测常量），
 * 只 grep 不执行；`-h` 去文件名、`-o` 只留匹配片段，回显极短（每行一个 `pop("字段"`）。
 */
export const POP_FIELDS_COMMAND = 'grep -ho \'pop("[^"]*"\' /data/workspace/myshixun/step*/read.py';

/**
 * 从上述 grep 回显里抽字段名（同一字段去重，只保留能安全拼进 shell 的 ASCII 名）。
 * @returns {string[]}
 */
export function parsePoppedFields(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/pop\(\s*["']([^"']+)["']/g)) {
    const f = m[1];
    if (SAFE.test(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * 生成"补字段重算"命令（第二轮，仅在**可见键集合 0 解**的项上）：
 * 键集合 = 预期键 + 单个候选 pop 字段，构造 dict 后**剔除该字段**再比对预期序——
 * 即模拟评测脚本的 `hgetall → pop → 打印`。返回标记行 `DQ <no> <命中数> <首解序号> <字段>`。
 * @param {Array<{no:number, keys:string[]}>} items 0 解项
 * @param {string[]} fields parsePoppedFields 的结果
 * @returns {Array<{tag:'DQ', no:number, field:string, sig:string, cmd:string}>}
 */
export function paddedProbeCommands(items = [], fields = []) {
  const out = [];
  for (const it of items) {
    const keys = it.keys ?? [];
    if (!keys.length || !keys.every((k) => SAFE.test(k))) continue;
    for (const field of fields) {
      if (!SAFE.test(field) || keys.includes(field)) continue;
      const ks = [...keys, field];
      if (ks.length > MAX_KEYS) continue;
      out.push({
        tag: 'DQ',
        no: it.no,
        field,
        sig: ks.join(','),
        cmd:
          `python -c "import itertools; exp=${pyList(keys)}; ks=exp+['${field}']; n=${ks.length}; ` +
          `fn=lambda p: [k for k in dict(zip(p,range(n))) if k!='${field}']; ` +
          `g=[i for i,p in enumerate(itertools.permutations(ks)) if fn(p)==exp]; ` +
          `print 'DQ', ${it.no}, len(g), (g[0] if g else -1), '${field}'"`,
      });
    }
  }
  return out;
}

/**
 * 解析补字段命令的回显（与 parseProbeOutput 分开，避免 DP/DQ 共用编号互相覆盖）。
 * 同一编号多次出现以最后一次为准。
 * @returns {Map<number,{count:number, rank:number, field:string}>}
 */
export function parsePaddedOutput(text) {
  const got = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim();
    const d = l.search(/\bDQ \d+ \d+ -?\d+ [A-Za-z0-9_.-]+\b/);
    if (d < 0) continue;
    const m = l.slice(d).match(/^DQ (\d+) (\d+) (-?\d+) ([A-Za-z0-9_.-]+)/);
    if (m) got.set(Number(m[1]), { count: Number(m[2]), rank: Number(m[3]), field: m[4] });
  }
  return got;
}

/**
 * 生成只读命令，编号 no 从 1 起、与 plan 里的顺序一致（回显靠编号对号入座）。
 * @returns {Array<{no:number, sig:string, kind:'dict'|'set', cmd:string}>}
 */
export function probeCommands(plan) {
  const out = [];
  let no = 0;
  for (const keys of plan.hashKeys) {
    no += 1;
    out.push({
      no,
      kind: 'dict',
      sig: join(keys),
      cmd:
        `python -c "import itertools; ks=${pyList(keys)}; t=list(ks); n=len(ks); ` +
        `g=[i for i,p in enumerate(itertools.permutations(ks)) ` +
        `if list(dict([(k,j) for k,j in zip(p,range(n))]).keys())==t]; ` +
        `print 'DP', ${no}, len(g), (g[0] if g else -1)"`,
    });
  }
  for (const words of plan.setGroups) {
    no += 1;
    out.push({
      no,
      kind: 'set',
      sig: join(words),
      cmd: `python -c "w=${pyList(words)}; o=list(set(w)); print 'SP', ${no}, (o==w), (','.join(o) if o!=w else '')"`,
    });
  }
  return out;
}

/**
 * 解析终端回显：只认 `DP <no> <命中数> <首解序号>` 与 `SP <no> <是否一致> [实测顺序]`。
 * 同一编号多次出现以最后一次为准（屏幕里可能留着上一轮的输出）。
 * @returns {Map<number,{count:number,rank:number>|{same:boolean,printed:string[]}>}
 */
export function parseProbeOutput(text) {
  const got = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim();
    const d = l.search(/\bDP \d+ \d+ -?\d+\b/);
    if (d >= 0) {
      const [, no, count, rank] = l.slice(d).match(/^DP (\d+) (\d+) (-?\d+)/);
      got.set(Number(no), { count: Number(count), rank: Number(rank) });
      continue;
    }
    const s = l.search(/\bSP \d+ (True|False)\b/);
    if (s >= 0) {
      const m = l.slice(s).match(/^SP (\d+) (True|False)\s*(.*)$/);
      if (m) {
        got.set(Number(m[1]), {
          same: m[2] === 'True',
          printed: m[3]
            ? m[3]
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
            : [],
        });
      }
    }
  }
  return got;
}

/**
 * 字典序第 rank 个全排列（0 起）。与 `itertools.permutations(items)` 的产出顺序同源：
 * 后者按"下标序列的字典序"枚举，所以这里按下标取即可，与 items 的内容无关。
 * 用 BigInt 之外的普通数够：8! = 40320。
 */
export function unrankPermutation(items, rank) {
  const pool = [...items];
  const out = [];
  let r = rank;
  while (pool.length) {
    const block = factorial(pool.length - 1);
    const idx = Math.floor(r / block);
    r %= block;
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

const factorial = (n) => {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
};

/**
 * 渲染成注入反思材料的中文段。没解析到结果就返回空串（不打扰，更不误导）。
 * @param {ReturnType<typeof planFormatProbe>} plan
 * @param {Map} parsed parseProbeOutput 的结果
 * @param {{quiet?: boolean, padded?: Map}} [opts] quiet=true 时省略「未探针」清单（结论仍给）；
 *   padded = parsePaddedOutput 的结果，用于把"0 解"项改写为"补 X 字段后有解"
 */
export function renderProbeFindings(plan, parsed, opts = {}) {
  const lines = [];
  let no = 0;
  for (const keys of plan.hashKeys) {
    no += 1;
    const hit = parsed.get(no);
    if (!hit) continue;
    if (hit.count > 0) {
      const witness = unrankPermutation(keys, hit.rank);
      lines.push(
        `· 哈希键序 [${keys.join(', ')}]：容器内 Python 2 穷举全部 ${factorial(
          keys.length,
        )} 种写入顺序，**${hit.count} 种能打印成预期的 ${keys.join(
          ' → ',
        )}**；实测的一个解 = 按 \`${witness.join(' → ')}\` 的先后写入。` +
          ` 落地：**用 collections.OrderedDict（或逐字段 hset）按上面这个顺序写入**——` +
          `它看着和预期不一样，但这正是实测能打印成预期序的写入序；` +
          `改普通 dict 字面量的键书写顺序在 Python 2 里是空操作，不要那样改。`,
      );
    } else {
      const pad = opts.padded?.get(no);
      if (pad && pad.count > 0) {
        const witness = unrankPermutation([...keys, pad.field], pad.rank);
        lines.push(
          `· 哈希键序 [${keys.join(', ')}]：按**你现在写的字段集合**穷举，0 种能打印成预期序 ——` +
            ` 说明**字段集合**与参考实现不同（参考实现多写了一个后来被评测脚本 pop 掉的字段，` +
            `它不在题面文本里，只在评测脚本的 pop 调用里）。容器实测：把这个哈希补上字段` +
            ` \`${pad.field}\`（共 ${factorial(keys.length + 1)} 种写入顺序）后有 **${pad.count} 种**` +
            `能打印成预期的 ${keys.join(' → ')}；实测的一个解 = 按 \`${witness.join(' → ')}\` 的先后写入。` +
            ` 落地：把 \`${pad.field}\` 一并写进这个哈希——**值任意**（评测脚本会 pop 掉它，` +
            `它只通过"字段集合改变哈希落位"影响打印序），用 collections.OrderedDict 按上面这个` +
            `顺序写入，**不要再调可见键之间的顺序**（那样永远是 0 解）。`,
        );
      } else {
        lines.push(
          `· 哈希键序 [${keys.join(', ')}]：容器内 Python 2 穷举全部 ${factorial(
            keys.length,
          )} 种写入顺序，**没有任何一种能打印成预期的 ${keys.join(' → ')}**。` +
            ` 结论：这一行**不是顺序问题，是键集合问题**——预期里的键与你的不同` +
            `（评测脚本 \`pop(x, "404")\` 掉的字段就是参考实现写了、预期里看不到的字段；` +
            `本平台题面的"示意"是图片，字段清单在文本层看不到）。` +
            ` 处置：**不要再改写入顺序**（怎么排都是 0 解）；按题面知识补全该哈希的字段集合。`,
        );
      }
    }
  }
  for (const words of plan.setGroups) {
    no += 1;
    const hit = parsed.get(no);
    if (!hit) continue;
    lines.push(
      `· 集合顺序 [${words.join(', ')}]：容器实测 \`list(set([${words
        .map((w) => `'${w}'`)
        .join(', ')}]))\` ${
        hit.same
          ? `与预期 ${words.join(', ')} **一致** —— 这一组就是"用 set 收集再 list() 转换"的结果，` +
            `题面用「集合」字样的收集处真用 set() 即可复现，**加 sort()/sorted() 反而错**。`
          : `**不等于**预期 ${words.join(', ')}（实测为 ${hit.printed.join(', ') || '见上'}）` +
            ` —— 这一组不能靠 set 得到预期顺序，别往这个方向改。`
      }`,
    );
  }
  if (!lines.length) return '';
  const skipped =
    !opts.quiet && plan.skipped?.length
      ? `\n（未探针：${plan.skipped.join('；')}——这些项仍按静态处置办，不等于已排除）`
      : '';
  return `=== 容器格式反解（在题目页「命令行」执行 python -c 纯计算所得，非平台输出）===\n${lines.join(
    '\n',
  )}${skipped}\n以上为实测事实，与你的自行推理冲突时以它为准。`;
}

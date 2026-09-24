// EXPORTS: classifyEchoLine, isFailureEcho, findFailureLines, extractMissingPaths,
//          pathProbeCommands, probeAnchor
// 终端回显「这条命令到底干没干活」的判据（1.6.20，零依赖纯函数）。
//
// 存在理由（2026-09-24 真机，mongorestore 关 3 轮止损）：`act.mjs` 原先只有一条
// ERROR_PATTERN，认的是"错误措辞"。而这一关最强的那条线索长这样——
//   building a list of collections to restore from /opt/mongodb_1 dir
//   don't know what to do with subdirectory "mongodb_1/test1", skipping...
//   done
// **退出码 0、整段没有一个 error 字样、实际什么都没做**。它既不进"输入期报错"，
// 也只会在滚动的终端尾巴里被几十个无关行淹没，于是模型连续三轮都在猜
// （"目录是空的"——而同一次回显里 `/opt/mongodb/test1/person.bson` 明明恢复了 8 条文档）。
//
// 两档判据，都**只认通用的英文错误/自述语法，不绑定任何具体工具名**：
//   · explicit   —— 明确的错误语法（bash / mysql / redis / tar / cp / mongotools 同形）
//   · silent-noop —— 工具自述"我跳过了 / 我不认识 / 无事可做"，却以成功收尾
//
// 本模块另一个职责是把"路径不存在的回显"变成**只读取证命令**：路径这类事实一步就能
// 测出来，不该交给模型猜（与 format-probe 同一纪律，只是这里连计算都不需要）。

/**
 * 第一档：明确的错误语法。
 * 在原 `act.mjs` 的 ERROR_PATTERN 基础上补齐今天缺的三类：`Permission denied`、
 * `Failed:`、`unknown option/command/argument`、`duplicate key`（重跑不带 --drop 时的
 * E11000 即属此类——它是"数据已在"的信号，不是"你连错了对象"）。
 */
const EXPLICIT = [
  /command not found/i,
  /\bnot found\b/i,
  /no such file or directory/i,
  /permission denied/i,
  /is a directory/i,
  /syntax error/i,
  /syntaxerror/i,
  /\berror\b\s*:/i,
  /multiple errors/i,
  /error scanning/i,
  /\bfailed\b/i,
  /exception/i,
  /traceback/i,
  /connection refused|refused/i,
  /timed? ?out/i,
  /unrecognized/i,
  /\bunknown (?:option|command|argument|token|type|verb)\b/i,
  /duplicate key|\bE\d{5}\b/,
  /无法识别|错误|失败/,
];

/**
 * 第二档：静默空操作——措辞里没有 error，工具却自述"没干活"。
 *
 * `skipping` 只认**进行式**是有意的：mongo 查询里 `{skip:10}` 这类合法写法会出现在
 * 回显的命令本身中，`\bskip\b` 会把它们全判成报错（误报会让模型去改本来正确的命令，
 * 与 py2-guard 同一条"宁漏不误报"纪律）。
 */
const SILENT_NOOP = [
  /don'?t know what to do/i,
  /\bskipping\b/i,
  /\bskipped\b/i,
  /nothing to (?:do|restore|dump|process|upload|print)/i,
  /no (?:files?|documents?|collections?|data) to (?:restore|process|dump|upload)/i,
  /is a directory, not a/i,
  /not a (?:bson|valid) /i,
];

/**
 * 单行回显分类。
 * @param {string} line
 * @returns {'explicit'|'silent-noop'|null}
 */
export function classifyEchoLine(line) {
  const t = String(line ?? '');
  if (!t.trim()) return null;
  if (EXPLICIT.some((re) => re.test(t))) return 'explicit';
  if (SILENT_NOOP.some((re) => re.test(t))) return 'silent-noop';
  return null;
}

/** 这行回显算不算失败（两档任一命中）。 */
export function isFailureEcho(line) {
  return classifyEchoLine(line) !== null;
}

/**
 * 从回显行里挑出失败行并保留档位（供日志与反思材料按档措辞）。
 * @param {string[]} lines
 * @returns {Array<{line: string, tier: string}>}
 */
export function findFailureLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => ({ line: l, tier: classifyEchoLine(l) }))
    .filter((x) => !!x.tier);
}

/** 出现"路径本身有问题"的回显（只有这类行里的路径才值得去取证） */
const PATH_SIGNAL =
  /no such file or directory|is a directory, not a|cannot (?:access|open|stat|read|find|op|chdir)|permission denied|error scanning/i;

/**
 * 绝对路径白名单：这些串是从终端/网页文本里抠出来、**要打进真实 shell** 的，
 * 不过滤等于开命令注入面（与 format-probe 的键名白名单同一条纪律）。
 * 允许：字母数字与 `._@+-`，以及分隔用的 `/`；其余（引号、反引号、$、;、|、&、
 * 重定向、括号、方括号、通配符、空白、非 ASCII）一律拒绝整条。
 */
const SAFE_ABS_PATH = /^\/[A-Za-z0-9._@+-]{1}(?:[A-Za-z0-9._@+-]|\/){0,119}$/;

/** 取路径的前 n 段（`/opt/collection_1/person.bson` → n=2 得 `/opt/collection_1`） */
function pathPrefix(p, n) {
  const seg = String(p).split('/').filter(Boolean);
  return '/' + seg.slice(0, n).join('/');
}

/**
 * 从失败回显里抠出**需要取证**的祖先目录（去重、按出现序）。
 *
 * 每条路径同时给出两种粒度，因为 xterm 按列硬换行会把长路径劈成两行（今天实测到的
 * `/collection_1/person/person.bson` 就是被劈开的前半截）——只取"前两段"会得到
 * `/collection_1/person` 这种根本不存在的根，什么也查不出来；而顶层目录（`/opt`、`/home`）
 * 永远是真的，一次 `find /opt -maxdepth 4` 就能把整棵备份树摊开。
 * 顶层那条兜底即使也查不到，"查不到"本身就是证据（比"换个猜测的名字再试一轮"值钱）。
 * @param {string|string[]} textOrLines
 * @param {{maxRoots?: number}} [opts]
 * @returns {string[]} 形如 ['/opt/collection_1', '/opt', '/opt/collection_2']
 */
export function extractMissingPaths(textOrLines, opts = {}) {
  const max = Math.max(1, Number(opts.maxRoots) || 3);
  const text = Array.isArray(textOrLines) ? textOrLines.join('\n') : String(textOrLines ?? '');
  if (!text) return [];
  const roots = [];
  const seen = new Set();
  const push = (r) => {
    if (!r || seen.has(r) || roots.length >= max) return;
    seen.add(r);
    roots.push(r);
  };
  for (const line of text.split(/\r?\n/)) {
    if (!PATH_SIGNAL.test(line)) continue;
    for (const raw of line.match(/\/[^\s'"`,;|&<>(){}[\]*?^$!#]+/g) ?? []) {
      // 去掉行尾被粘连的标点（`stat /a/b.json: no such...` 抠出来带尾随冒号/句点）
      const p = raw.replace(/[.:,]+$/, '');
      if (!SAFE_ABS_PATH.test(p)) continue;
      const segs = p.split('/').filter(Boolean);
      if (!segs.length) continue;
      if (segs.length >= 2) push(pathPrefix(p, 2));
      push(`/${segs[0]}`);
      if (roots.length >= max) return roots;
    }
  }
  return roots;
}

/**
 * 生成**只读**取证命令（一条命令摊开一棵树，输出自带完整路径、无需解析）。
 * 只用 ls / find，绝不写、绝不删、绝不进 REPL。顶层目录取更深的 maxdepth（它本身不算目标）。
 * @param {string[]} roots `extractMissingPaths` 的结果
 * @param {{headLines?: number}} [opts]
 * @returns {string[]}
 */
export function pathProbeCommands(roots, opts = {}) {
  const head = Math.max(10, Number(opts.headLines) || 80);
  return (Array.isArray(roots) ? roots : [])
    .filter((r) => SAFE_ABS_PATH.test(String(r ?? '')))
    .slice(0, 3)
    .map((r) => {
      const depth = String(r).split('/').filter(Boolean).length >= 2 ? 3 : 4;
      return `find ${r} -maxdepth ${depth} 2>&1 | head -${head}`;
    });
}

/** 取证回显的锚点（第一条命令的根），用于从整屏终端文本里截出本轮那段 */
export function probeAnchor(roots) {
  const r = Array.isArray(roots) && roots.length ? String(roots[0]) : '';
  return SAFE_ABS_PATH.test(r) ? r : '';
}

// EXPORTS: classifyEchoLine, isFailureEcho, findFailureLines, extractMissingPaths,
//          pathProbeCommands, probeAnchor, detectMissingPremise,
//          requiredPathsFromProblem, topLevelRoots, taskCreatesOwnData,
//          absPathTokens, absentPathsFromEcho, isDeadCommand, taskCreatesOwnData
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

/** 路径段数（`/opt` = 1，`/opt/mongodb` = 2） */
function segCount(p) {
  return String(p).split('/').filter(Boolean).length;
}

/** 绝对路径 token（同 `SAFE_ABS_PATH` 的字符集），用于从任意文本里抠候选路径 */
const PATH_TOKEN = /\/[^\s'"`,;|&<>(){}[\]*?^$!#]+/g;

/**
 * 题面里「编程要求」那一段——**唯一说"你要做什么"的部分**。
 * 页面文本是拼接渲染的，`编程要求` 会出现两次（开头的目录锚点 + 正文标题），按**最后一次**
 * 出现取；从全文或第一次取都会串味：真机题干里「相关知识」的参数表写着
 * `-o 指明到要导出的文件名`、示例写着 `/home/mongod/test/haha/haha.bson`，
 * 前者会把"纯恢复题"误判成"自造数据题"，后者会把示例目录当成题面要求的输入去取证。
 * 切不到该段返回空串（调用方自行回退，不猜测）。
 * @param {string} problemText 题干原文
 * @returns {string}
 */
export function requirementSection(problemText) {
  const text = String(problemText ?? '');
  const at = text.lastIndexOf('编程要求');
  if (at < 0) return '';
  return text.slice(at).split(/测试说明|任务描述|相关知识/)[0] ?? '';
}

/** 题面点名路径的候选（绝对、≥2 段、去尾斜杠）——优先只看「编程要求」段 */
function problemPathTokens(problemText) {
  const sec = requirementSection(problemText);
  const whole = String(problemText ?? '');
  for (const src of sec ? [sec, whole] : [whole]) {
    const out = [];
    const seen = new Set();
    let m;
    const re = new RegExp(PATH_TOKEN.source, 'g');
    while ((m = re.exec(src)) !== null) {
      const head = src.slice(Math.max(0, m.index - 2), m.index + 1);
      if (head.endsWith(':/') || head.endsWith('//')) continue; // URL scheme 的一部分
      const p = m[0].replace(/[.:,]+$/, '').replace(/\/+$/, '');
      if (!SAFE_ABS_PATH.test(p) || p.includes('//')) continue;
      if (segCount(p) < 2) continue;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(p.split('/')[1] ?? '')) continue; // 首段是 IPv4
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * 题面（题干文本）点名的绝对路径——「前置数据缺失」这类判据**唯一可信的路径来源**。
 *
 * 为什么不能像回显那样靠终端文本：xterm 按列硬换行会把长路径劈成两行，路径 token 与
 * 错误短语各行一半（2026-09-25 真机第 2 轮的取证命令因此变成 `find /collection_1/person`
 * ——`/opt` 被劈到了上一行末尾）。题面是网页文本层，不存在劈行问题。
 * @param {string} problemText 题干原文
 * @param {{cap?: number}} [opts]
 * @returns {string[]} 形如 ['/opt/mongodb', '/opt/mongodb_1', '/opt/collection_1']
 */
export function requiredPathsFromProblem(problemText, opts = {}) {
  const cap = Math.max(1, Number(opts.cap) || 8);
  return problemPathTokens(problemText).slice(0, cap);
}

/** 一组路径的顶层目录（去重、按出现序），如 `/opt/mongodb` → `/opt` */
export function topLevelRoots(paths) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(paths) ? paths : []) {
    const s = String(p ?? '');
    if (!SAFE_ABS_PATH.test(s)) continue;
    const first = s.split('/').filter(Boolean)[0] ?? '';
    const top = `/${first}`;
    if (segCount(s) < 2 || !SAFE_ABS_PATH.test(top) || seen.has(top)) continue;
    seen.add(top);
    out.push(top);
  }
  return out;
}

/**
 * 题面是否要求你**自己产出**这些源数据（而不是"恢复一份本应已存在的备份"）。
 * 用于「前置数据缺失」的止损阈值：自造数据的题，"当前目录里还没有"是正常中间态，
 * 必须多给一轮；只要求恢复的题，顶层实测为空本身就是一手确证，一轮即停。
 * 只看「编程要求」段，理由见 `requirementSection`。切不到该段返回 false（不猜测）。
 * @param {string} problemText 题干原文
 * @returns {boolean}
 */
export function taskCreatesOwnData(problemText) {
  const body = requirementSection(problemText);
  if (!body) return false;
  return /mongodump|mongoimport|创建|新建|插入|生成|写入|导出|备份到|准备.{0,6}数据/.test(body);
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
 *
 * 排序：**顶层根优先**。一次 `find /opt -maxdepth 4` 就把 `/opt` 整棵树摊开——题面点名的
 * `/opt/mongodb` 存在与否、拼错成什么名字，全在这一条的输出里；而 3 条命令的预算若先被
 * 两个具体根占掉，最关键的"顶层实测清单"反而可能没跑到（2026-09-25 真机第 2 轮：三个根
 * 全是 xterm 劈行产生的碎片，三条探针全废）。
 * @param {string[]} roots `extractMissingPaths` 的结果
 * @param {{headLines?: number}} [opts]
 * @returns {string[]}
 */
export function pathProbeCommands(roots, opts = {}) {
  const head = Math.max(10, Number(opts.headLines) || 80);
  const ok = (Array.isArray(roots) ? roots : []).filter((r) => SAFE_ABS_PATH.test(String(r ?? '')));
  const tops = ok.filter((r) => segCount(r) === 1);
  const specifics = ok.filter((r) => segCount(r) >= 2);
  return [...tops, ...specifics]
    .slice(0, 3)
    .map((r) => `find ${r} -maxdepth ${segCount(r) >= 2 ? 3 : 4} 2>&1 | head -${head}`);
}

/** 取证回显的锚点（第一条命令的根），用于从整屏终端文本里截出本轮那段 */
export function probeAnchor(roots) {
  const r = Array.isArray(roots) && roots.length ? String(roots[0]) : '';
  return SAFE_ABS_PATH.test(r) ? r : '';
}

/**
 * 文本里的绝对路径 token（过注入白名单；同 `extractMissingPaths` 的取值口径）。
 * @param {string} text
 * @returns {string[]} 去重、按出现序
 */
export function absPathTokens(text) {
  const out = [];
  const seen = new Set();
  let m;
  const re = new RegExp(PATH_TOKEN.source, 'g');
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const p = m[0].replace(/[.:,]+$/, '').replace(/\/+$/, '');
    if (!SAFE_ABS_PATH.test(p) || p.includes('//') || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** 会在文件系统里"造出"路径的动词或重定向（被跳过命令之前若出现，就不能判死） */
const CREATES_PATH =
  /\b(mkdir|mktree|touch|cp|copy|mv|rsync|tar|unzip|unzip|wget|curl|mongodump|mongoimport|pg_dump|mysqldump)\b|>>?\s*\//;

/** "这条路径不存在"的回显形态（与 PATH_SIGNAL 同源，另加 mongorestore 的 `invalid: stat`） */
const ABSENT_SIGNAL = /no such file or directory|cannot (?:access|open|stat)|invalid: stat/i;

/**
 * 从「本条命令 + 它新增的回显行」里取出**已被实测判为不存在**的路径（1.6.24）。
 *
 * 归因从严（宁漏不误报——误报会跳过本来能跑的命令）：
 * ① 行级归因优先：只认"同一行里既有绝对路径、又有不存在信号"的那条路径；
 * ② 命令里**只有一个**绝对路径时，允许整条命令归因——这是真机最常见的情形
 *   （`ls -la /opt/mongodb/`、`mongorestore ... /opt/mongodb`），而 xterm 按列劈行会把
 *   `/opt/mongodb: no such file or directory` 从中间切开、①失配。两个及以上路径时
 *   不做这个兜底：`cp /a /b` 失败可能只是 `/b` 的父目录不存在，判死 `/a` 就错了。
 *   **且必须有不存在信号行**：`find /opt -maxdepth 3 -type d` 正常打印一个 `/opt` 不是报错。
 * @param {string} cmd 本条命令原文
 * @param {string[]} newLines 本条命令新增的回显行
 * @returns {string[]} 判为不存在的路径
 */
export function absentPathsFromEcho(cmd, newLines) {
  const cmdPaths = absPathTokens(cmd);
  if (!cmdPaths.length) return [];
  const lines = Array.isArray(newLines) ? newLines : [];
  const out = [];
  const seen = new Set();
  let sawAbsentSignal = false;
  for (const raw of lines) {
    const line = String(raw ?? '');
    if (!ABSENT_SIGNAL.test(line)) continue;
    sawAbsentSignal = true;
    for (const p of absPathTokens(line)) {
      if (cmdPaths.includes(p) && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  // 兜底的前提是"确实出现过不存在信号行"，只是那一行里的路径被劈走了认不出。
  // 少了这道闸，`find /opt -maxdepth 3 -type d` 正常打印一个 `/opt` 就会被判成
  // "`/opt` 不存在"，于是整条后续序列全被跳过（1.6.24 自查回放时正是这样翻车的）。
  if (!out.length && sawAbsentSignal && cmdPaths.length === 1) return cmdPaths.slice();
  return out;
}

/**
 * 这条命令是不是**必败**（它要读的路径已被前面的命令实测为不存在）（1.6.24）。
 *
 * 存在理由（2026-09-25 真机 mongorestore 关）：模型给的 17 条里第 1 条 `find /opt -maxdepth 3
 * -type d` 就已经把 `/opt` 是空的摊在屏幕上，第 3~6 条 `ls` 逐条 `No such file`，而后面 9 条
 * `mongorestore` 引用的正是同一批已判不存在的路径——照敲 = 9 次必然失败 + 约 30 秒键入 +
 * 一整轮评测，这就是"输入期报错还继续按写好的敲完"的白费功夫。
 *
 * 判"必败"要连"后面会有命令把它造出来"一起看：`mkdir -p /opt/x` 之后 `mongorestore /opt/x`
 * 就不是必败，所以只在剩余命令里没有任何创建动作时才跳过。
 * @param {string} cmd 待判的命令
 * @param {string[]} absent 已判不存在的路径
 * @param {string[]} pending 本条及其后的全部命令（含自身）
 * @returns {{dead: boolean, hit: string}} hit 为命中的那个不存在路径
 */
export function isDeadCommand(cmd, absent, pending) {
  if (!Array.isArray(absent) || !absent.length) return { dead: false, hit: '' };
  const list = Array.isArray(pending) ? pending : [];
  const creating = list.some((c) => CREATES_PATH.test(String(c ?? '')));
  if (creating) return { dead: false, hit: '' };
  for (const p of absPathTokens(cmd)) {
    // 只认两个方向：同一对象，或"父已判缺、子必也缺"。**不认反方向**——
    // `/opt/mongodb` 缺席时 `/opt` 本身是存在的（真机就是这种情况：空目录），
    // 若把 `ls /opt` 这类去看父目录的命令也跳过，丢掉的正是判据需要的证据。
    for (const a of absent) {
      if (p === a || p.startsWith(`${a}/`)) return { dead: true, hit: a };
    }
  }
  return { dead: false, hit: '' };
}

/**
 * 「前置数据缺失」确定性判定（1.6.23，零依赖纯函数）。
 *
 * 存在理由（2026-09-25 真机，mongorestore 恢复关）：题面要求"把 /opt/mongodb* 的
 * 备份恢复到 mytest1~4"，而环境里 /opt 是**空目录**（上一关的备份产物没有落到这个
 * 环境）。历轮回显的 `stat /opt/mongodb: no such file` 只是证明"这些名字不存在"——
 * 旧的取证结论模板说"用清单里出现过的路径、或按题面改参数形态"，可清单里**什么
 * 源数据都没有**，模型无路可走就回去改 mongorestore 参数，连续 3 轮逐字节相同
 * 到止损。把"引用的源目录在顶层目录实测清单里**全部缺席**"从"猜错路径名"这一档
 * 里分出来，升级成"前置数据缺失"这一档——它不是命令形态问题，**任何改写都造不出
 * 数据**，处置只有"补前置数据（重做上一关备份 / 重置环境后按课程顺序重做）"。
 *
 * 判据（宁漏不误报——误判会把"其实能靠清单里其它目录解决"的题提前判死）：
 * ⓪ 参与判定的路径**只能是题面点名的那些**（`anchors` 由调用方从题干的「编程要求」段取，
 *   `requiredTops` 是它们的顶层）。这一条是防误报的关键：终端回显里的路径会被 xterm 按列
 *   劈行，`/opt/collection_1` 能劈成上行末的 `/opt` + 下行开头的 `/collection_1`，于是从
 *   回显抠出的"根"可能是 `/collection_1` 这种**根本不存在的幽灵顶层目录**（真机 2026-09-25
 *   第 2 轮实测：三条取证命令全是这种碎片）——对幽灵根下面三条判据会全部"成立"（幽灵根当然
 *   find 不到，而 find 不到的命令正是我们自己生成的），据此判死就把一道 `/opt/collection_1`
 *   其实有数据的可解题提前判死了。题面是网页文本、不会劈行，且"题面引用的源目录"本来就是
 *   这个判据要问的对象。
 * ① 题面点名的路径里**同时**有顶层根 T（如 `/opt`）之下的 ≥2 个具体源目录
 *   （如 `/opt/mongodb`、`/opt/mongodb_1`）——只点名 1 个时，数据可能在 T 的别的子目录里，
 *   不属于"缺失"而是"清单指认"（由取证段原有结论处理）；
 * ② T 的 find 探针**确实执行过**（取证段里认得到 `find T -maxdepth` 的命令行片段；
 *   探针命令被 xterm 按列劈行时认最长公共片段，认不到即判"证据不足"不结论）；
 * ③ 取证段中**没有任何一行**是 T 下的路径（`/opt/…` 开头的输出行）——T 为空目录，
 *   或 T 本身也不存在（find 回显 `find: '/opt': No such file`）。
 * 满足 ⓪①②③ 才判缺失；任一不满足返回 missing:false（fail-open）。
 *
 * @param {string[]} anchors 题面点名的源路径（≥2 段的绝对路径）。调用方无题面时可退回
 *   回显抠出的根（`extractMissingPaths` 的结果），此时 ⓪ 退化为本函数自行推顶层
 * @param {string} segment 取证回显段（`probeMissingPaths` 从整屏终端文本截出的那段）
 * @param {{requiredTops?: string[]}} [opts] 题面点名路径的顶层目录清单；
 *   为空时按 `anchors` 自行推导（跨平台 fail-open）
 * @returns {{missing: boolean, top: string, specifics: string[], note: string}}
 *   note 为注入反思材料的中文数据段（missing 为 false 时为空串）
 */
export function detectMissingPremise(anchors, segment, opts = {}) {
  const rs = (Array.isArray(anchors) ? anchors : [])
    .map((r) => String(r ?? ''))
    .filter((r) => SAFE_ABS_PATH.test(r));
  const seg = String(segment ?? '');
  const none = { missing: false, top: '', specifics: [], note: '' };
  if (!rs.length || !seg) return none;
  // 参与判定的只有"具体源目录"（≥2 段）；顶层根从这些目录推，或由调用方用题面结果指定
  const specifics = rs.filter((p) => segCount(p) >= 2);
  const requiredTops = (Array.isArray(opts.requiredTops) ? opts.requiredTops : []).filter((t) =>
    SAFE_ABS_PATH.test(String(t ?? '')),
  );
  const tops = requiredTops.length ? requiredTops : topLevelRoots(specifics);
  for (const T of tops) {
    const under = specifics.filter((s) => s.startsWith(T + '/'));
    if (under.length < 2) continue;
    // ② T 的探针执行过：命令行片段（find T -maxdepth…）。xterm 按列劈长行时命令行
    // 可能断行，但 `find /opt -maxdepth` 这一头部片段极少被劈开；认不到即证据不足。
    if (!seg.includes(`find ${T} -maxdepth`)) continue;
    const lines = seg.split(/\r?\n/);
    // ③ T 下的路径行：find 输出的是"存在的路径"（一行一个、绝对路径）；命令回显行
    // 以提示符/find 开头、find 的报错行以 `find:` 开头，都不会误认成 T 下路径。
    const childLines = lines.filter((l) => l.startsWith(T + '/'));
    if (childLines.length > 0) continue;
    // T 自身是否存在：只认"T 是**那个**被 find 报错的路径"（形如 `find: '/opt': No such file`，
    // 或无引号 locale 的 `find: /opt: …`）。**不能**用 `includes(T)`——T 的前缀（`/opt`）会
    // 出现在 `find: '/opt/mongodb': …` 里，把"T 下的子目录缺失"误认成"T 本身不存在"。
    const tAbsent = lines.some(
      (l) =>
        /no such file/i.test(l) &&
        (l.includes(`'${T}':`) || l.includes(`'${T}'`) || l.includes(`${T}:`)),
    );
    const note =
      `\n\n=== 前置数据体检（程序确定性判定，非平台输出、非模型结论）===\n` +
      `题目引用的源数据目录 ${[...new Set(under)].join('、')} 均位于 ${T} 之下；` +
      `对 ${T} 的只读实测（find ${T} -maxdepth）显示：` +
      (tAbsent ? `${T} 目录本身不存在` : `${T} 下没有任何子目录/文件（空目录）`) +
      `。结论：本关依赖的前置数据（如上一关的备份产物）在当前环境**不存在**——` +
      `改写或重跑本关的恢复/读取命令**不可能**让这些数据凭空出现。\n` +
      `正确处置：先补齐前置数据（重做上一关的备份命令，或「重置环境」后按课程顺序重做上一关），` +
      `再回来解本关；若题面要求由你**创建**这些数据（题干含生成/写入步骤），则忽略本节、按题面创建。`;
    return { missing: true, top: T, specifics: [...new Set(under)], note };
  }
  return none;
}

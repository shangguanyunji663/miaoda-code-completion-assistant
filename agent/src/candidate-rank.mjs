// EXPORTS: apiFingerprint, scoreCandidate, rankCandidates
// 多候选择优（1.6.3，L2）：一次并行生成 K 份候选，用**已有的本地闸门**当评分器，
// 选出零缺陷的那份再提交。默认关闭（cfg.loop.candidates=1 时 loop 根本不调用它）。
//
// 为什么把闸门改造成评分器而不是打回循环：打回是"串行试错"，一次 120 秒评测才换一个
// 方向（2026-09-22 反向索引关 5 轮 9 分钟、优先级队列关 4 轮全超时）。而 py2 语法、
// 空 Begin/End、多余 print、契约漏条目这四类判据本来就是确定性的——同一时间并行拿 3 份
// 答案，让它们互相比较，比串行烧评测便宜得多，且首轮 3~5 秒的并行请求几乎不增加墙钟时间。
//
// 多数派投票（apiFingerprint）抓的是另一类信号：3 份里 2 份用 conn.incr、1 份用
// conn.hincrby → 取多数派；3 份**全都**带同一硬缺陷 → 多采样救不了，标记 systemic
// 让上层提前上报"需要实测/人工"，而不是继续烧 20 轮。

import { checkPython2Syntax } from './py2-guard.mjs';
import {
  validateAlignment,
  parseAlignmentTable,
  findRedundantPrints,
} from './requirement-contract.mjs';

/** 权重：硬缺陷一票否决，其余按可修复程度分级 */
const W = { py_syntax: 100, empty_block: 100, missing_item: 3, bad_quote: 2, redundant_print: 2 };

/** 代码里数据库/客户端调用序列的指纹（方法名顺序），用于多数派比较 */
export function apiFingerprint(code) {
  const calls =
    String(code ?? '').match(
      /\b[\w.]*\.(?:incr|hincrby|decr|hset|hmset|set|hget|get|rpush|lpush|lpop|blpop|lrange|llen|sadd|smembers|srem|zadd|zrem|zrange|zrevrange|zrangebyscore|zrevrangebyscore|zrank|pipeline|execute|delete|keys|expire)\b/gi,
    ) ?? [];
  return calls.map((c) => c.toLowerCase().replace(/^conn\./, '')).join('>');
}

/**
 * 单个候选的打分。`submitted` 是拼进模板后的实际提交文本（闸门要判的就是它）；
 * `emptyBlocks` 由调用方用 ai.mjs 的 emptyMarkerBlocks 算好传入（本模块不依赖 ai.mjs）。
 * @returns {{score:number, hard:boolean, defects: Array, fingerprint: string}}
 */
export function scoreCandidate({
  code = '',
  submitted = '',
  alignment = '',
  contract,
  problem = '',
  emptyBlocks = [],
}) {
  const defects = [];
  const push = (kind, message, extra) =>
    defects.push({ kind, score: W[kind] ?? 1, message, ...extra });

  for (const p of checkPython2Syntax(submitted).problems ?? []) {
    push('py_syntax', `第 ${p.line} 行 ${p.hint}`, p);
  }
  for (const no of emptyBlocks ?? []) {
    push('empty_block', `Begin/End 区域 #${no} 空着（评测必报 IndentationError）`, { no });
  }
  if (contract?.present) {
    const v = validateAlignment({
      contract,
      rows: parseAlignmentTable(alignment),
      code: submitted,
      problemText: problem,
    });
    for (const p of v.problems ?? []) push(p.kind, p.message, p);
  }
  for (const f of findRedundantPrints({
    requireText: contract?.requireText ?? '',
    problemText: problem,
    code: submitted,
  })) {
    push('redundant_print', `第 ${f.line} 行 print 多余：${f.text}`, f);
  }

  const score = 100 - defects.reduce((s, d) => s + d.score, 0);
  return {
    score,
    hard: defects.some((d) => d.score >= 100),
    defects,
    fingerprint: apiFingerprint(submitted),
  };
}

/**
 * 择优：分数优先，同分取多数派；全部候选都带同一类硬缺陷时标记 systemic。
 * @returns {{pick: number, ranked: Array, systemic: string[]}} pick 为选中下标
 */
export function rankCandidates(cands, { contract, problem = '' } = {}) {
  const scored = (cands ?? []).map((c) => scoreCandidate({ ...c, contract, problem }));
  if (!scored.length) return { pick: 0, ranked: [], systemic: [] };

  const counts = new Map();
  for (const s of scored) {
    if (!s.fingerprint) continue;
    counts.set(s.fingerprint, (counts.get(s.fingerprint) ?? 0) + 1);
  }
  // 排序：分数降序 → 同分时多数派优先 → 再同分保持生成顺序（稳定）
  const order = scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (b.s.score !== a.s.score) return b.s.score - a.s.score;
      return (counts.get(b.s.fingerprint) ?? 0) - (counts.get(a.s.fingerprint) ?? 0);
    });

  const kindsByCand = scored.map((s) => [
    ...new Set(s.defects.filter((d) => d.score >= 100).map((d) => d.kind)),
  ]);
  const systemic =
    scored.length > 1 && kindsByCand.every((k) => k.length && k.join() === kindsByCand[0].join())
      ? kindsByCand[0]
      : [];

  return { pick: order[0].i, ranked: order.map((o) => ({ index: o.i, ...o.s })), systemic };
}

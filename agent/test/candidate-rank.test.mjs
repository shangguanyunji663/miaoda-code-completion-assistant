// 多候选择优单测（1.6.3）。
//
// 场景取自今天两道真机题的实际失误形态：
//   · 反向索引关：`conn.hincrby("content:id","num",1)` 把 string 计数器建成 hash → 评测
//     程序 conn.get 当场 WRONGTYPE；另有"把评测程序打印的行复制进被测函数"的 print。
//   · 优先级队列关：逐队列 blpop 的四份等价变体来回横跳。
// 择优要能在这些形态上做对选择，且**全都错时明确说"多采样救不了"**（systemic），
// 而不是继续把 20 轮 × 120 秒的额度烧完。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';

const { apiFingerprint, scoreCandidate, rankCandidates } =
  await import('../src/candidate-rank.mjs');
const { extractRequirementContract } = await import('../src/requirement-contract.mjs');

const PROBLEM = `任务描述
本关任务：使用 Redis 构建反向索引。
编程要求
在Begin-End区域编写 index_document(content) 函数，实现构建反向索引的功能，具体参数与要求如下：
分配文本序号的实现：对计数器content:id递增1，并将递增后的值作为该文本的序号；
记录文本全文的实现：将文本作为值，上一步的序号做为域存入到哈希键 contents 中。
测试说明
测试输入：无；
预期输出：
当前全文编号: 3`;
const CONTRACT = extractRequirementContract(PROBLEM);

const TPL = [
  '#!/usr/bin/env python',
  '#-*- coding:utf-8 -*-',
  'import redis',
  'conn = redis.Redis()',
  'def index_document(content):',
  '    #********* Begin *********#',
  '',
  '    #********* End *********#',
  '',
].join('\n');

/** 把 body 塞进模板的 Begin/End 之间，模拟真实提交文本 */
function fill(body) {
  const lines = TPL.split('\n');
  const at = lines.findIndex((l) => /Begin/i.test(l));
  return [...lines.slice(0, at + 1), ...body.split('\n'), ...lines.slice(at + 2)].join('\n');
}

/** 逐条抄写要求清单的对齐表（择优测试里让候选只暴露"代码缺陷"，不掺格式缺漏） */
const tableFor = (c) => c.items.map((s, i) => `${i + 1} | ${s} | ${10 + i} | 已实现`).join('\n');

const GOOD = fill(
  [
    '    doc_id = conn.incr("content:id")',
    '    conn.hset("contents", str(doc_id), content)',
    '    for w in tokenize(content):',
    '        conn.sadd("keyword:" + w, str(doc_id))',
  ].join('\n'),
);
const BAD_HASH = fill(
  [
    '    doc_id = conn.hincrby("content:id", "num", 1)',
    '    conn.hset("contents", str(doc_id), content)',
    '    for w in tokenize(content):',
    '        conn.sadd("keyword:" + w, str(doc_id))',
  ].join('\n'),
);
const BAD_PRINT = fill(
  [
    '    doc_id = conn.incr("content:id")',
    '    conn.hset("contents", str(doc_id), content)',
    '    print "当前全文编号: %s" % doc_id',
  ].join('\n'),
);
const BAD_PY3 = fill(['    doc_id = conn.incr("content:id")', '    print(f"{doc_id}")'].join('\n'));

test('apiFingerprint 能区分 incr 与 hincrby（多数派投票的比较键）', () => {
  assert.match(apiFingerprint(GOOD), /^incr>/);
  assert.match(apiFingerprint(BAD_HASH), /^hincrby>/);
  assert.notEqual(apiFingerprint(GOOD), apiFingerprint(BAD_HASH));
});

test('打分：带对齐表的干净候选满分；print 扣分不否决；语法错与空区域是否决级', () => {
  const ok = scoreCandidate({
    submitted: GOOD,
    alignment: tableFor(CONTRACT),
    contract: CONTRACT,
    problem: PROBLEM,
  });
  assert.equal(ok.score, 100, ok.defects.map((d) => d.kind).join(','));
  assert.equal(ok.hard, false);

  const py3 = scoreCandidate({ submitted: BAD_PY3, contract: CONTRACT, problem: PROBLEM });
  assert.equal(py3.hard, true);
  assert.ok(py3.defects.some((d) => d.kind === 'py_syntax'));

  const pr = scoreCandidate({
    submitted: BAD_PRINT,
    alignment: tableFor(CONTRACT),
    contract: CONTRACT,
    problem: PROBLEM,
  });
  assert.ok(
    pr.defects.some((d) => d.kind === 'redundant_print'),
    '题面未要求输出时的 print 必须被记为缺陷',
  );
  assert.equal(pr.score, 98);
  assert.equal(pr.hard, false, 'print 缺陷应扣分但不否决');

  const empty = scoreCandidate({
    submitted: TPL,
    contract: CONTRACT,
    problem: PROBLEM,
    emptyBlocks: [1],
  });
  assert.equal(empty.hard, true);
});

test('择优：把带多余 print 的候选排掉（反向索引关的真凶，本地可判）', () => {
  const r = rankCandidates(
    [
      { code: 'A', submitted: BAD_PRINT, alignment: tableFor(CONTRACT) },
      { code: 'B', submitted: GOOD, alignment: tableFor(CONTRACT) },
    ],
    { contract: CONTRACT, problem: PROBLEM },
  );
  assert.equal(r.pick, 1);
  assert.equal(r.ranked[0].index, 1);
});

test('同分取多数派：本地闸门分不清 incr 与 hincrby，只能靠 2:1 投票', () => {
  // 如实标注能力边界：hincrby 把 string 计数器建成 hash 是 Redis 键类型问题，
  // 四道本地闸门一条都抓不到（该靠平台回显/事实档案）。多采样对它的唯一价值是多数派。
  const alt = GOOD.replace(
    'for w in tokenize(content):',
    'for w in sorted(set(tokenize(content))):',
  );
  const list = [
    { code: 'X', submitted: BAD_HASH, alignment: tableFor(CONTRACT) },
    { code: 'Y', submitted: GOOD, alignment: tableFor(CONTRACT) },
    { code: 'Z', submitted: alt, alignment: tableFor(CONTRACT) },
  ];
  const r = rankCandidates(list, { contract: CONTRACT, problem: PROBLEM });
  assert.ok(r.ranked[0].score === 100, '三份本地看都是满分');
  assert.match(
    apiFingerprint(list[r.pick].submitted),
    /^incr>/,
    '同分时应由多数派选出 incr（2 份 incr vs 1 份 hincrby）',
  );
});

test('全都带同一硬缺陷 → systemic 标记（多采样救不了，该转实测/人工）', () => {
  const r = rankCandidates(
    [
      { code: '1', submitted: fill('    print(f"{conn.incr(chr(99)))"') },
      { code: '2', submitted: fill('    x = (a := 1)') },
      { code: '3', submitted: fill('    def f(a: int):\n        return a') },
    ],
    { contract: CONTRACT, problem: PROBLEM },
  );
  assert.deepEqual(r.systemic, ['py_syntax'], '三份都是 Python 2 语法错 → 应标记 systemic');
});

test('对齐表缺失只算缺陷不否决；K=1 时等价于不启用', () => {
  const s = scoreCandidate({
    submitted: GOOD,
    alignment: '',
    contract: CONTRACT,
    problem: PROBLEM,
  });
  assert.ok(s.defects.some((d) => d.kind === 'missing_item'));
  assert.equal(s.hard, false);
  assert.deepEqual(rankCandidates([], { contract: CONTRACT }).pick, 0);
});

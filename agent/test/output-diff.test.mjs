// 输出差异定位器单测（1.6.4）。
//
// 场景是真机原样（2026-09-22 检索式解析关，5 轮全未通过）：唯一实质差异是一个 list 里
// 两个元素的顺序，预期 `['refactoring', 'refactor']`、实现给出 `['refactor', 'refactoring']`。
// 反思依次猜过"剥 + 前缀""分组触发条件""加 sort() 按字典序"，第 4 轮加 sort 后输出
// 一字未变——因为预期里 `['code','coding']` 要升序、`['refactoring','refactor']` 要降序，
// **两种排序策略不可能同时成立**，真正的来源是 Python 2 的 set 迭代顺序被 list() 转出。
// 这段排除法是确定性可算的，本模块就是把它算出来喂给反思。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';

const { splitExpectedActual, diffOutputs, describeOutputDiff, diffSkipReason } =
  await import('../src/output-diff.mjs');

const EXPECTED = `—— 预期输出 ——
测试 parse 方法...
检索式为: software code +coding refactor +refactoring -test -testing
([['software'], ['code', 'coding'], ['refactoring', 'refactor']], ['test', 'testing'])
测试 set_common 方法...
并集内容为: ['4', '5', '8', '9']`;
const ACTUAL = EXPECTED.replace('预期输出', '实际输出').replace(
  "['refactoring', 'refactor']",
  "['refactor', 'refactoring']",
);

test('结构识别：取最后一对预期/实际，标记行本身不进正文', () => {
  const sa = splitExpectedActual(`${EXPECTED}\n${ACTUAL}`);
  assert.ok(sa);
  assert.ok(!/^—/.test(sa.expected.split('\n')[0]), '预期段开头不应残留标记行');
  assert.match(sa.actual, /^\s*测试 parse/);
  assert.ok(!sa.actual.includes('实际输出'), '实际段不应再包含标记行');
});

test('顺序差异被定位为 ORDER_ONLY，且 summary 判出"任何排序策略都无法解释"', () => {
  const r = diffOutputs(
    "([['software'], ['code', 'coding'], ['refactoring', 'refactor']], ['test', 'testing'])",
    "([['software'], ['code', 'coding'], ['refactor', 'refactoring']], ['test', 'testing'])",
  );
  assert.deepEqual(
    r.pairs.map((p) => p.kind),
    ['ORDER_ONLY'],
  );
  assert.match(r.summary, /set 迭代顺序/);
  assert.match(r.summary, /无法用任何统一的排序策略解释/);
  assert.match(r.summary, /容器实测/, 'set 结论已由实测确证，不得再写成推测');
  assert.match(r.summary, /绝不要加 sort\(\)\/sorted\(\)/);
});

test('预期整体就是字典升序时，summary 直接给出"改 sorted()"的可执行结论', () => {
  // 假设要检验的是**预期**那一行的顺序（我们得复现它），不是实际
  const asc = diffOutputs("(['a', 'b'])", "(['b', 'a'])");
  assert.match(asc.summary, /符合字典升序/);
  const desc = diffOutputs("(['b', 'a'])", "(['a', 'b'])");
  assert.match(desc.summary, /符合字典降序/);
});

test('只差空白 → WHITESPACE（自动补全两空格那类坑，与顺序问题分开定性）', () => {
  const r = diffOutputs("The range is:  ('wg{', 'wh{')", "The range is: ('wg{', 'wh{')");
  assert.deepEqual(
    r.pairs.map((p) => p.kind),
    ['WHITESPACE'],
  );
  assert.match(r.pairs[0].note, /只差空白/);
});

test('缺行 / 多行分别定性；多出一行提示"复制了评测程序打印的行"', () => {
  assert.deepEqual(
    diffOutputs('a\nb\nc', 'a\nc').pairs.map((p) => p.kind),
    ['MISSING_OR_EXTRA'],
  );
  const extra = diffOutputs('a\nb', 'a\nb\nc\n当前全文编号: 3');
  assert.match(extra.pairs[0].note, /多出一行/);
});

test('内容真不同 → VALUE_DIFF 并给第一个不同字符的位置与上下文', () => {
  const r = diffOutputs("索引内容: set(['1', '2'])", "索引内容: set(['1', '3'])");
  assert.deepEqual(
    r.pairs.map((p) => p.kind),
    ['VALUE_DIFF'],
  );
  assert.match(r.pairs[0].note, /第 \d+ 个字符起不同/);
});

test('注入材料：完全一致时静默（不打扰反思），有差异时带类型与要求', () => {
  assert.equal(describeOutputDiff(`${EXPECTED}\n${EXPECTED.replace('预期输出', '实际输出')}`), '');
  assert.equal(describeOutputDiff('一堆没有标记的面板文本'), '');
  assert.equal(describeOutputDiff(''), '');
  const note = describeOutputDiff(`${EXPECTED}\n${ACTUAL}`);
  assert.match(note, /=== 本地差异定位（程序逐行比对所得，非平台输出）===/);
  assert.match(note, /\[ORDER_ONLY\]/);
  assert.match(note, /set\(\) 再 list\(\)/);
});

// ---- 1.6.5：微博用户/动态关的真机形态（字典键顺序）+ 可诊断性 ----

const USER_LINE_EXP =
  "创建的用户信息为: {'login_name': 'testuser', 'posts': '0', 'real_name': 'Test User', 'followers': '0', 'following': '0', 'id': '1'}";
const USER_LINE_ACT =
  "创建的用户信息为: {'posts': '0', 'login_name': 'testuser', 'followers': '0', 'following': '0', 'real_name': 'Test User', 'id': '1'}";

test('DICT_ORDER：键值一一对应只有键序不同 → 成因是读侧 py2 哈希表序，该改写入顺序且要算不要猜', () => {
  const r = diffOutputs(USER_LINE_EXP, USER_LINE_ACT);
  assert.deepEqual(
    r.pairs.map((p) => p.kind),
    ['DICT_ORDER'],
  );
  assert.match(r.pairs[0].note, /预期 login_name → posts → real_name/);
  assert.match(r.summary, /Python 2 哈希表序/);
  assert.match(r.summary, /字面量的书写\s*\n?顺序基本是空操作/);
  assert.match(r.summary, /逐字段 hset \/ OrderedDict 的写入先后才真的换结果/);
  assert.match(r.summary, /720 种写入顺序只落在 4 种打印结果/);
  assert.match(r.summary, /pop\(x, "404"\)/, '要提示参考实现含预期里看不到的字段');
  assert.ok(
    !/不是被测代码能修的方向/.test(r.summary),
    '1.6.6 那个由错误观测推出的"改不了"结论已撤，不得回流',
  );
  assert.ok(!/set\(\)/.test(r.summary), '字典键序问题不该给出 set 假设');
  const note = describeOutputDiff(`预期输出：\n${USER_LINE_EXP}\n实际输出：\n${USER_LINE_ACT}`);
  assert.match(note, /DICT_ORDER = 键的打印顺序问题/);
  assert.match(note, /改字典字面量的书写顺序是空操作/);
  assert.match(note, /禁止在同方向重复重交/);
});

test('标记写法兼容：「预期：/实际：」与「预期输出：」都要能识别', () => {
  const a = splitExpectedActual("预期：\n['a', 'b']\n实际：\n['b', 'a']");
  assert.ok(a, '简写标记未被识别');
  assert.deepEqual(a.expected, "['a', 'b']");
  assert.deepEqual(a.actual, "['b', 'a']");
});

test('未启用时必须给出原因（静默失效要能在日志里看见）', () => {
  assert.match(diffSkipReason('一段没有任何标记的面板文本'), /找不到「预期输出 \/ 实际输出」标记/);
  assert.equal(diffSkipReason(`${EXPECTED}\n${ACTUAL}`), '');
});

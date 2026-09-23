// 格式反解探针：命令生成、回显解析、结论渲染。
// 这里钉死的三件事：探针只能生成只读的 python -c 纯计算、名字不过白名单就不许拼进 shell、
// 渲染出的结论必须给出"可照抄的写入序"而不是又一句"请注意顺序"。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFormatProbe,
  probeCommands,
  parseProbeOutput,
  renderProbeFindings,
  unrankPermutation,
  POP_FIELDS_COMMAND,
  parsePoppedFields,
  paddedProbeCommands,
  parsePaddedOutput,
} from '../src/format-probe.mjs';

const USER_LINE_EXP =
  "创建的用户信息为: {'login_name': 'testuser', 'posts': '0', 'real_name': 'Test User', 'followers': '0', 'following': '0', 'id': '1'}";
const USER_LINE_ACT =
  "创建的用户信息为: {'posts': '0', 'login_name': 'testuser', 'followers': '0', 'following': '0', 'real_name': 'Test User', 'id': '1'}";
const dictPair = { kind: 'DICT_ORDER', expected: USER_LINE_EXP, actual: USER_LINE_ACT };

test('DICT_ORDER 折成一组键序探针；非顺序类差异一律不探', () => {
  const plan = planFormatProbe([
    dictPair,
    { kind: 'VALUE_DIFF', expected: "a: ['x']", actual: "b: ['y']" },
  ]);
  assert.deepEqual(plan.hashKeys, [
    ['login_name', 'posts', 'real_name', 'followers', 'following', 'id'],
  ]);
  assert.deepEqual(plan.setGroups, []);
  assert.deepEqual(plan.skipped, []);
});

test('键名不在白名单内就不拼进 shell（网页文本进真实命令行，必须挡死注入面）', () => {
  const evil = {
    kind: 'DICT_ORDER',
    expected: "{'a;rm -rf /': 1, 'b`id`': 2, '中文': 3}",
    actual: "{'b`id`': 2, 'a;rm -rf /': 1, '中文': 3}",
  };
  const plan = planFormatProbe([evil]);
  assert.deepEqual(plan.hashKeys, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0], /不能安全拼进 shell/);
  assert.deepEqual(probeCommands(plan), []);
});

test('生成的命令：只有 python -c 纯计算，无 Redis 写、无起服务、无 $ / 反引号', () => {
  const cmds = probeCommands(planFormatProbe([dictPair]));
  assert.equal(cmds.length, 1);
  const { cmd } = cmds[0];
  assert.match(cmd, /^python -c "/);
  assert.match(cmd, /itertools\.permutations/);
  assert.match(cmd, /print 'DP', 1, len\(g\)/);
  assert.ok(!/redis|conn|hset|hmset|flushdb|redis-server/i.test(cmd), '探针不得含任何 Redis 操作');
  assert.ok(!cmd.includes('$') && !cmd.includes('`'), '不得含会被 bash 展开的字符');
  assert.equal((cmd.match(/"/g) ?? []).length, 2, '只允许最外层一对双引号');
});

test('unrankPermutation 与字典序全排列枚举一致（itertools.permutations 同序）', () => {
  const items = [0, 1, 2, 3];
  const all = [];
  const walk = (cur, rest) => {
    if (!rest.length) return all.push([...cur]);
    for (const x of rest)
      walk(
        [...cur, x],
        rest.filter((y) => y !== x),
      );
  };
  walk([], items);
  assert.equal(all.length, 24);
  for (let r = 0; r < all.length; r++) {
    assert.deepEqual(unrankPermutation(items, r), all[r], `第 ${r} 个排列不一致`);
  }
  assert.deepEqual(unrankPermutation(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(unrankPermutation(['a', 'b', 'c'], 5), ['c', 'b', 'a']);
});

test('回显解析：只认标记行，噪声与上一轮残留都不干扰；同编号取最后一次', () => {
  const text = [
    'root@coder:~# python -c "import itertools; ...print \'DP\', 1, len(g), (g[0] if g else -1)"',
    'DP 1 120 5',
    'DP 2 0 -1',
    'SP 3 True ',
    'root@coder:~#',
    'DP 1 120 7',
  ].join('\n');
  const got = parseProbeOutput(text);
  assert.deepEqual(got.get(1), { count: 120, rank: 7 });
  assert.deepEqual(got.get(2), { count: 0, rank: -1 });
  assert.deepEqual(got.get(3), { same: true, printed: [] });
});

test('渲染：有解时给出可照抄的写入序 + 点名 OrderedDict，并禁止改字面量', () => {
  const plan = planFormatProbe([dictPair]);
  const parsed = parseProbeOutput('DP 1 120 7');
  const txt = renderProbeFindings(plan, parsed);
  assert.match(txt, /容器格式反解/);
  assert.match(txt, /720 种写入顺序，\*\*120 种能打印成预期/);
  assert.match(txt, /collections\.OrderedDict（或逐字段 hset）/);
  assert.match(txt, /改普通 dict 字面量的键书写顺序在 Python 2 里是空操作/);
  assert.match(txt, /实测的一个解 = 按 `[^`]+ → [^`]+` 的先后写入/);
});

test('渲染：无解时改判"键集合问题"，并明确不许再调顺序', () => {
  const plan = planFormatProbe([dictPair]);
  const txt = renderProbeFindings(plan, parseProbeOutput('DP 1 0 -1'));
  assert.match(txt, /没有任何一种能打印成预期/);
  assert.match(txt, /不是顺序问题，是键集合问题/);
  assert.match(txt, /pop\(x, "404"\)/);
  assert.match(txt, /不要再改写入顺序/);
});

test('渲染：set 探针两种结果各说各话（一致=该用 set；不一致=别往这改）', () => {
  const plan = planFormatProbe([], {
    setGroups: [
      ['code', 'coding'],
      ['refactoring', 'refactor'],
    ],
  });
  const cmds = probeCommands(plan);
  assert.equal(cmds.length, 2);
  assert.deepEqual(
    cmds.map((c) => c.kind),
    ['set', 'set'],
  );
  const ok = renderProbeFindings(
    plan,
    parseProbeOutput('SP 1 True \nSP 2 False refactor,refactoring'),
  );
  assert.match(ok, /与预期 code, coding \*\*一致\*\*/);
  assert.match(ok, /加 sort\(\)\/sorted\(\) 反而错/);
  assert.match(ok, /\*\*不等于\*\*预期 refactoring, refactor/);
  assert.match(ok, /不能靠 set 得到预期顺序/);
});

test('什么都没解析到 → 空串（宁可不注入，也不给模型一个没依据的结论）', () => {
  const plan = planFormatProbe([dictPair]);
  assert.equal(renderProbeFindings(plan, parseProbeOutput('root@coder:~#')), '');
});

test('容器实测钉住的换算：rank 184 → 该写入序（2026-09-22 root@coder 两条独立命令交叉验证）', () => {
  // 真机回显：DP 1 120 184          ← 探针命令（只回编号与首解序号）
  // 真机回显②：120 [('posts','followers','following','id','login_name','real_name'), ...]
  //             ← 同一枚举直接打印解列表，首元素与 ① 的 rank 换算结果必须一致
  const keys = ['login_name', 'posts', 'real_name', 'followers', 'following', 'id'];
  assert.deepEqual(unrankPermutation(keys, 184), [
    'posts',
    'followers',
    'following',
    'id',
    'login_name',
    'real_name',
  ]);
  const rendered = renderProbeFindings(
    planFormatProbe([dictPair]),
    parseProbeOutput('DP 1 120 184'),
  );
  assert.match(
    rendered,
    /按 `posts → followers → following → id → login_name → real_name` 的先后写入/,
  );
});

test('未探针的原因会随结论一起给出（静默失效必须可见）', () => {
  const many = Array.from({ length: 9 }, (_, i) => `k${i}`);
  const plan = planFormatProbe([
    { kind: 'DICT_ORDER', expected: `{${many.map((k) => `'${k}': 1`).join(', ')}}`, actual: '{}' },
  ]);
  assert.deepEqual(plan.hashKeys, []);
  assert.match(plan.skipped[0], /超出 8 的排列上限/);
  const txt = renderProbeFindings(
    { hashKeys: [], setGroups: [['a', 'b']], skipped: ['x（超出）'] },
    parseProbeOutput('SP 1 True '),
  );
  assert.match(txt, /未探针：x（超出）/);
});

test('补字段链路：grep 评测脚本 → 抽字段 → 补字段重算 → 渲染出可照抄的写入序（2026-09-23 真机）', () => {
  // 容器回显（grep -ho 'pop("[^"]*")' /data/workspace/myshixun/step*/read.py）
  const grepEcho = [
    'root@coder:~# grep -ho \'pop("[^"]*")\' /data/workspace/myshixun/step*/read.py',
    'pop("last_signup"',
    'pop("posted"',
    'root@coder:~#  ',
  ].join('\n');
  assert.deepEqual(parsePoppedFields(grepEcho), ['last_signup', 'posted']);
  assert.deepEqual(parsePoppedFields(''), []);

  // 4 键 post:{id} 按可见键集合 0 解 → 补 posted 后重算
  // 编号必须与 hashKeys 的序号（1 起）对齐——这是编排契约，错位就命不中 padded
  const items = [{ no: 1, keys: ['content', 'uid', 'user_name', 'id'] }];
  const cmds = paddedProbeCommands(items, ['last_signup', 'posted']);
  assert.equal(cmds.length, 2, '两个候选字段各一条');
  assert.match(cmds[1].cmd, /ks=exp\+\['posted'\]/);
  assert.match(cmds[1].cmd, /if k!='posted'/);
  assert.match(cmds[1].cmd, /print 'DQ', 1/);
  // 字段已在键集合里 → 不再重复补
  assert.equal(paddedProbeCommands([{ no: 1, keys: ['content', 'posted'] }], ['posted']).length, 0);

  const parsed = parsePaddedOutput(
    ['root@coder:~# python -c "…"', 'DQ 1 24 9 posted', 'root@coder:~#  '].join('\n'),
  );
  assert.deepEqual(parsed.get(1), { count: 24, rank: 9, field: 'posted' });

  const txt = renderProbeFindings(
    { hashKeys: [['content', 'uid', 'user_name', 'id']], setGroups: [], skipped: [] },
    parseProbeOutput('DP 1 0 -1'),
    { padded: parsed },
  );
  assert.match(txt, /0 种能打印成预期序/);
  assert.match(txt, /补上字段 `posted`/);
  assert.match(txt, /24 种\*\*能打印成预期的/);
  assert.match(txt, /content → user_name → id → posted → uid/);
  assert.match(txt, /值任意/);
  assert.match(txt, /不要再调可见键之间的顺序/);
});

test('补字段命令仍守住只读与白名单边界（不引入新的注入面）', () => {
  assert.ok(!/[$`]/.test(POP_FIELDS_COMMAND), 'grep 命令不得含 $ 或反引号');
  assert.match(POP_FIELDS_COMMAND, /^grep -ho /);
  assert.ok(!/redis|sh |bash/.test(POP_FIELDS_COMMAND));
  // 模式必须命中真实形态 `X.pop("字段", "404")`——引号后面是**逗号**而不是右括号。
  // 2026-09-23 真机踩过：写成 pop("[^"]*") 时一个字段都取不到（回显只有提示符），
  // 补字段这一环静默失效。这条断言把该形态钉死。
  const pat = POP_FIELDS_COMMAND.match(/'([^']+)'/)[1];
  assert.equal(pat, 'pop("[^"]*"', '模式必须以 pop(" 起、以引号止（右括号不在模式里）');
  // grep 的 BRE 里 ( 是字面量，而 JS 正则是元字符，构造时必须转义
  const re = new RegExp(pat.replace(/\(/g, '\\('), 'g');
  const real = 'user_info.pop("last_signup", "404")\npost_info.pop("posted", "404")';
  assert.deepEqual(real.match(re), ['pop("last_signup"', 'pop("posted"']);
  const cmd = paddedProbeCommands(
    [{ no: 1, keys: ['a', 'b'] }],
    ['po;rm -rf /', 'ok_name', 'bad$name', 'x`y'],
  );
  // 只有过 SAFE 白名单的字段才会生成命令
  assert.equal(cmd.length, 1);
  assert.match(cmd[0].cmd, /'ok_name'/);
});

test('0 解但没取到 pop 字段时，退回"键集合问题"而不是编造一个字段', () => {
  const txt = renderProbeFindings(
    { hashKeys: [['content', 'uid', 'user_name', 'id']], setGroups: [], skipped: [] },
    parseProbeOutput('DP 1 0 -1'),
    { padded: new Map() },
  );
  assert.match(txt, /不是顺序问题，是键集合问题/);
  assert.ok(!/补上字段/.test(txt), '没有证据就不许说补某个字段');
});

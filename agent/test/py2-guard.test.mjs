// 写入前 Python 2 语法守卫单测（1.5.0）。
//
// 背景（2026-09-22 真机事故，Redis 优先级队列题）：反思产出的"修正版"里
// `conn.blpop(*task_lists, 10)` 是 PEP 448（Python 3.5+）语法，平台运行时是
// Python 2 → 直接 SyntaxError；同一段里还有 `if not lists: continue` 的热自旋。
// 一个语法错的代价是「写入 + 一整轮评测（本关最大执行时间 120 秒）+ 一轮反思」，
// 本地毫秒级即可检出，所以做成提交前的确定性守卫。
//
// 契约（与实现的"宁漏不误报"取向一致）：
//   ① Python 3 独有语法必须被抓出（漏报只损失一轮评测）
//   ② Python 2 合法写法不得被抓（误报会让模型来回改本来正确的代码——本项目吃过横跳的亏）
//   ③ 非 Python 提交（shell / 数据库命令）整体跳过
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';

const { checkPython2Syntax, formatPython2Problems } = await import('../src/py2-guard.mjs');

const H = '#!/usr/bin/env python\n#-*- coding:utf-8 -*-\nimport redis\nconn = redis.Redis()\n';

const rules = (code) => {
  const r = checkPython2Syntax(code);
  return r.skipped
    ? `SKIP:${r.skipped}`
    : r.problems
        .map((p) => p.rule)
        .sort()
        .join(',');
};

test('事故原文：blpop(*lists, 10) 的 PEP 448 形态被抓出', () => {
  const code = `${H}def pop_task():\n    while True:\n        lists = conn.zrevrange("p", 0, -1)\n        r = conn.blpop(*lists, 10)\n        if r: return r[1]\n`;
  const r = checkPython2Syntax(code);
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].rule, 'pep448_positional_after_star');
  assert.equal(r.problems[0].line, 8, '行号应指向出错的那一行');
  assert.match(r.problems[0].snippet, /conn\.blpop\(\*lists, 10\)/, '应带出错行原文，便于模型定位');
});

test('Python 2 正确写法（列表形式 + timeout 关键字）不得报', () => {
  assert.equal(
    rules(`${H}r = conn.blpop(list(conn.zrevrange("p", 0, -1)), timeout=10)\nprint r\n`),
    '',
  );
});

test('解包后接关键字实参是 Python 2 合法形态，不得报', () => {
  assert.equal(rules(`${H}keys = ["a", "b"]\nprint conn.blpop(*keys, timeout=10)\n`), '');
});

test('多个 * / ** 解包、字面量内解包都要报', () => {
  assert.equal(
    rules(`${H}a = [1]\nb = [2]\nc = [*a, *b]\nd = {**{"x": 1}, "y": 2}\nprint c, d\n`).includes(
      'star_in_display',
    ),
    true,
  );
  assert.match(rules(`${H}def f(x, **kw):\n    return g(**kw, **kw)\n`), /pep448_multi_star/);
});

test('f-string / 海象 / 注解 / 无参 super / nonlocal / yield from / async 都要报', () => {
  assert.match(rules(`${H}n = 3\nprint f"{n}"\n`), /fstring/);
  assert.match(rules(`${H}if (m := len("abc")) > 0:\n    print m\n`), /walrus/);
  assert.match(rules(`${H}def add(a: int, b) -> int:\n    return a + b\n`), /param_annotation/);
  assert.match(rules(`${H}def add(a: int, b) -> int:\n    return a + b\n`), /return_annotation/);
  assert.match(
    rules(`${H}class C(object):\n    def __init__(self):\n        super().__init__()\n`),
    /bare_super/,
  );
  assert.match(
    rules(`${H}def j():\n    x = 1\n    def k():\n        nonlocal x\n        x += 1\n`),
    /nonlocal/,
  );
  assert.match(rules(`${H}def g():\n    yield from [1, 2]\n`), /yield_from/);
  assert.match(rules(`${H}async def i():\n    await g()\n`), /async_await/);
  assert.match(rules(`${H}def f(a, *, b=1):\n    return a, b\n`), /kw_only_marker/);
  assert.match(rules(`${H}count: int = 1\nprint count\n`), /var_annotation/);
  assert.match(
    rules(`${H}try:\n    g()\nexcept ValueError:\n    raise RuntimeError("x") from None\n`),
    /raise_from/,
  );
});

test('Python 2 合法综合样本不得报（含切片/字典/lambda 默认值/异常逗号形态/乘号续行）', () => {
  const py2 = `${H}import sys, time
vals = [1, 2, 3]
squares = [v * v for v in vals]
d = {"k": 1,
     "j": 2}
f = lambda a, b=a: a == b
total = (
    vals[0]
    * 2
    * 3
)
for i, v in enumerate(vals):
    print "%d %d" % (i, v)
sl1 = vals[1:]
sl2 = vals[1:len(vals):2]
sl3 = vals[::2]
try:
    conn.set("k", "v")
except ValueError, e:
    print e
conn.zadd("testzset", "member2", 3)
conn.rpush("l", "x")
r = conn.blpop("clist", timeout=5)
print r[1]
msg = "a dict-like string: with colon = sign"
`;
  assert.equal(rules(py2), '', 'Python 2 合法代码被守卫误报');
});

test('字符串与注释里的 f"/:=/-> 不参与判定（掩码生效）', () => {
  assert.equal(
    rules(
      `${H}# explain --> f"{x}" and (m := 1) live in a comment\ns = "text with := and -> too"\nprint s\n`,
    ),
    '',
  );
});

test('非 Python 提交整体跳过（shell / 数据库命令题）', () => {
  const shell = 'echo "\ndb.educoder.aggregate([{$sort:{learning_num:1}}]);\n"\n';
  assert.equal(checkPython2Syntax(shell).skipped, 'not-python');
  assert.equal(checkPython2Syntax('').skipped, 'empty');
});

test('守卫自身异常必须放行（fail-open，不得阻断作答）', () => {
  // 括号严重不配对：栈被 pop 空也不能抛异常，最坏是漏报
  const r = checkPython2Syntax(`${H}x = (((((\n))))))((\nprint x\n`);
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.ok || Array.isArray(r.problems));
});

test('formatPython2Problems 渲染出行号与修正建议', () => {
  const r = checkPython2Syntax(`${H}conn.blpop(*["a"], 10)\nprint f"{1}"\n`);
  const text = formatPython2Problems(r.problems);
  assert.match(text, /第 5 行/);
  assert.match(text, /PEP 448/);
  assert.match(text, /f-string/);
});

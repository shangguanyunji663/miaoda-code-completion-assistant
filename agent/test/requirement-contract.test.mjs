// 题面契约层单测（1.6.0）。
//
// 背景：本项目三次栽在同一处——模型用工程常识覆盖题面明文要求（逐队列 blpop 顶掉
// 多键 blpop、转移一个任务就 return、把评测程序打印的行自己 print）。守则文字是
// 约束力最弱的一层（规则越多单条越弱），所以这里做的是**可机器判定**的三件事：
// ① 从当次题干确定性切出「编程要求」条目；② 要求模型逐条抄原文 + 给落点；
// ③ 校验漏条目 / 改写编造摘录 / 行号越界。切不出清单就整层不启用（跨平台 fail-open）。
//
// 题干 fixture 取自两道真机题（Redis 优先级队列关 / Redis 定时任务队列关），
// 测的是**切条器与校验器**，不是给某道题存答案。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';

const { extractRequirementContract, renderContractBlock, parseAlignmentTable, validateAlignment } =
  await import('../src/requirement-contract.mjs');

const PRIORITY_TASK = `任务描述
本关任务：使用 Redis 构建一个区分优先级的任务队列。
相关知识
rpush：将一个值插入到列表尾部，保证后插入的在最尾部。
编程要求
在Begin-End区域编写 add_task_list(list_name, priority) 函数，实现设置任务队列优先级的功能，具体参数与要求如下：
方法参数 list_name 是要加入的任务队列名字，priority 是要设置的优先权重，值越大则级别越高；
设置队列优先级的实现：将任务队列加入到有序集合 task:priority 中，分值为 priority。
编写 pop_task()函数，实现获取一个任务的功能，具体参数与要求如下：
排序任务队列的实现：将有序集合 task:priority 中的所有成员按照分值递减的顺序排列；
获取任务的实现：按照上述队列的顺序，从第一个非空列表的头部阻塞式的弹出一个值，最长等待10秒；
任务返回的实现：获取任务成功后，返回该值中弹出的元素值。
测试说明
平台会对你编写的代码进行测试：
测试输入：h,e,l,o,d,u,c,r；
预期输出：
测试 add_task_list 方法...
出队列顺序：['h', 'o', 'c']`;

const DELAY_TASK = `任务描述
本关任务：使用 Redis 构建定时执行任务队列。
编程要求
编写 pop_task() 函数，实现转移可执行任务的功能，具体参数与要求如下：
获取队列中第一个任务的实现：不断尝试获取有序集合task:delayed中按分值递增顺序的第一个元素；
判断该任务是否可执行的实现：若未取到任务或者任务的执行时间未到，则休眠 0.01 秒，然后继续尝试获取第一个任务；
任务转移的实现：从有序集合task:delayed中移除该任务，成功后，将该任务插入到列表task:list的尾部。
测试说明
测试输入：无；
预期输出：
等待0.6秒后，普通任务队列长度为：3`;

test('真题题干：一条要求都不许丢（引导语行不得被并进上一条后误杀）', () => {
  const c = extractRequirementContract(PRIORITY_TASK);
  assert.equal(c.present, true);
  assert.equal(c.source, '编程要求');
  assert.equal(c.items.length, 7);
  const all = c.items.join('\n');
  for (const key of [
    '值越大则级别越高',
    '有序集合 task:priority 中，分值为 priority',
    '按照分值递减的顺序排列',
    '从第一个非空列表的头部阻塞式的弹出一个值',
    '返回该值中弹出的元素值',
  ]) {
    assert.ok(all.includes(key), `切条丢了要求：${key}`);
  }
  // 「测试说明」的预期输出也带出来，供"哪些行该由你打印"判断
  assert.match(c.expectedOutput, /出队列顺序/);
});

test('没有「编程要求」这类标题的题干 → 整层不启用（跨平台 fail-open）', () => {
  for (const t of [
    '请把下面这段 Java 代码补充完整。',
    '',
    'Write a function that returns the sum.',
  ]) {
    const c = extractRequirementContract(t);
    assert.equal(c.present, false, `不该启用：${t.slice(0, 20)}`);
    assert.equal(renderContractBlock(c), '');
    assert.equal(validateAlignment({ contract: c, rows: [], code: 'x' }).skipped, 'no-contract');
  }
});

test('对齐表解析：半角/全角竖线、markdown 前缀、无编号分隔符都认', () => {
  const rows = parseAlignmentTable(`
- 1 | ${'方法参数 list_name 是要加入的任务队列名字'} | 12 | 用 zadd 存分值
2 ｜ 按照分值递减的顺序排列 ｜ L13-15 ｜ 排序
**3** | 返回该值中弹出的元素值 | 16 | 返回弹出值
说明性文字，不该被当成表行
`);
  assert.deepEqual(
    rows.map((r) => r.no),
    [1, 2, 3],
  );
  assert.equal(rows[1].where, 'L13-15');
  assert.match(rows[0].quote, /list_name/);
});

test('漏答条目 = 打回级问题，一条都不能少', () => {
  const c = extractRequirementContract(DELAY_TASK);
  assert.equal(c.items.length, 4);
  const rows = parseAlignmentTable(`1 | ${c.items[0]} | 3 | 常驻循环取头一个`);
  const v = validateAlignment({ contract: c, rows, code: 'a\nb\nc\n' });
  assert.equal(v.ok, false);
  assert.equal(v.problems.filter((p) => p.kind === 'missing_item').length, 3, '漏 3 条应报 3 处');
});

test('改写/编造摘录 = 打回级；原样抄写但空白与引号不同 = 放过', () => {
  const c = extractRequirementContract(DELAY_TASK);
  const honest = `1 | ${c.items[1]} | 4 | 未到就休眠再试
2 | "若未取到任务或者任务的执行时间未到，则休眠 0.01 秒" | 5 | 同一条
3 | ${c.items[2]} | 6 | 移除成功后插入
4 | ${c.items[3]} | 7 | 转移落点`;
  assert.equal(
    validateAlignment({ contract: c, rows: parseAlignmentTable(honest), code: 'x\n'.repeat(9) }).ok,
    true,
  );

  const invented = `1 | ${c.items[0]} | 4 | ok
2 | 列表为空时直接返回 None，避免死循环 | 5 | 我自己的想法
3 | ${c.items[2]} | 6 | ok
4 | ${c.items[3]} | 7 | ok`;
  const v = validateAlignment({
    contract: c,
    rows: parseAlignmentTable(invented),
    code: 'x\n'.repeat(9),
  });
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].kind, 'bad_quote');
  assert.match(v.problems[0].message, /疑似凭记忆改写/);
});

test('行号只作提示不作打回（模板拼接会让行号整体偏移，当硬判据会误伤）', () => {
  const c = extractRequirementContract(DELAY_TASK);
  const rows = parseAlignmentTable(`1 | ${c.items[0]} | 999 | 行号越界
2 | ${c.items[1]} |  | 没给行号
3 | ${c.items[2]} | 5 | ok
4 | ${c.items[3]} | 6 | ok`);
  const v = validateAlignment({ contract: c, rows, code: 'a\nb\nc\nd\ne\nf\n' });
  assert.equal(v.ok, true, '行号问题不得拦提交');
  assert.deepEqual(v.advisories.map((a) => a.kind).sort(), ['bad_line', 'no_landing']);
});

test('渲染出的清单要求逐编号作答，且带预期输出摘录', () => {
  const block = renderContractBlock(extractRequirementContract(PRIORITY_TASK));
  assert.match(block, /【题面要求清单】/);
  assert.match(block, /^1\. /m);
  assert.match(block, /7\. /m);
  assert.match(block, /【题面预期输出/);
});

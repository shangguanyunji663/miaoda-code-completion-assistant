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

const {
  extractRequirementContract,
  renderContractBlock,
  parseAlignmentTable,
  validateAlignment,
  findRedundantPrints,
  formatAlignmentProblems,
} = await import('../src/requirement-contract.mjs');

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

// ---- 1.6.2 冗余 print 守卫（真机反向索引关：模型把评测程序打印的行复制进被测函数，
//      第 2 轮加 print、第 5 轮删 print 才通过——同一坑本项目已栽三次）----

const NO_PRINT_CONTRACT = extractRequirementContract(PRIORITY_TASK); // 其「编程要求」无任何输出措辞
const SUBMIT_CODE = [
  '#!/usr/bin/env python',
  'import redis',
  'conn = redis.Redis()',
  'def index_document(content):',
  '    #********* Begin *********#',
  '    doc_id = conn.incr("content:id")',
  '    print "当前全文编号: %s" % doc_id',
  '    print "当前索引词:"',
  '    #********* End *********#',
  '',
].join('\n');

test('题面未要求输出时，Begin/End 里的 print 逐行被抓（行号指向提交文本）', () => {
  const hits = findRedundantPrints({
    requireText: NO_PRINT_CONTRACT.requireText,
    code: SUBMIT_CODE,
  });
  assert.deepEqual(
    hits.map((h) => h.line),
    [7, 8],
  );
  assert.match(hits[0].text, /当前全文编号/);
});

test('「编程要求」里出现"输出/打印/print"任一措辞 → 整题不启用守卫（要求打印的题绝不误伤）', () => {
  assert.deepEqual(
    findRedundantPrints({ requireText: '按以下格式打印结果，并输出每行内容', code: SUBMIT_CODE }),
    [],
  );
});

test('注释里的 print 与标记区域外的模板原有 print 不算', () => {
  const code = [
    'def f(x):',
    '    #********* Begin *********#',
    '    # print 这行是注释不是输出',
    '    return x',
    '    #********* End *********#',
    'print "模板顶层原有"',
    '',
  ].join('\n');
  assert.deepEqual(findRedundantPrints({ requireText: NO_PRINT_CONTRACT.requireText, code }), []);
});

test('问题渲染：print 与空区域用自带标签，不与"要求条目第 N 条"混号', () => {
  const text = formatAlignmentProblems([
    { no: 2, message: '漏答第 2 条要求' },
    { no: 7, label: '代码第 7 行', message: '这行 print 属多余' },
  ]);
  assert.match(text, /- 第 2 条｜漏答/);
  assert.match(text, /- 代码第 7 行｜这行 print/);
});

test('没有 Begin/End 标记时按整段判（不因找不到区域而漏判）', () => {
  const code = ['def f():', '    return 1', 'print "多余输出"', ''].join('\n');
  assert.deepEqual(
    findRedundantPrints({ requireText: NO_PRINT_CONTRACT.requireText, code }).map((h) => h.line),
    [3],
  );
});

// ---- 1.6.1：修 1.6.0 真机误伤（5 轮白烧 8 次打回）的两条回归 ----

const TWO_HEADERS = `任务描述
本关任务：编写一个将文本标记化并创建反向索引的程序。
任务要求
请实现 tokenize 与 index_document 两个函数。
相关知识
incr：将 key 中储存的数字值增一。
编程要求
在Begin-End区域编写 tokenize(content) 函数，实现文本标记化的功能，具体参数与要求如下：
文本标记的实现：使用正则表达式提取全小写化后的文本中长度 >= 2 的英文单词，并将这些标记词依次记录到标记词集合中；
返回标记词的实现：返回（return）标记词集合。
测试说明
测试输入：Design Patterns
预期输出：
该全文的索引为：['design']`;

test('题干里的页面导航残渣不得当成要求（真机：「参考答案 记录 评论」被编造了落点）', () => {
  const c = extractRequirementContract(
    '编程要求\n参考答案 记录 评论\n在Begin-End区域编写 create_user(login_name, real_name) 函数，实现创建新用户的功能：\n重名检测的实现：查询哈希键users中是否存在与用户登录名同名的域，若存在，则返回None；',
  );
  assert.equal(c.items.length, 2);
  assert.ok(!c.items.some((s) => s.includes('参考答案')), '导航残渣未被剔除');
});

test('一道题里同时有「任务要求」和「编程要求」时，两段的条目都要收到（旧版只取第一段 → 只切出 1 条）', () => {
  const c = extractRequirementContract(TWO_HEADERS);
  assert.equal(c.source, '任务要求+编程要求');
  assert.ok(c.items.length >= 4, `条目数应覆盖两段，实际 ${c.items.length}`);
  const all = c.items.join('\n');
  assert.ok(all.includes('请实现 tokenize 与 index_document 两个函数'), '任务要求段内容丢失');
  assert.ok(all.includes('长度 >= 2 的英文单词'), '编程要求段内容丢失');
});

test('摘录只要真是题面原文就该放过（判据真值是题干全文，不是切条清单）', () => {
  // 1.6.0 事故复现：切条只切到 1 条，模型从「编程要求」原样抄写却被判 bad_quote，
  // 每轮打回、每轮同样失败
  const c = extractRequirementContract(TWO_HEADERS);
  const quoted = '使用正则表达式提取全小写化后的文本中长度 >= 2 的英文单词';
  const rows = parseAlignmentTable(`1 | 请实现 tokenize 与 index_document 两个函数 | 5 | 入口
2 | ${quoted} | 8 | 正则提取
3 | 返回（return）标记词集合 | 9 | 返回`);
  const v = validateAlignment({
    contract: c,
    rows,
    code: 'a\n'.repeat(12),
    problemText: TWO_HEADERS,
  });
  assert.deepEqual(
    v.problems.filter((p) => p.kind === 'bad_quote'),
    [],
    '题面里确实有的原文不得判成幻觉',
  );
});

test('对齐表被误写进代码块内时仍能解析出来（2026-09-23 真机：16 行表格进 Begin-End）', () => {
  const submitted = [
    '#-*- coding:utf-8 -*-',
    'def create_user(login_name, real_name):',
    '#********* Begin *********#',
    '编号 | 题面原文摘录 | 实现行号 | 一句话说明',
    '1 | 在Begin-End区域编写 create_user(login_name, real_name) 函数 | 11-20 | 函数入口',
    '2 | 方法参数login_name为用户登录名，real_name为用户真名 | 12 | 参数接收',
    '#********* End *********#',
  ].join('\n');
  const rows = parseAlignmentTable(submitted);
  assert.equal(rows.length, 2, '回退解析必须能在提交文本里找到对齐表');
  assert.equal(rows[0].no, 1);
  assert.match(rows[0].quote, /在Begin-End区域编写/);
  assert.match(rows[0].where, /11-20/);
  // 纯代码零误报：位或表达式与赋值不会被当成对齐表行
  assert.deepEqual(parseAlignmentTable('x = a | b\ny = 1\n'), []);
});

test('叙述性条目不进要求清单（1.6.19 真机：missing_item ×12 把整层校验自我停用）', () => {
  const problem = [
    '编程要求',
    '现有 person.json 文件内容如下：',
    '_id\tname\tage\tsex\thobbies',
    '1\t杨璐\t19\t女\t唱歌，跳舞',
    '在右侧命令行进行操作：',
    '将 /home/example/person.json 文件导入到数据库 mydb3 中的 test 集合中。',
    '在右侧代码行 Begin-End 中编辑，如下：',
    '执行查询命令，查找年龄为20岁男生的信息，并按照_id升序排序；',
    '执行查询命令，查找name = 韩*开头的人的信息，并按照_id升序排序；',
  ].join('\n');
  const c = extractRequirementContract(problem);
  assert.equal(c.present, true);
  assert.equal(
    c.items.some((s) => /文件内容如下|进行操作：|Begin-End 中编辑/.test(s)),
    false,
    `叙述行被当成了要求，模型永远给不出落点：${c.items.join(' | ')}`,
  );
  assert.equal(c.items.filter((s) => /执行查询命令/.test(s)).length, 2, '真要求一条都不能少');
  assert.match(
    c.items.find((s) => /导入到数据库/.test(s)),
    /person\.json/,
    '可执行的数据准备要求必须保留',
  );
  // requireText 是 print 守卫的真值来源，不受切条过滤影响
  assert.match(c.requireText, /现有 person\.json 文件内容如下/);
});

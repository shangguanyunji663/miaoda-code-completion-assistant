// 1.6.19 三处新增的确定性护栏（全部来自 2026-09-24 真机同一道题 /tasks/XBLSCWNL/4883 step3）：
// ① 代码栏破坏性语句剔除 —— 第 4 轮 `db.test.remove({})` 把平台提供的 8 条文档删光，
//    之后每轮 count 恒为 0，反思却一路去改引号形态；
// ② 题面明写条数 vs 提交段数 —— 提交 7 条对 8 个标签，输出按位置整体错位；
// ③ bash 终端下裸写的 shell 语句包成 mongo --eval —— 两轮数据准备额度全烧在
//    `show dbs: command not found` / `syntax error near unexpected token` 上。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripDestructiveDbStatements,
  parseDeclaredCommandCount,
  detectCommandCountViolation,
  detectShellInvocationViolation,
  looksLikeDbScript,
  splitStatements,
  submissionBody,
  wrapBareDbStatementsForShell,
  planReplExit,
  wrapDbCommandsInEcho,
} from '../src/ai.mjs';
import { finalizeSubmission } from '../src/loop.mjs';

const B = '#********* Begin *********#';
const E = '#********* End *********#';
const PROBLEM_8 = '执行查询命令，……注意：上述操作共有八条命令，每条命令以；号隔开。';

/** 真机第 5 轮实际写进编辑器的文本形态（漏了「查找name != 韩*开头的人的信息」那条 find） */
const SEVEN = [
  "db.getSiblingDB('mydb3').test.find({age:20,sex:'男'}).sort({_id:1})",
  "db.getSiblingDB('mydb3').test.find({\\$or:[{age:20},{sex:'男'}]}).sort({_id:1})",
  "db.getSiblingDB('mydb3').test.find({name:/^韩.*/}).sort({_id:1})",
  "db.getSiblingDB('mydb3').test.find({age:{\\$gte:19,\\$lt:22}}).sort({_id:1})",
  "db.getSiblingDB('mydb3').test.find({\\$or:[{age:{\\$lt:19}},{age:{\\$gt:21}}]}).sort({_id:1})",
  "db.getSiblingDB('mydb3').test.find({name:{\\$not:/^韩.*/}}).count()",
  "db.getSiblingDB('mydb3').test.find({age:{\\$gte:19,\\$lt:22}}).count()",
].join(';');

// ---------- ① 破坏性语句剔除 ----------

test('代码栏里的 remove/mongoimport 被切掉，其余字节不动', () => {
  const src = `${B}\necho "\nmongoimport --db mydb3 --collection test --file /home/example/person.json;db.test.remove({});db.test.find({age:20}).sort({_id:1})\n"\n${E}\n`;
  const r = stripDestructiveDbStatements(src);
  assert.equal(r.dropped.length, 2, r.dropped.join(' | '));
  assert.ok(!r.code.includes('mongoimport'));
  assert.ok(!r.code.includes('remove('));
  assert.ok(r.code.includes('db.test.find({age:20}).sort({_id:1})'), '查询语句必须原样保留');
  assert.ok(r.code.includes('echo "'), '外层包裹形态不被改写');
});

test('find 里的 $ne/$nin 等含 remove/delete 字样的合法查询不误伤（宁漏不误删）', () => {
  const src = `${B}\ndb.test.find({status:{$ne:'removed'}}).count()\n${E}`;
  assert.deepEqual(stripDestructiveDbStatements(src).dropped, []);
});

test('普通 Python 编程题整体跳过（无 db 脚本形态）', () => {
  const src = `${B}\nitems = [1, 2, 3]\nitems.remove(1)\nprint(items)\n${E}`;
  const r = stripDestructiveDbStatements(src);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.code, src);
});

test('无破坏性语句时逐字节返回原文（幂等）', () => {
  const src = `${B}\necho "\n${SEVEN}\n"\n${E}\n`;
  const r = stripDestructiveDbStatements(src);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.code, src);
});

// ---------- ② 条数核对 ----------

test('题面中文数字条数解析', () => {
  assert.equal(parseDeclaredCommandCount('上述操作共有八条命令'), 8);
  assert.equal(parseDeclaredCommandCount('共有 12 条命令'), 12);
  assert.equal(parseDeclaredCommandCount('上述查询共十二条语句'), 12);
  assert.equal(parseDeclaredCommandCount('本关任务：完成文档查询。'), null);
});

test('真机复现：提交 7 条而题面写八条 ⇒ 给出条数差与错位解释', () => {
  const src = `${B}\necho "\n${SEVEN}\n"\n${E}\n`;
  const note = detectCommandCountViolation(src, PROBLEM_8);
  assert.match(note, /共 8 条命令/);
  assert.match(note, /只有 7 条/);
  assert.match(note, /漏答/);
  assert.match(note, /按位置/);
});

test('补齐第 6 条后不误报', () => {
  const eight = SEVEN.replace(
    ";db.getSiblingDB('mydb3').test.find({name:{\\$not:/^韩.*/}}).count()",
    ";db.getSiblingDB('mydb3').test.find({name:{\\$not:/^韩.*/}}).sort({_id:1});db.getSiblingDB('mydb3').test.find({name:{\\$not:/^韩.*/}}).count()",
  );
  assert.equal(detectCommandCountViolation(`${B}\necho "\n${eight}\n"\n${E}\n`, PROBLEM_8), '');
});

test('题面未声明条数时不判；非 db 脚本正文也不判（不越权）', () => {
  const src = `${B}\necho "\n${SEVEN}\n"\n${E}\n`;
  assert.equal(detectCommandCountViolation(src, '本关任务：完成文档查询。'), '');
  assert.equal(detectCommandCountViolation(`${B}\nprint(1)\n${E}`, PROBLEM_8), '');
});

// ---------- 纯函数自身契约 ----------

test('splitStatements 保留偏移，且与平台一致地按分号硬切', () => {
  const t = 'db.a.find();db.b.count();';
  const list = splitStatements(t);
  assert.equal(list.length, 2);
  assert.equal(t.slice(list[1].start, list[1].end), 'db.b.count()');
});

test('looksLikeDbScript：echo 前缀与 use/show 都算，Python 主体不算', () => {
  assert.equal(looksLikeDbScript(`echo "\ndb.x.find({})\n"`), true);
  assert.equal(looksLikeDbScript('use mydb3\nshow collections'), true);
  assert.equal(looksLikeDbScript('def f():\n    return 1'), false);
});

test('submissionBody 有无标记两种输入都拿到正文', () => {
  assert.equal(submissionBody(`${B}\ndb.x.find()\n${E}`).body.trim(), 'db.x.find()');
  assert.equal(submissionBody('db.x.find()').bare, true);
});

// ---------- ③ bash 终端下的 shell 包裹 ----------

test('裸 db.* 包成 mongo --eval；show 走交互模式（1.6.25 分开处理）', () => {
  const r = wrapBareDbStatementsForShell(['show dbs', 'db.test.count()'], { db: 'mydb3' });
  // `show` 是 shell 的交互内建、不是 JS：`mongo --eval 'show dbs'` 实测必报
  // `SyntaxError … @(shell eval)`（2026-09-25 真机 17:51:57）。平台自己的 Testdb.sh
  // 用的就是 `echo $sql | mongo --quiet --shell`，照它。
  assert.deepEqual(r.cmds, [
    "echo 'show dbs' | mongo --quiet mydb3 --shell",
    "mongo --quiet mydb3 --eval 'db.test.count()'",
  ]);
  assert.equal(r.wrapped.length, 2);
});

test('use 的库名往下带（旧版丢掉 use 却不接住，--eval 打在默认库上）', () => {
  // 2026-09-25 真机 setProfilingLevel 关：模型连续三轮诊断出"未先切换到 mydb"，
  // 每一轮执行层都把 `use mydb` 丢掉、又不带库名 ⇒ 永远改不对
  const r = wrapBareDbStatementsForShell(
    ['use mydb', 'db.setProfilingLevel(1, 50)', 'show profile'],
    { db: '' },
  );
  assert.deepEqual(r.cmds, [
    "mongo --quiet mydb --eval 'db.setProfilingLevel(1, 50)'",
    "echo 'show profile' | mongo --quiet mydb --shell",
  ]);
  assert.equal(r.dropped[0].no, 1, 'use 整行进 dropped，不再混进 wrapped');
  assert.match(r.dropped[0].to, /mydb/);
});

test('有序列化语句时，光杆 mongo 被丢弃（否则终端就地变成 REPL，后续 --eval 全敲进 REPL）', () => {
  const r = wrapBareDbStatementsForShell(['mongo', 'use mydb', 'db.setProfilingLevel(1, 50)'], {
    db: '',
  });
  assert.deepEqual(r.cmds, ["mongo --quiet mydb --eval 'db.setProfilingLevel(1, 50)'"]);
  assert.ok(r.dropped.some((d) => d.from === 'mongo'));
  // 没有任何语句要包裹时不许动它（模型可能就是单纯要进 REPL）
  const keep = wrapBareDbStatementsForShell(['mongo', 'ls -l'], {});
  assert.deepEqual(keep.cmds, ['mongo', 'ls -l']);
});

test('语句内含单引号时改双引号并转义 $（否则 bash 把 $or 吃掉）', () => {
  const r = wrapBareDbStatementsForShell(["db.test.find({\\$or:[{a:1}],name:'男'})"], {
    db: 'mydb3',
  });
  assert.match(r.cmds[0], /^mongo --quiet mydb3 --eval "/);
  assert.ok(r.cmds[0].includes('\\$or'), '$ 必须被转义');
  assert.ok(r.cmds[0].includes("'男'"), '内部单引号原样保留');
});

test('use 整行丢弃（库名改由每条语句自带），普通 shell 命令不动', () => {
  const r = wrapBareDbStatementsForShell(
    ['use mydb3', 'ls -l /home/example/person.json', 'mongoimport --db mydb3 --file a.json'],
    { db: 'mydb3' },
  );
  assert.deepEqual(r.cmds, [
    'ls -l /home/example/person.json',
    'mongoimport --db mydb3 --file a.json',
  ]);
  assert.equal(r.dropped[0].no, 1);
});

test('未给库名时不带 --quiet <db>（跨平台/未知题面 fail-open）', () => {
  assert.equal(
    wrapBareDbStatementsForShell(['db.test.count()'], {}).cmds[0],
    "mongo --eval 'db.test.count()'",
  );
});

// ---------- 死循环回归：兜底与判据不再互相抵消 ----------

test('逐行 echo 单引号形态：只删命中行，正确查询一条都不能陪葬', () => {
  const good = "echo 'db.test.find({age:20,sex:'男'}).sort({_id:1})'";
  const src = `${B}\necho 'mongoimport --db mydb3 --collection test --file /home/example/person.json'\necho 'db.test.remove({})'\n${good}\n${E}\n`;
  const r = stripDestructiveDbStatements(src);
  assert.equal(r.dropped.length, 2);
  assert.ok(r.code.includes(good), '第三条必须逐字节保留');
  // 关键：不得留下不成对的引号（旧实现只删引号内内容，毁掉整段）
  assert.ok(
    !/echo '[^'\n]*$/.test(r.code.split('\n').find((l) => l.includes('mongoimport')) ?? ''),
  );
  assert.ok(!r.code.includes("echo '\n"));
});

test('一条命令一行（无分号）时条数按行数计，不会报成"只有 1 条"', () => {
  const eight = [
    "db.test.find({age:20,sex:'男'}).sort({_id:1})",
    "db.test.find({\\$or:[{age:20},{sex:'男'}]}).sort({_id:1})",
    'db.test.find({name:/^韩.*/}).sort({_id:1})',
    'db.test.find({age:{\\$gte:19,\\$lt:22}}).sort({_id:1})',
    'db.test.find({\\$or:[{age:{\\$lt:19}},{age:{\\$gt:21}}]}).sort({_id:1})',
    'db.test.find({name:{\\$not:/^韩.*/}}).sort({_id:1})',
    'db.test.find({name:{\\$not:/^韩.*/}}).count()',
    'db.test.find({age:{\\$gte:19,\\$lt:22}}).count()',
  ].join('\n');
  assert.equal(detectCommandCountViolation(`${B}\n${eight}\n${E}\n`, PROBLEM_8), '');
  assert.match(
    detectCommandCountViolation(
      `${B}\n${eight.split('\n').slice(0, 6).join('\n')}\n${E}\n`,
      PROBLEM_8,
    ),
    /只有 6 条/,
  );
});

test('回归：echo 兜底包出来的文本，不会被形态判据说成违约', async () => {
  const { detectSubmissionFormViolations } = await import('../src/ai.mjs');
  const problem =
    '注意：上述操作共有八条命令，每条命令以；号隔开（请在$前加\\，即使用\\$；不要使用双引号改用 单引号）。';
  const bare = `${B}\n${SEVEN.split(';').join('\n')}\n${E}\n`;
  const wrapped = wrapDbCommandsInEcho(bare).code;
  assert.equal(wrapDbCommandsInEcho(bare).wrapped, true);
  const vs = detectSubmissionFormViolations(wrapped, problem);
  assert.deepEqual(
    vs.filter((v) => /双引号/.test(v)),
    [],
    `外层 echo 包裹不应判违约：${vs.join(' | ')}`,
  );
});

// ---------- 1.6.21：代码栏 shell 调用形态判据 ----------

test('代码栏里的 heredoc 起始 / mongo 命令前缀被点名，裸语句与 shell 脚本主体不误伤', () => {
  // heredoc 行混在 db 语句中间（真机事故形态：反思给出"用 heredoc 导入"策略）
  const src = `${B}\ndb.test.find({age:20});db.test.find({sex:'男'});db.test.count()\nmongo <<'EOF'\n${E}\n`;
  const note = detectShellInvocationViolation(src);
  assert.match(note, /shell 调用形态/);
  assert.match(note, /mongo/);
  // 纯裸语句（执行层会包 echo）零触发
  assert.equal(detectShellInvocationViolation(`${B}\ndb.test.find({age:20})\n${E}\n`), '');
  // 普通 shell 脚本主体（looksLikeDbScript 不过）不越权——宁漏不误报
  assert.equal(
    detectShellInvocationViolation(`${B}\ncat > /tmp/a <<'EOF'\nhello\nEOF\n${E}\n`),
    '',
  );
  // 已被破坏性剔除覆盖的 mongoimport 不在本判据重复点名
  assert.equal(
    detectShellInvocationViolation(
      `${B}\nmongoimport --db mydb3 --file /home/example/person.json\n${E}\n`,
    ),
    '',
  );
});

// ---------- 1.6.21：形态体检随 finalizeSubmission 每次拼接一起执行 ----------

test('finalizeSubmission 返回 formViolations；修复后的文本重检而不是沿用旧结论', () => {
  const tpl = `${B}\n\n${E}\n`;
  const bad = "db.mydb3.test.find({age:20,sex:'男'})";
  const first = finalizeSubmission(tpl, bad, '在代码栏编写查询。');
  assert.ok(
    first.formViolations.some((v) => /库名/.test(v)),
    `应检出 db.<库名>.<集合名> 形态：${first.formViolations.join(' | ')}`,
  );
  assert.ok(first.sanitizeNote.includes('库名'), '违约说明随 sanitizeNote 下发反思材料');
  const fixed = finalizeSubmission(tpl, "db.test.find({age:20,sex:'男'})", '在代码栏编写查询。');
  assert.deepEqual(fixed.formViolations, [], '修复后的文本应重检为零违约');
});

// ---------- ④ REPL 里写着 bash 形态：先 exit，不改写命令（1.6.25） ----------

test('planReplExit：在 mongo REPL 里敲 mongo/ls → 序列开头插一条 exit', () => {
  const r = planReplExit({ kind: 'mongosh' }, ["mongo --eval 'db.x.count()'", 'ls -l /opt']);
  assert.deepEqual(r.cmds.slice(0, 3), ['exit', "mongo --eval 'db.x.count()'", 'ls -l /opt']);
  assert.deepEqual(
    r.exitFor.map((e) => e.head),
    ['mongo', 'ls'],
  );
});

test('planReplExit：REPL 里的合法语句一律不动（宁漏不误报）', () => {
  assert.deepEqual(
    planReplExit({ kind: 'mongosh' }, ['use mydb', 'db.setProfilingLevel(1, 50)', 'show profile'])
      .cmds,
    ['use mydb', 'db.setProfilingLevel(1, 50)', 'show profile'],
  );
  assert.deepEqual(planReplExit({ kind: 'mysql' }, ['SHOW DATABASES;']).exitFor, []);
  assert.deepEqual(planReplExit({ kind: 'redis' }, ['PING', 'KEYS *']).exitFor, []);
});

test('planReplExit：bash 与 unknown 环境不介入（护栏只在实测 REPL 下生效）', () => {
  assert.deepEqual(planReplExit({ kind: 'bash' }, ['ls -l', 'mongo']).exitFor, []);
  assert.deepEqual(planReplExit({ kind: 'unknown' }, ['ls -l']).exitFor, []);
  assert.deepEqual(planReplExit(null, []).exitFor, []);
});

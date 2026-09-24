// 两条机器护栏（2026-09-23 真机）：
// ① 覆盖"题面声明为现有输入"的文件 —— 平台提供的数据源，禁止自造/覆盖；
// ② 题面明文要求语句内用单引号而提交仍用双引号 —— prompt 压不住（模型按"实测优先"选了双引号），改机器判。
//
// 1.6.19 收窄 ②：旧版把**外层** `echo "` 也判成违约，而 `wrapDbCommandsInEcho` 每轮又把裸
// 语句包回 `echo "` —— 两层互相抵消，第 5/6/7 轮提交文本逐字节相同（2026-09-24 真机）。
// 现在只管数据库语句**内部**的字符串字面量。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDataFileOverwrites,
  detectQuoteFormViolation,
  detectDbCollectionRefViolation,
  detectEscapeViolation,
  parseImportTarget,
} from '../src/ai.mjs';

// 真机题干（节选）："现有 person.json 文件内容如下…将 /home/example/person.json 导入 mydb3"
const PROBLEM = [
  '编程要求',
  '现有 person.json 文件内容如下：',
  '_id\tname\tage',
  '在右侧命令行进行操作：',
  '将 /home/example/person.json 文件导入到数据库 mydb3 中的 test 集合中。',
].join('\n');

test('回归：覆盖题面「现有」文件的命令被剔除（真机形态：cat > path <<EOF）', () => {
  const cmds = [
    'mkdir -p /home/example',
    "cat > /home/example/person.json <<'EOF'",
    '{"_id":1}',
    'EOF',
    'mongoimport --db mydb3 --collection test --file /home/example/person.json --jsonArray',
  ];
  const r = findDataFileOverwrites(cmds, PROBLEM);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].path, '/home/example/person.json');
  assert.equal(
    r.kept.some((c) => c.includes('person.json')),
    true,
    '导入命令本身是只读读取，必须保留',
  );
  assert.equal(
    r.kept.some((c) => c.trim() === '{"_id":1}' || c === 'EOF'),
    true,
    'heredoc 正文/结束标记不单独判定（只剔除发起覆盖的那条）',
  );
});

test('只读命令与写其它路径不受影响（宁漏不误伤）', () => {
  const cmds = [
    'ls -l /home/example/person.json',
    'mongoimport --file /home/example/person.json -d mydb3 -c test',
    'cat /home/example/person.json',
    'mkdir -p /data/test/db1',
    "cat > /etc/test/mongod.conf <<'EOF'",
  ];
  const r = findDataFileOverwrites(cmds, PROBLEM);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.kept.length, cmds.length);
});

test('题面没把该文件称作"现有"时不动手（另一半判据）', () => {
  const cmds = ["cat > /home/example/person.json <<'EOF'"];
  const p = '请在 /home/example/person.json 写一份自己构造的测试数据';
  assert.deepEqual(findDataFileOverwrites(cmds, p).dropped, []);
});

test('语句内部用双引号 ⇒ 命中，且明确告诉模型外层包裹不要动', () => {
  const problem = '注意：请在 $ 前加 \\，即使用 \\$；不要使用双引号改用 单引号。';
  const bad = '#*** Begin ***#\necho "\ndb.test.find({sex:\\"男\\"});\n"\n#*** End ***#';
  const note = detectQuoteFormViolation(bad, problem);
  assert.match(note, /不要使用双引号/);
  assert.match(note, /数据库语句内部/);
  assert.match(note, /外层 echo 的双引号包裹属平台机制，保持原样不要动/);
});

test('回归（1.6.19 死循环根因）：外层 echo 包裹本身不算违约', () => {
  const problem = '注意：请在 $ 前加 \\，即使用 \\$；不要使用双引号改用 单引号。';
  // 真机第 5/6/7 轮实际写进编辑器的形态：外层 echo "、内层单引号、$ 已转义
  const ok =
    '#*** Begin ***#\necho "\ndb.test.find({age:20,sex:\'男\'}).sort({_id:1});db.test.find({\\$or:[{a:1}]}).count()\n"\n#*** End ***#';
  assert.equal(detectQuoteFormViolation(ok, problem), '');
});

test('合规提交不误报：题面禁双引号 + 代码已用单引号/无 echo 包裹', () => {
  const problem = '不要使用双引号改用 单引号';
  assert.equal(detectQuoteFormViolation("db.test.find({sex:'男'}).sort({_id:1})", problem), '');
});

test('题面没说引号形态时不判（不越权）', () => {
  assert.equal(detectQuoteFormViolation('echo "\ndb.x.find();\n"', '本关任务：完成文档查询。'), '');
});

test('回归：`db.<库名>.<集合名>` 被机器判为非法形态（真机：8 条查询全空而看不出原因）', () => {
  const code = '#*** Begin ***#\ndb.mydb3.test.find({age:20}).sort({_id:1})\n#*** End ***#';
  const note = detectDbCollectionRefViolation(code);
  assert.match(note, /db\.mydb3\./);
  assert.match(note, /静默/); // 实测：不报错，而是静默指向空集合
  assert.match(note, /db\.test\./, '应给出改写后的形态');
});

test('合法形态不误报：db.<集合> / getCollection / getSiblingDB / db.stats()', () => {
  for (const ok of [
    'db.test.find({age:20})',
    "db.getCollection('test').find({})",
    "db.getSiblingDB('mydb3').test.find({})",
    'db.stats()',
  ]) {
    assert.equal(detectDbCollectionRefViolation(ok), '', ok);
  }
});

test('题面要求 $ 前加转义而未转义 ⇒ 命中；已转义不误报', () => {
  const problem = '注意：请在$前加\\（转义符），即使用\\$；不要使用双引号改用 单引号。';
  assert.match(detectEscapeViolation("find({hobbies:{$all:['a']}})", problem), /\$all/);
  assert.equal(detectEscapeViolation("find({hobbies:{\\$all:['a']}})", problem), '');
});

test('题面没要求转义时不判（不越权）', () => {
  assert.equal(detectEscapeViolation('find({hobbies:{$all:[]}})', '完成文档查询。'), '');
});

test('从题面解析导入目标（用于导入后实测条数）', () => {
  const t =
    '在右侧命令行进行操作：\n将 /home/example/person.json 文件导入到数据库 mydb3 中的 test 集合中。';
  assert.deepEqual(parseImportTarget(t), { db: 'mydb3', coll: 'test' });
  assert.equal(parseImportTarget('本关任务：完成文档查询。'), null);
});

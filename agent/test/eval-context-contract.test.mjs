// 两条机器护栏（2026-09-23 真机）：
// ① 覆盖"题面声明为现有输入"的文件 —— 平台提供的数据源，禁止自造/覆盖；
// ② 题面明文禁双引号而提交仍是 `echo "` —— prompt 压不住（模型按"实测优先"选了双引号），改机器判。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findDataFileOverwrites, detectQuoteFormViolation } from '../src/ai.mjs';

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

test('题面禁双引号而提交用 `echo "` ⇒ 机器给出违约结论', () => {
  const problem = '注意：请在 $ 前加 \\，即使用 \\$；不要使用双引号改用 单引号。';
  const bad = '#*** Begin ***#\necho "\ndb.test.find({sex:\\"男\\"});\n"\n#*** End ***#';
  const note = detectQuoteFormViolation(bad, problem);
  assert.match(note, /不要使用双引号/);
  assert.match(note, /echo "/);
});

test('合规提交不误报：题面禁双引号 + 代码已用单引号/无 echo 包裹', () => {
  const problem = '不要使用双引号改用 单引号';
  assert.equal(detectQuoteFormViolation("db.test.find({sex:'男'}).sort({_id:1})", problem), '');
});

test('题面没说引号形态时不判（不越权）', () => {
  assert.equal(detectQuoteFormViolation('echo "\ndb.x.find();\n"', '本关任务：完成文档查询。'), '');
});

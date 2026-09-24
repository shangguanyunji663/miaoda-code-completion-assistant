// 终端回显失败判据 + 路径只读取证（1.6.20）。
//
// fixture 全部取自 2026-09-24 真机 mongorestore 关的实际回显（用户附件）：那一关三条
// 命令因路径不对失败，模型连猜三轮路径名（每次换一种写法），而**一次都没有 ls 过目录**；
// 最强的一条线索 `don't know what to do with subdirectory …, skipping...` 因为不带 error
// 字样、退出码又是 0，从未进过"输入期报错"材料。这里锁两件事：
// ① 这类"自述没干活"的行必须被判为失败（且不误伤合法输出）；
// ② 从失败回显抠出的路径必须过注入白名单，并确定性生成只读取证命令。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEchoLine,
  isFailureEcho,
  findFailureLines,
  extractMissingPaths,
  pathProbeCommands,
  probeAnchor,
} from '../src/cmd-evidence.mjs';

// ---------- ① 两档判据 ----------

test('静默空操作档：措辞里没有 error、退出码为 0，但工具自述没干活', () => {
  const lines = [
    `2026-09-24T06:18:44.314+0000    don't know what to do with subdirectory "mongodb_1/test1", skipping...`,
    '2026-09-24T06:20:04.278+0000    Failed: error scanning filesystem: file /opt/collection_1 is a directory, not a bson file',
    '2026-09-24T06:18:44.314+0000    nothing to restore',
  ];
  for (const l of lines) {
    assert.ok(isFailureEcho(l), l);
    assert.ok(['explicit', 'silent-noop'].includes(classifyEchoLine(l)), l);
  }
  // 关键回归：旧的那条 ERROR_PATTERN 对第一行完全无感（真机因此瞎猜三轮）
  assert.equal(
    /command not found|not found|No such file|SyntaxError|Syntax error|Error:|error:|exception|Traceback|refused|timed? ?out|Unrecognized option|无法识别|错误|失败/i.test(
      lines[0],
    ),
    false,
    '第一行旧判据确实抓不到——新档存在的理由',
  );
});

test('明确错误档：今天缺的三类现在抓得到，原有的仍抓得到', () => {
  for (const l of [
    'chmod: changing permissions: Permission denied',
    'mongorestore: unknown option --nsForm',
    'E11000 duplicate key error collection: test1.person index: _id_ dup key: { : 1 }',
    'mysql: Unknown command "\\z"',
    '-bash: show: command not found',
    "-bash: syntax error near unexpected token `{'",
    'mongodump: Failed: cannot access /opt/x: No such file or directory',
    '命令执行失败',
  ]) {
    assert.equal(classifyEchoLine(l), 'explicit', l);
  }
});

test('成功输出与警告不误报（宁漏不误报：误报会让模型改本来正确的命令）', () => {
  for (const l of [
    '2026-09-24T06:18:42.899+0000    finished restoring test1.person (8 documents)',
    '2026-09-24T06:18:44.314+0000    done',
    '2026-09-24T06:18:42.899+0000    no indexes to restore',
    'the --db and --collection args should only be used when restoring from a BSON file. Other uses are deprecated',
    'root@coder:~# db.test.find({skip:10}).limit(3)',
    'imported 8 documents',
    '{ "_id" : 2, "name" : "李建学" }',
  ]) {
    assert.equal(classifyEchoLine(l), null, l);
  }
});

test('findFailureLines 保留档位与原文顺序', () => {
  const r = findFailureLines([
    'building a list of collections to restore from /opt/mongodb_1 dir',
    `don't know what to do with subdirectory "mongodb_1/test1", skipping...`,
    'done',
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].tier, 'silent-noop');
});

// ---------- ② 路径取证 ----------

test('从真机三条失败回显抠祖先目录：具体目录 + 顶层兜底，去重限三条', () => {
  const text = [
    `Failed: mongorestore target '/opt/collection_1/person/person.bson' invalid: stat /opt/collection_1/person/person.bson: no such file or directory`,
    `Failed: mongorestore target '/opt/collection_2/student/student.bson' invalid: stat /opt/collection_2/student/student.bson: no such file or directory`,
    'Failed: error scanning filesystem: file /opt/collection_1 is a directory, not a bson file',
  ].join('\n');
  assert.deepEqual(extractMissingPaths(text), ['/opt/collection_1', '/opt', '/opt/collection_2']);
  // 顶层那条负责兜住被换行劈开的半截路径；具体那条负责快
  assert.deepEqual(pathProbeCommands(extractMissingPaths(text)), [
    'find /opt/collection_1 -maxdepth 3 2>&1 | head -80',
    'find /opt -maxdepth 4 2>&1 | head -80',
    'find /opt/collection_2 -maxdepth 3 2>&1 | head -80',
  ]);
});

test('被 xterm 换行劈开的半截路径：仍给出顶层目录（查不到本身就是证据）', () => {
  assert.deepEqual(
    extractMissingPaths('/collection_1/person/person.bson: no such file or directory'),
    ['/collection_1/person', '/collection_1'],
  );
});

test('注入面：来自网页/终端文本的路径必须过白名单，含元字符的一律不进命令', () => {
  const dirty = [
    '/a/b; rm -rf / no such file or directory',
    '/x/y`id`.bson: No such file or directory',
    '/etc/$(whoami)/pass: cannot access',
    '/opt/a b/c.json: no such file or directory',
  ].join('\n');
  const roots = extractMissingPaths(dirty);
  assert.ok(roots.length > 0, '干净前缀应当保留: ' + roots.join(','));
  for (const r of roots) {
    assert.match(r, /^\/[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/, `不该放行: ${r}`);
  }
  const cmds = pathProbeCommands(roots);
  assert.ok(cmds.length > 0);
  for (const c of cmds) {
    assert.match(c, /^find \/[A-Za-z0-9._@+/-]+ -maxdepth [34] 2>&1 \| head -80$/);
  }
  // 决定性断言：命令必须**只能是**这条固定形态（多一个字符都不行），且注入载荷
  // 不得出现在其中（`2>&1 | head -80` 是我们自己拼的后缀，不在检查范围）
  for (const c of cmds) {
    const root = c.replace(/^find /, '').replace(/ -maxdepth [34] 2>&1 \| head -80$/, '');
    for (const payload of [';', '`', '$(', 'rm', '&', '|', '<', '(', ')', ' ', '$']) {
      assert.ok(!root.includes(payload), `路径里混进了 ${JSON.stringify(payload)}: ${c}`);
    }
  }
});

test('无路径信号时不生成任何取证命令（普通题零成本）', () => {
  assert.deepEqual(extractMissingPaths('redis-cli ping\nPONG'), []);
  assert.deepEqual(pathProbeCommands([]), []);
  assert.deepEqual(pathProbeCommands(['../../etc', 'not-abs', '/ok/path']), [
    'find /ok/path -maxdepth 3 2>&1 | head -80',
  ]);
});

test('祖先目录两种粒度都给：具体目录定位、顶层兜底', () => {
  const roots = extractMissingPaths(
    'cp: cannot stat /data/workspace/myshixun/step3/read.py: No such file or directory',
  );
  assert.deepEqual(roots, ['/data/workspace', '/data']);
});

test('probeAnchor 只认白名单内的根，用于从整屏回显里截本轮那段', () => {
  assert.equal(probeAnchor(['/opt/collection_1']), '/opt/collection_1');
  assert.equal(probeAnchor(['/opt/$(id)']), '');
  assert.equal(probeAnchor([]), '');
});

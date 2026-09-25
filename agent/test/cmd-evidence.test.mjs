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
  detectMissingPremise,
  requiredPathsFromProblem,
  topLevelRoots,
  taskCreatesOwnData,
  absentPathsFromEcho,
  isDeadCommand,
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
  // 探针命令**顶层优先**（1.6.24 改）：一条 `find /opt -maxdepth 4` 就把整棵树摊开，
  // 拼错的名字、缺席的名字全在里面；而 3 条预算若先被具体根占掉，最关键的顶层清单
  // 反而可能被挤出（真机第 2 轮 roots 全是劈行碎片时就是这样全废的）。
  assert.deepEqual(pathProbeCommands(extractMissingPaths(text)), [
    'find /opt -maxdepth 4 2>&1 | head -80',
    'find /opt/collection_1 -maxdepth 3 2>&1 | head -80',
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

// ---------- ③ 前置数据缺失体检（1.6.23）----------

// fixture 取自 2026-09-25 真机 mongorestore 恢复关：题面要求"把 /opt/mongodb* 的备份
// 恢复到 mytest1~4"，但环境里 /opt 是空目录（上一关的备份产物没落到这个环境）。
// 旧取证结论只说"清单里没有的名字不存在、换个路径名"，可清单里什么源数据都没有，
// 模型无路可走就回去改 mongorestore 参数，连烧 3 轮逐字节相同到止损。这里把
// "题面引用的源目录在顶层目录实测清单里全部缺席"从"猜错路径名"里分出来。

test('前置数据缺失：顶层目录实测为空、题面引用的源目录全部缺席 → 判缺失并给出处置段', () => {
  const roots = ['/opt/mongodb', '/opt', '/opt/mongodb_1'];
  const seg = [
    'find /opt/mongodb -maxdepth 3 2>&1 | head -80',
    `find: '/opt/mongodb': No such file or directory`,
    'find /opt -maxdepth 4 2>&1 | head -80',
    '/opt',
    'find /opt/mongodb_1 -maxdepth 3 2>&1 | head -80',
    `find: '/opt/mongodb_1': No such file or directory`,
  ].join('\n');
  const r = detectMissingPremise(roots, seg);
  assert.equal(r.missing, true);
  assert.equal(r.top, '/opt');
  assert.deepEqual(r.specifics, ['/opt/mongodb', '/opt/mongodb_1']);
  assert.match(r.note, /前置数据体检/);
  assert.match(r.note, /空目录/);
  assert.match(r.note, /不可能/);
  assert.match(r.note, /重置环境/);
});

test('前置数据缺失：顶层目录本身不存在（连 /opt 都没有）同样判缺失，措辞区分', () => {
  const roots = ['/opt/mongodb', '/opt', '/opt/mongodb_1'];
  const seg = [
    'find /opt/mongodb -maxdepth 3 2>&1 | head -80',
    `find: '/opt/mongodb': No such file or directory`,
    'find /opt -maxdepth 4 2>&1 | head -80',
    `find: '/opt': No such file or directory`,
    'find /opt/mongodb_1 -maxdepth 3 2>&1 | head -80',
    `find: '/opt/mongodb_1': No such file or directory`,
  ].join('\n');
  const r = detectMissingPremise(roots, seg);
  assert.equal(r.missing, true);
  assert.match(r.note, /本身不存在/);
});

test('清单里存在题面引用的源目录 → 不判缺失（这是"清单指认"而非"缺失"）', () => {
  const roots = ['/opt/mongodb', '/opt', '/opt/mongodb_1'];
  const seg = [
    'find /opt -maxdepth 4 2>&1 | head -80',
    '/opt',
    '/opt/mongodb',
    '/opt/mongodb/test1',
    '/opt/mongodb/test1/person.bson',
  ].join('\n');
  assert.equal(detectMissingPremise(roots, seg).missing, false);
});

test('顶层目录非空但不是题面引用的目录 → 不判缺失（数据可能在 T 的别的子目录）', () => {
  const roots = ['/opt/mongodb', '/opt', '/opt/mongodb_1'];
  const seg = [
    'find /opt -maxdepth 4 2>&1 | head -80',
    '/opt',
    '/opt/other_backup',
    '/opt/other_backup/test1',
  ].join('\n');
  assert.equal(detectMissingPremise(roots, seg).missing, false);
});

test('只有 1 个具体缺失根位于 T 下 → 证据不足，不判缺失（数据可能换在 T 的别处）', () => {
  const roots = ['/opt/mongodb', '/opt'];
  const seg = [
    'find /opt/mongodb -maxdepth 3 2>&1 | head -80',
    `find: '/opt/mongodb': No such file or directory`,
    'find /opt -maxdepth 4 2>&1 | head -80',
    '/opt',
  ].join('\n');
  assert.equal(detectMissingPremise(roots, seg).missing, false);
});

test('T 的 find 探针未执行（取证段里没有顶层命令）→ 证据不足，不判缺失（fail-open）', () => {
  const roots = ['/opt/mongodb', '/opt', '/opt/mongodb_1'];
  const seg = [
    'find /opt/mongodb -maxdepth 3 2>&1 | head -80',
    `find: '/opt/mongodb': No such file or directory`,
  ].join('\n');
  assert.equal(detectMissingPremise(roots, seg).missing, false);
});

test('空输入与无顶层根：一律 fail-open 返回 missing:false', () => {
  assert.deepEqual(detectMissingPremise([], 'x'), {
    missing: false,
    top: '',
    specifics: [],
    note: '',
  });
  assert.equal(detectMissingPremise(['no-such-root'], 'whatever').missing, false);
});

// ---------- ④ 路径来源分工（1.6.24）：题面点名哪些目录=题面说了算，目录里有什么=实测说了算 ----------

// fixture 按 2026-09-25 真机题干的结构重写（页面文本是拼接渲染的：目录锚点 + 相关知识 +
// 编程要求 + 测试说明）。要锁的是三件真机踩过的事：
// ① `编程要求` 出现两次（开头锚点 + 正文标题），按第一次切会得到一个空壳段；
// ② 相关知识里的示例路径 /home/mongod/... 不是"题面要求的输入"，参数表里的"导出"二字
//    也不代表题面要你自己造数据；
// ③ 终端回显里的路径会被 xterm 按列劈行，从回显抠出的"根"可能是幽灵目录。
const PROBLEM_RESTORE = [
  '任务描述 相关知识 编程要求 测试说明',
  '相关知识',
  'mongorestore 恢复工具：-o 指明到要导出的文件名',
  '示例：mongorestore -h 127.0.0.1:27017 --drop /home/mongod/test',
  '详见 http://172.22.226.31/tasks/AAA/4882/bbb',
  '编程要求',
  '将 /opt/mongodb 目录下的数据恢复到 MongoDB 中；',
  '将 /opt/mongodb_1 目录下的数据恢复到 mytest1 数据库中；',
  '将 /opt/collection_1 目录下的数据恢复到 mytest2 数据库的 person 集合中；',
  '测试说明',
  '平台会对你编写的代码进行测试',
].join('\n');

test('requiredPathsFromProblem 只认「编程要求」段点名的路径（示例/参数表/URL 都不算）', () => {
  assert.deepEqual(requiredPathsFromProblem(PROBLEM_RESTORE), [
    '/opt/mongodb',
    '/opt/mongodb_1',
    '/opt/collection_1',
  ]);
  assert.deepEqual(topLevelRoots(requiredPathsFromProblem(PROBLEM_RESTORE)), ['/opt']);
  assert.deepEqual(requiredPathsFromProblem('本题没有任何绝对路径'), []);
});

test('taskCreatesOwnData：纯恢复题为 false，题面要你自造数据的题为 true', () => {
  assert.equal(taskCreatesOwnData(PROBLEM_RESTORE), false);
  // 同样的"导出"字样出现在「编程要求」里才是"要你自造数据"（相关知识里出现不算）
  assert.equal(
    taskCreatesOwnData(
      '相关知识\n-o 指明到要导出的文件名\n编程要求\n用 mongodump 将 test1 库导出到 /opt/mongodb\n测试说明\n',
    ),
    true,
  );
  assert.equal(taskCreatesOwnData(''), false);
});

test('回显被劈行打成碎片时，前置缺失仍按题面点名的目录判定（真机第 2 轮）', () => {
  const anchors = requiredPathsFromProblem(PROBLEM_RESTORE);
  const tops = topLevelRoots(anchors);
  const seg = ['root@coder:~# find /opt -maxdepth 4 2>&1 | head -80', '/opt', 'root@coder:~#'].join(
    '\n',
  );
  const r = detectMissingPremise(anchors, seg, { requiredTops: tops });
  assert.equal(r.missing, true);
  assert.equal(r.top, '/opt');
  assert.equal(r.specifics.length, 3);
});

test('幽灵顶层根（劈行碎片自己成了根）不构成判定——清单里其实有源目录时不得判死', () => {
  const anchors = requiredPathsFromProblem(PROBLEM_RESTORE);
  const tops = topLevelRoots(anchors);
  const segWithData = [
    'root@coder:~# find /opt -maxdepth 4 2>&1 | head -80',
    '/opt',
    '/opt/collection_1',
    '/opt/collection_1/person',
    '/opt/collection_1/person/person.bson',
  ].join('\n');
  assert.equal(detectMissingPremise(anchors, segWithData, { requiredTops: tops }).missing, false);
  // 碎片根单独拿出来（不带题面闸）会"三条全中"——这正是 1.6.24 加 ⓪ 号条件要挡住的误报
  const ghost = ['/collection_1/person', '/collection_1', '/collection_1/student'];
  const ghostSeg = [
    'root@coder:~# find /collection_1 -maxdepth 4 2>&1 | head -80',
    `find: '/collection_1': No such file or directory`,
  ].join('\n');
  assert.equal(detectMissingPremise(ghost, ghostSeg).missing, true, '前提：无闸时确实会误报');
  assert.equal(
    detectMissingPremise(ghost, ghostSeg, { requiredTops: tops }).missing,
    false,
    '加题面闸后幽灵根不参与判定',
  );
});

// ---------- ⑤ 必败命令跳过（1.6.24，用户点名的"输入期报错还照敲完"） ----------

test('absentPathsFromEcho 行级归因：只认同一行里既有的、且命令里出现过的路径', () => {
  assert.deepEqual(
    absentPathsFromEcho('mongorestore -h 127.0.0.1:27017 --drop /opt/mongodb', [
      `Failed: mongorestore target '/opt/mongodb' invalid: stat /opt/mongodb: no such file or directory`,
    ]),
    ['/opt/mongodb'],
  );
  // 两个操作数、报错只点到其中一个：另一个不许连带判死
  assert.deepEqual(
    absentPathsFromEcho('cp /data/a.json /backup/x/a.json', [
      `cp: cannot create regular file '/backup/x/a.json': No such file or directory`,
    ]),
    ['/backup/x/a.json'],
  );
  // 不是"不存在"这一类的报错（语法错、拒绝连接）不产生缺席路径
  assert.deepEqual(
    absentPathsFromEcho('mongo --eval "db.x.find()"', ['syntax error near unexpected token'], []),
    [],
  );
  assert.deepEqual(absentPathsFromEcho('curl http://a/b', ['Connection refused'], []), []);
});

test('absentPathsFromEcho 兜底归因只在命令含唯一路径时生效（xterm 把路径本身劈成两段）', () => {
  // 路径与原因同行 → 行级归因就够了（原因被劈到下一行也不影响）
  assert.deepEqual(
    absentPathsFromEcho('ls -la /opt/mongodb/', [`ls: cannot access '/opt/mongodb/':`]),
    ['/opt/mongodb'],
  );
  // 真机第 2 轮那种：**路径自己**被按列劈开（上行末 `/opt`、下行开头 `/mongodb/': No such…`），
  // 两行各自的 token 都不等于命令里的 `/opt/mongodb` → 行级拿不到，靠"唯一操作数"兜底
  assert.deepEqual(
    absentPathsFromEcho('ls -la /opt/mongodb/', [
      `ls: cannot access '/opt`,
      `/mongodb/': No such file or directory`,
    ]),
    ['/opt/mongodb'],
  );
  // 多个路径操作数时绝不兜底：`cp /a /b` 失败可能只是 /b 的父目录不存在
  assert.deepEqual(
    absentPathsFromEcho('cp /data/a.json /backup/x/a.json', ['cp: cannot create regular file']),
    [],
  );
  // 兜底的硬前提：**得有不存在信号行**。`find /opt -maxdepth 3 -type d` 正常打印一个 `/opt`
  // 不是报错——少了这道闸，序列里第一条取证命令就会把后面整批命令判成必败（自查回放翻过车）
  assert.deepEqual(absentPathsFromEcho('find /opt -maxdepth 3 -type d | head -50', ['/opt']), []);
  assert.deepEqual(
    absentPathsFromEcho('ls -la /opt/mongodb/', ['total 0', 'drwxr-xr-x 2 root root']),
    [],
  );
});

test('isDeadCommand：引用已判不存在的路径即必败，后续有创建动作则不判死', () => {
  const absent = ['/opt/mongodb'];
  assert.deepEqual(
    isDeadCommand('mongorestore --drop /opt/mongodb', absent, ['mongorestore --drop /opt/mongodb']),
    { dead: true, hit: '/opt/mongodb' },
  );
  // 不存在目录之下的文件同样必败（父目录都没了）
  assert.equal(isDeadCommand('cat /opt/mongodb/test1/person.bson', absent, ['cat x']).dead, true);
  // 反向**不算**：`/opt/mongodb` 缺席时 `/opt` 本身存在（真机就是空目录），
  // 去看父目录正是判据需要的证据，不能跳
  assert.equal(
    isDeadCommand('ls -la /opt', ['/opt/mongodb', '/opt/mongodb_1'], ['ls -la /opt']).dead,
    false,
  );
  // 剩余命令里有创建动作 → 不判死（先 mkdir 再 restore 是合法序列）
  assert.equal(
    isDeadCommand('mongorestore /opt/mongodb', absent, ['mkdir -p /opt/mongodb', 'ls']).dead,
    false,
  );
  // 与缺席路径无关的命令照常放行
  assert.equal(isDeadCommand('mongo --eval "db.stats()"', absent, ['mongo']).dead, false);
  assert.equal(isDeadCommand('ls /opt/mongodb', [], ['ls /opt/mongodb']).dead, false);
});

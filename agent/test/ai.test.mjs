// 核心纯函数单测。零新增依赖（Node 内置 node:test + node:assert）。
//
// 覆盖对象均为判定正确性的命脉，且都曾出过真实缺陷：
//   - detectVerdict：朴素 includes 曾把「未通过」判成通过
//   - sanitizeShellSubmission：lastIndexOf 冒号曾把整条合法命令误剔（0.9.1）
//   - spliceIntoTemplate：模板拼错 = 评测必挂
//   - renderTemplate / parseAnswers：prompt 渲染与答案解析的基础
//
// 运行：npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectVerdict,
  sanitizeShellSubmission,
  spliceIntoTemplate,
  renderTemplate,
  parseAnswers,
} from '../src/ai.mjs';

test('detectVerdict：空输入判未通过', () => {
  assert.equal(detectVerdict('').passed, false);
  assert.equal(detectVerdict('   ').passed, false);
  assert.equal(detectVerdict(null).passed, false);
});

test('detectVerdict：否定词优先短路，不被裸「通过」带偏', () => {
  assert.equal(detectVerdict('未通过').passed, false);
  assert.equal(detectVerdict('没有通过全部用例').passed, false);
  assert.equal(detectVerdict('答案错误').passed, false);
  assert.equal(detectVerdict('运行时异常').passed, false);
  assert.equal(detectVerdict('Wrong Answer').passed, false);
  assert.equal(detectVerdict('Time Limit Exceeded').passed, false);
});

test('detectVerdict：肯定词判通过', () => {
  assert.equal(detectVerdict('全部通过').passed, true);
  assert.equal(detectVerdict('答案正确').passed, true);
  assert.equal(detectVerdict('评测通过').passed, true);
  assert.equal(detectVerdict('恭喜您通过本关').passed, true);
  assert.equal(detectVerdict('Accepted').passed, true);
});

test('detectVerdict：EduCoder 逐测试集文风「测试集1 通过」判通过', () => {
  assert.equal(detectVerdict('测试集1 通过').passed, true);
  assert.equal(detectVerdict('测试集2 通过\n测试集3 通过').passed, true);
});

test('detectVerdict：AC 需整词匹配，避免命中 back / ACCEPT 之外的词', () => {
  assert.equal(detectVerdict('AC').passed, true);
  assert.equal(detectVerdict('back').passed, false);
  assert.equal(detectVerdict('trace').passed, false);
});

test('detectVerdict：「0 组不匹配」是全部通过的等价表述，应判通过', () => {
  // 回归：否定词表里含 /不匹配/，若不做零失败白名单，
  // 「共 3 组测试，0 组不匹配」会被短路判为未通过。
  assert.equal(detectVerdict('0 组不匹配').passed, true);
  assert.equal(detectVerdict('共 3 组测试，0 组不匹配').passed, true);
});

test('detectVerdict：真实存在失败组数时仍判未通过', () => {
  assert.equal(detectVerdict('共 3 组测试，1 组不匹配').passed, false);
  assert.equal(detectVerdict('2 组不匹配').passed, false);
});

test('renderTemplate：替换占位符，缺失变量渲染为空串', () => {
  assert.equal(renderTemplate('a={{input.x}} b={{input.y}}', { x: '1' }), 'a=1 b=');
  assert.equal(renderTemplate('{{input.x}}', { x: null }), '');
  assert.equal(renderTemplate('{{input.x}}', {}), '');
});

test('renderTemplate：同一变量多次出现全部替换', () => {
  assert.equal(renderTemplate('{{input.a}}-{{input.a}}', { a: 'z' }), 'z-z');
});

test('renderTemplate：非字符串值按 String 转换', () => {
  assert.equal(renderTemplate('{{input.n}}', { n: 42 }), '42');
});

test('parseAnswers：解析「题号:字母」，容忍全角与空格', () => {
  const r = parseAnswers('3:ABE');
  assert.deepEqual(r.map, { 3: 'ABE' });
  assert.deepEqual(parseAnswers('1：c').map, { 1: 'C' });
  assert.deepEqual(parseAnswers('1 : a\n2 : bd').map, { 1: 'A', 2: 'BD' });
});

test('parseAnswers：无匹配返回空 map 供调用方降级', () => {
  assert.deepEqual(parseAnswers('无法作答').map, {});
  assert.deepEqual(parseAnswers('').map, {});
});

test('spliceIntoTemplate：把 AI 代码体拼回原始模板的标记之间', () => {
  const tpl = ['#********** Begin **********#', 'old_body', '#********** End **********#'].join(
    '\n',
  );
  const ai = ['#********** Begin **********#', 'new_body', '#********** End **********#'].join(
    '\n',
  );
  const out = spliceIntoTemplate(tpl, ai);
  assert.match(out, /Begin/);
  assert.match(out, /End/);
  assert.match(out, /new_body/);
  assert.doesNotMatch(out, /old_body/);
});

test('spliceIntoTemplate：AI 未带标记时整段当代码体', () => {
  const tpl = ['#*** Begin ***#', 'old', '#*** End ***#'].join('\n');
  const out = spliceIntoTemplate(tpl, 'brand_new');
  assert.match(out, /brand_new/);
  assert.doesNotMatch(out, /old/);
});

test('spliceIntoTemplate：原始模板无标记时直接信任 AI 输出', () => {
  assert.equal(spliceIntoTemplate('plain template', '  ai code  '), 'ai code');
});

test('spliceIntoTemplate：不会把 Redis 事务的 BEGIN 当平台标记', () => {
  // 标记行要求同时含 ≥3 个装饰符，裸 begin/end 关键字不匹配
  const tpl = ['MULTI', 'BEGIN', 'SET k v', 'END', 'EXEC'].join('\n');
  const out = spliceIntoTemplate(tpl, 'SET a b');
  assert.equal(out, 'SET a b');
});

test('sanitizeShellSubmission：普通编程题零触发', () => {
  const r = sanitizeShellSubmission('print("你好；世界")');
  assert.deepEqual(r.changes, []);
  assert.equal(r.code, 'print("你好；世界")');
});

test('sanitizeShellSubmission：全角分号转半角（仅 db/mongo 内容触发）', () => {
  const r = sanitizeShellSubmission('db.c.find()；db.c.count()');
  assert.equal(r.code, 'db.c.find(); db.c.count()');
  assert.ok(r.changes.length > 0);
});

test('sanitizeShellSubmission：剥离中文标签行，保留命令部分', () => {
  const r = sanitizeShellSubmission('输出集合前3条文档: db.educoder.find().limit(3)');
  assert.equal(r.code, 'db.educoder.find().limit(3)');
});

test('sanitizeShellSubmission：命令内部冒号不被误当标签分隔符（0.9.1 回归）', () => {
  // 历史缺陷：用 lastIndexOf 找冒号会截到 sort({learning_num:1}) 内部，
  // 剩余片段以数字开头 → 整条合法命令被剔除。
  const cmd = '输出集合前3条文档: db.educoder.find().sort({learning_num:1}).limit(3)';
  const r = sanitizeShellSubmission(cmd);
  assert.equal(r.code, 'db.educoder.find().sort({learning_num:1}).limit(3)');
});

test('sanitizeShellSubmission：剥不出命令的裸中文行整行剔除', () => {
  const r = sanitizeShellSubmission('这是纯中文说明行\ndb.educoder.find()');
  assert.equal(r.code.split('\n')[0], '');
  assert.match(r.code, /db\.educoder\.find\(\)/);
});

test('sanitizeShellSubmission：注释行不受影响', () => {
  const r = sanitizeShellSubmission('// 中文注释说明\ndb.c.find()');
  assert.match(r.code, /\/\/ 中文注释说明/);
});

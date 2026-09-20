// slimForReflection 单测：反思窗口必须落在「编程要求 / 测试说明」的**正文**上。
//
// 背景（2026-09-20 真机事故，Redis IP 地址库题）：评测页题干顶部有一份**目录**
// （"任务要求 参考答案 记录 评论 任务描述 相关知识 … 编程要求 测试说明"），
// 旧实现用 indexOf 取锚点首次出现 → 两个锚点都落在目录里，窗口退化成题干开头
// 约 1600 字，恰好把「编程要求」的正文细则整体切掉。反思 AI 因此看不到
// "城市ID 加 _ 加当前行索引值做为成员"这条硬要求，反而把**正确的**
// `city_id + "_" + str(count)` 判定为"多余的_行号"主动删掉——10 轮反思越改越错。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';
import { slimForReflection } from '../src/loop.mjs';

// 页首目录：两个锚点标题都出现一次
const TOC =
  '第3关：使用Redis实现IP地址库\n任务要求\n参考答案\n记录\n评论\n任务描述\n相关知识\n编程要求\n测试说明\n';
const BODY =
  '任务描述\n\n本关任务：使用 Redis 编写一个 IP 地址库。\n\n相关知识\n\nzadd：将成员加入到有序集合中…\n';
const REQ =
  '编程要求\n\n在Begin-End区域编写 ip2long(ip_address) 函数…\n' +
  '- 为保持有序集合中城市ID唯一，将城市ID加_加当前行索引值做为成员，经过上述处理的IP段起始值做为分值存入有序集合 ip2city 中。\n' +
  '查找所属城市ID实现：从有序集合 ip2city 中查找出分值小于等于上述整数的所有成员。\n';
const SPEC =
  '测试说明\n\n我会对你编写的代码进行测试：\n\n预期输出：\n\n' +
  'Start import IP addresses to Redis!\nDone!\nRedis ip2city sorted set ranges: 80008\n104211\n24328\n';

test('题干带目录时，窗口必须覆盖「编程要求」正文细则与「测试说明」预期输出', () => {
  const problem = TOC + BODY + REQ + SPEC;
  const w = slimForReflection(problem);
  const mustHave = [
    '为保持有序集合中城市ID唯一', // member 构造规则（曾被截掉 → 反思改错）
    '分值小于等于', // 查找语义（曾被截掉）
    'Start import IP addresses to Redis!', // 预期输出（靠它才能比对 stdout）
    '80008', // 集合基数（评测逐项比对的关键数字）
  ];
  for (const kw of mustHave) {
    assert.ok(w.includes(kw), `反思窗口应包含「${kw}」，实际窗口长度 ${w.length}`);
  }
});

test('窗口仍受尾窗上限约束（不会无限膨胀成整篇题干）', () => {
  const tail = '结尾噪声'.repeat(3000); // 远超 +2400 尾窗
  const problem = TOC + BODY + REQ + SPEC + tail;
  const w = slimForReflection(problem);
  assert.ok(w.length < problem.length, '窗口应小于题干总长');
  assert.ok(w.includes('Start import IP addresses to Redis!'), '预期输出仍应在窗口内');
});

test('题干无锚点时回退为开头 3000 字（保持旧行为）', () => {
  const p = '一段没有任何章节标题的题干描述文字'.repeat(400);
  const w = slimForReflection(p);
  assert.equal(w.length, 3000);
});

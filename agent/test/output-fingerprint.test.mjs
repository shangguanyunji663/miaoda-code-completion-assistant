// 实际输出指纹单测（1.5.1）。
//
// 背景（2026-09-22 真机，Redis 优先级队列题）：第 1~4 轮提交的代码字符数
// 711/779/932/934 各不相同，反思每轮都"改了"，但抓到的预期/实际输出明细
// 恒为 738 字符一字未变——四个版本都是「逐队列 blpop」同一个错误方向。
// loop 当时没有任何机制能发现"改了等于没改"，于是把 MAX_RETRY 的额度全花在
// 同一方向的等价变体上（每轮 ≈120s）。
//
// 契约：① 同一段输出（含缩进/空行/CRLF 差异）指纹相同；② 实际输出有任何实质
// 差异则指纹不同（不能被"归一化"糊掉）；③ 有测试集明细时只按明细算指纹，
// 面板上的耗时/进度噪音不参与。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';

const { outputFingerprint, pickEvalEvidence } = await import('../src/loop.mjs');

const DETAIL =
  '=== 测试集明细 ===\n测试集1\n预期输出：\n出队列顺序：[h, o, c]\n实际输出：\n测试 pop_task 方法...';

test('同一段输出：缩进 / 空行 / CRLF 差异不影响指纹', () => {
  const a = outputFingerprint('实际输出：\n  测试 pop_task 方法...\n\n');
  const b = outputFingerprint('实际输出：\r\n测试 pop_task 方法...');
  assert.equal(a, b);
  assert.ok(a && a.length === 10);
});

test('实际输出有实质差异时指纹必须不同（归一化不得糊掉真实变化）', () => {
  const before = outputFingerprint('实际输出：\n测试 pop_task 方法...');
  const after = outputFingerprint('实际输出：\n出队列顺序：[h, o, c]');
  assert.notEqual(before, after);
});

test('有「测试集明细」时只按明细算指纹，面板耗时噪音不参与', () => {
  const withNoise = `共有 2 组测试集，本关最大执行时间：120 秒。耗时 128.4 秒\n\n${DETAIL}`;
  const otherNoise = `共有 2 组测试集，本关最大执行时间：120 秒。耗时 131.7 秒\n\n${DETAIL}`;
  assert.equal(outputFingerprint(withNoise), outputFingerprint(otherNoise));
  assert.equal(pickEvalEvidence(withNoise), DETAIL);
});

test('空文本 / 非字符串 → 空指纹（不参与"相同"判定）', () => {
  assert.equal(outputFingerprint(''), '');
  assert.equal(outputFingerprint(undefined), '');
  assert.equal(outputFingerprint('   \n  \n'), '');
});

// 重载兜底的草稿判据单测（1.4.3）：looksLikeOwnDraft。
//
// 背景（2026-09-20 真机）：本平台**持久化编辑器草稿且无「恢复初始代码」按钮**，
// `page.reload()` 拿不回平台原始模板。旧实现的判据是「`fresh.code` 非空即视为重取成功」，
// 而草稿恰好非空 ⇒ 走进 `codeProbe = fresh`，把干净的原始模板存档**覆盖成污染草稿**，
// 再强制基于污染模板重新生成——兜底从"无效"退化成"主动变糟"。
//
// 本用例钉死三条契约：
//   ① 拿回自己的草稿（含空白/缩进/末尾换行差异）必须识别出来 → 保留原存档
//   ② 拿回真正不同的模板/代码必须**不**误判 → 允许覆盖存档并重新生成
//   ③ 空输入一律不判为草稿（不能因为"读不到内容"就把兜底停掉）
//
// 运行：npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeOwnDraft } from '../src/loop.mjs';

const TEMPLATE = [
  '#-*- coding:utf-8 -*-',
  'import redis',
  '',
  'def ip2long(ip_address):',
  '    # ********** Begin ********** #',
  '    pass',
  '    # ********** End ********** #',
  '    return None',
].join('\n');

test('完全相同的提交内容判为草稿', () => {
  assert.equal(looksLikeOwnDraft(TEMPLATE, TEMPLATE), true);
});

test('仅空行 / 行首缩进 / 行尾 CRLF 差异仍判为草稿（平台保存草稿的常见形态）', () => {
  const draft =
    TEMPLATE.split('\n')
      .map((l) => (l ? '  ' + l : ''))
      .join('\r\n') + '\r\n\r\n';
  assert.equal(looksLikeOwnDraft(draft, TEMPLATE), true);
});

test('拿回平台原始模板（不是自己提交的内容）不得判为草稿', () => {
  const submitted = TEMPLATE.replace(
    '    pass',
    '    ip_int = 0\n    for part in ip_address.split("."):\n        ip_int = ip_int * 256 + int(part)',
  );
  assert.equal(looksLikeOwnDraft(TEMPLATE, submitted), false);
});

test('同一模板下的不同实现不得判为草稿（防止误停兜底）', () => {
  const a = [
    'def f(x):',
    '    total = 0',
    '    for i in range(3):',
    '        total += i',
    '    return total',
  ].join('\n');
  const b = ['def f(x):', '    return sum([0, 1, 2])'].join('\n');
  assert.equal(looksLikeOwnDraft(a, b), false);
});

test('近似判据的两条硬约束：行集重合度与长度比都要达标', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `    line_${i} = ${i}`);
  const submitted = ['def f():', ...lines, '    return 0'].join('\n');
  // 只改 2/22 行：行集重合 20/22 ≈ 0.91 且长度接近 → 判为草稿（防御平台对草稿做了轻量规整）
  const nearly = [
    'def f():',
    ...lines.slice(0, 18),
    '    line_18 = 999',
    '    line_19 = 999',
    '    return 0',
  ].join('\n');
  assert.equal(looksLikeOwnDraft(nearly, submitted), true);
  // 同样行但整体被砍掉大半（长度比与重合度均远低于 0.85）→ 不判为草稿
  const truncated = ['def f():', ...lines.slice(0, 3)].join('\n');
  assert.equal(looksLikeOwnDraft(truncated, submitted), false);
});

test('空输入 / 非字符串一律不判为草稿（读不到内容不等于兜底无效）', () => {
  assert.equal(looksLikeOwnDraft('', TEMPLATE), false);
  assert.equal(looksLikeOwnDraft(TEMPLATE, ''), false);
  assert.equal(looksLikeOwnDraft('   \n\n  ', TEMPLATE), false);
  assert.equal(looksLikeOwnDraft(undefined, TEMPLATE), false);
  assert.equal(looksLikeOwnDraft(TEMPLATE, null), false);
});

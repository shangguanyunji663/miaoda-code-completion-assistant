// 平台事实档案的注入单测（1.4.2）。
//
// 背景（2026-09-20 真机，同一类根因连续两题复发）：平台运行环境落后于官方文档
// （Python 2 + 旧版 redis-py：`zadd` 先成员后分值、无字典写法、`open()` 无 encoding=）。
// 这类"事实"原先散落在各条 prompt 规则里，新增场景就要改多处且必然漏——本次就漏在生成端。
// 现收敛为 `shared/platform-facts.json` 单一数据源，并由 readCapability 统一注入所有能力 prompt。
//
// 本用例钉死两条契约：
//   ① 事实档案必须可读、且含已实测的关键事实（防止误删/写成非法 JSON 后静默失效）
//   ② **每个**能力 prompt 都必须带上事实块（防止将来新增能力时漏注入）
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlatformFactsBlock, readCapability } from '../src/ai.mjs';

const CAP_IDS = [
  'code_completion_generator_1',
  'code_reflection_fixer_1',
  'task_router_1',
  'cmdline_runner_1',
  'cmdline_reflection_fixer_1',
  'quiz_answer_selector_1',
  'quiz_batch_answer_1',
];

test('平台事实档案可读，且含已实测的关键事实', () => {
  const block = buildPlatformFactsBlock();
  assert.ok(block.length > 0, '事实块不应为空（检查 shared/platform-facts.json 是否缺失/非法）');
  assert.match(block, /### 平台事实/);
  for (const key of ['zadd_positional_order', 'zadd_dict_form_supported', 'python', 'evidence']) {
    assert.ok(block.includes(key), `事实块应包含关键字段：${key}`);
  }
});

test('每个能力 prompt 都被注入平台事实块（将来新增能力也不许漏）', () => {
  for (const id of CAP_IDS) {
    const cap = readCapability(id);
    assert.match(
      cap.formValue.prompt,
      /### 平台事实/,
      `${id} 的 prompt 未注入平台事实块——注入点是 ai.mjs readCapability，若新增能力请沿用它`,
    );
  }
});

test('注入不破坏原有 prompt 内容（原规则仍在）', () => {
  const cap = readCapability('code_completion_generator_1');
  assert.match(cap.formValue.prompt, /事实优先级/, '生成端「事实优先级」规则应仍在');
  assert.match(cap.formValue.prompt, /先成员后分值/, 'zadd 实参顺序须明示');
});

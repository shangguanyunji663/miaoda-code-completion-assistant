// 平台事实档案的结构校验单测（1.4.3）。零新增依赖（Node 内置 node:test + node:assert）。
//
// 背景：caps-check 此前只校验 shared/capabilities/*.json，事实档案是盲区——坏 JSON 只在
// 运行时被 buildPlatformFactsBlock 降级为空串 + 告警一次，prompt 静默退回「无平台事实」
// 而解题链路不报错。本用例把该盲区钉死：
//   - 仓库真实事实档案必须通过（回归闸）
//   - 该文件自己的 _readme 纪律必须可被机器强制：事实段带 evidence+date / 待验证项隔离在 unknowns
//
// 运行：npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePlatformFacts, assertPlatformFactsValid } from '../src/platform-facts-schema.mjs';
import { cfg } from '../src/config.mjs';

/** 合法最小事实档案（每条规则都有对应的注入点） */
function minimal(overrides = {}) {
  return {
    platform_id: 'demo',
    runtime: { python: '2.x', evidence: 'SyntaxError: ...', date: '2026-09-20' },
    ...overrides,
  };
}

/** 写一个临时文件并返回其路径（调用方负责在 finally 里清目录） */
function writeTmp(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('assertPlatformFactsValid：仓库真实事实档案通过', () => {
  assert.doesNotThrow(() => assertPlatformFactsValid(cfg.paths.platformFactsFile));
});

test('validatePlatformFacts：合法最小档案零错误', () => {
  assert.deepEqual(validatePlatformFacts(minimal(), 'facts.json'), []);
});

test('validatePlatformFacts：事实段缺证据被抓出（防"没证据的推断写成事实"）', () => {
  const errs = validatePlatformFacts(
    minimal({ runtime: { python: '2.x', date: '2026-09-20' } }),
    'f',
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /runtime/);
  assert.match(errs[0], /缺少证据/);
});

test('validatePlatformFacts：逐条 <名>_evidence 也算带证据（redis_py 段的形态）', () => {
  const errs = validatePlatformFacts(
    minimal({
      redis_py: {
        zadd_positional_order: ['member', 'score'],
        zadd_evidence: 'ZADD requires an equal number of values and scores',
        date: '2026-09-20',
      },
    }),
    'f',
  );
  assert.deepEqual(errs, []);
});

test('validatePlatformFacts：date 缺失或形态不符被抓出', () => {
  const missing = validatePlatformFacts(
    minimal({ runtime: { python: '2.x', evidence: 'e' } }),
    'f',
  );
  assert.ok(missing.some((m) => /date 必须为 YYYY-MM-DD/.test(m)));
  const bad = validatePlatformFacts(
    minimal({ runtime: { python: '2.x', evidence: 'e', date: '2026/09/20' } }),
    'f',
  );
  assert.ok(bad.some((m) => /date 必须为 YYYY-MM-DD/.test(m)));
});

test('validatePlatformFacts：待验证字样混进事实段被抓出（要求移入 unknowns）', () => {
  const errs = validatePlatformFacts(
    minimal({
      redis_py: { zrangebylex: '待验证：该命令是否可用', evidence: 'e', date: '2026-09-20' },
    }),
    'f',
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /redis_py\.zrangebylex/);
  assert.match(errs[0], /移入顶层 unknowns/);
});

test('validatePlatformFacts：事实段内嵌 unknowns 字段被抓出', () => {
  const errs = validatePlatformFacts(
    minimal({ evaluation: { unknowns: ['x'], evidence: 'e', date: '2026-09-20' } }),
    'f',
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /待验证字段/);
});

test('validatePlatformFacts：unknowns 必须是字符串数组，且元字段不受事实段规则约束', () => {
  const notArray = validatePlatformFacts(minimal({ unknowns: '一条字符串' }), 'f');
  assert.ok(notArray.some((m) => /unknowns 必须是数组/.test(m)));

  const badItem = validatePlatformFacts(minimal({ unknowns: ['ok', '   ', 42] }), 'f');
  assert.equal(badItem.filter((m) => /unknowns\[\d\]/.test(m)).length, 2);

  // `_` 前缀元信息与 platform_id/unknowns 均不被当作事实段（无 evidence 也合法）
  const meta = validatePlatformFacts(
    minimal({ _readme: '填写规则…', platform_id: 'demo', unknowns: ['待验证项'] }),
    'f',
  );
  assert.deepEqual(meta, []);
});

test('validatePlatformFacts：缺 platform_id / 顶层非对象字段被抓出', () => {
  const json = minimal();
  delete json.platform_id;
  const errs = validatePlatformFacts(json, 'f');
  assert.ok(errs.some((m) => /platform_id/.test(m)));

  const stray = validatePlatformFacts(minimal({ version: '2026-09' }), 'f');
  assert.equal(stray.length, 1);
  assert.match(stray[0], /"version"/);
  assert.match(stray[0], /_ 开头/);
});

test('assertPlatformFactsValid：坏 JSON / 缺文件均 fail-fast（不再只留运行时告警）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  try {
    const badJson = writeTmp(dir, 'bad.json', '{ not json');
    assert.throws(() => assertPlatformFactsValid(badJson), /JSON 解析失败/);

    assert.throws(() => assertPlatformFactsValid(path.join(dir, 'nope.json')), /不存在/);

    const badStruct = writeTmp(
      dir,
      'struct.json',
      JSON.stringify({ platform_id: 'demo', runtime: { python: '2.x' } }),
    );
    assert.throws(
      () => assertPlatformFactsValid(badStruct),
      (err) => {
        assert.match(err.message, /校验失败（2 处）/, '缺 evidence 与 date 应各报一处');
        assert.match(err.message, /struct\.json/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

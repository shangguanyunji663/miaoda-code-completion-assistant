// 能力配置校验单测。零新增依赖（Node 内置 node:test + node:assert）。
//
// 覆盖：
//   - 仓库真实能力 JSON 必须全部通过（防手改引入静默缺陷的回归闸）
//   - 三类故障注入：缺必填字段 / 占位符拼写错误（静默空串根源）/ required 声明漂移
//
// 运行：npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractPlaceholders,
  validateCapability,
  assertCapabilitiesValid,
} from '../src/capability-schema.mjs';
import { cfg } from '../src/config.mjs';

test('extractPlaceholders：提取全部占位符名并去重（容忍空白）', () => {
  const s = extractPlaceholders('a={{input.x}} b={{input.y}} c={{ input.x }} d=无占位符');
  assert.deepEqual([...s].sort(), ['x', 'y']);
});

test('validateCapability：合法最小能力对象零错误', () => {
  const json = {
    id: 'demo_1',
    formValue: { prompt: '题干：{{input.problem_description}}' },
    paramsSchema: {
      type: 'object',
      properties: { problem_description: { type: 'string' } },
      required: ['problem_description'],
    },
  };
  assert.deepEqual(validateCapability(json, 'demo'), []);
});

test('validateCapability：缺 id / 缺 prompt / 缺 paramsSchema 分别报错', () => {
  assert.match(validateCapability({ formValue: {} }, 'a')[0], /id/);
  const noPrompt = validateCapability({ id: 'x' }, 'b');
  assert.ok(noPrompt.some((m) => /formValue\.prompt/.test(m)));
  const noSchema = validateCapability({ id: 'x', formValue: { prompt: 'hi' } }, 'c');
  assert.ok(noSchema.some((m) => /paramsSchema/.test(m)));
});

test('validateCapability：占位符拼写错误被抓出（防静默渲染为空串）', () => {
  const json = {
    id: 'x',
    formValue: { prompt: '{{input.problm}}' },
    paramsSchema: { type: 'object', properties: { problem_description: { type: 'string' } } },
  };
  const errs = validateCapability(json, 'x.json');
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\{\{input\.problm\}\}/);
  assert.match(errs[0], /静默替换为空串/);
});

test('validateCapability：required 引用未声明变量（声明漂移）', () => {
  const json = {
    id: 'x',
    formValue: { prompt: '{{input.a}}' },
    paramsSchema: {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a', 'ghost'],
    },
  };
  const errs = validateCapability(json, 'x.json');
  assert.equal(errs.length, 1);
  assert.match(errs[0], /ghost/);
});

test('assertCapabilitiesValid：仓库真实能力配置全部通过', () => {
  assert.ok(assertCapabilitiesValid(cfg.paths.capabilitiesDir) >= 7);
});

test('assertCapabilitiesValid：坏文件聚合报错且错误含文件路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'good.json'),
      JSON.stringify({
        id: 'g',
        formValue: { prompt: '{{input.a}}' },
        paramsSchema: { type: 'object', properties: { a: { type: 'string' } } },
      }),
    );
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    fs.writeFileSync(
      path.join(dir, 'drift.json'),
      JSON.stringify({
        id: 'd',
        formValue: { prompt: '{{input.typo_var}}' },
        paramsSchema: { type: 'object', properties: { a: { type: 'string' } } },
      }),
    );
    assert.throws(
      () => assertCapabilitiesValid(dir),
      (err) => /bad\.json/.test(err.message) && /typo_var/.test(err.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

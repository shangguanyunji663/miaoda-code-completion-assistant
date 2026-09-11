// EXPORTS: extractPlaceholders, validateCapability, assertCapabilitiesValid
// 能力配置（shared/capabilities/*.json）加载前校验。
//
// 背景：readCapability 原本只有裸 JSON.parse，三类问题会静默失败——
//   1) JSON 语法错误要到运行时才炸，且报错无文件上下文；
//   2) prompt 里 {{input.xxx}} 占位符拼写错误 → renderTemplate 静默渲染为空串，
//      AI 收到残缺 prompt 无任何报错（最危险的静默失败路径）；
//   3) paramsSchema.required 声明了 properties 里不存在的变量（声明漂移）。
//
// 设计取舍：零依赖手写最小校验，不引入 Ajv——延续"运行时仅 playwright-core"
// 的零依赖哲学；paramsSchema 是原平台遗留的 JSON Schema 输入变量声明
// （7 个能力文件全部具备），校验只需要它的一个极小子集。

import fs from 'node:fs';
import path from 'node:path';

/** 与 ai.mjs renderTemplate 同源（正则保持一致）的占位符匹配 */
const PLACEHOLDER_RE = /\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g;

/** 提取 prompt 中出现的全部 {{input.xxx}} 占位符名 */
export function extractPlaceholders(prompt) {
  const names = new Set();
  for (const m of String(prompt ?? '').matchAll(PLACEHOLDER_RE)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * 校验单个能力对象，返回错误列表（空数组 = 通过）。
 * @param {*} json 已 JSON.parse 的能力对象
 * @param {string} label 报错定位标识（文件路径或能力 id）
 */
export function validateCapability(json, label) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return [`[${label}] 顶层必须是 JSON 对象`];
  }

  const errors = [];
  if (typeof json.id !== 'string' || !json.id.trim()) {
    errors.push(`[${label}] 缺少非空字符串字段：id`);
  }
  const prompt = json.formValue?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    errors.push(`[${label}] 缺少非空字段：formValue.prompt（prompt 单一数据源，必须有模板文本）`);
    return errors; // 后续校验全部依赖 prompt
  }

  const schema = json.paramsSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`[${label}] 缺少对象字段：paramsSchema（输入变量声明，7 个能力文件均应具备）`);
    return errors;
  }
  if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    errors.push(`[${label}] paramsSchema 必须为 type:"object" 且含 properties`);
    return errors;
  }

  // 占位符 ⊆ properties：抓 {{input.xxx}} 拼写错误——渲染时会静默替换为空串
  const declared = new Set(Object.keys(schema.properties));
  for (const name of extractPlaceholders(prompt)) {
    if (!declared.has(name)) {
      errors.push(
        `[${label}] prompt 占位符 {{input.${name}}} 未在 paramsSchema.properties 中声明` +
          `（已声明：${[...declared].join(', ') || '无'}）——渲染时会静默替换为空串`,
      );
    }
  }

  // required ⊆ properties：抓声明漂移
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      errors.push(`[${label}] paramsSchema.required 必须是数组`);
    } else {
      for (const req of schema.required) {
        if (!declared.has(req)) {
          errors.push(`[${label}] paramsSchema.required 引用了未声明的变量 "${req}"`);
        }
      }
    }
  }

  return errors;
}

/**
 * 全量校验能力目录（fail-fast）：任一文件出错即抛错，所有文件的错误聚合为一条信息。
 * @param {string} dir capabilities 目录
 * @returns {number} 校验通过的文件数
 */
export function assertCapabilitiesValid(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`能力目录不存在：${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`能力目录下没有 .json 配置文件：${dir}`);
  }

  const allErrors = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      allErrors.push(`[${p}] JSON 解析失败：${err.message}`);
      continue;
    }
    allErrors.push(...validateCapability(json, p));
  }
  if (allErrors.length > 0) {
    throw new Error(
      `能力配置校验失败（${allErrors.length} 处）：\n` +
        allErrors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  return files.length;
}

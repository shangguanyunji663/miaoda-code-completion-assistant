// EXPORTS: validatePlatformFacts, assertPlatformFactsValid
// 平台事实档案（shared/platform-facts.json）的结构校验。
//
// 背景（1.4.3）：caps-check 此前只覆盖 shared/capabilities/*.json，事实档案是**盲区**——
// 该文件坏 JSON 时，ai.mjs 的 buildPlatformFactsBlock 只在**运行时**降级为空串 + 告警一次，
// 结果是 prompt 静默退回「没有任何平台事实」的状态，而解题链路一路正常。
// 这与 capability-schema.mjs 头注里「占位符拼错 → 静默渲染空串」是同一类失效：
// 单次运行看不出来，只有在真机上连续失败之后才可能被察觉。故纳入显式校验。
//
// 校验规则**直接取自该文件自己的 `_readme` 填写纪律**，不新增约定：
//   ① 事实段必须带证据与 date ——「只写实测过的条目，必须带 evidence 与 date」；证据
//      允许段级 `evidence` 或逐条 `<条目>_evidence`（redis_py 段用后者，粒度更细）
//   ② 事实段内不得出现"待验证/未验证/待确认/推断"字样 ——「推断、待验证的写进 unknowns」
//   ③ 事实段内不得出现名为 unknowns / unknown / tbd / to_verify 的字段 —— 同上
//   ④ unknowns 必须是**字符串数组**（每条非空）—— 它在结构上是"与事实严格分离的待验证区"
//
// 取舍：与 capability-schema.mjs 同源——零依赖手写最小校验，不引入 JSON Schema 库。

import fs from 'node:fs';

/** date 字段形态（与既有条目一致：2026-09-20） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 事实段内出现即视为「把推断写成了事实」的字样（规则 ②） */
const UNVERIFIED_RE = /待验证|未验证|待确认|待单独确认|推断/;

/** 事实段内不应出现的待验证字段名（规则 ③） */
const UNKNOWN_KEY_RE = /^(unknowns?|tbd|to_verify)$/i;

/** 顶层允许存在的非事实段字段 */
const META_KEYS = new Set(['platform_id', 'unknowns']);

/**
 * 校验事实档案对象，返回错误列表（空数组 = 通过）。
 * @param {*} json 已 JSON.parse 的事实档案对象
 * @param {string} label 报错定位标识（通常为文件路径）
 */
export function validatePlatformFacts(json, label) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return [`[${label}] 顶层必须是 JSON 对象`];
  }

  const errors = [];
  if (typeof json.platform_id !== 'string' || !json.platform_id.trim()) {
    errors.push(`[${label}] 缺少非空字符串字段：platform_id`);
  }

  // 规则 ④：unknowns 是字符串数组，且每段非空
  if (json.unknowns !== undefined) {
    if (!Array.isArray(json.unknowns)) {
      errors.push(`[${label}] unknowns 必须是数组（每条为一段待验证说明）`);
    } else {
      json.unknowns.forEach((u, i) => {
        if (typeof u !== 'string' || !u.trim()) {
          errors.push(`[${label}] unknowns[${i}] 必须是非空字符串`);
        }
      });
    }
  }

  // 规则 ①~③：逐个事实段
  for (const [key, section] of Object.entries(json)) {
    if (key.startsWith('_') || META_KEYS.has(key)) continue; // `_readme` 等元信息与元字段跳过

    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      errors.push(
        `[${label}] 顶层字段 "${key}" 既非元信息（以 _ 开头）也非事实段对象` +
          `——事实必须落在带 evidence/date 的段里，元信息请加 _ 前缀`,
      );
      continue;
    }

    // 证据要求：段级 `evidence`，或逐条 `<条目>_evidence`（redis_py 段即用后者，
    // 粒度更细）——二者只要有一处非空即视为"带证据"，不强制统一形态
    const hasEvidence =
      (typeof section.evidence === 'string' && section.evidence.trim()) ||
      Object.entries(section).some(
        ([k, v]) => k.endsWith('_evidence') && typeof v === 'string' && v.trim(),
      );
    if (!hasEvidence) {
      errors.push(
        `[${label}] 事实段 "${key}" 缺少证据——按 _readme 纪律只写实测过的条目，` +
          `须带 evidence 或逐条 <名>_evidence（报错/回显原文）`,
      );
    }
    if (typeof section.date !== 'string' || !DATE_RE.test(section.date)) {
      errors.push(
        `[${label}] 事实段 "${key}" 的 date 必须为 YYYY-MM-DD 字符串（实际：${JSON.stringify(section.date)}）`,
      );
    }

    for (const [k, v] of Object.entries(section)) {
      if (UNKNOWN_KEY_RE.test(k)) {
        errors.push(
          `[${label}] 事实段 "${key}" 内含待验证字段 "${k}"——待验证项应移入顶层 unknowns`,
        );
      }
      if (typeof v === 'string' && UNVERIFIED_RE.test(v)) {
        errors.push(
          `[${label}] 事实段 "${key}.${k}" 含"待验证/推断"类字样，疑似把推断写成了事实` +
            `——应移入顶层 unknowns（原文：${v.slice(0, 60)}）`,
        );
      }
    }
  }

  return errors;
}

/**
 * 校验事实档案文件（fail-fast）。文件缺失 / JSON 非法 / 结构不合规均抛错。
 * @param {string} file platform-facts.json 的绝对路径
 */
export function assertPlatformFactsValid(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`平台事实档案不存在：${file}`);
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`平台事实档案 JSON 解析失败：[${file}] ${err.message}`);
  }
  const errors = validatePlatformFacts(json, file);
  if (errors.length > 0) {
    throw new Error(
      `平台事实档案校验失败（${errors.length} 处）：\n` + errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
}

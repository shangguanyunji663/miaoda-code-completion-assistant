// EXPORTS: taskKey, isTaskUrl
// 题目页 URL 识别（共享小模块）。
//
// 从 loop.mjs 抽出的原因：browser.mjs 的 pickTargetPage 也要按题目页 URL 形状
// 挑页，而 loop.mjs 已经 import browser.mjs，反向引用会成环。下沉到这里后
// loop / browser 共用同一实现、同一配置旋钮（TASK_URL_PATTERN），避免两份漂移。

import { cfg } from './config.mjs';

let cachedSrc = null;
let cachedRe = null;

function getRe() {
  if (cachedRe && cachedSrc === cfg.watch.taskUrlPattern) return cachedRe;
  // 先编译后落缓存：用户把 TASK_URL_PATTERN 改错时抛错向上（taskKey 捕获返回 null），
  // 缓存保持原状，下次调用仍会重试编译
  const re = new RegExp(cfg.watch.taskUrlPattern);
  cachedRe = re;
  cachedSrc = cfg.watch.taskUrlPattern;
  return re;
}

/** 从 URL 中提取题目唯一键；非题目页返回 null */
export function taskKey(url) {
  try {
    const m = String(url ?? '').match(getRe());
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** URL 是否形如题目页（默认形状 /tasks/<courseId>/<数字>/<串>，eduCoder 官网与校内部署一致） */
export function isTaskUrl(url) {
  return taskKey(url) !== null;
}

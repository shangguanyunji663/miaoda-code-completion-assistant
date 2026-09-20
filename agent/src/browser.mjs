// EXPORTS: connectBrowser, pickTargetPage, pickTargetPageWithMeta
// 浏览器连接层：通过 CDP 连接用户已登录的 Edge/Chrome，并挑出评测页面标签。
// 连不上时支持自动拉起（AUTO_LAUNCH=1，默认开）：独立 profile + 调试端口，
// 在用户桌面环境经 cmd start 启动可脱离父进程存活（见 launch-browser.mjs 坑 3）。

import { chromium } from 'playwright-core';
import { cfg } from './config.mjs';
import { launchBrowser } from './launch-browser.mjs';
import { isTaskUrl } from './task-url.mjs';
import { looksLikeTaskPage } from './perceive.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('pick');

/**
 * 在本机 CDP 连接期间临时摘除代理环境变量。
 *
 * 坑：环境里若配置了 http_proxy（本机实测 http_proxy=http://127.0.0.1:53470），
 * Playwright 的 connectOverCDP 会走代理去连 127.0.0.1，代理转发失败后返回 502，
 * 表现为 "Unexpected status 502 ... This does not look like a DevTools server"。
 * 此时浏览器其实完全正常——用 Node 原生 fetch 直连同一个端口是可以拿到
 * /json/version 的。因为 Node 的 fetch(undici) 默认不读代理环境变量，而 Playwright 读。
 * 对策：连接建立前临时清除代理变量，连接成功后立即恢复（已建立的 WebSocket
 * 不受后续环境变量变化影响）。
 */
async function withoutProxy(fn) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
}

/**
 * 连接 CDP 端点；连不上且 AUTO_LAUNCH 开启（默认开）时自动拉起浏览器再重连。
 * 自动拉起用的是独立 profile（安全默认）；想接管"你自己的 Edge（含登录态）"，
 * 先运行一次 my-edge 命令（见 launch-browser.mjs launchMyEdge）。
 * @returns {Promise<{browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext}>}
 */
export async function connectBrowser() {
  const endpoint = cfg.browser.cdpEndpoint;
  let browser;
  try {
    browser = await withoutProxy(() => chromium.connectOverCDP(endpoint, { timeout: 10000 }));
  } catch (err) {
    if (!cfg.browser.autoLaunch) {
      throw new Error(
        `无法连接浏览器调试端口 ${endpoint}。\n` +
          '请先启动带调试端口的浏览器：npm run browser\n' +
          `原始错误：${err.message}`,
      );
    }
    console.warn(
      `[auto] 调试端口 ${endpoint} 未响应，正在自动启动浏览器（独立 profile，登录一次即可）…`,
    );
    let launched;
    try {
      launched = await launchBrowser();
    } catch (e2) {
      throw new Error(`自动启动浏览器失败：${e2.message}`);
    }
    cfg.browser.cdpEndpoint = launched.endpoint; // 端口顺延时对齐后续使用
    try {
      browser = await withoutProxy(() =>
        chromium.connectOverCDP(launched.endpoint, { timeout: 10000 }),
      );
      console.warn(`[auto] 浏览器已启动并连接：${launched.endpoint}`);
    } catch (e3) {
      throw new Error(
        `自动启动后仍无法连接 ${launched.endpoint}：${e3.message}\n` +
          '（受限/沙箱执行环境里，脚本拉起的浏览器会随命令结束被回收——' +
          '这种环境请双击 start-browser.bat 或 start-my-edge.bat 由资源管理器启动）',
      );
    }
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error('浏览器无可用上下文，请确认浏览器已正常启动。');
  return { browser, context };
}

/**
 * 从多个标签页中挑出目标评测页（四级挑页链）：
 *
 *   1. TARGET_URL_HINT（.env.local 显式指定的 URL 特征片段）——用户显式覆盖最高优先；
 *      唯一命中即选；命中多个时**报错并列出全部**，绝不猜（防解错页）；零命中告警后降级；
 *   2. 内置题目页 URL 形状正则（复用 watch 的 TASK_URL_PATTERN，默认匹配
 *      /tasks/<courseId>/<数字>/<串>，eduCoder 官网与校内部署一致）；
 *   3. 内容级兜底：URL 都认不出时逐标签页做单次内容探测（强代码编辑器 / 评测面板特征，
 *      见 perceive.looksLikeTaskPage），命中多个取标签序第一个并列日志；
 *   4. 最终兜底（历史行为）：第一个非 about:blank 的页面。
 *
 * 注意：CDP 下 document.visibilityState 对所有标签页都返回 visible（TROUBLESHOOTING
 * C-4 实测），无法识别「用户正在看哪个标签」，因此多命中一律报错列出而不是猜。
 *
 * @returns {Promise<{page, tier: 'url-hint'|'url-pattern'|'content'|'first-page', candidates: import('playwright-core').Page[]}>}
 */
export async function pickTargetPageWithMeta(context) {
  const pages = context.pages();
  if (pages.length === 0) throw new Error('浏览器没有任何打开的标签页。');

  const safeUrl = (p) => {
    try {
      return p.url() || '';
    } catch {
      return '';
    }
  };
  const listPages = (list) => list.map((p) => `  - ${safeUrl(p) || '(空白页)'}`).join('\n');

  // ---- Tier 1：TARGET_URL_HINT 显式指定 ----
  const hint = cfg.browser.urlHint?.trim();
  if (hint) {
    const hits = pages.filter((p) => safeUrl(p).includes(hint));
    if (hits.length === 1) {
      log(`按 TARGET_URL_HINT「${hint}」选中：${safeUrl(hits[0])}`);
      return { page: hits[0], tier: 'url-hint', candidates: hits };
    }
    if (hits.length > 1) {
      throw new Error(
        `TARGET_URL_HINT「${hint}」命中了 ${hits.length} 个标签页，为避免操作错页面请处理后重试` +
          `（关闭多余的标签页，或把 .env.local 里的特征片段改得更具体）：\n${listPages(hits)}`,
      );
    }
    log.warn(`TARGET_URL_HINT「${hint}」无命中，降级按题目页 URL 形状识别`);
  }

  // ---- Tier 2：内置题目页 URL 形状正则（TASK_URL_PATTERN） ----
  const taskHits = pages.filter((p) => isTaskUrl(safeUrl(p)));
  if (taskHits.length === 1) {
    log(`按题目页 URL 形状（TASK_URL_PATTERN）选中：${safeUrl(taskHits[0])}`);
    return { page: taskHits[0], tier: 'url-pattern', candidates: taskHits };
  }
  if (taskHits.length > 1) {
    throw new Error(
      `发现 ${taskHits.length} 个题目页标签页（URL 匹配 TASK_URL_PATTERN），` +
        `为避免解错页面，请只保留要做的那个题目页标签后重试：\n${listPages(taskHits)}`,
    );
  }

  // ---- Tier 3：内容级兜底（URL 两级都落空时按页面特征识别） ----
  const contentHits = [];
  for (const p of pages) {
    const u = safeUrl(p);
    if (!u || u === 'about:blank') continue;
    const sig = await looksLikeTaskPage(p).catch(() => null);
    if (sig) contentHits.push({ page: p, sig });
  }
  if (contentHits.length > 0) {
    if (contentHits.length > 1) {
      log.warn(
        `内容级识别命中 ${contentHits.length} 个页面，取标签序第一个：\n` +
          listPages(contentHits.map((c) => c.page)),
      );
    }
    const { page, sig } = contentHits[0];
    log(`URL 未命中，按页面内容特征选中：${safeUrl(page)}（特征：${sig.reasons.join('、')}）`);
    return { page, tier: 'content', candidates: contentHits.map((c) => c.page) };
  }

  // ---- Tier 4：最终兜底（历史行为：第一个非空白页） ----
  const usable = pages.find((p) => safeUrl(p) && safeUrl(p) !== 'about:blank');
  const page = usable ?? pages[0];
  log.warn(`未识别到题目页，回退到第一个非空白标签页：${safeUrl(page)}`);
  return { page, tier: 'first-page', candidates: [page] };
}

/**
 * 挑出目标评测页（兼容旧签名，内部走 pickTargetPageWithMeta 四级链）。
 */
export async function pickTargetPage(context) {
  const m = await pickTargetPageWithMeta(context);
  return m.page;
}

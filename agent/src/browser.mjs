// EXPORTS: connectBrowser, pickTargetPage
// 浏览器连接层：通过 CDP 连接用户已登录的 Edge/Chrome，并挑出评测页面标签。

import { chromium } from 'playwright-core';
import { cfg } from './config.mjs';

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
  const keys = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ];
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
 * 连接 CDP 端点
 * @returns {Promise<{browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext}>}
 */
export async function connectBrowser() {
  const endpoint = cfg.browser.cdpEndpoint;
  let browser;
  try {
    browser = await withoutProxy(() =>
      chromium.connectOverCDP(endpoint, { timeout: 10000 }),
    );
  } catch (err) {
    throw new Error(
      `无法连接浏览器调试端口 ${endpoint}。\n` +
        '请先启动带调试端口的浏览器：npm run browser\n' +
        `原始错误：${err.message}`,
    );
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error('浏览器无可用上下文，请确认浏览器已正常启动。');
  return { browser, context };
}

/**
 * 从多个标签页中挑出目标评测页
 * 优先 URL 含 urlHint 的，否则取第一个非 about:blank 的页面
 */
export async function pickTargetPage(context) {
  const pages = context.pages();
  if (pages.length === 0) throw new Error('浏览器没有任何打开的标签页。');

  const hint = cfg.browser.urlHint?.trim();
  if (hint) {
    const hit = pages.find((p) => p.url().includes(hint));
    if (hit) return hit;
    throw new Error(
      `没有找到 URL 含「${hint}」的标签页。当前打开的：\n` +
        pages.map((p) => '  - ' + p.url()).join('\n'),
    );
  }

  const usable = pages.find((p) => p.url() && p.url() !== 'about:blank');
  if (usable) return usable;
  return pages[0];
}

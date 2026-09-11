// EXPORTS: withBrowserSession, drainQueue, sessionStatus, disconnectSession
// 浏览器会话管理器：为常驻进程形态（MCP server / Web server）提供
// 「懒连接 + 会话内复用 + 断线重连 + 互斥串行」的浏览器连接管理。
//
// 背景：CLI 各命令是「连一次 → 做事 → finally 断开」的短生命周期
// （connectBrowser + 各 loop 自行收尾，browser.close 对 CDP 连接只是断开、
// 不杀浏览器进程——playwright-core 1.63.0 types.d.ts:11147 实查）；常驻进程
// 不能这样：①浏览器操作必须全进程串行（一次只做一题，并发会互相踩页面）；
// ②连接要跨多次调用复用（每次调用重建 CDP 连接是纯开销）。
// 断线重连始终安全：浏览器进程不随断开而退出，connectBrowser 会重新接管。

import { connectBrowser } from './browser.mjs';

let session = null; // { browser, context }
let connecting = null; // 进行中的连接 Promise（防并发重复连接）
let queue = Promise.resolve(); // 互斥队列：所有浏览器操作串行执行

async function ensureConnected() {
  if (session && session.browser.isConnected()) return session;
  if (connecting) return connecting;
  connecting = (async () => {
    session = await connectBrowser();
    return session;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * 在互斥队列中执行一个浏览器操作（全进程串行，防并发踩同一页面）。
 * 队列语义：无论前一个操作成功与否，后续操作都继续执行。
 * @template T
 * @param {(session: {browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withBrowserSession(fn) {
  const run = async () => fn(await ensureConnected());
  const result = queue.then(run, run);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** 等待互斥队列排空（不触发浏览器连接）；常驻进程退出前用它等待在途操作完成 */
export function drainQueue() {
  return queue.then(
    () => {},
    () => {},
  );
}

/** 当前连接状态（只读查询，不触发连接）：供状态面板展示 */
export function sessionStatus() {
  return { connected: Boolean(session && session.browser.isConnected()) };
}

/** 主动断开 CDP 连接（不杀浏览器进程，重连即恢复） */
export async function disconnectSession() {
  if (!session) return;
  const s = session;
  session = null;
  await s.browser.close().catch(() => {});
}

// EXPORTS: isPortListening, reportCdpPortStartupCheck
// 启动自检：在双击运行的入口（watch / lite / course / web）启动时探测 CDP 调试端口，
// 给出一条新手能看懂的状态——就绪打勾，没响应则明确告诉下一步该做什么。
//
// 设计：仅提示、不阻断。端口无响应时由 connectBrowser 的 auto-launch 兜底
// （独立 profile 浏览器），本模块只负责把"为什么等一下会弹出一个新浏览器"提前讲清楚。
// 真机反馈（2026-09-12）：同学跳过受控浏览器直接运行时，故障要到点按钮/连接时才暴露，
// 中间隔着自动拉起等一串动作，无从判断当前处于哪一步。

import net from 'node:net';
import { cfg } from './config.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('startup');

/** 探测 TCP 端口是否可连（1.5s 超时；任何错误一律按"没在监听"处理） */
export function isPortListening(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 从 cfg.browser.cdpEndpoint（如 http://127.0.0.1:9333）解析 host/port */
function cdpHostPort() {
  try {
    const url = new URL(cfg.browser.cdpEndpoint);
    return {
      host: url.hostname || '127.0.0.1',
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    };
  } catch {
    return { host: '127.0.0.1', port: Number(process.env.DEBUG_PORT) || 9333 };
  }
}

/**
 * 启动自检（watch / lite / course / web 入口调用）：打印 CDP 端口状态与后续指引。
 * @returns {Promise<boolean>} 端口是否就绪
 */
export async function reportCdpPortStartupCheck() {
  const { host, port } = cdpHostPort();
  const listening = await isPortListening(host, port);
  if (listening) {
    log(`调试端口 ${host}:${port} 已就绪 ✓`);
  } else {
    log.warn(`调试端口 ${host}:${port} 没有响应——受控浏览器还没启动。`);
    log.warn('  · 推荐：Ctrl+C 停止本程序，先双击 start-my-edge.bat，再重新运行；');
    log.warn(
      '  · 或什么都不做：稍后会自动拉起一个独立 profile 浏览器兜底（首次需在其中登录评测站）。',
    );
  }
  return listening;
}

// EXPORTS: (入口) node src/web-server.mjs —— 网页工作台（HTTP API + 单文件前端）
// 方案 C 的最小落地（见《妙答Agent-全栈架构演进方案对比分析》）：
//   - 零新增依赖：Node 内置 node:http，前端为单文件原生子页（无 React、无构建链
//     ——尊重 2026-09-09 移除 React 工作台的决策，本服务只做最小可用形态）
//   - 会话管理复用 browser-session.mjs：懒连接 + 互斥串行（一次只做一题）+ 断线重连
//
// 安全边界：
//   - 只绑定 127.0.0.1：服务不对局域网/外网暴露；真正的"多人使用"需要浏览器池
//     与账号隔离，属产品化场景，不在本期范围
//   - 不实现任何「抓取用户提供的 URL」类功能；AI 端点配置复用 .env.local，不新增密钥面
//   - 端点固定且无参数（probe / solve），无任意文件读取、无代理跳转

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.mjs';
import { pickTargetPage } from './browser.mjs';
import { probePage } from './perceive.mjs';
import { solveOnce } from './loop.mjs';
import { withBrowserSession, disconnectSession, sessionStatus } from './browser-session.mjs';
import { addLogSink, createLogger } from './logger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const HOST = '127.0.0.1';
const PORT = Number(process.env.WEB_PORT ?? 8787);
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

const log = createLogger('web');

// 内存环形日志缓冲（最近 200 条），供 /api/logs 增量轮询
const LOG_RING_MAX = 200;
const logRing = [];
let logSeq = 0;
addLogSink((e) => {
  logRing.push({ seq: ++logSeq, ...e });
  if (logRing.length > LOG_RING_MAX) logRing.shift();
});

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? HOST}`);
  try {
    // ---- 静态页 ----
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ---- 状态（只读，不触发浏览器连接） ----
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, {
        version: PKG.version,
        aiReady: Boolean(cfg.ai.baseUrl && cfg.ai.apiKey),
        model: cfg.ai.model,
        browser: sessionStatus(),
        logs: { buffered: logRing.length, lastSeq: logSeq },
      });
    }

    // ---- 只读感知 ----
    if (req.method === 'POST' && url.pathname === '/api/probe') {
      const r = await withBrowserSession(async (session) => {
        const page = await pickTargetPage(session.context);
        const p = await probePage(page);
        return {
          url: p.url,
          taskType: p.taskType,
          editor: p.editor ? { type: p.editor.type, hint: p.editor.hint } : null,
          problemLength: p.problem?.length ?? 0,
          problemPreview: (p.problem ?? '').slice(0, 800),
          codeTemplateLength: p.code?.length ?? 0,
          inputs: p.inputs ?? null,
          questions: (p.questions ?? []).map((q) => ({
            no: q.no,
            multi: q.multi,
            options: q.options,
          })),
          clickables: (p.clickables ?? []).slice(0, 15).map((c) => `[${c.tag}] ${c.text}`),
        };
      });
      return json(res, 200, r);
    }

    // ---- 解当前题（会真实提交评测；编排/反思循环在 agent 侧） ----
    if (req.method === 'POST' && url.pathname === '/api/solve') {
      const r = await withBrowserSession(async (session) => {
        const page = await pickTargetPage(session.context);
        const probe = await probePage(page);
        return solveOnce(page, probe);
      });
      return json(res, 200, {
        ok: r.ok,
        kind: r.kind ?? null,
        reason: r.reason ?? null,
        attempts: r.attempts ?? null,
        verdict: r.verdict ? { passed: r.verdict.passed, reason: r.verdict.reason } : null,
        evalText: (r.evalText ?? '').slice(0, 3000),
      });
    }

    // ---- 日志增量轮询 ----
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return json(res, 200, {
        items: logRing.filter((e) => e.seq > since),
        lastSeq: logSeq,
      });
    }

    json(res, 404, { error: `未知路径：${req.method} ${url.pathname}` });
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

function shutdown() {
  // browser.close 对 CDP 连接仅断开、不杀浏览器进程（playwright-core 实查）
  disconnectSession()
    .catch(() => {})
    .finally(() => process.exit(0));
}

server.listen(PORT, HOST, () => {
  log(`网页工作台已启动：http://${HOST}:${PORT}（仅本机可访问）`);
  log('请在带调试端口的浏览器中打开评测题目页后使用「探测页面 / 解当前题」');
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 真机反馈（2026-09-12）：新手最常见场景是工作台已经开过一个窗口又重复双击，
    // 旧文案"换 WEB_PORT"会把人引去改配置，实际多数情况只需直接用浏览器访问。
    console.error('[web] 启动失败：127.0.0.1:' + PORT + ' 已被占用。两种可能：');
    console.error('  1) 网页工作台已经在运行（最常见）——不用再启动，黑窗口保持开着，');
    console.error('     直接用浏览器打开 http://127.0.0.1:' + PORT + ' 使用即可；');
    console.error('  2) 端口被别的程序占了——若打开上面地址不是本工作台页面，');
    console.error('     在 agent/.env.local 里加一行 WEB_PORT=8788（或其他空号）再重新双击。');
  } else {
    console.error(`[web] 启动失败：${err.message}`);
  }
  process.exit(1);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

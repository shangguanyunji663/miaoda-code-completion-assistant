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
//   - 端点固定且无参数（probe / solve / stop），无任意文件读取、无代理跳转
//
// 手动停止（1.4.0）：评测反复不通过时，反思重试会一直烧到 MAX_RETRY（默认 10 轮，
// 单轮可达数分钟）。POST /api/stop 置位中断标志，solveOnce 在下一个检查点抛
// StopRequested——不再提交下一次评测、不再发起下一次 AI 调用。该端点**不经过**
// 浏览器操作互斥队列（否则会被在途解题挡住，点了没反应）；停止语义与轮次隔离
// 见 control.mjs。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, loadEnv } from './config.mjs';
import { pickTargetPageWithMeta } from './browser.mjs';
import { probePage } from './perceive.mjs';
import { solveOnce } from './loop.mjs';
import { requestStop, stopState } from './control.mjs';
import { withBrowserSession, disconnectSession, sessionStatus } from './browser-session.mjs';
import { reportCdpPortStartupCheck } from './port-check.mjs';
import { addLogSink, createLogger } from './logger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const HOST = '127.0.0.1';
const PORT = Number(process.env.WEB_PORT ?? 8787);
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const ENV_FILE = path.join(__dirname, '..', '.env.local');

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

/** 读请求体（限 1MB） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * 以 .env.local 文件的 AI_MODEL 为准自愈运行态（双向同步的一侧）：
 * 用户手改文件后无需重启，下次 /api/status 轮询即检测差异并热生效。
 */
function syncModelFromEnv() {
  try {
    const env = loadEnv();
    if (env.AI_MODEL && env.AI_MODEL !== cfg.ai.model) {
      const old = cfg.ai.model;
      cfg.ai.model = env.AI_MODEL;
      log(`检测到 .env.local 模型变更：${old || '(空)'} → ${env.AI_MODEL}（已热生效，无需重启）`);
    }
  } catch {
    /* 读失败静默，维持运行态 */
  }
  return cfg.ai.model;
}

/** 把模型名写回 .env.local 的 AI_MODEL 行并热生效（双向同步的另一侧） */
function updateModelInEnv(value) {
  const raw = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const lines = raw.split(/\r?\n/);
  const re = /^AI_MODEL\s*=/;
  const line = `AI_MODEL=${value}`;
  if (lines.some((l) => re.test(l))) {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) lines[i] = line;
  } else {
    lines.push(line);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
  cfg.ai.model = value;
  log(`模型已更新并写回 .env.local：${value}`);
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

    // ---- 状态（只读，不触发浏览器连接；模型以 .env.local 为准自愈同步） ----
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, {
        version: PKG.version,
        aiReady: Boolean(cfg.ai.baseUrl && cfg.ai.apiKey),
        model: syncModelFromEnv(),
        browser: sessionStatus(),
        // 运行态：前端据此显示"跑到哪一步"并决定「停止做题」按钮是否可点
        //（running 与浏览器连接解耦——探测类请求不置 running）
        run: stopState(),
        logs: { buffered: logRing.length, lastSeq: logSeq },
      });
    }

    // ---- 模型名配置（页面 ↔ .env.local 双向同步；不涉及密钥） ----
    if (req.method === 'POST' && url.pathname === '/api/config') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const model = String(body.model ?? '').trim();
      if (!model || /[\s#=]/.test(model)) {
        return json(res, 400, { error: '模型名不能为空，且不能包含空白、# 或 =（仅模型名）' });
      }
      updateModelInEnv(model);
      return json(res, 200, { model: cfg.ai.model, saved: true });
    }

    // ---- 只读感知 ----
    if (req.method === 'POST' && url.pathname === '/api/probe') {
      const r = await withBrowserSession(async (session) => {
        const pick = await pickTargetPageWithMeta(session.context);
        const p = await probePage(pick.page);
        return {
          url: p.url,
          // 挑页链命中层级：url-hint / url-pattern / content / first-page，
          // 让用户能看到"探测的是哪个页面、怎么选中的"（多候选时前端可见 candidates）
          pickedBy: pick.tier,
          // 页面可能正被销毁，url() 会抛错——逐个兜底为空串，不让探测整体 500
          candidates:
            pick.candidates.length > 1
              ? pick.candidates.map((c) => {
                  try {
                    return c.url();
                  } catch {
                    return '';
                  }
                })
              : undefined,
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
      let r;
      try {
        r = await withBrowserSession(async (session) => {
          const pick = await pickTargetPageWithMeta(session.context);
          const probe = await probePage(pick.page);
          const out = await solveOnce(pick.page, probe);
          return { url: pick.page.url(), pickedBy: pick.tier, ...out };
        });
      } catch (err) {
        // 手动停止（1.4.0）：solveOnce 在检查点抛出的 StopRequested 收敛为
        // 一次"正常结束但未通过"的响应（HTTP 200 + stopped:true），
        // 前端据此显示"已停止"而不是把它当服务端错误
        if (!err?.isStopRequested) throw err;
        log(`已停止当前解题：${err.message}`);
        return json(res, 200, {
          ok: false,
          stopped: true,
          reason: 'stopped-by-user',
          stoppedAt: err.stage || null,
          message: err.message,
        });
      }
      return json(res, 200, {
        ok: r.ok,
        stopped: false,
        kind: r.kind ?? null,
        reason: r.reason ?? null,
        attempts: r.attempts ?? null,
        url: r.url ?? null,
        pickedBy: r.pickedBy ?? null,
        verdict: r.verdict ? { passed: r.verdict.passed, reason: r.verdict.reason } : null,
        evalText: (r.evalText ?? '').slice(0, 3000),
      });
    }

    // ---- 手动停止做题（打断在途的解题循环，幂等） ----
    // 不走 withBrowserSession：那个队列被在途解题占着，排队就等于"点了没反应"。
    // 置位后由 loop/ai/act 各检查点接管（不再提交评测、不再发起 AI 调用）。
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const st = stopState();
      if (!st.running) {
        return json(res, 200, {
          ok: true,
          stopped: false,
          running: false,
          message: '当前没有正在进行的解题任务（无需停止）',
        });
      }
      requestStop('用户在网页工作台点击「停止做题」');
      log(
        `已收到「停止做题」请求——当前阶段：${st.phase}（将在该步骤的检查点立即中断，不再提交下一次评测、不再发起下一次 AI 调用）`,
      );
      return json(res, 200, {
        ok: true,
        stopped: true,
        running: true,
        phase: st.phase,
        runSeq: st.runSeq,
        message: `已请求停止（当前阶段：${st.phase}）`,
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
  // 启动自检：浏览器是懒连接，此刻不查的话"没开受控浏览器"要到点按钮才暴露
  reportCdpPortStartupCheck();
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

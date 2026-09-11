// EXPORTS: (入口) node src/mcp-server.mjs —— MCP Server（stdio 传输）
// 把本 Agent 的解题能力以 MCP 工具暴露给宿主（ZCode / Claude Desktop / Cursor 等）。
//
// 设计要点（对应《妙答Agent-全栈架构演进方案对比分析》方案 A）：
//   1. 粗粒度工具：编排（生成 → 评测 → 反思循环）留在 agent 侧，不把原子浏览器
//      操作暴露给宿主——act.mjs 的领域适配（Monaco setValue / xterm 键入 / echo
//      双引号守则）是本项目核心资产，让渡即丢失。
//   2. AI 调用留在工具内部：detectVerdict / 反思循环 / shell 护栏与 chat 深度耦合，
//      不对宿主开放 chat 原语。
//   3. 会话管理见 browser-session.mjs：懒连接 + 互斥串行 + 断线重连。
//   4. 不暴露 courseLoop 跑批：长任务与宿主工具超时模型冲突，留 v2 再议。
//
// stdout 纪律：本进程 stdout 只允许出现 JSON-RPC 报文。所有日志走 stderr
// （LOG_STREAM=stderr，下方模块体第一行设置）或 agent/logs/ 文件。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { cfg } from './config.mjs';
import { pickTargetPage } from './browser.mjs';
import { probePage } from './perceive.mjs';
import { solveOnce } from './loop.mjs';
import { listChatModels } from './ai.mjs';
import { withBrowserSession, disconnectSession } from './browser-session.mjs';
import { createLogger } from './logger.mjs';

// 必须先于任何日志输出（本模块的 import 加载完成后、main() 之前执行）
process.env.LOG_STREAM = 'stderr';

const log = createLogger('mcp');
const server = new McpServer({ name: 'miaoda-agent', version: '1.2.0' });

/** 统一工具返回：结构化 JSON 文本 */
function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function jsonError(err) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: String(err?.message ?? err) }) }],
    isError: true,
  };
}

// ---- 生命周期 ----
// 退出语义（2026-09-11 冒烟两次踩坑后定稿）：
//   - stdin EOF（宿主写完请求即关管道）→ 等「在途调用归零」再退出，否则会掐断
//     最后一个工具的响应；
//   - guard 的 finally 早于 SDK 发送响应的微任务链执行，故退出检查必须让出
//     事件循环一拍（setTimeout 0），否则 exit 仍抢在响应落盘前；
//   - SIGINT / SIGTERM（宿主要求终止）→ 立即断开退出，在途调用由宿主侧负责。
let stdinClosed = false;
let exiting = false;
let inflight = 0;

/** 包裹工具处理器：维护在途计数，供「EOF 后等在途清零」的退出判定 */
function guard(fn) {
  return async (...args) => {
    inflight++;
    try {
      return await fn(...args);
    } finally {
      inflight--;
      setTimeout(exitIfIdle, 0);
    }
  };
}

function disconnectAndExit() {
  if (exiting) return;
  exiting = true;
  disconnectSession()
    .catch(() => {})
    .finally(() => process.exit(0));
}

function exitIfIdle() {
  if (stdinClosed && inflight === 0) disconnectAndExit();
}

// ---- 工具 1：只读感知（最低风险，宿主可放心调用） ----
server.tool(
  'probe_page',
  '只读感知当前评测页面：URL / 题型 / 编辑器类型 / 题干摘要 / 可点击元素。不修改页面、不作答、不提交。',
  {},
  guard(async () => {
    try {
      const r = await withBrowserSession(async (session) => {
        const page = await pickTargetPage(session.context);
        const p = await probePage(page);
        return {
          url: p.url,
          taskType: p.taskType,
          editor: p.editor ? { type: p.editor.type, hint: p.editor.hint } : null,
          problemLength: p.problem?.length ?? 0,
          problemPreview: (p.problem ?? '').slice(0, 600),
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
      return jsonResult(r);
    } catch (err) {
      return jsonError(err);
    }
  }),
);

// ---- 工具 2：一键解当前题（含真实提交评测；反思循环在 agent 侧执行） ----
server.tool(
  'solve_current_task',
  '解当前评测页的这一道题：感知 → AI 生成/作答 → 提交评测 → 失败反思重试（至多重试上限）。' +
    '会真实点击「评测」提交。选择/填空/代码/命令行/混合题通吃，编排逻辑在服务端。',
  {},
  guard(async () => {
    try {
      const r = await withBrowserSession(async (session) => {
        const page = await pickTargetPage(session.context);
        const probe = await probePage(page);
        const r = await solveOnce(page, probe);
        return {
          ok: r.ok,
          kind: r.kind ?? null,
          reason: r.reason ?? null,
          attempts: r.attempts ?? null,
          verdict: r.verdict ? { passed: r.verdict.passed, reason: r.verdict.reason } : null,
          evalText: (r.evalText ?? '').slice(0, 2000),
        };
      });
      return jsonResult(r);
    } catch (err) {
      return jsonError(err);
    }
  }),
);

// ---- 工具 3：列模型（调试用，无浏览器依赖） ----
server.tool(
  'list_models',
  '列出 AI 端点当前可用的文本模型。',
  {},
  guard(async () => {
    try {
      return jsonResult({ models: await listChatModels(), current: cfg.ai.model });
    } catch (err) {
      return jsonError(err);
    }
  }),
);

async function main() {
  // stdio 纪律见文件头：stdout 只出 JSON-RPC。stdin EOF（宿主关闭管道）→ 等在途
  // 调用归零后退出；SIGINT/SIGTERM（宿主要求终止）→ 立即退出（见上方生命周期语义）
  await server.connect(new StdioServerTransport());
  log('MCP server 已启动（stdio）：工具 probe_page / solve_current_task / list_models');
  process.stdin.on('end', () => {
    stdinClosed = true;
    exitIfIdle();
  });
  process.on('SIGINT', disconnectAndExit);
  process.on('SIGTERM', disconnectAndExit);
}

main().catch((err) => {
  console.error(`[mcp] 启动失败：${err.message}`);
  process.exitCode = 1;
});

// 「停止做题」断流集成测试（1.4.0）：用本地 SSE 假端点验证 chat 的在途请求
// 能被即时 abort，并抛 StopRequested、不进退避重试。零新增依赖（node:test + node:http）。
//
// 为什么不能只靠 run 级单测：停止机制里最脆的一环是"AI 正在流式思考时点停止"
// ——若只依赖阶段边界的 checkStop，用户要等模型自然思考完（可达 120s）才停得下来，
// 体验上等于没停。这条用例把"信号 → abort → 抛 StopRequested → 不重试"钉死。
//
// 手法：起一个只发 reasoning 增量、永不结束的 SSE 服务，把 cfg.ai.baseUrl 指过去
// （cfg 是可变对象，chat 在调用期读取，故无需重启进程），发一轮请求后在流中途请求停止。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cfg } from '../src/config.mjs';
import { chat } from '../src/ai.mjs';
import { beginRun, endRun, requestStop, StopRequested } from '../src/control.mjs';

/** 起一个"永久思考"的 SSE 假端点，返回 { baseUrl, requests, close } */
async function startSlowSseServer() {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 首片立即到达（确保请求已进入流式阶段），之后持续发增量但永不收尾
    res.write('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n');
    const tick = setInterval(() => {
      res.write('data: {"choices":[{"delta":{"reasoning_content":"。"}}]}\n\n');
    }, 40);
    res.on('close', () => clearInterval(tick));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    getRequests: () => requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('手动停止：在途 AI 流被即时断流，抛 StopRequested 且不进入重试', async () => {
  const fake = await startSlowSseServer();
  const saved = { baseUrl: cfg.ai.baseUrl, apiKey: cfg.ai.apiKey };
  cfg.ai.baseUrl = fake.baseUrl;
  cfg.ai.apiKey = 'test-key';

  beginRun('单测');
  try {
    const pending = chat([{ role: 'user', content: 'hi' }], { maxAttempts: 2 });
    // 等请求确实进入流式阶段（首片 + 若干增量已到达）再停止
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fake.getRequests(), 1, '停止前应已发起 1 次请求');

    const t0 = Date.now();
    requestStop('单测');
    await assert.rejects(
      pending,
      (e) => e instanceof StopRequested && e.isStopRequested === true && /中断/.test(e.message),
      '停止应抛 StopRequested（而非 AbortError 被描述成空闲超时）',
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `断流应即时生效（实测 ${elapsed}ms）`);
    // 关键：停止后不得再发起第 2 次请求（退避重试）——否则用户以为停了、实际在烧 token
    assert.equal(fake.getRequests(), 1, '停止后不得再发起 AI 请求');
  } finally {
    endRun();
    cfg.ai.baseUrl = saved.baseUrl;
    cfg.ai.apiKey = saved.apiKey;
    await fake.close();
  }
});

test('未请求停止时正常流不受影响（对照组）', async () => {
  // 同一假端点，但这次让服务端主动收尾，验证正常路径未被检查点破坏
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const saved = { baseUrl: cfg.ai.baseUrl, apiKey: cfg.ai.apiKey };
  cfg.ai.baseUrl = `http://127.0.0.1:${port}/v1`;
  cfg.ai.apiKey = 'test-key';

  beginRun('单测');
  try {
    const out = await chat([{ role: 'user', content: 'hi' }], { maxAttempts: 1 });
    assert.equal(out.content, 'OK');
  } finally {
    endRun();
    cfg.ai.baseUrl = saved.baseUrl;
    cfg.ai.apiKey = saved.apiKey;
    await new Promise((resolve) => server.close(resolve));
  }
});

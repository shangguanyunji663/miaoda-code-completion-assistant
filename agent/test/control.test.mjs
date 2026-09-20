// 运行控制层单测（control.mjs）：停止信号、轮次隔离、订阅通知。零新增依赖（node:test）。
//
// 背景（1.4.0）：网页工作台新增「停止做题」——评测反复不通过时人工打断反思重试。
// 中断靠 checkStop 抛 StopRequested 沿异步链冒泡，因此这里必须钉死两条契约：
//   ① 未请求停止时检查点绝不能抛（否则正常解题被误杀）；
//   ② 停止请求只对它发出时正在跑的那一轮生效（轮次隔离）——否则"点停止的同时
//      又点了新解题"会让新任务被上一轮的停止请求误杀。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StopRequested,
  beginRun,
  endRun,
  requestStop,
  checkStop,
  isStopping,
  onStop,
  stopState,
} from '../src/control.mjs';

test('未请求停止：检查点放行，且同时刷新运行态展示的阶段', () => {
  beginRun('测试轮次');
  assert.equal(stopState().running, true);
  assert.equal(stopState().phase, '测试轮次');
  assert.equal(isStopping(), false);
  assert.doesNotThrow(() => checkStop('等待评测结果'));
  assert.equal(stopState().phase, '等待评测结果', '检查点应顺带推进阶段展示');
  endRun();
  assert.equal(stopState().running, false);
  assert.equal(stopState().phase, '空闲');
});

test('请求停止后：检查点抛 StopRequested，且带出中断阶段与可判定标记', () => {
  beginRun('测试轮次');
  requestStop('单测');
  assert.equal(isStopping(), true);
  assert.throws(
    () => checkStop('等待评测结果'),
    (e) =>
      e instanceof StopRequested &&
      e.isStopRequested === true &&
      e.stage === '等待评测结果' &&
      /等待评测结果/.test(e.message),
  );
  endRun();
});

test('轮次隔离：停止请求不跨轮生效（新一轮不继承上一轮的中断）', () => {
  beginRun('第一轮');
  requestStop('单测');
  assert.equal(isStopping(), true, '同一轮内应立即生效');
  endRun();

  beginRun('第二轮');
  assert.equal(isStopping(), false, '新一轮不得继承上一轮的停止标志');
  assert.doesNotThrow(() => checkStop('新一轮阶段'));
  endRun();
});

test('运行态快照：停止只在当前轮运行中标记 stopping', () => {
  beginRun('测试轮次');
  requestStop('单测');
  assert.equal(stopState().stopping, true, '运行中且已请求停止 → stopping');
  endRun();
  assert.equal(stopState().running, false);
  assert.equal(stopState().stopping, false, '运行结束后不得再声称正在停止');
  assert.equal(stopState().stopReason, null);
});

test('onStop 订阅：请求停止时同步回调；退订后不再触发', () => {
  beginRun('测试轮次');
  const hits = [];
  const off = onStop((reason) => hits.push(reason));
  requestStop('单测原因');
  assert.deepEqual(hits, ['单测原因'], '订阅者应在 requestStop 内同步收到通知');
  off();

  beginRun('第二轮');
  requestStop('第二次');
  assert.deepEqual(hits, ['单测原因'], '退订后不应再收到通知');
  endRun();
});

test('onStop 订阅者抛错不影响停止流程与其他订阅者', () => {
  beginRun('测试轮次');
  const hits = [];
  const off1 = onStop(() => {
    throw new Error('订阅者自身故障');
  });
  const off2 = onStop((reason) => hits.push(reason));
  assert.doesNotThrow(() => requestStop('单测'));
  assert.deepEqual(hits, ['单测'], '一个订阅者抛错不得阻断其余订阅者');
  assert.equal(isStopping(), true, '订阅者异常绝不能吞掉停止标志');
  off1();
  off2();
  endRun();
});

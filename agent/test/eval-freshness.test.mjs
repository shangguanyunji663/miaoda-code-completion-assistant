// 评测结果防陈旧 + 动态预算单测（1.5.0）。
//
// 背景（2026-09-22 真机事故，Redis 优先级队列题）：Agent 在 12:16:31 点击评测，
// 12:16:35（4 秒后）就以"面板文本与点击前一致（同错复现）"采信了**上一轮遗留**的
// 结果面板——而该题本关最大执行时间是 120 秒，本轮评测根本没跑完。后果是反思拿
// 假证据编造机制（"队列名被 blpop 从有序集合中隐式删除"），改出的代码在 Python 2
// 下连语法都不过；紧接着第二次点击又落在仍在评测的页面上被拦截 → 整题作废。
//
// 钉死三条契约：
//   ① 本轮提交与上一轮不同 → 绝不采信"与点击前一致"的面板（返回带陈旧标记的文本）
//   ② 本轮提交与上一轮相同 → 允许同错复现捷径（但最短等待从 3s 抬到 10s）
//   ③ 等待预算必须覆盖平台自报的「本关最大执行时间」
//
// 时间由假时钟驱动（Date.now 与 page.waitForTimeout 一起推进），所以这些用例
// 覆盖 30s/120s 量级的等待预算也只跑几十毫秒。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DRY_RUN = '0';
const { cfg } = await import('../src/config.mjs');
const { parsePlatformMaxSeconds, evalDeadlineAt, isStaleEvalText, waitEvalResult } =
  await import('../src/act.mjs');

/** 带结果面板标记的遗留文本（hasResultMarker 认「测试结果」，不必依赖时限栏） */
const PANEL = '测试结果：共有 2 组测试集。实际输出与预期输出不匹配';
const PANEL_WITH_LIMIT = `${PANEL}本关最大执行时间：120 秒。`;

/** 假时钟：只在本用例内接管 Date.now，page.waitForTimeout 负责推进它 */
function withFakeClock(run) {
  const realNow = Date.now;
  let fake = realNow.call(Date);
  Date.now = () => fake;
  const page = {
    mainFrame: () => page._frame,
    frames: () => [page._frame],
    waitForTimeout: async (ms) => {
      fake += ms;
    },
    _frame: {},
  };
  const setFrameText = (t) => {
    page._frame = {
      evaluate: async () => t,
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
    };
  };
  return (async () => {
    try {
      return await run(page, setFrameText);
    } finally {
      Date.now = realNow;
    }
  })();
}

test('parsePlatformMaxSeconds：认得平台这栏的常见写法，认不出即 0', () => {
  assert.equal(parsePlatformMaxSeconds('本关最大执行时间：120 秒'), 120);
  assert.equal(parsePlatformMaxSeconds('本关最大执行时间为 60秒'), 60);
  assert.equal(parsePlatformMaxSeconds('本关最大执行时间：3 秒'), 3);
  assert.equal(parsePlatformMaxSeconds('没有任何时限信息'), 0);
  assert.equal(parsePlatformMaxSeconds(undefined), 0);
});

test('evalDeadlineAt：平台自报 120 秒时预算必须盖过它（旧版固定 30s 是事故根因）', () => {
  const start = 1_000_000;
  const r = evalDeadlineAt(start, 30_000, PANEL_WITH_LIMIT, 300_000, 15_000);
  assert.equal(r.extended, true);
  assert.equal(r.deadlineAt, start + 135_000, '120s + 15s 收尾余量');
});

test('evalDeadlineAt：本地预算更长时不缩短；离谱自报值被 cap 兜住', () => {
  assert.equal(
    evalDeadlineAt(0, 60_000, '本关最大执行时间：3 秒', 300_000, 15_000).deadlineAt,
    60_000,
  );
  assert.equal(
    evalDeadlineAt(0, 30_000, '本关最大执行时间：99999 秒', 240_000, 15_000).deadlineAt,
    240_000,
  );
  assert.equal(evalDeadlineAt(0, 25_000, '无时限栏', 300_000, 15_000).deadlineAt, 25_000);
});

test('代码已变 → 遗留面板不得当本轮结果：返回陈旧标记 + 遗留原文', async () => {
  await withFakeClock(async (page, setText) => {
    setText(PANEL);
    const text = await waitEvalResult(page, 30_000, { codeUnchanged: false });
    assert.equal(isStaleEvalText(text), true, '必须带"本轮结果未确认"首行标记');
    assert.match(text, /严禁[\s\S]*推断本轮的?失败原因/, '要显式禁止反思据此推测');
    assert.ok(text.includes(PANEL), '遗留文本仍作为参考保留');
  });
});

test('代码与上一轮相同 → 允许同错复现捷径，直接采用面板文本', async () => {
  await withFakeClock(async (page, setText) => {
    setText(PANEL);
    const text = await waitEvalResult(page, 60_000, { codeUnchanged: true });
    assert.equal(isStaleEvalText(text), false);
    assert.equal(text, PANEL);
  });
});

test('同错复现捷径不得早于最短等待（默认 10s：旧版 3s 时平台多半还没跑完）', async () => {
  assert.ok(cfg.loop.evalUnchangedMinMs >= 10_000);
  await withFakeClock(async (page, setText) => {
    // 预算只有 2 秒 < 最短等待 → 捷径来不及触发，只能走"未观测到变化"分支
    setText(PANEL);
    const text = await waitEvalResult(page, 2_000, { codeUnchanged: true });
    assert.equal(isStaleEvalText(text), false, '预算内未采用，也就没有返回文本');
    assert.equal(text, '');
  });
});

test('面板全程读不到内容 → 仍按旧行为返回空串（不硬造陈旧说明）', async () => {
  await withFakeClock(async (page, setText) => {
    setText('');
    const text = await waitEvalResult(page, 3_000, { codeUnchanged: false });
    assert.equal(text, '');
  });
});

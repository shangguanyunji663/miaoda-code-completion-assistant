// clickByKeywords 点击重扫兜底单测（1.4.1）。
//
// 背景（2026-09-20 真机事故）：评测按钮偶发被遮挡/未就绪，旧实现「三次点击被拦截即放弃」→
// loop 直接判「未找到评测按钮」终止整题；但实测该按钮**存在且可见**
// （`评测 @1608,941 visible=true`），页面上也没有真实遮罩。
//
// 本用例用假 page 钉死三条契约：
//   ① 首轮被拦截、次轮点中 → 必须成功（不能因为一次遮挡就放弃）
//   ② 始终点不动 → 必须在有界窗口内放弃（**绝不死循环**）
//   ③ 按钮不存在 → 不点击、直接返回失败（失败原因可与"点不动"区分）
//
// 1.5.0 追加（2026-09-22 事故）：②的返回值必须带 exists:true，与③的 exists:false
// 区分开——loop 只有对"页面根本没有按钮"才该终止整题；点不动多半是上一轮评测仍在
// 进行，重扫窗口要按平台执行时间量级（默认 150s）给。
//
// 运行：npm test。

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DRY_RUN = '0'; // 保证不是干跑（干跑时 guard 会短路点击）
const { clickByKeywords } = await import('../src/act.mjs');

/** 假 page：覆盖 clickByKeywords / dismissResultPanel 用到的全部接口；waitForTimeout 不真等 */
function makeFakePage({ present = true, failFirstClicks = 0 } = {}) {
  const state = { clicks: 0 };
  const el = {
    isVisible: async () => present,
    click: async () => {
      state.clicks += 1;
      if (state.clicks <= failFirstClicks) throw new Error('intercepts pointer events');
    },
  };
  const loc = { count: async () => (present ? 1 : 0), nth: () => el };
  return {
    state,
    page: {
      getByRole: () => loc,
      getByText: () => loc,
      // dismissResultPanel 会按选择器找结果面板；假 page 一律视为不存在
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      keyboard: { press: async () => {} },
      mouse: { click: async () => {} },
      waitForTimeout: async () => {},
    },
  };
}

test('首轮点击被拦截 → 收起面板后点中，返回 clicked:true', async () => {
  const { page, state } = makeFakePage({ failFirstClicks: 1 });
  const r = await clickByKeywords(page, ['评测'], '评测', { settleMs: 100, settleStepMs: 1 });
  assert.equal(r.clicked, true);
  assert.equal(state.clicks, 2, '第一次被拦截、第二次成功');
});

test('始终点不动 → 在有界窗口内放弃，绝不死循环', async () => {
  const { page, state } = makeFakePage({ failFirstClicks: Number.MAX_SAFE_INTEGER });
  const t0 = Date.now();
  const r = await clickByKeywords(page, ['评测'], '评测', { settleMs: 60, settleStepMs: 1 });
  const elapsed = Date.now() - t0;
  assert.equal(r.clicked, false);
  // 关键契约是"有界终止"：窗口内必须返回（真死循环会挂住测试跑者），且确实尝试过点击。
  // 不锁死点击次数上限——重扫轮数取决于机器速度，锁死会变成脆弱断言。
  assert.ok(elapsed < 1000, `应在窗口内返回，实测 ${elapsed}ms`);
  assert.ok(state.clicks > 0, '应当尝试过点击');
});

test('页面上没有该按钮 → 不点击、直接返回失败', async () => {
  const { page, state } = makeFakePage({ present: false });
  const r = await clickByKeywords(page, ['评测'], '评测', { settleMs: 60, settleStepMs: 1 });
  assert.equal(r.clicked, false);
  assert.equal(r.keyword, null);
  assert.equal(state.clicks, 0);
});

// ---- 1.5.0：exists 语义（2026-09-22 事故：点不动被当成"没有按钮"，整题作废）----

test('按钮存在但点不动 → exists:true，loop 据此改判"评测仍在进行"而非页面结构问题', async () => {
  const { page } = makeFakePage({ failFirstClicks: Number.MAX_SAFE_INTEGER });
  const r = await clickByKeywords(page, ['评测'], '评测', { settleMs: 60, settleStepMs: 1 });
  assert.equal(r.clicked, false);
  assert.equal(r.exists, true);
});

test('按钮不存在 → exists:false 且在 absentGrace 内快速失败（不拖满重扫窗口）', async () => {
  const { page, state } = makeFakePage({ present: false });
  const t0 = Date.now();
  const r = await clickByKeywords(page, ['评测'], '评测', {
    settleMs: 5000,
    settleStepMs: 1000,
    absentGraceMs: 1,
  });
  assert.equal(r.exists, false);
  assert.equal(state.clicks, 0);
  assert.ok(Date.now() - t0 < 1000, '没有按钮就不该等到 settleMs 才返回');
});

test('clickEval 的重扫窗口按平台执行时间量级配置（150s 级），不再 20s 就放弃', async () => {
  const { cfg } = await import('../src/config.mjs');
  assert.ok(
    cfg.loop.evalClickMs >= 120_000,
    `默认应覆盖「本关最大执行时间 120 秒」量级，实际 ${cfg.loop.evalClickMs}ms`,
  );
});

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

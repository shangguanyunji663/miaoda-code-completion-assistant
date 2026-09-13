// 四级挑页链单测（pickTargetPageWithMeta / taskKey）。零新增依赖（node:test）。
//
// 背景：pickTargetPage 曾是「hint 子串 → 第一个非空白页」两档，用户开着
// 「课程列表在前、题目页在后」的 5 个标签页时永远选错页（1.2.0 真机驱动）。
// 现为四级链：hint → TASK_URL_PATTERN 形状 → 内容级 → 第一个非空白页；
// hint / URL 形状层多命中一律报错列出（CDP 下无法识别"用户正在看的标签"，
// 见 TROUBLESHOOTING C-4），绝不静默猜页。
//
// 运行：npm test。假 page 只实现 url()；内容级用例的假 page 额外实现
// mainFrame()/frames() 供 looksLikeTaskPage 的 evaluate 桩。

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTargetPageWithMeta } from '../src/browser.mjs';
import { taskKey, isTaskUrl } from '../src/task-url.mjs';
import { cfg } from '../src/config.mjs';

/** 构造假 page：只需 url()；可选注入 evaluate 桩（内容级用例） */
function fakePage(url, evaluateImpl = null) {
  return {
    url: () => url,
    mainFrame: () => ({ evaluate: evaluateImpl ?? (async () => null) }),
    frames: () => [],
  };
}

const CONTEXT = (...pages) => ({ pages: () => pages });

const LIST_PAGE = 'https://172.22.226.31/users/user_2400960229/classrooms';
const TASK_IP = 'https://172.22.226.31/tasks/XBLSCWNL/4879/fs7w4pziklnc?courseId=XBLSCWNL';
const TASK_NET = 'https://www.educoder.net/tasks/i3o4h5eb/4063351/qgtfsrymv8ce';

test('taskKey/isTaskUrl：eduCoder 官网与校内部署的题目页 URL 均命中', () => {
  assert.ok(isTaskUrl(TASK_IP));
  assert.ok(isTaskUrl(TASK_NET));
  assert.equal(taskKey(TASK_NET), '/tasks/i3o4h5eb/4063351/qgtfsrymv8ce');
});

test('taskKey/isTaskUrl：课程列表页与空白页不命中', () => {
  assert.equal(isTaskUrl(LIST_PAGE), false);
  assert.equal(isTaskUrl('about:blank'), false);
  assert.equal(isTaskUrl(''), false);
  assert.equal(isTaskUrl(null), false);
});

test('taskKey：TASK_URL_PATTERN 改成非法正则时不抛出、按不命中处理', () => {
  const saved = cfg.watch.taskUrlPattern;
  cfg.watch.taskUrlPattern = '/[/'; // 非法正则
  try {
    assert.equal(taskKey(TASK_IP), null);
  } finally {
    cfg.watch.taskUrlPattern = saved;
  }
});

test('Tier 1：hint 唯一命中即选，优先于 URL 形状', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = 'educoder.net';
  try {
    const m = await pickTargetPageWithMeta(CONTEXT(fakePage(LIST_PAGE), fakePage(TASK_NET)));
    assert.equal(m.tier, 'url-hint');
    assert.equal(m.page.url(), TASK_NET);
  } finally {
    cfg.browser.urlHint = saved;
  }
});

test('Tier 1：hint 多命中报错并列出全部，不猜页', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = '/tasks/';
  try {
    await assert.rejects(
      pickTargetPageWithMeta(CONTEXT(fakePage(TASK_IP), fakePage(TASK_NET))),
      /命中了 2 个标签页/,
    );
  } finally {
    cfg.browser.urlHint = saved;
  }
});

test('Tier 1：hint 零命中降级到 URL 形状层（旧版直接抛错）', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = '/exam/';
  try {
    const m = await pickTargetPageWithMeta(CONTEXT(fakePage(LIST_PAGE), fakePage(TASK_IP)));
    assert.equal(m.tier, 'url-pattern');
    assert.equal(m.page.url(), TASK_IP);
  } finally {
    cfg.browser.urlHint = saved;
  }
});

test('Tier 2：hint 留空时按内置题目页 URL 形状识别（课程列表在前也选题目页）', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = '';
  try {
    // 复刻 1.2.0 真机场景：列表页在最前、题目页在后
    const m = await pickTargetPageWithMeta(
      CONTEXT(fakePage(LIST_PAGE), fakePage('about:blank'), fakePage(TASK_IP)),
    );
    assert.equal(m.tier, 'url-pattern');
    assert.equal(m.page.url(), TASK_IP);
  } finally {
    cfg.browser.urlHint = saved;
  }
});

test('Tier 2：URL 形状多命中报错并列出全部', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = '';
  try {
    await assert.rejects(
      pickTargetPageWithMeta(CONTEXT(fakePage(TASK_IP), fakePage(TASK_NET))),
      /发现 2 个题目页标签页/,
    );
  } finally {
    cfg.browser.urlHint = saved;
  }
});

test('Tier 3：URL 全落空时按页面内容特征选中题目页', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = '';
  const savedPattern = cfg.watch.taskUrlPattern;
  cfg.watch.taskUrlPattern = '/zzz-never-match/';
  const taskLike = fakePage(LIST_PAGE, async () => ({
    strongEditor: true,
    evalMarker: false,
    evalButton: false,
  }));
  try {
    const m = await pickTargetPageWithMeta(CONTEXT(fakePage('about:blank'), taskLike));
    assert.equal(m.tier, 'content');
    assert.equal(m.page, taskLike);
    assert.deepEqual(m.candidates, [taskLike]);
  } finally {
    cfg.browser.urlHint = saved;
    cfg.watch.taskUrlPattern = savedPattern;
  }
});

test('Tier 3：内容级探测异常的页面被跳过，不中断挑页', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = '';
  const savedPattern = cfg.watch.taskUrlPattern;
  cfg.watch.taskUrlPattern = '/zzz-never-match/';
  // 无 mainFrame 的假 page：looksLikeTaskPage 调用即抛，等价于标签页崩溃/销毁
  const broken = { url: () => 'https://example.com/broken' };
  const plain = fakePage('https://example.com/plain');
  try {
    // 两页都无题目内容特征 → 走 Tier 4；broken 页在前但没让挑页链崩溃，
    // 证明探测异常被逐页消化（跳过而非中断）
    const m = await pickTargetPageWithMeta(CONTEXT(broken, plain));
    assert.equal(m.tier, 'first-page');
    assert.equal(m.page, broken);
  } finally {
    cfg.browser.urlHint = saved;
    cfg.watch.taskUrlPattern = savedPattern;
  }
});

test('Tier 4：全都不命中时回退到第一个非空白页（历史行为）', async () => {
  const saved = cfg.browser.urlHint;
  cfg.browser.urlHint = '';
  try {
    const m = await pickTargetPageWithMeta(
      CONTEXT(fakePage('about:blank'), fakePage(LIST_PAGE), fakePage('about:blank')),
    );
    assert.equal(m.tier, 'first-page');
    assert.equal(m.page.url(), LIST_PAGE);
  } finally {
    cfg.browser.urlHint = saved;
  }
});

test('没有任何标签页时结构化报错', async () => {
  await assert.rejects(pickTargetPageWithMeta(CONTEXT()), /没有任何打开的标签页/);
});

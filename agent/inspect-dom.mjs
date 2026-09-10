// 只读 DOM 诊断：连接 CDP，扫描所有 page/frame，输出两类信息——
// 1) 关键字命中（恭喜/全部通过/测试结果/下一关等）的元素上下文
//    （tag/class/祖先链/定位方式/可见性），用于精调判定规则；
// 2) /tasks/ 页的评测面板结构（p.test-result 的 class 与 outerHTML、
//    right-panel 文本），用于核对 readEvalPanel 捕获范围。
// 不点击、不修改任何页面状态。用法：node inspect-dom.mjs [CDP_ENDPOINT]
import { chromium } from 'playwright-core';

const CDP = process.argv[2] || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9333';
const KEYS = ['恭喜', '全部通过', '测试结果', '下一关', '评测通过'];

const browser = await chromium.connectOverCDP(CDP);
try {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      for (const f of page.frames()) {
        const isTask = page.url().includes('/tasks/');
        const info = await f
          .evaluate((keys) => {
            const out = { hits: [] };
            if (!document.body) return out;
            // 1) 关键字命中
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const t = walker.currentNode.textContent || '';
              const key = keys.find((k) => t.includes(k));
              if (!key) continue;
              const el = walker.currentNode.parentElement;
              if (!el) continue;
              const chain = [];
              let cur = el;
              for (let d = 0; cur && d < 6; d++) {
                chain.push(
                  `${(cur.tagName || '').toLowerCase()}${cur.className ? '.' + String(cur.className).split(/\s+/).slice(0, 2).join('.') : ''}`,
                );
                cur = cur.parentElement;
              }
              out.hits.push({
                key,
                text: t.trim().replace(/\s+/g, ' ').slice(0, 60),
                tag: el.tagName.toLowerCase(),
                cls: String(el.className || '').slice(0, 80),
                pos: getComputedStyle(el).position,
                rects: el.getClientRects().length,
                chain: chain.join(' < '),
              });
            }
            // 2) 评测面板结构（仅任务页）
            if (new URL(location.href).pathname.startsWith('/tasks/')) {
              const tr = document.querySelector('p.test-result');
              const rp = document.querySelector('section.right-panel');
              out.resultClass = tr ? tr.className : null;
              out.resultHtml = tr ? tr.outerHTML.slice(0, 200) : null;
              out.rightPanelTextLen = rp ? rp.innerText.length : 0;
            }
            return out;
          }, KEYS)
          .catch(() => null);
        if (!info || (!info.hits.length && info.resultClass === undefined)) continue;
        console.log(`\n===== frame: ${f.url().slice(0, 100)}\n----- page: ${page.url().slice(0, 100)}`);
        for (const h of info.hits) console.log(JSON.stringify(h));
        if (info.resultClass !== undefined) {
          console.log(
            JSON.stringify({ resultClass: info.resultClass, resultHtml: info.resultHtml, rightPanelTextLen: info.rightPanelTextLen }),
          );
        }
      }
    }
  }
  console.log('\nDONE');
} finally {
  await browser.close().catch(() => {});
}

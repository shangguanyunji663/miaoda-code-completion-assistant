// CLI 入口：node src/cli.mjs <command>
// 命令：
//   browser  启动带调试端口的 Edge/Chrome（首次使用先跑这个，然后登录评测网站）
//   my-edge  以"你自己的浏览器配置"重启并带调试端口（保留账号/历史，junction 绕过 136+ 限制）
//   probe    检查配置、浏览器连接与页面识别情况
//   dump     导出当前页面结构快照到 agent/dumps/（用于针对站点精调规则）
//   caps-check 手动校验 shared/capabilities/*.json（占位符与 paramsSchema 声明一致性）
//   once     只解当前这一题
//   run      连续解题，成功后自动翻页
//   watch    常驻监听，切到新题目页即自动作答
//   lite     刷新触发模式：刷新题目页即自动重做（含反思修正循环，同一题可反复重做）
//   course   课程自动驾驶：遍历「课堂实验→板块→开始学习」，逐关作答直至板块做完
//   course-probe 只读诊断课程列表页识别结果（不点击），course 卡住时先跑这个
//   models   列出可用文本模型

import { cfg, printConfig, assertAiReady } from './config.mjs';
import { connectBrowser, pickTargetPage } from './browser.mjs';
import {
  probePage,
  dumpProbe,
  collectCards,
  collectSections,
  collectCardCandidates,
  dumpCourseProbe,
} from './perceive.mjs';
import { runLoop, watchLoop, liteLoop, courseLoop } from './loop.mjs';
import { listChatModels } from './ai.mjs';
import { assertCapabilitiesValid } from './capability-schema.mjs';
import { reportCdpPortStartupCheck } from './port-check.mjs';
import { launchBrowser, resolveBrowserPath, launchMyEdge } from './launch-browser.mjs';

const cmd = process.argv[2] ?? 'probe';

async function withPage(fn) {
  const { browser, context } = await connectBrowser();
  try {
    const page = await pickTargetPage(context);
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  switch (cmd) {
    case 'browser': {
      console.log(printConfig());
      const { exe, endpoint, profileDir, version } = await launchBrowser();
      console.log('\n浏览器已启动');
      console.log(`  可执行文件 : ${exe}`);
      console.log(`  调试端口   : ${endpoint}`);
      console.log(`  独立 profile: ${profileDir}`);
      console.log(`  版本       : ${version?.Browser ?? 'unknown'}`);
      console.log('\n请在该浏览器窗口中登录评测网站并打开题目页，然后再执行 npm run probe');
      return;
    }

    case 'my-edge': {
      // 以"你自己的 Edge 配置"重启并带调试端口（junction 绕过 136+ 限制）
      const r = await launchMyEdge();
      console.log('\n端点:', r.endpoint);
      return;
    }

    case 'probe': {
      console.log(printConfig());
      console.log(`\n浏览器可执行文件探测：${resolveBrowserPath()}`);
      assertAiReady();
      await withPage(async (page) => {
        const p = await probePage(page);
        console.log('\n--- 页面识别结果 ---');
        console.log(`URL       : ${p.url}`);
        console.log(`题型      : ${p.taskType}`);
        console.log(`编辑器    : ${p.editor ? `${p.editor.type} (${p.editor.hint})` : '未识别'}`);
        console.log(`代码长度  : ${p.code?.length ?? 0}`);
        console.log(`题干长度  : ${p.problem?.length ?? 0}`);
        console.log(`单选/复选 : ${p.inputs?.radios ?? 0} / ${p.inputs?.checks ?? 0}`);
        console.log(`可点击元素: ${p.clickables?.length ?? 0} 个`);
        console.log('\n--- 题干前 300 字 ---');
        console.log((p.problem || '（空）').slice(0, 300));
        console.log('\n--- 可点击元素（前 20）---');
        for (const c of (p.clickables ?? []).slice(0, 20)) {
          console.log(`  [${c.tag}] ${c.text}`);
        }
      });
      return;
    }

    case 'dump': {
      await withPage(async (page) => {
        const { file, probe } = await dumpProbe(page, 'dump');
        console.log(`快照已导出：${file}`);
        console.log(
          `题型=${probe.taskType} 编辑器=${probe.editor?.type ?? '无'} 题干长度=${probe.problem?.length ?? 0}`,
        );
      });
      return;
    }

    case 'caps-check': {
      // 只读校验能力配置：不连浏览器、不调 AI。编辑 shared/capabilities 后先跑这个
      const n = assertCapabilitiesValid(cfg.paths.capabilitiesDir);
      console.log(`能力配置校验通过：${n} 个文件（prompt 占位符与 paramsSchema 声明一致）`);
      return;
    }

    case 'once': {
      assertAiReady();
      const r = await runLoop({ once: true });
      console.log('\n结果：', JSON.stringify({ total: r.total, solved: r.solved }, null, 2));
      return;
    }

    case 'run': {
      assertAiReady();
      const r = await runLoop({ once: false });
      console.log('\n结果：', JSON.stringify({ total: r.total, solved: r.solved }, null, 2));
      return;
    }

    case 'watch': {
      assertAiReady();
      await reportCdpPortStartupCheck();
      // 常驻运行，不会自行退出；由 SIGINT/SIGTERM 收尾
      await watchLoop();
      return;
    }

    case 'lite': {
      assertAiReady();
      await reportCdpPortStartupCheck();
      // 刷新触发模式：常驻运行；刷新题目页即重做，失败后刷新即可再试
      await liteLoop();
      return;
    }

    case 'course': {
      assertAiReady();
      await reportCdpPortStartupCheck();
      // 课程自动驾驶：需先在该浏览器打开「课堂实验」列表页
      const r = await courseLoop();
      console.log('\n结果：', JSON.stringify(r, null, 2));
      return;
    }

    case 'course-probe': {
      // 只读诊断：只识别、不点击。用于 course 模式卡住时定位识别问题
      await withPage(async (page) => {
        const sections = await collectSections(page);
        const cards = await collectCards(page);
        console.log('\n--- 课程列表页识别结果（只读，未点击任何元素） ---');
        console.log(`URL  : ${page.url()}`);
        console.log(`板块(${sections.length})：${sections.join(' | ') || '（未识别到）'}`);
        console.log(`卡片(${cards.length})：`);
        for (const [i, c] of cards.entries()) {
          const btn = c.btnTag ? `  按钮:<${c.btnTag} class="${c.btnCls}">` : '';
          console.log(`  [${i}] 进度 ${c.done ?? '?'}/${c.total ?? '?'}  ${c.title}${btn}`);
        }
        const { file } = await dumpCourseProbe(page, cards, sections);
        console.log(`\n快照已导出：${file}`);
        if (cards.length === 0) {
          const cands = await collectCardCandidates(page);
          console.log(
            `\n候选节点采样(${cands.length})——text 为 JSON 转义串，可看到图标字体等不可见字符：`,
          );
          for (const c of cands.slice(0, 10)) {
            console.log(`  <${c.tag} class="${c.cls}"> text=${c.text}`);
          }
          console.log('未识别到卡片：请把上面的输出发给开发侧，按真实结构精调识别规则');
        }
      });
      return;
    }

    case 'models': {
      assertAiReady();
      const models = await listChatModels();
      console.log(`可用文本模型 ${models.length} 个：`);
      console.log(models.map((m) => '  ' + m).join('\n'));
      console.log(`\n当前使用：${cfg.ai.model}`);
      return;
    }

    default:
      console.log(`未知命令：${cmd}`);
      console.log(
        '可用：browser | my-edge | probe | dump | caps-check | once | run | watch | lite | course | course-probe | models',
      );
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n错误：${err.message}`);
  process.exitCode = 1;
});

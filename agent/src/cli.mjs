// CLI 入口：node src/cli.mjs <command>
// 命令：
//   browser  启动带调试端口的 Edge/Chrome（首次使用先跑这个，然后登录评测网站）
//   probe    检查配置、浏览器连接与页面识别情况
//   dump     导出当前页面结构快照到 agent/dumps/（用于针对站点精调规则）
//   once     只解当前这一题
//   run      连续解题，成功后自动翻页
//   models   列出可用文本模型

import { cfg, printConfig, assertAiReady } from './config.mjs';
import { connectBrowser, pickTargetPage } from './browser.mjs';
import { probePage, dumpProbe } from './perceive.mjs';
import { runLoop, watchLoop } from './loop.mjs';
import { listChatModels } from './ai.mjs';
import { launchBrowser, resolveBrowserPath } from './launch-browser.mjs';

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
        console.log(`题型=${probe.taskType} 编辑器=${probe.editor?.type ?? '无'} 题干长度=${probe.problem?.length ?? 0}`);
      });
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
      // 常驻运行，不会自行退出；由 SIGINT/SIGTERM 收尾
      await watchLoop();
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
      console.log('可用：browser | probe | dump | once | run | watch | models');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n错误：${err.message}`);
  process.exitCode = 1;
});

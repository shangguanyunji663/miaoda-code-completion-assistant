// 妙答 · 一键启动（1.7.0，零新增依赖）：受控浏览器 + 网页工作台，单进程单窗口。
//
// 与旧手动三步的对应关系（start-my-edge.bat / start-web.bat 均保留可用）：
//   start-my-edge.bat        → 本脚本第 1 步（复用同一个 launchMyEdge）；
//                              **唯一行为差异**：调试端口已经活着时直接复用、
//                              不再关闭重启你的 Edge——日常双击不会反复折腾浏览器
//   start-web.bat            → 本脚本第 2 步（同进程 import web-server.mjs）
//   手动开 127.0.0.1:8787    → 第 3 步自动完成（默认浏览器打开工作台页面）
//
// 失败处置给人话：依赖/密钥缺失 → 指回 install.bat；CDP 起不来 → 指回
// start-my-edge.bat 单独排查（Edge 进程合并类问题见 TROUBLESHOOTING E-4）。
// 工作台端口已被占用（多半是上次的工作台还在）→ 照 web-server 自己的提示办，
// 本脚本直接打开页面收场，不与旧进程抢端口。
//
// 与其余入口一样：本脚本只做编排，不动 agent/src 的任何行为。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cfg } from '../src/config.mjs';
import { launchMyEdge, waitForCdp } from '../src/launch-browser.mjs';
import { isPortListening } from '../src/port-check.mjs';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (s = '') => console.log(s);
const webPort = Number(process.env.WEB_PORT ?? 8787);
const webUrl = `http://127.0.0.1:${webPort}`;

function precheck() {
  if (!fs.existsSync(path.join(agentDir, 'node_modules', 'playwright-core'))) {
    say('[X] 依赖尚未安装。请先双击 install.bat（或手动 npm install）再启动。');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(agentDir, '.env.local'))) {
    say('[X] 尚未配置 AI 密钥。请先双击 install.bat，按提示填三件套。');
    process.exit(1);
  }
}

async function ensureBrowser() {
  const alive = await isPortListening('127.0.0.1', cfg.browser.debugPort, 800);
  if (alive) {
    say(`受控浏览器已在运行（调试端口 ${cfg.browser.debugPort}），直接复用，不重启你的 Edge。`);
    return true;
  }
  say('正在以「你自己的 Edge」重启受控浏览器（3 秒倒计时关闭现有 Edge，登录态保留）……');
  try {
    const r = await launchMyEdge();
    say(`调试端点：${r.endpoint}`);
  } catch (e) {
    say(`[!] 受控浏览器启动失败：${e?.message ?? e}`);
    say('    不影响工作台启动；可稍后单独双击 start-my-edge.bat 重试，');
    say('    或参照 TROUBLESHOOTING E-4（Edge 进程合并）排查。');
    return false;
  }
  try {
    await waitForCdp(cfg.browser.cdpEndpoint, 30000);
    say('受控浏览器就绪 ✓');
    return true;
  } catch {
    say('[!] 30 秒内未等到调试端口。浏览器窗口若没起来，双击 start-my-edge.bat 单独重试；');
    say('    起来了但连不上，参照 TROUBLESHOOTING E-1（Windows 保留端口）。');
    return false;
  }
}

function openWorkbenchWhenReady() {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (await isPortListening('127.0.0.1', webPort, 500)) {
      clearInterval(timer);
      say(`网页工作台已就绪：${webUrl}（正在用默认浏览器打开……）`);
      // 打开默认浏览器：cmd start 的第一个参数是窗口标题占位，URL 单独给
      spawn('cmd.exe', ['/c', 'start', '', webUrl], { detached: true, stdio: 'ignore' })
        .on('error', () => say(`[!] 未能自动打开浏览器——请手动访问 ${webUrl}`))
        .unref();
    } else if (Date.now() - t0 > 15000) {
      clearInterval(timer);
      say(`[!] 工作台端口 ${webPort} 未就绪——请看上方报错（多半是端口被占用）。`);
    }
  }, 500);
}

async function main() {
  say('==========================================');
  say('  妙答 · 一键启动（受控 Edge + 网页工作台）');
  say('==========================================');
  precheck();

  say('\n〔1/2〕受控浏览器');
  await ensureBrowser();

  say('\n〔2/2〕网页工作台');
  if (await isPortListening('127.0.0.1', webPort, 500)) {
    say(`工作台已在运行（${webUrl}）——不再重复启动，直接打开页面。`);
    spawn('cmd.exe', ['/c', 'start', '', webUrl], { detached: true, stdio: 'ignore' })
      .on('error', () => say(`请手动访问 ${webUrl}`))
      .unref();
    say('\n关闭本窗口不影响正在运行的工作台；要彻底停止请到原先那个黑窗口按 Ctrl+C。');
    return;
  }
  say(`将在本窗口启动：${webUrl}（停止 = Ctrl+C 或关闭本窗口）`);
  openWorkbenchWhenReady();
  // web-server.mjs 顶层即监听（start-web.bat 同一入口），import 即启动；
  // EADDRINUSE 时它自带人话提示并退出本进程。
  await import('../src/web-server.mjs');
}

main().catch((e) => {
  console.error(`[X] 启动异常：${e?.message ?? e}`);
  process.exit(1);
});

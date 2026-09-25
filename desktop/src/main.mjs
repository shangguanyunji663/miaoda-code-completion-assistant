// 妙答桌面版 · Electron 主进程（0.1.0）。
//
// 定位：一个「壳」，**不复制、不改动 agent 的任何代码**。它做四件事：
//   ① 首次配置：agent/.env.local 不存在时弹出配置窗口（setup.html），三件套
//      写入文件——分发方预填则此步自动跳过（与分支 A 的向导同一兼容策略）；
//   ② 起服务：用 Electron 自带 Node 以 ELECTRON_RUN_AS_NODE 方式子进程运行
//      agent/src/web-server.mjs（与 start-web.bat 完全同一入口），打包后
//      agent 位于 resources/agent（extraResources，非 asar，普通 Node 可读）；
//   ③ 受控浏览器：CDP 端口已活则复用（不折腾你的 Edge）；否则子进程运行
//      `node src/cli.mjs my-edge`（与 start-my-edge.bat 同一入口）并等待端口；
//   ④ 窗口：加载 http://127.0.0.1:<WEB_PORT> 的网页工作台。关闭窗口 = 隐藏
//      到托盘继续运行（首次有气泡提示），托盘「退出」才真正结束——与旧
//      「黑窗口要保持开着」的心智对齐，又不占任务栏。
//
// 为什么子进程而不是直接 import agent 模块：RUN_AS_NODE 的子进程是普通 Node，
// 不认 asar；agent 放在 extraResources 普通目录里恰好规避这一点，且 agent 的
// 日志/生命周期完全不被 Electron 干扰（agent 代码零改动的硬约束）。
// 图标：BMP 由代码生成（32×32 纯色），不在仓库里放二进制资产。

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, Notification } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = '妙答';
const AGENT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'agent')
  : path.resolve(__dirname, '..', '..', 'agent');
const ENV_FILE = path.join(AGENT_DIR, '.env.local');
const ENV_EXAMPLE = path.join(AGENT_DIR, '.env.example');
const LOG_FILE = path.join(app.getPath('userData'), 'agent-web.log');

const say = (...a) => console.log('[miaoda]', ...a);

/** 极简 .env.local 解析（DEBUG_PORT / WEB_PORT 两个数字键；缺省同 agent） */
function readNumericEnv(key, fallback) {
  try {
    const line = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    const v = line ? Number(line.slice(key.length + 1).trim()) : NaN;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

const debugPort = () => readNumericEnv('DEBUG_PORT', 9333);
const webPort = () => readNumericEnv('WEB_PORT', 8787);
const webUrl = () => `http://127.0.0.1:${webPort()}`;

async function portAlive(port, timeoutMs = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** 32×32 纯色 BMP（Electron nativeImage 可直接解码；免二进制资产） */
function makeIconBmp(size = 32, [r, g, b] = [45, 111, 237]) {
  const rowSize = size * 4;
  const pixels = Buffer.alloc(rowSize * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < 3 || x >= size - 3 || y < 3 || y >= size - 3;
      const inner = x > 9 && x < 22 && y > 9 && y < 22;
      const i = (size - 1 - y) * rowSize + x * 4; // BMP 自底向上
      pixels[i + 3] = 255;
      if (edge) [pixels[i], pixels[i + 1], pixels[i + 2]] = [b, g, r];
      else if (inner) [pixels[i], pixels[i + 1], pixels[i + 2]] = [255, 255, 255];
      else [pixels[i], pixels[i + 1], pixels[i + 2]] = [r, g, b];
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(size, 18);
  header.writeInt32LE(size, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  return Buffer.concat([header, pixels]);
}

// ---- 子进程管理（agent web-server；退出前一并结束） ----
let webChild = null;
const outTail = [];
function recordOut(chunk) {
  const text = String(chunk);
  outTail.push(text);
  if (outTail.length > 40) outTail.shift();
  fs.appendFile(LOG_FILE, text, () => {});
  process.stdout.write(text);
}

function startAgentWeb() {
  say(`启动 agent 工作台（ELECTRON_RUN_AS_NODE）：${AGENT_DIR}\\src\\web-server.mjs`);
  // 入口必须是**单个**相对路径参数——拆成 ['src','web-server.mjs'] 两个参数时，
  // Node 会把 'src' 当入口模块去找，报 MODULE_NOT_FOUND（真机首跑抓到）
  webChild = spawn(process.execPath, ['src/web-server.mjs'], {
    cwd: AGENT_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  webChild.stdout.on('data', recordOut);
  webChild.stderr.on('data', recordOut);
  webChild.on('exit', (code) => {
    say(`agent 工作台进程退出（code=${code}）`);
    webChild = null;
  });
  return webChild;
}

function runAgentCli(args, waitMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.mjs', ...args], {
      cwd: AGENT_DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      process.stdout.write(c);
    });
    child.stderr.on('data', (c) => {
      out += c;
      process.stdout.write(c);
    });
    child.on('exit', () => resolve(out));
    setTimeout(() => resolve(out), waitMs);
  });
}

async function ensureControlledBrowser() {
  if (await portAlive(debugPort())) {
    say(`受控浏览器已在运行（端口 ${debugPort()}），复用，不重启 Edge。`);
    return;
  }
  say('受控浏览器不在——运行 agent 的 my-edge（重启你的 Edge 并带调试端口）……');
  await runAgentCli(['my-edge']);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await portAlive(debugPort())) {
      say(`受控浏览器就绪 ✓（端口 ${debugPort()}）`);
      return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  new Notification({
    title: APP_NAME,
    body: '受控浏览器 45 秒内未就绪。可在网页里点「探测」重试，或单独运行 agent\\start-my-edge.bat。',
  }).show();
}

// ---- 首次配置窗口 ----
function registerIpc() {
  ipcMain.handle('save-config', (_event, cfgObj = {}) => {
    const get = (k) => String(cfgObj[k] ?? '').trim();
    const lines = [
      '# 妙答 AI 配置（本文件等同密码：不外发、不上传、不提交）',
      `AI_BASE_URL=${get('AI_BASE_URL')}`,
      `AI_API_KEY=${get('AI_API_KEY')}`,
      `AI_MODEL=${get('AI_MODEL')}`,
    ];
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
    say('.env.local 已写入（首次配置）');
    return true;
  });
}

async function ensureEnvFile() {
  if (fs.existsSync(ENV_FILE)) return true;
  const win = new BrowserWindow({
    width: 580,
    height: 640,
    resizable: false,
    title: `${APP_NAME} · 首次配置`,
    webPreferences: { preload: path.join(__dirname, 'preload.mjs') },
  });
  await win.loadFile(path.join(__dirname, 'setup.html'));
  // 保存后 setup.html 自己 window.close()；这里以「窗口关闭时 .env.local 是否存在」为准
  const ok = await new Promise((resolve) => {
    win.once('closed', () => resolve(fs.existsSync(ENV_FILE)));
  });
  if (!ok) {
    dialog.showErrorBox(APP_NAME, '未完成 AI 配置，妙答退出。下次启动会再次出现配置窗口。');
  }
  return ok;
}

// ---- 主窗口 + 托盘 ----
let tray = null;
let mainWindow = null;
let quitting = false;
let hideTipShown = false;

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makeIconBmp()));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: () => mainWindow?.show() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => mainWindow?.show());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!hideTipShown) {
      hideTipShown = true;
      new Notification({
        title: APP_NAME,
        body: '妙答仍在运行（受控浏览器与工作台保持可用）。右键托盘图标 → 退出 才会真正结束。',
      }).show();
    }
  });
  return mainWindow;
}

async function loadWithRetry(win, url) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await portAlive(webPort(), 500)) {
      await win.loadURL(url);
      return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---- 生命周期 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => mainWindow?.show());

  app.whenReady().then(async () => {
    registerIpc();
    createTray();

    if (!(await ensureEnvFile())) {
      app.exit(1);
      return;
    }

    startAgentWeb();
    await ensureControlledBrowser();

    const win = createMainWindow();
    const ok = await loadWithRetry(win, webUrl());
    if (!ok) {
      const tail = outTail.join('').slice(-800);
      dialog.showErrorBox(
        APP_NAME,
        `工作台页面加载失败（${webUrl()}）。\n\nagent 输出尾部：\n${tail || '（无输出）'}`,
      );
      app.exit(1);
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    try {
      webChild?.kill();
    } catch {}
  });

  app.on('window-all-closed', () => {
    // 关窗=隐藏到托盘；真正退出走托盘菜单 → before-quit。此处兜底：托盘已销毁时才退出
    if (quitting || !tray) app.quit();
  });
}

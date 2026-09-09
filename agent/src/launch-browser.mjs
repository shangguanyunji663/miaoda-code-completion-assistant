// EXPORTS: resolveBrowserPath, launchBrowser, waitForCdp,
//          getExcludedPortRanges, pickAvailablePort
// 以远程调试模式启动 Edge / Chrome。
//
// 两个已踩过的坑（改动前请先读）：
//
// 坑 1 —— 端口被 Windows 保留，导致 devtools 起不来。
//   现象：浏览器进程正常启动、profile 目录也生成了，但端口死活连不上，
//         Node 侧只能看到 "fetch failed"，毫无头绪。
//   真因：Edge 自身日志里写着
//           bind() returned an error: ... (0x271D)
//           Cannot start http server for devtools.
//         0x271D = WSAEACCESS，即该端口落在 Windows 的 excludedportrange 内
//         （实测本机 9137-9236 被保留，9222 正中区间）。
//   对策：启动前读取 netsh 保留区间，自动顺延到区间外的端口。
//         netsh 输出为范围而非精确值，逐端口比对时必须做区间判断。
//
// 坑 2 —— 进程合并。
//   同 profile 已有实例在跑时，新启动命令会被转交给已有进程，
//   --remote-debugging-port 不生效。因此必须配独立 --user-data-dir。
//   代价：该 profile 是全新的，需重新登录一次，之后登录态持久保存。
//
// 另外：早期版本用 stdio:'ignore' 把浏览器报错全吞了，排查极其困难。
// 现在改为落盘到 agent/logs/browser.log，启动失败时自动打印日志尾部。

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg, AGENT_ROOT } from './config.mjs';

const CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.BROWSER_PATH,
  cfg.browser.browserPath,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const LOG_DIR = path.join(AGENT_ROOT, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'browser.log');

/** 返回本机第一个存在的浏览器可执行文件绝对路径 */
export function resolveBrowserPath() {
  for (const p of CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    '未找到 Edge 或 Chrome。请设置环境变量 EDGE_PATH（或 BROWSER_PATH）指向可执行文件。',
  );
}

/**
 * 读取 Windows 保留端口区间（netsh excludedportrange）
 * @returns {Array<[number, number]>} 闭区间列表
 */
export function getExcludedPortRanges() {
  const ranges = [];
  try {
    // 输出形如 "9137  9236"，表头为本地化文字，故只提取同行内的两个数字
    const out = execSync('netsh interface ipv4 show excludedportrange protocol=tcp', {
      encoding: 'latin1',
      timeout: 8000,
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{1,5})\s+(\d{1,5})\s*$/);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (Number.isFinite(a) && Number.isFinite(b) && a <= b) ranges.push([a, b]);
      }
    }
  } catch {
    // 非 Windows 或 netsh 不可用时，退化为不检测
  }
  return ranges;
}

/**
 * 从 startPort 起找一个不在 Windows 保留区间内的端口
 * @param {number} startPort
 * @param {Array<[number,number]>} ranges
 */
export function pickAvailablePort(startPort, ranges = getExcludedPortRanges()) {
  let port = startPort;
  for (let i = 0; i < 200; i++, port++) {
    const excluded = ranges.some(([a, b]) => port >= a && port <= b);
    if (!excluded) return port;
  }
  return startPort; // 兜底：实在找不到就沿用原端口，让浏览器自己报错
}

function tailLog(n = 25) {
  try {
    if (!fs.existsSync(LOG_PATH)) return '（无日志）';
    const txt = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = txt.trim().split(/\r?\n/);
    return lines.slice(-n).join('\n');
  } catch (e) {
    return `（读取日志失败：${e.message}）`;
  }
}

/** 等待 CDP 端口就绪，返回 /json/version 内容 */
export async function waitForCdp(endpoint, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/json/version`);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `CDP 端口 ${endpoint} 在 ${timeoutMs}ms 内未就绪：${lastErr?.message}。\n` +
      '若浏览器已打开，请确认它是用本脚本启动的（带独立 user-data-dir）。\n' +
      `浏览器日志尾部：\n${tailLog()}`,
  );
}

/**
 * 启动浏览器（独立 profile + 调试端口）
 * @param {{url?: string}} opts
 */
export async function launchBrowser(opts = {}) {
  const exe = resolveBrowserPath();
  const profileDir = opts.userDataDir || cfg.browser.userDataDir;
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  // 避开 Windows 保留端口区间，避免 bind() 报 0x271D
  const preferred = cfg.browser.debugPort;
  const port = pickAvailablePort(preferred);
  if (port !== preferred) {
    console.warn(
      `[launch] 端口 ${preferred} 位于 Windows 保留区间，已自动改用 ${port}`,
    );
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    // 让浏览器自己写日志（start 方式无法 pipe stdio，故交给 Chromium 参数）
    '--enable-logging',
    `--log-file=${LOG_PATH}`,
  ];
  if (opts.profileDirectory) args.push(`--profile-directory=${opts.profileDirectory}`);
  if (opts.url) args.push(opts.url);

  // 坑 3 —— 子进程活不过命令边界。
  //   直接 spawn + detached:true + unref() 时，Edge 在本机实测中会随着 Node 进程
  //   退出而被终止：同一条命令内启动再探测是通的，换个命令再探测就 ECONNREFUSED。
  //   对策（Windows）：借 cmd 内建的 start 启动，使浏览器真正脱离父进程。
  if (process.platform === 'win32') {
    const cmdArgs = [exe, ...args].map((a) => `"${a}"`).join(' ');
    const child = spawn(`start "" ${cmdArgs}`, {
      shell: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
  } else {
    // 非 Windows 下 detached 行为正常，保留 stdio 落盘以便排查
    const fd = fs.openSync(LOG_PATH, 'a');
    const child = spawn(exe, args, { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
  }

  const endpoint = `http://127.0.0.1:${port}`;
  let version;
  try {
    version = await waitForCdp(endpoint);
  } catch (err) {
    throw new Error(`${err.message}\n（浏览器可执行文件：${exe}）`);
  }
  return { exe, profileDir, endpoint, port, version };
}

/**
 * 以「用户自己的浏览器配置」重启浏览器并带上调试端口（my-edge 命令）。
 *
 * 背景：Chromium/Edge 136+ 禁止在默认 user-data-dir 上开调试端口，但校验是
 * 路径比较——建一个指向真实 User Data 的目录联接（junction，无需管理员），
 * 以联接路径启动即可绕过限制：加载的仍是用户原配置（账号/历史/插件全保留）。
 *
 * ⚠️ 必须先关闭正在运行的浏览器实例：同 profile 已有实例时，新启动命令会被
 * 合并进旧进程、端口不生效（见本文件坑 2）。故本流程含 3 秒倒计时 + taskkill。
 *
 * @returns {Promise<object>} launchBrowser 结果 + linkPath / reused
 */
export async function launchMyEdge(opts = {}) {
  const exe = resolveBrowserPath();
  const isEdge = /edge/i.test(exe);
  const appDataLocal =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const realDir = opts.userDataDir
    ? path.resolve(opts.userDataDir)
    : isEdge
      ? path.join(appDataLocal, 'Microsoft', 'Edge', 'User Data')
      : path.join(appDataLocal, 'Google', 'Chrome', 'User Data');
  if (!fs.existsSync(realDir)) {
    throw new Error(`未找到浏览器用户数据目录：${realDir}`);
  }
  const linkPath =
    opts.linkDir ||
    path.join(os.homedir(), isEdge ? '.edge-debug-link' : '.chrome-debug-link');

  // 1. 幂等：调试端口已就绪就直接复用
  const probeEndpoint = `http://127.0.0.1:${cfg.browser.debugPort}`;
  try {
    await waitForCdp(probeEndpoint, 800);
    console.log('[my-edge] 调试浏览器已在运行，直接复用（无需重启）。');
    return { exe, linkPath, endpoint: probeEndpoint, reused: true };
  } catch {
    /* 未在运行，继续 */
  }

  // 2. 倒计时后关闭正在运行的浏览器（否则新命令被旧实例合并）
  const exeName = path.basename(exe);
  console.log(
    `[my-edge] 3 秒后将关闭正在运行的 ${exeName} 并以调试模式重启：` +
      '你的账号/历史/插件全部保留，标签页可由会话恢复。',
  );
  for (let i = 3; i > 0; i--) {
    console.log(`  ${i}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    execSync(`taskkill /IM ${exeName} /F`, { stdio: 'ignore', timeout: 8000 });
  } catch {
    /* 本来就没在运行，忽略 */
  }
  await new Promise((r) => setTimeout(r, 1500));

  // 3. 建目录联接（已存在且指向一致则跳过；realpath 可解析联接到真实目标）
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let needLink = true;
  try {
    const resolved = fs.realpathSync(linkPath);
    needLink = resolved.toLowerCase() !== realDir.toLowerCase();
  } catch {
    needLink = true;
  }
  if (needLink) {
    try {
      fs.rmSync(linkPath, { force: true });
    } catch {
      try {
        fs.rmdirSync(linkPath);
      } catch {
        /* 联接不存在，忽略 */
      }
    }
    fs.symlinkSync(realDir, linkPath, 'junction');
    console.log(`[my-edge] 已创建目录联接：${linkPath} -> ${realDir}`);
  }

  // 4. 以联接路径 + 主 profile（Default）启动
  const r = await launchBrowser({
    userDataDir: linkPath,
    profileDirectory: 'Default',
  });
  console.log('[my-edge] 完成：这就是你平时的浏览器（账号都在），且已带调试端口。');
  console.log('[my-edge] 之后双击 start-watch.bat / start-course.bat 即可接管。');
  console.log(
    '[my-edge] 注意：日常若从任务栏另开 Edge（不带端口），接管前需再运行一次本命令。',
  );
  return { ...r, linkPath };
}

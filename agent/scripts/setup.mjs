// 妙答 · 首次安装向导（1.7.0，零新增依赖）。
//
// 给「不想碰命令行」的同学用：双击 install.bat 跑一次，之后日常只双击桌面
// 「妙答」图标。向导做四件事，每一步幂等（重复运行安全，已做过的自动跳过）：
//   ① Node.js 版本检查（< 18 给出人话指引后退出）；
//   ② node_modules 缺失时自动 npm install（运行时唯一依赖 playwright-core）；
//   ③ AI 三件套配置：.env.local 缺失则从 .env.example 复制；三件套任一为空
//      且终端可交互时逐项询问并写回——分发方预填了配置就整段跳过，两种密钥
//      分发方式（统一提供 / 每人自己的）都兼容；stdin 不可交互（被脚本带管道
//      调用等）时不询问、只报告缺什么，绝不卡死；
//   ④ 在桌面创建「妙答」快捷方式：优先 PowerShell WScript.Shell 生成 .lnk
//     （经 [Environment]::GetFolderPath 解析桌面，兼容 OneDrive 重定向），
//     PowerShell 不可用时退化为在桌面写一个指向 start-miaoda.bat 的 bat。
//
// 测试支持：--dry-run 只打印将做什么、不写任何文件不装任何东西；
// MIAODA_DESKTOP_DIR 可覆盖桌面目录（自动化测试用，绝不污染真实桌面）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin, stdout, exit, env } from 'node:process';

const DRY_RUN = process.argv.includes('--dry-run');
// 本文件在 agent/scripts/ 下，上一级即 agent/（install.bat 与 .env.local 都在这层）。
// 注意不能用 dirname(new URL('..'))——那会再剥一层指到仓库根（dry-run 实测抓到过）。
const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(agentDir, '.env.local');
const envExample = path.join(agentDir, '.env.example');
const KEYS = [
  { key: 'AI_BASE_URL', label: 'AI 端点地址', hint: 'OpenAI 兼容端点，一般以 /v1 结尾，例如 https://xxx.xxx/v1' },
  { key: 'AI_API_KEY', label: 'AI 密钥', hint: '形如 sk-xxxx 的一长串' },
  { key: 'AI_MODEL', label: '模型名', hint: '不确定就先填发你工具的人给的那个' },
];

const say = (s = '') => console.log(s);
const step = (n, msg) => say(`\n〔${n}/4〕${msg}`);

function nodeCheck() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    say(`Node.js ${process.versions.node} ✓`);
    return true;
  }
  say(`[X] 当前 Node.js 版本 ${process.versions.node} 过旧（需要 18+）。`);
  say('    请到 https://nodejs.org 安装 LTS 版本后，重新双击 install.bat。');
  return false;
}

function installDeps() {
  if (fs.existsSync(path.join(agentDir, 'node_modules', 'playwright-core'))) {
    say('依赖已安装（node_modules/playwright-core 在），跳过 npm install。');
    return true;
  }
  if (DRY_RUN) {
    say('[dry-run] 将在此处执行：npm install（约 1~2 分钟）');
    return true;
  }
  say('首次安装依赖，约 1~2 分钟，请耐心等待……');
  const r = spawnSync('npm', ['install'], { cwd: agentDir, stdio: 'inherit', shell: true });
  if (r.status !== 0 || !fs.existsSync(path.join(agentDir, 'node_modules', 'playwright-core'))) {
    say('[X] npm install 没有成功。常见原因：网络不通 / npm 需要换源。');
    say('    可在 agent 目录命令行里手动执行 npm install，把报错截图发给发你工具的人。');
    return false;
  }
  say('依赖安装完成 ✓');
  return true;
}

/** 读 .env.local 为行数组（保留原样），并提供按键取值 / 写值 */
function loadEnvLines() {
  if (!fs.existsSync(envFile)) {
    const template = fs.existsSync(envExample)
      ? fs.readFileSync(envExample, 'utf8')
      : [
          '# 妙答 AI 配置（本文件等同密码：不外发、不上传、不提交）',
          ...KEYS.map((k) => `${k.key}=`),
        ].join('\n');
    return template.split(/\r?\n/);
  }
  return fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
}

const getValue = (lines, key) => {
  const hit = lines.find((l) => l.startsWith(`${key}=`));
  return hit ? hit.slice(key.length + 1).trim() : '';
};

function setValue(lines, key, value) {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  const next = `${key}=${value}`;
  if (i >= 0) lines[i] = next;
  else lines.push(next);
  return lines;
}

async function configureKeys(lines) {
  const missing = KEYS.filter((k) => !getValue(lines, k.key));
  if (!missing.length) {
    say('AI 三件套已配置 ✓（分发方预填或此前已填过，自动跳过询问）');
    return { lines, changed: false };
  }
  const interactive = stdin.isTTY && !DRY_RUN;
  if (!interactive) {
    say(`[!] ${missing.map((k) => k.key).join('、')} 尚未配置。`);
    say('    本次不询问（终端不可交互）。请双击 install.bat 在弹出的窗口里补填，');
    say('    或用记事本打开 agent/.env.local 手动填写后保存。');
    return { lines, changed: false };
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (const k of missing) {
      say('');
      const ans = (
        await rl.question(`请输入${k.label}（${k.hint}）：\n> `)
      ).trim();
      if (ans) setValue(lines, k.key, ans);
    }
  } finally {
    rl.close();
  }
  const still = KEYS.filter((k) => !getValue(lines, k.key));
  if (still.length) {
    say(`[X] 仍有未填项：${still.map((k) => k.key).join('、')}——没有密钥无法做题，可稍后补填再重跑向导。`);
  }
  return { lines, changed: true };
}

function resolveDesktopDir() {
  if (env.MIAODA_DESKTOP_DIR) return env.MIAODA_DESKTOP_DIR;
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return null;
  }
}

function createShortcut() {
  const desktop = resolveDesktopDir();
  if (!desktop || !fs.existsSync(desktop)) {
    say('[!] 未能定位桌面目录（不影响使用）：日常请双击 agent 目录里的 start-miaoda.bat。');
    return;
  }
  const linkPath = path.join(desktop, '妙答.lnk');
  const target = path.join(agentDir, 'start-miaoda.bat');
  if (DRY_RUN) {
    say(`[dry-run] 将在桌面创建快捷方式：${linkPath} → ${target}`);
    return;
  }
  const ps = (cmd) =>
    execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  try {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    ps(
      `$ws = New-Object -ComObject WScript.Shell; ` +
        `$lnk = $ws.CreateShortcut(${q(linkPath)}); ` +
        `$lnk.TargetPath = ${q(target)}; ` +
        `$lnk.WorkingDirectory = ${q(agentDir)}; ` +
        `$lnk.Description = ${q('妙答 · 自动解题（受控 Edge + 网页工作台）')}; ` +
        '$lnk.Save()',
    );
    say(`桌面快捷方式已创建 ✓（${linkPath}）`);
  } catch {
    // PowerShell/COM 不可用的兜底：写一个转发的 bat（内容纯 ASCII，路径原样）
    try {
      const fallback = path.join(desktop, '妙答.bat');
      fs.writeFileSync(fallback, `@echo off\r\ncall "${target}"\r\n`, 'utf8');
      say(`桌面已创建「妙答.bat」✓（PowerShell 不可用，用 bat 兜底）`);
    } catch (e) {
      say(`[!] 快捷方式创建失败（不影响使用）：日常请双击 agent 目录里的 start-miaoda.bat。（${e.message}）`);
    }
  }
}

async function main() {
  say('==========================================');
  say('  妙答 · 首次安装向导' + (DRY_RUN ? '（dry-run 演练，不写任何东西）' : ''));
  say('==========================================');

  step(1, '检查 Node.js');
  if (!nodeCheck()) exit(1);

  step(2, '安装依赖');
  if (!installDeps()) exit(1);

  step(3, '配置 AI 密钥');
  const lines = loadEnvLines();
  let nextLines = lines;
  let changed = false;
  if (DRY_RUN) {
    const missing = KEYS.filter((k) => !getValue(lines, k.key));
    say(
      `[dry-run] .env.local ${fs.existsSync(envFile) ? '已存在' : '缺失（将从 .env.example 复制）'}；` +
        (missing.length ? `将在交互窗口询问：${missing.map((k) => k.key).join('、')}` : '三件套齐全，跳过询问'),
    );
  } else {
    ({ lines: nextLines, changed } = await configureKeys(lines));
    if (changed) {
      fs.writeFileSync(envFile, nextLines.join('\n'), 'utf8');
      say(`已写入 ${envFile}`);
      const key = getValue(nextLines, 'AI_API_KEY');
      if (key) say(`（密钥 ${key.slice(0, 5)}…${key.slice(-4)} 已保存；此文件等同密码，勿外发）`);
    }
  }

  step(4, '创建桌面快捷方式');
  createShortcut();

  say('\n==========================================');
  say('安装完成！以后每天只有一步：');
  say('  双击桌面「妙答」→ 自动起受控 Edge + 网页工作台');
  say('  然后在受控 Edge 里登录评测平台、打开题目页，');
  say('  回到自动弹出的网页里点「探测页面 / 解当前题」。');
  say('遇到报错：把黑窗口里的内容截图发给发你工具的人。');
  say('==========================================');
}

main().catch((e) => {
  console.error(`[X] 向导异常：${e?.message ?? e}`);
  exit(1);
});

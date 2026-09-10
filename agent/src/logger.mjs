// EXPORTS: createLogger
// 统一日志层：替代此前 act / ai / loop / perceive 四处各自定义的 log。
//
// 设计：
//   - 控制台输出保持原有 `[scope] msg` 形态，不改变使用者已有的阅读习惯
//   - 同时落盘到 agent/logs/agent-<日期>.log，带完整时间戳与级别，供事后复盘
//   - 落盘失败只降级不中断：日志系统绝不能让主流程崩溃
//
// 此前常驻模式（watch / lite）跑完关掉终端窗口日志即丢失，而排查方法论
// （见 docs/TROUBLESHOOTING.md）恰恰依赖事后回溯，故这里是必需基建。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');

const pad = (n) => String(n).padStart(2, '0');

function fullStamp(d) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 落盘开关：LOG_TO_FILE=0 关闭。默认开启。
const TO_FILE = (process.env.LOG_TO_FILE ?? '1') !== '0';

// 目录创建与写句柄状态。懒初始化——模块被 import 时不产生任何副作用。
let dirReady = false;
let fileBroken = false;
let currentDay = '';
let stream = null;

function ensureStream(day) {
  if (fileBroken) return null;
  try {
    if (!dirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      dirReady = true;
    }
    if (!stream || day !== currentDay) {
      if (stream) stream.end();
      stream = fs.createWriteStream(path.join(LOG_DIR, `agent-${day}.log`), {
        flags: 'a',
        encoding: 'utf8',
      });
      // 流错误只降级，不抛出——主流程不应被日志拖垮
      stream.on('error', () => {
        fileBroken = true;
      });
      currentDay = day;
    }
    return stream;
  } catch {
    fileBroken = true;
    return null;
  }
}

/**
 * 创建一个带作用域的 logger。
 * 返回的函数可直接调用（INFO 级），也挂了 .warn / .error。
 * @param {string} scope 模块名，如 'loop'
 */
export function createLogger(scope) {
  const emit = (level, msg) => {
    const d = new Date();
    const text = String(msg ?? '');
    const prefix = level === 'INFO' ? `[${scope}]` : `[${scope}] [${level}]`;
    console.log(`${prefix} ${text}`);
    if (!TO_FILE) return;
    const s = ensureStream(dayKey(d));
    if (s) s.write(`${fullStamp(d)} ${level} [${scope}] ${text}\n`);
  };

  const log = (msg) => emit('INFO', msg);
  log.warn = (msg) => emit('WARN', msg);
  log.error = (msg) => emit('ERROR', msg);
  return log;
}

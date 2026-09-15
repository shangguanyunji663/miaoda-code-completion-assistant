// EXPORTS: cfg, loadEnv, AI_DEFAULTS
// 配置层：优先读 agent/.env.local，其次读进程环境变量。
// 注意：.env.local 含密钥，已在 .gitignore 中排除，禁止提交。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(AGENT_ROOT, '.env.local');

/** 极简 .env 解析：KEY=VALUE，忽略 # 注释与空行 */
export function loadEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = loadEnv();

function pick(key, fallback = undefined) {
  return process.env[key] ?? env[key] ?? fallback;
}

function pickNum(key, fallback) {
  const v = pick(key);
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const AI_DEFAULTS = {
  // 端点与模型不设默认值：这些是部署相关的个人配置，统一放 .env.local，
  // 避免任何个人信息随源码进入版本库（安全要求，见 docs/TROUBLESHOOTING.md）。
  baseUrl: '',
  // 模型留空时由 ai.mjs 报错提示配置；实测记录（2026-09-08）：
  // agnes-2.0-flash 走 chat/completions 正常约 3.4s；qwen3.8-flash-free 可用约 10.8s；
  // deepseek-v4-flash-0731-free-2 当时 502 不可用。模型可用性随时变化，用 npm run models 实测。
  model: '',
  temperature: 0.3,
  maxTokens: 32768,
  // 单次 AI 请求超时（毫秒）。推理模型思考+生成可达数分钟，默认 5 分钟兜底：
  // 端点挂起时请求按失败处理并重试，而不是整个 loop 永久停摆
  //（实测表现即"切完 tab 后毫无动作、再无任何日志"）。
  timeoutMs: 300000,
};

// 默认不用 9222：实测该机 Windows 把 9137-9236 划为保留端口区间，
// Edge bind() 会失败并报 0x271D(WSAEACCESS)。9333 在保留区间之外。
// 即便如此，launch-browser 仍会做一次保留区间检测并自动顺延。
const DEBUG_PORT = pickNum('DEBUG_PORT', 9333);

// 题目页 URL 形状默认正则：/tasks/<courseId>/<数字>/<串>。
// eduCoder 官网（www.educoder.net）与校内部署（如 172.22.226.31）的题目页同构。
// watch / lite 识别与 pickTargetPage 自动挑页共用这一个旋钮（TASK_URL_PATTERN）。
export const DEFAULT_TASK_URL_PATTERN = '/tasks/[^/]+/\\d+/[A-Za-z0-9]+';

export const cfg = {
  ai: {
    baseUrl: pick('AI_BASE_URL', AI_DEFAULTS.baseUrl),
    apiKey: pick('AI_API_KEY', ''),
    model: pick('AI_MODEL', AI_DEFAULTS.model),
    temperature: pickNum('AI_TEMPERATURE', AI_DEFAULTS.temperature),
    maxTokens: pickNum('AI_MAX_TOKENS', AI_DEFAULTS.maxTokens),
    // 推理分级（v0.8.1 探测实证）：off → 漏多步要求；default → 思考马拉松
    // 击穿预算；medium → 思考 1612 字有界且命令完整。可调 low/medium/high
    reasoningEffort: pick('AI_REASONING_EFFORT', 'medium'),
    // 思考全关开关（极简任务用，默认开思考走分级）
    enableThinking: pick('AI_ENABLE_THINKING', '1') === '1',
    timeoutMs: pickNum('AI_TIMEOUT_MS', AI_DEFAULTS.timeoutMs),
    // 思考停滞检测（毫秒）：流式响应中"正文仍 0 字、思考长度连续这么久无
    // 新增"即视为空转/卡死，提前断流重试（0 = 禁用）。对应 2026-09-15 实测
    // 事故：AI 对题干信号矛盾反复"重新审视"，思考 2362 字后 60s~120s 完全
    // 停滞，纯时间硬闸只能傻等满 120s。停滞检测只掐"无进展"，不误伤正常
    // 深思考（正常思考会持续增长）。
    thinkingStallMs: pickNum('AI_THINKING_STALL_MS', 45000),
    // 思考字数配额（字）：流式响应中"正文仍 0 字、思考累计达到该字数"即强制
    // 断流重试（0 = 禁用）。端点兼容模型的 max_tokens 是思考+正文共享预算，
    // 弱推理模型会无限思考直到烧光预算（2026-09-15 实测思考 40986 字正文 0、
    // finish_reason=length），喂多少都不收敛——这是"产品层强制思考有界"，
    // 与商用 Agent 的思考预算分账对齐：思考到线即收，正文留足预算。
    thinkingMaxChars: pickNum('AI_THINKING_MAX_CHARS', 24000),
    // 首轮（首次生成）是否开思考：AI_FIRST_PASS_THINKING=1 开（默认关）。
    // 时间优先策略（2026-09-15）：大多数题首轮无需思考，关思考 5~10s 出初稿
    // 最快；只有失败后的反思轮才动用 high 思考档一次修对。
    firstPassThinking: pick('AI_FIRST_PASS_THINKING', '0') === '1',
    // 思考硬闸（毫秒）：流式响应中"仍在思考、正文 0 字"持续超过该时长即
    // 主动断流，重试强制关思考（双通道 enable_thinking）。0 = 不设限。
    // 兜底场景：端点忽略思考开关、推理模型对简单反思题穷举假设拖到数分钟。
    // 默认 120s（2026-09-15 时间优先调优）：目标是最短时间通过而非省 token，
    // high 档正常思考常达 60~120s，120s 内放行，真马拉松仍被拦（5 分钟请求
    // 超时兜底终局）。
    thinkingCapMs: pickNum('AI_THINKING_CAP_MS', 120000),
  },
  browser: {
    // 连接用户已登录的浏览器（Edge / Chrome），需以 --remote-debugging-port 启动
    cdpEndpoint: pick('CDP_ENDPOINT', `http://127.0.0.1:${DEBUG_PORT}`),
    debugPort: DEBUG_PORT,
    // 浏览器可执行文件；留空则自动探测 Edge -> Chrome
    browserPath: pick('EDGE_PATH', pick('BROWSER_PATH', '')),
    // 独立 profile 目录。必须与日常使用的 profile 隔离，否则调试端口不生效
    userDataDir: pick('USER_DATA_DIR', path.join(AGENT_ROOT, '.browser-profile')),
    // 目标页面 URL 匹配片段，用于从多个标签页中挑出评测页
    urlHint: pick('TARGET_URL_HINT', ''),
    // 连不上调试端口时自动拉起浏览器（独立 profile）。0 = 关闭
    autoLaunch: pick('AUTO_LAUNCH', '1') === '1',
  },
  // ---- 常驻监听（watch）模式 ----
  // 程序持续运行，检测用户切换到的新题目页并自动作答；只做题、不翻页，
  // 导航权始终留给用户。
  watch: {
    // 轮询间隔
    pollMs: pickNum('WATCH_POLL_MS', 2000),
    // 题目页 URL 正则。默认匹配形如 /tasks/<courseId>/<num>/<slug> 的路径
    taskUrlPattern: pick('TASK_URL_PATTERN', DEFAULT_TASK_URL_PATTERN),
    // 等待题目区渲染完成的超时
    readyTimeoutMs: pickNum('READY_TIMEOUT_MS', 15000),
  },
  loop: {
    // 单题最大反思重试次数（用户指定 10；注意失败题最坏耗时与 token 消耗随重试线性放大）
    maxRetry: pickNum('MAX_RETRY', 10),
    // 等待评测结果的最长时间（毫秒）
    evalTimeoutMs: pickNum('EVAL_TIMEOUT_MS', 25000),
    // 每题之间的间隔（毫秒），避免触发平台风控
    cooldownMs: pickNum('COOLDOWN_MS', 1500),
    // 连续解题数量上限，0 表示不限
    maxTasks: pickNum('MAX_TASKS', 0),
    // 干跑模式：只感知与生成，不写入、不点击
    dryRun: pick('DRY_RUN', '0') === '1',
  },
  // ---- 终端键入（命令行题） ----
  terminal: {
    // 每字符键入延迟：xterm 真实键盘输入，10ms 对逐字符处理已足够稳
    typeDelayMs: pickNum('TERMINAL_TYPE_DELAY_MS', 10),
    // 自适应命令间隔：回车后轮询终端提示符返回即下一条（快命令 ~200ms 放行）；
    // 输出仍在滚动就继续等，上限防前台阻塞类命令（如未 fork 的 mongod）卡死节奏
    gapMinMs: pickNum('TERMINAL_GAP_MIN_MS', 200),
    gapMaxMs: pickNum('TERMINAL_GAP_MAX_MS', 2500),
  },
  // ---- 课程自动驾驶（course）模式 ----
  // 遍历「课堂实验 → 板块 → 开始学习」，逐关作答；评测通过后点「下一关」，
  // 点击后 URL/关卡序号无变化即判定本小板块做完，退出并回列表继续下一块。
  course: {
    // 点击「下一关」后等待跳转的最长时间
    navTimeoutMs: pickNum('NAV_TIMEOUT_MS', 10000),
    // 退出/返回后等待列表页重新出现的最长时间
    listTimeoutMs: pickNum('LIST_TIMEOUT_MS', 15000),
    // 单板块最多连续处理的卡片数（防呆上限）
    maxBoardsPerSection: pickNum('MAX_BOARDS_PER_SECTION', 50),
  },
  paths: {
    agentRoot: AGENT_ROOT,
    // prompt 单一数据源：复用仓库根 shared/capabilities 下的配置
    capabilitiesDir: path.resolve(AGENT_ROOT, '..', 'shared', 'capabilities'),
    dumpDir: path.join(AGENT_ROOT, 'dumps'),
  },
};

export function assertAiReady() {
  if (!cfg.ai.baseUrl) {
    throw new Error(
      `缺少 AI_BASE_URL 配置。请在 ${ENV_FILE} 中设置，例如：AI_BASE_URL=https://your-openai-compatible-endpoint/v1`,
    );
  }
  if (!cfg.ai.apiKey) {
    throw new Error(`缺少 AI_API_KEY。请在 ${ENV_FILE} 中配置，或设置环境变量 AI_API_KEY。`);
  }
}

export function printConfig() {
  const masked = cfg.ai.apiKey
    ? `${cfg.ai.apiKey.slice(0, 6)}...${cfg.ai.apiKey.slice(-4)}`
    : '(未配置)';
  return [
    `AI_BASE_URL      = ${cfg.ai.baseUrl || '(未配置)'}`,
    `AI_MODEL         = ${cfg.ai.model || '(未配置)'}`,
    `AI_API_KEY       = ${masked}`,
    `AI_TEMPERATURE   = ${cfg.ai.temperature}`,
    `CDP_ENDPOINT     = ${cfg.browser.cdpEndpoint}`,
    `TARGET_URL_HINT  = ${cfg.browser.urlHint || '(未配置，自动按 TASK_URL_PATTERN 识别题目页)'}`,
    `TASK_URL_PATTERN = ${cfg.watch.taskUrlPattern}`,
    `MAX_RETRY        = ${cfg.loop.maxRetry}`,
    `DRY_RUN          = ${cfg.loop.dryRun ? 'yes' : 'no'}`,
  ].join('\n');
}

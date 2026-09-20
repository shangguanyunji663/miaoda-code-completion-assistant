// EXPORTS: StopRequested, beginRun, endRun, requestStop, checkStop, isStopping,
//          onStop, stopState
// 运行控制层：为「一次解题」（solveOnce）提供可被人工打断的运行态与停止信号。
//
// 背景（2026-09-20）：反思重试上限由 MAX_RETRY 控制（默认 10），但单轮耗时可达
// 数分钟（推理模型思考 + 评测等待 25s），最坏情况一次解题可挂十几分钟；「评测一直
// 不通过」时每一轮都在烧 token 却看不到收敛。网页工作台需要一个人工制动闸：
// 点一下就停——不再提交下一次评测、不再发起下一次 AI 调用。
//
// 设计要点：
//   1. 轮次隔离（运行序号规则）。停止请求记住"它发出时正在跑的是第几轮"，
//      只有当前运行轮次等于该序号时才生效。这样"点停止的同时又点了新解题"
//      不会让新任务被上一轮的停止请求误杀，也不会让停止被新任务静默吞掉
//      （不用时间戳比较：同毫秒内先后发生的事件无法靠时间区分）。
//   2. 检查点是唯一中断手段。不依赖 Promise 取消——playwright 的页面调用无法
//      安全取消，强行中断会留下半写入的编辑器/半键入的终端。checkStop 只做
//      一件事：标志对本轮生效就抛 StopRequested。把检查点埋在「阶段边界 +
//      每轮重试开头 + 每个长等待的轮询循环内」，即可保证在"当前步骤结束时"
//      退出，而不是干等到 MAX_RETRY 耗尽。
//   3. onStop 订阅。给在途的 AI 流式请求用：信号一到就 abort 掉 fetch，
//      一次可长达 120s 的思考不必等自然结束。

/** 手动停止信号：由 checkStop 在检查点抛出，沿异步链冒泡到调用方 */
export class StopRequested extends Error {
  /**
   * @param {string} [message] 人类可读的中断点描述（会出现在日志与工作台响应里）
   * @param {string} [stage] 中断时的阶段名（不含修饰语，便于程序化使用）
   */
  constructor(message = '已被手动停止', stage = '') {
    super(message);
    this.name = 'StopRequested';
    // 供跨模块判定（不依赖 instanceof，避免多实例/打包场景失效）
    this.isStopRequested = true;
    this.stage = stage;
  }
}

let runSeq = 0; // 运行轮次序号：每次 beginRun 自增（第 0 轮表示尚未开始过）
let running = false;
let startedAt = 0; // 本轮起点（毫秒时间戳，供 UI 展示已运行时长）
let stopped = false; // 是否收到过停止请求
let stopRunSeq = -1; // 停止请求针对的运行轮次（-1 = 尚未收到过）
let stopReason = '';
let phase = '空闲'; // 人类可读的当前阶段，随检查点推进
const listeners = new Set(); // onStop 订阅者（在途 AI 请求的 abort 钩子）

/** 停止标志对本轮是否生效（轮次隔离的唯一判据） */
function stopAppliesHere() {
  return stopped && stopRunSeq === runSeq && runSeq > 0;
}

/**
 * 开始一轮运行。所有会打断流程的入口（solveOnce / 循环体）都应先调用它，
 * 使停止标志与运行轮次对齐。
 * @param {string} [label] 起始阶段描述
 * @returns {number} 本轮运行序号
 */
export function beginRun(label = '运行中') {
  runSeq += 1;
  running = true;
  startedAt = Date.now();
  phase = label;
  // 上一轮的停止请求不跨轮生效（stopAppliesHere 的序号判据已能拦住，
  // 这里同时清标志，使 stopState() 对外的展示与内部判据一致）
  stopped = false;
  stopRunSeq = -1;
  stopReason = '';
  return runSeq;
}

/** 结束一轮运行（成功、失败、被停止都要走这里，保证运行态不悬空） */
export function endRun() {
  running = false;
  phase = '空闲';
  // 同时清停止标志：否则任务结束后 /api/status 仍会声称"正在停止"，
  // 且 stopState() 的 stopping 判据（依赖本轮序号）会与实际脱节
  stopped = false;
  stopRunSeq = -1;
  stopReason = '';
}

/** 直接设置当前阶段（不想顺带做停止检查时用） */
export function setPhase(p) {
  phase = String(p ?? '') || '运行中';
}

/**
 * 检查点：若停止请求对本轮生效则抛出 StopRequested。
 * 这是全链路唯一的中断出口——阶段边界与长等待轮询里都调用它。
 * @param {string} [stage] 当前阶段描述；传入时同时刷新运行态展示的阶段
 */
export function checkStop(stage) {
  if (stage) phase = stage;
  if (!stopAppliesHere()) return;
  const where = stage || phase;
  throw new StopRequested(`已手动停止，中断于「${where}」阶段`, where);
}

/** 是否已请求停止且对本轮生效（供不影响控制流的场景只读判断） */
export function isStopping() {
  return stopAppliesHere();
}

/**
 * 订阅停止事件，返回取消订阅函数。
 * 订阅者异常被吞掉——停止流程本身绝不能因某个钩子失败而中断。
 * @param {(reason: string) => void} fn
 * @returns {() => void}
 */
export function onStop(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 请求停止当前运行。
 * 注意：无运行中任务时调用同样会记录标志，但不会影响后续运行（轮次序号不匹配）。
 * 调用方（/api/stop）应先查 running，避免给用户"点了停止其实没停"的错误反馈。
 * @param {string} [reason] 停止原因，写入日志与响应体
 */
export function requestStop(reason = '用户在网页工作台点击「停止做题」') {
  stopped = true;
  stopRunSeq = runSeq; // 记住针对哪一轮——只对这一轮生效
  stopReason = reason;
  for (const fn of listeners) {
    try {
      fn(reason);
    } catch {
      /* 订阅者异常不影响停止流程 */
    }
  }
  return stopState();
}

/** 运行态快照：供 /api/status 展示"是否在跑、跑到哪一步、停了多久" */
export function stopState() {
  const active = stopAppliesHere();
  return {
    running,
    runSeq,
    phase,
    // stopping=true 表示"停止请求已生效、正在收尾"——UI 据此把按钮变灰并提示等待
    stopping: active && running,
    startedAt: startedAt || null,
    runningMs: running ? Date.now() - startedAt : 0,
    stopReason: active ? stopReason : null,
  };
}

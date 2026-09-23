// 终端键入期的「输入期报错」窗口计算（2026-09-23 C-19）。
// 背景：原先拿 `.xterm-rows` 的**行数**当游标（`lines.slice(prevCount)`），而可见行是滑动窗口——
// 首次调用 prevCount=0 ⇒ 窗口 = 整屏历史（上一轮遗留的报错冒充"命令 1 报错"），
// 屏幕滚满后行数不再增长 ⇒ 第 2 条起窗口恒为空（永远检不出东西）。
// 真机账单：全部日志 18 次「输入期报错」无一例外归到"命令 1"。这里用几条贴近真机的快照钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { newTerminalLines } from '../src/act.mjs';

// 贴近真机的快照 fixture：屏幕满、且上一轮的报错还停在可见区
const PROMPT = 'root@e8f1c2:/home/example# ';
const prev = [
  `${PROMPT}mongoexport --type csv -o /home/test1.csv`,
  `${PROMPT}python3 /tmp/fix.py`,
  'IndentationError: expected an indented block',
  PROMPT,
];
// 下一条命令执行完：窗口整体上移 1 行，尾部追加 3 行
const now = [
  `${PROMPT}python3 /tmp/fix.py`,
  'IndentationError: expected an indented block',
  `${PROMPT}cat /home/test1.csv`,
  '_id,name,age,sex,major',
  PROMPT,
];

test('滚动满屏后仍能取到新增行（旧实现的行数游标在这里恒为空）', () => {
  assert.deepEqual(newTerminalLines(prev, now), [
    `${PROMPT}cat /home/test1.csv`,
    '_id,name,age,sex,major',
    PROMPT,
  ]);
});

test('回归（C-19）：上一轮遗留在屏幕上的报错不得算进本轮命令的窗口', () => {
  // 旧实现的两种失真，写在这里当"反面证据"：
  // 首次调用（prevCount=0）→ 整屏，遗留报错被算进"命令 1 报错"（误报 + 归因错）
  assert.equal(
    now.slice(0).some((l) => /IndentationError/.test(l)),
    true,
    '前提：该报错确实还在屏幕上',
  );
  // 同一次调用里第二条命令（prevCount=行数）→ 空窗口（漏报）
  assert.deepEqual(now.slice(prev.length), [PROMPT], '旧实现只会看到最后一行提示符');
  // 新实现：两边都不失真
  const delta = newTerminalLines(prev, now);
  assert.equal(
    delta.some((l) => /IndentationError/.test(l)),
    false,
    '遗留报错不能出现在本条命令的窗口里',
  );
  assert.equal(
    delta.some((l) => l.includes('cat /home/test1.csv')),
    true,
  );
});

test('未滚动（屏幕未满）时等价于"取尾部新增"', () => {
  assert.deepEqual(newTerminalLines(['a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'd']);
});

test('无变化返回空数组（同一条命令的输出不会被重复计一次）', () => {
  assert.deepEqual(newTerminalLines(['a', 'b', 'c'], ['a', 'b', 'c']), []);
});

test('整屏被刷掉（无重叠）保守返回本次全部行', () => {
  // 一条命令的输出把整个可见区刷走时，可见内容确实主要由它产生
  assert.deepEqual(newTerminalLines(['a', 'b', 'c'], ['x', 'y', 'z']), ['x', 'y', 'z']);
});

test('首次快照（基线为空）返回本次全部行', () => {
  assert.deepEqual(newTerminalLines([], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(newTerminalLines(undefined, ['a']), ['a']);
});

test('逐行推进多次滚动：每次只吐当次新增（模拟连续键入多条命令）', () => {
  let snapshot = ['l1', 'l2', 'l3'];
  const seen = [];
  for (const add of [['l4'], ['l5', 'l6'], ['l7']]) {
    const next = [...snapshot.slice(add.length), ...add];
    seen.push(...newTerminalLines(snapshot, next));
    snapshot = next;
  }
  assert.deepEqual(seen, ['l4', 'l5', 'l6', 'l7']);
});

// 命令序列解析（parseCommandLines）：围栏剥离必须是**逐行**的。
// 真机账单（2026-09-23 15:14-15:15，混合题数据准备）：模型按小节输出多组 ``` 围栏，
// 旧实现只剥首尾，段间围栏被当成命令**键入真实终端**——日志实录「命令 5: ```」
// 「命令 6: ```bash」，随后 mongo 报 `SyntaxError: unterminated string literal @(shell):1:2`，
// 两轮数据准备全灭（导入从未成功）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLines } from '../src/ai.mjs';

test('段间围栏被剔除（真机形态：多组围栏 + 文字小节混排）', () => {
  const out = parseCommandLines(
    [
      '```bash',
      'mkdir -p /data/test',
      '```',
      '第二步：导入数据',
      '```bash',
      'mongoimport --db mydb2 --collection test --file /home/example/person.json',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(out, [
    'mkdir -p /data/test',
    '第二步：导入数据',
    'mongoimport --db mydb2 --collection test --file /home/example/person.json',
  ]);
  assert.equal(
    out.some((l) => l.includes('```')),
    false,
    '任何围栏行都不许留下（它们会被逐条键入终端）',
  );
});

test('首尾围栏照旧剥掉，带语言名的也剥', () => {
  assert.deepEqual(parseCommandLines('```sh\nls -l\n```'), ['ls -l']);
  assert.deepEqual(parseCommandLines('```\nls -l\n```'), ['ls -l']);
});

test('围栏不误伤正文：含反引号的普通命令原样保留', () => {
  const out = parseCommandLines("echo `date`\ncat > f <<'EOF'\n  key: value\nEOF");
  assert.equal(out[0], 'echo `date`');
  // heredoc 正文的缩进必须保留（写 YAML 时缩进即语法）
  assert.equal(out[2], '  key: value');
});

test('注释行与提示符行的既有行为不变', () => {
  const out = parseCommandLines('# 注释\n// 注释\nroot@a:~# ls\n$ pwd');
  assert.deepEqual(out, ['ls', 'pwd']);
});

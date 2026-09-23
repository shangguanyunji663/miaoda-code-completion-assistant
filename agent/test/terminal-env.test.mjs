// 终端环境识别（2026-09-23）：等待就绪的日志措辞 + unknown 描述的三态区分。
// 钉死的理由：真机上 `终端环境识别：unknown` 这条日志原先只打 kind，说不出是"终端还没内容"
// （切标签后 xterm 可见 ≠ 提示符已打印）还是"有回显但提示符形态不认"（命令仍在跑 / 输入未
// 闭合）——两种的处置完全相反（前者该等，后者不该等）。诊断能力本身就是修复的一部分，
// 与 C-16 同一条纪律：静默失效必须可见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTerminalWait, unknownEnvDesc } from '../src/perceive.mjs';

test('首次采样即识别成功：日志不加任何修饰（零额外开销路径）', () => {
  assert.equal(describeTerminalWait('bash', 'root@a:/# ', { waitedMs: 120, attempts: 1 }), '');
});

test('等待若干轮后才识别：日志带等待时长与采样次数', () => {
  const s = describeTerminalWait('bash', '', { waitedMs: 2400, attempts: 4 });
  assert.match(s, /等待 2\.4s \/ 4 次采样/);
  assert.match(s, /识别/);
});

test('超时且终端无回显：结论指向"会话未就绪"，不得写成"形态不认"', () => {
  const s = describeTerminalWait('unknown', '', { waitedMs: 15000, attempts: 19 });
  assert.match(s, /未识别/);
  assert.match(s, /无回显/);
  assert.doesNotMatch(s, /形态不认/);
  assert.match(s, /15\.0s \/ 19 次采样/);
});

test('超时但有回显：结论指向"提示符形态不认"并带末行（两种 unknown 据此分开）', () => {
  const s = describeTerminalWait('unknown', 'root@a:/home/example$ ', {
    waitedMs: 15000,
    attempts: 19,
  });
  assert.match(s, /有回显但提示符形态不认/);
  assert.doesNotMatch(s, /无回显/);
});

test('未等待的调用点（反思前）如实写"单次采样"，不谎称等过', () => {
  const s = describeTerminalWait('unknown', '>', {});
  assert.match(s, /单次采样/);
  assert.doesNotMatch(s, /等待/);
});

test('末行只截尾 40 字符：日志不被超长回显刷屏', () => {
  const long = 'x'.repeat(200);
  const s = describeTerminalWait('unknown', long, {});
  assert.equal(s.includes('x'.repeat(41)), false);
  assert.equal(s.includes('x'.repeat(40)), true);
});

test('unknown 描述：有末行 ⇒ 带末行原文 + 明确禁止贸然 exit（bash 里 exit 会关掉会话）', () => {
  const withEcho = unknownEnvDesc('root@a:/# ');
  assert.match(withEcho, /最后一行/);
  assert.match(withEcho, /exit/);
  assert.match(withEcho, /不要贸然/);
});

test('unknown 描述：无回显 ⇒ 直接给 bash 基线动作，不提"最后一行"', () => {
  const empty = unknownEnvDesc('');
  assert.match(empty, /暂无回显/);
  assert.match(empty, /建立会话/);
  assert.doesNotMatch(empty, /最后一行/);
});

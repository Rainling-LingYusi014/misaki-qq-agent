/* ── 低信息量消息的「回不回」抽签（2026-10-28 主人定规）────────────────────────
 *
 * 主人原话：「misaki 可以直接不回啊，不回复是被允许的」——同时明确不能一律不回，
 * 所以做成骰子。这个测试钉住三件事：
 *   ① 什么算"低信息量"：owo / 纯表情 / 单字 / 纯贴纸图片 → 是；
 *      「我回来了」「在吗」「你看这个？」「谢谢老板」→ 不是（这些是在说话/在问，照常回）；
 *   ② 骰子本身：p=0 从不沉默、p=1 总是沉默、p=0.5 按 roll 分界，且非低信息量时永远不沉默；
 *   ③ 边界：空文本无图不算（不是"沉默"的理由）、带文件不算。
 *
 * 跑法：cd qq-bridge && node tests/short-reply-dice.test.js
 */
import assert from 'node:assert/strict';
import { isLowInfoIncoming, shortReplyDecision } from '../src/lib/short-reply-dice.js';

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const low = (text, extra = {}) => isLowInfoIncoming({ text, ...extra });
const dec = (a) => shortReplyDecision(a);

console.log('=== ① 低信息量判定 ===');
t('ow o / owo 算低信息量（带空格也认）', () => {
  assert.equal(low('ow o'), true);
  assert.equal(low('owo'), true);
  assert.equal(low('OWO'), true);
});
t('纯表情算低信息量', () => {
  assert.equal(low('😂'), true);
  assert.equal(low('🥺🥺'), true);
  assert.equal(low('❤️'), true);
});
t('单字与应声算低信息量', () => {
  assert.equal(low('嗯'), true);
  assert.equal(low('好'), true);
  assert.equal(low('啊'), true);
  assert.equal(low('嗯嗯'), true);
  assert.equal(low('哈哈哈'), true);
  assert.equal(low('收到'), true);
  assert.equal(low('ok'), true);
});
t('纯贴纸/图片（无文本，只有媒体）算低信息量', () => {
  assert.equal(isLowInfoIncoming({ text: '', hasMedia: true }), true);
});
t('正文是占位符的纯表情包也算（[表情] / [动画表情] / [图片]）', () => {
  assert.equal(low('[表情]'), true);
  assert.equal(low('[动画表情]'), true);
  assert.equal(low('[图片]'), true);
  assert.equal(low('哈哈哈[表情]'), true);
});
t('「我回来了」不算（是在说话，照常回）', () => {
  assert.equal(low('我回来了'), false);
});
t('「在吗」「你看这个？」「好吗」不算（在问）', () => {
  assert.equal(low('在吗'), false);
  assert.equal(low('你看这个？'), false);
  assert.equal(low('好吗'), false);
  assert.equal(low('？'), false);
});
t('「谢谢老板」不算（有具体内容）', () => {
  assert.equal(low('谢谢老板'), false);
});
t('文件/文档不算（要回应）', () => {
  assert.equal(isLowInfoIncoming({ text: '嗯', hasFile: true }), false);
  assert.equal(isLowInfoIncoming({ text: '', hasMedia: true, hasFile: true }), false);
});
t('空文本且无图不算（空消息不是沉默的理由）', () => {
  assert.equal(isLowInfoIncoming({ text: '' }), false);
  assert.equal(isLowInfoIncoming({}), false);
});

console.log('\n=== ② 骰子 ===');
t('低信息量 + p=0 → 从不沉默（主人想全回时）', () => {
  for (const r of [0, 0.1, 0.5, 0.999]) {
    assert.equal(dec({ text: 'owo', probability: 0, rng: () => r }).silent, false);
  }
});
t('低信息量 + p=1 → 总是沉默', () => {
  for (const r of [0, 0.1, 0.5, 0.999]) {
    assert.equal(dec({ text: 'owo', probability: 1, rng: () => r }).silent, true);
  }
});
t('低信息量 + p=0.5 → roll 低于 p 沉默、高于 p 回', () => {
  assert.equal(dec({ text: '嗯', probability: 0.5, rng: () => 0.2 }).silent, true);
  assert.equal(dec({ text: '嗯', probability: 0.5, rng: () => 0.7 }).silent, false);
});
t('非低信息量 → 永远不沉默（哪怕 roll=0 / p=1）', () => {
  const d = dec({ text: '我回来了', probability: 1, rng: () => 0 });
  assert.equal(d.lowInfo, false);
  assert.equal(d.silent, false);
});
t('默认参数（不传 probability）按 0.5 走', () => {
  const d = dec({ text: 'owo', rng: () => 0.2 });
  assert.equal(d.p, 0.5);
  assert.equal(d.silent, true);
});
t('roll 越界/NaN 被夹住，不抛异常', () => {
  assert.equal(dec({ text: 'owo', probability: 0.5, rng: () => 1.5 }).silent, false);
  assert.equal(dec({ text: 'owo', probability: 0.5, rng: () => -3 }).silent, true);
  const d = dec({ text: 'owo', probability: 0.5, rng: () => Number.NaN });
  assert.equal(d.roll, 0);
});
t('返回值带 lowInfo/p/roll，便于正文如实报出', () => {
  const d = dec({ text: 'owo', probability: 0.5, rng: () => 0.42 });
  assert.equal(d.lowInfo, true);
  assert.equal(d.p, 0.5);
  assert.equal(d.roll, 0.42);
});

console.log('\n=== ③ [Dice] 行注入（wake-send 侧）===');
const { shortReplyDiceLine, initWakeCore } = await import('../src/core/wake-send.js');
const P = 'private:11111111';
const stWith = (text, extra = {}) => ({
  unread: [{ isSelf: false, time: Date.now(), text, ...extra }],
  recentMessages: [],
});

t('配置关掉 → 不注入', () => {
  initWakeCore({ social: { shortReply: { enabled: false } } });
  assert.equal(shortReplyDiceLine(stWith('owo'), P), '');
});
t('群聊不注入（群聊交给模型自己判断）', () => {
  initWakeCore({ social: { shortReply: { enabled: true, silenceProbability: 0.5 } } });
  assert.equal(shortReplyDiceLine(stWith('owo'), 'group:22222222'), '');
});
t('owner 私聊默认豁免', () => {
  initWakeCore({ ownerQQ: 11111111, social: { shortReply: { enabled: true, silenceProbability: 0.5 } } });
  assert.equal(shortReplyDiceLine(stWith('owo'), P), '');
});
t('owner 私聊 applyToOwner=true 时照掷', () => {
  initWakeCore({ ownerQQ: 11111111, social: { shortReply: { enabled: true, silenceProbability: 0.5, applyToOwner: true } } });
  assert.match(shortReplyDiceLine(stWith('owo'), P), /\[Dice\] low-info message/);
});
t('非 owner 私聊 + owo → 出现 [Dice] 行，且两个结论之一', () => {
  initWakeCore({ ownerQQ: 999, social: { shortReply: { enabled: true, silenceProbability: 0.5 } } });
  const line = shortReplyDiceLine(stWith('owo'), P);
  assert.match(line, /^\[Dice\] low-info message .*roll=\d\.\d\d p=0\.5: (SILENT|REPLY)/);
});
t('非 owner 私聊 + 正常句子 → 一行都不加', () => {
  initWakeCore({ ownerQQ: 999, social: { shortReply: { enabled: true, silenceProbability: 0.5 } } });
  assert.equal(shortReplyDiceLine(stWith('今天下班好晚，累死了'), P), '');
});
t('没有 unread 时看最近窗口（10 分钟内的对方消息）', () => {
  initWakeCore({ ownerQQ: 999, social: { shortReply: { enabled: true, silenceProbability: 0.5 } } });
  const st = { unread: [], recentMessages: [{ isSelf: false, time: Date.now() - 60000, text: '嗯' }] };
  assert.match(shortReplyDiceLine(st, P), /\[Dice\]/);
});
t('最近窗口里只有自己说的话 → 不注入', () => {
  initWakeCore({ ownerQQ: 999, social: { shortReply: { enabled: true, silenceProbability: 0.5 } } });
  const st = { unread: [], recentMessages: [{ isSelf: true, time: Date.now() - 60000, text: '嗯' }] };
  assert.equal(shortReplyDiceLine(st, P), '');
});

console.log(`\nshort-reply-dice: ${pass}/${pass + failures.length} 通过`);
process.exit(failures.length ? 1 : 0);

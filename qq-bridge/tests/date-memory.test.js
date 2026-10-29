// 回归测试：日期型记忆的解析与浮现（2026-10-28 主人需求）
//
// 需求原话：「misaki 对三天内的事情不会忘记，或者出现幻觉乱说。比如说三天以后是生日，
//            生日当天用户如果问起他不应该答不出来。」
// 关键判据：日期解析要对（含"没写年份 + 每年循环"的生日）、窗口要对（昨天~未来 7 天）。
// 用法：node tests/date-memory.test.js
import assert from 'node:assert/strict';
import { parseMemoryDate, dateTip, dateDigestItem, extractDateHints } from '../src/lib/date-memory.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const NOW = Date.parse('2026-10-28T20:00:00+08:00');   // 周三

console.log('== 日期解析 ==');

t('「11-01 生日」→ 每年循环，还有 4 天', () => {
  const ev = parseMemoryDate({ content: '一只萌王 11-01 生日', now: NOW });
  assert.equal(ev.month, 11); assert.equal(ev.day, 1);
  assert.equal(ev.yearly, true);
  assert.equal(ev.daysUntil, 4);
});

t('「11月3日面试」→ 今年，还有 6 天，不算年循环', () => {
  const ev = parseMemoryDate({ content: '小林 11月3日 面试', now: NOW });
  assert.equal(ev.daysUntil, 6);
  assert.equal(ev.yearly, false);
});

t('明确年份「2026-11-01 交报告」→ 一次性事件', () => {
  const ev = parseMemoryDate({ content: '2026-11-01 交报告', now: NOW });
  assert.equal(ev.explicitYear, true);
  assert.equal(ev.daysUntil, 4);
});

t('年循环生日今年已过 → 算到明年（不报负数）', () => {
  const ev = parseMemoryDate({ content: '生日 10-01', now: NOW });
  assert.equal(ev.yearly, true);
  assert.ok(ev.daysUntil > 300, `应滚到明年，实得 ${ev.daysUntil}`);
});

t('tags 里的 date: 优先于正文', () => {
  const ev = parseMemoryDate({ content: '见面', tags: 'date:2026-11-02', now: NOW });
  assert.equal(ev.daysUntil, 5);
});

t('非法日期不解析（2 月 30 日）', () => {
  assert.equal(parseMemoryDate({ content: '2026-02-30 聚会', now: NOW }), null);
});

t('没有日期 → null', () => {
  assert.equal(parseMemoryDate({ content: '她喜欢喝美式', now: NOW }), null);
});

console.log('== 浮现窗口 ==');

t('昨天的事件仍在窗口内（-1 天）', () => {
  const it = dateDigestItem('10-27 面试', { now: NOW });
  assert.ok(it, '应浮现');
  assert.equal(it.daysUntil, -1);
  assert.equal(it.tip, '昨天');
});

t('8 天以后的事件不浮现（窗口 7 天）', () => {
  assert.equal(dateDigestItem('11-05 考试', { now: NOW }), null);
});

t('格式：MM-DD + 人话 tip', () => {
  const it = dateDigestItem('一只萌王 11-01 生日', { now: NOW });
  assert.equal(it.dateText, '11-01');
  assert.equal(it.tip, '还有 4 天');
  assert.equal(dateTip(0), '今天'); assert.equal(dateTip(1), '明天'); assert.equal(dateTip(2), '后天');
});

t('规则条目里的日期不算事件（「2026-10-27 要求：…」不该进 [Dates]）', () => {
  assert.equal(dateDigestItem('主人 2026-10-27 要求：单条回复保持简短', { category: 'rule', now: NOW }), null);
  assert.equal(dateDigestItem('2026-10-28 教：表情包不能已读不回', { category: 'rule', now: NOW }), null);
});

console.log('== 轮换前的落盘提示 ==');

t('只扫对方的话，命中日期+事件词才提示，最多 3 条', () => {
  const msgs = [
    { isSelf: true, text: '我 11-03 有个面试' },
    { isSelf: false, text: '我 11-03 有个面试' },
    { isSelf: false, text: '下周三 11-04 要答辩' },
    { isSelf: false, text: '今天天气不错' },
    { isSelf: false, text: '12-25 生日' },
    { isSelf: false, text: '01-01 纪念日' },
  ];
  const hints = extractDateHints(msgs, { limit: 3 });
  assert.equal(hints.length, 3);
  assert.ok(hints[0].includes('11-03'));
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

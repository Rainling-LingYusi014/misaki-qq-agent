// 回归测试：常规模式「每天保底一次主动关心」的窗口判定（2026-10-28 主人定规）
//
// 需求原话：「常规模式做一天至少一次的主动关心，陪伴模式保持不变。」
// 判据（lib/proactive-window.js 纯函数）：今天没主动过 + 在保底窗口内 + 对方今天没说过话。
// 用法：node tests/proactive-daily-min.test.js
import assert from 'node:assert/strict';
import { dailyMinDue, dailyMinCfg } from '../src/lib/proactive-window.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

// 北京时间今天 0 点（测试只需要一个稳定的"今天零点"）
const todayStart = Date.parse('2026-10-28T00:00:00+08:00');
const yesterday = todayStart - 3600 * 1000;
const base = {
  usedToday: 0, nowMin: 20 * 60, windowStartMin: 19 * 60, windowEndMin: 22 * 60 + 30,
  lastIncomingAt: yesterday, todayStartMs: todayStart, dailyMin: 1,
};

console.log('== 每日保底判定 ==');

t('窗口内 + 今天没主动过 + 对方今天没说话 → 到期', () => {
  assert.equal(dailyMinDue(base), true);
});

t('今天已经主动过一次 → 不重复', () => {
  assert.equal(dailyMinDue({ ...base, usedToday: 1 }), false);
});

t('还没到窗口（18:59）→ 不叫', () => {
  assert.equal(dailyMinDue({ ...base, nowMin: 18 * 60 + 59 }), false);
});

t('过了窗口（22:30）→ 不再补', () => {
  assert.equal(dailyMinDue({ ...base, nowMin: 22 * 60 + 30 }), false);
});

t('对方今天说过话 → 不需要"关心"（刚聊完不硬塞一句）', () => {
  assert.equal(dailyMinDue({ ...base, lastIncomingAt: todayStart + 3600 * 1000 }), false);
});

t('对方昨天说的 → 今天仍然到期', () => {
  assert.equal(dailyMinDue({ ...base, lastIncomingAt: yesterday }), true);
});

t('privateDailyMin=0 → 关闭保底', () => {
  assert.equal(dailyMinDue({ ...base, dailyMin: 0 }), false);
});

t('跨午夜的窗口也能判（23:00–01:00）', () => {
  assert.equal(dailyMinDue({ ...base, nowMin: 23 * 60 + 30, windowStartMin: 23 * 60, windowEndMin: 60 }), true);
  assert.equal(dailyMinDue({ ...base, nowMin: 30, windowStartMin: 23 * 60, windowEndMin: 60 }), true);
  assert.equal(dailyMinDue({ ...base, nowMin: 12 * 60, windowStartMin: 23 * 60, windowEndMin: 60 }), false);
});

t('配置解析：字符串时间 → 分钟；缺省回落 19:00–22:30 / 每天 1 次', () => {
  const c = dailyMinCfg({})
  assert.deepEqual(c, { dailyMin: 1, windowStartMin: 19 * 60, windowEndMin: 22 * 60 + 30 });
  const c2 = dailyMinCfg({ privateDailyMin: 2, dailyMinWindowStart: '20:15', dailyMinWindowEnd: '23:00' });
  assert.deepEqual(c2, { dailyMin: 2, windowStartMin: 20 * 60 + 15, windowEndMin: 23 * 60 });
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

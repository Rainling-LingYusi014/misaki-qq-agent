// 周计划发说说调度（2026-10-26 用户定规）：
// ① 概率：pickWeeklyCount(0.6) 大样本约 60% 出 2
// ② 窗口：pickWeeklyFireTime 产出的时刻永不在北京 01:00~06:59
// ③ 间隔：minAfter 约束生效（不早于前次+gap）
// ④ 周界：产出时刻不晚于 weekEnd
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWeeklyCount, pickWeeklyFireTime } from '../src/core/qzone.js';

const BJ = 8 * 3600 * 1000;
const bjHour = (ts) => new Date(Number(ts) + BJ).getUTCHours();

test('周计划：60% 概率分布（大样本 5000 次，容差 ±5%）', () => {
  let two = 0;
  for (let i = 0; i < 5000; i++) if (pickWeeklyCount(0.6) === 2) two++;
  const ratio = two / 5000;
  assert.ok(ratio > 0.55 && ratio < 0.65, `两次占比 ${ratio}`);
});

test('周计划：发帖时刻永远避开北京 01:00~06:59', () => {
  // 取一周内多个起点各掷多次，任何产出时刻的小时不得落在 1-6
  const base = Date.UTC(2026, 9, 26, 0, 0, 0); // 2026-10-26 00:00 UTC
  for (let k = 0; k < 60; k++) {
    const now = base + k * 3600 * 1000 * 3;
    for (let j = 0; j < 20; j++) {
      const t = pickWeeklyFireTime(now, { minLeadMs: 3600 * 1000, maxLeadMs: 36 * 3600 * 1000 });
      const h = bjHour(t);
      assert.ok(!(h >= 1 && h < 7), `产出时刻落深夜窗 bjHour=${h}`);
      assert.ok(t > now, '产出必须晚于 now');
    }
  }
});

test('周计划：间隔约束（minAfter）与周界（weekEnd）生效', () => {
  const now = Date.UTC(2026, 9, 26, 10, 0, 0);
  const minAfter = now + 20 * 3600 * 1000;
  const weekEnd = now + 5 * 24 * 3600 * 1000;
  for (let j = 0; j < 100; j++) {
    const t = pickWeeklyFireTime(now, { minAfter, weekEnd, minLeadMs: 3600 * 1000, maxLeadMs: 7 * 24 * 3600 * 1000 });
    assert.ok(t >= minAfter, '不得早于 minAfter（间隔保证）');
    assert.ok(t <= weekEnd, '不得晚于 weekEnd（本周内）');
    const h = bjHour(t);
    assert.ok(!(h >= 1 && h < 7), `深夜窗 bjHour=${h}`);
  }
});

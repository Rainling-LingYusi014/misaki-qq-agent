// 回归测试：早安问候（2026-10-29 主人定规）
//
// 规则原话：「每天7~8点，8~9点主动向列表内的好友用户问早安。这两个时间段的概率分别为33%和67%，
// 然而时间段内的具体某一时刻则随机」+「每天必然问早安」+「如果已经有人先一步发起了询问早安，
// 后来再发一次就会显得相当奇怪」+「把静默窗口也跟随调整，调到7点」。
//
// 守六件事：
//   ① 确定性 —— 同 会话+日期 永远同一时刻（重启重算一致 = 不重发不漏账的根基）；
//   ② 窗口边界 —— 时刻落在自己被掷中的窗口内（北京时间）；
//   ③ 33/67 分布 —— 大样本下窗口1占比贴 0.33；
//   ④ 到点判定 —— 问过/对方先开口/正聊着 都不发，干净才发；
//   ⑤ 跨日翻篇 —— 明天的时刻严格晚于今天，且换日换骰；
//   ⑥ 静默窗 —— 陪伴静默默认提前到 07:00 后，07:05 已可主动、06:55 仍静默。
//
// 纯函数直测，不碰真实 state。用法：node tests/morning-greet.test.js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { fails += 1; console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const lib = await import(pathToFileURL(path.join(here, '..', 'src', 'lib', 'morning-greet.js')).href);
const companion = await import(pathToFileURL(path.join(here, '..', 'src', 'core', 'companion-mode.js')).href);

check('① 确定性：同 会话+日期 100 次重算同一时刻，跨会话不串', () => {
  const p1 = lib.morningGreetPlan({ key: 'private:10001', dateKey: '2026-10-29' });
  for (let i = 0; i < 100; i++) {
    const p = lib.morningGreetPlan({ key: 'private:10001', dateKey: '2026-10-29' });
    assert.equal(p.atMs, p1.atMs);
    assert.equal(p.windowIndex, p1.windowIndex);
  }
  const others = new Set();
  for (let uid = 10002; uid < 10052; uid++) {
    others.add(lib.morningGreetPlan({ key: `private:${uid}`, dateKey: '2026-10-29' }).atMs);
  }
  assert.ok(others.size > 25, `50 个会话应散在不同时刻，实际只有 ${others.size} 种`);
});

check('② 窗口边界：时刻落在被掷中的窗口内（北京 7~9 点之间）', () => {
  for (let uid = 20000; uid < 20200; uid++) {
    const p = lib.morningGreetPlan({ key: `private:${uid}`, dateKey: '2026-10-29' });
    const dayStart = Date.parse('2026-10-29T00:00:00+08:00');
    const off = p.atMs - dayStart;
    assert.ok(off > 0 && off < 24 * 3600 * 1000, '必须落在当天');
    const bjMin = Math.floor(off / 60000);
    if (p.windowIndex === 1) assert.ok(bjMin >= 420 && bjMin < 480, `窗口1 应在 07:00–08:00，实际 ${bjMin}min`);
    else assert.ok(bjMin >= 480 && bjMin < 540, `窗口2 应在 08:00–09:00，实际 ${bjMin}min`);
  }
});

check('③ 33/67 分布：400 个会话里窗口1占比贴 0.33（±8 个点）', () => {
  let w1 = 0;
  const N = 400;
  for (let uid = 30000; uid < 30000 + N; uid++) {
    if (lib.morningGreetPlan({ key: `private:${uid}`, dateKey: '2026-10-29' }).windowIndex === 1) w1++;
  }
  const ratio = w1 / N;
  assert.ok(ratio > 0.25 && ratio < 0.41, `窗口1 占比应贴 0.33，实际 ${ratio.toFixed(3)}`);
});

check('③b 概率可配：p1=0 恒落窗口2，p1=1 恒落窗口1', () => {
  for (let uid = 40000; uid < 40040; uid++) {
    assert.equal(lib.morningGreetPlan({ key: `private:${uid}`, dateKey: '2026-10-29', p1: 0 }).windowIndex, 2);
    assert.equal(lib.morningGreetPlan({ key: `private:${uid}`, dateKey: '2026-10-29', p1: 1 }).windowIndex, 1);
  }
});

check('④ 到点判定：问过/对方先开口/正聊着都不发，干净才发', () => {
  const dayStart = Date.parse('2026-10-29T00:00:00+08:00');
  const base = { dateKey: '2026-10-29', dayStartMs: dayStart };
  assert.equal(lib.morningGreetDecision({ ...base, greetedDay: '2026-10-29' }).fire, false);
  assert.equal(lib.morningGreetDecision({ ...base, lastIncomingAt: dayStart - 1 }).fire, true, '昨天说的话不算今天搭上话');
  assert.equal(lib.morningGreetDecision({ ...base, lastIncomingAt: dayStart + 60000 }).fire, false, '今天先开口 → 不补发');
  assert.equal(lib.morningGreetDecision({ ...base, busy: true }).fire, false);
  assert.equal(lib.morningGreetDecision(base).fire, true);
});

check('⑤ 跨日翻篇：明天的时刻严格晚于今天 +12h，且换日换骰', () => {
  const today = lib.morningGreetPlan({ key: 'private:50001', dateKey: '2026-10-29' });
  const tomorrow = lib.morningGreetPlan({ key: 'private:50001', dateKey: '2026-10-30' });
  assert.ok(tomorrow.atMs > today.atMs + 12 * 3600 * 1000, '明天的早安必须落在明天');
});

check('⑥ 静默窗提前到 07:00：06:55 仍静默，07:05 已放开', () => {
  assert.equal(companion.inCompanionQuietHours(Date.parse('2026-10-29T06:55:00+08:00'), null), true);
  assert.equal(companion.inCompanionQuietHours(Date.parse('2026-10-29T07:05:00+08:00'), null), false);
  assert.equal(companion.inCompanionQuietHours(Date.parse('2026-10-29T23:35:00+08:00'), null), true);
});

check('⑦ 配置归一：脏值回落默认，不抛异常', () => {
  const bad = lib.morningGreetCfg({ p1: 'abc', window1: ['9:00', '8:00'], window2: 'x' });
  assert.equal(bad.p1, lib.MORNING_GREET_DEFAULTS.p1);
  assert.deepEqual(bad.window1, [420, 480]);
  assert.deepEqual(bad.window2, [480, 540]);
  const clamp = lib.morningGreetCfg({ p1: 5 });
  assert.equal(clamp.p1, 1);
  const custom = lib.morningGreetCfg({ p1: 0.5, window1: ['06:30', '07:30'] });
  assert.deepEqual(custom.window1, [390, 450]);
});

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);

// 回归测试：拍一拍的开口策略（2026-10-28 主人定规）
//
// 需求原话：「除非被一连拍了两下，或者在 10 分钟内被拍了三下的情况做一次询问，
//            不要每次被拍就问，这会让人觉得很奇怪，仿佛 misaki 很敏感不好接触。」
// 判据在 lib/poke-policy.js（纯函数）。
// 用法：node tests/poke-policy.test.js
import assert from 'node:assert/strict';
import { pokeAskDecision, pokeBackDecision } from '../src/lib/poke-policy.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const T = 1793180000000;   // 任意基准时刻

console.log('== 拍一拍开口策略 ==');

t('单拍 → 不开口', () => {
  assert.deepEqual(pokeAskDecision({ history: [T], now: T }), { ask: false, why: 'single' });
});

t('一连两下（15 秒内，考虑 QQ 自身 10 秒冷却）→ 问一次', () => {
  // 真实客户端最快的第二下大约在 10~12 秒后；6 秒窗口永远命中不了（主人 2026-10-28 指出）
  assert.deepEqual(pokeAskDecision({ history: [T - 10500, T], now: T }), { ask: true, why: 'double-tap' });
  assert.deepEqual(pokeAskDecision({ history: [T - 3000, T], now: T }), { ask: true, why: 'double-tap' });
});

t('两下但隔了 16 秒以上 → 不算"一连"，不问', () => {
  assert.deepEqual(pokeAskDecision({ history: [T - 16000, T], now: T }), { ask: false, why: 'slow-burst' });
  assert.deepEqual(pokeAskDecision({ history: [T - 30000, T], now: T }), { ask: false, why: 'slow-burst' });
});

t('10 分钟内三下（散着拍）→ 问一次', () => {
  const h = [T - 8 * 60 * 1000, T - 4 * 60 * 1000, T];
  assert.deepEqual(pokeAskDecision({ history: h, now: T }), { ask: true, why: 'triple-10m' });
});

t('十分钟前的旧拍不计数', () => {
  const h = [T - 11 * 60 * 1000, T - 9 * 60 * 1000, T];
  assert.equal(pokeAskDecision({ history: h, now: T }).ask, false, '只剩两下且间隔 9 分钟 → 不该问');
});

t('问过一次后的连拍 → 冷却期内不再问', () => {
  const h = [T, T + 3000];
  const d = pokeAskDecision({ history: h, now: T + 3000, lastAskedAt: T });
  assert.deepEqual(d, { ask: false, why: 'cooldown' });
});

t('问过 11 分钟后再连拍 → 仍在 30 分钟冷却里，不问', () => {
  const last = T - 11 * 60 * 1000;
  const d = pokeAskDecision({ history: [T - 2000, T], now: T, lastAskedAt: last });
  assert.deepEqual(d, { ask: false, why: 'cooldown' });
});

t('冷却结束后（31 分钟）再被连拍两次 → 重新问', () => {
  const last = T - 31 * 60 * 1000;
  const d = pokeAskDecision({ history: [T - 2000, T], now: T, lastAskedAt: last });
  assert.equal(d.ask, true);
});

t('阈值可配（count=4 → 三下不问，四下问；间隔都在双拍窗口外）', () => {
  const h3 = [T - 40000, T - 25000, T];
  assert.equal(pokeAskDecision({ history: h3, now: T, count: 4 }).ask, false);
  const h4 = [T - 55000, ...h3].sort((a, b) => a - b);
  assert.equal(pokeAskDecision({ history: h4, now: T, count: 4 }).ask, true);
});

console.log('\n== 回拍（被拍之后 50% 概率回一下，纯动作）==');

t('默认 p=0.5：roll 0.2 → 回拍', () => {
  const d = pokeBackDecision({ now: T, rng: () => 0.2 });
  assert.equal(d.back, true);
  assert.equal(d.p, 0.5);
  assert.equal(d.why, 'dice-hit');
});

t('默认 p=0.5：roll 0.7 → 不回拍', () => {
  const d = pokeBackDecision({ now: T, rng: () => 0.7 });
  assert.equal(d.back, false);
  assert.equal(d.why, 'dice-miss');
});

t('p=0 → 永不回拍（关掉）', () => {
  const d = pokeBackDecision({ now: T, probability: 0, rng: () => 0 });
  assert.equal(d.back, false);
  assert.equal(d.why, 'off');
});

t('p=1 → 一定回拍', () => {
  const d = pokeBackDecision({ now: T, probability: 1, rng: () => 0.999 });
  assert.equal(d.back, true);
});

t('回拍冷却内（5 分钟前刚回过）→ 不再回，哪怕骰子命中', () => {
  const d = pokeBackDecision({ now: T, lastBackAt: T - 5 * 60 * 1000, probability: 1, rng: () => 0 });
  assert.equal(d.back, false);
  assert.equal(d.why, 'cooldown');
});

t('冷却过期（31 分钟前）→ 重新掷骰', () => {
  const d = pokeBackDecision({ now: T, lastBackAt: T - 31 * 60 * 1000, probability: 1, rng: () => 0.3 });
  assert.equal(d.back, true);
  assert.equal(d.why, 'dice-hit');
});

t('冷却时间可配（10 分钟冷却 → 11 分钟后放行）', () => {
  const d = pokeBackDecision({ now: T, lastBackAt: T - 11 * 60 * 1000, cooldownMs: 10 * 60 * 1000, probability: 1, rng: () => 0 });
  assert.equal(d.back, true);
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

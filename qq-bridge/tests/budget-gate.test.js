// 预算闸门回归（2026-10-25 审计 P2-1 修复）：
// 1) 不配置 = 不限额（现状兼容）
// 2) 每会话日预算：用量超限 → ok:false
// 3) 全局日预算：任一会话触发
// 4) 两级并存：报告"更紧的那个"
// 数据面走真实路径：写 token-usage.jsonl → initTokenMeter 回填 → convDaySums/days 聚合。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initTokenMeter, setTokenBudgetCfg, checkTokenBudget, meterTokenFrame } from '../src/core/token-meter.js';

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
}

test('预算闸门：未配置 = 一律放行', () => {
  const dir = tmpStateDir();
  initTokenMeter({ stateDir: dir });
  setTokenBudgetCfg(null);
  const r = checkTokenBudget('private:123');
  assert.equal(r.ok, true);
  assert.equal(r.limit, 0);
});

test('预算闸门：每会话日预算超限拒绝，其他会话不受影响', () => {
  const dir = tmpStateDir();
  initTokenMeter({ stateDir: dir, convKeyResolver: () => 'private:123' });
  setTokenBudgetCfg({ dailyPerConv: 100 });
  // 一条真实 usage：prompt 80 + completion 40 = 120 计费 > 100
  meterTokenFrame({ sessionId: 's1', type: 'usage', usage: { prompt_tokens: 80, completion_tokens: 40 } });
  const hit = checkTokenBudget('private:123');
  assert.equal(hit.ok, false);
  assert.equal(hit.scope, 'conv');
  assert.equal(hit.limit, 100);
  // 另一个会话没用过 → 放行
  const other = checkTokenBudget('private:456');
  assert.equal(other.ok, true);
});

test('预算闸门：全局日预算跨会话生效', () => {
  const dir = tmpStateDir();
  initTokenMeter({ stateDir: dir, convKeyResolver: () => 'private:789' });
  setTokenBudgetCfg({ dailyGlobal: 50 });
  meterTokenFrame({ sessionId: 's2', type: 'usage', usage: { prompt_tokens: 30, completion_tokens: 30 } });
  const r = checkTokenBudget('private:789');
  assert.equal(r.ok, false);
  assert.equal(r.scope, 'global');
});

test('预算闸门：owner 会话豁免（2026-10-26 主人免上限）', () => {
  const dir = tmpStateDir();
  initTokenMeter({ stateDir: dir, convKeyResolver: () => 'private:999' });
  // owner=999 配了每会话+全局双闸，且 owner 自己已烧超两闸
  setTokenBudgetCfg({ dailyPerConv: 100, dailyGlobal: 200, ownerQQ: 999 });
  meterTokenFrame({ sessionId: 's3', type: 'usage', usage: { prompt_tokens: 500, completion_tokens: 100 } });
  const owner = checkTokenBudget('private:999');
  assert.equal(owner.ok, true);
  assert.equal(owner.ownerExempt, true);
  // 非 owner 同样用量照样被拦
  const friend = checkTokenBudget('private:111');
  assert.equal(friend.ok, false);
});

test('预算闸门：非主人全局池剔除 owner 用量（2026-10-28 开放好友）', () => {
  const dir = tmpStateDir();
  // meter 是进程级单例，同文件前序测试会在 convDaySums 里留下别的会话键——
  // 所以这里只用【增量断言】（owner 前后池读数不变），不断言精确值。
  initTokenMeter({ stateDir: dir, convKeyResolver: (sid) => (String(sid) === 'owner-s1' ? 'private:777' : 'private:555') });
  setTokenBudgetCfg({ dailyNonOwnerGlobal: 1e12, ownerQQ: 777 });
  meterTokenFrame({ sessionId: 'friend-s1', type: 'usage', usage: { prompt_tokens: 40, completion_tokens: 20 } });
  const base = checkTokenBudget('private:555');
  assert.equal(base.scope, 'non-owner-global');
  assert.ok(base.used >= 60, '好友用量应计入非主人池（>=60），实际 ' + base.used);
  const base0 = base.used;
  // owner 随后烧 5000 → 池读数必须纹丝不动（owner 豁免的不止拦截，还有非主人池的计入）
  meterTokenFrame({ sessionId: 'owner-s1', type: 'usage', usage: { prompt_tokens: 4000, completion_tokens: 1000 } });
  const after = checkTokenBudget('private:555');
  assert.equal(after.used, base0, 'owner 用量不得污染非主人全局池');
  // 好友再烧 50，把限额压到 (used-1) → 拦；owner 侧依旧豁免
  meterTokenFrame({ sessionId: 'friend-s2', type: 'usage', usage: { prompt_tokens: 30, completion_tokens: 20 } });
  setTokenBudgetCfg({ dailyNonOwnerGlobal: after.used + 49, ownerQQ: 777 });
  assert.equal(checkTokenBudget('private:555').ok, false);
  assert.equal(checkTokenBudget('private:777').ownerExempt, true);
});

test('预算闸门：非主人池 + 每会话并存时报告更紧的（2026-10-28）', () => {
  const dir = tmpStateDir();
  initTokenMeter({ stateDir: dir, convKeyResolver: () => 'private:222' });
  setTokenBudgetCfg({ dailyNonOwnerGlobal: 1e12, dailyPerConv: 100, ownerQQ: 777 });
  meterTokenFrame({ sessionId: 'f1', type: 'usage', usage: { prompt_tokens: 60, completion_tokens: 60 } });
  const r = checkTokenBudget('private:222');
  assert.equal(r.ok, false);
  assert.equal(r.scope, 'conv'); // 120/100(conv) > 池占比（池限额放大到不构成约束）
});

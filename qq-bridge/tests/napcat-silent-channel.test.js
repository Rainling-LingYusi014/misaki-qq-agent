/* ── 收包通道静默探测（2026-10-28 主人：「这种情况要避免，不然半天排查不出来」）────────
 *
 * 现场：NapCat 报 online/good、HTTP 探针全绿、心跳每 5 秒照来、bot 还能往外发，
 * 但手机发来的私聊一条都进不来（19:24 之后 29 分钟零事件）。所有现有探针都判健康。
 * 判据（纯函数 decideSilentChannel）：桥的真实事件水位 N 分钟没动，而 NapCat 最近联系人里的
 * 最新消息比它更新 → QQ 收到了、桥没收到。
 *
 * 跑法：cd qq-bridge && node tests/napcat-silent-channel.test.js
 */
import assert from 'node:assert/strict';
import { decideSilentChannel } from '../src/core/napcat-guard.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const T = 1793196000000;              // 任意基准时刻
const MIN = 60e3;

console.log('== 收包通道静默判定 ==');

t('没有任何水位（刚重启/刚连上）→ 不断言', () => {
  assert.deepEqual(decideSilentChannel({ now: T, lastEventAt: 0, newestMsgAt: T }), { suspect: false, why: 'no-data' });
});

t('NapCat 那边也查不到最新消息 → 不断言（宁可漏报不误报）', () => {
  assert.deepEqual(decideSilentChannel({ now: T, lastEventAt: T - 20 * MIN, newestMsgAt: 0 }), { suspect: false, why: 'no-data' });
});

t('桥 3 分钟前刚有事件 → 不算静默', () => {
  assert.equal(decideSilentChannel({ now: T, lastEventAt: T - 3 * MIN, newestMsgAt: T }).why, 'recent-event');
});

t('桥安静 15 分钟，但 NapCat 最新消息并不比水位新 → 正常（没人说话）', () => {
  const d = decideSilentChannel({ now: T, lastEventAt: T - 15 * MIN, newestMsgAt: T - 20 * MIN });
  assert.equal(d.suspect, false);
  assert.equal(d.why, 'no-newer-msg');
});

t('NapCat 新消息只比水位新 30 秒（在 90 秒宽限内）→ 不报', () => {
  const d = decideSilentChannel({ now: T, lastEventAt: T - 15 * MIN, newestMsgAt: T - 15 * MIN + 30e3 });
  assert.equal(d.suspect, false);
});

t('刚好卡在宽限边界（+90 秒）→ 不报', () => {
  const d = decideSilentChannel({ now: T, lastEventAt: T - 15 * MIN, newestMsgAt: T - 15 * MIN + 90e3 });
  assert.equal(d.suspect, false);
});

t('NapCat 有 12 分钟前的新消息、桥却 15 分钟没动静 → 判定卡死', () => {
  const d = decideSilentChannel({ now: T, lastEventAt: T - 15 * MIN, newestMsgAt: T - 12 * MIN });
  assert.equal(d.suspect, true);
  assert.equal(d.why, 'stalled');
  assert.equal(d.gapMs, 3 * MIN);
});

t('阈值可配：minMs 调到 5 分钟 → 安静 6 分钟就开始比对', () => {
  const d = decideSilentChannel({ now: T, lastEventAt: T - 6 * MIN, newestMsgAt: T - 1 * MIN, silentMinMs: 5 * MIN });
  assert.equal(d.suspect, true);
});

t('阈值可配：graceMs 调到 10 分钟 → 只新 3 分钟不算', () => {
  const d = decideSilentChannel({ now: T, lastEventAt: T - 30 * MIN, newestMsgAt: T - 27 * MIN, silentGraceMs: 10 * MIN });
  assert.equal(d.suspect, false);
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

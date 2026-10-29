// 早安问候（2026-10-29 主人定规）：白名单私聊每天必问一次，骰子只决定落在哪个窗口
// （默认 7~8 点 33%、8~9 点 67%），窗口内的具体时刻再掷一枚。不占主动配额——
// 落账只认 proactiveCheck/companionCare（social-flow.recordSentMessages），两本账互不相干。
// 时刻必须可重现：按（会话+日期）做文本指纹（stableRoll，与气泡骰子同源），桥重启后重算
// 同一天得到同一时刻 → 定时器无需落盘，天然「不重发、不漏账」。
import { stableRoll } from './dice.js';
import { parseClockMin } from './time.js';

export const MORNING_GREET_DEFAULTS = Object.freeze({
  p1: 0.33,
  window1: ['07:00', '08:00'],
  window2: ['08:00', '09:00'],
});

/** 归一化配置：脏值一律回落默认（概率夹 [0,1]；窗口端点解析失败或端点颠倒 → 整窗回落）。 */
export function morningGreetCfg(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d; };
  const win = (v, d) => {
    const arr = Array.isArray(v) && v.length === 2 ? v : d;
    const a = arr.map((x) => parseClockMin(x));
    return a[0] != null && a[1] != null && a[1] > a[0] ? a : d.map((x) => parseClockMin(x));
  };
  return {
    p1: num(o.p1, MORNING_GREET_DEFAULTS.p1),
    window1: win(o.window1, MORNING_GREET_DEFAULTS.window1),
    window2: win(o.window2, MORNING_GREET_DEFAULTS.window2),
  };
}

/** 当天该会话的问候时刻（确定性）。同 key+同日永远同一结果，这是「重启不重发」的根基。
 *  返回 null = 参数无效（key 缺失 / dateKey 不是 YYYY-MM-DD）。 */
export function morningGreetPlan({ key, dateKey, p1, window1, window2 }) {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey ?? ''))) return null;
  const cfg = morningGreetCfg({ p1, window1, window2 });
  const r1 = stableRoll(`morning-window:${key}:${dateKey}`);
  const idx = r1 < cfg.p1 ? 1 : 2;
  const [sMin, eMin] = idx === 1 ? cfg.window1 : cfg.window2;
  const spanSec = Math.max(60, (eMin - sMin) * 60);
  const offsetSec = Math.floor(stableRoll(`morning-min:${key}:${dateKey}`) * spanSec);
  const dayStartMs = Date.parse(`${dateKey}T00:00:00+08:00`);
  return { atMs: dayStartMs + sMin * 60000 + offsetSec * 1000, windowIndex: idx };
}

/** 到点判定（纯函数）。「对方今天已经先开口（比如他先问了早安）→ 再补发一条愣的会很奇怪」
 *  是主人点名的场景：lastIncomingAt 兜住他今天说过的任何话，都算「今天已经搭上话」。 */
export function morningGreetDecision({ dateKey, greetedDay = '', lastIncomingAt = 0, dayStartMs = 0, busy = false }) {
  if (greetedDay === dateKey) return { fire: false, why: '今天已问过' };
  if (Number(lastIncomingAt) >= dayStartMs) return { fire: false, why: '对方今天已先开口' };
  if (busy) return { fire: false, why: '对话进行中' };
  return { fire: true, why: '' };
}

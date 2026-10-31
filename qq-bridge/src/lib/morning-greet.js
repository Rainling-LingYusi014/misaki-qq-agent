// 早安问候（2026-10-29 主人定规）：白名单私聊每天必问一次，骰子只决定落在哪个窗口
// （默认 7~8 点 33%、8~9 点 67%），窗口内的具体时刻再掷一枚。不占主动配额——
// 落账只认 proactiveCheck/companionCare（social-flow.recordSentMessages），两本账互不相干。
// 时刻必须可重现：按（会话+日期）做文本指纹（stableRoll，与气泡骰子同源），桥重启后重算
// 同一天得到同一时刻 → 定时器无需落盘，天然「不重发、不漏账」。
import { stableRoll } from './dice.js';
import { beijingDateKey, parseClockMin } from './time.js';

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

/** 到点判定（纯函数）。2026-10-30 主人改口：「对方已先开口」只指**主动道过早安**——
 *  今天说过别的话不算（熬到凌晨道晚安、早上起床，早安照发不误）。
 *  peerGreetedDay 由入站钩子按问候日记账（见 isPeerMorningGreeting / greetDayKey）。 */
export function morningGreetDecision({ dateKey, greetedDay = '', peerGreetedDay = '', busy = false }) {
  if (greetedDay === dateKey) return { fire: false, why: '今天已问过' };
  if (peerGreetedDay === dateKey) return { fire: false, why: '对方今天已先道过早安' };
  if (busy) return { fire: false, why: '对话进行中' };
  return { fire: true, why: '' };
}

// ── 问候日界与对方问候识别（2026-10-30 主人定规）────────────────────────────
// 新的一天从凌晨 4 点起算：0~4 点算前一夜，熬夜到凌晨的对话不拦当天早安。

export const GREET_DAY_BOUNDARY_HOURS = 4;

/** 早安域的「今天是哪天」：北京时间日期键前移 4 小时再取。 */
export function greetDayKey(ms = Date.now()) {
  return beijingDateKey(ms - GREET_DAY_BOUNDARY_HOURS * 3600 * 1000);
}

// 只认纯问候形态（可带标点/表情标记/一句后续）。前缀匹配：「早安，昨晚…」算道过早安；
// 「早点睡」「早上再说」「早自习」这类不算。
const PEER_GREET_RE = /^(?:早[安呀啊哦哈哟]?|早上好|早上呀|早哦|good\s*morning|morning|ohayo|おはよう)(?:[！!。．,，~～\s…]|$)/;

export function isPeerMorningGreeting(text) {
  let t = String(text ?? '').trim().toLowerCase();
  if (!t) return false;
  t = t.replace(/\[[^\]]{1,16}\]/g, ' ').trim(); // [表情:xx] 等 QQ 标记不算内容
  if (!t || t.length > 24) return false;
  return PEER_GREET_RE.test(t);
}

// 拍一拍的开口策略（2026-10-28 主人定规，纯函数）
//
// 现场（泠岚私聊）：每次被拍一下，美咲都追问「在的，拍我干嘛呢 / 是有话要说还是就拍着玩」。
// 主人原话：「不要每次被拍就问，这会让人觉得很奇怪，仿佛 misaki 这个人很敏感不好接触。」
// 规则：
//   · 单次拍一拍 → 不开口（多数人拍一下只是打个招呼/勾一下注意）；
//   · 一连拍两下（默认 15 秒内的第二下）→ 问一次；
//   · 10 分钟内累计三下（含前面那两下）→ 问一次；
//   · 问过之后冷却 30 分钟，连拍不会问个不停。
// 计数按「会话 + 发送者」分开，群里不同人拍的不会叠加。
//
// 2026-10-28 主人指出：QQ 的拍一拍本身有冷却，最短 10 秒、实际不可能卡着秒刚好，
// 所以"6 秒内第二下"在真实客户端上永远触发不了 —— 一连两下按 15 秒算才是可发生的。

const DEFAULTS = { doubleTapMs: 15000, windowMs: 10 * 60 * 1000, count: 3, cooldownMs: 30 * 60 * 1000 };

/**
 * @param {{history?:number[], now?:number, lastAskedAt?:number,
 *          doubleTapMs?:number, windowMs?:number, count?:number, cooldownMs?:number}} a
 * @returns {{ask:boolean, why:string}}
 */
export function pokeAskDecision(a = {}) {
  const now = Number(a.now) || Date.now();
  const doubleTapMs = Math.max(1000, Number(a.doubleTapMs) || DEFAULTS.doubleTapMs);
  const windowMs = Math.max(60000, Number(a.windowMs) || DEFAULTS.windowMs);
  const count = Math.max(2, Number(a.count) || DEFAULTS.count);
  const cooldownMs = Math.max(60000, Number(a.cooldownMs) || DEFAULTS.cooldownMs);
  const ts = (Array.isArray(a.history) ? a.history : [])
    .map(Number).filter(Number.isFinite).sort((x, y) => x - y)
    .filter((t) => now - t >= 0 && now - t <= windowMs);
  const n = ts.length;
  if (n <= 1) return { ask: false, why: 'single' };
  const fastDouble = now - ts[n - 2] <= doubleTapMs;
  const triple = n >= count;
  if (!fastDouble && !triple) return { ask: false, why: 'slow-burst' };
  const lastAsked = Number(a.lastAskedAt) || 0;
  if (lastAsked > 0 && now - lastAsked < cooldownMs) return { ask: false, why: 'cooldown' };
  return { ask: true, why: fastDouble ? 'double-tap' : `triple-${Math.round(windowMs / 60000)}m` };
}

/* ── 回拍（2026-10-28 主人定规）────────────────────────────────────────────────
 * 主人原话：「如果被对方拍一拍，只要有 50% 的概率也拍对方一次……想拍就拍，除非被问起。」
 *
 * 为什么不是"每次都回拍"：一来会变成条件反射式的机器行为，二来一拍一还容易变成互相刷。
 * 所以掷骰 + 冷却：同一个人的拍，回拍过之后 POKE_BACK 冷却内不再回。
 * 为什么放在桥而不是让模型决定：单次拍一拍按现行策略**不唤醒模型**（不追问），
 * 模型根本没有回合可用；回拍是纯动作、无文本，桥直接做最省。
 */
const BACK_DEFAULTS = { probability: 0.5, cooldownMs: 30 * 60 * 1000 };

/**
 * @param {{now?:number, lastBackAt?:number, probability?:number, cooldownMs?:number, rng?:() => number}} a
 * @returns {{back:boolean, p:number, roll:number, why:string}}
 */
export function pokeBackDecision(a = {}) {
  const now = Number(a.now) || Date.now();
  const pRaw = Number(a.probability);
  const p = Number.isFinite(pRaw) ? Math.min(1, Math.max(0, pRaw)) : BACK_DEFAULTS.probability;
  const cooldownMs = Math.max(0, Number(a.cooldownMs) || 0) || BACK_DEFAULTS.cooldownMs;
  const lastBackAt = Number(a.lastBackAt) || 0;
  const rng = typeof a.rng === 'function' ? a.rng : Math.random;
  const raw = Number(rng());
  const roll = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 1;
  if (p <= 0) return { back: false, p, roll, why: 'off' };
  if (lastBackAt > 0 && now - lastBackAt < cooldownMs) return { back: false, p, roll, why: 'cooldown' };
  if (roll >= p) return { back: false, p, roll, why: 'dice-miss' };
  return { back: true, p, roll, why: 'dice-hit' };
}

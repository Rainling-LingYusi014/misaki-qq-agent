// 「这一类内容本轮能不能发」的抽签 —— 桥侧掷骰，不让模型自己按概率决定（2026-09-15）
//
// 背景：语音和表情包原来都只是在提示词里写一句"概率 0.2 就偶尔来一个"，那属于软引导：
// 模型看不到真正的随机数，判断很飘（要么连着发、要么整晚不发）。现在桥每次唤醒掷一次骰子，
// 把结果当数据行写进唤醒正文（[Voice] / [Meme] dice HIT / MISS / cooldown），模型照着办。
// 语音那份先落在 voice.js 里；这里抽成通用件，语音与表情包共用同一套掷骰与冷却逻辑。
import { log } from '../lib/log.js';

let cfgRef = null;

export function initSendDice(cfg) {
  cfgRef = cfg;
}

/** `${kind}:${key}` -> 最近一次成功发出的时间戳（进程内；重启清空，不影响正确性） */
const sentAt = new Map();

/** 真的发出去了才登记：用于冷却窗口内不再抽中（防"概率虽小却连着发"）。 */
export function noteSent(kind, key) {
  const k = String(key ?? '').trim();
  if (!k) return;
  sentAt.set(`${kind}:${k}`, Date.now());
}

/**
 * 掷骰。
 * @returns {{ p:number, cooling:boolean, hit:boolean }}
 */
export function dice(kind, key, probability, cooldownMs) {
  const p = Math.min(1, Math.max(0, Number(probability) || 0));
  const cd = Math.max(0, Number(cooldownMs) || 0);
  const last = sentAt.get(`${kind}:${String(key ?? '').trim()}`) ?? 0;
  const cooling = cd > 0 && last > 0 && (Date.now() - last) < cd;
  return { p, cooling, hit: !cooling && p > 0 && Math.random() < p };
}

// ── 表情包（内置表情库 qq_send_meme + QQ 收藏表情 qq_send_sticker 共用一条机会线）──────
// 2026-10-30 主人定调：**概率退役**——每一轮唤醒都给表情机会，发不发由「库里有没有贴语境的」
// 这一条模型判断把守；限频全靠两个硬闸：sendMinIntervalMs（两张最短间隔）+
// sendMaxPerWindow / sendMaxWindowMs（滑动窗口限额）。历史背景：2026-09-19 曾把 HIT 从
// "许可"改成"指令"（当时实际发生率 ≈ 概率 × 模型配合率，1966 次工具调用只发过 5 张）；
// 概率门删除后指令语义保留，闸门变成确定性的。
export const MEME_DEFAULT_MIN_INTERVAL_MS = 30 * 1000;
export const MEME_DEFAULT_MAX_PER_WINDOW = 5;
export const MEME_DEFAULT_MAX_WINDOW_MS = 5 * 60 * 1000;

/** `meme:${key}` -> 最近发送时间戳数组（滑窗限额；进程内，重启清空不影响正确性） */
const sentTimes = new Map();

function memeCfg() {
  const s = cfgRef?.social?.sticker ?? {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    enabled: cfgRef?.social?.sticker?.enabled !== false,
    minIntervalMs: num(s.sendMinIntervalMs, num(s.sendCooldownMs, MEME_DEFAULT_MIN_INTERVAL_MS)),
    maxPerWindow: Math.max(1, num(s.sendMaxPerWindow, MEME_DEFAULT_MAX_PER_WINDOW)),
    maxWindowMs: num(s.sendMaxWindowMs, MEME_DEFAULT_MAX_WINDOW_MS)
  };
}

/** 表情包发出去之后登记一次（内置表情库与收藏表情两条路都调） */
export function noteMemeSent(key) {
  noteSent('meme', key);
  const k = String(key ?? '').trim();
  if (!k) return;
  const arr = sentTimes.get(`meme:${k}`) ?? [];
  arr.push(Date.now());
  sentTimes.set(`meme:${k}`, arr.slice(-20));
}

/**
 * 唤醒提示词里的表情机会行（英文，与 preset 的英文指令框架一致）。
 * 三种形态：available（本轮有机会）/ cooldown（30s 间隔内）/ quota used（窗口满额）。
 */
export function memeTurnHint(key) {
  const c = memeCfg();
  if (!c.enabled) return '';
  const k = String(key ?? '').trim();
  const now = Date.now();
  const last = sentAt.get(`meme:${k}`) ?? 0;
  if (last > 0 && now - last < c.minIntervalMs) {
    return `[Meme] cooldown (${Math.ceil((c.minIntervalMs - (now - last)) / 1000)}s since last sticker): no stickers this turn unless someone explicitly asks for one.\n`;
  }
  const times = (sentTimes.get(`meme:${k}`) ?? []).filter((t) => now - t < c.maxWindowMs);
  sentTimes.set(`meme:${k}`, times);
  if (times.length >= c.maxPerWindow) {
    return `[Meme] sticker quota used (${times.length}/${c.maxPerWindow} in last ${Math.round(c.maxWindowMs / 60000)}min): no stickers this turn unless someone explicitly asks for one.\n`;
  }
  return `[Meme] sticker available (quota ${times.length}/${c.maxPerWindow} in ${Math.round(c.maxWindowMs / 60000)}min): SEND ONE sticker or meme this turn if one in the library fits what you are saying (qq_send_sticker for QQ favorites; qq_meme_search + qq_send_meme for the meme packs, which already include the owner's own packs and the pack bound to the current character). At most one, never the same one twice in a row, never as a substitute for answering. A text placeholder like "[表情包:...]" is NOT sending one - if you cannot send a real image, send none.\n`;
}

/** 供诊断/日志：当前生效的表情包参数 */
export function memeDiceInfo() {
  const c = memeCfg();
  return { ...c, lastSentAt: sentAt.get('meme:private') ?? 0 };
}

/** 清空登记（测试与排障用） */
export function resetSendDice() {
  sentAt.clear();
  sentTimes.clear();
  log('[send-dice] 抽签登记已清空');
}

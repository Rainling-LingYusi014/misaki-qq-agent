// 常规模式「每天保底一次主动关心」的判定（2026-10-28 主人定规，纯函数）
//
// 为什么需要：常规模式的主动机会要求"有新鲜话题"（未读 / 待办想法 / 近 2 小时对方说过话），
// 一个安静下来的朋友可能连着几天收不到她一句话。主人要求：常规模式一天至少主动关心一次。
// 但保底不能变成半夜叫人，也不能在刚聊完的时候硬塞一句"关心"，所以三条同时成立才算到期：
//   ① 今天还没主动开口过（usedToday < dailyMin）；
//   ② 现在落在保底窗口内（默认 19:00–22:30，避开深夜和清晨）；
//   ③ 对方今天一整天没说过话（lastIncomingAt 早于北京时间今天零点）——已经在聊的人不需要"关心"。
// 陪伴模式有自己的参数档，不走这里。

import { parseClockMin } from './time.js';

/** 从 social.proactive 读保底配置（缺省：每天 1 次，19:00–22:30）。 */
export function dailyMinCfg(proactive = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const start = parseClockMin(proactive.dailyMinWindowStart ?? '19:00');
  const end = parseClockMin(proactive.dailyMinWindowEnd ?? '22:30');
  return {
    dailyMin: Math.max(0, Math.round(num(proactive.privateDailyMin, 1))),
    windowStartMin: start == null ? 19 * 60 : start,
    windowEndMin: end == null ? 22 * 60 + 30 : end,
  };
}

/**
 * 今天这一次"保底关心"是否到期。
 * @param {{usedToday?:number, nowMin?:number, windowStartMin?:number, windowEndMin?:number,
 *          lastIncomingAt?:number, todayStartMs?:number, dailyMin?:number}} a
 * @returns {boolean}
 */
export function dailyMinDue(a = {}) {
  const need = Math.max(0, Math.round(Number(a.dailyMin) || 0));
  if (need <= 0) return false;                                   // 0 = 关闭保底
  if (Math.max(0, Number(a.usedToday) || 0) >= need) return false;
  const s = Number(a.windowStartMin);
  const e = Number(a.windowEndMin);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  const now = ((Number(a.nowMin) || 0) % 1440 + 1440) % 1440;
  const inWindow = s < e ? (now >= s && now < e) : (now >= s || now < e);  // 支持跨午夜窗口
  if (!inWindow) return false;
  const last = Number(a.lastIncomingAt) || 0;
  const dayStart = Number(a.todayStartMs) || 0;
  if (last > 0 && dayStart > 0 && last >= dayStart) return false;          // 今天对方说过话
  return true;
}

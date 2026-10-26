// life-events.js — 泠娜的「生活事件池」状态层（2026-10-16）
// 目的：让「今天发生了什么 / 这会在做什么 / 之后有什么打算」有可对账的事实来源。
// 每天开档（惰性，当天首次被问到才滚一次）从事件池里按三重闸门抽定当日档案：
//   ① 月份闸门（季节穿帮防护：桂花只许 10-11 月、台风只许 7-9 月……）
//   ② 时段闸门（凌晨/早上/下午/晚上）
//   ③ 班表闸门（复用 shift-roster 的排班：上班=仅当班可抽，休=仅不在班上可抽）
// 注入为 [Today] 三行（这会/今天/之后），只进 owner 私聊；群聊一律不给。
// 事件池在 state/life-events.json（Excel 定稿转的），mtime 变了自动热加载。
// 任何异常都退化为空串，绝不阻塞唤醒。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_PATH = path.join(__dirname, '..', '..', 'state', 'life-events.json');
const TODAY_PATH = path.join(__dirname, '..', '..', 'state', 'life-today.json');
const ROSTER_PATH = path.join(__dirname, '..', '..', 'state', 'shift-roster.json');

// 与 shift-roster.js 保持一致（勿单方面改）
const SHIFTS = { early: { s: 8, e: 16 }, late: { s: 15, e: 23 }, off: { s: -1, e: -1 } };
const ALL_MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];

function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); } // UTC+8
function bjDateStr(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function bjHour() { return beijingNow().getUTCHours(); }
function monthBJ() { return beijingNow().getUTCMonth() + 1; }
function bucketOf(h) { return h < 6 ? 'dawn' : h < 12 ? 'am' : h < 18 ? 'pm' : 'eve'; }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

let poolCache = null, poolStamp = '';
function loadPool() {
  try {
    const st = fs.statSync(POOL_PATH);
    const v = String(st.mtimeMs);
    if (!poolCache || poolStamp !== v) {
      poolCache = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
      poolStamp = v;
    }
    return Array.isArray(poolCache) ? poolCache : [];
  } catch { return []; }
}
function loadToday() {
  try { return JSON.parse(fs.readFileSync(TODAY_PATH, 'utf8')); } catch { return null; }
}
function saveToday(t) {
  try { fs.writeFileSync(TODAY_PATH, JSON.stringify(t, null, 2)); } catch { /* 写失败下一轮再滚 */ }
}
function shiftFor(dateStr) {
  try {
    const j = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
    return (j.days && j.days[dateStr]) || 'late';
  } catch { return 'late'; }
}
function isWorking(shift, hour) {
  const s = SHIFTS[shift] || SHIFTS.late;
  return s.s >= 0 && hour >= s.s && hour < s.e;
}

function wpick(list, n) {
  const p = list.slice();
  const out = [];
  while (out.length < n && p.length) {
    const tot = p.reduce((s, e) => s + (e.f || 1), 0);
    let r = Math.random() * tot, i = 0;
    for (; i < p.length; i++) { r -= (p[i].f || 1); if (r <= 0) break; }
    const idx = Math.min(i, p.length - 1);
    out.push(p[idx]);
    p.splice(idx, 1);
  }
  return out;
}

/* 每日开档：抽定当日档案（一天只滚一次，之后不变——防止前后矛盾） */
function roll() {
  const pool = loadPool();
  const today = bjDateStr(beijingNow());
  const prev = loadToday();
  const lastSpoken = (prev && prev.lastSpoken) || {};
  const seriesState = (prev && prev.seriesState) || {};
  const archive = ((prev && prev.archive) || []).slice(-29);

  // ① 昨天的「这会」归档为过去（讲过的进冷却；连续剧剧情推进一格）
  if (prev && prev.date && prev.date !== today) {
    for (const ev of (prev.now || [])) {
      if (!ev || !ev.id) continue;
      lastSpoken[ev.id] = prev.date;
      if (ev.tp === 'series' && Array.isArray(ev.stages) && ev.stages.length) {
        const st = seriesState[ev.id] || { stage: 0 };
        if (st.stage + 1 >= ev.stages.length) {
          seriesState[ev.id] = { stage: 0, exhaustedAt: today }; // 讲完一轮 → 长冷却
        } else {
          seriesState[ev.id] = { stage: st.stage + 1 };
        }
      }
    }
  }

  // ② 到期的计划熟成 → 进入今天的「这会」候选
  const matured = [];
  const plans = [];
  for (const p of ((prev && prev.plans) || [])) {
    if (p && p.ev && p.readyDay && p.readyDay <= today) {
      if (!lastSpoken[p.ev.id] || daysBetween(lastSpoken[p.ev.id], today) >= 5) matured.push(p.ev);
      // 刚讲过没多久就到期的计划，直接作废，不硬塞
    } else if (p && p.ev) plans.push(p);
  }

  // ③ 候选过滤：月份闸门 + 冷却 + 班表闸门
  const month = monthBJ();
  const shift = shiftFor(today);
  const cdOk = (id, gap) => !lastSpoken[id] || daysBetween(lastSpoken[id], today) >= gap;
  const seriesCool = (id) => {
    const st = seriesState[id];
    return !st || !st.exhaustedAt || daysBetween(st.exhaustedAt, today) >= 7;
  };
  const cands = pool.filter((e) => {
    if (!e || !e.id) return false;
    const m = Array.isArray(e.m) ? e.m : ALL_MONTHS;
    if (!m.includes(month)) return false;                 // 月份闸门
    if (e.w === 'work' && shift === 'off') return false;  // 班表闸门（休=当天不进店）
    if (e.tp === 'series') return cdOk(e.id, 2) && seriesCool(e.id);
    return cdOk(e.id, 3);
  });

  const taken = new Set(matured.map((e) => e.id));
  const now = matured.slice();
  now.push(...wpick(cands.filter((e) => e.tp !== 'series'), 3).filter((e) => !taken.has(e.id) && taken.add(e.id)));
  now.push(...wpick(cands.filter((e) => e.tp === 'series'), 1).filter((e) => !taken.has(e.id) && taken.add(e.id)));

  // ④ 「今天发生了什么」：钩子优先，固定 1-2 条（当天不变）
  const hooks = now.filter((e) => e.tp === 'hook');
  const rest = now.filter((e) => e.tp !== 'hook');
  const happened = [...hooks, ...rest].slice(0, 2);

  // ⑤ 抽 1-2 条新计划（1~3 天后到期）
  const planCap = pool.filter((e) =>
    e.tp === 'plan' && cdOk(e.id, 5) &&
    !now.some((n) => n.id === e.id) && !plans.some((p) => p.ev.id === e.id));
  for (const ev of wpick(planCap, 1 + (Math.random() < 0.4 ? 1 : 0))) {
    const d = new Date(beijingNow());
    d.setUTCDate(d.getUTCDate() + 1 + Math.floor(Math.random() * 3));
    plans.push({ ev, readyDay: bjDateStr(d) });
  }

  const st = { date: today, now, happened, plans, seriesState, lastSpoken, archive };
  saveToday(st);
  return st;
}

function stageText(ev) {
  try {
    const t = loadToday();
    const st = (t && t.seriesState && t.seriesState[ev.id]) || { stage: 0 };
    const i = Math.min(st.stage || 0, ev.stages.length - 1);
    return ev.stages[i];
  } catch { return (ev.stages && ev.stages[0]) || ''; }
}

/* 唤醒注入入口：只进 owner 私聊；返回以 \n 结尾的整段或空串 */
export function todayBlock(key, ownerQQ) {
  void ownerQQ;
  try {
    if (!String(key).startsWith('private:')) return '';
    if (!loadPool().length) return '';
    let t = loadToday();
    const today = bjDateStr(beijingNow());
    if (!t || t.date !== today) t = roll();
    const h = bjHour();
    const b = bucketOf(h);
    const wk = isWorking(shiftFor(today), h);
    const now = (t.now || []).filter((e) =>
      e.bk.includes(b) && (wk ? e.w !== 'off' : e.w !== 'work'));
    const nowTxt = now.length
      ? now.map((e) => (e.tp === 'series' ? `${e.t}（${stageText(e)}）` : `${e.t}（${e.d}）`)).join('；')
      : (wk ? '在店里当班' : '没在忙什么特别的');
    const hap = (t.happened || []).filter((e) => !now.some((n) => n.id === e.id)).map((e) => e.t).slice(0, 2).join('、');
    const plan = (t.plans || []).map((p) => p.ev.t).join('、');
    const parts = [`这会：${nowTxt}`];
    if (hap) parts.push(`今天：${hap}`);
    if (plan) parts.push(`之后：${plan}`);
    return `[Today] ${parts.join('；')}。\n（被问在做什么/今天怎么样/之后有什么打算时，按这几行答，可以展开括号里的细节；不要编造这几行之外的遭遇；主动开口没话找话时也可以从这里挑一件来讲。）\n`;
  } catch { return ''; }
}

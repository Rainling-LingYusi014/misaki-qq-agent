/* ══════════════════════════════════════════════════════════════════════════
 * B 站养号（M2，2026-10-27 按主人规格重写观看模型）
 *
 * 主人定规（2026-10-27）：
 *   · 三个每日窗口：11:00~13:00 / 16:30~18:00 / 22:00~23:00（北京时间），窗口外不刷
 *   · 每天至少 2 片、上限 30 片；额度可全在一个窗口，也可摊到两三个窗口
 *   · 单日观看总时长上限 2 小时；时长超过 1 小时（3600s）的视频一律不刷
 *   · 跳出行为拟人：12% 三秒跳出 / 18% 6s~60% 早退 / 60% 峰值在 90% 的正态 / 10% 完整看完
 *   · 点赞概率 = 完播率；5 秒内退出不赞；每日点赞上限（默认 3）；永不取消赞；同片当日不重复
 *   · 只观看 + 点赞——不评论/不私信/不收藏/不发动态
 *   · 风控特征码（-412/-352/-509/-403）→ 熔断，当天停
 *
 * 排程模型（2026-10-27 v2）：不是"每片一个定时点"，而是「会话」——
 * 每天在选中的窗口里随机生成 1~3 个观看时段（每段 15~40 分钟），
 * 进入时段后连续看片，片与片之间停 20~90 秒；时段结束或额度/预算用尽就收工。
 * 这样一个人一天只会打开几次 B 站看一会儿，而不是 30 个孤立的定时器。
 * 登录：复用 state/bilibili-auth.json；失效则当日停，不自动重登。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { biliJson, wbiSign, checkIsLogin, circuitOpen, circuitState, BILI_AUTH_FILE, BILI_CIRCUIT_FILE } from '../lib/bili-api.js';
import { loadActions, saveActions, getCoinBalance, coinVideo, followUser, notifyOwnerCard, COIN_FLOOR } from '../lib/bili-social.js';

const AUTH_FILE = BILI_AUTH_FILE;
const NURTURE_FILE = path.join(STATE_DIR, 'bili-nurture.json');
const BJ = 8 * 3600 * 1000;
const GRACE_MS = 10 * 60 * 1000;
const SEARCH_TTL_MS = 30 * 60 * 1000;
const SESSION_MIN_MIN = 15;   /* 一个观看时段的时长下限（分钟） */
const SESSION_MAX_MIN = 40;   /* 上限 */
const GAP_MIN_SEC = 20;       /* 片与片之间（秒） */
const GAP_MAX_SEC = 90;

let cfgRef = null;
let nurtureTimer = null;

/* ── 基础 ── */
const api = (url, opts = {}) => biliJson(url, { ...opts, scope: 'nurture', circuitFile: BILI_CIRCUIT_FILE, authFile: AUTH_FILE });
const sign = (params) => wbiSign(params, { authFile: AUTH_FILE, circuitFile: BILI_CIRCUIT_FILE, scope: 'nurture' });
const bjHour = (nowMs = Date.now()) => new Date(nowMs + BJ).getUTCHours();
const todayKey = (nowMs = Date.now()) => new Date(Number(nowMs) + BJ).toISOString().slice(0, 10);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick1 = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfgN = () => cfgRef?.social?.bilibili?.nurture ?? {};
const bjMin = (nowMs = Date.now()) => { const d = new Date(nowMs + BJ); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dayStart = (nowMs = Date.now()) => {
  const d = new Date(nowMs + BJ);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BJ;
};
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmtClock = (ms) => new Date(ms + BJ).toISOString().slice(11, 16);

/* ── 状态 ── */
function loadState(now = Date.now()) {
  const today = todayKey(now);
  const raw = readJsonSafe(NURTURE_FILE, {});
  if (raw.day !== today) {
    return { day: today, likes: 0, lastLikedAid: '', lastLikedDay: '', plan: null };
  }
  return {
    day: today,
    likes: Number(raw.likes) || 0,
    lastLikedAid: raw.lastLikedAid != null ? String(raw.lastLikedAid) : '',
    lastLikedDay: String(raw.lastLikedDay ?? ''),
    plan: raw.plan && typeof raw.plan === 'object' ? raw.plan : null,
  };
}
const saveSt = (s) => atomicWriteJson(NURTURE_FILE, s);

/* ── 当日计划：窗口 → 观看时段（会话） ── */
export function generatePlan(now = Date.now()) {
  const n = cfgN();
  const ds = dayStart(now);
  const nowMin = bjMin(now);
  const maxTarget = Math.max(2, Number(n.dailyVideoMax) || 30);
  const minTarget = Math.min(maxTarget, Math.max(2, Number(n.dailyVideoMin) || 2));
  const quota = rnd(minTarget, maxTarget);
  const winsRaw = (Array.isArray(n.windows) && n.windows.length) ? n.windows : [[660, 780], [990, 1080], [1320, 1380]];
  const open = winsRaw
    .map((w) => ({ start: Number(w?.[0]), end: Number(w?.[1]) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .filter((w) => w.end > nowMin + 2);
  if (!open.length) {
    return { day: todayKey(now), quota, sessions: [], watchSec: 0, count: 0, ownerPending: false, search: null, stopped: '今日窗口已过' };
  }
  /* 摊几个窗口：40% 一个 / 40% 两个 / 20% 三个 */
  const r = Math.random();
  const k = r < 0.4 ? 1 : (r < 0.8 ? 2 : 3);
  const chosen = open.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(k, open.length)).sort((a, b) => a.start - b.start);
  const sessions = [];
  for (const w of chosen) {
    const winStart = Math.max(w.start, nowMin + 2);
    const avail = w.end - winStart;
    if (avail < 5) continue;
    /* 时段起点落在窗口前 60% 里，避免总在窗口刚开就开刷 */
    const latestStart = winStart + Math.max(0, Math.floor(avail * 0.6));
    const startMin = rnd(winStart, Math.max(winStart, latestStart));
    const room = w.end - startMin;
    if (room < 5) continue;
    const len = rnd(Math.min(SESSION_MIN_MIN, room), Math.min(SESSION_MAX_MIN, room));
    sessions.push({
      win: `${fmtMin(w.start)}-${fmtMin(w.end)}`,
      start: ds + startMin * 60000,
      end: ds + (startMin + len) * 60000,
    });
  }
  return {
    day: todayKey(now),
    quota,
    sessions,
    watchSec: 0,
    count: 0,
    ownerPending: Math.random() < 0.6,
    search: null,
    stopped: '',
  };
}

function logPlan(plan) {
  const budgetMin = Math.round((Number(cfgN().dailyWatchSeconds) || 7200) / 60);
  if (!plan?.sessions?.length) { log(`[bili-nurture] 今日计划：无时段（${plan?.stopped || '窗口已过'}）`); return; }
  const seg = plan.sessions.map((s) => `${s.win} 内 ${fmtClock(s.start)}~${fmtClock(s.end)}`).join(' / ');
  log(`[bili-nurture] 今日计划：额度 ${plan.quota} 片 · 预算 ${budgetMin}min · ${seg}`);
}

/** 当前所在的时段（没有则 null） */
function currentSession(plan, now = Date.now()) {
  return (plan.sessions || []).find((s) => now >= Number(s.start) && now <= Number(s.end)) || null;
}

/** 收尾补足"每天至少 2 片"：所有时段都过去、片数不足、还有窗口开着时，临时加一个 10~20 分钟的时段。 */
function catchUpSession(plan, now = Date.now()) {
  if (plan.catchUp) return null;
  const n = cfgN();
  const nowMin = bjMin(now);
  const winsRaw = (Array.isArray(n.windows) && n.windows.length) ? n.windows : [[660, 780], [990, 1080], [1320, 1380]];
  const ds = dayStart(now);
  const open = winsRaw
    .map((w) => ({ start: Number(w?.[0]), end: Number(w?.[1]) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > nowMin + 3)
    .sort((a, b) => a.start - b.start);
  if (!open.length) return null;
  const w = open[0];
  const startMin = Math.max(w.start, nowMin + 1);
  const len = Math.min(20, w.end - startMin);
  if (len < 3) return null;
  plan.catchUp = true;
  return { win: `${fmtMin(w.start)}-${fmtMin(w.end)}（补足）`, start: ds + startMin * 60000, end: ds + (startMin + len) * 60000 };
}

/* ── 跳出行为：峰值压在完播 90% ── */
function gauss() {
  let u = 0; let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function sampleExitSec(durationSec) {
  const d = Math.max(1, Math.round(Number(durationSec) || 0));
  if (d <= 1) return d;
  const r = Math.random();
  if (r < 0.12) return Math.min(rnd(3, 5), d);                 /* 三秒跳出 */
  if (r < 0.30) {                                              /* 6s ~ 60% 早退 */
    const lo = Math.min(6, d);
    const hi = Math.max(lo, Math.round(d * 0.6));
    return rnd(lo, hi);
  }
  if (r < 0.90) {                                              /* 峰值 90%，截断 75%~100% */
    const x = Math.max(0.75, Math.min(1, 0.9 + gauss() * 0.06));
    return Math.max(1, Math.round(d * x));
  }
  return d;                                                    /* 完整看完 */
}

/* ── 行为原语 ── */
async function watchVideo(bvid, exitSec, durationSec) {
  const v = await api(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { referer: 'https://www.bilibili.com/video/' + bvid });
  if (v.code !== 0) return { ok: false, why: `view code=${v.code}` };
  const aid = v.data.aid;
  const cid = v.data.cid;
  const dur = Number(v.data.duration) || Number(durationSec) || 0;
  const played = Math.max(1, Math.min(Math.round(exitSec), dur > 0 ? dur : Math.round(exitSec)));
  const click = (playType, playedTime) => api('https://api.bilibili.com/x/click-interface/click/web/h5', {
    method: 'POST',
    referer: 'https://www.bilibili.com/video/' + bvid,
    body: `aid=${aid}&cid=${cid}&part=1&lv=0&ftime=${Math.floor(Date.now() / 1000) - playedTime}&stime=${Math.floor(Date.now() / 1000)}&type=4&sub_type=0&platform=h5&played_time=${playedTime}&play_type=${playType}`,
  }).then((j) => j.code).catch((e) => e.message);
  const c1 = await click(1, 0);
  const heartbeats = Math.max(1, Math.round(played / 60));
  for (let i = 1; i <= heartbeats; i++) {
    await sleep(Math.round((played * 1000 / heartbeats) * (0.8 + Math.random() * 0.4)));
    await click(0, Math.round((played * i) / heartbeats));
  }
  const c2 = await click(2, played);
  return {
    ok: true,
    aid,
    bvid,
    pic: String(v.data.pic ?? ''),
    title: String(v.data.title ?? '').slice(0, 40),
    up: v.data.owner?.mid,
    upName: String(v.data.owner?.name ?? ''),
    dur,
    played,
    play: c1 === 0 && c2 === 0 ? 'reported' : `codes(${c1}/${c2})`,
  };
}

/** 点赞（无白名单：2026-10-27 定规=点赞放开给任意真实看过的视频；调用方保证先看后赞）。 */
const LIKE_QUERY = 'x-bili-locale-json=%7B%22c_locale%22:%7B%22language%22:%22zh%22,%22script%22:%22Hans%22%7D,%22always_translate%22:false%7D&x-bili-device-req-json=%7B%22platform%22:%22web%22,%22device%22:%22pc%22,%22spmid%22:%22333.788%22,%22mobi_app%22:%22web_cn%22%7D';
async function likeVideo(aid, bvid) {
  const d = readJsonSafe(AUTH_FILE, {});
  const csrf = d.bili_jct ?? '';
  if (!csrf) return { ok: false, why: '无 csrf' };
  const j = await api('https://api.bilibili.com/x/web-interface/archive/like?' + LIKE_QUERY, {
    method: 'POST',
    referer: 'https://www.bilibili.com/video/' + bvid,
    body: `aid=${aid}&like=1&csrf=${encodeURIComponent(csrf)}`,
  });
  if (j.code === 0 || j.code === 65004 || j.code === 65006) return { ok: true, idem: j.code !== 0 };
  return { ok: false, why: `like code=${j.code} ${j.message ?? ''}` };
}

/* ── 选片 ── */
export function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const s = String(v ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map((x) => Number(x));
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return 0;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

export async function searchCandidates(kw) {
  const n = cfgN();
  const minSec = Math.max(1, Number(n.minVideoSeconds) || 60);
  const maxSec = Math.max(minSec, Number(n.maxVideoSeconds) || 3600);
  const qs = await sign({ keyword: kw, search_type: 'video', page: 1 });
  const j = await api('https://api.bilibili.com/x/web-interface/search/type?' + qs, { referer: 'https://search.bilibili.com/' });
  const rows = (j.data?.result ?? []).filter((r) => r.bvid);
  const items = [];
  for (const r of rows) {
    const dur = parseDuration(r.duration);
    if (!dur || dur < minSec || dur > maxSec) continue;
    items.push({
      bvid: r.bvid,
      title: String(r.title ?? '').replace(/<[^>]+>/g, '').slice(0, 40),
      dur,
      up: String(r.owner?.mid ?? r.mid ?? ''),
    });
  }
  return items;
}

async function pickOwnerLatestVideo(ownerUid) {
  const qs = await sign({ mid: String(ownerUid), pn: 1, ps: 3, order: 'pubdate' });
  const j = await api('https://api.bilibili.com/x/space/wbi/arc/search?' + qs, { referer: `https://space.bilibili.com/${ownerUid}/video` });
  const v0 = j.data?.list?.vlist?.[0];
  if (!v0) return null;
  return {
    bvid: v0.bvid,
    title: String(v0.title ?? '').slice(0, 40),
    dur: parseDuration(v0.length),
    up: String(ownerUid),
    aid: v0.aid,
    source: 'owner',
  };
}

async function nextCandidate(s) {
  const n = cfgN();
  const maxSec = Math.max(1, Number(n.maxVideoSeconds) || 3600);
  const minVideos = Math.max(1, Number(n.dailyVideoMin) || 2);
  /* 前两片优先短于 10 分钟：保证「每天至少 2 片」能在单个时段内落地 */
  const needShort = Number(s.plan.count) < minVideos;
  if (s.plan.ownerPending) {
    const ownerUid = String(n.ownerUid ?? '');
    s.plan.ownerPending = false;
    if (ownerUid) {
      try {
        const own = await pickOwnerLatestVideo(ownerUid);
        if (own && own.dur && own.dur <= maxSec && (!needShort || own.dur <= 600)) return own;
        if (own) log(`[bili-nurture] 主人最新片 ${own.dur}s 本轮跳过（超时长上限或补足下限需短片）`);
      } catch (e) {
        log(`[bili-nurture] 主人空间查询失败（${e.message}）`);
      }
    }
  }
  const cache = s.plan.search;
  const fresh = cache && Array.isArray(cache.items) && cache.items.length && (Date.now() - Number(cache.at || 0) < SEARCH_TTL_MS);
  if (!fresh) {
    const kws = (Array.isArray(n.interestQueries) && n.interestQueries.length) ? n.interestQueries : ['AI 编程', '原神 剧情', '技术 教程'];
    const kw = pick1(kws);
    const items = await searchCandidates(kw);
    s.plan.search = { kw, at: Date.now(), items };
    if (!items.length) return { err: `搜索「${kw}」没有符合时长的候选` };
  }
  const items = s.plan.search.items;
  let idx = 0;
  if (needShort) {
    const shortIdx = items.findIndex((x) => Number(x.dur) > 0 && Number(x.dur) <= 600);
    if (shortIdx >= 0) idx = shortIdx;
  }
  const [item] = items.splice(idx, 1);
  return item ? { ...item, source: 'interest', kw: s.plan.search.kw } : { err: '候选已用完' };
}

/* ── 看一片（会话内的单位动作） ── */
async function watchOne(s) {
  const n = cfgN();
  const budget = Math.max(600, Number(n.dailyWatchSeconds) || 7200);
  const minVideos = Math.max(1, Number(n.dailyVideoMin) || 2);
  let cand = null;
  try {
    cand = await nextCandidate(s);
  } catch (e) {
    log(`[bili-nurture] 选片失败（${e.message}），本轮跳过`);
    return;
  }
  if (!cand || cand.err) { log(`[bili-nurture] ${cand?.err || '无候选'}，本轮跳过`); return; }
  const dur = Number(cand.dur) || 0;
  const exitSec = sampleExitSec(dur);
  if (s.plan.count >= minVideos && s.plan.watchSec + exitSec > budget) {
    s.plan.stopped = '观看预算用尽';
    log(`[bili-nurture] 预算用尽（已看 ${Math.round(s.plan.watchSec / 60)}/${Math.round(budget / 60)}min），今日收工`);
    return;
  }
  const w = await watchVideo(cand.bvid, exitSec, dur).catch((e) => ({ ok: false, why: e.message }));
  if (!w.ok) { log(`[bili-nurture] 观看失败《${cand.title}》: ${w.why}`); return; }
  s.plan.count += 1;
  s.plan.watchSec += w.played;
  const completion = w.dur > 0 ? w.played / w.dur : 0;
  const pct = Math.round(completion * 100);
  const likeCap = Math.max(0, Number(n.likePerDayMax) || 3);
  const minExit = Math.max(0, Number(n.likeMinExitSeconds) || 6);
  let likeNote = `抽签未中（p=${completion.toFixed(2)}）`;
  let likedFresh = false;
  const sameDay = String(s.lastLikedAid ?? '') === String(w.aid) && s.lastLikedDay === todayKey();
  if (s.likes >= likeCap) likeNote = `点赞额度已满（${s.likes}/${likeCap}）`;
  else if (sameDay) likeNote = '今日已赞过同片';
  else if (w.played < minExit) likeNote = `退出过早（${w.played}s）不赞`;
  else if (Math.random() < completion) {
    const l = await likeVideo(w.aid, w.bvid).catch((e) => ({ ok: false, why: e.message }));
    if (l.ok) {
      s.lastLikedAid = String(w.aid);
      s.lastLikedDay = todayKey();
      if (!l.idem) { s.likes += 1; likedFresh = true; }
      likeNote = l.idem ? '已赞过（幂等）' : '已赞';
    } else likeNote = `点赞失败（${l.why}）`;
  }

  /* ── 投币 / 关注 / 推荐到 QQ（2026-10-27 主人定规） ── */
  const act = n.actions ?? {};
  const acts = loadActions();
  const notes = [];
  const coinCfg = act.coin ?? {};
  if (coinCfg.enabled !== false && completion >= (Number(coinCfg.minCompletion) || 0.8) && !acts.coinAids.includes(String(w.aid))) {
    const dailyMax = Math.max(0, Number(coinCfg.dailyMax) || 5);
    const perVideoMax = Math.max(1, Math.min(2, Number(coinCfg.maxPerVideo) || 2));
    if (acts.coinSpent >= dailyMax) notes.push(`投币额度已满(${acts.coinSpent}/${dailyMax})`);
    else {
      const balance = await getCoinBalance().catch(() => null);
      if (balance === null) notes.push('投币跳过:余额查询失败');
      else {
        let cnt = Math.min(perVideoMax, dailyMax - acts.coinSpent);
        if (cnt >= 2 && Math.random() < 0.5) cnt = 2; else cnt = 1;
        while (cnt > 1 && balance - cnt < COIN_FLOOR) cnt -= 1;
        if (balance - cnt < COIN_FLOOR) notes.push(`投币跳过:余额${balance}不足保底${COIN_FLOOR}`);
        else {
          const c = await coinVideo(w.aid, cnt, w.bvid).catch((e) => ({ ok: false, why: e.message }));
          if (c.ok) {
            acts.coinSpent += cnt;
            acts.coinAids.push(String(w.aid));
            notes.push(`投币${cnt}枚(余额约${balance - cnt})`);
          } else notes.push(`投币失败(${c.why})`);
        }
      }
    }
  }
  const followCfg = act.follow ?? {};
  if (followCfg.enabled !== false && likedFresh && cand.source !== 'owner' && w.up
      && completion >= (Number(followCfg.minCompletion) || 0.85)) {
    const mid = String(w.up);
    const dailyMax = Math.max(0, Number(followCfg.dailyMax) || 1);
    const weeklyMax = Math.max(0, Number(followCfg.weeklyMax) || 3);
    if (acts.followed[mid]) notes.push('关注跳过:已关注');
    else if (acts.followToday >= dailyMax) notes.push(`关注跳过:日额度(${acts.followToday}/${dailyMax})`);
    else if (acts.followWeek >= weeklyMax) notes.push(`关注跳过:周额度(${acts.followWeek}/${weeklyMax})`);
    else if (Math.random() < (Number(followCfg.probability) || 0.25)) {
      const f = await followUser(mid).catch((e) => ({ ok: false, why: e.message }));
      if (f.ok) {
        acts.followed[mid] = todayKey();
        acts.followToday += 1;
        acts.followWeek += 1;
        notes.push(`关注UP${mid}${f.followed ? '(幂等)' : ''}`);
      } else notes.push(`关注失败(${f.why})`);
    }
  }
  const recCfg = act.recommend ?? {};
  const recBvid = String(w.bvid ?? cand.bvid ?? '');
  if (recCfg.enabled !== false && cand.source !== 'owner' && recBvid
      && completion >= (Number(recCfg.minCompletion) || 0.75) && !acts.recBvids.includes(recBvid)) {
    const dailyMax = Math.max(0, Number(recCfg.dailyMax) || 2);
    if (acts.recCount >= dailyMax) notes.push(`推荐跳过:日额度(${acts.recCount}/${dailyMax})`);
    else if (Math.random() < (Number(recCfg.probability) || 0.6)) {
      const ok = await notifyOwnerCard(cfgRef, { title: w.title, bvid: recBvid, pic: w.pic, upName: w.upName, dur: w.dur });
      if (ok) {
        acts.recCount += 1;
        acts.recBvids.push(recBvid);
        acts.recBvids = acts.recBvids.slice(-200);
        notes.push('已推荐到QQ');
      } else notes.push('推荐发送失败');
    }
  }
  if (notes.length) saveActions(acts);
  const label = cand.source === 'owner' ? '主人片' : `兴趣片[${cand.kw ?? ''}]`;
  const extra = notes.length ? `｜${notes.join('｜')}` : '';
  log(`[bili-nurture] ${label}《${cand.title}》${w.played}/${w.dur}s（完播 ${pct}%）｜${likeNote}${extra}｜今日 ${s.plan.count}/${s.plan.quota} 片 · ${Math.round(s.plan.watchSec / 60)}min`);
}

/* ── 调度 ── */
async function tick() {
  nurtureTimer = null;
  const n = cfgN();
  if (n.enabled !== true) { log('[bili-nurture] 配置已关闭，停止排程'); return; }
  const now = Date.now();
  const s = loadState(now);
  if (!s.plan || s.plan.day !== s.day || !Array.isArray(s.plan.sessions)) {
    s.plan = generatePlan(now);
    saveSt(s);
    logPlan(s.plan);
  }
  if (s.plan.stopped) return scheduleNext(s);
  const quota = Math.max(2, Number(s.plan.quota) || 2);
  const budget = Math.max(600, Number(n.dailyWatchSeconds) || 7200);
  const minVideos = Math.max(1, Number(n.dailyVideoMin) || 2);
  if (s.plan.count >= quota) { s.plan.stopped = '额度完成'; saveSt(s); log(`[bili-nurture] 今日额度完成：${s.plan.count} 片 / ${Math.round(s.plan.watchSec / 60)}min`); return scheduleNext(s); }
  if (s.plan.count >= minVideos && s.plan.watchSec >= budget) { s.plan.stopped = '观看预算用尽'; saveSt(s); log(`[bili-nurture] 观看预算用尽：${s.plan.count} 片 / ${Math.round(s.plan.watchSec / 60)}min`); return scheduleNext(s); }
  const sess = currentSession(s.plan, now);
  if (!sess) {
    const hasUpcoming = (s.plan.sessions || []).some((x) => Number(x.start) > now);
    if (s.plan.count < minVideos && !hasUpcoming) {
      const cu = catchUpSession(s.plan, now);
      if (cu) { s.plan.sessions.push(cu); saveSt(s); log(`[bili-nurture] 片数不足 ${minVideos}，加收尾时段 ${fmtClock(cu.start)}~${fmtClock(cu.end)}（${cu.win}）`); return tick(); }
    }
    return scheduleNext(s);
  }
  /* 熔断共享：养号/M3/MCP 搜索任一撞风控，同账号同 IP 一起停 */
  if (circuitOpen(BILI_CIRCUIT_FILE)) {
    const c = circuitState(BILI_CIRCUIT_FILE);
    s.plan.stopped = '熔断';
    saveSt(s);
    log(`[bili-nurture] 熔断中（${c.scope || 'bili'} 码 ${c.code}，停至 ${new Date(c.until).toISOString()}），今日停`);
    return scheduleNext(s);
  }
  const quiet = Array.isArray(n.quiet) ? n.quiet : [1, 8];
  if (bjHour(now) >= quiet[0] && bjHour(now) < quiet[1]) { return scheduleNext(s); }
  try {
    if (!(await checkIsLogin({ authFile: AUTH_FILE, circuitFile: BILI_CIRCUIT_FILE, scope: 'nurture' }))) {
      s.plan.stopped = '登录失效';
      saveSt(s);
      log('[bili-nurture] B站登录已过期，今日停（等重导 cookie）');
      return scheduleNext(s);
    }
  } catch (e) {
    if (/登录失效/.test(String(e?.message ?? ''))) {
      s.plan.stopped = '登录失效';
      saveSt(s);
      log(`[bili-nurture] 登录态失效（${e.message}），今日停`);
      return scheduleNext(s);
    }
  }
  await watchOne(s);
  saveSt(s);
  return scheduleNext(s);
}

function scheduleNext(s) {
  if (nurtureTimer) { clearTimeout(nurtureTimer); nurtureTimer = null; }
  const now = Date.now();
  const plan = s?.plan;
  const sessions = Array.isArray(plan?.sessions) ? plan.sessions : [];
  const inSess = currentSession(plan, now);
  let delay;
  if (inSess) {
    delay = rnd(GAP_MIN_SEC, GAP_MAX_SEC) * 1000;            /* 会话内：看完歇 20~90 秒 */
    delay = Math.min(delay, Math.max(5000, Number(inSess.end) - now));
  } else {
    const upcoming = sessions.map((x) => Number(x.start)).filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b);
    if (upcoming.length) delay = upcoming[0] - now;
    else delay = Math.max(60000, dayStart(now) + 24 * 3600 * 1000 + 10 * 60000 - now);
  }
  delay = Math.max(5000, Math.min(delay, 6 * 3600 * 1000));
  nurtureTimer = setTimeout(() => tick().catch((e) => { log(`[bili-nurture] 轮异常：${e.message}`); scheduleNext(loadState()); }), delay);
  nurtureTimer.unref?.();
}

export function initBiliNurtureCore(cfg) { cfgRef = cfg; }
export function startBiliNurture() {
  if (nurtureTimer) { clearTimeout(nurtureTimer); nurtureTimer = null; }
  const n = cfgN();
  if (n.enabled !== true) { log('[bili-nurture] 未启用（social.bilibili.nurture.enabled !== true）'); return; }
  if (!fs.existsSync(AUTH_FILE)) { log('[bili-nurture] 无登录态（state/bilibili-auth.json 不存在），不启动'); return; }
  const s = loadState();
  if (!s.plan || s.plan.day !== s.day || !Array.isArray(s.plan.sessions)) {
    s.plan = generatePlan();
    saveSt(s);
  }
  logPlan(s.plan);
  nurtureTimer = setTimeout(() => tick().catch((e) => { log(`[bili-nurture] 首轮异常：${e.message}`); scheduleNext(loadState()); }), 5000);
  nurtureTimer.unref?.();
}

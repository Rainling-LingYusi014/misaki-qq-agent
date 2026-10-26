/* ══════════════════════════════════════════════════════════════════════════
 * B 站养号实验（2026-10-26，M2，主人定规）
 *
 * 边界（主人四条限制的 M2 子集，硬编码闸门）：
 *   · 只「观看」（播放心跳上报）与「点赞」——不评论/不私信/不关注/不投币/不收藏/不发动态
 *   · 点赞仅限白名单 UID 的视频（当前=主人 UID），且「先看后赞」
 *   · 不投币、不收藏（用户明定暂不做）
 *   · 风控特征码（-412/-352 等）出现 → 当天立即停 + 记录
 * 调度：每天随机 1~3 轮、北京 01:00~08:00 不跑、轮间隔 3~8h、首轮启动后 2~6min（链路验证）。
 * 登录：复用 state/bilibili-auth.json（M1 的登录态；失效时本轮跳过并记日志，不自动重登）。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';

const AUTH_FILE = path.join(STATE_DIR, 'bilibili-auth.json');
const NURTURE_FILE = path.join(STATE_DIR, 'bili-nurture.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BJ = 8 * 3600 * 1000;
const RISK_CODES = [-412, -352, -111, -101];

let cfgRef = null;
let nurtureTimer = null;

/* ── 基础 ── */
const authCookie = () => {
  const d = readJsonSafe(AUTH_FILE, {});
  return Object.entries(d).filter(([k]) => !['savedAt', 'mode', 'fingerprint'].includes(k)).map(([k, v]) => `${k}=${v}`).join('; ');
};
const bjHour = (nowMs = Date.now()) => new Date(nowMs + BJ).getUTCHours();
const todayKey = (nowMs = Date.now()) => new Date(Number(nowMs) + BJ).toISOString().slice(0, 10);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick1 = (arr) => arr[Math.floor(Math.random() * arr.length)];

function st() {
  const s = readJsonSafe(NURTURE_FILE, { day: '', rounds: 0, likes: 0, quitUntil: 0 });
  if (s.day !== todayKey()) { s.day = todayKey(); s.rounds = 0; s.likes = 0; }
  return s;
}
const saveSt = (s) => atomicWriteJson(NURTURE_FILE, s);

async function biliFetch(url, { method = 'GET', body = '', extraRef = '' } = {}) {
  const cookie = authCookie();
  const headers = { 'user-agent': UA, referer: extraRef || 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(url, { method, headers, ...(body ? { body } : {}) });
  const j = await res.json().catch(() => ({ code: -999, message: `HTTP ${res.status}` }));
  if (RISK_CODES.includes(Number(j.code))) throw new Error(`风控码 ${j.code}（${j.message ?? ''}）`);
  return j;
}

/* Wbi 签名（space 搜索用；与 mcp 工具同款算法） */
const WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const enc = (s) => encodeURIComponent(String(s)).replace(/[!'"()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
async function wbiSign(params) {
  const nav = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const imgKey = nav.data.wbi_img.img_url.split('/').pop().split('.')[0];
  const subKey = nav.data.wbi_img.sub_url.split('/').pop().split('.')[0];
  const mixin = WBI_TAB.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32);
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const qs = Object.keys(p).sort().map((k) => encodeURIComponent(k) + '=' + enc(p[k])).join('&');
  return qs + '&w_rid=' + crypto.createHash('md5').update(qs + mixin).digest('hex') + '&wts=' + p.wts;
}

/* ── 行为原语 ── */
/** 观看一个视频：view 拿 cid → start / 心跳 / end 三次 click 上报，总时长 watchSec 秒（分片拟人）。 */
async function watchVideo(bvid, watchSec) {
  const v = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { extraRef: 'https://www.bilibili.com/video/' + bvid });
  if (v.code !== 0) return { ok: false, why: `view code=${v.code}` };
  const { aid, cid } = { aid: v.data.aid, cid: v.data.cid };
  const click = (playType, played) => biliFetch('https://api.bilibili.com/x/click-interface/click/web/h5', {
    method: 'POST',
    extraRef: 'https://www.bilibili.com/video/' + bvid,
    body: `aid=${aid}&cid=${cid}&part=1&lv=0&ftime=${Math.floor(Date.now() / 1000) - played}&stime=${Math.floor(Date.now() / 1000)}&type=4&sub_type=0&platform=h5&played_time=${played}&play_type=${playType}`,
  }).then((j) => j.code).catch((e) => e.message);
  const c1 = await click(1, 0);
  const heartbeats = Math.max(1, Math.round(watchSec / 60));
  for (let i = 1; i <= heartbeats; i++) {
    await sleep(Math.round(watchSec * 1000 / heartbeats));
    await click(0, Math.round((watchSec * i) / heartbeats));
  }
  const c2 = await click(2, watchSec);
  return { ok: true, title: String(v.data.title).slice(0, 40), up: v.data.owner?.mid, play: c1 === 0 && c2 === 0 ? 'reported' : `codes(${c1}/${c2})` };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点赞（硬闸：仅白名单 UID 的视频；调用方必须已 watch 同一视频——先看后赞）。 */
async function likeVideo(aid, uploaderMid, bvid) {
  const n = cfgRef?.social?.bilibili?.nurture ?? {};
  const white = (Array.isArray(n.whiteUids) ? n.whiteUids : []).map(String);
  if (!white.includes(String(uploaderMid))) return { ok: false, why: `uploader ${uploaderMid} 不在白名单（硬闸）` };
  const d = readJsonSafe(AUTH_FILE, {});
  const csrf = d.bili_jct ?? '';
  if (!csrf) return { ok: false, why: '无 csrf' };
  const j = await biliFetch('https://api.bilibili.com/x/web-interface/archive/like', {
    method: 'POST', extraRef: 'https://www.bilibili.com/video/' + bvid,
    body: `id=${aid}&like=1&csrf=${encodeURIComponent(csrf)}`,
  });
  if (j.code === 0 || j.code === 65004) return { ok: true, idem: j.code === 65004 };
  return { ok: false, why: `like code=${j.code} ${j.message ?? ''}` };
}

/* ── 选片 ── */
async function pickInterestVideo() {
  const n = cfgRef?.social?.bilibili?.nurture ?? {};
  const kw = pick1(Array.isArray(n.interestQueries) && n.interestQueries.length ? n.interestQueries : ['AI 编程', '原神 剧情', '技术 教程']);
  const qs = await wbiSign({ keyword: kw, search_type: 'video', page: 1 });
  const j = await biliFetch('https://api.bilibili.com/x/web-interface/search/type?' + qs, { extraRef: 'https://search.bilibili.com/' });
  const rows = (j.data?.result ?? []).filter((r) => r.bvid);
  if (!rows.length) return null;
  const r = pick1(rows.slice(0, 5)); // 前5随机挑1（拟人：不总看第一名）
  return { bvid: r.bvid, title: String(r.title).replace(/<[^>]+>/g, '').slice(0, 40), up: r.owner?.mid ?? r.mid };
}
async function pickOwnerLatestVideo(ownerUid) {
  const qs = await wbiSign({ mid: String(ownerUid), pn: 1, ps: 3, order: 'pubdate' });
  const j = await biliFetch('https://api.bilibili.com/x/space/wbi/arc/search?' + qs, { extraRef: `https://space.bilibili.com/${ownerUid}/video` });
  const v0 = j.data?.list?.vlist?.[0];
  return v0 ? { bvid: v0.bvid, title: String(v0.title).slice(0, 40), up: ownerUid, aid: v0.aid } : null;
}

/* ── 一轮 ── */
async function nurtureRound() {
  const s = st();
  const n = cfgRef?.social?.bilibili?.nurture ?? {};
  const maxRounds = Array.isArray(n.roundsPerDay) ? rnd(n.roundsPerDay[0], n.roundsPerDay[1]) : 2;
  if (s.rounds >= maxRounds) { log(`[bili-nurture] 今日轮数已满（${s.rounds}/${maxRounds}），跳过`); scheduleNext(); return; }
  if (s.quitUntil > Date.now()) { log('[bili-nurture] 风控冷静期中，跳过'); scheduleNext(); return; }
  const quiet = Array.isArray(n.quiet) ? n.quiet : [1, 8];
  if (bjHour() >= quiet[0] && bjHour() < quiet[1]) { log('[bili-nurture] 静默时段，跳过'); scheduleNext(); return; }

  const watchSec = rnd(50, 150);
  const results = [];
  /* 片1：兴趣视频（无社交行为，纯看） */
  const interest = await pickInterestVideo().catch(() => null);
  if (interest) {
    const w = await watchVideo(interest.bvid, watchSec).catch((e) => ({ ok: false, why: e.message }));
    results.push(`兴趣片《${interest.title}》: ${w.ok ? 'watched' : w.why}`);
  }
  /* 片2：主人最新视频（先看后赞，白名单硬闸在 likeVideo 内） */
  const ownerUid = n.ownerUid ?? (Array.isArray(n.whiteUids) ? n.whiteUids[0] : '');
  if (ownerUid) {
    const own = await pickOwnerLatestVideo(ownerUid).catch(() => null);
    if (own) {
      const w = await watchVideo(own.bvid, watchSec).catch((e) => ({ ok: false, why: e.message }));
      results.push(`主人片《${own.title}》: ${w.ok ? 'watched' : w.why}`);
      if (w.ok && s.likes < (Number(n.likePerDayMax) || 2) && own.aid) {
        const l = await likeVideo(own.aid, own.up, own.bvid).catch((e) => ({ ok: false, why: e.message }));
        if (l.ok && !l.idem) { s.likes += 1; saveSt(s); }
        results.push(`  点赞: ${l.ok ? (l.idem ? '已赞过(幂等)' : 'ok') : l.why}`);
      }
    } else results.push('主人暂无投稿，跳过');
  }
  s.rounds += 1; saveSt(s);
  log(`[bili-nurture] 第 ${s.rounds} 轮（今日 likes=${s.likes}）：${results.join('；')}`);
  scheduleNext();
}

function scheduleNext() {
  if (nurtureTimer) { clearTimeout(nurtureTimer); nurtureTimer = null; }
  const n = cfgRef?.social?.bilibili?.nurture ?? {};
  const quiet = Array.isArray(n.quiet) ? n.quiet : [1, 8];
  let delay = rnd(3 * 3600, 8 * 3600) * 1000;
  /* 落静默窗则推到窗尾 */
  const nextHour = bjHour(Date.now() + delay);
  if (nextHour >= quiet[0] && nextHour < quiet[1]) {
    const now = new Date(Date.now() + BJ);
    const nextQuietEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), quiet[1]) - BJ;
    delay = Math.max(delay, nextQuietEnd - Date.now() + rnd(10, 90) * 60000);
  }
  nurtureTimer = setTimeout(() => nurtureRound().catch((e) => { log(`[bili-nurture] 轮异常：${e.message}`); scheduleNext(); }), delay);
  nurtureTimer.unref?.();
}

export function initBiliNurtureCore(cfg) { cfgRef = cfg; }
export function startBiliNurture() {
  if (nurtureTimer) { clearTimeout(nurtureTimer); nurtureTimer = null; }
  const n = cfgRef?.social?.bilibili?.nurture ?? {};
  if (n.enabled !== true) { log('[bili-nurture] 未启用（social.bilibili.nurture.enabled !== true）'); return; }
  if (!fs.existsSync(AUTH_FILE)) { log('[bili-nurture] 无登录态（state/bilibili-auth.json 不存在），不启动'); return; }
  const first = rnd(2, 6) * 60000;
  nurtureTimer = setTimeout(() => nurtureRound().catch((e) => { log(`[bili-nurture] 首轮异常：${e.message}`); scheduleNext(); }), first);
  nurtureTimer.unref?.();
  log(`[bili-nurture] 已启动（实验）：${rnd(Array.isArray(n.roundsPerDay) ? n.roundsPerDay[0] : 1, Array.isArray(n.roundsPerDay) ? n.roundsPerDay[1] : 3)} 轮/天，点赞上限 ${n.likePerDayMax ?? 2}/天（白名单 ${(n.whiteUids ?? []).length} 人），首轮 ${Math.round(first / 60000)}min 后`);
}

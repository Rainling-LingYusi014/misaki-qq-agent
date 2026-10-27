/* ══════════════════════════════════════════════════════════════════════════
 * B 站社交动作共享层（2026-10-27 主人定规）
 *   · 投币：日上限 5、单次最多 2、**每次投币后余额不得低于 6**（改名储备金）
 *   · 关注：日 1 / 周 3、永不取关；资格=看过并赞过的作者（桥侧）或主人点名（工具侧）
 *   · 推荐到 QQ：桥侧模板文案，零 token，日上限 2
 * 配额状态落 state/bili-social-actions.json（按北京日/周滚动）。协议单源走 lib/bili-api.js。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { readJsonSafe, atomicWriteJson } from './json-fs.js';
import { log } from './log.js';
import { biliJson, wbiSign, BILI_AUTH_FILE, BILI_CIRCUIT_FILE } from './bili-api.js';

const ACTIONS_FILE = path.join(STATE_DIR, 'bili-social-actions.json');
const BJ = 8 * 3600 * 1000;

/** 改名储备金：任何时刻余额都不得低于这个数 */
export const COIN_FLOOR = 6;

/** 与点赞相同的设备标识 query（缺任一即 -400，10-26 实测） */
export const BILI_DEVQ = 'x-bili-locale-json=%7B%22c_locale%22:%7B%22language%22:%22zh%22,%22script%22:%22Hans%22%7D,%22always_translate%22:false%7D&x-bili-device-req-json=%7B%22platform%22:%22web%22,%22device%22:%22pc%22,%22spmid%22:%22333.788%22,%22mobi_app%22:%22web_cn%22%7D';

const todayKey = (ms = Date.now()) => new Date(ms + BJ).toISOString().slice(0, 10);
function weekKey(ms = Date.now()) {
  const d = new Date(ms + BJ);
  const dow = (d.getUTCDay() + 6) % 7; /* 周一=0 */
  const mon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  return new Date(mon).toISOString().slice(0, 10);
}

export function loadActions(now = Date.now()) {
  const a = readJsonSafe(ACTIONS_FILE, {});
  const t = todayKey(now);
  if (a.coinDay !== t) { a.coinDay = t; a.coinSpent = 0; a.coinAids = []; }
  if (a.followDay !== t) { a.followDay = t; a.followToday = 0; }
  if (a.week !== weekKey(now)) { a.week = weekKey(now); a.followWeek = 0; }
  if (a.recDay !== t) { a.recDay = t; a.recCount = 0; }
  if (a.sendVideoDay !== t) { a.sendVideoDay = t; a.sendVideoCount = 0; }
  a.followed = (a.followed && typeof a.followed === 'object') ? a.followed : {};
  a.coinAids = Array.isArray(a.coinAids) ? a.coinAids : [];
  a.recBvids = Array.isArray(a.recBvids) ? a.recBvids : [];
  return a;
}
export const saveActions = (a) => atomicWriteJson(ACTIONS_FILE, a);

/* ── 凭据 ── */
function cookieHeader() {
  const d = readJsonSafe(BILI_AUTH_FILE, {});
  const src = (d.cookies && typeof d.cookies === 'object') ? d.cookies : d;
  return Object.entries(src)
    .filter(([k]) => typeof k === 'string' && k)
    .map(([k, v]) => `${k}=${v && typeof v === 'object' ? v.value : v}`)
    .join('; ');
}
function csrfToken() {
  return String(readJsonSafe(BILI_AUTH_FILE, {}).bili_jct ?? '');
}

/** 当前硬币余额（nav 的 money 字段）。失败返回 null，调用方一律按"不可投"处理。
 *  2026-10-27（审查 P2-3）：原来这里直连 nav 且自带 Chrome/131 UA，与单源 Chrome/126
 *  构成「同端点两种 UA」的风控特征；改走 biliJson 单源（UA / HTTP 412 归一 / 共享熔断一致）。 */
export async function getCoinBalance() {
  const ck = cookieHeader();
  if (!ck) return null;
  try {
    const j = await biliJson('https://api.bilibili.com/x/web-interface/nav', {
      cookie: ck,
      scope: 'coin',
      circuitFile: BILI_CIRCUIT_FILE,
      authFile: BILI_AUTH_FILE,
    });
    const n = Number(j?.data?.money);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 投币。n=1|2。返回 {ok, capped?, why?}。34005=已达上限，按幂等成功处理。 */
export async function coinVideo(aid, n, bvid = '') {
  const csrf = csrfToken();
  if (!csrf) return { ok: false, why: '无 csrf' };
  const mult = Math.max(1, Math.min(2, Number(n) || 1));
  try {
    const j = await biliJson('https://api.bilibili.com/x/web-interface/coin/add?' + BILI_DEVQ, {
      method: 'POST',
      body: `aid=${aid}&multiply=${mult}&select_like=0&cross_domain=true&csrf=${encodeURIComponent(csrf)}`,
      referer: `https://www.bilibili.com/video/${bvid}`,
      scope: 'coin',
      circuitFile: BILI_CIRCUIT_FILE,
      authFile: BILI_AUTH_FILE,
    });
    if (j.code === 0) return { ok: true };
    if (j.code === 34005) return { ok: true, capped: true }; /* 今日已投满/已达该视频上限 */
    return { ok: false, why: `coin code=${j.code} ${j.message ?? ''}` };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

/** 关注一个 mid（不取关）。22014=已关注，按幂等成功。 */
export async function followUser(mid) {
  const target = String(mid ?? '').trim();
  if (!/^\d{1,16}$/.test(target)) return { ok: false, why: 'mid 必须是纯数字' };
  const csrf = csrfToken();
  if (!csrf) return { ok: false, why: '无 csrf' };
  try {
    const j = await biliJson('https://api.bilibili.com/x/relation/modify?' + BILI_DEVQ, {
      method: 'POST',
      body: `fid=${target}&act=1&re_src=11&csrf=${encodeURIComponent(csrf)}`,
      referer: `https://space.bilibili.com/${target}`,
      scope: 'follow',
      circuitFile: BILI_CIRCUIT_FILE,
      authFile: BILI_AUTH_FILE,
    });
    if (j.code === 0) return { ok: true };
    if (j.code === 22014) return { ok: true, followed: true };
    return { ok: false, why: `follow code=${j.code} ${j.message ?? ''}` };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

/** 推荐卡片（2026-10-27 主人二次定版）：第 1 行标题 → 封面图 → UP昵称/时长/链接（各占一行）。
 *  零 token：数据全部来自观看链路，不经模型。封面拉取失败时自动退回纯文本。 */
export async function notifyOwnerCard(cfg, { title, bvid, pic, upName, dur }) {
  const base = String(cfg?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const uid = String(cfg?.ownerQQ ?? '').trim();
  if (!uid || !bvid) return false;
  const mmss = (sec) => {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  const head = `《${title}》`;
  const tail = [];
  if (upName) tail.push(`UP：${upName}`);
  if (dur) tail.push(`时长：${mmss(dur)}`);
  tail.push(`https://b23.tv/${bvid}?share_medium=android&share_source=qq`);
  const tailText = tail.join('\n');
  const send = async (message) => {
    try {
      const res = await fetch(`${base}/send_private_msg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg?.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {}) },
        body: JSON.stringify({ user_id: Number(uid), message }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json().catch(() => ({}));
      return j?.status === 'ok' || j?.retcode === 0;
    } catch (e) {
      log(`[bili-social] 卡片发送异常：${e?.message ?? e}`);
      return false;
    }
  };
  if (pic && /^https?:\/\//.test(String(pic))) {
    const ok = await send([
      { type: 'text', data: { text: head } },
      { type: 'image', data: { file: String(pic) } },
      { type: 'text', data: { text: tailText } },
    ]);
    if (ok) return true;
    log('[bili-social] 封面卡发送失败，退回纯文本');
  }
  return send(`${head}\n${tailText}`);
}

/** 给主人发一条 QQ 私聊（推荐用；零 token，纯模板文案）。 */
export async function notifyOwner(cfg, text) {
  const base = String(cfg?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const uid = String(cfg?.ownerQQ ?? '').trim();
  if (!uid) return false;
  try {
    const res = await fetch(`${base}/send_private_msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg?.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {}) },
      body: JSON.stringify({ user_id: Number(uid), message: text, auto_escape: false }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (j?.status === 'ok' || j?.retcode === 0) return true;
    log(`[bili-social] 推荐发送失败：${j?.message || j?.wording || res.status}`);
    return false;
  } catch (e) {
    log(`[bili-social] 推荐发送异常：${e?.message ?? e}`);
    return false;
  }
}

/* ── 用户搜索（2026-10-27 补：此前她只有视频搜索，于是把"我没有工具"说成"B站搜不到昵称"）── */
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').trim();
function parseDur(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const s = String(v ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const p = s.split(':').map(Number);
  return p.some((x) => !Number.isFinite(x)) ? 0 : p.reduce((a, b) => a * 60 + b, 0);
}

/** 按昵称（或数字 mid）查 B 站用户，返回 mid/昵称/等级/粉丝 + 最近视频。
 *  search_type=bili_user 是真实存在的接口（2026-10-27 实测：搜「泠雨丝」第一条即主人号）。 */
export async function searchBiliUsers(query, limit = 5) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, why: 'query 为空' };
  const opts = { authFile: BILI_AUTH_FILE, circuitFile: BILI_CIRCUIT_FILE, scope: 'user-search' };
  const cap = Math.max(1, Math.min(10, Number(limit) || 5));
  if (/^\d{4,16}$/.test(q)) {
    const qs = await wbiSign({ mid: q, pn: 1, ps: 5, order: 'pubdate' }, opts);
    const j = await biliJson('https://api.bilibili.com/x/space/wbi/arc/search?' + qs, { ...opts, referer: `https://space.bilibili.com/${q}/video` });
    const list = j?.data?.list?.vlist ?? [];
    return {
      ok: true,
      query: q,
      users: [{
        mid: q,
        uname: String(list[0]?.author ?? ''),
        level: null,
        fans: null,
        videos: Number(j?.data?.page?.count ?? list.length) || list.length,
        latest: list.slice(0, 3).map((v) => ({ bvid: v.bvid, title: stripTags(v.title), duration: parseDur(v.length) })),
      }],
    };
  }
  const qs = await wbiSign({ keyword: q, search_type: 'bili_user', page: 1 }, opts);
  const j = await biliJson('https://api.bilibili.com/x/web-interface/search/type?' + qs, { ...opts, referer: 'https://search.bilibili.com/' });
  const rows = (j?.data?.result ?? []).slice(0, cap).map((r) => ({
    mid: String(r.mid),
    uname: stripTags(r.uname),
    level: Number(r.level) || null,
    fans: Number(r.fans) || 0,
    videos: Number(r.videos) || 0,
    sign: stripTags(r.usign).slice(0, 40),
    latest: (Array.isArray(r.res) ? r.res : []).slice(0, 3).map((v) => ({ bvid: v.bvid, title: stripTags(v.title), duration: parseDur(v.duration) })),
  }));
  return { ok: true, query: q, users: rows };
}

/** 把一个视频按定版卡片发到指定 QQ 私聊（标题 → 封面 → UP昵称/时长/链接）。
 *  配额落 bili-social-actions.json（日上限由调用方传入，默认 5）。 */
export async function sendVideoCard({ cfg, targetUid, bvid, dailyMax = 5 }) {
  const uid = String(targetUid ?? '').trim();
  const bv = String(bvid ?? '').trim();
  if (!uid || !/^\d{5,12}$/.test(uid)) return { ok: false, why: 'targetUid 非法' };
  if (!/^BV[0-9A-Za-z]{8,12}$/.test(bv)) return { ok: false, why: 'bvid 非法' };
  const acts = loadActions();
  if (acts.sendVideoCount >= Math.max(0, Number(dailyMax) || 5)) {
    return { ok: false, why: `今日发卡已达上限 ${dailyMax} 条` };
  }
  const opts = { authFile: BILI_AUTH_FILE, circuitFile: BILI_CIRCUIT_FILE, scope: 'send-video' };
  const v = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { ...opts, referer: `https://www.bilibili.com/video/${bv}` });
  if (v.code !== 0) return { ok: false, why: `view code=${v.code} ${v.message ?? ''}` };
  const d = v.data ?? {};
  const mmss = (sec) => {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  const head = `《${stripTags(d.title)}》`;
  const tail = [];
  if (d.owner?.name) tail.push(`UP：${d.owner.name}`);
  if (d.duration) tail.push(`时长：${mmss(d.duration)}`);
  tail.push(`https://b23.tv/${bv}?share_medium=android&share_source=qq`);
  const tailText = tail.join('\n');
  const segments = [];
  if (d.pic && /^https?:\/\//.test(String(d.pic))) {
    segments.push({ type: 'text', data: { text: head } });
    segments.push({ type: 'image', data: { file: String(d.pic) } });
    segments.push({ type: 'text', data: { text: tailText } });
  } else {
    segments.push({ type: 'text', data: { text: `${head}\n${tailText}` } });
  }
  const base = String(cfg?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/send_private_msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg?.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {}) },
      body: JSON.stringify({ user_id: Number(uid), message: segments }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!(j?.status === 'ok' || j?.retcode === 0)) return { ok: false, why: j?.message || j?.wording || `http ${res.status}` };
    acts.sendVideoCount += 1;
    saveActions(acts);
    return { ok: true, bvid: bv, title: stripTags(d.title), duration: Number(d.duration) || 0, remaining: Math.max(0, Number(dailyMax) - acts.sendVideoCount) };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

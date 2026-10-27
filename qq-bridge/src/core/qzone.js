// M2 空间说说
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, ROOT } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { initMemoryDb } from './memory.js';

let cfgRef = null;
export function initQzoneCore(cfg) { cfgRef = cfg; }

/* 曲库池（2026-10-27 v3）：assets/qzone-pool.json 由《空间文案池_定稿审阅_20261027.md》生成，
 * 按类目权重抽（日常侧写 15% / 工作痕迹 15% / 治愈短句 70%），类目内均匀随机。
 * 文件缺失/不可读时退回下面的内置兜底池——宁可发一条旧的，也不要因为缺文件而不发。
 * 缓存按 mtime 失效：改池文件后下次选文即生效，无需重启。 */
const QZONE_POOL_FILE = path.join(ROOT, 'assets', 'qzone-pool.json');
let qzonePoolCache = null;
let qzonePoolMtime = 0;

export function loadQzonePool() {
  try {
    const st = fs.statSync(QZONE_POOL_FILE);
    if (qzonePoolCache !== null && st.mtimeMs === qzonePoolMtime) return qzonePoolCache;
    const j = readJsonSafe(QZONE_POOL_FILE, null);
    const cats = Array.isArray(j?.categories)
      ? j.categories.filter((c) => Array.isArray(c?.items) && c.items.length)
      : [];
    qzonePoolCache = cats.length ? { version: String(j.version ?? ''), cats } : null;
    qzonePoolMtime = st.mtimeMs;
  } catch {
    qzonePoolCache = null;
  }
  return qzonePoolCache;
}

export function pickFromQzonePool() {
  const p = loadQzonePool();
  if (!p) return null;
  const weights = p.cats.map((c) => { const w = Number(c.weight); return Number.isFinite(w) && w > 0 ? w : 0; });
  const totalW = weights.reduce((a, b) => a + b, 0) || p.cats.length;
  let r = Math.random() * totalW;
  let idx = p.cats.length - 1;
  for (let i = 0; i < p.cats.length; i++) {
    r -= weights[i];
    if (r <= 0) { idx = i; break; }
  }
  const cat = p.cats[idx];
  const it = cat.items[Math.floor(Math.random() * cat.items.length)];
  const text = typeof it === 'string' ? it : String(it?.text ?? '');
  if (!text) return null;
  return { text, id: typeof it === 'string' ? '' : String(it?.id ?? ''), catName: String(cat.name ?? cat.id ?? '') };
}

export async function postRandomQzone() {
  const napcatBase = String(cfgRef.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  // 兜底说说池（角色无关的短句，情绪/日常向）。角色人设由 persona 决定，这里只保证
  // 「模型没给正文时也发得出一条像人写的说说」，不与任何具体角色绑定。
  const pool = [
    '今天也在好好过。日子这么长，事情这么多，我只是一件一件慢慢做。',
    '有人问我为什么总在这种时候说话。我说，因为安静的时候，人容易想起没说完的事。',
    '灯关了以后，房间比白天更大。有些话就是在这种时候想清楚的。',
    '想念是一种很轻的东西，轻到一阵风就能吹动；又很重，重到一整天都放不下。',
    '愿你每天都有事可做，有人可说，有一件小事值得你晚睡。',
    '时间像一场远游，我在途中学会了告别，也学会了在告别里长出生气。',
    '今天走得很慢，像在等什么。后来想明白了：我只是不想那么快到家。',
    '在意一个人是很轻的事，轻到一句话就能说明；又很重，重到一整年都说不完。',
    '错过不可怕，可怕的是没来得及把想说的话说完。所以我现在就说了：你好呀。',
    '我就是我，没什么特别，但每天都过得还算认真。这大概就是我的全部浪漫。'
  ];
  const picked = pickFromQzonePool();
  const content = picked?.text ?? pool[Math.floor(Math.random() * pool.length)];
  const fromPool = picked ? `（${picked.catName}${picked.id ? ' ' + picked.id : ''}）` : '（内置兜底池）';
  const body = { content };
  const res = await fetch(`${napcatBase}/send_qzone_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfgRef.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const j = await res.json().catch(() => ({}));
  if (j.status !== 'ok' || j.retcode !== 0) throw new Error(`OneBot send_qzone_msg: ${j.message || j.wording || res.status}`);
  // 记录到自己空间记忆：让 AI 知道自己发过这条说说
  try {
    const uid = String(cfgRef.ownerQQ ?? '');
    const db = initMemoryDb();
    if (db) {
      db.prepare('INSERT INTO memory_entries (uid, category, content, created_at) VALUES (?, ?, ?, ?)')
        .run(uid, 'qzone_post', `我主动发了一条空间说说：${content}`, Date.now());
    }
  } catch {}
  log(`[qzone] 主动发说说成功${fromPool}: ${content.slice(0, 30)}…`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 自动点赞巡航（2026-10-26，用户需求「QQ空间自动点赞」）
 *
 * 设计：名单制——只巡 config social.qzone.autoLike.uids 里的人（默认空=不巡任何人），
 * 每轮逐人拉最新动态，对「没赞过的新 tid」点赞。去重与当日计数落 state/qzone-liked.json。
 *
 * 为什么名单制而不是「好友动态流」：①QZone 的好友聚合流接口没有稳定封装，逐人
 * msglist 是 qq_qzone_view 同款现役路径；②新号行为风控敏感，点赞对象明确可控
 * （只赞主人指定的人）比「巡到谁赞谁」安全得多。
 *
 * 保守默认（可配）：120 分钟一轮、每轮每人最多 1 条 / 总共 3 条、每天上限 12 赞、
 * 深夜（北京 1-6 点）不巡。autoLike.enabled 默认 false——新号养几天再开。
 * ══════════════════════════════════════════════════════════════════════════ */

const LIKED_FILE = path.join(STATE_DIR, 'qzone-liked.json');

async function napcatOnebot(action, params = {}) {
  const base = String(cfgRef.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfgRef.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  return res.json().catch(() => ({}));
}

/** 拿 QZone 登录态（NapCat get_cookies，qzone.qq.com 域），算 gtk。 */
async function qzoneAuth() {
  const j = await napcatOnebot('get_cookies', { domain: 'qzone.qq.com' });
  const cookies = String(j?.data?.cookies ?? j?.cookies ?? '');
  if (!cookies) throw new Error('get_cookies 未返回空间登录态');
  const skey = cookies.match(/p_skey=([^;\s]+)/)?.[1] || cookies.match(/(?<![A-Za-z_])skey=([^;\s]+)/)?.[1];
  if (!skey) throw new Error('cookie 缺 p_skey/skey（空间未登录）');
  const uin = (cookies.match(/(?<![A-Za-z_])uin=([^;\s]+)/)?.[1] || '').replace(/^o/i, '').replace(/\D/g, '') || String(cfgRef.ownerQQ ?? '');
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) hash += (hash << 5) + skey.charCodeAt(i);
  return { cookies, uin, gtk: hash & 0x7fffffff };
}

/** 拉某人最新说说列表（同 qq_qzone_view 的现役接口）。返回 [{tid, created_time}] */
async function qzoneFeedLatest(auth, uid, num = 10) {
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/taotao/feeds_query_v6?uin=${auth.uin}&hostUin=${uid}&format=json&num=${num}&start=0&g_tk=${auth.gtk}`;
  const res = await fetch(url, { headers: { Cookie: auth.cookies }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`空间接口无 JSON（uid=${uid} http=${res.status}）`);
  const j = JSON.parse(m[0]);
  if (j.code !== 0) throw new Error(`空间接口 code=${j.code}（uid=${uid}）`);
  return Array.isArray(j.msglist) ? j.msglist : [];
}

/** 点赞一条（同 qq_qzone_like 的现役接口 internal_dolike_app）。 */
async function qzoneDoLike(auth, hostUid, tid) {
  const unikey = `http://user.qzone.qq.com/${hostUid}/mood/${tid}`;
  const body = new URLSearchParams({
    opuin: String(auth.uin), unikey, curkey: unikey,
    from: '1', appid: '311', typeid: '0',
    abstime: String(Math.floor(Date.now() / 1000)),
    fid: String(tid), active: '0', format: 'json', fupdate: '1',
    qzreferrer: `https://user.qzone.qq.com/${hostUid}`
  });
  const res = await fetch(`https://w.qzone.qq.com/cgi-bin/internal_dolike_app?g_tk=${auth.gtk}`, {
    method: 'POST',
    headers: { Cookie: auth.cookies, Referer: `https://user.qzone.qq.com/${hostUid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const j = await res.json().catch(() => ({}));
  return j.code === 0 || j.code === '0' || j.ret === 0;
}

function likedState() {
  const s = readJsonSafe(LIKED_FILE, null);
  return { day: '', tids: [], todayCount: 0, ...(s && typeof s === 'object' ? s : {}) };
}

async function autoLikeRound() {
  const a = cfgRef?.social?.qzone?.autoLike ?? {};
  const uids = Array.isArray(a.uids) ? a.uids.map(String).filter(Boolean) : [];
  if (!uids.length) return;
  const bjHour = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  if (bjHour >= 1 && bjHour < 6) { log('[qzone-autolike] 深夜不巡'); return; }
  const st = likedState();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (st.day !== today) { st.day = today; st.todayCount = 0; }
  const maxPerRun = Math.max(1, Number(a.maxPerRun) || 3);
  const dailyCap = Math.max(1, Number(a.dailyCap) || 12);
  if (st.todayCount >= dailyCap) { log(`[qzone-autolike] 今日已达上限 ${dailyCap}`); return; }
  let auth;
  try { auth = await qzoneAuth(); } catch (e) { log(`[qzone-autolike] ${e.message}`); return; }
  const seen = new Set(st.tids);
  let did = 0;
  for (const uid of uids) {
    if (did >= maxPerRun || st.todayCount >= dailyCap) break;
    try {
      const feed = await qzoneFeedLatest(auth, uid, 10);
      // 从新到旧找第一条没赞过的
      for (const m of feed) {
        const tid = String(m.tid ?? '');
        if (!tid || seen.has(tid)) continue;
        const ok = await qzoneDoLike(auth, uid, tid);
        seen.add(tid); st.tids.push(tid); did += 1; st.todayCount += 1;
        log(`[qzone-autolike] ${ok ? '已赞' : '赞失败'} ${uid} 的 tid=${tid}`);
        break; // 每人每轮只赞最新一条
      }
    } catch (e) { log(`[qzone-autolike] 巡 ${uid} 失败: ${e.message}`); }
  }
  if (st.tids.length > 2000) st.tids = st.tids.slice(-1500);
  try { atomicWriteJson(LIKED_FILE, st); } catch {}
  if (did) log(`[qzone-autolike] 本轮赞了 ${did} 条（今日 ${st.todayCount}/${dailyCap}）`);
}

let autoLikeTimer = null;
export function startQzoneAutoLike() {
  if (autoLikeTimer) { clearInterval(autoLikeTimer); autoLikeTimer = null; }
  const a = cfgRef?.social?.qzone?.autoLike ?? {};
  if (a.enabled !== true) { log('[qzone-autolike] 未启用（social.qzone.autoLike.enabled !== true）'); return; }
  if (!Array.isArray(a.uids) || !a.uids.length) { log('[qzone-autolike] 名单为空，不巡'); return; }
  const intervalMs = Math.max(30 * 60 * 1000, Number(a.intervalMinMs) || 120 * 60 * 1000);
  autoLikeTimer = setInterval(() => { autoLikeRound().catch(() => {}); }, intervalMs);
  autoLikeTimer.unref?.();
  // 启动后先歇半个周期再首轮（避开启动风暴）
  setTimeout(() => { autoLikeRound().catch(() => {}); }, Math.min(intervalMs / 2, 10 * 60 * 1000)).unref?.();
  log(`[qzone-autolike] 巡航已启动：每 ${Math.round(intervalMs / 60000)} 分钟一轮，名单 ${a.uids.length} 人，每轮最多 ${Number(a.maxPerRun) || 3} 赞，每日上限 ${Number(a.dailyCap) || 12}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 周计划自动发说说（2026-10-26，用户定规）
 *
 * 规则：每周 1~2 次——60% 概率本周发 2 次、40% 发 1 次；两次间隔 ≥12 小时；
 * 北京时间 01:00~07:00 不发。计划落盘（state/qzone-weekly.json），桥重启不丢
 * 本周进度（已发条数为准，未发的名额重新排点）。
 *
 * 替换了 dsh-watch 里的旧「8-16h 随机 × 概率」调度器（频率远超周 1-2 次）。
 * ══════════════════════════════════════════════════════════════════════════ */

const WEEKLY_FILE = path.join(STATE_DIR, 'qzone-weekly.json');
const BJ_OFFSET = 8 * 3600 * 1000;

/** 北京时间的「本周一 00:00」的 epoch（周 key 与本周结束时刻都从这算）。 */
function bjWeekStart(nowMs) {
  const bj = new Date(Number(nowMs) + BJ_OFFSET);
  const day = (bj.getUTCDay() + 6) % 7; // 周一=0
  const monday = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - day) - BJ_OFFSET;
  return monday;
}
function bjHourOf(ts) {
  return new Date(Number(ts) + BJ_OFFSET).getUTCHours();
}
/** 给定 now，返回一个合法的下次发帖时刻：
 *  - 落在 now+minLead ~ now+maxLead 之间随机
 *  - 不早于 minAfter（保证与前次间隔）
 *  - 不晚于 weekEnd（保证本周内）
 *  - 避开北京 01:00~06:59 静默窗（落进去就推到当天 07:00） */
export function pickWeeklyFireTime(nowMs, { minLeadMs = 2 * 3600 * 1000, maxLeadMs = 36 * 3600 * 1000, minAfter = 0, weekEnd = Infinity } = {}) {
  const lo = Math.max(Number(nowMs) + minLeadMs, Number(minAfter));
  const hi = Math.min(Number(nowMs) + maxLeadMs, Number(weekEnd) - 15 * 60 * 1000); // 别贴着周界
  let t = hi > lo ? lo + Math.floor(Math.random() * (hi - lo)) : lo;
  // 深夜窗顺延：北京 1~6 点 → 推到当天北京 07:00
  for (let i = 0; i < 2; i++) {
    const h = bjHourOf(t);
    if (h >= 1 && h < 7) {
      const bj = new Date(t + BJ_OFFSET);
      t = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 7) - BJ_OFFSET;
      if (t <= Number(nowMs)) t += 24 * 3600 * 1000;
    }
  }
  return t;
}
/** 本周计划条数：60% → 2，40% → 1（可配 twoPostsProbability）。 */
export function pickWeeklyCount(twoProb = 0.6) {
  return Math.random() < twoProb ? 2 : 1;
}

function weeklyState() {
  const s = readJsonSafe(WEEKLY_FILE, null);
  return { weekStart: 0, planned: 0, posted: [], ...(s && typeof s === 'object' ? s : {}) };
}

let weeklyTimer = null;
export function startQzoneWeeklyScheduler() {
  if (weeklyTimer) { clearTimeout(weeklyTimer); weeklyTimer = null; }
  const qz = cfgRef?.social?.qzone ?? {};
  if (qz.enabled === false) { log('[qzone-weekly] social.qzone.enabled=false，不发'); return; }
  const poolInfo = loadQzonePool();
  log(poolInfo
    ? `[qzone-weekly] 文案池 ${poolInfo.version}：${poolInfo.cats.reduce((a, c) => a + c.items.length, 0)} 条（${poolInfo.cats.map((c) => `${c.name} ${c.items.length}`).join(' / ')}）`
    : '[qzone-weekly] 文案池文件缺失，将用内置兜底池');
  const twoProb = (() => { const v = Number(qz.weeklyTwoPostsProbability); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6; })();
  const minGapMs = Math.max(0, Number(qz.weeklyMinGapHours) || 12) * 3600 * 1000;
  const schedule = () => {
    const now = Date.now();
    const ws = bjWeekStart(now);
    const st = weeklyState();
    if (st.weekStart !== ws) {
      st.weekStart = ws;
      st.planned = pickWeeklyCount(twoProb);
      st.posted = [];
      try { atomicWriteJson(WEEKLY_FILE, st); } catch {}
      log(`[qzone-weekly] 新的一周：计划发 ${st.planned} 次（概率 p2=${twoProb}）`);
    }
    const remaining = st.planned - st.posted.length;
    if (remaining <= 0) {
      // 本周名额用完：睡到下周一再评估
      const nextWeek = ws + 7 * 24 * 3600 * 1000 + 10 * 60 * 1000;
      weeklyTimer = setTimeout(() => { schedule(); }, Math.max(60 * 1000, nextWeek - Date.now()));
      weeklyTimer.unref?.();
      log(`[qzone-weekly] 本周 ${st.planned} 次已发完，下次评估下周一`);
      return;
    }
    const lastPosted = st.posted.length ? Math.max(...st.posted.map(Number)) : 0;
    const fireAt = pickWeeklyFireTime(now, {
      minAfter: lastPosted ? lastPosted + minGapMs : 0,
      weekEnd: ws + 7 * 24 * 3600 * 1000,
    });
    weeklyTimer = setTimeout(async () => {
      let ok = false;
      try { await postRandomQzone(); ok = true; } catch (e) { log(`[qzone-weekly] 发送失败: ${e?.message ?? e}`); }
      if (ok) {
        const st2 = weeklyState();
        st2.posted.push(Date.now());
        try { atomicWriteJson(WEEKLY_FILE, st2); } catch {}
        log(`[qzone-weekly] 本周第 ${st2.posted.length}/${st2.planned} 次已发`);
      }
      schedule(); // 失败也重排（同周内再试）
    }, Math.max(30 * 1000, fireAt - Date.now()));
    weeklyTimer.unref?.();
    log(`[qzone-weekly] 已排下次发帖：约 ${Math.round((fireAt - now) / 3600000)} 小时后（本周 ${st.posted.length}/${st.planned}）`);
  };
  schedule();
}

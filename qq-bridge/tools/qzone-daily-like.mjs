// 每日空间自动点赞（2026-10-07 主人要求："让泠娜给她的列表好友的空间自动点赞"）
//
// 复用泠娜自己的 QZone 登录态（NapCat get_cookies 中转，与 mcp-napcat-safe.js 的
// qq_qzone_view / qq_qzone_like 同一套接口），不需要 qzone-liker 的扫码登录。
//
// 行为（保守风控口径）：
//   · 拉好友列表 → 逐个看空间 → 只赞"最新一条"说说，且只赞 48h 内的新帖（赞陈年旧帖太像机器人）
//   · 好友之间随机间隔 20~50 秒；单日上限 40 人（超出部分下次再说，逐步覆盖）
//   · 已赞过的 tid 记在 state/qzone-like-history.json，重复运行不会反复点赞
//   · 随机初始延迟 0~30 分钟（由计划任务触发时打散时间指纹）
//   · NapCat 不在线/空间登录态失效 → 直接退出，日志留痕，不硬试
//
// 用法：node tools/qzone-daily-like.mjs [--limit N] [--nolike]
//   --limit N   本次最多处理 N 个好友（验证用）
//   --nolike    只看不做（dry-run）
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_FILE = path.join(ROOT, 'state', 'qzone-like-history.json');
const LOG_FILE = path.join(ROOT, 'state', 'qzone-like.log');
const napcatBase = String(CFG.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const napcatToken = String(CFG.napcat?.accessToken || '');
const DOLIKE = 'https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app';
const MSG_LIST = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Math.max(1, Number(args[limitIdx + 1]) || 5) : 40;
const DRY = args.includes('--nolike');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a));

function logLine(s) {
  const line = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { liked: {} }; }
}
function saveHistory(h) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(h)); } catch {}
}

async function napcatApi(api, body) {
  const res = await fetch(`${napcatBase}/${api}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(napcatToken ? { authorization: `Bearer ${napcatToken}` } : {}) },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000)
  });
  return res.json().catch(() => null);
}

async function qzoneAuth() {
  // 与 console-server 的 /api/qzone-cookie 相同来源（bridge 控制台 3100），这里直连 NapCat 免依赖桥在跑
  const ck = await napcatApi('get_cookies', { domain: 'qzone.qq.com' });
  const cookies = ck?.data?.cookies || '';
  if (!cookies) throw new Error('拿不到 QZone cookie（NapCat 未登录空间？）');
  const skey = cookies.match(/p_skey=([^;\s]+)/)?.[1] || cookies.match(/(?<![A-Za-z_])skey=([^;\s]+)/)?.[1];
  if (!skey) throw new Error('缺少 p_skey/skey');
  const uin = (cookies.match(/(?<![A-Za-z_])uin=([^;\s]+)/)?.[1] || '').replace(/^o/i, '').replace(/\D/g, '');
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) hash += (hash << 5) + skey.charCodeAt(i);
  return { cookies, uin, gtk: hash & 0x7fffffff };
}

/* QZone 响应壳不一（纯 JSON / JSONP / 自定义壳），抽「首个 { 到最后一个 }」 */
function qzoneParse(txt) {
  const s = String(txt ?? '').trim();
  if (s[0] === '{' || s[0] === '[') { try { return JSON.parse(s); } catch {} }
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

async function qzoneGet(url, cookies) {
  const res = await fetch(url, {
    headers: { Cookie: cookies, Referer: 'https://user.qzone.qq.com/', Origin: 'https://user.qzone.qq.com' },
    signal: AbortSignal.timeout(20000)
  });
  return qzoneParse(await res.text().catch(() => ''));
}

async function likeMood({ cookies, uin, gtk }, hostUid, tid) {
  const unikey = `http://user.qzone.qq.com/${hostUid}/mood/${tid}`;
  const body = new URLSearchParams({
    opuin: String(uin), unikey, curkey: unikey,
    from: '1', appid: '311', typeid: '0',
    abstime: String(Math.floor(Date.now() / 1000)),
    fid: String(tid), active: '0', format: 'json', fupdate: '1',
    qzreferrer: `https://user.qzone.qq.com/${hostUid}`
  });
  const res = await fetch(`${DOLIKE}?g_tk=${gtk}`, {
    method: 'POST',
    headers: { Cookie: cookies, Referer: `https://user.qzone.qq.com/${hostUid}`, Origin: 'https://user.qzone.qq.com', 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000)
  });
  return qzoneParse(await res.text().catch(() => ''));
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const initialDelay = DRY ? 0 : randInt(0, 30 * 60 * 1000);
if (initialDelay) logLine(`随机打散：${Math.round(initialDelay / 60000)}min 后开始`);
await sleep(initialDelay);

let auth;
try { auth = await qzoneAuth(); } catch (e) { logLine(`退出：${e.message}`); process.exit(0); }
const fl = await napcatApi('get_friend_list');
const friends = Array.isArray(fl?.data) ? fl.data : [];
if (!friends.length) { logLine('退出：好友列表为空（NapCat 未登录？）'); process.exit(0); }
logLine(`好友 ${friends.length} 个，本次处理前 ${LIMIT} 个${DRY ? '（dry-run 不点赞）' : ''}`);

const history = loadHistory();
history.liked ||= {};
const today = new Date().toISOString().slice(0, 10);
// 顺手清 30 天前的历史（文件别越滚越大）
for (const k of Object.keys(history.liked)) {
  history.liked[k] = history.liked[k].filter((d) => d >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  if (!history.liked[k].length) delete history.liked[k];
}

let liked = 0, skipped = 0, failed = 0;
for (const f of friends.slice(0, LIMIT)) {
  const uid = String(f.user_id ?? f.uin ?? '').replace(/\D/g, '');
  if (!uid || uid === auth.uin) continue; // 跳过自己
  try {
    const j = await qzoneGet(`${MSG_LIST}?uin=${uid}&hostUin=${uid}&format=json&num=1&start=0&g_tk=${auth.gtk}`, auth.cookies);
    const mood = Array.isArray(j?.msglist) ? j.msglist[0] : null;
    if (!mood?.tid) { skipped++; logLine(`跳过 ${uid}（${f.nickname || f.remark || '?'}）：无说说或空间不可见`); }
    else {
      const ageH = mood.created_time ? (Date.now() / 1000 - Number(mood.created_time)) / 3600 : 1e9;
      const key = `${uid}:${mood.tid}`;
      if (ageH > 72) { skipped++; logLine(`跳过 ${uid}：最新说说已是 ${Math.round(ageH / 24)} 天前`); }
      else if ((history.liked[key] || []).includes(today)) { skipped++; logLine(`跳过 ${uid}：今天已赞过`); }
      else if (DRY) { logLine(`[dry] 将赞 ${uid}（${f.nickname || '?'}）tid=${mood.tid}`); }
      else {
        const r = await likeMood(auth, uid, mood.tid);
        if (r && (r.code === 0 || r.code === '0' || r.ret === 0)) {
          liked++;
          (history.liked[key] ||= []).push(today);
          logLine(`已赞 ${uid}（${f.nickname || f.remark || '?'}）：${String(mood.content || '').slice(0, 20) || '[图片/无字]'}`);
        } else {
          failed++;
          logLine(`点赞失败 ${uid}: code=${r?.code ?? r?.ret ?? '?'} ${r?.message || r?.msg || ''}`);
        }
      }
    }
  } catch (e) { failed++; logLine(`处理 ${uid} 异常：${e.message}`); }
  saveHistory(history);
  await sleep(randInt(20000, 50000)); // 好友间隔：20~50 秒，保守
}
logLine(`结束：赞 ${liked}，跳 ${skipped}，败 ${failed}`);
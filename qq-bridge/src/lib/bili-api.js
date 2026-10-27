/* ══════════════════════════════════════════════════════════════════════════
 * B 站请求单源（2026-10-27，审查 P3-2 / P2-3）
 *
 * 此前 bili-nurture.js / bili-dynamic.js / mcp-napcat-safe.js 各有一份 biliFetch+wbi 实现，
 * 已经分叉出真实缺陷：MCP 版有 isLogin 检查而另两处没有；风控判据三种写法；UA 硬编码三处。
 * 本模块统一：UA、风控码、HTTP 412 归一、wbi 签名、cookie 读取，以及**跨模块共享的熔断状态**
 * （M2 撞风控 → M3 也停，同账号同 IP 不该各撞各的）。
 *
 * 熔断状态落 state/bili-circuit.json：{ until, code, message, scope, at }。
 * 调用方不传 path 时用 STATE_DIR；MCP 独立进程用自己的 ROOT 拼同一路径，读写同一份文件。
 * ══════════════════════════════════════════════════════════════════════════ */
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './paths.js';
import { readJsonSafe, atomicWriteJson } from './json-fs.js';
import { log } from './log.js';

export const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 真风控码（会让整个账号进入冷却）。-403 权限不足在数据中心 IP 上通常是风控形态，一并算。
 *  **不要把 -101/-111 放进来**：它们是「账号未登录 / CSRF 失效」= 凭据问题，
 *  正确反应是提示重登、各模块已有 isLogin 预检；当成风控会熔断一整天（2026-10-27 实际踩过）。 */
export const BILI_RISK_CODES = [-412, -352, -509, -403];

/** 凭据类错误码：不熔断，只如实上报（等重导 cookie 自愈）。 */
export const BILI_AUTH_ERRORS = [-101, -111];

export const BILI_AUTH_FILE = path.join(STATE_DIR, 'bilibili-auth.json');
export const BILI_CIRCUIT_FILE = path.join(STATE_DIR, 'bili-circuit.json');

const AUTH_SKIP_KEYS = ['savedAt', 'mode', 'fingerprint'];

export const biliEnc = (s) => encodeURIComponent(String(s)).replace(/[!'"()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

/* ── cookie / 登录态 ── */
export function readAuth(authFile = BILI_AUTH_FILE) {
  return readJsonSafe(authFile, {});
}
export function authCookie(authFile = BILI_AUTH_FILE) {
  const d = readAuth(authFile);
  return Object.entries(d).filter(([k]) => !AUTH_SKIP_KEYS.includes(k)).map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ── 熔断（共享） ── */
export function circuitState(circuitFile = BILI_CIRCUIT_FILE) {
  const c = readJsonSafe(circuitFile, { until: 0 });
  return { until: Number(c.until) || 0, code: c.code ?? '', message: c.message ?? '', scope: c.scope ?? '', at: c.at ?? 0 };
}
export const circuitOpen = (circuitFile = BILI_CIRCUIT_FILE) => circuitState(circuitFile).until > Date.now();

/** 撞风控 → 落盘熔断。冷却 = max(北京次日零点, now + minCoolHours)。已熔断时不缩短。 */
export function tripCircuit({ code, message = '', scope = 'bili' }, circuitFile = BILI_CIRCUIT_FILE, minCoolHours = 6) {
  const cur = circuitState(circuitFile);
  if (cur.until > Date.now()) return cur;
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const nextMidnight = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1) - 8 * 3600 * 1000;
  const until = Math.max(nextMidnight, Date.now() + Math.max(1, Number(minCoolHours) || 6) * 3600 * 1000);
  const rec = { until, code: String(code), message: String(message), scope, at: Date.now() };
  try { atomicWriteJson(circuitFile, rec); } catch (e) { log(`[bili-api] 熔断落盘失败：${e?.message ?? e}`); }
  log(`[bili-api] 风控熔断（${scope}）：码 ${code}（${message}），停至 ${new Date(until).toISOString()}`);
  return rec;
}

/* ── JSON 请求 ── */
/**
 * @param {object} o
 * @param {string} o.url
 * @param {'GET'|'POST'} [o.method]
 * @param {string} [o.body]  - 已编码的 body
 * @param {boolean} [o.json] - body 是 JSON（设 content-type: application/json）
 * @param {string} [o.referer]
 * @param {string} [o.cookie] - 不传则读 authFile
 * @param {string} [o.authFile]
 * @param {string} [o.circuitFile]
 * @param {boolean} [o.tripOnRisk] - 撞风控时是否落熔断（默认 true）
 * @param {string} [o.scope] - 熔断标记来源
 */
export async function biliJson(url, {
  method = 'GET', body = '', json = false, referer, cookie, authFile = BILI_AUTH_FILE,
  circuitFile = BILI_CIRCUIT_FILE, tripOnRisk = true, scope = 'bili',
} = {}) {
  const ck = cookie === undefined ? authCookie(authFile) : cookie;
  const headers = { 'user-agent': BILI_UA, referer: referer || 'https://www.bilibili.com/', ...(ck ? { cookie: ck } : {}) };
  if (body) headers['content-type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
  const res = await fetch(url, { method, headers, ...(body ? { body } : {}) });
  const j = await res.json().catch(() => ({ code: -999, message: `HTTP ${res.status}` }));
  /* 本 IP 的风控主形态是 HTTP 层 412 + HTML 页（video.js 实测），归一成业务 -412 一并判定 */
  if (res.status === 412) j.code = -412;
  if (BILI_AUTH_ERRORS.includes(Number(j.code))) {
    /* 凭据失效：不熔断（否则重登后仍被挡一整天），抛专用错误让调用方按"登录过期"处理 */
    throw new Error(`B站登录失效（code ${j.code} ${j.message ?? ''}）：请重新导出 cookie`);
  }
  if (BILI_RISK_CODES.includes(Number(j.code))) {
    if (tripOnRisk) tripCircuit({ code: j.code, message: j.message ?? '', scope }, circuitFile);
    throw new Error(`风控码 ${j.code}（${j.message ?? ''}）`);
  }
  return j;
}

/** 登录态预检：true=已登录，false=过期。nav 游客可访问，isLogin 才是判据。 */
export async function checkIsLogin({ authFile = BILI_AUTH_FILE, circuitFile = BILI_CIRCUIT_FILE, scope = 'bili' } = {}) {
  const nav = await biliJson('https://api.bilibili.com/x/web-interface/nav', { authFile, circuitFile, scope });
  return nav.data?.isLogin !== false;
}

/* ── Wbi 签名 ── */
const WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

/** 返回可直接拼到 URL 后面的 query（含 w_rid；wts 只出现一次——尾部重复拼 wts 曾致 space 接口 -403）。 */
export async function wbiSign(params, { authFile = BILI_AUTH_FILE, circuitFile = BILI_CIRCUIT_FILE, scope = 'bili' } = {}) {
  const nav = await biliJson('https://api.bilibili.com/x/web-interface/nav', { authFile, circuitFile, scope });
  const imgKey = nav.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0];
  const subKey = nav.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0];
  if (!imgKey || !subKey) throw new Error(`nav 无 wbi key（code=${nav.code}）`);
  const mixin = WBI_TAB.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32);
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const qs = Object.keys(p).sort().map((k) => encodeURIComponent(k) + '=' + biliEnc(p[k])).join('&');
  return qs + '&w_rid=' + crypto.createHash('md5').update(qs + mixin).digest('hex');
}

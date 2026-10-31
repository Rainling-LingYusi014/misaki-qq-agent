// TG 资源管线核心（M2，2026-10-30）：TG 资源域的编排层。
//
// 分工（见《TG资源管线_设计_20261029.md》§3/§8.5）：
//   - MTProto 层在 Python 侧车（tg-line/tg_service.py，本模块 spawn + 托管）：搜索/并行下载。
//   - 本模块只做策略：白名单闸、每日配额、大小闸、任务登记、完成后经 NapCat 直传交付（绕开
//     console send-file 的 500MB 闸——那是给 DSH 沙箱文件设的，TG 原文件上限是 2GB）。
//   - 出口固定走 mihomo 的 TG 专线（socks5://127.0.0.1:7892，TG 组手动钉节点），不影响 7890 主路由。
//
// 启用条件：cfg.telegram?.enabled === true（config.json 本地线开；服务器线不开，工具面整体缺席，
// agent 按「能力诚实」规则明说没有——与 bili_* 的开关哲学一致）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from '../lib/log.js';
import { uploadFileToQQ } from './docx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(ROOT, 'state');

let cfgRef = null;
let sidecarProc = null;
let sidecarToken = '';
let superviseTimer = null;
let retentionTimer = null;
// jobId -> { key, channel, msgId, started, delivered }（进程内；重启丢任务，tg_job 如实报 unknown）
const jobs = new Map();

const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2GB @ 0.5MB/s ≈ 70min，留足余量

function tgCfg() {
  const t = cfgRef?.telegram ?? {};
  return {
    enabled: t.enabled === true,
    whitelist: (Array.isArray(t.whitelist) ? t.whitelist : []).map(normalizeChannel),
    port: Number(t.sidecarPort) || 8765,
    proxyPort: Number(t.proxyPort) || 7892,
    maxFileBytes: Number(t.limits?.maxFileBytes) || 2 * 1024 * 1024 * 1024,
    // 2026-10-30 主人拍板：对所有人开放、不设限额——0 = 不限；配额仍逐次计数（tg-quota.json），只作数据不作闸
    dailyLimit: Math.max(0, Math.floor(Number(t.limits?.dailyLimit) ?? 0)),
    retentionDays: Number(t.retentionDays) || 3,
    python: t.sidecarPython || path.join(ROOT, '..', 'tg-line', 'venv', 'Scripts', 'python.exe'),
    script: t.sidecarScript || path.join(ROOT, '..', 'tg-line', 'tg_service.py'),
  };
}

function normalizeChannel(ch) {
  let s = String(ch ?? '').trim();
  s = s.replace(/^https?:\/\/t\.me\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '');
  s = s.split('?')[0].trim(); // 分享链接常带 ?xxx 查询串
  return s ? '@' + s : '';
}

function stateFile(name) { return path.join(STATE_DIR, name); }

function readToken() {
  const f = stateFile('tg-sidecar-token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* 生成在下方 */ }
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(f, t + '\n');
  return t;
}

function sidecarBase() { return `http://127.0.0.1:${tgCfg().port}`; }

async function sidecarFetch(p, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(sidecarBase() + p, {
      ...opts,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-sidecar-token': sidecarToken, ...(opts.headers ?? {}) },
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let lastSpawnAt = 0;
let missingSessionLogged = false; // 审查 P2-12：缺 session 只在状态变化时打日志，不再每 60s 刷屏
let unhealthyRounds = 0;          // 审查 P2-12：连续不健康轮数，>1 时在日志里升级提示
/** 2026-10-31 主人授权修的侧车死循环：代理劣化后 Telethon 连接+鉴权可能超过一分钟，
 * 而健康检查每 60s 杀一次「还没连上」的侧车 → 永远连不上（就绪行每分钟一条的实锤）。
 * 活着的侧车先给 4 分钟宽限；进程死了仍按原节奏拉起；宽限期过了还不健康才杀掉重启。 */
const SIDECAR_GRACE_MS = 4 * 60 * 1000;

function spawnSidecar() {
  const c = tgCfg();
  if (sidecarProc) {
    // Windows + venv 转发器：python.exe 是 shim，真实解释器是它的子进程——只 kill shim
    // 会留下孤儿占着 8765 和 session 锁，新侧车 /health 直接挂死（2026-10-30 实测）。必须树杀。
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(sidecarProc.pid)], { timeout: 15000 }); log(`[tg] 旧侧车进程树已清（PID ${sidecarProc.pid}）`); } catch { /* 已死就算了 */ }
    sidecarProc = null;
  }
  // Windows 不随父进程回收子进程：桥重启后旧侧车会变孤儿占着端口，导致新侧车 bind 失败或静默共绑。
  // spawn 前按端口清场（只杀 LISTENING 在侧车口上的 PID，非自己）。
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15000 });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = String(cols[1] ?? '');
      const pid = Number(cols[4] ?? cols[cols.length - 1]);
      if (local.endsWith(`:${c.port}`) && pid && pid !== process.pid) {
        try { execFileSync('taskkill', ['/F', '/PID', String(pid), '/T'], { timeout: 15000 }); log(`[tg] 清掉残留侧车 PID ${pid}`); } catch { /* 可能已死 */ }
      }
    }
  } catch { /* netstat 不可用就交给健康检查兜底 */ }
  const sessionPath = stateFile('tg-session.session');
  const downloadsDir = path.join(STATE_DIR, 'agents', 'tg');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  if (!fs.existsSync(sessionPath)) {
    if (!missingSessionLogged) { log('[tg] 缺 MTProto session（state/tg-session.session）——先用 tg-line 的登录流程生成（本条只在状态变化时提示一次）'); missingSessionLogged = true; }
    return;
  }
  missingSessionLogged = false;
  const logFd = fs.openSync(stateFile('tg-sidecar.log'), 'a');
  sidecarProc = spawn(c.python, [
    '-u', c.script,
    '--session', sessionPath,
    '--port', String(c.port),
    '--token', sidecarToken,
    '--downloads', downloadsDir,
    '--proxy-port', String(c.proxyPort),
  ], { stdio: ['ignore', logFd, logFd], windowsHide: true });
  lastSpawnAt = Date.now();
  sidecarProc.on('exit', (code) => { log(`[tg] 侧车退出（code=${code}），60s 内由托管重启`); sidecarProc = null; });
  /* 审查 P1-5：spawn 的 error 事件（python 路径不存在等）没有监听会变成 uncaughtException
   * 直接崩整座桥。这里接住并置空句柄，交给监督循环按节奏重试。 */
  sidecarProc.on('error', (e) => {
    log(`[tg] 侧车启动失败：${e?.message ?? e}（60s 内由托管重试；若持续出现请检查 telegram.python 路径）`);
    sidecarProc = null;
  });
  log(`[tg] 侧车已启动（port=${c.port}，TG 专线 socks5://127.0.0.1:${c.proxyPort}）`);
}

async function sidecarHealthy() {
  try {
    const h = await sidecarFetch('/health', {}, 8000);
    return h?.ok === true;
  } catch { return false; }
}

function sweepRetention() {
  const c = tgCfg();
  const dir = path.join(STATE_DIR, 'agents', 'tg');
  const cutoff = Date.now() - c.retentionDays * 86400e3;
  let swept = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); swept++; } } catch { /* 占用中跳过 */ }
    }
  } catch { /* 目录不存在就算了 */ }
  if (swept) log(`[tg] 保留清理：删除 ${swept} 个超过 ${c.retentionDays} 天的文件`);
}

function quotaFile() {
  const f = stateFile('tg-quota.json');
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  let j = { day: today, counts: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (raw.day === today) j = raw;
  } catch { /* 首日/损坏都从头计 */ }
  return {
    today,
    count: (key) => Number(j.counts[key]) || 0,
    bump: (key) => { j.counts[key] = (Number(j.counts[key]) || 0) + 1; try { fs.writeFileSync(f, JSON.stringify(j)); } catch { /* 配额少记一次可接受 */ } },
  };
}

export function initTgResource(cfg) {
  cfgRef = cfg;
  if (!tgCfg().enabled) { log('[tg] 资源域未启用（telegram.enabled）——侧车不启动，工具不注册'); return; }
  sidecarToken = readToken();
  spawnSidecar();
  superviseTimer = setInterval(async () => {
    if (!sidecarProc) { log('[tg] 侧车不在了，重新拉起'); spawnSidecar(); return; }
    // 2026-10-31：活着的侧车先给宽限期——代理慢时 MTProto 连接+鉴权超过 60s，
    // 旧的「不健康就杀」会把每次都在连上之前杀掉，永远连不上。
    if (Date.now() - lastSpawnAt < SIDECAR_GRACE_MS) return;
    if (!(await sidecarHealthy())) {
      unhealthyRounds += 1;
      log(`[tg] 侧车不健康（宽限期已过），重启${unhealthyRounds > 1 ? `（已连续 ${unhealthyRounds} 轮——查 tg-sidecar.log 尾部，别只盯着重启）` : ''}`);
      spawnSidecar();
    } else if (unhealthyRounds) { unhealthyRounds = 0; }
  }, 60 * 1000);
  retentionTimer = setInterval(sweepRetention, 6 * 3600e3);
  superviseTimer.unref?.();  // 沙盒/单测里不阻进程退出；桥本身常驻不受影响
  retentionTimer.unref?.();
  sweepRetention();
}

export function tgWhitelist() { return tgCfg().whitelist; }
export function tgNormalizeChannel(ch) { return normalizeChannel(ch); }
export function tgGateChannel(channel) { return gateChannel(channel); }

function gateChannel(channel) {
  const c = tgCfg();
  const ch = normalizeChannel(channel);
  if (!ch) {
    if (c.whitelist.length === 1) return c.whitelist[0];
    throw new Error('未指定频道（白名单有多个，必须指明是哪一个）');
  }
  if (!c.whitelist.includes(ch)) throw new Error(`频道 ${ch} 不在白名单内（可搜：${c.whitelist.join('、')}）`);
  return ch;
}

// 时间参数归一化：'YYYY-MM-DD' 按北京日界展开（since=当日零点 / until=当日 23:59:59）；
// 完整 ISO 时间串原样解析。返回 epoch 秒（0=不限）。
export function tgParseDay(s, endOfDay = false) {
  const str = String(s ?? '').trim();
  if (!str) return 0;
  let ms;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(str)) {
    const [y, m, d] = str.split('-').map((x) => String(Number(x)).padStart(2, '0'));
    ms = Date.parse(`${y}-${m}-${d}T${endOfDay ? '23:59:59' : '00:00:00'}+08:00`);
  } else {
    ms = Date.parse(str);
  }
  if (Number.isNaN(ms)) throw new Error(`时间参数看不懂：「${str}」（要 YYYY-MM-DD 或 ISO 日期时间，按北京时间理解）`);
  return Math.floor(ms / 1000);
}

// 侧车时间契约（2026-10-30 修 Bug①）：/search 的 minDate/maxDate 一律秒级 epoch。
// tgParseDay 已产秒，这里再做防御归一：毫秒误传（>1e12，秒级 epoch 到公元三万年才够）÷1000，
// 0/null/undefined 归 0——与侧车 _sec 同规，两边谁被单独改动都不至于单位错配。
export function toSidecarSec(v) {
  const n = Number(v) || 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export async function tgSearch(query, channel, n = 5, since = '', until = '') {
  const c = tgCfg();
  const channels = channel ? [gateChannel(channel)] : c.whitelist;
  if (!channels.length) throw new Error('白名单为空（config.telegram.whitelist）');
  const minDate = tgParseDay(since, false);
  const maxDate = tgParseDay(until, true);
  if (minDate && maxDate && minDate > maxDate) throw new Error('时间窗反了：since 晚于 until');
  const rows = [];
  const failures = [];
  for (const ch of channels) {
    try {
      const out = await sidecarFetch('/search', { method: 'POST', body: JSON.stringify({ channel: ch, query: String(query ?? '').slice(0, 120), limit: n, minDate: toSidecarSec(minDate), maxDate: toSidecarSec(maxDate) }) }, 70000);
      if (Array.isArray(out.rows)) rows.push(...out.rows);
      else failures.push(`${ch}: ${out.error ?? '未知错误'}`);
    } catch (e) { failures.push(`${ch}: ${e?.message ?? e}`); }
  }
  return { rows: rows.slice(0, n), searched: channels, failures, window: (minDate || maxDate) ? { since: since || null, until: until || null } : null };
}

async function deliver(jobId) {
  const rec = jobs.get(jobId);
  const j = await sidecarFetch(`/job?id=${jobId}`, {}, 15000);
  if (j.status !== 'done') return;
  const absPath = path.resolve(j.path);
  try {
    await uploadFileToQQ(rec.key, absPath, j.fileName);
    rec.delivered = true;
    log(`[tg] 任务 ${jobId.slice(0, 8)} 已交付 ${rec.key}: ${j.fileName}（${(j.size / 1048576).toFixed(1)}MB）`);
    // 完成告知：一行直发（交付是主动承诺过的动作，不走打字链）
    const [kind, id] = rec.key.split(':');
    const httpUrl = String(cfgRef?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const text = `TG 素材下好了，已直接发你：${j.fileName}（${(j.size / 1048576).toFixed(1)}MB，来自 ${rec.channel}）`;
    await fetch(`${httpUrl}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${cfgRef?.napcat?.accessToken}` },
      body: JSON.stringify(kind === 'private' ? { user_id: Number(id), message: [{ type: 'text', data: { text } }] } : { group_id: Number(id), message: [{ type: 'text', data: { text } }] }),
    }).catch(() => {});
  } catch (e) {
    rec.delivered = false;
    rec.deliverError = String(e?.message ?? e).slice(0, 200);
    log(`[tg] 任务 ${jobId.slice(0, 8)} 交付失败（文件留在 ${absPath}）：${rec.deliverError}`);
  }
}

function watchJob(jobId) {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    const rec = jobs.get(jobId);
    if (!rec) { clearInterval(timer); return; }
    try {
      const j = await sidecarFetch(`/job?id=${jobId}`, {}, 15000);
      if (j.status === 'done') { clearInterval(timer); await deliver(jobId); }
      else if (j.status === 'error') { clearInterval(timer); rec.error = j.error; log(`[tg] 任务 ${jobId.slice(0, 8)} 失败：${j.error}`); }
    } catch { /* 侧车瞬时不可达，下轮再看 */ }
    if (Date.now() - t0 > DOWNLOAD_TIMEOUT_MS) { clearInterval(timer); rec.error = '下载超时'; }
  }, 5000);
}

export async function tgDownload(key, channel, msgId) {
  const c = tgCfg();
  const ch = gateChannel(channel);
  const q = quotaFile();
  if (c.dailyLimit > 0 && q.count(key) >= c.dailyLimit) throw new Error(`今日下载次数已用完（${c.dailyLimit}/天）`);
  const body = await sidecarFetch('/download', { method: 'POST', body: JSON.stringify({ channel: ch, msgId: Number(msgId), maxBytes: c.maxFileBytes }) }, 60000);
  if (!body.jobId) throw new Error(body.error ?? '侧车未受理');
  const jobId = body.jobId;
  jobs.set(jobId, { key, channel: ch, msgId: Number(msgId), started: Date.now(), delivered: false });
  q.bump(key);
  watchJob(jobId);
  // 立刻取一次 size/fileName 给用户报口径（sidecar 起任务后异步填 size，稍等片刻再查）
  await new Promise((r) => setTimeout(r, 1200));
  let size = 0, fileName = '', status = 'running';
  try {
    const j = await sidecarFetch(`/job?id=${jobId}`, {}, 15000);
    size = j.size || 0; fileName = j.fileName || ''; status = j.status;
  } catch { /* 查不到就先只回 jobId */ }
  if (size > c.maxFileBytes) { /* maxBytes 由侧车拦，这里只兜底 */ }
  return { jobId, channel: ch, msgId: Number(msgId), size, fileName, status };
}

export async function tgJob(jobId) {
  const rec = jobs.get(String(jobId));
  if (!rec) return { known: false };
  try {
    const j = await sidecarFetch(`/job?id=${jobId}`, {}, 15000);
    return {
      known: true, key: rec.key, status: j.status, got: j.got, size: j.size, fileName: j.fileName,
      pct: j.size ? Math.min(100, Math.round((j.got / j.size) * 100)) : 0,
      channel: rec.channel, delivered: rec.delivered, error: j.error || rec.error || '',
    };
  } catch (e) {
    return { known: true, status: 'unknown', error: `侧车不可达：${e?.message ?? e}` };
  }
}

export function tgEnabled() { return tgCfg().enabled; }

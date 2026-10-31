// NapCat 会话守护（2026-10-26 半版重建：探测 + 报警，不自动重启）。
//
// 为什么需要它｜两次亲历：
//   · 2026-09-16（旧栈时期）：QQ「静默死」50 分钟——服务端作废登录态，客户端零报错、isLogin 仍 true。
//   · 2026-10-25（本部署）：同样剧本，22:55 后消息静默丢失 1.5 小时，靠用户人肉发现。
//   共同点：TCP 活着、桥的重连逻辑不触发、get_login_info 照样返回在线——**唯一能逮住它的是
//   get_rkey 探针**（每次真打腾讯服务器，登录态作废即失败）。
//
// 半版的边界（为什么只报警不动手）：
//   自动重启的前提是「重启后能自动登回来」（密码回退登录）。密码回退当前被短信风控卡着
//   未激活——此时自动重启会把 bot 推进「等扫码」状态，凌晨没人扫码 = 彻底停机到早上，比僵尸更糟。
//   等密码回退激活后，把 cfg.guard.autoHeal 打开即可升级全自动（本文件预留 heal 分支）。
//
// 2026-10-27 升级 L0（主人批准）：只治「假死」，不治「被踢」。
//   · 重启用 systemd（sudo -n systemctl restart），有窗口预算 + 退避 + 二维码新鲜度闸；
//   · 被踢/令牌作废时 NapCat 自己在等扫码（qrcode.png 新鲜），此时**禁止重启**（会把码作废）；
//   · 仍需要人扫码的那一步没有自动化，L1（跨通道告警带二维码）等主人的告警通道定了再接。
//
// 历史：本文件的 2026-09-23 版曾被裁成空壳（探针/自愈全删）；docker 重启链与 WebUI 换码
//   一并删除的原因（登录额度抢占、换码作废用户手上的码）见 git 历史。本版只恢复探针与报警，
//   重启动作不做，docker 相关导出改为无 Docker 部署下的明确报错。

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GUARD_FILE = path.join(STATE_DIR, 'napcat-guard.json');

const DEFAULTS = {
  enabled: true,          // 默认启动；config guard.enabled=false 关闭
  probeIntervalMs: 60000, // 探针周期
  failThreshold: 2,       // 连续失败 N 次（≈2 分钟）判定会话死
  alertCooldownMs: 900000, // 持续故障时的重复报警间隔（15 分钟一条，不轰炸）
  probeTimeoutMs: 8000,
  /* 2026-10-27 L0 自愈（主人批准）：只治「假死」，不治「被踢」。
   * 被踢/令牌作废时 NapCat 会自己进扫码等待并写出 qrcode.png —— 那种情况重启只会把码作废，
   * 所以 qrWaitMs 内看到新鲜二维码一律不重启。 */
  autoHeal: false,
  healWindowMs: 6 * 3600e3,
  maxHealsPerWindow: 3,
  healBackoffMs: [0, 2 * 60e3, 10 * 60e3],
  recoverWaitMs: 150000,
  qrWaitMs: 180000,
  serviceName: 'qq-agent-napcat',
  /* 2026-10-29 Windows 本地栈自愈（两次被踢实证：systemd 命令在 win32 上全是白跑）。
   * 假死半死态（二维码陈旧、不出新码）时：杀 NapCatWinBootMain 进程树 + 补刀占 3000 的孤儿
   * → 用这个 launcher 重新拉起 NapCat 进扫码流程。注意绝不能按镜像名杀 QQ.exe（主人的个人 QQ 同名），
   * 只准杀 boot main 树和占 3000 端口的那个 PID。服务器（linux）走 systemd，本键忽略。 */
  winLauncherPath: '',
  /* 2026-10-28 静默探测（主人：「这种情况要避免，不然半天排查不出来」）：
   * 现场——NapCat 报 online/good、HTTP 探针全过、心跳每 5 秒照来、bot 还能往外发，
   * 但手机发来的私聊一条都进不来（19:24 之后 29 分钟零事件）。所有现有探针都判健康。
   * 判据：桥的"真实事件水位"（心跳不算）N 分钟内没动，而 NapCat 最近联系人里的最新消息时间
   * 比它更新 —— 说明 QQ 那边收到了、桥这边没收到 → 收包通道卡死。
   * 只报警不自动重启：这种状态重启 NapCat 要扫码，凌晨没人扫比半死更糟。 */
  silentCheckMs: 5 * 60e3,      // 每 5 分钟查一次
  silentMinMs: 10 * 60e3,       // 桥这边 10 分钟没有任何真实事件才进入比对
  silentGraceMs: 90e3,          // NapCat 最新消息要比桥的水位再新 90 秒（吃掉跨境/时钟抖动）
  silentAlertCooldownMs: 30 * 60e3,
};

let cfgRef = null;
let callAction = null; // (action, params) => Promise<OneBot 应答>；bridge 注入 bot.raw
let sendFn = null;     // (key, text) => Promise；bridge 注入 sendToQQ
let getLastEventAt = null; // () => number：桥最近一条真实事件的毫秒时间戳（心跳不算）
let timer = null;
let ticking = false;

export function initNapcatGuard(cfg, opts = {}) {
  cfgRef = cfg;
  if (typeof opts.callAction === 'function') callAction = opts.callAction;
  if (typeof opts.send === 'function') sendFn = opts.send;
  if (typeof opts.getLastEventAt === 'function') getLastEventAt = opts.getLastEventAt;
}

function guardCfg() { return { ...DEFAULTS, ...(cfgRef?.guard ?? {}) }; }
function ownerKey() { return cfgRef?.ownerQQ ? `private:${cfgRef.ownerQQ}` : ''; }

function readState() {
  const s = readJsonSafe(GUARD_FILE, null);
  return {
    lastProbeAt: 0,
    lastProbeOk: false,
    lastProbeDetail: '',
    consecutiveFails: 0,
    alerting: false,
    lastAlertAt: 0,
    lastRecoverAt: 0,
    ...(s && typeof s === 'object' ? s : {}),
  };
}
function writeState(s) {
  try { atomicWriteJson(GUARD_FILE, s); } catch (e) { log(`[napcat-guard] 状态写盘失败（忽略）: ${e?.message ?? e}`); }
}

/** get_rkey 探针：返回 {ok, detail}。
 *  注意 bot.raw() 的应答形状（onebot-ws.js:395）：**成功时 resolve 的是 resp.data**（get_rkey
 *  即 rkey 数组，没有 retcode 字段），失败时直接 reject——所以「拿到非空数组」= 成功，
 *  「抛错」= 失败。别按完整 OneBot 应答的 retcode 判断（第一版就这么误报的）。
 *
 *  2026-10-28 分层探针（本地 Windows 装机实战教训）：get_rkey 依赖 packetBackend，本地装机
 *  没配 packet → 探针**永久失败**但会话其实健康，看门狗连续 289 次误报「会话疑似死亡」刷屏主人。
 *  现在 get_rkey 失败时先看失败原因：凡 detail 命中 packetBackend（= NapCat 能力缺失，不是
 *  登录态死）→ 自动降级 get_login_info 判活，结果标 degraded；真超时/其它失败才计入死亡。 */
async function probeLoginInfo(timeoutMs) {
  try {
    const r = await Promise.race([
      callAction('get_login_info', {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`get_login_info 探针超时 ${timeoutMs}ms`)), timeoutMs)),
    ]);
    if (r && typeof r === 'object' && (Number(r.user_id) > 0 || Number(r.retcode) === 0)) {
      return { ok: true, detail: `login_info ok（${String(r.nickname ?? '').slice(0, 16) || r.user_id}）` };
    }
    return { ok: false, detail: `login_info 应答形状异常: ${JSON.stringify(r).slice(0, 80)}` };
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 120) };
  }
}

async function probeOnce(timeoutMs) {
  if (typeof callAction !== 'function') return { ok: false, detail: 'callAction 未注入（桥初始化异常）' };
  let deep;
  try {
    deep = await Promise.race([
      callAction('get_rkey', {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`探针超时 ${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (e) {
    const detail = String(e?.message ?? e).slice(0, 160);
    if (/packetBackend/i.test(detail)) {
      const lite = await probeLoginInfo(timeoutMs);
      return { ...lite, degraded: true };
    }
    return { ok: false, detail };
  }
  if (Array.isArray(deep)) {
    if (deep.length > 0) return { ok: true, detail: `rkey ok（${deep.length} 条）` };
    return { ok: false, detail: 'rkey 数组为空（登录态异常）' };
  }
  if (deep && typeof deep === 'object' && Number(deep.retcode) === 0 && Array.isArray(deep.data)) {
    return { ok: true, detail: `rkey ok（${deep.data.length} 条）` };
  }
  const shape = JSON.stringify(deep).slice(0, 160);
  if (/packetBackend/i.test(shape)) {
    const lite = await probeLoginInfo(timeoutMs);
    return { ...lite, degraded: true };
  }
  return { ok: false, detail: `应答形状异常: ${shape}` };
}

/* ── L0 自愈：判定与执行（2026-10-27） ──────────────────────────────────────── */

/** NapCat 落盘的二维码路径候选（与 qrSnapshot 同一套）。 */
function qrPathCandidates() {
  const boot = String(cfgRef?.napcat?.bootMain ?? '');
  return [
    boot ? path.join(boot, 'napcat', 'cache', 'qrcode.png') : '',
    '/home/ubuntu/qq-agent/napcat/napcat/cache/qrcode.png',
  ].filter(Boolean);
}

/** 二维码文件的年龄（ms）。没有码 = Infinity（不是在等扫码）。 */
function qrAgeMs(now = Date.now()) {
  for (const p of qrPathCandidates()) {
    try { return now - fs.statSync(p).mtimeMs; } catch { /* 试下一个 */ }
  }
  return Infinity;
}

/** 纯判定（无副作用，可单测）：现在该不该重启。
 *  顺序：开关 → 是否正在等扫码 → 窗口预算 → 退避。 */
export function decideHeal({ state, cfg, now = Date.now(), qrAge = Infinity } = {}) {
  const g = { ...DEFAULTS, ...(cfg || {}) };
  if (g.autoHeal !== true) return { heal: false, why: 'autoHeal 未开启（只报警不动手）' };
  if (Number.isFinite(qrAge) && qrAge < g.qrWaitMs) {
    return { heal: false, why: `正在等扫码（二维码 ${Math.round(qrAge / 1000)}s 前生成），重启会作废这张码` };
  }
  const heals = (Array.isArray(state?.heals) ? state.heals : []).filter((t) => now - Number(t) < g.healWindowMs);
  if (heals.length >= g.maxHealsPerWindow) {
    return { heal: false, why: `窗口内已自动重启 ${heals.length} 次（上限 ${g.maxHealsPerWindow}）` };
  }
  const last = heals.length ? Number(heals[heals.length - 1]) : 0;
  const gap = Number(g.healBackoffMs[Math.min(heals.length, g.healBackoffMs.length - 1)]) || 0;
  if (last && now - last < gap) {
    return { heal: false, why: `退避中，还需 ${Math.ceil((gap - (now - last)) / 60000)} 分钟` };
  }
  return { heal: true, why: heals.length ? `第 ${heals.length + 1} 次` : '首次' };
}

async function restartService(g) {
  const started = Date.now();
  try {
    if (process.platform === 'win32') {
      /* Windows 本地栈：没有 systemd。等价动作 = 杀 boot main 进程树（含它拉起的 QQ）
       * → 3000 若仍被孤儿 QQ 占着就按 PID 精确补一刀 → 用 launcher 重新拉起进扫码流程。
       * launcher 未配置时明确失败，绝不假装成功（那样预算被白白消耗还无人知晓）。 */
      const lp = String(g.winLauncherPath || '').trim();
      if (!lp) return { ok: false, ms: Date.now() - started, error: 'win32 未配置 guard.winLauncherPath（launcher-bot.bat 路径），无法自动重启' };
      /* 2026-10-30 两条加固（当日掉线事故）：
       * ① 僵尸持锁：旧 QQ 主进程（--user-data-dir=<bot 数据目录>）没死透会握着数据目录锁，
       *    之后每次新实例都静默起不来——实测看门狗连打 3 次全失败、手动重启也失败。
       *    从 launcher 自身解析数据目录，只杀命令行含该目录的 QQ.exe（绝不碰主人个人 QQ）。
       * ② 隐藏启动：优先用同目录的 launcher-bot-hidden.vbs，不弹黑色 cmd 窗口——
       *    主人关掉那个窗口会连带杀死整棵 QQ 进程树，等于"刚修好又掉线"。 */
      try {
        const batText = fs.readFileSync(lp, 'utf8');
        const mDir = /--user-data-dir=([^\s"]+)/.exec(batText);
        const botDir = mDir ? mDir[1].trim() : '';
        if (botDir) {
          const psDir = botDir.replace(/'/g, "''");
          await execFileAsync('powershell', ['-NoProfile', '-Command',
            `$d='${psDir}'; Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
          ], { timeout: 25000 }).catch(() => {});
          await sleep(1500);
        }
      } catch { /* 解析/清理失败不阻塞后续重启 */ }
      await execFileAsync('taskkill', ['/F', '/IM', 'NapCatWinBootMain.exe', '/T'], { timeout: 15000 }).catch(() => {});
      await sleep(2000);
      const out = await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'netstat -ano | findstr ":3000 .*LISTENING"'], { timeout: 10000 }).catch(() => ({ stdout: '' }));
      const pid = String(out.stdout ?? '').trim().split(/\r?\n/)[0]?.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid ?? '')) {
        await execFileAsync('taskkill', ['/F', '/PID', pid, '/T'], { timeout: 15000 }).catch(() => {});
        await sleep(1000);
      }
      const hiddenVbs = path.join(path.dirname(lp), 'launcher-bot-hidden.vbs');
      if (fs.existsSync(hiddenVbs)) {
        spawn('wscript.exe', [hiddenVbs], { cwd: path.dirname(lp), detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else {
        spawn(lp, [], { cwd: path.dirname(lp), detached: true, stdio: 'ignore', windowsHide: true, shell: true }).unref();
      }
      return { ok: true, ms: Date.now() - started };
    }
    await execFileAsync('sudo', ['-n', 'systemctl', 'restart', g.serviceName], { timeout: 30000 });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: `${e?.code ?? ''} ${e?.message ?? e}`.trim().slice(0, 200) };
  }
}

/** 重启后等登录回来：每 10s 探一次，直到 recoverWaitMs 用完。 */
async function waitRecover(g) {
  const deadline = Date.now() + Math.max(30000, Number(g.recoverWaitMs) || 150000);
  let last = { ok: false, detail: '重启后未探测' };
  while (Date.now() < deadline) {
    await sleep(10000);
    last = await probeOnce(g.probeTimeoutMs);
    if (last.ok) return last;
  }
  return { ok: false, detail: `等待 ${Math.round((Number(g.recoverWaitMs) || 150000) / 1000)}s 仍未恢复：${last.detail}` };
}

/** 手动自愈（管理端调用）：不看去重/退避，只受开关约束——但照样不碰正在等扫码的状态。 */
export async function healNow(reason = 'manual') {
  const g = guardCfg();
  const s = readState();
  const qrAge = qrAgeMs();
  if (Number.isFinite(qrAge) && qrAge < g.qrWaitMs) {
    return { ok: false, error: `正在等扫码（二维码 ${Math.round(qrAge / 1000)}s 前生成），重启会作废这张码` };
  }
  const r = await restartService(g);
  s.heals = [...(Array.isArray(s.heals) ? s.heals : []).slice(-19), Date.now()];
  s.lastHealAt = Date.now();
  s.lastHealResult = r.ok ? `手动重启已执行（${reason}）` : `手动重启失败：${r.error}`;
  writeState(s);
  log(`[napcat-guard] ${s.lastHealResult}`);
  if (!r.ok) return { ok: false, error: s.lastHealResult };
  const rec = await waitRecover(g);
  s.lastHealResult = rec.ok ? '手动重启后恢复' : `手动重启后仍未恢复：${rec.detail}`;
  if (rec.ok) { s.consecutiveFails = 0; s.alerting = false; s.lastRecoverAt = Date.now(); }
  writeState(s);
  return { ok: rec.ok, detail: s.lastHealResult, status: guardStatus() };
}

/** 尽力通知 owner（QQ 通道本身可能已死——日志必达，QQ 通知尽力而为）。 */
/** 北京时间字符串（只用于诊断文案） */
function fmtBj(ms) {
  try { return new Date(Number(ms) + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' '); }
  catch { return String(ms); }
}

/** NapCat 侧"最近联系人里的最新消息时间"（毫秒）；查不到返回 0（宁可漏报，不误报） */
async function recentContactMaxTs(timeoutMs) {
  if (typeof callAction !== 'function') return 0;
  try {
    const r = await Promise.race([
      callAction('get_recent_contact', { count: 10 }),
      sleep(Math.max(2000, Number(timeoutMs) || 8000)).then(() => ({ __timeout: true })),
    ]);
    if (!r || r.__timeout) return 0;
    const list = Array.isArray(r?.data) ? r.data : (Array.isArray(r?.data?.data) ? r.data.data : []);
    let maxTs = 0;
    for (const c of list) {
      const raw = c?.lastestMsg ?? c?.latestMsg ?? c?.lastest_msg;
      const m = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      const t = Number(m?.time) || 0;
      if (t > 0 && t * 1000 > maxTs) maxTs = t * 1000;
    }
    return maxTs;
  } catch { return 0; }
}

/**
 * 静默判定的纯函数版（单测用）：给三个时间戳，说是不是"QQ 收到了、桥没收到"。
 * 返回 why 便于日志与排查：no-data / recent-event / no-newer-msg / stalled。
 */
export function decideSilentChannel(a = {}) {
  const now = Number(a.now) || Date.now();
  const last = Number(a.lastEventAt) || 0;
  const newest = Number(a.newestMsgAt) || 0;
  const minMs = Number.isFinite(Number(a.silentMinMs)) ? Math.max(60e3, Number(a.silentMinMs)) : 10 * 60e3;
  const graceMs = Number.isFinite(Number(a.silentGraceMs)) ? Math.max(0, Number(a.silentGraceMs)) : 90e3;
  if (!last || !newest) return { suspect: false, why: 'no-data' };
  if (now - last < minMs) return { suspect: false, why: 'recent-event' };
  if (newest <= last + graceMs) return { suspect: false, why: 'no-newer-msg' };
  return { suspect: true, why: 'stalled', gapMs: newest - last };
}

/**
 * 收包通道静默探测（2026-10-28，主人拍板"这种情况要避免"）。
 * 判据：桥的「真实事件水位」超过 silentMinMs 没动，而 NapCat 最近联系人里的最新消息比它更新
 * （再宽限 silentGraceMs）→ QQ 收到了、桥没收到 → 收包通道卡死。
 * 只报警、不自动重启：这种状态重启 NapCat 需要扫码，深夜没人扫比半僵更糟。
 */
async function silentChannelCheck(s, g, now) {
  if (typeof getLastEventAt !== 'function') return;
  if (now - (Number(s.lastSilentCheckAt) || 0) < Math.max(60e3, Number(g.silentCheckMs) || 0)) return;
  s.lastSilentCheckAt = now;
  const lastEvent = Number(getLastEventAt()) || 0;
  const newest = await recentContactMaxTs(g.probeTimeoutMs);
  const d = decideSilentChannel({
    now, lastEventAt: lastEvent, newestMsgAt: newest,
    silentMinMs: g.silentMinMs, silentGraceMs: g.silentGraceMs,
  });
  if (!d.suspect) {
    if (s.silentSuspectedAt) log(`[napcat-guard] 收包通道已恢复（${d.why}）`);
    s.silentSuspectedAt = 0;
    s.silentDetail = '';
    return;
  }
  const first = !s.silentSuspectedAt;
  s.silentSuspectedAt = s.silentSuspectedAt || now;
  s.silentDetail = `NapCat 最新消息 ${fmtBj(newest)}，桥最后一条真实事件 ${fmtBj(lastEvent)}（差 ${Math.round(d.gapMs / 60000)} 分钟）`;
  log(`[napcat-guard] 收包通道疑似卡死：${s.silentDetail}`);
  if (first || now - (Number(s.lastSilentAlertAt) || 0) >= Math.max(60e3, Number(g.silentAlertCooldownMs) || 0)) {
    s.lastSilentAlertAt = now;
    await notifyOwner(`[看门狗] ⚠️ 我这边收不到新消息了：${s.silentDetail}。桥的连接和登录探针都正常，这种状态重启桥没用，得重启 NapCat（可能要扫码）。`);
  }
}

async function notifyOwner(text) {  const k = ownerKey();
  log(`[napcat-guard] ${text}`);
  if (!k || typeof sendFn !== 'function') return;
  try { await sendFn(k, text); } catch { /* 通道已死属预期，日志已记 */ }
}

export async function guardTick(force = false) {
  if (ticking) return guardStatus();
  ticking = true;
  try {
    const g = guardCfg();
    if (!g.enabled && !force) return guardStatus();
    const s = readState();
    const probe = await probeOnce(g.probeTimeoutMs);
    s.lastProbeAt = Date.now();
    s.lastProbeOk = probe.ok;
    s.lastProbeDetail = probe.detail;
    if (probe.ok) {
      s.consecutiveFails = 0;
      // 探针绿了也要看"消息在不在进来"——这是 2026-10-28 那次 29 分钟静默唯一逮得住的判据
      await silentChannelCheck(s, g, Date.now());
      if (s.alerting) {
        s.alerting = false;
        s.lastRecoverAt = Date.now();
        await notifyOwner(`[看门狗] NapCat 会话已恢复（探针通过）。刚才那段故障期间的 QQ 消息可能没有送达，若有遗漏请让对方重发。`);
      }
    } else {
      s.consecutiveFails += 1;
      if (s.consecutiveFails >= g.failThreshold) {
        const now = Date.now();
        const first = !s.alerting;
        const d = decideHeal({ state: s, cfg: g, now, qrAge: qrAgeMs(now) });
        if (d.heal) {
          log(`[napcat-guard] 连续 ${s.consecutiveFails} 次探针失败 → 自动重启 ${g.serviceName}（${d.why}）`);
          const r = await restartService(g);
          s.heals = [...(Array.isArray(s.heals) ? s.heals : []).slice(-19), now];
          s.lastHealAt = now;
          s.lastHealResult = r.ok ? '重启命令已执行，等待登录…' : `重启失败：${r.error}`;
          writeState(s);
          if (r.ok) {
            const rec = await waitRecover(g);
            if (rec.ok) {
              s.consecutiveFails = 0;
              s.alerting = false;
              s.lastRecoverAt = Date.now();
              s.lastProbeOk = true;
              s.lastProbeDetail = rec.detail;
              s.lastHealResult = `自动重启后恢复（重启用了 ${r.ms}ms）`;
              writeState(s);
              await notifyOwner('[看门狗] NapCat 假死已自动重启并恢复登录。故障期间的消息可能没送达，若有遗漏请让对方重发。');
              return guardStatus();
            }
            s.lastHealResult = `自动重启后仍未恢复：${rec.detail}`;
            writeState(s);
            if (first || now - s.lastAlertAt >= g.alertCooldownMs) {
              s.alerting = true;
              s.lastAlertAt = Date.now();
              await notifyOwner(`[看门狗] ⚠️ 自动重启后 NapCat 仍未恢复登录（${rec.detail}）——很可能需要扫码，请到管理端 NapCat 卡取二维码。`);
            }
          } else if (first || now - s.lastAlertAt >= g.alertCooldownMs) {
            s.alerting = true;
            s.lastAlertAt = Date.now();
            await notifyOwner(`[看门狗] ⚠️ 自动重启失败：${r.error}`);
          }
        } else if (first || now - s.lastAlertAt >= g.alertCooldownMs) {
          s.alerting = true;
          s.lastAlertAt = now;
          await notifyOwner(`[看门狗] ⚠️ NapCat 会话疑似死亡：探针连续 ${s.consecutiveFails} 次失败（${probe.detail}）。未自动重启：${d.why}。`);
        }
      }
    }
    writeState(s);
    return guardStatus();
  } finally {
    ticking = false;
  }
}

export function guardStatus() {
  const s = readState();
  const g = guardCfg();
  const heals = (Array.isArray(s.heals) ? s.heals : []).filter((t) => Date.now() - Number(t) < g.healWindowMs);
  const qrAge = qrAgeMs();
  return {
    removed: false,
    enabled: g.enabled,
    autoHeal: g.autoHeal === true,
    autoHealSource: 'config',
    probeMode: 'get_rkey（真打腾讯服务器）；packetBackend 缺失时自动降级 get_login_info（2026-10-28 分层探针）',
    lastProbeAt: s.lastProbeAt,
    lastProbeOk: s.lastProbeOk,
    lastProbeDetail: s.lastProbeDetail,
    consecutiveFails: s.consecutiveFails,
    failThreshold: g.failThreshold,
    probeIntervalMs: g.probeIntervalMs,
    alerting: s.alerting,
    lastAlertAt: s.lastAlertAt,
    lastRecoverAt: s.lastRecoverAt,
    heals,
    healBudget: { windowHours: Math.round(g.healWindowMs / 3600e3), used: heals.length, max: g.maxHealsPerWindow },
    lastHealAt: s.lastHealAt || 0,
    lastHealResult: s.lastHealResult || '未执行过',
    silentChannel: {
      checkedAt: s.lastSilentCheckAt || 0,
      suspectedAt: s.silentSuspectedAt || 0,
      detail: s.silentDetail || '',
      lastEventAt: typeof getLastEventAt === 'function' ? (Number(getLastEventAt()) || 0) : 0,
      thresholds: { checkMs: g.silentCheckMs, minMs: g.silentMinMs, graceMs: g.silentGraceMs },
    },
    qrAgeSec: Number.isFinite(qrAge) ? Math.round(qrAge / 1000) : null,
    waitingForScan: Number.isFinite(qrAge) && qrAge < g.qrWaitMs,
    alert: s.alerting ? { kind: 'session-dead', detail: s.lastProbeDetail, at: s.lastAlertAt } : null,
    passwordFallback: { configured: false, source: 'none（本部署未启用；密码回退受短信风控限制，见部署文档第 7 条）' },
    container: { name: `systemd:${g.serviceName}`, status: g.autoHeal === true ? 'probe+autoheal' : 'probe-only', startedAt: '' },
  };
}

/** 管理端开关：{ enabled?, autoHeal? }。 */
export function setGuardConfig(patch = {}) {
  if (!cfgRef.guard || typeof cfgRef.guard !== 'object') cfgRef.guard = {};
  if (patch.enabled === true || patch.enabled === false) cfgRef.guard.enabled = patch.enabled;
  if (patch.autoHeal === true || patch.autoHeal === false) cfgRef.guard.autoHeal = patch.autoHeal;
  log(`[napcat-guard] 管理端设置: ${JSON.stringify(patch)}（enabled=${guardCfg().enabled} autoHeal=${guardCfg().autoHeal === true}）`);
  if (guardCfg().enabled) startNapcatGuard();
  else if (timer) { clearInterval(timer); timer = null; log('[napcat-guard] 探针已停用'); }
  return guardStatus();
}

export function startNapcatGuard() {
  const g = guardCfg();
  if (timer) { clearInterval(timer); timer = null; }
  if (!g.enabled) {
    log('[napcat-guard] 已按配置停用（guard.enabled=false）');
    return;
  }
  timer = setInterval(() => { guardTick().catch(() => {}); }, g.probeIntervalMs);
  // 启动后先歇一个周期再首探（给 NapCat 热身时间，避开重启窗口的误报）
  log(`[napcat-guard] 看门狗已启动：每 ${Math.round(g.probeIntervalMs / 1000)}s 探针（get_rkey，packetBackend 缺失时降级 get_login_info），连续 ${g.failThreshold} 次失败${g.autoHeal === true ? `自动重启（${g.maxHealsPerWindow} 次/${Math.round(g.healWindowMs / 3600e3)}h 预算，等扫码时不重启）` : '报警（不自动重启）'}`);
}

/* ── 管理端历史接口（保留签名，无 Docker 部署下的适配） ─────────────────────── */

/** 读 NapCat 写在盘上的现成二维码（只读不换码；换码能力 2026-09-23 已定稿删除）。 */
export async function qrSnapshot() {
  const src = path.join(String(cfgRef?.napcat?.bootMain ?? ''), 'napcat', 'cache', 'qrcode.png');
  const candidates = [src, '/home/ubuntu/qq-agent/napcat/napcat/cache/qrcode.png'];
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(p);
      return { ok: true, path: p, bytes: buf.length, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
    } catch { /* 试下一个 */ }
  }
  return { ok: false, error: '盘上暂无二维码（没在等登录）' };
}

export async function exportQrFresh() {
  const r = await qrSnapshot();
  return r.ok ? r.path : null;
}

/** 密码回退配置：Docker 容器重建链已不适用本部署（systemd 原生跑）。
 *  正确路径：把 ACCOUNT + NAPCAT_QUICK_PASSWORD_MD5 写进 ~/.config/qq-agent.env
 *  （napcat 单元已配 EnvironmentFile），重启 qq-agent-napcat 即可。 */
export async function applyQuickPassword() {
  return { ok: false, error: '本部署为 systemd 原生（无 Docker），容器重建接口不适用。密码回退请写 ~/.config/qq-agent.env（ACCOUNT + NAPCAT_QUICK_PASSWORD_MD5）后 systemctl restart qq-agent-napcat。' };
}

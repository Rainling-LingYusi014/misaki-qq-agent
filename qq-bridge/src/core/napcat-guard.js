// NapCat 会话守护（2026-10-26 半版重建：探测 + 报警，不自动重启）。
//
// 为什么需要它｜两次亲历：
//   · 2026-09-16（泠娜）：QQ「静默死」50 分钟——服务端作废登录态，客户端零报错、isLogin 仍 true。
//   · 2026-10-25（本部署）：同样剧本，22:55 后消息静默丢失 1.5 小时，靠用户人肉发现。
//   共同点：TCP 活着、桥的重连逻辑不触发、get_login_info 照样返回在线——**唯一能逮住它的是
//   get_rkey 探针**（每次真打腾讯服务器，登录态作废即失败）。
//
// 半版的边界（为什么只报警不动手）：
//   自动重启的前提是「重启后能自动登回来」（密码回退登录）。密码回退当前被短信风控卡着
//   未激活——此时自动重启会把 bot 推进「等扫码」状态，凌晨没人扫码 = 彻底停机到早上，比僵尸更糟。
//   等密码回退激活后，把 cfg.guard.autoHeal 打开即可升级全自动（本文件预留 heal 分支）。
//
// 历史：本文件的 2026-09-23 版曾被裁成空壳（探针/自愈全删）；docker 重启链与 WebUI 换码
//   一并删除的原因（登录额度抢占、换码作废用户手上的码）见 git 历史。本版只恢复探针与报警，
//   重启动作不做，docker 相关导出改为无 Docker 部署下的明确报错。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';

const GUARD_FILE = path.join(STATE_DIR, 'napcat-guard.json');

const DEFAULTS = {
  enabled: true,          // 默认启动；config guard.enabled=false 关闭
  probeIntervalMs: 60000, // 探针周期
  failThreshold: 2,       // 连续失败 N 次（≈2 分钟）判定会话死
  alertCooldownMs: 900000, // 持续故障时的重复报警间隔（15 分钟一条，不轰炸）
  probeTimeoutMs: 8000,
  autoHeal: false,        // 半版恒 false；密码回退激活后可开（届时补重启实现）
};

let cfgRef = null;
let callAction = null; // (action, params) => Promise<OneBot 应答>；bridge 注入 bot.raw
let sendFn = null;     // (key, text) => Promise；bridge 注入 sendToQQ
let timer = null;
let ticking = false;

export function initNapcatGuard(cfg, opts = {}) {
  cfgRef = cfg;
  if (typeof opts.callAction === 'function') callAction = opts.callAction;
  if (typeof opts.send === 'function') sendFn = opts.send;
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
 *  「抛错」= 失败。别按完整 OneBot 应答的 retcode 判断（第一版就这么误报的）。 */
async function probeOnce(timeoutMs) {
  if (typeof callAction !== 'function') return { ok: false, detail: 'callAction 未注入（桥初始化异常）' };
  try {
    const r = await Promise.race([
      callAction('get_rkey', {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`探针超时 ${timeoutMs}ms`)), timeoutMs)),
    ]);
    if (Array.isArray(r)) {
      if (r.length > 0) return { ok: true, detail: `rkey ok（${r.length} 条）` };
      return { ok: false, detail: 'rkey 数组为空（登录态异常）' };
    }
    if (r && typeof r === 'object' && Number(r.retcode) === 0 && Array.isArray(r.data)) {
      return { ok: true, detail: `rkey ok（${r.data.length} 条）` };
    }
    return { ok: false, detail: `应答形状异常: ${JSON.stringify(r).slice(0, 80)}` };
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 120) };
  }
}

/** 尽力通知 owner（QQ 通道本身可能已死——日志必达，QQ 通知尽力而为）。 */
async function notifyOwner(text) {
  const k = ownerKey();
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
        if (first || now - s.lastAlertAt >= g.alertCooldownMs) {
          s.alerting = true;
          s.lastAlertAt = now;
          await notifyOwner(`[看门狗] ⚠️ NapCat 会话疑似死亡：探针连续 ${s.consecutiveFails} 次失败（${probe.detail}）。${first ? '半版看门狗只报警不自动重启——请让管理员重启 qq-agent-napcat。' : '（持续故障提醒）'}`);
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
  return {
    removed: false,
    enabled: g.enabled,
    autoHeal: g.autoHeal,
    autoHealSource: 'config',
    probeMode: 'get_rkey（真打腾讯服务器，唯一能逮住静默死）',
    lastProbeAt: s.lastProbeAt,
    lastProbeOk: s.lastProbeOk,
    lastProbeDetail: s.lastProbeDetail,
    consecutiveFails: s.consecutiveFails,
    failThreshold: g.failThreshold,
    probeIntervalMs: g.probeIntervalMs,
    alerting: s.alerting,
    lastAlertAt: s.lastAlertAt,
    lastRecoverAt: s.lastRecoverAt,
    heals: [],
    lastHealAt: 0,
    lastHealResult: '半版：不自动重启（等密码回退激活后开 autoHeal）',
    alert: s.alerting ? { kind: 'session-dead', detail: s.lastProbeDetail, at: s.lastAlertAt } : null,
    passwordFallback: { configured: false, source: 'none' },
    container: { name: 'systemd:qq-agent-napcat', status: 'probe-only', startedAt: '' },
  };
}

/** 管理端开关：{ enabled? }（autoHeal 字段保留但半版忽略）。 */
export function setGuardConfig(patch = {}) {
  if (patch.enabled === true || patch.enabled === false) {
    if (!cfgRef.guard || typeof cfgRef.guard !== 'object') cfgRef.guard = {};
    cfgRef.guard.enabled = patch.enabled;
  }
  log(`[napcat-guard] 管理端设置: ${JSON.stringify(patch)}（enabled=${guardCfg().enabled}）`);
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
  log(`[napcat-guard] 半版看门狗已启动：每 ${Math.round(g.probeIntervalMs / 1000)}s get_rkey 探针，连续 ${g.failThreshold} 次失败报警（不自动重启）`);
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

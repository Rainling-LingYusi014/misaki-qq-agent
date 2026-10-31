// 作息仪式（2026-10-13）：晚安 / 早安流程的计时侧。
// 需求：sleep-switch.sh 的「睡」不再瞬间熄灯，改为 POST /api/social/goodnight/start ——
// 她先跟主人道晚安，然后 5+x 分钟（x∈[5,15]，即 10~20min）后自动 paused。
// 「醒」侧由脚本先 POST activity{paused:false}（老行为不变）再 POST /api/social/morning/start
// 触发早安唤醒（道早安 + 补回睡觉期间的未读）。
// 本模块只管：熄灯时刻的持久化 + 计时 + 桥重启后的恢复 + 到点熄灯（复用 /api/social/activity
// 的 paused 语义，避免在模块里重抄一遍 pause/unpause 的清理逻辑）。
// goodnight / morning 的提示词在 wake-send.js 的 buildWakePrompt。
import path from 'node:path';
import fs from 'node:fs';
import { SOCIAL_STATE_FILE } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { sendWakePrompt } from './wake-send.js';
import { activeAiTurns } from './session-state.js';

const BRIDGE_BASE = 'http://127.0.0.1:3100';
const RETRY_BUSY_MS = 30_000;    // 到点时她正处在 AI 回合 → 等这回合说完再熄灯
const RETRY_HTTP_MS = 60_000;    // 熄灯请求发失败 → 稍后重试（不允许出现整夜不睡）
const STALE_GRACE_MS = 6 * 3600_000; // 重启恢复：过期超过这么久的熄灯时刻视为陈年残留，只清理不补熄

const STATE_FILE = path.join(path.dirname(SOCIAL_STATE_FILE), 'ritual.json');

let ownerKey = null;
let timer = null;
const rt = { goodnightUntil: 0 };

function persist() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(rt)); } catch (e) {
    log(`[ritual] 状态写盘失败: ${e?.message ?? e}`);
  }
}

function arm(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(onTimer, Math.max(0, ms));
}

function onTimer() {
  timer = null;
  const until = Number(rt.goodnightUntil) || 0;
  if (!until) return;
  if (Date.now() < until) { arm(until - Date.now()); return; }
  // 护栏：到点时她正在说话（回合进行中）→ 等说完再熄灯，不把回复拦腰掐断
  if (ownerKey && activeAiTurns.has(ownerKey)) {
    log('[ritual] 熄灯到点但回合进行中，等这回合说完再熄灯');
    rt.goodnightUntil = Date.now() + RETRY_BUSY_MS;
    persist();
    arm(RETRY_BUSY_MS);
    return;
  }
  rt.goodnightUntil = 0;
  persist();
  pauseNow();
}

async function pauseNow(attempt = 0) {
  try {
    const r = await fetch(`${BRIDGE_BASE}/api/social/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    log('[ritual] 晚安窗口结束 → 已熄灯（paused=true）');
  } catch (e) {
    log(`[ritual] 熄灯请求失败（第 ${attempt + 1} 次）：${e?.message ?? e}，${RETRY_HTTP_MS / 1000}s 后重试`);
    setTimeout(() => pauseNow(attempt + 1), RETRY_HTTP_MS);
  }
}

/** 桥启动时调用：恢复持久化的熄灯时刻 */
export function initRitual(ownerKeyValue) {
  ownerKey = ownerKeyValue;
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    rt.goodnightUntil = Number(obj?.goodnightUntil) || 0;
  } catch { /* 无文件 / 坏文件：从零开始 */ }
  const until = rt.goodnightUntil;
  if (until > Date.now()) {
    arm(until - Date.now());
    log(`[ritual] 重启恢复：晚安熄灯时刻 ${new Date(until).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}，计时器已重新挂上`);
  } else if (until > 0 && Date.now() - until < STALE_GRACE_MS) {
    log('[ritual] 重启恢复：熄灯时刻已过且在宽限期内 → 立即补熄灯');
    rt.goodnightUntil = 0;
    persist();
    pauseNow();
  } else if (until > 0) {
    log('[ritual] 重启恢复：过期熄灯时刻已超过宽限期，仅清理不熄灯');
    rt.goodnightUntil = 0;
    persist();
  }
}

/** 晚安流程启动（由 /api/social/goodnight/start 调用）：注入晚安唤醒 + 挂 10~20min 熄灯计时器 */
export function startGoodnight() {
  const delayMs = (10 + Math.floor(Math.random() * 11)) * 60_000; // 5+x, x∈[5,15]
  rt.goodnightUntil = Date.now() + delayMs;
  persist();
  arm(delayMs);
  log(`[ritual] 晚安流程启动：${Math.round(delayMs / 60000)} 分钟后熄灯`);
  if (ownerKey) {
    sendWakePrompt(ownerKey, 'goodnight').catch((e) => log(`[ritual] 晚安唤醒失败: ${e?.message ?? e}`));
  }
}

/** 清掉晚安流程（早安触发时 / 不需要时）；why 仅用于日志 */
export function clearGoodnight(why = '') {
  if (timer) { clearTimeout(timer); timer = null; }
  if (rt.goodnightUntil) {
    rt.goodnightUntil = 0;
    persist();
    log(`[ritual] 晚安流程已清理${why ? `（${why}）` : ''}`);
  }
}

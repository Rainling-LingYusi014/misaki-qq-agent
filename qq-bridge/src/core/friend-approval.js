// 好友申请拟人化延迟审批（2026-10-07）
// 需求：别人加好友不要秒通过——黑名单秒拒、owner/白名单秒过，其余随机晾一段时间（默认
// 10 分钟 ~ 6 小时）再自动同意；申请信息以伪消息注入 owner 私聊会话（appendSocialNotice），
// 泠娜"知情不决策"。队列持久化到 state/friend-requests.json，桥重启后到点补审。
//
// 为什么不复用 core/scheduler.js：① 它的 fire 动作写死为"发消息到 targetKey"，而这里是
// "set_friend_add_request + 注入伪消息"；② loadScheduledTasks 对已过期一次性任务是**丢弃**
// （对发消息是正确清理），而延迟审批恢复时过期任务恰恰要**立即补审**——语义相反，共用一套
// load 得加类型分支，不如照骨架独立 60 行。
// 注意：改延迟区间（minDelayMs/maxDelayMs）只影响之后的新申请；已挂起任务的 at 不重算。
import path from 'node:path';
import { log } from '../lib/log.js';
import { convKey } from '../lib/keys.js';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { sendToQQ } from './qq-send.js';
import { appendSocialNotice } from './social-flow.js';
import { scheduleWake } from './social-state.js';
import { friendApprovalCfg, pickApprovalDelayMs, isBlacklisted, isWhitelisted, buildFriendNoticeText } from './friend-approval-rules.js';

export const FRIEND_REQUESTS_FILE = path.join(STATE_DIR, 'friend-requests.json');

const pendingRequests = readJsonSafe(FRIEND_REQUESTS_FILE, []); // [{userId, flag, comment, nickname, at, tries, createdAt}]
const timers = new Map(); // userId -> timer（同 user_id 重申时清旧 timer，只保留最新 flag）

let botRef = null;
let cfgRef = null;
export function setFriendApprovalBot(bot) { botRef = bot; }
export function initFriendApprovalCore(cfg) { cfgRef = cfg; }

function saveFriendRequests() {
  atomicWriteJson(FRIEND_REQUESTS_FILE, pendingRequests);
}

function ownerKeyOf() {
  const qq = cfgRef?.ownerQQ != null ? String(cfgRef.ownerQQ) : '';
  return qq ? convKey('private', qq) : '';
}

/** 注入伪消息 + 唤醒 owner（notifyOwner=false 或 ownerQQ 未配时只留日志）。 */
function notice(type, info) {
  const fc = friendApprovalCfg(cfgRef?.social);
  const key = ownerKeyOf();
  const text = buildFriendNoticeText(type, info);
  if (!fc.notifyOwner || !key) { log(`[friend] 通知已跳过（notifyOwner=${fc.notifyOwner}，ownerKey=${key || '未配置'}）: ${text}`); return; }
  try {
    appendSocialNotice(key, text);
    scheduleWake(key, 'friendRequest');
  } catch (error) {
    log(`[friend] 伪消息注入失败（不影响审批本身）: ${error?.message ?? error}`);
  }
}

/** 同 user_id 去重：重复申请保留最新 flag，旧条目与 timer 一并作废。 */
function upsertRequest(entry) {
  const idx = pendingRequests.findIndex((r) => r && r.userId === entry.userId);
  if (idx >= 0) {
    const prev = timers.get(entry.userId);
    if (prev) clearTimeout(prev);
    timers.delete(entry.userId);
    pendingRequests.splice(idx, 1);
  }
  pendingRequests.push(entry);
  saveFriendRequests();
  armTimer(entry);
}

function armTimer(entry) {
  const t = setTimeout(() => {
    timers.delete(entry.userId);
    void approveEntry(entry);
  }, Math.max(0, entry.at - Date.now()));
  t.unref?.();
  timers.set(entry.userId, t);
}

/** 到点审批：成功删条目；失败 60s 重试 3 次（新 at 落盘），耗尽则放弃 + 通知 owner。 */
async function approveEntry(entry) {
  if (!botRef) { log('[friend] bot 未注入，无法审批，60s 后重试'); entry.tries += 1; entry.at = Date.now() + 60000; saveFriendRequests(); armTimer(entry); return; }
  try {
    await botRef.setFriendAddRequest(entry.flag, true);
    const idx = pendingRequests.indexOf(entry);
    if (idx >= 0) pendingRequests.splice(idx, 1);
    saveFriendRequests();
    log(`[friend] 延迟通过好友申请 ${entry.userId}（等待了 ${Math.round((entry.at - entry.createdAt) / 1000)}s）`);
    notice('approved', { uid: entry.userId, nickname: entry.nickname });
  } catch (error) {
    entry.tries = (entry.tries || 0) + 1;
    if (entry.tries <= 3) {
      log(`[friend] 审批失败（第 ${entry.tries}/3 次），60s 后重试 ${entry.userId}: ${error?.message ?? error}`);
      entry.at = Date.now() + 60000;
      saveFriendRequests(); // 新的重试时刻必须落盘：否则重启后恢复看到的还是旧 at
      armTimer(entry);
      return;
    }
    const idx = pendingRequests.indexOf(entry);
    if (idx >= 0) pendingRequests.splice(idx, 1);
    saveFriendRequests();
    log(`[friend] 审批失败已放弃 ${entry.userId}: ${error?.message ?? error}`);
    notice('failed', { uid: entry.userId, nickname: entry.nickname });
    const key = ownerKeyOf();
    if (key) { try { await sendToQQ(key, `好友申请审批失败（flag 可能已过期）：${entry.nickname || entry.userId}，请手动处理。`); } catch {} }
  }
}

/** 昵称 best-effort：get_stranger_info 与 5s 竞速，失败留空（模板里回退"QQ {uid}"）。 */
async function fetchNicknameBestEffort(uid) {
  if (!botRef?.api) return '';
  try {
    const p = botRef.api('get_stranger_info', { user_id: Number(uid) });
    const r = await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('nickname timeout')), 5000).unref?.())
    ]);
    return String(r?.nickname ?? r?.data?.nickname ?? '').trim();
  } catch { return ''; }
}

/** 主入口：bridge.js 的 bot.onRequest('friend') 调用。 */
export async function handleFriendRequest(event) {
  const flag = String(event?.flag ?? '');
  const uid = String(event?.user_id ?? '');
  if (!flag || !uid || !cfgRef) return;
  const fc = friendApprovalCfg(cfgRef.social);
  const comment = String(event.comment ?? '');

  // ① 黑名单：秒拒 + QQ 通知 owner（保留原 bridge.js 行为）+ 伪消息告知
  if (isBlacklisted(cfgRef.deny, uid)) {
    try { await botRef.setFriendAddRequest(flag, false); } catch (error) { log(`[friend] 黑名单拒绝失败 ${uid}: ${error?.message ?? error}`); }
    log(`[friend] 自动拒绝好友请求（黑名单）${uid}`);
    notice('deny', { uid, comment });
    try { const k = ownerKeyOf(); if (k) await sendToQQ(k, `已自动拒绝黑名单用户 ${uid} 的好友请求。`); } catch {}
    return;
  }
  // ② owner / allow 白名单：秒过
  if (isWhitelisted(cfgRef, uid)) {
    try { await botRef.setFriendAddRequest(flag, true); } catch (error) { log(`[friend] 白名单秒过失败 ${uid}: ${error?.message ?? error}`); return; }
    log(`[friend] 白名单秒过好友请求 ${uid}`);
    notice('instant', { uid, comment });
    return;
  }
  // ③ 其余：随机延迟审批
  const delayMs = pickApprovalDelayMs(fc.minDelayMs, fc.maxDelayMs);
  const at = Date.now() + delayMs;
  const nickname = await fetchNicknameBestEffort(uid);
  upsertRequest({ userId: uid, flag, comment, nickname, at, tries: 0, createdAt: Date.now() });
  log(`[friend] 好友申请进入延迟审批 ${uid}（${nickname || '昵称未知'}），${Math.round(delayMs / 1000)}s 后通过`);
  notice('received', { uid, nickname, comment, at });
}

/**
 * 启动恢复：已过期条目不丢弃（与 scheduler 相反——这里过期 = 应立即补审），
 * 加 5~30s 抖动避免重启风暴时瞬通一批。
 */
export function loadFriendRequests() {
  const now = Date.now();
  let repaired = 0;
  for (let i = pendingRequests.length - 1; i >= 0; i -= 1) {
    const r = pendingRequests[i];
    if (!r || !r.flag || r.userId == null) { pendingRequests.splice(i, 1); repaired += 1; continue; }
    if (Number(r.at) <= now) { r.at = now + 5000 + Math.floor(Math.random() * 25000); r.tries = 0; repaired += 1; }
  }
  for (const r of pendingRequests) armTimer(r);
  saveFriendRequests();
  log(`[friend] 已恢复待审批好友申请 ${pendingRequests.length} 个${repaired ? `（补审/清理 ${repaired} 个）` : ''}`);
}

/* ── 2026-10-26（仪表盘好友卡）：管理端手动审批 ──
 * 必须走本模块而不是控制台直调 OneBot：内存 pendingRequests + timers 与盘上文件是两份状态，
 * 绕过这里会造成"手动已批/拒、定时器到点再批一次 + save 把条目写回去"的双头状态。 */
export function listPendingFriendRequests() {
  return pendingRequests.map((r) => ({
    userId: String(r.userId ?? ''),
    nickname: String(r.nickname ?? ''),
    comment: String(r.comment ?? ''),
    at: Number(r.at ?? 0),
    createdAt: Number(r.createdAt ?? 0)
  }));
}

export async function decideFriendRequest(userId, approve) {
  const idx = pendingRequests.findIndex((r) => String(r.userId) === String(userId));
  if (idx < 0) return { ok: false, error: '该申请不在待审批队列中（可能已被自动处理或已过期）' };
  const entry = pendingRequests[idx];
  if (!botRef) return { ok: false, error: 'bot 未注入（NapCat 未就绪），稍后再试' };
  const t = timers.get(entry.userId);
  if (t) { clearTimeout(t); timers.delete(entry.userId); }
  try {
    await botRef.setFriendAddRequest(entry.flag, !!approve);
    const at = pendingRequests.indexOf(entry);
    if (at >= 0) pendingRequests.splice(at, 1);
    saveFriendRequests();
    log(`[friend] 管理端手动${approve ? '通过' : '拒绝'}好友申请 ${entry.userId}（${entry.nickname || '昵称未知'}）`);
    return { ok: true, userId: String(entry.userId), nickname: String(entry.nickname ?? '') };
  } catch (error) {
    return { ok: false, error: `OneBot 审批调用失败：${error?.message ?? error}` };
  }
}

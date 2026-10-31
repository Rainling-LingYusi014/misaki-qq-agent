/* 一次性验收：好友申请拟人化延迟审批（2026-10-07，见 core/friend-approval.js）
 * 覆盖三块：
 *   1) 纯规则单测（friend-approval-rules.js，无副作用）；
 *   2) config.js 深合并归一（真实 config.json 缺 friendApproval 段时的回填路径）；
 *   3) mock bot 端到端：黑名单秒拒 / owner 秒过 / 延迟审批 / 同 user 重申去重。
 * 端到端强制 notifyOwner=false：notice 只落日志，不写 social-state.json、不唤醒 owner；
 * 用过的待审批队列收尾必须归零（finally 里兜底恢复），不污染真实 state。
 * 跑法：qq-bridge 目录下 node tests/friend-approval-check.mjs
 */
import fs from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import {
  FRIEND_APPROVAL_DEFAULTS, friendApprovalCfg, pickApprovalDelayMs,
  isBlacklisted, isWhitelisted, buildFriendNoticeText,
} from '../src/core/friend-approval-rules.js';
import {
  FRIEND_REQUESTS_FILE, setFriendApprovalBot, initFriendApprovalCore, handleFriendRequest, loadFriendRequests,
} from '../src/core/friend-approval.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 1) 规则单测 ──────────────────────────────────────────────── */

// 默认值
const d = friendApprovalCfg(undefined);
ok(d.enabled === true && d.notifyOwner === true, 'friendApprovalCfg: 无配置回填默认全开');
ok(d.minDelayMs === FRIEND_APPROVAL_DEFAULTS.minDelayMs && d.maxDelayMs === FRIEND_APPROVAL_DEFAULTS.maxDelayMs, 'friendApprovalCfg: 默认延迟区间 10min~6h');

// min>max 对调
const swapped = friendApprovalCfg({ friendApproval: { minDelayMs: 5000, maxDelayMs: 1000 } });
ok(swapped.minDelayMs === 1000 && swapped.maxDelayMs === 5000, 'friendApprovalCfg: min>max 自动对调');

// 非法值兜底 + 钳制
const clamped = friendApprovalCfg({ friendApproval: { minDelayMs: 'abc', maxDelayMs: 999999999 } });
ok(clamped.minDelayMs === FRIEND_APPROVAL_DEFAULTS.minDelayMs, 'friendApprovalCfg: 非数字 min 回退默认');
ok(clamped.maxDelayMs === 86400000, 'friendApprovalCfg: max 超上限钳到 24h');
ok(friendApprovalCfg({ friendApproval: { enabled: false } }).enabled === false, 'friendApprovalCfg: enabled=false 可关');
ok(friendApprovalCfg({ friendApproval: { enabled: 'yes' } }).enabled === true, 'friendApprovalCfg: enabled 非 false 一律 true（宽松）');

// 随机延迟边界
let inRange = true;
for (let i = 0; i < 300; i += 1) {
  const v = pickApprovalDelayMs(100, 200);
  if (v < 100 || v >= 200 || !Number.isInteger(v)) { inRange = false; break; }
}
ok(inRange, 'pickApprovalDelayMs: 300 次采样全部落在 [min, max) 且为整数');
ok(pickApprovalDelayMs(150, 150) === 150, 'pickApprovalDelayMs: min==max 恒等');
ok(pickApprovalDelayMs(300, 100) >= 300, 'pickApprovalDelayMs: min>max 时按 min 兜底（hi=max(lo)）');

// 黑名单（新/旧键名）
ok(isBlacklisted({ private: ['111', 222] }, '111') && isBlacklisted({ private: [222] }, 222), 'isBlacklisted: deny.private 命中（含数字 id）');
ok(isBlacklisted({ privates: ['333'] }, '333'), 'isBlacklisted: 旧键名 deny.privates 兼容');
ok(!isBlacklisted({ private: ['111'] }, '999') && !isBlacklisted({}, '') && !isBlacklisted(null, '1'), 'isBlacklisted: 不中/空 uid/无 deny → false');

// 白名单（owner + allow）
ok(isWhitelisted({ ownerQQ: 1736784911 }, '1736784911'), 'isWhitelisted: ownerQQ 命中（数字配置 vs 字符串 uid）');
ok(isWhitelisted({ allow: { private: ['123'] } }, '123') && isWhitelisted({ allow: { privates: ['456'] } }, '456'), 'isWhitelisted: allow.private / privates 兼容');
ok(!isWhitelisted({ ownerQQ: 1 }, '') && !isWhitelisted({}, '1'), 'isWhitelisted: 空 uid / 无配置 → false');

// 伪消息文本
const t1 = buildFriendNoticeText('received', { uid: '888', nickname: '小测', comment: '你好', at: Date.now() });
ok(t1.startsWith('[好友申请]') && t1.includes('小测（QQ 888）') && t1.includes('“你好”') && t1.includes('预计'), 'buildFriendNoticeText: received 含昵称/附言/预计时间');
ok(buildFriendNoticeText('received', { uid: '888' }).includes('（没有附言）') && buildFriendNoticeText('received', { uid: '888' }).includes('QQ 888'), 'buildFriendNoticeText: 无昵称无附言回退');
ok(['instant', 'deny', 'approved', 'failed'].every((k) => buildFriendNoticeText(k, { uid: '1' }).startsWith('[好友申请]')), 'buildFriendNoticeText: 其余四类文本格式统一');
ok(buildFriendNoticeText('received', { uid: '9'.repeat(300) }).length === 200, 'buildFriendNoticeText: 截 200 字');

/* ── 2) config.js 深合并归一 ──────────────────────────────────── */
// 当前真实 config.json 没有 friendApproval 段 → loadConfig 后必须回填出完整默认形状
const cfgNow = loadConfig();
const fa = cfgNow.social?.friendApproval;
ok(fa && typeof fa === 'object', 'config.js: 旧 config.json 缺段时回填 social.friendApproval');
ok(fa && Number.isInteger(fa.minDelayMs) && Number.isInteger(fa.maxDelayMs) && fa.minDelayMs <= fa.maxDelayMs && typeof fa.enabled === 'boolean' && typeof fa.notifyOwner === 'boolean', 'config.js: 回填段形状完整（min<=max、布尔为真布尔）');

/* ── 3) mock bot 端到端（notifyOwner=false，不碰真实 QQ / social state） ── */
const calls = []; // {flag, approve}
const mockBot = {
  setFriendAddRequest: async (flag, approve) => { calls.push({ flag, approve }); },
  api: async () => ({ nickname: '测试昵称' }),
};
setFriendApprovalBot(mockBot);
initFriendApprovalCore({
  ownerQQ: 1736784911,
  social: { friendApproval: { enabled: true, minDelayMs: 200, maxDelayMs: 400, notifyOwner: false } },
  deny: { private: ['111111111'] },
  allow: { private: ['222222222'] },
});

const readPending = () => JSON.parse(fs.readFileSync(FRIEND_REQUESTS_FILE, 'utf8'));
const waitCalls = async (n, ms = 3000) => {
  const dl = Date.now() + ms;
  while (calls.length < n && Date.now() < dl) await sleep(50);
  return calls.length >= n;
};

try {
  // ① 黑名单秒拒
  await handleFriendRequest({ flag: 'F-black', user_id: '111111111', comment: '打扰了' });
  await waitCalls(1);
  ok(calls[0]?.flag === 'F-black' && calls[0]?.approve === false, '端到端①: 黑名单秒拒（approve=false）', JSON.stringify(calls[0]));
  ok(readPending().length === 0, '端到端①: 黑名单不进待审批队列');

  // ② owner 秒过
  await handleFriendRequest({ flag: 'F-owner', user_id: '1736784911', comment: '' });
  await waitCalls(2);
  ok(calls[1]?.flag === 'F-owner' && calls[1]?.approve === true, '端到端②: owner 秒过（approve=true）', JSON.stringify(calls[1]));

  // ③ 白名单秒过
  await handleFriendRequest({ flag: 'F-allow', user_id: '222222222', comment: '' });
  await waitCalls(3);
  ok(calls[2]?.flag === 'F-allow' && calls[2]?.approve === true, '端到端③: allow 白名单秒过', JSON.stringify(calls[2]));

  // ④ 延迟审批：入队 → 落盘 → 到点自动通过
  await handleFriendRequest({ flag: 'F-delay', user_id: '333333333', comment: '交个朋友', nickname: '' });
  let pending = readPending();
  ok(pending.length === 1 && pending[0].flag === 'F-delay' && pending[0].nickname === '测试昵称', '端到端④: 申请入队落盘且昵称已取', JSON.stringify(pending[0]));
  ok(pending[0].at >= pending[0].createdAt + 200 && pending[0].at <= pending[0].createdAt + 400, '端到端④: at 落在 [min+createdAt, max+createdAt]');
  ok(await waitCalls(4), '端到端④: 到点后自动通过');
  ok(calls[3]?.flag === 'F-delay' && calls[3]?.approve === true, '端到端④: 通过动作 approve=true', JSON.stringify(calls[3]));
  ok(readPending().length === 0, '端到端④: 通过后队列清空');

  // ⑤ 同 user 重申去重：只认最新 flag
  await handleFriendRequest({ flag: 'F-444-old', user_id: '444444444', comment: '' });
  await handleFriendRequest({ flag: 'F-444-new', user_id: '444444444', comment: '' });
  await waitCalls(6);
  const last444 = calls.filter((c) => String(c.flag).startsWith('F-444'));
  ok(last444.length === 1 && last444[0].flag === 'F-444-new' && last444[0].approve === true, '端到端⑤: 重申只保留最新 flag（旧申请作废不审批）', JSON.stringify(last444));
  ok(readPending().length === 0, '端到端⑤: 结束后队列归零');
} finally {
  // 兜底：无论成败，恢复真实 state 文件为空队列（测试只写入过短延迟假条目）
  fs.writeFileSync(FRIEND_REQUESTS_FILE, '[]\n', 'utf8');
}

/* ── 4) 启动恢复语义（loadFriendRequests 的过期补审路径） ── */
// 注意：pendingRequests 是模块 import 时刻载入内存的快照，事后写文件再调同一实例看不到 ——
// 所以先用 query 打散缓存拿一个全新实例（import 前把过期条目写进文件）。
const testCfg = {
  ownerQQ: 1736784911,
  social: { friendApproval: { enabled: true, minDelayMs: 200, maxDelayMs: 400, notifyOwner: false } },
  deny: { private: ['111111111'] },
  allow: { private: ['222222222'] },
};
fs.writeFileSync(FRIEND_REQUESTS_FILE, JSON.stringify([{ userId: '555555555', flag: 'F-expired', comment: '', nickname: '', at: Date.now() - 60000, tries: 0, createdAt: Date.now() - 120000 }]), 'utf8');
const fresh = await import(`../src/core/friend-approval.js?fresh=${Date.now()}`);
fresh.setFriendApprovalBot(mockBot);
fresh.initFriendApprovalCore(testCfg);
fresh.loadFriendRequests(); // 语义：过期条目必须立即补审（不像 scheduler 那样丢弃过期任务）
ok(await waitCalls(calls.length + 1, 35000), '恢复语义: 过期条目重启后抖动 5~30s 内补审（不丢弃）');
ok(calls[calls.length - 1]?.flag === 'F-expired' && calls[calls.length - 1]?.approve === true, '恢复语义: 补审动作 approve=true', JSON.stringify(calls[calls.length - 1]));
fs.writeFileSync(FRIEND_REQUESTS_FILE, '[]\n', 'utf8');

console.log(`\n${failed === 0 ? '🎉 全部通过' : `⚠️ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
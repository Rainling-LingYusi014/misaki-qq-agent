// 好友申请拟人化审批 · 纯函数层（无任何副作用依赖，供 friend-approval.js 与单测复用）
// 为什么单独拆一个文件：主模块 import 了 qq-send/social-flow/social-state 这条重依赖链，
// 单测不想拉起半个桥 —— 规则（默认值/钳制/黑名单判定/延迟抽取/伪消息文本）全部放这里，
// 保持可独立 import。

export const FRIEND_APPROVAL_DEFAULTS = Object.freeze({
  enabled: true,       // false = 回退旧的"秒过"逻辑（bridge.js legacyAutoApprove）
  minDelayMs: 600000,  // 10 分钟：最短晾多久
  maxDelayMs: 21600000, // 6 小时：最长晾多久（QQ 好友申请 flag 平台侧有效期以天计，6h 安全）
  notifyOwner: true,   // false = 只写日志，不注入伪消息、不唤醒 owner 会话
  // 2026-10-28 开放好友（主人定规"审批由我亲自来搞"）：false = 手动模式——非黑/白名单的申请
  // 不再定时自动通过，只通报 owner 等她在 QQ 里亲自批。黑名单秒拒、白名单秒过不受影响。
  autoApprove: true
});

const clampInt = (v, lo, hi) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * 归一化 social.friendApproval 配置：缺键回填默认、min>max 对调。
 * 深合并语义与 config.js 对 sticker 段的处理一致（外层是浅合并，这里必须自己补全默认键）。
 */
export function friendApprovalCfg(rawSocial) {
  const raw = (rawSocial && typeof rawSocial === 'object' && rawSocial.friendApproval && typeof rawSocial.friendApproval === 'object')
    ? rawSocial.friendApproval
    : {};
  const out = {
    enabled: raw.enabled === false ? false : FRIEND_APPROVAL_DEFAULTS.enabled,
    notifyOwner: raw.notifyOwner === false ? false : FRIEND_APPROVAL_DEFAULTS.notifyOwner,
    autoApprove: raw.autoApprove === false ? false : FRIEND_APPROVAL_DEFAULTS.autoApprove,
    minDelayMs: FRIEND_APPROVAL_DEFAULTS.minDelayMs,
    maxDelayMs: FRIEND_APPROVAL_DEFAULTS.maxDelayMs
  };
  const lo = clampInt(raw.minDelayMs ?? out.minDelayMs, 0, 86400000);
  if (lo != null) out.minDelayMs = lo;
  const hi = clampInt(raw.maxDelayMs ?? out.maxDelayMs, 0, 86400000);
  if (hi != null) out.maxDelayMs = hi;
  // 下限高过上限 = 写反了：对调（否则按"等最久"理解就永远顶在上限）
  if (out.minDelayMs > out.maxDelayMs) {
    const t = out.minDelayMs; out.minDelayMs = out.maxDelayMs; out.maxDelayMs = t;
  }
  return out;
}

/** 随机延迟：[min, max) 均匀取整。min==max 时恒等。 */
export function pickApprovalDelayMs(minMs, maxMs) {
  const lo = Math.max(0, Math.round(Number(minMs) || 0));
  const hi = Math.max(lo, Math.round(Number(maxMs) || 0));
  return Math.round(lo + Math.random() * (hi - lo));
}

/**
 * 黑名单判定。兼容 deny.private（新）与 deny.privates（旧复数形式）两种键名，
 * 与 bridge.js 原 :636 的读取顺序一致。
 */
export function isBlacklisted(deny, uid) {
  const id = String(uid ?? '');
  if (!id) return false;
  const list = Array.isArray(deny?.private) ? deny.private : Array.isArray(deny?.privates) ? deny.privates : [];
  return list.map(String).includes(id);
}

/** owner / allow 白名单（allow.private / allow.privates，镜像 deny 的两种键名）。 */
export function isWhitelisted(cfg, uid) {
  const id = String(uid ?? '');
  if (!id) return false;
  if (cfg?.ownerQQ != null && id === String(cfg.ownerQQ)) return true;
  const allow = cfg?.allow;
  const list = Array.isArray(allow?.private) ? allow.private : Array.isArray(allow?.privates) ? allow.privates : [];
  return list.map(String).includes(id);
}

// ── 伪消息文本模板（泠娜第一人称知情口吻；桥替她说，她不决策） ────────────────

function nameOf(nickname, uid) {
  const n = String(nickname ?? '').trim();
  return n ? `${n}（QQ ${uid}）` : `QQ ${uid}`;
}
function commentOf(comment) {
  const c = String(comment ?? '').trim();
  return c ? `“${c}”` : '（没有附言）';
}
const fmtHHmm = (at) => {
  const d = new Date(Number(at));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 各场景的 [好友申请] 伪消息文本。type:
 *  - 'received'   延迟路径到达（extra.at = 预计处理时刻）
 *  - 'instant'    owner/白名单秒过
 *  - 'deny'       黑名单秒拒
 *  - 'approved'   延迟审批完成
 *  - 'failed'     重试耗尽放弃
 * 统一截 200 字，与 appendSocialPoke 的切片口径一致。
 */
export function buildFriendNoticeText(type, { uid = '', nickname = '', comment = '', at = 0 } = {}) {
  let text;
  switch (type) {
    case 'received':
      text = `[好友申请] 有人加你好友：${nameOf(nickname, uid)}。${commentOf(comment)}我打算过一会儿再处理，先看看情况（预计 ${fmtHHmm(at)} 前后处理）`;
      break;
    case 'manual':
      text = `[好友申请] 有人加你好友：${nameOf(nickname, uid)}。${commentOf(comment)}这条交给你亲自处理——你在 QQ 里通过后，记得把 ta 的 QQ 号加进私聊白名单，不然 ta 的消息进不来。`;
      break;
    case 'instant':
      text = `[好友申请] ${nameOf(nickname, uid)} 加你好友，是我认识的人，直接通过了。${commentOf(comment)}`;
      break;
    case 'deny':
      text = `[好友申请] 拒绝了 ${nameOf(nickname, uid)} 的好友申请（在黑名单里）。${commentOf(comment)}`;
      break;
    case 'approved':
      text = `[好友申请] 刚才 ${nameOf(nickname, uid)} 的申请已经通过了，之后 ta 就能给你发消息啦。`;
      break;
    case 'failed':
      text = `[好友申请] 那个好友申请（${nameOf(nickname, uid)}）拖太久处理失败，可能过期了，麻烦你自己看看 QQ 的通知。`;
      break;
    default:
      text = `[好友申请] 处理了一条好友申请（${nameOf(nickname, uid)}）。`;
  }
  return text.slice(0, 200);
}

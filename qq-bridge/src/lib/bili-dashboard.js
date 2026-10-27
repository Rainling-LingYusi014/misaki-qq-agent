/* ══════════════════════════════════════════════════════════════════════════
 * B 站创作中心只读数据（2026-10-28，主人拍板的「数据面板」）
 *
 * 此前桥只有公开侧（view/search）+ 动作侧（coin/follow/upload/dynamic），
 * 创作中心（member.bilibili.com）后台接口从未实现——所以美咲答"看不到自己稿件
 * 的运营数据"是诚实的。本模块补上只读的自己人数据：
 *   · 稿件列表+统计：member.bilibili.com/x/web/archives（播放/点赞/投币/收藏/分享/评论/弹幕 + 审核状态）
 *   · 粉丝数：api.bilibili.com/x/relation/stat?vmid=<自己 mid>（公开接口）
 * 自己 mid 从登录 cookie 的 DedeUserID 读（无则跳过粉丝数，不阻塞稿件数据）。
 * 协议单源走 lib/bili-api.js（UA/风控码/HTTP412 归一/共享熔断一致）。
 * 全部只读 GET、不花钱——按 2026-10-28 额度定稿不限次数（频控只防刷）。
 * ══════════════════════════════════════════════════════════════════════════ */
import { readJsonSafe } from './json-fs.js';
import { biliJson, BILI_AUTH_FILE, BILI_CIRCUIT_FILE } from './bili-api.js';

const MEMBER = 'https://member.bilibili.com';
const REFERER = 'https://member.bilibili.com/platform/upload/video/frame';

/** 稿件状态码 → 人话（未收录的如实报 state=原始码，不编） */
export const STATE_LABELS = {
  0: '已公开',
  '-30': '审核中',
  '-40': '被打回（待修改）',
  '-9': '转码中',
};
export const stateLabel = (code) => STATE_LABELS[String(Number(code) || 0)] ?? `state=${code}`;

const STAT_KEYS = ['view', 'like', 'coin', 'favorite', 'share', 'reply', 'danmaku'];

/** 把 arcDatas 的 stat 归一成七个指标（缺字段记 0）。 */
export const normStat = (s) => {
  const src = (s && typeof s === 'object') ? s : {};
  const out = {};
  for (const k of STAT_KEYS) out[k] = Math.max(0, Number(src[k]) || 0);
  return out;
};

/** 一组稿件指标求和（纯函数：面板顶部那行"合计"） */
export function sumStats(items) {
  const total = {};
  for (const k of STAT_KEYS) total[k] = 0;
  for (const it of items ?? []) {
    const s = normStat(it?.stat);
    for (const k of STAT_KEYS) total[k] += s[k];
  }
  return total;
}

/** 自己的 mid：登录 cookie 里的 DedeUserID（值可能是字符串或 {value} 形态，同 bili-social 的容错）。 */
export function readSelfMid(authFile = BILI_AUTH_FILE) {
  const d = readJsonSafe(authFile, {});
  const raw = d.DedeUserID ?? d.dedeuserid;
  const v = raw && typeof raw === 'object' ? raw.value : raw;
  const s = String(v ?? '').trim();
  return /^\d{1,16}$/.test(s) ? s : '';
}

/** 创作中心稿件列表（一页）。返回 { ok, total, auditClass, items:[{bvid,aid,title,tname,ptime,state,label,stat}] }。
 *  2026-10-28 服务器实测：新投稿（即使已过审）先出现在 data.arc_audits（x.Archive），
 *  有播放数据后才挪进 data.archives —— 两表合并、按 bvid 去重；总数看 data.page.count，
 *  审核分账看 data.class = {pubed, is_pubing, not_pubed}。 */
export async function listMyArchives({ pn = 1, ps = 20, status = 'all', authFile = BILI_AUTH_FILE, circuitFile = BILI_CIRCUIT_FILE } = {}) {
  const qs = `status=${encodeURIComponent(status)}&pn=${Math.max(1, Number(pn) || 1)}&ps=${Math.max(1, Math.min(50, Number(ps) || 20))}`;
  const j = await biliJson(`${MEMBER}/x/web/archives?${qs}`, {
    referer: REFERER, scope: 'dashboard', authFile, circuitFile,
  });
  if (j.code !== 0) return { ok: false, why: `archives code=${j.code} ${j.message ?? ''}` };
  const d = j.data ?? {};
  /* 2026-10-28 审查 P2-3 修正：archives 放前——迁移期同一 bvid 两表并存时，
   * archives 侧才是带播放统计的那份（arc_audits 的 stat 常为空），去重必须保它。 */
  const merged = [
    ...(Array.isArray(d.archives) ? d.archives : []),
    ...(Array.isArray(d.arc_audits) ? d.arc_audits : []).map((x) => x?.Archive).filter(Boolean),
  ];
  const seen = new Set();
  const rows = merged.filter((r) => {
    const k = String(r.bvid ?? '');
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const cls = (d.class && typeof d.class === 'object') ? d.class : {};
  return {
    ok: true,
    total: Number(d.page?.count ?? rows.length) || rows.length,
    auditClass: {
      pubed: Number(cls.pubed) || 0,
      auditing: Number(cls.is_pubing) || 0,
      rejected: Number(cls.not_pubed) || 0,
    },
    items: rows.map((r) => ({
      bvid: String(r.bvid ?? ''),
      aid: Number(r.aid) || 0,
      title: String(r.title ?? ''),
      tname: String(r.tname ?? ''),
      ptime: Number(r.ptime) || 0,
      state: Number(r.state) || 0,
      label: stateLabel(r.state),
      stat: normStat(r.stat),
    })),
  };
}

/** 粉丝数（relation/stat 公开接口）。失败返回 null——粉丝数拿不到不该连累稿件数据。 */
export async function fanCount({ mid, authFile = BILI_AUTH_FILE, circuitFile = BILI_CIRCUIT_FILE } = {}) {
  const m = String(mid ?? '').trim();
  if (!/^\d{1,16}$/.test(m)) return null;
  try {
    const j = await biliJson(`https://api.bilibili.com/x/relation/stat?vmid=${m}`, {
      scope: 'dashboard', authFile, circuitFile, tripOnRisk: false,
    });
    const n = Number(j?.data?.follower);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 面板汇总：稿件统计 + 审核分账/待处理清单 + 粉丝数。
 *  合计只覆盖拉到的这一页（ps 默认 20）——返回里带 sumScope 说明，调用方照实说，不冒充全站总数。 */
export async function dashboardSummary({ pageSize = 20, authFile = BILI_AUTH_FILE, circuitFile = BILI_CIRCUIT_FILE } = {}) {
  const arcs = await listMyArchives({ ps: pageSize, authFile, circuitFile });
  if (!arcs.ok) return arcs;
  const pending = arcs.items.filter((v) => v.state !== 0).map(({ bvid, title, state, label }) => ({ bvid, title, state, label }));
  const fans = await fanCount({ mid: readSelfMid(authFile), authFile, circuitFile });
  return {
    ok: true,
    total: arcs.total,
    auditClass: arcs.auditClass,
    fetched: arcs.items.length,
    sumScope: `最近 ${arcs.items.length} 条（共 ${arcs.total} 条）`,
    sum: sumStats(arcs.items),
    fans,
    pending,
    videos: arcs.items.map(({ bvid, title, ptime, state, label, stat }) => ({
      bvid, title, ptime, state, label, stat,
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
    })),
  };
}

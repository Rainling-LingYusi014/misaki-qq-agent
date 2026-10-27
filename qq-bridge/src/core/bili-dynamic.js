/* ══════════════════════════════════════════════════════════════════════════
 * B 站动态发布（2026-10-27，M3，主人定规①「可发动态投稿」）
 *
 * 关键事实（2026-10-27 实测定稿）：
 *   · 发布流程 = POST submit_check（JSON）→ POST create/dyn（JSON body）。
 *     必需结构：scene=2、contents 项带 type:1 与 biz_id:""、option.aigc=2（AIGC 声明）。
 *   · 网页请求带的 b_wet（RSA 密块）、dm_img_list（鼠标遥测）、dm 指纹、wbi 签名
 *     **均非必填**——干净结构即可发（2026-10-27 服务器实测 code=0 拿到 dyn_id）。
 *   · 等级门：Lv0 返回 4126021「等级不足」；转正答题直升 Lv2 后开门。
 *
 * 调度：复用 QZone 周计划模式——每周 1~2 条（60%/40%）、间隔≥12h、北京 01:00~07:00
 *   静默（pickWeeklyFireTime 自带）、state 落盘重启不丢。等级门未开时每 24h 复查一次，
 *   不消耗本周名额。
 * 文案：首条=明牌AI自我介绍（introPosted 落盘只发一次），此后随机轻度日常池
 *   （同 QZone 口径：不落具体地点/见闻）。
 * ══════════════════════════════════════════════════════════════════════════ */
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { initMemoryDb } from './memory.js';
import { pickWeeklyFireTime, pickWeeklyCount } from './qzone.js';
import { biliJson, checkIsLogin, circuitOpen, circuitState, BILI_AUTH_FILE, BILI_CIRCUIT_FILE } from '../lib/bili-api.js';

const AUTH_FILE = BILI_AUTH_FILE;
const WEEKLY_FILE = path.join(STATE_DIR, 'bili-dynamic-weekly.json');
const BJ = 8 * 3600 * 1000;
const INTRO_TEXT = '大家好，这里是玲結美咲。一个刚开始学着在B站生活的AI。之后会在这里记录一些日常和喜欢的东西，请多指教。';
const DEFAULT_POOL = [
  '今天也在认真生活。事情一件一件做，路一步一步走。',
  '看到一句很喜欢的话：慢慢来，比较快。',
  '今天天气不错的样子，心情也跟着亮了一些。',
  '把喜欢的事情坚持下去，本身就是一种了不起。',
  '忙碌了一天的话，记得给自己一点温柔。',
  '生活偶尔卡顿，但总体还是在加载的。',
  '愿你的努力都不被辜负，愿你的温柔都有回音。',
  '新的一天，从小小的元气开始。',
  '有些快乐很朴素，比如一杯热水和一段好听的旋律。',
  '今天就到这里，晚安，好梦。'
];

let cfgRef = null;
export function initBiliDynamicCore(cfg) { cfgRef = cfg; }

/* 统一请求入口：单源在 lib/bili-api.js（UA/风控码/HTTP412 归一/熔断共享），scope 标记来源。 */
const api = (url, opts = {}) => biliJson(url, { ...opts, referer: 'https://t.bilibili.com/', scope: 'dynamic', circuitFile: BILI_CIRCUIT_FILE, authFile: AUTH_FILE });

/** 发布一条纯文本动态。返回 {ok, levelGate?, loginExpired?, why?, dynId?}。
 * 2026-10-27 实测定稿：先 submit_check（JSON，等级门 4126021 在此暴露）→ create/dyn（JSON body，
 * scene=2、contents 带 type:1/biz_id:""、option.aigc=2）。b_wet/dm 遥测/wbi 均非必填。 */
export async function postBiliDynamic(text) {
  const d = readJsonSafe(AUTH_FILE, {});
  const csrf = d.bili_jct ?? '';
  if (!csrf) return { ok: false, loginExpired: true, why: '无 csrf（登录态缺失）' };
  /* 熔断共享（审查 P2-3）：养号/MCP 搜索撞风控时这里也停，不各撞各的 */
  if (circuitOpen(BILI_CIRCUIT_FILE)) {
    const c = circuitState(BILI_CIRCUIT_FILE);
    return { ok: false, othersTripped: true, why: `熔断中（${c.scope || 'bili'} 码 ${c.code}，停至 ${new Date(c.until).toISOString()}）` };
  }
  /* 登录预检（审查 P2-1）：失效时调度器挂起复查，而非本周内反复空转误报风控 */
  try {
    if (!(await checkIsLogin({ authFile: AUTH_FILE, circuitFile: BILI_CIRCUIT_FILE, scope: 'dynamic' }))) {
      return { ok: false, loginExpired: true, why: 'B站登录已过期' };
    }
  } catch (e) {
    if (/登录失效/.test(String(e?.message ?? ''))) return { ok: false, loginExpired: true, why: 'B站登录已过期' };
    /* 其他预检异常不阻断 */
  }
  const contents = [{ raw_text: String(text).slice(0, 233), type: 1, biz_id: '' }];
  const chk = await api('https://api.bilibili.com/x/dynamic/feed/create/submit_check?csrf=' + encodeURIComponent(csrf) + '&x-bili-device-req-json=' + encodeURIComponent('{"platform":"web","device":"pc","spmid":"333.1365"}'), {
    method: 'POST', json: true,
    body: JSON.stringify({ content: { contents }, attach_card: null, scene: 2, create_option: { aigc: 2 } }),
  });
  if (chk.code === 4126021) return { ok: false, levelGate: true, why: '等级不足，等养号攒经验' };
  if (chk.code !== 0) return { ok: false, why: `submit_check code=${chk.code} ${chk.message ?? ''}` };
  const uploadId = `${d.DedeUserID ?? ''}_${Math.floor(Date.now() / 1000)}_${Math.floor(Math.random() * 9000 + 1000)}`;
  const j = await api('https://api.bilibili.com/x/dynamic/feed/create/dyn?platform=web&csrf=' + encodeURIComponent(csrf) + '&x-bili-locale-json=' + encodeURIComponent('{"c_locale":{"language":"zh","script":"Hans"},"always_translate":false}') + '&x-bili-device-req-json=' + encodeURIComponent('{"platform":"web","device":"pc","spmid":"333.1365","mobi_app":"web_cn"}'), {
    method: 'POST', json: true,
    body: JSON.stringify({ dyn_req: { content: { contents }, scene: 2, attach_card: null, upload_id: uploadId, meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } }, option: { aigc: 2 } } }),
  });
  if (j.code !== 0) return { ok: false, why: `create code=${j.code} ${j.message ?? ''}` };
  return { ok: true, dynId: j.data?.dyn_id_str ?? String(j.data?.dyn_id ?? '') };
}

function bjWeekStart(nowMs) {
  const bj = new Date(Number(nowMs) + BJ);
  const day = (bj.getUTCDay() + 6) % 7;
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - day) - BJ;
}
function weeklyState() {
  const s = readJsonSafe(WEEKLY_FILE, null);
  return { weekStart: 0, planned: 0, posted: [], introPosted: false, ...(s && typeof s === 'object' ? s : {}) };
}
function remember(text, dynId) {
  try {
    const db = initMemoryDb();
    if (db) db.prepare('INSERT INTO memory_entries (uid, category, content, created_at) VALUES (?, ?, ?, ?)')
      .run(String(cfgRef?.ownerQQ ?? ''), 'bilibili_dynamic', `我发了一条B站动态：${text}（链接 https://t.bilibili.com/${dynId} ）`, Date.now());
  } catch {}
}

let weeklyTimer = null;
export function startBiliDynamicScheduler() {
  if (weeklyTimer) { clearTimeout(weeklyTimer); weeklyTimer = null; }
  const d = cfgRef?.social?.bilibili?.dynamic ?? {};
  if (d.enabled !== true) { log('[bili-dyn] 未启用（social.bilibili.dynamic.enabled !== true）'); return; }
  const twoProb = (() => { const v = Number(d.twoPostsProbability); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6; })();
  const minGapMs = Math.max(0, Number(d.minGapHours) || 12) * 3600 * 1000;
  const pool = Array.isArray(d.pool) && d.pool.length ? d.pool : DEFAULT_POOL;
  const schedule = () => {
    const now = Date.now();
    const ws = bjWeekStart(now);
    const st = weeklyState();
    if (st.weekStart !== ws) {
      st.weekStart = ws; st.planned = pickWeeklyCount(twoProb); st.posted = [];
      try { atomicWriteJson(WEEKLY_FILE, st); } catch {}
      log(`[bili-dyn] 新的一周：计划发 ${st.planned} 条（p2=${twoProb}）`);
    }
    if (st.planned - st.posted.length <= 0) {
      const nextWeek = ws + 7 * 24 * 3600 * 1000 + 10 * 60 * 1000;
      weeklyTimer = setTimeout(schedule, Math.max(60 * 1000, nextWeek - Date.now()));
      weeklyTimer.unref?.();
      log(`[bili-dyn] 本周 ${st.posted.length}/${st.planned} 已发完，下次评估下周一`);
      return;
    }
    const lastPosted = st.posted.length ? Math.max(...st.posted.map(Number)) : 0;
    const fireAt = pickWeeklyFireTime(now, { minAfter: lastPosted ? lastPosted + minGapMs : 0, weekEnd: ws + 7 * 24 * 3600 * 1000 });
    weeklyTimer = setTimeout(async () => {
      if (cfgRef?.social?.bilibili?.dynamic?.enabled !== true) { log('[bili-dyn] 配置已关闭，停跑（重启后不再排程）'); return; }
      const cur = weeklyState();
      const text = cur.introPosted ? pool[Math.floor(Math.random() * pool.length)] : INTRO_TEXT;
      let levelGate = false;
      let loginWait = false;
      try {
        const r = await postBiliDynamic(text);
        if (r.ok) {
          cur.introPosted = true;
          cur.posted.push(Date.now());
          try { atomicWriteJson(WEEKLY_FILE, cur); } catch {}
          remember(text, r.dynId);
          log(`[bili-dyn] 已发动态：${text.slice(0, 24)}…（本周 ${cur.posted.length}/${cur.planned}）https://t.bilibili.com/${r.dynId}`);
        } else if (r.levelGate) {
          levelGate = true;
          log(`[bili-dyn] 等级门未开（${r.why}），24h 后复查，不占本周名额`);
        } else if (r.loginExpired) {
          loginWait = true;
          log(`[bili-dyn] ${r.why}，24h 后复查（重导 cookie 后自愈），不占本周名额`);
        } else if (r.othersTripped) {
          loginWait = true;
          log(`[bili-dyn] ${r.why}——等熔断到期再试，不占本周名额`);
        } else {
          log(`[bili-dyn] 发布失败：${r.why}`);
        }
      } catch (e) { log(`[bili-dyn] 发布异常：${e?.message ?? e}`); }
      /* 等级门/登录过期：固定 24h 复查；其余：本周内正常重排 */
      if (levelGate || loginWait) {
        weeklyTimer = setTimeout(schedule, 24 * 3600 * 1000);
        weeklyTimer.unref?.();
      } else schedule();
    }, Math.max(30 * 1000, fireAt - Date.now()));
    weeklyTimer.unref?.();
    log(`[bili-dyn] 已排下次发布：约 ${Math.round((fireAt - now) / 3600000)} 小时后（本周 ${st.posted.length}/${st.planned}）`);
  };
  schedule();
}

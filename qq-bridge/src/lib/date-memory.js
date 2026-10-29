// 日期型记忆的解析与浮现（2026-10-28 主人需求：三天内的事不许忘、生日当天要答得出）
//
// 背景：会话每 12 次用户唤醒就轮换一次，光靠上下文保证不了"三天"；所以日期必须落进 memory.db，
// 再由桥在每轮唤醒时算好"今天/还有几天"推到模型眼前，不依赖她主动检索。
//
// 本模块只做纯解析（不读库、不读配置），便于单测。支持的写法：
//   · YYYY-MM-DD / YYYY/MM/DD / YYYY年M月D日 —— 明确年份，一次性事件（可落在过去）；
//   · M月D日 / M月D号 / M-D / M/D —— 没年份；含「生日/birthday/纪念日/周年」按每年循环，
//     其余按"下一个到达的这一天"（今年已过就顺延到明年）计算；
//   · tags 里的 date:YYYY-MM-DD 与 repeat:yearly 优先于正文解析。
// daysUntil 以北京时间为准：今天 = 0，明天 = 1，昨天 = -1。

const YEARLY_RE = /生日|birthday|纪念日|周年|周岁/i;
const EVENT_RE = /生日|birthday|纪念日|周年|面试|考试|答辩|婚礼|开学|入职|复查|手术|提交|截止|deadline|见面|约好|约定/i;

/** 北京时间的 Y/M/D（now 为毫秒时间戳） */
function bjYmd(now) {
  const d = new Date(Number(now) + 8 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** 两个北京日历日之间相差多少天（用 UTC 代理，差值精确到天） */
function daysBetween(a, b) {
  const ta = Date.UTC(a.y, a.m - 1, a.d);
  const tb = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((ta - tb) / 86400000);
}

/** 合法日期校验（防 2 月 30、13 月之类被当成日期） */
function validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * 从一条记忆里解析出日期。
 * @param {{content?:string, tags?:string, category?:string, now?:number}} o
 * @returns {null | {month:number, day:number, year:number|null, yearly:boolean, daysUntil:number, explicitYear:boolean}}
 */
export function parseMemoryDate(o = {}) {
  const content = String(o.content ?? '');
  const tags = String(o.tags ?? '');
  const category = String(o.category ?? '');
  const now = Number(o.now) || Date.now();
  const today = bjYmd(now);

  let year = null;
  let month = 0;
  let day = 0;
  let explicitYear = false;

  const tagDate = /date:\s*(\d{4})-(\d{1,2})-(\d{1,2})/i.exec(tags);
  const tagYearly = /repeat:\s*yearly/i.test(tags);
  const full = tagDate || /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(content);
  if (full) {
    year = Number(full[1]); month = Number(full[2]); day = Number(full[3]); explicitYear = true;
  } else {
    // 只写月日：10-28 / 10/28 / 11月3日 / 11月3号
    const md = /(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(content)
      || /(?:^|[^\d])(\d{1,2})\s*[-/]\s*(\d{1,2})(?!\d)/.exec(content);
    if (!md) return null;
    month = Number(md[1]); day = Number(md[2]);
  }
  if (!validYmd(2024, month, day)) return null;   // 2024 是闰年，2/29 合法

  const yearly = tagYearly || YEARLY_RE.test(content) || YEARLY_RE.test(category);

  if (explicitYear) {
    if (!validYmd(year, month, day)) return null;
    return { month, day, year, yearly, explicitYear: true, daysUntil: daysBetween({ y: year, m: month, d: day }, today) };
  }

  // 没写年份：先看今年；今年已过 → 年循环的顺延到明年，一次性的保留为"已过"
  let y = today.y;
  let days = daysBetween({ y, m: month, d: day }, today);
  if (days < 0 && yearly) {
    y += 1;
    days = daysBetween({ y, m: month, d: day }, today);
  }
  return { month, day, year: yearly ? y : null, yearly, explicitYear: false, daysUntil: days };
}

/** -1/0/1/N 的中文说法 */
export function dateTip(daysUntil) {
  if (daysUntil === 0) return '今天';
  if (daysUntil === 1) return '明天';
  if (daysUntil === 2) return '后天';
  if (daysUntil === -1) return '昨天';
  if (daysUntil > 0) return `还有 ${daysUntil} 天`;
  return `${-daysUntil} 天前`;
}

/** MM-DD（补零） */
export function mmdd(month, day) {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 从一段记忆文本里抽出"近期日期条目"，给 [Dates] 行用。
 * 返回 { month, day, daysUntil, tip, text } 或 null。
 */
export function dateDigestItem(content, { tags = '', category = '', now = Date.now(), daysAhead = 7, daysBack = 1 } = {}) {
  const text = String(content ?? '');
  const cat = String(category ?? '').toLowerCase();
  const hasDateTag = /date:/i.test(String(tags ?? ''));
  const yearly = YEARLY_RE.test(text) || YEARLY_RE.test(cat);
  const eventWord = EVENT_RE.test(text);
  /* 不是所有带日期的记忆都是事件：规则类条目常把日期当时间戳写（「2026-10-27 要求：…」），
   * 放进 [Dates] 会把规则当生日报。只认两种：显式 date: 标签，或正文里有事件词
   * （生日/面试/纪念日/截止…）。 */
  if (!(hasDateTag || eventWord)) return null;
  const ev = parseMemoryDate({ content: text, tags, category, now });
  if (!ev) return null;
  if (ev.daysUntil > daysAhead || ev.daysUntil < -daysBack) return null;
  return { ...ev, tip: dateTip(ev.daysUntil), dateText: mmdd(ev.month, ev.day), text: text.replace(/\s+/g, ' ').slice(0, 80) };
}

/**
 * 轮换前扫描最近消息：找出"提到日期/事件但可能没落盘"的句子。
 * 只做提示（桥提示、模型写），不自动写库——误记比忘掉更糟。
 * @param {Array<{text?:string, isSelf?:boolean}>} messages
 */
export function extractDateHints(messages, { limit = 3 } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.isSelf) continue;
    const t = String(m.text ?? m.plain ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!/\d{1,2}\s*月\s*\d{1,2}|\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}|\d{1,2}[-/]\d{1,2}/.test(t)) continue;
    if (!EVENT_RE.test(t)) continue;
    const key = t.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.slice(0, 100));
    if (out.length >= limit) break;
  }
  return out;
}

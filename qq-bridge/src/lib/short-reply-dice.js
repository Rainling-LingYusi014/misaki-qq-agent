// 低信息量消息（owo / 表情 / 单字 / 表情包）「这一轮回不回」的抽签（纯函数）
//
// 主人原话：「misaki 可以直接不回啊，不回复是被允许的」——但不是"遇到表情包一律沉默"，
// 那种一刀切一样不像人；所以交给骰子：桥每轮掷一次，结果当数据行写进唤醒正文，模型照着办。
// 跟 [Voice]/[Meme] 抽签同一套路（见 core/send-dice.js）：让模型自己"按概率感觉一下"
// 从来没准过，桥侧掷骰才稳，也才验得出来。
//
// 2026-10-29 拆分（主人定规）：表情包和照片以前被当成同一种"有图"，一张美食照和一张贴纸同样
// 50% 被要求沉默。现在按 QQ 给的 picSubType/summary 分开：
//   · 照片（image）—— 必须回，不进骰子。分享吃的、分享风景却没配字，本来就是想让人看。
//   · 表情包（sticker）—— 进五档骰子（收藏回发 / 评价 / 发自己的 / 沉默 / 拍一拍）。
//   · 冷场（距上一条消息超过该模式的冷场阈值）—— 表情包也必须回：隔了很久还发一个表情，
//     意思等同于"在忙？"/打个招呼，已读不回比沉默伤人得多。
//   · 纯文字（单字 / 应声 / 纯 emoji）—— 维持原来的 50/50 沉默骰。
//
// "热聊"和"刚聊完"在这里不需要分开：两者都走同一个五档骰子。真正影响判定的只有"冷场没冷场"。

const DEFAULT_SILENCE_P = 0.5;   // 文字低信息量的沉默概率：一半左右
const DEFAULT_MAX_CHARS = 4;
/** 表情包五档的默认概率（沉默 = 剩下的 50%）。主人定的：5 / 5 / 30 / 10 / 50。 */
export const STICKER_DEFAULTS = { echo: 0.05, comment: 0.05, own: 0.30, poke: 0.10 };

/** 明确的应声 / 笑声 / 收尾语：整条只有这些才算"没什么可接的" */
const ACK_RE = /^(?:(?:哈|嘿|呵|嘻|草|艹|6|笑死|aw+a?|qwq|ow+o?|uw+u?|嗯|哦|噢|嗷|好|行|可|对|是|收到|了解|知道|懂|ok|okk|谢谢|多谢|thx|ty|3q|晚安|早安|早|拜拜|88)[\s。.!！~～…]*)+$/i;
const QUESTION_RE = /[?？]/;
const ASK_RE = /吗|么|呢|咋|啥|什么|为什么|怎么|哪|几|谁|多少/;
/** 纯 emoji / 表情符号（没有任何文字） */
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F\s]+$/u;

const clamp01 = (n, d) => (Number.isFinite(Number(n)) ? Math.min(1, Math.max(0, Number(n))) : d);

/**
 * 这条消息是不是"低信息量"（回不回都正常的那种）。
 * 注意：带照片的一律不算低信息量——照片要被看见，不是应声。
 * @param {{text?:string, hasMedia?:boolean, hasFile?:boolean, maxChars?:number, mediaKinds?:string[]}} a
 * @returns {boolean}
 */
export function isLowInfoIncoming(a = {}) {
  if (a.hasFile === true) return false;                 // 文件/文档要回应
  const kinds = Array.isArray(a.mediaKinds) ? a.mediaKinds : [];
  if (kinds.includes('image')) return false;            // 照片要回应（2026-10-29）
  const text = String(a.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return a.hasMedia === true || kinds.length > 0;  // 纯贴纸/小黄脸（空文本）才算
  // 「ow o」「哈 哈」这类带空格的分开输法先压掉空格再认，否则同一句两种写法两种待遇
  const compact = text.replace(/\s+/g, '');
  /* 表情包/图片在正文里常是占位符：[表情] / [动画表情] / [图片] / [笑]。
   * 它们不是"一句真话"，必须当低信息量处理 —— 否则纯表情包消息永远进不了抽签。 */
  const bare = compact.replace(/\[[^\]]{1,10}\]/g, '');
  if (!bare) return true;
  if (ACK_RE.test(bare) || EMOJI_ONLY_RE.test(bare)) return true;
  if (QUESTION_RE.test(text) || ASK_RE.test(text)) return false;   // 问句一律要回
  const maxChars = Math.max(1, Math.round(Number(a.maxChars) || DEFAULT_MAX_CHARS));
  if ([...bare].length > maxChars) return false;        // 有正话
  if ([...bare].length === 1) return true;              // 单字（啊/诶/嗯…，问句已在上面排除）
  return false;                                         // 其它短句（我回来了 / 你先忙）照常回
}

/**
 * 把一条入站消息归类，决定用哪套策略。
 * @returns {'file'|'photo'|'sticker'|'text-normal'|'text-low'|'none'}
 */
export function classifyIncoming(a = {}) {
  if (a.hasFile === true) return 'file';
  const kinds = Array.isArray(a.mediaKinds) ? a.mediaKinds : [];
  const text = String(a.text ?? '').replace(/\s+/g, ' ').trim();
  const bare = text.replace(/\s+/g, '').replace(/\[[^\]]{1,10}\]/g, '');
  if (!bare) {
    if (kinds.includes('image')) return 'photo';        // 只有照片、没配字 → 必须回
    if (kinds.includes('sticker')) return 'sticker';    // 只有表情包 → 五档骰子
    if (kinds.length > 0 || text) return 'text-low';    // 纯小黄脸 / 纯占位符
    return 'none';
  }
  return isLowInfoIncoming(a) ? 'text-low' : 'text-normal';
}

/**
 * 表情包的五个去向（2026-10-29 主人定规）。
 *   冷场 → 必须回一句（不掷骰）。
 *   非冷场 → 5% 收藏并原样发回 / 5% 评价内容 / 30% 发自己的 / 10% 拍一拍 / 剩余沉默。
 * 概率写歪了也不怕：四项之和超过 1 就按比例归一，沉默取剩余。
 * @param {{roll?:number, probs?:{echo?:number,comment?:number,own?:number,poke?:number}, cold?:boolean}} a
 * @returns {{action:'ECHO'|'COMMENT'|'OWN'|'POKE'|'SILENT'|'COLD_REPLY', roll:number}}
 */
export function stickerReplyDecision(a = {}) {
  const rng = typeof a.rng === 'function' ? a.rng : Math.random;
  const raw = Number(a.roll != null ? a.roll : rng());
  const roll = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 0;
  if (a.cold === true) return { action: 'COLD_REPLY', roll };
  const p = a.probs || {};
  const bands = [
    ['ECHO', clamp01(p.echo, STICKER_DEFAULTS.echo)],
    ['COMMENT', clamp01(p.comment, STICKER_DEFAULTS.comment)],
    ['OWN', clamp01(p.own, STICKER_DEFAULTS.own)],
    ['POKE', clamp01(p.poke, STICKER_DEFAULTS.poke)],
  ];
  const sum = bands.reduce((n, [, v]) => n + v, 0);
  if (sum > 1) for (const b of bands) b[1] /= sum;
  const used = Math.min(1, sum);
  let acc = 0;
  for (const [name, v] of bands) {
    acc += v;
    if (roll < acc) return { action: name, roll };
  }
  // 剩下的概率全给沉默（配置把四项写满 1 时这里永远到不了）
  void used;
  return { action: 'SILENT', roll };
}

/**
 * 掷骰：低信息量消息这一轮该沉默还是该接一句（文字/小黄脸用）。
 * @param {{text?:string, hasMedia?:boolean, hasFile?:boolean, maxChars?:number, mediaKinds?:string[],
 *          probability?:number, rng?:() => number}} a
 * @returns {{lowInfo:boolean, p:number, roll:number, silent:boolean}}
 */
export function shortReplyDecision(a = {}) {
  const p = clamp01(a.probability, DEFAULT_SILENCE_P);
  const rng = typeof a.rng === 'function' ? a.rng : Math.random;
  const raw = Number(rng());
  const roll = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 0;
  const lowInfo = isLowInfoIncoming(a);
  return { lowInfo, p, roll, silent: lowInfo && p > 0 && roll < p };
}

/** 供诊断：当前默认值（配置没写时生效的那些） */
export function shortReplyDefaults() {
  return { silenceProbability: DEFAULT_SILENCE_P, maxChars: DEFAULT_MAX_CHARS, sticker: { ...STICKER_DEFAULTS } };
}

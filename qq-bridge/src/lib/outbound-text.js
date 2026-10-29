// 出站文本清洗
import { KNOWN_AGENT_TOKENS } from './text-safe.js';
import { stripImeEmoji } from './emoji.js';

// 只替换 KNOWN_AGENT_TOKENS 命中的令牌（不动 SENSITIVE_RE 之外的文本）
export function redactKnownTokensOnly(text) {
  let s = String(text ?? '');
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && s.includes(token)) s = s.split(token).join('***');
  }
  return s;
}

// —— 表情/图片占位符根治（2026-09-03）——
// AI 常把"想发的图/表情描述"误写成文字占位符（[表情:蓝鱼吃白米饭，开心]、
// [表情包:喜欢阁下：蓝发猫耳女仆…]、[QQ表情:害羞(148)]、[表情:xx.webp]、[收藏表情:…]等）。
// 本应通过 qq_send_meme / qq_send_sticker / qq_send_qq_face 或 qq_send_message 的 images
// 参数发真图；直接发这段文字 = "表情没发出去"，是观感崩坏的根源。
// 根治策略：出站文本把这类占位【全部剥掉】，占位单独成条且无法翻译成真表情时【整条丢弃】，
// 绝不把文字版表情发出去；可翻译成 QQ 原生 face 的（如 (148)）直接改发真 face 段。
const ARTIFACT_TOKEN_RE = /\[(?:QQ表情|q表情|表情包|表情|鲸鱼表情|收藏表情|大肥鱼表情|动画表情|动图|截图|图片|贴纸|颜文字|face|sticker)\s*[:：]\s*[^\]\[]+\]|\[(?:表情|QQ表情|face)\s*\(?\d{1,4}\)?\]/g;

// 清扫全部表情/图片占位符。返回 { text: 清除后的正文, removed: 清除个数, tokens: 各占位内部文本 }
export function sweepMessageArtifacts(text) {
  const s = String(text ?? '');
  const cq = [];
  const tokens = [];
  const masked = s.replace(/\[CQ:[^\]]*\]/g, (m) => { cq.push(m); return '\u0003'; });
  let removed = 0;
  let t = masked.replace(ARTIFACT_TOKEN_RE, (m) => {
    removed++;
    tokens.push(m.slice(1, -1));
    return ' ';
  });
  t = t.replace(/\u0003/g, () => cq.shift() || '');
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？；：、,.!?;:])/g, '$1').replace(/^\s+|\s+$/g, '');
  return { text: t, removed, tokens };
}

// 兼容旧调用：只取清扫后的文本
export function stripMessageArtifacts(text) {
  return sweepMessageArtifacts(text).text;
}

// 出站文本统一清洗：令牌脱敏 → 表情/图片占位符清扫 → 输入法 emoji 剥离。
export function cleanOutboundText(text) {
  const swept = sweepMessageArtifacts(text);
  return stripImeEmoji(swept.text);
}

/**
 * 闲聊短句的句尾句号（2026-10-28 主人：「正常人聊天打字不会额外打句号」）。
 *
 * 现场是「收下啦。」——一条三个字的短句还挂个句号，读起来像公文。但主人也说了
 * 「完全禁用掉又不现实、不合适」：长段落、正式说明、多条陈述里句号是对的。
 * 所以只在最明显的那一类上兜底：**单行、不超过 maxChars 字、结尾是「。」** 的气泡，
 * 把最后一个句号摘掉。多句混排、带换行、带链接、以引号/括号收尾的一律不动。
 *
 * 说明：这是提示词之外的第二道，专防"规则写了但她偶尔照旧"；长文本的句读交给模型自己判断。
 */
export function trimCasualPeriod(text, { maxChars = 20 } = {}) {
  const s = String(text ?? '');
  if (!s || !/。$/.test(s)) return s;
  if (s.length > Math.max(1, Number(maxChars) || 20)) return s;
  if (/[\n\r]/.test(s)) return s;
  if (/https?:\/\/|www\./i.test(s)) return s;
  return s.slice(0, -1);
}

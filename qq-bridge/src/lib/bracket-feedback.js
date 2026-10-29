// 括号反馈（2026-10-29 主人定规，陪伴模式专属「高级反馈总开关」）：
//   她可以用括号表达动作/表情/心理（(低头)(担忧)(抱)），像坐在对面而不是对话框。
//   场景由「用户的动作性」判定：用户做出动作（摸摸头/抱一下…）→ 实时档（100%，每句都带）；
//   用户停留在聊天层面 → 普通档（每个气泡独立掷 (10+x)%，x 为发泡前现掷的 0~30 随机整数）。
//   切出 = 动作停止后经过保持窗（realtimeHoldMs）自动落回普通档；新动作只续窗、不叠加——
//   一次识别的最坏影响就是一个保持窗的时长，结构上不存在「永久 100%」。
//   一个气泡最多两段，双段概率 10%；心理类不降档。括号统一半角 ()（中文全角太宽，代码层归一）。
// 桥在发送瞬间读档位并掷骰——「出不出现」是骰子的决定，「写什么」是她的事。
// 与气泡骰子同源：stableRoll 按（会话+文本）做指纹，同句重发同形，幂等账本不乱。
import { stableRoll } from './dice.js';

export const BRACKET_FEEDBACK_DEFAULTS = Object.freeze({
  enabled: true,
  realtimeHoldMs: 10 * 60 * 1000, // 动作性保持窗：窗内都算实时档；超时无新动作自动落回普通档
  normalBasePct: 10,              // 普通档基础命中率 10%
  normalXMax: 30,                 // x ∈ [0,30]，每气泡现掷 → 普通档命中率 10%~40%
  twoSegmentPct: 10,              // 单气泡出现两段的概率 10%（其余保留一段）
  maxSegmentChars: 12,            // 动作段长度上限（超过视为普通括号注解，不算反馈）
  actionRepeatBubbles: 6,         // 动作类：最近 N 个气泡内不允许出现完全相同的段（表情/心理不受此限）
  chainPct: 8,                    // 实时档：动作链触发概率（8%）
  chainTwoPct: 67,                // 动作链命中后 2 条的概率（67%），否则 3 条
  singleActionPct: 8,             // 实时档：动作链没中时，「单个纯动作反馈代替文字」的概率（8%）
  actionOnlyMaxTextChars: 20,     // 纯动作代替文字前，原话最多这么长（超过=在回答具体问题，不许吃成动作）
});

/** 归一化配置：脏值回落默认，比例夹 [0,100]。 */
export function bracketFeedbackCfg(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const pct = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : d; };
  const num = (v, d, min = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, n) : d; };
  return {
    enabled: o.enabled !== false,
    realtimeHoldMs: num(o.realtimeHoldMs, BRACKET_FEEDBACK_DEFAULTS.realtimeHoldMs, 60 * 1000),
    normalBasePct: pct(o.normalBasePct, BRACKET_FEEDBACK_DEFAULTS.normalBasePct),
    normalXMax: pct(o.normalXMax, BRACKET_FEEDBACK_DEFAULTS.normalXMax),
    twoSegmentPct: pct(o.twoSegmentPct, BRACKET_FEEDBACK_DEFAULTS.twoSegmentPct),
    maxSegmentChars: num(o.maxSegmentChars, BRACKET_FEEDBACK_DEFAULTS.maxSegmentChars, 2),
    actionRepeatBubbles: num(o.actionRepeatBubbles, BRACKET_FEEDBACK_DEFAULTS.actionRepeatBubbles, 0),
    chainPct: pct(o.chainPct, BRACKET_FEEDBACK_DEFAULTS.chainPct),
    chainTwoPct: pct(o.chainTwoPct, BRACKET_FEEDBACK_DEFAULTS.chainTwoPct),
    singleActionPct: pct(o.singleActionPct, BRACKET_FEEDBACK_DEFAULTS.singleActionPct),
    actionOnlyMaxTextChars: num(o.actionOnlyMaxTextChars, BRACKET_FEEDBACK_DEFAULTS.actionOnlyMaxTextChars, 1),
  };
}

/* ── 括号段分型（2026-10-29 主人定规）────────────────────────────────────
 * 只有**动作类**受「6 个气泡内不许完全相同」的限制；表情/神态/心理活动暂时不设限制。
 * 分类用策展词表 + 「未知归动作」：宁可错拦一个动作，也不要去限制笑/担忧这种表情心理
 * （主人明确说这两类暂不限制）。词表可加，判定是纯函数，改完有单测兜底。 */
const EXPRESSION_RE = /(笑|皱眉|挑眉|眯眼|睁大|眨眼|别开眼|移开视线|视线|脸红|脸色|神情|表情|撇嘴|撅嘴|抿嘴|咬唇|吐舌|翻白眼|叹气|沉默|愣|怔|发呆|苦笑|冷笑|坏笑)/;
const MIND_RE = /(担忧|心疼|开心|高兴|难过|伤心|委屈|生气|紧张|不安|害怕|慌|心虚|犹豫|纠结|无奈|无语|尴尬|期待|不舍|羡慕|愧疚|心软|安心|放心|忐忑|失落|满足|烦躁|烦|累|酸|暖|甜|苦)/;

/** 段分型：'expression'（表情/神态）| 'mind'（心理活动）| 'action'（动作，受重复限制）。 */
export function classifySegment(inner) {
  const s = String(inner ?? '').replace(/\s+/g, '').trim();
  if (!s) return 'action';
  if (MIND_RE.test(s)) return 'mind';
  if (EXPRESSION_RE.test(s)) return 'expression';
  return 'action';
}

/* 动作性词表（低歧义 curated；完整动作靠括号/星号标记兜住）。
 * 故意不用单字「抱/拍/亲」：抱怨、拍一拍提示语、亲密度这类误报得不偿失。 */
const ACTION_VERB_RE = /(摸摸头|摸头|揉了揉|揉揉|抱抱|抱住|抱着我|搂着|搂住|牵起|牵着|牵住|亲了一口|亲了一下|亲额头|蹭了蹭|蹭蹭|挠了挠|戳了一下|戳戳|捏了捏|靠在你|靠在我|靠在肩|贴着|挽着|依偎|怀里|举高高)/;

/** 括号/星号动作段：（）() 均认（用户侧输入不定形），*…* 也认。 */
const MARKED_SEGMENT_RE = /[（(]([^（）()]{1,20})[)）]|\*([^*\n]{1,20})\*/g;

/**
 * 入站动作性检测（只扫用户发来的消息；她自己的动作不算）。
 * 命中任一 → 实时档。带图/带链接的消息不检测（媒体描述不是动作）。
 */
export function detectActionSignal(text, cfg = bracketFeedbackCfg()) {
  const s = String(text ?? '');
  if (!s) return false;
  if (/https?:\/\/|\[\w+:/.test(s)) return false; // 链接/卡片，不判动作
  if (MARKED_SEGMENT_RE.test(s)) {
    MARKED_SEGMENT_RE.lastIndex = 0;
    return true;
  }
  return ACTION_VERB_RE.test(s);
}

/** 当前场景：动作保持窗内 = realtime，否则 normal。（st.bracketSceneUntil 由入站钩子维护） */
export function bracketScene(st, now = Date.now()) {
  return Number(st?.bracketSceneUntil) > now ? 'realtime' : 'normal';
}

/** 把文本切成 [普通文本 | 括号段] 序列；段对象带原文与半角归一后的内容。 */
function splitSegments(text) {
  const parts = [];
  const re = /([（(][^（）()]{1,40}[)）])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', value: text.slice(last, m.index) });
    const raw = m[1];
    parts.push({ kind: 'seg', value: raw, norm: `(${raw.slice(1, -1).trim()})` });
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

/** 是否「反馈形状」的段：短、无数字/链接/拉丁串——只剥这类，绝不碰 (2026-10-29)、(LOL)、(图1) 这类注解。 */
function isFeedbackShape(seg, maxChars) {
  if (seg.kind !== 'seg') return false;
  const inner = seg.value.slice(1, -1);
  if (!inner.trim() || inner.length > maxChars) return false;
  if (/[0-9a-zA-Z/\\.:_\-]{2,}/.test(inner)) return false; // 数字/链接/代码状内容
  return true;
}

/**
 * 对单个气泡做括号反馈成形（纯函数）。
 * scene='realtime' → 全保留；'normal' → 本气泡独立掷 (10+x)%（x 现掷 0..30），不中则剥光反馈段。
 * 保留时：默认 1 段，掷中 twoSegmentPct 才留 2 段（超出丢弃，保留靠前的）。
 * **动作类重复闸**（2026-10-29 主人定规）：同一动作段在最近 actionRepeatBubbles 个气泡内出现过
 *   完全相同的串 → 砍掉这一个（不替换）；砍光了就发不带括号的版本。表情/神态/心理**不受此限**。
 * 返回 { text, keptSegments, keptSegs, rolled }；keptSegs 是真正发出去的段（调用方拿去记账，
 *   只记动作类），seed = 稳定骰子指纹。
 */
export function shapeBrackets(text, { scene = 'normal', seed = '', cfg = bracketFeedbackCfg(), recentActions = [], bubbleSeq = 0 } = {}) {
  const src = String(text ?? '');
  const c = bracketFeedbackCfg(cfg);
  const parts = splitSegments(src);
  const segIdx = parts.map((p, i) => (isFeedbackShape(p, c.maxSegmentChars) ? i : -1)).filter((i) => i >= 0);
  if (!segIdx.length) return { text: src, keptSegments: 0, keptSegs: [], rolled: scene };

  // 命中判定：实时档必中；普通档每气泡独立掷 (base + x)%，x 现掷
  let keep;
  if (scene === 'realtime') {
    keep = true;
  } else {
    const x = Math.floor(stableRoll(`bf-x:${seed}`) * (c.normalXMax + 1));
    const pct = c.normalBasePct + x;
    keep = stableRoll(`bf-keep:${seed}`) * 100 < pct;
  }

  if (!keep) {
    const out = parts.filter((p) => p.kind === 'text' || !isFeedbackShape(p, c.maxSegmentChars))
      .map((p) => (p.kind === 'seg' ? '' : p.value)).join('');
    return { text: out.replace(/\s{2,}/g, ' ').trim(), keptSegments: 0, keptSegs: [], rolled: 'strip' };
  }

  // 保留：段数 = 1，掷中双段概率才 2；超出（含第三段起）一律剥
  const twoSeg = stableRoll(`bf-two:${seed}`) * 100 < c.twoSegmentPct;
  const keepCount = twoSeg ? 2 : 1;
  let picked = segIdx.slice(0, keepCount).map((i) => parts[i]);
  /* 动作类重复闸：只比对动作类（表情/心理豁免），窗口按气泡序号（不是墙钟），
   * 所以「隔了很久但只隔了两条」也算重复——这正是主人要的「6 个气泡内不许完全相同」。
   * 边界：上一个动作在第 10 泡、窗口 6 → 第 11~16 泡都算「6 个气泡内」（含第 6 个），17 泡起放行。 */
  if (c.actionRepeatBubbles > 0 && picked.length) {
    const floor = bubbleSeq - c.actionRepeatBubbles;
    picked = picked.filter((p) => {
      if (classifySegment(p.value.slice(1, -1)) !== 'action') return true; // 表情/心理不限
      const hit = (Array.isArray(recentActions) ? recentActions : []).some((r) => r && r.seg === p.norm && Number(r.seq) >= floor);
      return !hit;
    });
  }
  const keepSet = new Set(picked.map((p) => parts.indexOf(p)));
  /* 2026-10-29 主人定规：反馈性动作统一提到**句子最前**（原来跟着模型写的位置走，常落在句尾）。
   * 保留的段按原顺序前置、用一个空格连起来，正文去掉这些段后接在后面；
   * 非反馈形状的括号（日期/拉丁/超长注解）原地不动。 */
  const heads = [];
  const body = parts.map((p, i) => {
    if (p.kind === 'text') return p.value;
    if (!isFeedbackShape(p, c.maxSegmentChars)) return p.value;
    if (keepSet.has(i)) heads.push(p.norm);
    return '';
  }).join('');
  const rest = body.replace(/\s{2,}/g, ' ').trim();
  const outText = heads.length ? `${heads.join(' ')}${rest ? ` ${rest}` : ''}` : rest;
  return { text: outText, keptSegments: heads.length, keptSegs: heads, rolled: keepCount };
}

/**
 * 实时档的「整句变形」决策（2026-10-29 主人定规，纯函数）：
 *   ① 先掷**动作链**（chainPct，默认 8%）：中 → 2 条（67%）或 3 条（33%），一串动作/文字算**一句话**；
 *   ② 链没中 → 掷**单个纯动作反馈**（singleActionPct，默认 8%）：只发一个括号段，文字不出现；
 *   ③ 都没中 → 返回 normal，走原有逐气泡成形（实时档括号 100% 保留）。
 * 材料来自她这一轮写的东西：括号段按出现顺序做前 N-1 条（一条一段），文字垫最后一条；
 * 材料不够 N 条 → 链降级，继续按 ②③ 判（绝不硬编凑数）。
 * 纯动作代替文字有长度门槛：原话超过 actionOnlyMaxTextChars（默认 20 字）就不许被吃成动作
 * （那多半是在回答具体问题）。动作去重窗口对链里的每一段照常生效。
 * 返回 { mode: 'chain'|'single'|'normal', bubbles: [{text, seq}], usedSegs: [{seg, seq}] }。
 */
export function planRealtimeReply(messages, { scene = 'normal', seed = '', cfg = bracketFeedbackCfg(), recentActions = [], bubbleSeq = 0 } = {}) {
  const c = bracketFeedbackCfg(cfg);
  if (scene !== 'realtime') return { mode: 'normal', bubbles: [], usedSegs: [] };
  const list = Array.isArray(messages) ? messages.map((m) => String(m ?? '')) : [String(messages ?? '')];
  const segs = [];
  const texts = [];
  for (const m of list) {
    for (const p of splitSegments(m)) {
      if (p.kind === 'text') { if (p.value.trim()) texts.push(p.value.trim()); }
      else if (isFeedbackShape(p, c.maxSegmentChars)) segs.push({ norm: p.norm, kind: classifySegment(p.value.slice(1, -1)), taken: false });
    }
  }
  if (!segs.length) return { mode: 'normal', bubbles: [], usedSegs: [] };
  const text = texts.join(' ').replace(/\s{2,}/g, ' ').trim();

  const used = [];
  const pickSeg = (seq) => {
    for (const s of segs) {
      if (s.taken) continue;
      if (s.kind === 'action' && c.actionRepeatBubbles > 0) {
        const floor = seq - c.actionRepeatBubbles;
        if ((Array.isArray(recentActions) ? recentActions : []).some((r) => r && r.seg === s.norm && Number(r.seq) >= floor)) {
          s.taken = true; // 窗口内的重复动作直接跳过，不占气泡
          continue;
        }
      }
      s.taken = true;
      used.push({ seg: s.norm, seq });
      return s.norm;
    }
    return '';
  };
  const resetDraft = () => { for (const s of segs) s.taken = false; used.length = 0; };

  // ① 动作链
  if (stableRoll(`bf-chain:${seed}`) * 100 < c.chainPct) {
    const n = stableRoll(`bf-chain-n:${seed}`) * 100 < c.chainTwoPct ? 2 : 3;
    const out = [];
    let seq = bubbleSeq;
    let ok = true;
    for (let j = 0; j < n; j++) {
      seq += 1;
      if (j < n - 1) {
        const seg = pickSeg(seq);
        if (!seg) { ok = false; break; }
        out.push({ text: seg, seq });
      } else {
        const seg = pickSeg(seq);
        if (!seg && !text) { ok = false; break; }
        out.push({ text: seg && text ? `${seg} ${text}` : (seg || text), seq });
      }
    }
    if (ok && out.length === n) return { mode: 'chain', chainSize: n, bubbles: out, usedSegs: used.slice() };
    resetDraft(); // 材料不够 → 降级
  }

  // ② 单个纯动作反馈
  if (stableRoll(`bf-single:${seed}`) * 100 < c.singleActionPct) {
    const seq = bubbleSeq + 1;
    const seg = pickSeg(seq);
    const textLen = [...text].length;
    if (seg && textLen <= c.actionOnlyMaxTextChars) {
      return { mode: 'single', bubbles: [{ text: seg, seq }], usedSegs: used.slice() };
    }
    resetDraft();
  }

  return { mode: 'normal', bubbles: [], usedSegs: [] };
}

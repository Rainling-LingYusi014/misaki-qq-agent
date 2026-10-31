// 气泡成形（2026-10-28 主人定规，2026-10-29 改为骰子分配）
//
// 历史（为什么会有这个文件）：
//   ① 10-28：「不发一大坨」——长句要拆成两个甚至更多气泡。桥层做了 30 字必拆。
//   ② 结果拆过头：「一句话几乎必定被分成两条」。把阈值调到 60、把～从句末标点里去掉，
//      都只是把线挪了挪，没治根——根子是「拆」被写成了默认动作、而不是一种概率。
//   ③ 10-29 主人定下终局：**一句话落成几个气泡由骰子分**，1 / 2 / 3 个的概率是 70% / 25% / 5%
//      （「是的，一句话现在支持最多三个气泡」）。
//
// 所以现在分工是：
//   · 模型负责把话写对（内容、语气、该不该说）；
//   · 桥负责成形：把这一回合的气泡拼回一句，按骰子抽到的条数重新切开。
//   模型自己分了 1、2、3 条都不算数——先拼再分，所以气泡之间的文本必须经得起「拼回一行」。
//
// 骰子用文本指纹（stableRoll）：同一句话永远是同一个条数（幂等账本按真正发出去的碎片记账，
// 重发必须得到同样的切法），不同句子之间各自独立，长期分布就是 70/25/5。
//
// 切点规则（刻意保守）：
//   · 句子边界（。！？!?…）优先，切口后紧跟的引号/括号归前一条，不让气泡以 " 开头；
//   · 只有句子边界不够凑条数时，才允许在「，」后切（那是语气停顿）；「、」永远不切——那是并列，切了就断意；
//   · 波浪号 ～ 不算句末（语气尾巴：「知道的～」），省略号 … 算；
//   · 每片不少于 PIECE_MIN 字；拼回去必须等于拼出来的那一句（只 trim 首尾空白）；
//   · 一条超过 wallChars 的句子不许再整条发：过 40 字至少两条、过 ~72 字三条
//     （2026-10-29 主人：60 字还是太长，"正常人也很少超过 50 字"，先定 40）。
//   · 2026-10-31 主人定规「气泡卫生」：闲聊里人类不用换行和空格分句——两侧都是汉字的
//     空格就该是逗号（「别说话了 闭眼」→「别说话了，闭眼」），挨着英文/数字的空格是
//     排版保留；单个换行 = 两个话题，各成一个气泡（「人类直接换一个气泡了」）；
//     ≥2 个换行（歌词、help 回执这类短行结构）与代码块仍原样放行——那是原豁免面。
import { stableRoll } from './dice.js';

const SENTENCE_END = /[。！？!?…]/;
const TRAILING = /["'”’）)】」』]/;
const PIECE_MIN = 6;
/** 主人定的比例：1 / 2 / 3 个气泡 */
export const BUBBLE_ODDS = Object.freeze([0.70, 0.25, 0.05]);
const DEFAULT_WALL = 40;
const WALL3_RATIO = 1.8;

/**
 * 句内所有合法切点。
 * @param {string} text
 * @param {{minPiece?: number, allowComma?: boolean}} [opts]
 * @returns {{at:number, strong:boolean, eat:boolean}[]}
 *   strong = 句末标点（优先）；否则是「，」或「～」这类语气停顿。
 *   eat = 切开时把这个标点吃掉（「，」）；「～」保留在句尾——它本来就是语气尾巴。
 */
export function findCuts(text, opts = {}) {
  const s = String(text ?? '');
  const minPiece = Math.max(2, Math.round(Number(opts.minPiece) || PIECE_MIN));
  const allowComma = opts.allowComma === true;
  const cuts = [];
  for (let i = 0; i < s.length; i++) {
    const strong = SENTENCE_END.test(s[i]);
    const weakComma = !strong && allowComma && s[i] === '，';
    const weakTilde = !strong && allowComma && (s[i] === '～' || s[i] === '~');
    if (!strong && !weakComma && !weakTilde) continue;
    // ～ 是语气尾巴，不是句子边界：允许在更短的短语后就断（「知道的～」/「你说吧」）
    const minB = weakTilde ? Math.min(3, minPiece) : minPiece;
    let j = i + 1;
    if (strong) while (j < s.length && (SENTENCE_END.test(s[j]) || TRAILING.test(s[j]))) j++;
    if (j < s.length && j >= minB && s.length - j >= minB) cuts.push({ at: j, strong, eat: weakComma, min: minB });
    i = j - 1;
  }
  return cuts;
}

/** 把模型给的几条气泡拼回一句话：前一条没有停顿标点就补一个「，」，免得两句话粘成一个病句。 */
const NO_SEP_END = /[。！？!?…～~，、；;：:""''）)】」』]$/;
export function joinBubbles(messages) {
  const parts = (Array.isArray(messages) ? messages : [messages])
    .map((m) => String(m ?? '').trim())
    .filter(Boolean);
  let out = '';
  for (const p of parts) {
    if (!out) { out = p; continue; }
    out += NO_SEP_END.test(out) ? p : `，${p}`;
  }
  return out;
}

/**
 * 掷骰：这句话该落成几个气泡（1~3）。
 * @param {string} text 拼好的整句
 * @param {number[]} [odds] 长度 3 的权重，缺省 70/25/5
 */
export function rollBubbleCount(text, odds) {
  const p = Array.isArray(odds) && odds.length === 3 && odds.every((x) => Number.isFinite(x) && x >= 0)
    ? odds
    : BUBBLE_ODDS;
  const sum = p.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return 1;
  const r = stableRoll(`bubble:${text}`) * sum;
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i];
    if (r < acc) return i + 1;
  }
  return 1;
}

function chooseCuts(text, cuts, pieces, minPiece) {
  const need = pieces - 1;
  const minOf = (c) => (Number.isFinite(c?.min) ? c.min : minPiece);
  const pick = (pool) => {
    const out = [];
    let prev = 0;
    for (let k = 1; k <= need; k++) {
      const target = Math.round((text.length * k) / pieces);
      // 切口自己的最小片长：～ 后面可以更短（「知道的～」），逗号/句号仍按 minPiece
      const ok = pool.filter((c) => c.at >= prev + minOf(c) && text.length - c.at >= minOf(c));
      if (!ok.length) return null;
      const score = (c) => Math.abs(c.at - target) - (c.strong ? 8 : 0);
      ok.sort((a, b) => score(a) - score(b));
      out.push(ok[0]);
      prev = ok[0].at;
    }
    return out;
  };
  // 句号够用就只用句号：在句子边界上断开才像"停了一下"，在逗号上断开只是够不着句号时的退路
  const strongOnly = cuts.filter((c) => c.strong);
  return pick(strongOnly) ?? pick(cuts) ?? [];
}

/** 审查 P2-4：无标点长句过墙的兜底——按字数均分补切点（确定性 → 幂等）。
 * 片长凑不足 minPiece 就降条数；两条都保证不了返回空（交回 hardSplit 按发送上限硬切）。 */
function positionalCuts(text, pieces, minPiece) {
  const s = String(text ?? '');
  let n = Math.max(2, Math.min(3, Math.round(Number(pieces) || 2)));
  while (n >= 2 && s.length < n * minPiece) n -= 1;
  if (n < 2) return [];
  const out = [];
  for (let k = 1; k < n; k++) out.push({ at: Math.round((s.length * k) / n), strong: false, eat: false });
  return out;
}

/** 2026-10-31 主人定规：两侧都是汉字的空格就是该是逗号的地方；挨着英文/数字的空格是排版，保留。
 * 审查 P2-5：口径从基本区汉字扩到中日韩全角——扩展A/兼容表意区、假名、谚文都算「两侧都是字」。 */
const CJK_SPACE_RE = /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af])[ \t\u3000]+(?=[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af])/g;

/**
 * 成形：拼回一句 → 换行/空格卫生 → 按骰子重切。
 * @param {string|string[]} messages 模型这一回合给出的气泡
 * @param {{enabled?: boolean, mode?: 'auto'|'single', odds?: number[], wallChars?: number,
 *          wall3Chars?: number, minPiece?: number, maxChars?: number}} [opts]
 *   mode='single'：这一位用户抱怨过被切碎，整段并成一条（只有超过 maxChars 才退回自动切法）
 * @returns {{bubbles: string[], rolled: number|string, count: number, text: string}}
 */
export function shapeBubbles(messages, opts = {}) {
  const input = (Array.isArray(messages) ? messages : [messages])
    .map((m) => String(m ?? '').trim())
    .filter(Boolean);
  if (!input.length) return { bubbles: [], rolled: 0, count: 0, text: '' };
  const raw = joinBubbles(input);
  if (opts.enabled === false) return { bubbles: input, rolled: 0, count: input.length, text: raw };
  // 代码块/多段结构（≥2 个换行：歌词、help 回执这类短行结构）不是聊天口气：原样放行，一个字不碰。
  // 2026-10-31 收窄：单个换行不再豁免——那是模型把换行当软分隔用，人类不这么打字。
  if (raw.includes('```') || (raw.match(/\r\n|\r|\n/g) || []).length >= 2) {
    return { bubbles: input, rolled: 0, count: input.length, text: raw };
  }
  /* 审查 P2-5：孤 \r（老 Mac 换行，模型偶尔吐）也按换行处理，不再漏清洗漏拆分 */
  const units = raw.split(/\r\n|\r|\n/).map((s) => s.replace(CJK_SPACE_RE, '$1，').trim()).filter(Boolean);
  if (!units.length) return { bubbles: [], rolled: 0, count: 0, text: '' };
  if (units.length === 1) return shapeOne(units[0], opts);
  // 单个换行 = 两个话题（2026-10-31 主人定规：人类直接换一个气泡）——各自成形，骰子只管每段内部。
  // 单条偏好的会话仍整段一条；总条数破 3 就退回「逗号拼回再骰切」，不破「一条最多三个气泡」。
  if (opts.mode === 'single') return shapeOne(units.join('，'), opts);
  const parts = units.map((u) => shapeOne(u, opts));
  const bubbles = parts.flatMap((p) => p.bubbles);
  if (bubbles.length <= 3) {
    return { bubbles, rolled: parts.map((p) => p.rolled).join('+'), count: bubbles.length, text: units.join('，') };
  }
  return shapeOne(units.join('，'), opts);
}

/** 单句成形（骰子 + 切点 + 长句墙）。shapeBubbles 的内部件，text 必须已不含换行。 */
function shapeOne(text, opts = {}) {
  const minPiece = Math.max(2, Math.round(Number(opts.minPiece) || PIECE_MIN));
  const wall = Math.max(20, Math.round(Number(opts.wallChars) || DEFAULT_WALL));
  const wall3 = Math.max(wall + 1, Math.round(Number(opts.wall3Chars) || wall * WALL3_RATIO));
  const cap = Math.max(1, Math.round(Number(opts.maxChars) || 500));

  const rolled = rollBubbleCount(text, opts.odds);
  // 单条偏好：只对这一位用户，不掷骰不设墙，整段一条；超过发送上限才继续往下切成合规的碎片
  if (opts.mode === 'single' && text.length <= cap) {
    return { bubbles: [text], rolled: 1, count: 1, text, mode: 'single' };
  }
  // 太短的不拆（「嗯」「在的」）。原来用 minPiece*2=12 当闸，会把「知道的～你说吧」这种真停顿也挡住。
  if (text.length < 6) { const hard = hardSplit(text, cap); return { bubbles: hard, rolled, count: hard.length, text }; }

  const cuts = findCuts(text, { minPiece, allowComma: true });
  const maxFeasible = Math.min(3, cuts.length + 1);
  let want = Math.min(rolled, maxFeasible);
  // 长句墙：>wall 至少两条，>wall3 三条。审查 P2-4：墙【不看】maxFeasible——
  // 没有标点切点（无标点长句/URL 串）时由 positionalCuts 按字数硬补切点，
  // 绝不把超墙的整句原样放行（文件头「过 40 字至少两条」原来是句空话）。
  if (text.length > wall3) want = Math.max(want, 3);
  else if (text.length > wall) want = Math.max(want, 2);

  if (want <= 1) { const hard = hardSplit(text, cap); return { bubbles: hard, rolled, count: hard.length, text }; }
  // 2026-10-29：切不开就降一档再试（3→2），别一次失败就把整句原样发出去
  let chosen = [];
  for (let n = Math.min(want, maxFeasible); n >= 2 && !chosen.length; n--) chosen = chooseCuts(text, cuts, n, minPiece);
  if (!chosen.length) chosen = positionalCuts(text, want, minPiece); // 无标点过墙：宁可切口生硬，不发一大坨
  if (!chosen.length) { const hard = hardSplit(text, cap); return { bubbles: hard, rolled, count: hard.length, text }; }
  const bubbles = [];
  let start = 0;
  for (const c of chosen) {
    // 在「，」处切开时把那个逗号留在切口里：气泡以「，」结尾是打字软件的痕迹，真人不会这么发。
    // 「～」不吞——它本来就是句尾的语气尾巴。
    const end = c.eat ? c.at - 1 : c.at;
    bubbles.push(text.slice(start, end).trim());
    start = c.at;
  }
  bubbles.push(text.slice(start).trim());
  const kept = bubbles.filter(Boolean).flatMap((b) => hardSplit(b, cap));
  const final = kept.length ? kept : hardSplit(text, cap);
  return { bubbles: final, rolled, count: final.length, text };
}

/**
 * 硬切到发送上限以内。只在「成形后的碎片超过 maxChars」时兜底用——
 * 多条原文各自合规、合并后却可能超长（例如 6×500 字），这一步保证发出去的每一条都合规。
 */
export function hardSplit(text, maxChars) {
  const s = String(text ?? '');
  const cap = Math.max(1, Math.round(Number(maxChars) || 500));
  if (s.length <= cap) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += cap) out.push(s.slice(i, i + cap));
  return out;
}

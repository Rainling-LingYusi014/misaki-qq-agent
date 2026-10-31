// 联想映射 · 运行时（2026-10-30）：给定对方这句话，从真人对里捞出「人类怎么回」。
//
// 为什么不做「先打标签再查桶」：桶要语义标注，标注要么花钱调云端（把好友私聊发出去，
// 越了主人定的不外传红线），要么等本地大模型。而**检索**不需要标注也能工作——
// 用字符二元组 TF-IDF 找历史上最像的那几句话，把它们的人类回复直接摆出来，
// 分布是实测的，不是猜的。这也正是「联想」两个字的原意：由一句想起一堆类似的。
//
// 边界：
//   ① 全本地内存索引，不出网；
//   ② 只回分布 + 脱敏原话（redact + 截断），不整段回放；
//   ③ 检索到的东西只作**语气锚**，不是让她照抄——照抄会连别人的私事一起搬过去。
import fs from 'node:fs';
import { log } from '../lib/log.js';
import { initCorpus, redact, classifyStrategy, lengthBucket, isNsfw, classifyIntent } from './corpus.js';

/** 中文没有空格，二元组是最省事又够用的相似度单位；拉丁/数字按词切。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9]+/g) || []) out.push(w);
  for (const seg of s.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.push(seg);
    else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

let index = null;
let indexSig = '';

/** 建/复用内存索引（按单条对方消息建，回复挂整块）。语料条数变了就重建。 */
export function buildIndex({ force = false } = {}) {
  const db = initCorpus();
  const rows = db.prepare(`SELECT u.id, u.stimulus, u.reply, u.resp_len, u.nsfw, c.peer_name, c.peer_uin, c.relation
                           FROM corpus_units u JOIN corpus_convs c ON c.id = u.conv_id`).all();
  const sig = `${rows.length}`;
  if (index && !force && indexSig === sig) return index;
  const docs = rows.map((r) => {
    const tf = new Map();
    for (const tk of tokenize(r.stimulus)) tf.set(tk, (tf.get(tk) || 0) + 1);
    let len = 0;
    for (const v of tf.values()) len += v;
    return {
      id: Number(r.id), stimulus: r.stimulus, reply: r.reply,
      strategy: classifyStrategy(r.reply), respLen: Number(r.resp_len) || 0,
      nsfw: Number(r.nsfw) === 1,
      conv: r.peer_name, convUin: String(r.peer_uin || ''), relation: r.relation || '', tf, len,
    };
  });
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.len;
    for (const tk of d.tf.keys()) df.set(tk, (df.get(tk) || 0) + 1);
  }
  const N = docs.length || 1;
  const avgdl = totalLen / N || 1;
  const idf = (tk) => Math.log(1 + (N - (df.get(tk) || 0) + 0.5) / ((df.get(tk) || 0) + 0.5));
  index = { docs, idf, N, avgdl, builtAt: Date.now() };
  indexSig = sig;
  return index;
}

export function resetIndex() { index = null; indexSig = ''; }

/** 指令/催促词（人类基线 4.3%、亲密语境 0%；分布统计与硬闸共用这份词表）。 */
export const IMP_RE = /(别|先|快去|快点|滚|记得|该去|起来吧|睡吧|闭眼)/;

/**
 * 无语境碎片闸（2026-10-31 R2 盲测定案）：「啊啊啊啊」「哈哈哈。」这类纯语气串没有可接的
 * 事——检索会命中一堆语气相同但内容无关的历史，注入的分布全是噪声。宁可不想，不想瞎想。
 * 主人原话：不是这类沟通不存在，是拿无上下文的碎片当刺激会「二次污染」。
 */
export function isLowContext(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  const bare = t.replace(/[\s。，！？、~～.!?…]+/g, '');
  if (!bare) return true;                                            // 全是标点
  if (/(.)\1{2,}/.test(bare) && [...bare].length <= 6) return true;  // 同字符刷屏（啊啊啊啊/？？？/6666）
  if (/^(哈|呵|嘿|咳|诶|唉|嗯|哦|欸)+$/.test(bare)) return true;     // 纯语气词串
  if ([...bare].length < 2) return true;                             // 单字（草/6/？）
  return false;
}

/**
 * 联想检索：BM25（k1=1.2, b=0.75）+ **命中 IDF 总量闸门**。
 * 只靠 BM25 分会把「只撞上一个常用词」的句子排上来；而纯比例覆盖率又会误杀
 * 「明天有空吗」这种含生僻二元组的短问句（只中两个词也到不了 50%）。
 * 所以改成看**命中了多少有信息量的词**（IDF 之和），两个常用词顶不上一个生僻词。
 */
export function associate(text, { k = 24, minMatchedIdf = 2.0, minCoverage = 0.4, relation = '', sampleExcludePeers = [] } = {}) {
  const idx = buildIndex();
  const qTokens = tokenize(text);
  if (!qTokens.length) return { query: text, matches: 0, stats: null, samples: [], distribution: [] };
  const qtf = new Map();
  for (const tk of qTokens) qtf.set(tk, (qtf.get(tk) || 0) + 1);
  const K1 = 1.2, B = 0.75;
  let totalIdf = 0;
  const qIdf = new Map();
  for (const tk of qtf.keys()) {
    const w = idx.idf(tk);
    qIdf.set(tk, w);
    totalIdf += w;
  }
  if (totalIdf <= 0) totalIdf = 1;
  const maxScore = totalIdf * (K1 + 1); // 每个词都饱和命中时的理论上限

  const scored = [];
  /* 语域隔离（2026-10-30 主人定规：NSFW 允许存在，但不许泛化）：
   * 查询本身是露骨语境时，只从露骨语料里取；普通聊天只从干净语料里取。
   * 两个方向都隔离，避免「正常聊天学来床上用语」或「床上用语被客服腔污染」。 */
  const queryNsfw = isNsfw(text);
  for (const d of idx.docs) {
    if (d.nsfw !== queryNsfw) continue;
    if (relation && d.relation !== relation) continue;
    let s = 0, matchedIdf = 0;
    for (const [tk] of qtf) {
      const f = d.tf.get(tk);
      if (!f) continue;
      const w = qIdf.get(tk);
      matchedIdf += w;
      s += w * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / idx.avgdl)));
    }
    if (!s) continue;
    // 两道闸：①命中的词要够「有信息量」（IDF 总量）；②命中要覆盖查询的 minCoverage。
    // 只看比例会放过「全是常用词」的匹配，只看绝对量会让小语料永远不命中。
    if (matchedIdf < minMatchedIdf) continue;
    if (matchedIdf / totalIdf < minCoverage) continue;
    scored.push({ score: s / maxScore, matchedIdf, d });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  if (!top.length) return { query: text, matches: 0, stats: null, samples: [], distribution: [] };

  const dist = new Map();
  let lenSum = 0, sticker = 0, question = 0, imperative = 0;
  const lenBuckets = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const { d } of top) {
    dist.set(d.strategy, (dist.get(d.strategy) || 0) + 1);
    lenSum += d.respLen;
    lenBuckets[lengthBucket(d.reply)] += 1;
    if (/^\[(图片|表情包|语音|视频)\]$/.test(d.reply.trim())) sticker += 1;
    if (/[?？]/.test(d.reply)) question += 1;
    if (IMP_RE.test(d.reply)) imperative += 1;
  }
  const n = top.length;
  const distribution = [...dist.entries()]
    .map(([strategy, count]) => ({ strategy, n: count, pct: Math.round((count / n) * 1000) / 10 }))
    .sort((a, b) => b.n - a.n);
  // 样例去重：同一句只说一次；只给短句，长段落会带出别人的事
  const seen = new Set();
  const samples = [];
  const bannedConv = new Set((Array.isArray(sampleExcludePeers) ? sampleExcludePeers : []).map(String));
  for (const { d, score, matchedIdf } of top) {
    if (bannedConv.has(d.convUin)) continue;   // 某些会话的原话不给出去（露骨内容/太私密），分布照算
    const t = d.reply.trim();
    if (seen.has(t) || [...t].length > 24 || t.startsWith('[')) continue;
    seen.add(t);
    samples.push({ text: redact(t), score: Math.round(score * 100) / 100, matchedIdf: Math.round(matchedIdf * 10) / 10, conv: d.conv, stimulus: redact(d.stimulus) });
    if (samples.length >= 5) break;
  }
  return {
    query: text, matches: n,
    stats: {
      avgLen: Math.round(lenSum / n),
      questionShare: Math.round((question / n) * 100),
      stickerShare: Math.round((sticker / n) * 100),
      imperativeShare: Math.round((imperative / n) * 100),
      lenBuckets: Object.fromEntries(Object.entries(lenBuckets).map(([b, c]) => [b, Math.round((c / n) * 100)])),
    },
    distribution, samples,
  };
}

/** 意图代码 → 中文名（注入块里给人看的版本）。 */
export const INTENT_CN = {
  emotion_vent: '情绪倾诉', question: '提问', invite: '邀约', joke: '玩笑', complain_other: '吐槽第三人',
  share: '日常陈述', low_info: '低信息', greeting: '寒暄', farewell: '告别', media: '发图/表情',
};

/** 自曝再分型（2026-10-30 主人定）：她能说「我今天看了什么/在学什么/生成了什么」（可核对的事实），
 *  但不能说「我也累/我也难受」——那是假装有身体和情绪。感受类降权，事实类保留。 */
const FEELING_RE = /(累|困|难受|疼|痛|烦|难过|开心|高兴|怕|慌|想哭|委屈|压力|焦虑|丧|emo|心累|撑不住|崩溃|熬夜|通宵|失眠|睡不|上课|考试|作业|上班|加班|吃饭|生病|感冒|发烧)/;

export function selfDiscloseKind(text) {
  return FEELING_RE.test(String(text ?? '')) ? 'feeling' : 'event';
}

/** 策略代码 → 中文名（注入块给人看，不夹英文）。 */
export const STRATEGY_CN = {
  empathy: '共情', question: '追问', advice: '建议', joke: '玩笑', self_disclose: '自曝',
  comfort: '安慰', divert: '转移', perfunctory: '敷衍', care: '关心', answer: '作答', media: '表情/图',
};

/**
 * 按配置调整策略权重（不改原始统计，只在注入时加权后归一）。
 * 目的：语料是真人，美咲不是——真人可以「我也累」，她不能；真人敷衍是自然，她敷衍多了像糊弄。
 * 调整项与倍率都写在 config.social.associative.strategyAdjust，可随时改。
 */
export function adjustDistribution(list, adjust = {}) {
  const fFeel = Number.isFinite(Number(adjust.selfDiscloseFeelingFactor)) ? Number(adjust.selfDiscloseFeelingFactor) : 0.3;
  const fEvent = Number.isFinite(Number(adjust.selfDiscloseEventFactor)) ? Number(adjust.selfDiscloseEventFactor) : 1;
  const fPerf = Number.isFinite(Number(adjust.perfunctoryFactor)) ? Number(adjust.perfunctoryFactor) : 0.8;
  const out = [];
  for (const d of list) {
    if (d.strategy === 'self_disclose') {
      const e = Number(d.nEvent);
      const f = Number(d.nFeeling);
      if (Number.isFinite(e) || Number.isFinite(f)) {
        // 拆成两条：模型能看出「说事」和「说感受」各占多少，才不会拿感受类来演
        out.push({ strategy: 'self_disclose_event', label: '自曝(说事)', n: (Number.isFinite(e) ? e : 0) * fEvent });
        out.push({ strategy: 'self_disclose_feeling', label: '自曝(说感受)', n: (Number.isFinite(f) ? f : 0) * fFeel });
        continue;
      }
      out.push({ strategy: 'self_disclose', label: '自曝', n: (Number(d.n) || 0) * fEvent });
      continue;
    }
    if (d.strategy === 'perfunctory') {
      out.push({ strategy: 'perfunctory', label: '敷衍', n: (Number(d.n) || 0) * fPerf });
      continue;
    }
    out.push({ strategy: d.strategy, label: d.label || STRATEGY_CN[d.strategy] || d.strategy, n: Number(d.n) || 0 });
  }
  const total = out.reduce((a, b) => a + b.n, 0) || 1;
  return out.filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => ({ ...x, pct: Math.round((x.n / total) * 1000) / 10 }));
}

/**
 * 意图桶兜底：检索不到近义原句时，用「关系 × 意图」的历史分布顶上。
 * 这一层不需要语义检索，靠规则判意图（够用：倾诉/提问/玩笑/告别都很显式）。
 * 返回注入文本；样本不足 minPairs 或意图判不出来就返回空——宁可不给。
 */
export function bucketHint(text, { relation = '', minPairs = 30, maxChars = 180, adjust = {}, sample = true } = {}) {
  const intent = classifyIntent(text);
  if (!intent || intent === 'other' || intent === 'media') return '';
  // share 是「没匹配到任何特征」的兜底类，不是判出来的——拿它取桶等于瞎猜，宁可跳过
  if (intent === 'share') return '';
  const db = initCorpus();
  const q = (rel) => db.prepare(`SELECT p.llm_strategy s, p.my_text t FROM corpus_pairs p
      JOIN corpus_convs c ON c.id = p.conv_id
      WHERE p.nsfw = 0 AND p.llm_intent = ? ${rel ? 'AND c.relation = ?' : ''}`).all(...(rel ? [intent, rel] : [intent]));
  let rows = relation ? q(relation) : [];
  let usedRel = relation;
  if (rows.length < minPairs) { rows = q(''); usedRel = ''; }  // 关系档太薄 → 退回全库
  if (rows.length < minPairs) return '';
  const dist = new Map();
  let len = 0, imp = 0, question = 0, sticker = 0;
  let selfEvent = 0, selfFeeling = 0;
  for (const r of rows) {
    const t = String(r.t || '');
    if (r.s === 'self_disclose') {
      if (selfDiscloseKind(t) === 'feeling') selfFeeling += 1; else selfEvent += 1;
    } else {
      dist.set(r.s, (dist.get(r.s) || 0) + 1);
    }
    len += [...t].length;
    if (IMP_RE.test(t)) imp += 1;
    if (/[?？]/.test(t)) question += 1;
    if (/^\[(图片|表情包)\]$/.test(t.trim())) sticker += 1;
  }
  if (selfEvent || selfFeeling) dist.set('self_disclose', { nEvent: selfEvent, nFeeling: selfFeeling });
  const n = rows.length;
  // 权重调整（自曝拆事实/感受，敷衍降权）后再归一
  const adjusted = adjustDistribution([...dist.entries()].map(([s, v]) => (typeof v === 'object' ? { strategy: s, ...v } : { strategy: s, n: v })), adjust);
  const top = adjusted.slice(0, 4).map((d) => `${d.label || d.strategy} ${d.pct}%`).join(' / ');
  const relCn = usedRel || '全库';
  /* 2026-10-30 盲测R1（30 条净负 8）定案：删「本轮建议走X」——真抽样会抽到低概率策略，
   * 注入行自相矛盾（分布前三 17/12/10%，建议走 6.5% 的那个）；且模型会去执行策略标签、
   * 跳过对方话里的具体字词，输的条目清一色「策略对、没接住词」。只给数据 + 一句立场提醒。 */
  let line = `[联想] 对方在${INTENT_CN[intent] || intent}（${relCn}，n=${n}），人类回应分布——${top}；平均 ${Math.round(len / n)} 字，指令句 ${Math.round((imp / n) * 100)}%，提问 ${Math.round((question / n) * 100)}%，表情/图 ${Math.round((sticker / n) * 100)}%。先接住对方这句话里的具体字词（里面的词、事、情绪），再决定怎么回。`;
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/** 按权重抽一个策略（真概率，不是提示）。返回 {strategy,label,pct}；分布为空返回 null。 */
export function weightedPick(dist, rnd = Math.random) {
  const list = Array.isArray(dist) ? dist.filter((d) => Number(d.n) > 0) : [];
  if (!list.length) return null;
  const total = list.reduce((a, b) => a + Number(b.n), 0);
  let r = rnd() * total;
  for (const d of list) {
    r -= Number(d.n);
    if (r <= 0) return d;
  }
  return list[list.length - 1];
}

/**
 * 生成注入用的 [联想] 块（M2）。先试检索近义原句；命中不足退回意图桶。
 * 任何一条不满足就返回空串——宁可不加，不要硬塞。
 */
export function associativeHint(text, { enabled = false, minMatches = 10, maxSamples = 2, maxChars = 180, relation = '', sampleExcludePeers = [], adjust = {}, sample = true } = {}) {
  if (!enabled) return '';
  if (isLowContext(text)) return '';
  const r = associate(text, { relation, k: 24, sampleExcludePeers });
  if (!r.matches || r.matches < minMatches) {
    // 检索够不着（同义改写）→ 意图桶兜底
    return bucketHint(text, { relation, maxChars, adjust });
  }
  // 检索路径同样过一遍权重调整（自曝拆事实/感受、敷衍降权）
  const adj = adjustDistribution(r.distribution, adjust);
  const top = adj.slice(0, 4).map((d) => `${d.label || d.strategy} ${d.pct}%`).join(' / ');
  const samples = r.samples.slice(0, maxSamples).map((s) => `"${s.text}"`).join(' ');
  // R1 同款定案：不给策略建议，只给数据 + 立场提醒（bucketHint 注释有完整理由）
  let line = `[联想] 对方这类话（n=${r.matches}），人类回应分布：${top}；平均 ${r.stats.avgLen} 字，提问 ${r.stats.questionShare}%，发表情/图 ${r.stats.stickerShare}%，指令句 ${r.stats.imperativeShare}%。先接住对方这句话里的具体字词（里面的词、事、情绪），再决定怎么回。`;
  if (samples) line += ` 语气锚（脱敏，别照抄原话）：${samples}`;
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/** 供 CLI/诊断：语料文件指纹与索引规模。 */
export function indexInfo() {
  const idx = buildIndex();
  return { docs: idx.N, builtAt: idx.builtAt };
}

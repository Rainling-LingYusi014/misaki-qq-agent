// 联想映射 · 语料层（2026-10-30 主人定规，最高优先级项目）
//
// 目的：让美咲学「真人怎么回」，而不是只靠 speech rules 砍错答。
// 语料只能来自**真人之间的对话**——本机 chat.db 里对方的回复全是 AI 生成的，学它只会学到 AI 腔。
// 所以语料源是 QQ Chat Explorer 导出的个人聊天记录（D:\QQChatExporter），本机离线处理。
//
// 结构：
//   corpus_convs  一条私聊一行（按 peerUin 去重，多份导出合并）
//   corpus_pairs  切轮后的 (对方说 → 我回) 对；意图/策略标注就地存
// 切轮规则：同一方 90 秒内的多条并成一句（真人聊天本来就是一串短句），换边即新轮。
//
// 隐私边界（写死在这里，任何调用方都绕不过）：
//   ① 全本地：db 在 state/（已 gitignore），不外传、不进 git、不写日志正文；
//   ② 对外只给**分布**，原话只在本机给人看；运行时注入的样例必须过 redact()；
//   ③ 语料来自好友，他们没同意过被训练——所以只做统计学习，不做逐字复述。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../lib/log.js';

/** 同一方连续消息合并成一句的时间窗。 */
export const TURN_GAP_MS = 90 * 1000;

let db = null;
let dbPath = '';

function stateDir() {
  const home = process.env.QQB_HOME ? path.resolve(process.env.QQB_HOME) : path.resolve(process.cwd());
  return path.join(home, 'state');
}

export function corpusDbPath() {
  return dbPath || path.join(stateDir(), 'corpus.db');
}

/** 打开/建库。幂等；CLI 与桥都能各自调用。 */
export function initCorpus(opts = {}) {
  const file = opts.file ? path.resolve(opts.file) : corpusDbPath();
  if (db && dbPath === file) return db;
  if (db) { try { db.close(); } catch { /* 旧句柄已失效 */ } }
  dbPath = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus_convs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_uin TEXT NOT NULL UNIQUE,
      peer_name TEXT DEFAULT '',
      relation TEXT DEFAULT '',
      msg_count INTEGER DEFAULT 0,
      pair_count INTEGER DEFAULT 0,
      first_ms INTEGER DEFAULT 0,
      last_ms INTEGER DEFAULT 0,
      src_files TEXT DEFAULT '[]',
      imported_at INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS corpus_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      peer_text TEXT NOT NULL,
      my_text TEXT NOT NULL,
      peer_ts INTEGER DEFAULT 0,
      my_ts INTEGER DEFAULT 0,
      peer_n INTEGER DEFAULT 1,
      my_n INTEGER DEFAULT 1,
      intent TEXT DEFAULT '',
      strategy TEXT DEFAULT '',
      resp_len INTEGER DEFAULT 0,
      UNIQUE(conv_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_pairs_intent ON corpus_pairs(intent);
    CREATE INDEX IF NOT EXISTS idx_pairs_conv ON corpus_pairs(conv_id);
    CREATE TABLE IF NOT EXISTS corpus_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id INTEGER NOT NULL,
      stimulus TEXT NOT NULL,
      reply TEXT NOT NULL,
      ts INTEGER DEFAULT 0,
      reply_n INTEGER DEFAULT 1,
      resp_len INTEGER DEFAULT 0,
      nsfw INTEGER DEFAULT 0,
      UNIQUE(conv_id, ts, stimulus)
    );
    CREATE INDEX IF NOT EXISTS idx_units_conv ON corpus_units(conv_id);
  `);
  // 轻量迁移：老库补列（nsfw 标记 2026-10-30 加，用于把露骨内容挡在统计与样例之外；
  // llm_* 是标注列，放在建库时补齐——否则 importCorpus 单独跑（不经过标注模块）会插入失败）
  try {
    const cols = db.prepare('PRAGMA table_info(corpus_pairs)').all().map((c) => c.name);
    const add = (name, type) => { if (!cols.includes(name)) db.exec(`ALTER TABLE corpus_pairs ADD COLUMN ${name} ${type}`); };
    add('nsfw', 'INTEGER DEFAULT 0');
    add('llm_intent', 'TEXT');
    add('llm_strategy', 'TEXT');
    add('llm_model', 'TEXT');
    add('llm_at', 'INTEGER');
  } catch { /* 建库失败时下面的查询会报出来 */ }
  return db;
}

export function closeCorpus() {
  if (db) { try { db.close(); } catch { /* 已关 */ } }
  db = null; dbPath = '';
}

export function _resetCorpus() {
  closeCorpus();
}

/* ── 文本抽取（导出格式差异全在这一个函数里兜住）────────────────────────
 * 只取「人说的话」：text / reply（剥掉 [回复消息] 前缀）。
 * 媒体记成标记而不是正文——它们仍然是「回复策略」（发表情包/发图），要计入分布。
 * system（戳一戳）、forward（转发他人内容）、json/file/markdown 一律丢弃：
 * 前者不是话，后两者会把别人的隐私带进来。 */
const MEDIA_MARK = {
  type_17: '[表情包]', market_face: '[表情包]', image: '[图片]', audio: '[语音]', video: '[视频]',
};

/* 行内媒体标记：导出里图片常是 type:'text' + content.text = "[图片:hash.jpg]"。
 * 不归一的话这些会当成句子进语料，既污染切轮也把文件名塞进标注。 */
const INLINE_MEDIA = [
  [/\[图片:[^\]]*\]/g, '[图片]'],
  [/\[(?:动画)?表情:[^\]]*\]/g, '[表情包]'],
  [/\[语音:[^\]]*\]/g, '[语音]'],
  [/\[视频:[^\]]*\]/g, '[视频]'],
  [/\[文件:[^\]]*\]/g, '[文件]'],
];

const MEDIA_ONLY_RE = /^(?:\[(?:图片|表情包|图片|语音|视频|文件)\]\s*)+$/;

/** 露骨内容粗筛：只用于把这类样本挡在统计与运行时样例之外，不作为分类依据。 */
const NSFW_RE = /(做爱|上床|呻吟|淫|骚|插入|射|龟头|肉棒|小穴|舔|脱光|裸|胸|湿湿|粘糊糊|色色|发情|高潮|约炮|调教|震动棒|自慰)/;

export function isNsfw(...texts) {
  return texts.some((t) => NSFW_RE.test(String(t ?? '')));
}

function normalizeInlineMedia(text) {
  let t = String(text ?? '');
  for (const [re, mark] of INLINE_MEDIA) t = t.replace(re, mark);
  return t.replace(/\s{2,}/g, ' ').trim();
}

export function extractMessage(m) {
  if (!m || m.system || m.type === 'system' || m.recalled) return null;
  const ts = Number(m.timestamp) || 0;
  if (!ts) return null;
  const raw = typeof m.content?.text === 'string' ? m.content.text : '';
  if (m.type === 'text' || m.type === 'reply') {
    let t = raw;
    if (m.type === 'reply') t = t.replace(/^\[回复消息\]\s*/, '');
    t = normalizeInlineMedia(t);
    if (!t || /^\[(文件)\]$/.test(t)) return null;
    return { text: t, kind: MEDIA_ONLY_RE.test(t) ? 'media' : 'text', ts };
  }
  const mark = MEDIA_MARK[m.type] || '';
  if (mark) return { text: mark, kind: 'media', ts };
  return null;
}

/** 同一方 90 秒内的连续消息合并成一块，换边或超时即切。块里保留原始消息（检索按单条建索引）。 */
export function buildBlocks(messages, selfUin) {
  const blocks = [];
  const items = [];
  for (const m of messages) {
    const ex = extractMessage(m);
    if (!ex) continue;
    const side = String(m.sender?.uin) === String(selfUin) ? 'me' : 'peer';
    items.push({ side, ...ex });
  }
  items.sort((a, b) => a.ts - b.ts);
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (last && last.side === it.side && it.ts - last.lastTs <= TURN_GAP_MS) {
      last.text += ` ${it.text}`;
      last.n += 1;
      last.lastTs = it.ts;
      last.msgs.push({ text: it.text, kind: it.kind, ts: it.ts });
    } else {
      blocks.push({ side: it.side, text: it.text, n: 1, ts: it.ts, lastTs: it.ts, msgs: [{ text: it.text, kind: it.kind, ts: it.ts }] });
    }
  }
  return blocks.map((b) => ({ side: b.side, text: b.text.replace(/\s{2,}/g, ' ').trim(), n: b.n, ts: b.ts, msgs: b.msgs }));
}

/** 相邻的「对方 → 我」两块构成一条轮样本；**单条**对方消息另成检索单元（unit），回复挂整块。 */
export function buildPairs(blocks) {
  const pairs = [];
  const units = [];
  for (let i = 0; i + 1 < blocks.length; i++) {
    if (blocks[i].side !== 'peer' || blocks[i + 1].side !== 'me') continue;
    const reply = blocks[i + 1];
    pairs.push({
      peerText: blocks[i].text,
      myText: reply.text,
      peerTs: blocks[i].ts,
      myTs: reply.ts,
      peerN: blocks[i].n,
      myN: reply.n,
    });
    for (const m of blocks[i].msgs) {
      if (m.kind !== 'text') continue;          // 媒体不进检索（没有语义可比）
      units.push({ stimulus: m.text, reply: reply.text, ts: m.ts, replyN: reply.n });
    }
  }
  return { pairs, units };
}

/* ── 双轨标注：意图轨（对方说了什么）／策略轨（我怎么回）────────────────
 * 这一版是**词表粗标**（M0/M1-lite）：够用来量覆盖度和桶样本量，也让人眼先看一眼分布对不对。
 * M1 正式版换模型批量打标，词表只留作兜底与抽检对照。 */
export const INTENT_KEYS = ['greeting', 'farewell', 'question', 'emotion_vent', 'invite', 'complain_other', 'joke', 'share', 'low_info', 'media', 'other'];
export const STRATEGY_KEYS = ['perfunctory', 'media', 'empathy', 'care', 'advice', 'question', 'comfort', 'joke', 'self_disclose', 'divert', 'answer', 'other'];

const R = {
  greeting: /^(早|早安|早上好|早呀|早哦|在吗|在不在|好久不见|最近怎么样|最近咋样|吃了没|干嘛呢|嗨|hi|hello)/i,
  farewell: /晚安|睡了|先这样|拜拜|再见|下线|我走了|我去忙|去睡觉|先不聊|拜了/,
  question: /[?？]|怎么|为什么|为啥|能不能|可不可以|帮我|有没有|是不是|行不行|要不要|多久|几点|哪里|哪儿|什么|吗/,
  emotion_vent: /累|烦|难受|难过|emo|崩溃|委屈|压力|恶心|受不了|哭了|想哭|不开心|心累|焦虑|头疼|失眠|睡不着|烦躁|丧|摆烂|自闭|破防|绝望|生气|气死/,
  /* 「出来」带负向环视（2026-10-31 R2 盲测定案）：「点不出来」「大退出来了」「转出来了」
   * 这类「<动词>(不)出来」的日常陈述曾被裸匹配抓成邀约，桶分布全错。 */
  invite: /要不要|一起|约个|约饭|(?<![点退拿转看读掏翻捞搜取]不?)出来|开黑|上线|来不来|走不走|明天|周末|今晚|待会|去吃|来玩/,
  complain_other: /(他|她|老师|老板|同事|同学|室友|领导|导员)[^。！？]{0,12}(烦|讨厌|傻|离谱|过分|恶心|气|不是人)/,
  /* 「太X了」用白名单（2026-10-31）：裸 `太.{0,4}了` 会把「太卡了/太贵了/太远了」这类抱怨吞成玩笑。
   * 逗号里只收玩笑向的补语；抱怨类让 emotion_vent / share 接住。 */
  joke: /哈哈|笑死|离谱|绷不住|草|乐了|绝了|蚌埠|6+$|牛|笑不活|太(搞|逗|乐|好笑|蠢|萌|逆天|上头|邪门|抽象)了|狗头|乐/,
  share: /我今天|我刚|刚才|昨天|结果|然后|居然|突然|我发现|我们|终于|到了|发生/,
  low_info: /^(嗯+|哦+|啊+|哈+|好|行|可以|收到|ok|是|对|在|没有|没事|不知道|？+|\?+)[。!！~～]*$/i,
  media: /^\[(图片|表情包|语音|视频)\]$/,
};

const S = {
  perfunctory: /^(嗯+|哦+|啊+|好|行|可以|收到|ok|是|对|在|没有|没事|哈哈+|？+|\?+)[。!！~～]*$/i,
  media: /^\[(图片|表情包|语音|视频)\]$/,
  empathy: /辛苦|抱抱|理解|我懂|懂你|确实|是啊|心疼|难为|不容易|我也觉得|唉|天呐|太惨|确实.{0,3}啊/,
  care: /吃了没|吃饭了吗|记得吃|吃点|早点睡|早点休息|注意身体|多喝水|喝水|穿多|带伞|路上小心|别熬夜|睡吧|休息吧/,
  advice: /不如|要不|可以试|建议|你应该|先去|记得|别硬撑|不行就|去找|问问|让.{0,4}帮/,
  question: /[?？]|怎么|为什么|然后呢|后来|是谁|哪|几点|多久|啥事|什么事|真的假的|然后/,
  comfort: /没事|别想|会好的|慢慢来|加油|别急|别怕|不至于|放松|别自责/,
  joke: /哈哈|笑死|离谱|绷|草|乐了|绝了|太(搞|逗|乐|好笑|蠢|萌|逆天|上头|邪门|抽象)了|6/,
  self_disclose: /我也|我刚才|我今天|我昨天|我之前|我这边|我上次|我最近|我这|我这人/,
  divert: /^对了|话说|顺便|说起来|换个话题|对了/,
};

/** 意图：先认媒体/寒暄/告别这类强形状，再认问题与情绪；都不中的日常陈述归 share（不是 other——
 *  「对方只是随口说件事」本身就是最常见的一类意图，把它扔进 other 会让桶严重失真）。 */
export function classifyIntent(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'other';
  const bare = t.replace(/\[(图片|表情包|语音|视频)\]/g, '').trim();
  if (!bare) return 'media';
  if (R.greeting.test(bare)) return 'greeting';
  if (R.farewell.test(bare)) return 'farewell';
  if (R.question.test(bare)) return 'question';
  if (R.emotion_vent.test(bare)) return 'emotion_vent';
  if (R.invite.test(bare)) return 'invite';
  if (R.complain_other.test(bare)) return 'complain_other';
  if (R.joke.test(bare)) return 'joke';
  if (R.low_info.test(bare) || [...bare].length <= 2) return 'low_info';
  return 'share';
}

/** 策略：先认「没说什么」的敷衍与媒体，再认共情/关心这类最容易被规则误判的；
 *  剩下的「我在作答/给内容」归 answer——人类回复里最大的一类就是这种，不是 other。 */
export function classifyStrategy(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'other';
  const bare = t.replace(/\[(图片|表情包|语音|视频)\]/g, '').trim();
  if (!bare) return 'media';
  if (S.perfunctory.test(bare)) return 'perfunctory';
  if (S.empathy.test(bare)) return 'empathy';
  if (S.care.test(bare)) return 'care';
  if (S.advice.test(bare)) return 'advice';
  if (S.comfort.test(bare)) return 'comfort';
  if (S.question.test(bare)) return 'question';
  if (S.joke.test(bare)) return 'joke';
  if (S.self_disclose.test(bare)) return 'self_disclose';
  if (S.divert.test(bare)) return 'divert';
  return 'answer';
}

/** 回复长度分桶：1 极短(≤6字) 2 短(7-15) 3 中(16-40) 4 长(>40)。 */
export function lengthBucket(text) {
  const n = [...String(text ?? '')].length;
  if (n <= 6) return 1;
  if (n <= 15) return 2;
  if (n <= 40) return 3;
  return 4;
}

/* ── 导入 ────────────────────────────────────────────────────────────── */
/** 把一批导出 JSON 灌进 corpus.db（同一 peerUin 多份导出按 message id 去重合并）。 */
export function importCorpus({ sources = [], excludePeers = [], relationMap = {}, dbRef = null } = {}) {
  const d = dbRef || db || initCorpus();
  const files = [];
  for (const src of sources) {
    const p = path.resolve(String(src));
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'resources' || e.name === 'backups') continue;
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) walk(fp);
          else if (e.name.toLowerCase().endsWith('.json')) files.push(fp);
        }
      };
      walk(p);
    } else if (p.toLowerCase().endsWith('.json')) {
      files.push(p);
    }
  }
  const banned = new Set(excludePeers.map(String));
  /* 排除名单一旦进过库，旧数据必须清掉——「不参与训练」意味着库里也不该留着。 */
  const purged = [];
  for (const uin of banned) {
    const row = d.prepare('SELECT id FROM corpus_convs WHERE peer_uin = ?').get(uin);
    if (!row) continue;
    d.prepare('DELETE FROM corpus_pairs WHERE conv_id = ?').run(row.id);
    d.prepare('DELETE FROM corpus_units WHERE conv_id = ?').run(row.id);
    d.prepare('DELETE FROM corpus_convs WHERE id = ?').run(row.id);
    purged.push(uin);
  }
  const convs = new Map();
  const skipped = [];
  for (const file of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { skipped.push({ file, why: 'JSON 解析失败' }); continue; }
    const ci = j?.chatInfo;
    if (!ci || !Array.isArray(j.messages)) { skipped.push({ file, why: '不是导出文件（缺 chatInfo/messages）' }); continue; }
    if (ci.type !== 'private') { skipped.push({ file, why: `非私聊（${ci.type}）` }); continue; }
    const uin = String(ci.peerUin || '');
    if (!uin) { skipped.push({ file, why: '缺 peerUin' }); continue; }
    if (banned.has(uin)) { skipped.push({ file, why: `排除名单（${uin}）` }); continue; }
    if (!convs.has(uin)) {
      // 名字优先取对方在自己那边的昵称（导出标题常带「训练数据_」「与…的聊天记录」这种前缀）
      const sender = Array.isArray(j.statistics?.senders)
        ? j.statistics.senders.find((s) => String(s?.uid) === String(ci.peerUid))
        : null;
      const name = String(sender?.name || ci.name || '').replace(/【[^】]*】/g, '').trim();
      convs.set(uin, { uin, name, selfUin: String(ci.selfUin || ''), msgs: new Map(), files: [] });
    }
    const rec = convs.get(uin);
    rec.files.push(path.basename(file));
    for (const m of j.messages) {
      const id = m?.id || `${m?.seq}:${m?.timestamp}`;
      if (!rec.msgs.has(id)) rec.msgs.set(id, m);
    }
  }

  const results = [];
  for (const rec of convs.values()) {
    const messages = [...rec.msgs.values()];
    const blocks = buildBlocks(messages, rec.selfUin);
    const { pairs, units } = buildPairs(blocks);
    const ts = blocks.map((b) => b.ts).filter(Boolean);
    const relation = String(relationMap[rec.uin] ?? '').trim();
    const row = d.prepare('SELECT id FROM corpus_convs WHERE peer_uin = ?').get(rec.uin);
    let convId;
    if (row) {
      convId = Number(row.id);
      d.prepare(`UPDATE corpus_convs SET peer_name=?, relation=?, msg_count=?, pair_count=?, first_ms=?, last_ms=?, src_files=?, imported_at=? WHERE id=?`)
        .run(rec.name, relation, blocks.length, pairs.length, ts.length ? Math.min(...ts) : 0, ts.length ? Math.max(...ts) : 0, JSON.stringify(rec.files), Date.now(), convId);
    } else {
      convId = Number(d.prepare(`INSERT INTO corpus_convs (peer_uin, peer_name, relation, msg_count, pair_count, first_ms, last_ms, src_files, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(rec.uin, rec.name, relation, blocks.length, pairs.length, ts.length ? Math.min(...ts) : 0, ts.length ? Math.max(...ts) : 0, JSON.stringify(rec.files), Date.now()).lastInsertRowid);
    }
    // 重切前先把已打的 LLM 标注按「时间戳+原文」快照下来：新导出只增不改，
    // 同一条样本重导入后仍然对得上，标签继续用，不重复花钱标。
    const keep = new Map();
    for (const r of d.prepare('SELECT peer_text, my_text, peer_ts, my_ts, llm_intent, llm_strategy, llm_model, llm_at FROM corpus_pairs WHERE conv_id = ? AND llm_intent IS NOT NULL').all(convId)) {
      keep.set(`${Number(r.peer_ts)}|${Number(r.my_ts)}|${r.peer_text}|${r.my_text}`, r);
    }
    // 重切：整条会话的 pair / unit 全量重建，避免旧切法残留（去重靠 UNIQUE，但内容会变）
    d.prepare('DELETE FROM corpus_pairs WHERE conv_id = ?').run(convId);
    const ins = d.prepare(`INSERT INTO corpus_pairs (conv_id, seq, peer_text, my_text, peer_ts, my_ts, peer_n, my_n, intent, strategy, resp_len, nsfw, llm_intent, llm_strategy, llm_model, llm_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let seq = 0;
    let kept = 0;
    for (const p of pairs) {
      seq += 1;
      const old = keep.get(`${Number(p.peerTs)}|${Number(p.myTs)}|${p.peerText}|${p.myText}`);
      if (old) kept += 1;
      ins.run(convId, seq, p.peerText, p.myText, p.peerTs, p.myTs, p.peerN, p.myN, classifyIntent(p.peerText), classifyStrategy(p.myText), [...p.myText].length, isNsfw(p.peerText, p.myText) ? 1 : 0,
        old?.llm_intent ?? null, old?.llm_strategy ?? null, old?.llm_model ?? null, old?.llm_at ?? null);
    }
    // 检索单元：一条对方消息 → 我那一整块回复。短刺激才检索得准。
    d.prepare('DELETE FROM corpus_units WHERE conv_id = ?').run(convId);
    const insU = d.prepare(`INSERT OR IGNORE INTO corpus_units (conv_id, stimulus, reply, ts, reply_n, resp_len, nsfw) VALUES (?,?,?,?,?,?,?)`);
    for (const u of units) {
      insU.run(convId, u.stimulus, u.reply, u.ts, u.replyN, [...u.reply].length, isNsfw(u.stimulus, u.reply) ? 1 : 0);
    }
    results.push({ uin: rec.uin, name: rec.name, relation, files: rec.files.length, blocks: blocks.length, pairs: pairs.length, units: units.length, labelsKept: kept });
  }
  results.sort((a, b) => b.pairs - a.pairs);
  const keptTotal = results.reduce((s, r) => s + (r.labelsKept || 0), 0);
  log(`[corpus] 导入完成：${results.length} 个会话 / ${results.reduce((s, r) => s + r.pairs, 0)} 条样本；跳过 ${skipped.length} 个文件${purged.length ? `；按排除名单清掉 ${purged.length} 个会话` : ''}${keptTotal ? `；沿用已有标注 ${keptTotal} 条` : ''}`);
  return { results, skipped, purged };
}

/* ── 统计 ────────────────────────────────────────────────────────────── */
export function corpusStats() {
  const d = db || initCorpus();
  const convs = d.prepare(`SELECT c.*, (SELECT COUNT(*) FROM corpus_pairs p WHERE p.conv_id = c.id AND p.nsfw = 0) AS clean
                          FROM corpus_convs c ORDER BY c.pair_count DESC`).all().map((c) => ({
    id: Number(c.id), uin: c.peer_uin, name: c.peer_name, relation: c.relation,
    blocks: Number(c.msg_count), pairs: Number(c.pair_count), clean: Number(c.clean),
    first: Number(c.first_ms) || 0, last: Number(c.last_ms) || 0,
  }));
  const total = d.prepare('SELECT COUNT(*) AS n FROM corpus_pairs WHERE nsfw = 0').get();
  const nsfw = d.prepare('SELECT COUNT(*) AS n FROM corpus_pairs WHERE nsfw = 1').get();
  const byIntent = d.prepare('SELECT intent, COUNT(*) AS n FROM corpus_pairs WHERE nsfw = 0 GROUP BY intent ORDER BY n DESC').all()
    .map((r) => ({ intent: r.intent, n: Number(r.n) }));
  const byStrategy = d.prepare('SELECT strategy, COUNT(*) AS n FROM corpus_pairs WHERE nsfw = 0 GROUP BY strategy ORDER BY n DESC').all()
    .map((r) => ({ strategy: r.strategy, n: Number(r.n) }));
  return { convs, total: Number(total?.n || 0), nsfw: Number(nsfw?.n || 0), byIntent, byStrategy };
}

/** 某个意图桶里的策略分布（relation 留空 = 全库；给了值就只统计该关系标签）。 */
export function bucketDistribution(intent, { minPairs = 1, relation = '' } = {}) {
  const d = db || initCorpus();
  const rows = relation
    ? d.prepare(`SELECT p.strategy AS s, COUNT(*) AS n FROM corpus_pairs p JOIN corpus_convs c ON c.id = p.conv_id
                 WHERE p.intent = ? AND p.nsfw = 0 AND c.relation = ? GROUP BY s ORDER BY n DESC`).all(intent, relation)
    : d.prepare('SELECT strategy AS s, COUNT(*) AS n FROM corpus_pairs WHERE intent = ? AND nsfw = 0 GROUP BY s ORDER BY n DESC').all(intent);
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  if (total < minPairs) return { intent, total, distribution: [], confident: false };
  return {
    intent, total, confident: true,
    distribution: rows.map((r) => ({ strategy: r.s, n: Number(r.n), pct: Math.round((Number(r.n) / total) * 1000) / 10 })),
  };
}

/** 覆盖率：有多少样本能被词表归到「非 other」的意图上。 */
export function labelCoverage() {
  const d = db || initCorpus();
  const total = Number(d.prepare('SELECT COUNT(*) AS n FROM corpus_pairs WHERE nsfw = 0').get()?.n || 0);
  const other = Number(d.prepare("SELECT COUNT(*) AS n FROM corpus_pairs WHERE nsfw = 0 AND intent IN ('other','')").get()?.n || 0);
  const media = Number(d.prepare("SELECT COUNT(*) AS n FROM corpus_pairs WHERE nsfw = 0 AND intent='media'").get()?.n || 0);
  return { total, other, media, coverage: total ? Math.round(((total - other) / total) * 1000) / 10 : 0 };
}

/* ── 脱敏 ────────────────────────────────────────────────────────────── */
/** 原话只作语气锚：抹掉 @、链接、长数字、QQ 号、邮箱，其余不动（不改语气才有锚定价值）。 */
export function redact(text) {
  const t = String(text ?? '')
    .replace(/@\S+/g, '@某人')
    .replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱]')
    .replace(/\d{5,}/g, '[数字]');
  // 按码点截断：String.slice 会把 emoji 的代理对切成半个，JSON 序列化出去就是非法转义
  return Array.from(t).slice(0, 40).join('');
}

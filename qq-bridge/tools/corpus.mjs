#!/usr/bin/env node
// 联想映射语料工具（2026-10-30）：导入 / 看统计 / 看桶分布。
// 用法：
//   node tools/corpus.mjs import            # 按 config.json 的 social.associative.sources 导入
//   node tools/corpus.mjs stats             # 会话与标签总览
//   node tools/corpus.mjs buckets [min]     # 每个意图桶的策略分布（min = 最小样本量，默认 30）
// 隐私：只打印计数与分布；不打印原话（要看原话自己开 corpus.db）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.QQB_HOME = ROOT;
process.chdir(ROOT);

const corpus = await import('../src/core/corpus.js');

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; }
}

const cfg = loadCfg();
const aCfg = cfg?.social?.associative ?? {};
const cmd = String(process.argv[2] || 'stats').toLowerCase();

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length));

if (cmd === 'import') {
  const sources = Array.isArray(aCfg.sources) && aCfg.sources.length
    ? aCfg.sources
    : ['D:/QQChatExporter'];
  const r = corpus.importCorpus({
    sources,
    excludePeers: Array.isArray(aCfg.excludePeers) ? aCfg.excludePeers : [],
    relationMap: aCfg.relationMap && typeof aCfg.relationMap === 'object' ? aCfg.relationMap : {},
  });
  console.log('\n会话                文件  轮块    样本');
  for (const x of r.results) console.log(pad(x.name, 20), pad(x.files, 5), pad(x.blocks, 7), x.pairs);
  if (r.skipped.length) {
    console.log('\n跳过：');
    for (const s of r.skipped) console.log('  ', path.basename(s.file), '—', s.why);
  }
  console.log('\n合计样本：', r.results.reduce((a, b) => a + b.pairs, 0));
  corpus.closeCorpus();
} else if (cmd === 'stats') {
  corpus.initCorpus();
  const s = corpus.corpusStats();
  const cov = corpus.labelCoverage();
  console.log('\n会话                关系    样本(净)');
  for (const c of s.convs) console.log(pad(c.name, 20), pad(c.relation || '（未标）', 8), c.clean + '/' + c.pairs);
  console.log('\n净样本：', s.total, '｜已挡 NSFW：', s.nsfw, '｜可归桶：', cov.coverage + '%', '｜未归桶(other)：', cov.other);
  console.log('\n意图分布：');
  for (const x of s.byIntent) console.log('  ', pad(x.intent, 16), x.n, `(${(x.n / Math.max(1, s.total) * 100).toFixed(1)}%)`);
  console.log('\n策略分布：');
  for (const x of s.byStrategy) console.log('  ', pad(x.strategy, 16), x.n, `(${(x.n / Math.max(1, s.total) * 100).toFixed(1)}%)`);
  corpus.closeCorpus();
} else if (cmd === 'buckets') {
  const min = Number(process.argv[3]) || 30;
  corpus.initCorpus();
  const s = corpus.corpusStats();
  console.log(`\n每个意图桶的策略分布（样本量 ≥ ${min} 才展示）\n`);
  for (const it of s.byIntent) {
    const b = corpus.bucketDistribution(it.intent, { minPairs: min });
    if (!b.confident) { console.log(`${pad(it.intent, 16)} 样本 ${it.n} —— 不足 ${min}，跳过`); continue; }
    const top = b.distribution.map((d) => `${d.strategy} ${d.pct}%`).join('  ');
    console.log(`${pad(it.intent, 16)} n=${pad(it.n, 6)} ${top}`);
  }
  corpus.closeCorpus();
} else if (cmd === 'try' || cmd === 'hint') {
  const q = process.argv.slice(3).join(' ').trim();
  if (!q) { console.log('用法：node tools/corpus.mjs try "感觉今天好累"'); process.exit(1); }
  const assoc = await import('../src/core/associative.js');
  corpus.initCorpus();
  const r = assoc.associate(q, { k: 24, sampleExcludePeers: Array.isArray(aCfg.sampleExcludePeers) ? aCfg.sampleExcludePeers : [] });
  if (!r.matches) { console.log(`「${q}」没有足够相似的历史对（覆盖率 ≥50% 且分数 ≥0.12）`); process.exit(0); }
  console.log(`\n查询：「${q}」 → 命中 ${r.matches} 条相似历史\n`);
  console.log('人类回应分布：', r.distribution.map((d) => `${d.strategy} ${d.pct}%`).join('  '));
  console.log(`形态：平均 ${r.stats.avgLen} 字 ｜ 提问 ${r.stats.questionShare}% ｜ 发表情/图 ${r.stats.stickerShare}% ｜ 长度桶 ${JSON.stringify(r.stats.lenBuckets)}`);
  console.log('\n原话锚点（脱敏）：');
  for (const s of r.samples) console.log(`  [${s.conv} 分${s.score}/覆盖${s.coverage}] 对方「${s.stimulus}」→ 我「${s.text}」`);
  if (cmd === 'hint') {
    console.log('\n注入形态预览：');
    console.log(assoc.associativeHint(q, { enabled: true, minMatches: 6, maxSamples: 2, maxChars: 180 }));
  }
  corpus.closeCorpus();
} else if (cmd === 'label') {
  const limitArg = process.argv.indexOf('--limit');
  const convArg = process.argv.indexOf('--conv');
  const dry = process.argv.includes('--dry');
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 0;
  const convUin = convArg > 0 ? String(process.argv[convArg + 1]) : '';
  const label = await import('../src/core/corpus-label.js');
  corpus.initCorpus();
  const r = await label.labelCorpus(cfg, { limit: limit || undefined, convUin: convUin || undefined, dry });
  if (r.dry) {
    console.log('\n待标注：', r.pending, '条；本次预览', r.sampleCount, '条；模型', r.model, '\n');
    console.log(r.prompt);
  } else {
    console.log('\n标注结果：成功', r.labeled, '｜失败', r.failed, '｜批次', r.batches, '｜tokens', r.tokens, '｜耗时', (r.ms / 1000).toFixed(0) + 's');
    const s = label.llmStats();
    console.log('\n会话            关系        已标/总');
    for (const c of s.byConv) console.log(pad(c.peer_name, 16), pad(c.relation || '（未标）', 10), c.done + '/' + c.n);
    console.log('\n意图分布：');
    for (const x of s.byIntent) console.log('  ', pad(x.i, 16), x.n);
  }
  corpus.closeCorpus();
} else {
  console.log('用法：node tools/corpus.mjs [import|stats|buckets [min]|try "文本"|hint "文本"|label [--limit N] [--conv UIN] [--dry]]');
}

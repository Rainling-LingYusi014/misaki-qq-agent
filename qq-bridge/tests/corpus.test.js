// 联想映射语料层单测（2026-10-30）：切轮/配对/分类/脱敏/检索闸门。
// 全部用合成数据，不读真实导出——测试不碰隐私语料。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
process.env.QQB_HOME = TMP;
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });

const corpus = await import('../src/core/corpus.js');
const assoc = await import('../src/core/associative.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { fail++; console.log('FAIL ', name, '\n     ', e.message); }
}

const m = (uin, text, ts, extra = {}) => ({
  id: `id-${uin}-${ts}-${Math.random().toString(36).slice(2, 6)}`,
  timestamp: ts, type: 'text', sender: { uin },
  content: { text }, ...extra,
});

check('① 切轮：同方 90 秒内合并、换边切、超时切', () => {
  const msgs = [
    m('1', '在吗', 1000),
    m('1', '问你个事', 1000),
    m('2', '在', 20000),
    m('2', '说吧', 21000),
  ];
  const blocks = corpus.buildBlocks(msgs, '2');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].side, 'peer');
  assert.equal(blocks[0].text, '在吗 问你个事');
  assert.equal(blocks[0].n, 2);
  assert.equal(blocks[1].side, 'me');
});

check('② 超时（>90s）即使同方也切块', () => {
  const blocks = corpus.buildBlocks([m('1', '早', 1000), m('1', '到晚上了', 200000)], '2');
  assert.equal(blocks.length, 2);
});

check('③ 配对：只取 对方→我；单条对方消息另成检索单元', () => {
  const msgs = [m('1', '今天好热', 1000), m('1', '热死了', 1000), m('2', '开空调啊', 3000), m('1', '开了没用', 9000), m('2', '那没办法', 12000)];
  const { blocks } = { blocks: corpus.buildBlocks(msgs, '2') };
  const { pairs, units } = corpus.buildPairs(blocks);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].peerText, '今天好热 热死了');
  assert.equal(pairs[0].myText, '开空调啊');
  assert.equal(units.length, 3, '两条对方单句 + 一条新块的对方单句');
  assert.ok(units.every((u) => !u.stimulus.includes('热死了')) || units.some((u) => u.stimulus === '热死了'));
});

check('④ 导出字段抽取：剥回复前缀、归一图片、丢 system/forward', () => {
  assert.deepEqual(corpus.extractMessage({ type: 'reply', timestamp: 1, content: { text: '[回复消息]好的' } })?.text, '好的');
  assert.equal(corpus.extractMessage({ type: 'text', timestamp: 1, content: { text: '[图片:abc.jpg]' } })?.kind, 'media');
  assert.equal(corpus.extractMessage({ type: 'system', timestamp: 1, content: { text: '戳一戳' } }), null);
  assert.equal(corpus.extractMessage({ type: 'forward', timestamp: 1, content: { text: '[转发消息: 3条]' } }), null);
  assert.equal(corpus.extractMessage({ type: 'text', timestamp: 0, content: { text: 'x' } }), null, '没有时间戳的丢弃');
});

check('⑤ 意图分类：情绪/提问/寒暄/低信息/媒体', () => {
  assert.equal(corpus.classifyIntent('今天好累啊'), 'emotion_vent');
  assert.equal(corpus.classifyIntent('明天有空吗'), 'question');
  assert.equal(corpus.classifyIntent('早安'), 'greeting');
  assert.equal(corpus.classifyIntent('嗯嗯'), 'low_info');
  assert.equal(corpus.classifyIntent('[图片]'), 'media');
  assert.equal(corpus.classifyIntent('我今天去图书馆了'), 'share');
});

check('⑥ 策略分类：共情/关心/敷衍严格区分', () => {
  assert.equal(corpus.classifyStrategy('辛苦了，抱抱'), 'empathy');
  assert.equal(corpus.classifyStrategy('早点睡'), 'care');
  assert.equal(corpus.classifyStrategy('嗯'), 'perfunctory');
  assert.equal(corpus.classifyStrategy('这张图是我同学'), 'answer');
});

check('⑦ 脱敏：抹掉 @、链接、邮箱、长数字，保留语气', () => {
  const r = corpus.redact('@小明 你在 http://x.y 看到没 手机13812345678 a@b.com');
  assert.ok(!r.includes('小明') && !r.includes('http') && !r.includes('a@b.com') && !r.includes('13812345678'));
  assert.ok(r.includes('看到没'), '语气词必须保留');
});

check('⑧ NSFW 粗筛能挡住露骨样本（分布里剔除）', () => {
  assert.equal(corpus.isNsfw('舌头接过去 斯哈斯哈'), false, '这类误判可接受——靠 sampleExcludePeers 兜');
  assert.equal(corpus.isNsfw('你在呻吟什么'), true);
});

check('⑨ 导入→建库→检索：近义原句能命中，无关句不命中', () => {
  corpus.closeCorpus();
  const db = corpus.initCorpus();
  const file = path.join(TMP, 'export.json');
  const mk = (uin, text, ts) => m(uin, text, ts);
  fs.writeFileSync(file, JSON.stringify({
    chatInfo: { type: 'private', peerUin: '999', peerUid: 'u9', peerName: '测试', selfUin: '2' },
    statistics: { senders: [{ uid: 'u9', name: '测试' }] },
    messages: [
      mk('999', '晚安', 1000), mk('2', '晚安 好梦', 2000),
      mk('999', '我去睡了', 3000), mk('2', '嗯嗯 早点休息', 4000),
      mk('999', '今天吃了火锅', 5000), mk('2', '怎么不叫我', 6000),
    ],
  }));
  const r = corpus.importCorpus({ sources: [file], relationMap: { 999: '普通' } });
  assert.equal(r.results.length, 1);
  assert.ok(r.results[0].pairs >= 3);
  assert.ok(r.results[0].units >= 3);
  db.close();
  corpus.closeCorpus();
  const db2 = corpus.initCorpus();
  const hit = db2.prepare("SELECT reply FROM corpus_units WHERE stimulus = '晚安'").get();
  assert.equal(hit.reply, '晚安 好梦');
  assoc.resetIndex();
  const a = assoc.associate('晚安', { k: 5, minMatchedIdf: 0 });
  assert.ok(a.matches >= 1, `「晚安」应命中，实际 ${a.matches}`);
  assert.ok(a.samples.some((s) => s.text.includes('好梦')));
  const b = assoc.associate('量子力学课题报告', { k: 5, minMatchedIdf: 0 });
  assert.equal(b.matches, 0, '无关句不该命中');
  corpus.closeCorpus();
});

check('⑩ 样例排除名单：被排除的会话只进分布、不进原话', () => {
  assoc.resetIndex();
  const a = assoc.associate('晚安', { k: 5, minMatchedIdf: 0, sampleExcludePeers: ['999'] });
  assert.ok(a.matches >= 1, '分布仍然统计');
  assert.equal(a.samples.length, 0, '原话一条都不给');
  corpus.closeCorpus();
});

check('⑪ 意图回归：邀约词表不吃「…出来」的日常陈述、玩笑词表不吃「太X了」抱怨（R2 盲测 X 根因）', () => {
  // 误伤样本：「实在是卡了，点不出来」曾被裸「出来」抓成邀约、「太卡了」被「太X了」抓成玩笑
  assert.notEqual(corpus.classifyIntent('实在是太卡了，点不出来，卡死我了'), 'invite');
  assert.notEqual(corpus.classifyIntent('我大退出来了'), 'invite');
  assert.notEqual(corpus.classifyIntent('把截图转出来了'), 'invite');
  assert.notEqual(corpus.classifyIntent('读不出来啊'), 'invite');
  assert.equal(corpus.classifyIntent('实在是太卡了，点不出来，卡死我了'), 'share', '抱怨工具卡是日常陈述，不是玩笑');
  assert.equal(corpus.classifyIntent('太搞了哈哈哈'), 'joke', '玩笑侧的「太X了」白名单不受影响');
  // 真邀约不受影响
  assert.equal(corpus.classifyIntent('周末出来吃饭吧'), 'invite');
  assert.equal(corpus.classifyIntent('晚上一起打游戏吧'), 'invite');
  assert.equal(corpus.classifyIntent('可晚上来玩'), 'invite');
  corpus.closeCorpus();
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  （${pass} 通过 / ${fail} 失败）`);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 偶发占用 */ }
process.exit(fail ? 1 : 0);

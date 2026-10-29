// 回归测试：一句话落成几个气泡（2026-10-28 定规，2026-10-29 改为骰子分配）
//
// 主人定的终局：一句话 1 / 2 / 3 个气泡，概率 70% / 25% / 5%，最多三个。
//   「先前是被拆成1~2个气泡，一句话用两个气泡来发是被准许的，现在矫枉过正得到的结果是：
//     我一句话，非得用两个气泡来发才行」——所以条数不能由习惯决定，必须由骰子决定。
//
// 这个文件守四件事：分布对、同句稳定（幂等账本）、拼回原文不丢字、长句不许整条发。
//
// 用法：node tests/bubble-split.test.js
import assert from 'node:assert/strict';
import { shapeBubbles, joinBubbles, rollBubbleCount, findCuts, BUBBLE_ODDS } from '../src/lib/bubble-split.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const LIVE = '查东西、跑工具、给你成品这些都不做，不给你解决方案也不挑你毛病，你说什么我就接着。想吐槽或者就是心烦的时候用它';
const TWO = '我看了下那个稿子问题还挺多的，主要是开头太绕。你要是想听我就具体说说，不想听就当我没提';
const THREE = '稿子我看了，开头太绕。中间那两段可以留着，往后挪一挪就行。结尾那句得重写';

console.log('== 气泡成形 ==');

t('比例就是 70/25/5（2000 句的长期分布）', () => {
  const need = [[], [], []];
  for (let i = 0; i < 2000; i++) need[rollBubbleCount(`第${i}句话，落成几个气泡呢`) - 1].push(i);
  const [one, two, three] = need.map((x) => x.length);
  assert.ok(one > 1300 && one < 1500, `1 条应约 70%，实得 ${one}/2000`);
  assert.ok(two > 420 && two < 580, `2 条应约 25%，实得 ${two}/2000`);
  assert.ok(three > 60 && three < 140, `3 条应约 5%，实得 ${three}/2000`);
});

t('同一句话永远是同一个条数（幂等账本靠这个）', () => {
  const a = rollBubbleCount(TWO);
  const b = rollBubbleCount(TWO);
  assert.equal(a, b);
  const s1 = shapeBubbles([TWO]);
  const s2 = shapeBubbles([TWO]);
  assert.deepEqual(s1.bubbles, s2.bubbles);
});

t('短句永远一条（拆不动的东西不硬拆）', () => {
  for (const s of ['嗯', '在的', '知道了～', '好呀', '在的，拍我干嘛呢']) {
    const r = shapeBubbles([s]);
    assert.equal(r.count, 1, `${s} 应一条，实得 ${r.count}`);
    assert.deepEqual(r.bubbles, [s]);
  }
});

t('模型给多条时先拼回一句：没标点就补「，」，已有标点不重复补', () => {
  assert.equal(joinBubbles(['在的啊', '你说']), '在的啊，你说');
  assert.equal(joinBubbles(['好呀。', '我这就去']), '好呀。我这就去');
  assert.equal(joinBubbles(['好呀，', '我这就去']), '好呀，我这就去');
});

t('骰子说一条时，模型给的两条会合并（这是治「一句话必两条」的闸）', () => {
  // 用 odds 把骰子钉死在 1 条
  const r = shapeBubbles(['在的啊', '你说'], { odds: [1, 0, 0] });
  assert.equal(r.rolled, 1);
  assert.deepEqual(r.bubbles, ['在的啊，你说']);
});

t('骰子说两条时，一句话在标点后切开，拼回去不丢字', () => {
  const r = shapeBubbles([TWO], { odds: [0, 1, 0] });
  assert.equal(r.count, 2, `应 2 条，实得 ${JSON.stringify(r.bubbles)}`);
  assert.equal(r.bubbles.join(''), TWO);
  assert.ok(/[。！？!?…]$/.test(r.bubbles[0]), `第一条应停在句末标点：${r.bubbles[0]}`);
});

t('骰子说三条时切成三条，内容一个字不丢', () => {
  const r = shapeBubbles([THREE], { odds: [0, 0, 1] });
  assert.equal(r.count, 3, `应 3 条，实得 ${JSON.stringify(r.bubbles)}`);
  // 在「，」处切开的那个逗号会被切口吃掉（气泡不以逗号收尾），内容本身不能丢
  assert.equal(r.bubbles.join('').replace(/，/g, ''), THREE.replace(/，/g, ''), '拼回去必须等于原句（除切口逗号）');
  for (const b of r.bubbles) assert.ok(b.length >= 4, `碎片太短：${b}`);
});

t('切在逗号处时，前一条不带尾逗号', () => {
  const text = '知道了～我就是随口一问，你别当回事，早点睡吧';
  const r = shapeBubbles([text], { odds: [0, 1, 0] });
  assert.equal(r.count, 2);
  for (const b of r.bubbles) assert.ok(!/[，,]$/.test(b), `气泡不该以逗号收尾：${b}`);
});

t('最多三个：再长的句子也只切三片', () => {
  const longText = '第一句话在这里。第二句话在那里。第三句话在别处。第四句话补在后面。第五句收尾';
  for (const p of [[0, 0, 1], [0, 0.5, 0.5], [1, 0, 0]]) {
    const r = shapeBubbles([longText], { odds: p });
    assert.ok(r.count <= 3, `超过三条：${r.count}`);
  }
});

t('句子边界优先于逗号', () => {
  const text = '开头这句有点绕，得改一下。后面那段没问题';
  const cuts = findCuts(text, { allowComma: true });
  const picked = shapeBubbles([text], { odds: [0, 1, 0] });
  assert.equal(picked.count, 2);
  assert.ok(picked.bubbles[0].endsWith('。'), `应在句号后切：${JSON.stringify(picked.bubbles)}`);
  assert.ok(cuts.some((c) => c.strong), '句末切点应存在');
});

t('「、」永远不是切点（并列切了就断意）', () => {
  const text = '苹果、香蕉、橘子、葡萄、西瓜、桃子和李子都买了';
  assert.ok(!findCuts(text, { allowComma: true }).some((c) => text[c.at - 1] === '、'));
});

t('长句不许整条发：过 wall（40 字）至少两条', () => {
  assert.ok(LIVE.length > 40, `样例应超过 40 字：${LIVE.length}`);
  const r = shapeBubbles([LIVE], { odds: [1, 0, 0] });
  assert.ok(r.count >= 2, `超过 40 字还整条发了：${JSON.stringify(r.bubbles)}`);
});

t('关闭开关时原样放行（管理端可以一键关掉）', () => {
  const input = ['在的啊', '你说'];
  const r = shapeBubbles(input, { enabled: false });
  assert.deepEqual(r.bubbles, input);
  assert.equal(r.count, 2);
});

t('比例可配置：给 0/1/0 就永远两条', () => {
  assert.deepEqual(BUBBLE_ODDS, [0.7, 0.25, 0.05]);
  for (let i = 0; i < 20; i++) {
    const r = shapeBubbles([`第${i}句，带逗号的话，够长到能切开`], { odds: [0, 1, 0] });
    assert.equal(r.rolled, 2);
  }
});

t('代码块/多行正文不重排（原样放行，别把结构切坏）', () => {
  const code = ['给你写好了：', '```js', 'const a = 1, b = 2;', '```'];
  const r = shapeBubbles(code, { odds: [0, 0, 1] });
  assert.deepEqual(r.bubbles, code);
});

// ── 2026-10-29 修的三处 ─────────────────────────────────────────────
t('～ 是切点：骰子要两条时在 ～ 后断开，且不吞掉它', () => {
  const r = shapeBubbles(['知道的～你说吧'], { odds: [0, 1, 0] });
  assert.equal(r.count, 2, JSON.stringify(r.bubbles));
  assert.ok(r.bubbles[0].endsWith('～'), `第一条应保留 ～：${r.bubbles[0]}`);
  assert.equal(r.bubbles.join(''), '知道的～你说吧');
});

t('三条切不开时退两条，不是整条 1 条', () => {
  const text = '今天天气真不错，去走走，顺便买点水果';
  const r = shapeBubbles([text], { odds: [0, 0, 1] });
  assert.ok(r.count >= 2, `骰子给 3、切不开时至少两条，实得 ${r.count}`);
  assert.equal(r.bubbles.join('').replace(/，/g, ''), text.replace(/，/g, ''));
});

t('成形后的碎片一律不超过 500 字（6×500 的合并也压得住）', () => {
  let s = '';
  let i = 0;
  while (s.length < 500) { s += `第${i}句说一下，后面的内容也要讲清楚。`; i += 1; }
  s = s.slice(0, 500);
  const r = shapeBubbles(Array(6).fill(s), { odds: [1, 0, 0] });
  for (const b of r.bubbles) assert.ok(b.length <= 500, `有碎片 ${b.length} 字，超过上限`);
});

t('单条偏好（某位联系人抱怨过被切碎）：整段一条，不掷骰不设墙', () => {
  const text = '这个问题我看了，主要是配置没生效。你把新加的那段贴给我，我照着你的实际值说，省得来回猜';
  for (const odds of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const r = shapeBubbles([text], { mode: 'single', odds });
    assert.equal(r.count, 1, `single 模式下不该拆：${JSON.stringify(r.bubbles)}`);
    assert.equal(r.bubbles[0], text);
  }
  // 模型自己分了两条，也要并回一条
  const merged = shapeBubbles(['这个问题我看了', '主要是配置没生效'], { mode: 'single' });
  assert.equal(merged.count, 1);
});

t('单条偏好不影响别人：auto 模式仍按骰子走', () => {
  const text = '这个问题我看了，主要是配置没生效';
  const auto = shapeBubbles([text], { mode: 'auto', odds: [0, 1, 0] });
  assert.equal(auto.count, 2);
});

t('单条偏好遇到超长文本仍然按上限切（不会发出 500 字以上）', () => {
  const long = '说'.repeat(1200);
  const r = shapeBubbles([long], { mode: 'single', maxChars: 500 });
  for (const b of r.bubbles) assert.ok(b.length <= 500, `超限：${b.length}`);
  assert.ok(r.count >= 3);
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

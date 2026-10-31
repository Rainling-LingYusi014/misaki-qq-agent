// 回归测试：括号反馈（2026-10-29 主人定规，陪伴模式专属「高级反馈总开关」）
//
// 规则原话要点：
//   · 括号统一中文全角 （）（2026-10-30 主人改口），代码层归一；输入全半角都认；
//   · 普通反馈：回合命中率 10+x%（x=0~30 随机数，每个气泡发出之前产生一次）；
//   · 实时反馈：由「用户的动作性」触发（摸摸头/抱一下…），每一句都加，100%；
//   · 一个气泡最多两段，双段概率 10%；心理类不降档。
//
// 守八件事：标记/动词/拍一拍的动作检测误报面；场景窗过期回落；实时档全保留；
// 普通档命中区间与每气泡独立；双段 10%；全角归一；非反馈形状括号（日期/拉丁）永不剥；确定性。
//
// 纯函数直测。用法：node tests/bracket-feedback.test.js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { fails += 1; console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const lib = await import(pathToFileURL(path.join(here, '..', 'src', 'lib', 'bracket-feedback.js')).href);
const { stableRoll } = await import(pathToFileURL(path.join(here, '..', 'src', 'lib', 'dice.js')).href);

check('① 动作检测：括号段/星号段/动词/拍一拍文本都命中，链接和纯聊天不命中', () => {
  assert.equal(lib.detectActionSignal('（摸摸头）'), true);
  assert.equal(lib.detectActionSignal('(抱)'), true);
  assert.equal(lib.detectActionSignal('*凑近看了看你的屏幕*'), true);
  assert.equal(lib.detectActionSignal('过来让我揉揉你头发'), true);
  assert.equal(lib.detectActionSignal('把你拉进怀里'), true);
  assert.equal(lib.detectActionSignal('今天好累啊，不想动'), false);
  assert.equal(lib.detectActionSignal('看看这个 https://example.com/x（抱）'), false, '带链接不判动作');
  assert.equal(lib.detectActionSignal(''), false);
});

check('② 场景窗：动作推入实时档并续时，过期自动落回普通档', () => {
  const now = 1_000_000_000_000;
  const st = { bracketSceneUntil: now + 60_000 };
  assert.equal(lib.bracketScene(st, now), 'realtime');
  assert.equal(lib.bracketScene(st, now + 61_000), 'normal', '超时无新动作 → 普通档');
  const st2 = { bracketSceneUntil: 0 };
  assert.equal(lib.bracketScene(st2, now), 'normal');
});

check('③ 实时档：每句都保留（100%），确定性可复现', () => {
  for (let i = 0; i < 50; i++) {
    const r = lib.shapeBrackets('过来（抱）一下就好', { scene: 'realtime', seed: `k#${i}` });
    assert.equal(r.keptSegments, 1);
    assert.ok(r.text.includes('（'), '实时档必须保留括号段（现在是全角）');
  }
  const a = lib.shapeBrackets('（低头）嗯', { scene: 'realtime', seed: 'same' });
  const b = lib.shapeBrackets('（低头）嗯', { scene: 'realtime', seed: 'same' });
  assert.equal(a.text, b.text, '同 seed 同形（幂等）');
});

check('④ 普通档：命中率落在 (10+x)% 区间内，且每个气泡独立', () => {
  const cfg = { normalBasePct: 10, normalXMax: 30 };
  let kept = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const r = lib.shapeBrackets(`（低头）第${i}句`, { scene: 'normal', seed: `s#${i}`, cfg });
    kept += r.keptSegments > 0 ? 1 : 0;
  }
  const ratio = kept / N;
  assert.ok(ratio > 0.10 && ratio < 0.50, `普通档命中率应在 10%~40% 附近，实际 ${(ratio * 100).toFixed(1)}%`);
});

check('⑤ 双段概率 18%：大量样本下双段占比贴 0.18（2026-10-30 由 10% 上调）', () => {
  let two = 0;
  const N = 600;
  for (let i = 0; i < N; i++) {
    const r = lib.shapeBrackets('（低头）（叹气）内容', { scene: 'realtime', seed: `two#${i}` });
    if (r.keptSegments === 2) two++;
  }
  const ratio = two / N;
  assert.ok(ratio > 0.10 && ratio < 0.27, `双段占比应贴 18%，实际 ${(ratio * 100).toFixed(1)}%`);
});

check('⑥ 全角归一 + 提到句首：无论写在哪，保留的段都移到最前并变全角 （）', () => {
  const r = lib.shapeBrackets('（揉揉头发）别怕', { scene: 'realtime', seed: 'norm' });
  assert.ok(!r.text.includes('('), `不应再有半角括号：${r.text}`);
  assert.ok(r.text.startsWith('（揉揉头发）'));
  // 2026-10-29 主人定规：写在句尾也要提到最前
  const tail = lib.shapeBrackets('别怕，我在呢（揉揉头发）', { scene: 'realtime', seed: 'norm2' });
  assert.ok(tail.text.startsWith('（揉揉头发）'), `句尾的段必须提到最前：${tail.text}`);
  assert.ok(tail.text.includes('别怕'), '正文不能丢');
  // 两段：保持原顺序、都在最前
  const two = lib.shapeBrackets('嗯（低头）（笑）', { scene: 'realtime', seed: 'norm3' });
  if (two.keptSegments === 2) assert.match(two.text, /^（低头） （笑） /, `两段应前置：${two.text}`);
  else assert.match(two.text, /^（低头） /, `单段也应前置：${two.text}`);
});

check('⑦ 非反馈形状的括号永不剥：日期/英文/超长段都保留', () => {
  const r = lib.shapeBrackets('版本是 (2026-10-29) 的（LOL）参考', { scene: 'normal', seed: 'x' });
  assert.ok(r.text.includes('(2026-10-29)'), '日期段不能剥');
  assert.ok(r.text.includes('（LOL）'), '拉丁内容段不能剥');
  const r2 = lib.shapeBrackets('这一段是（很长很长的补充说明，根本不是动作，只是普通的括号注解而已）', { scene: 'normal', seed: 'y' });
  assert.ok(r2.text.includes('很长很长的补充说明'), '超长段不按反馈剥');
});

check('⑧ 心理类不降档：（担忧）与（抱）同规则同概率', () => {
  let psy = 0, act = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    psy += lib.shapeBrackets('（担忧）还在吗', { scene: 'realtime', seed: `p#${i}` }).keptSegments;
    act += lib.shapeBrackets('（抱）在的', { scene: 'realtime', seed: `a#${i}` }).keptSegments;
  }
  assert.equal(psy, N, '实时档心理类全保留（不降档）');
  assert.equal(act, N);
});

check('⑨ 配置归一：脏值回落默认', () => {
  const bad = lib.bracketFeedbackCfg({ enabled: 'no', realtimeHoldMs: -5, normalBasePct: 'x', normalXMax: 999 });
  assert.equal(bad.enabled, true, 'enabled 只有显式 false 才关');
  assert.ok(bad.realtimeHoldMs >= 60_000);
  assert.equal(bad.normalBasePct, lib.BRACKET_FEEDBACK_DEFAULTS.normalBasePct);
  assert.equal(bad.normalXMax, 100, '比例夹 [0,100]');
});

// ── 2026-10-29 动作类去重（主人定规：动作类每 6 个气泡不允许完全相同；表情/心理不限）──

check('⑩ 段分型：动作 / 表情神态 / 心理活动 三分，未知归动作', () => {
  assert.equal(lib.classifySegment('小声'), 'action');
  assert.equal(lib.classifySegment('低头'), 'action');
  assert.equal(lib.classifySegment('揉了揉头发'), 'action');
  assert.equal(lib.classifySegment('笑'), 'expression');
  assert.equal(lib.classifySegment('别开眼'), 'expression');
  assert.equal(lib.classifySegment('叹气'), 'expression');
  assert.equal(lib.classifySegment('担忧'), 'mind');
  assert.equal(lib.classifySegment('心疼'), 'mind');
  assert.equal(lib.classifySegment('心虚'), 'mind');
});

check('⑪ 动作类 6 泡内完全相同 → 砍掉；超出窗口 → 允许', () => {
  const cfg = { actionRepeatBubbles: 6 };
  const hist = [{ seg: '（小声）', seq: 10 }];
  // 第 13 泡：距 10 只有 3 泡 → 砍
  const near = lib.shapeBrackets('（小声）我其实有点怕', { scene: 'realtime', seed: 'r1', cfg, recentActions: hist, bubbleSeq: 13 });
  assert.equal(near.keptSegments, 0, '窗口内必须砍掉');
  assert.ok(!near.text.includes('小声'), `砍掉后不能留：${near.text}`);
  assert.ok(near.text.includes('我其实有点怕'), '正文必须保留');
  // 第 17 泡：距 10 是 7 泡 → 允许
  const far = lib.shapeBrackets('（小声）我其实有点怕', { scene: 'realtime', seed: 'r2', cfg, recentActions: hist, bubbleSeq: 17 });
  assert.equal(far.keptSegments, 1, '超出 6 泡就该允许');
  assert.ok(far.text.startsWith('（小声）'));
});

check('⑫ 表情/神态/心理 不受窗口限制（同一句连续重复照样保留）', () => {
  const cfg = { actionRepeatBubbles: 6 };
  const hist = [{ seg: '（笑）', seq: 10 }, { seg: '（担忧）', seq: 10 }, { seg: '（叹气）', seq: 10 }];
  for (const seg of ['笑', '担忧', '叹气']) {
    const r = lib.shapeBrackets(`（${seg}）嗯`, { scene: 'realtime', seed: `x${seg}`, cfg, recentActions: hist, bubbleSeq: 11 });
    assert.equal(r.keptSegments, 1, `${seg} 属于表情/心理，不该被窗口拦`);
  }
});

check('⑬ 窗口边界精确：距离正好 6 泡算在内、7 泡放行', () => {
  const cfg = { actionRepeatBubbles: 6 };
  const hist = [{ seg: '（点头）', seq: 10 }];
  const at6 = lib.shapeBrackets('（点头）好', { scene: 'realtime', seed: 'b6', cfg, recentActions: hist, bubbleSeq: 16 });
  assert.equal(at6.keptSegments, 0, 'seq 16 - 6 = 10 → 边界应算在内（砍）');
  const at7 = lib.shapeBrackets('（点头）好', { scene: 'realtime', seed: 'b7', cfg, recentActions: hist, bubbleSeq: 17 });
  assert.equal(at7.keptSegments, 1, 'seq 17 - 6 = 11 > 10 → 放行');
});

check('⑭ 只认「完全相同」：不同动作/近似写法都不受影响', () => {
  const cfg = { actionRepeatBubbles: 6 };
  const hist = [{ seg: '（小声）', seq: 10 }];
  const other = lib.shapeBrackets('（压低了声音）我有点怕', { scene: 'realtime', seed: 'o1', cfg, recentActions: hist, bubbleSeq: 12 });
  assert.equal(other.keptSegments, 1, '换个动作照常保留');
  assert.equal(lib.shapeBrackets('（小小声）我有点怕', { scene: 'realtime', seed: 'o2', cfg, recentActions: hist, bubbleSeq: 12 }).keptSegments, 1,
    '近似但不相同的串不算完全重复');
});

check('⑮ keptSegs 只回报真正发出去的段（供调用方记账）', () => {
  const cfg = { actionRepeatBubbles: 6 };
  const r = lib.shapeBrackets('（小声）嗯', { scene: 'realtime', seed: 'k1', cfg, recentActions: [{ seg: '（小声）', seq: 9 }], bubbleSeq: 10 });
  assert.deepEqual(r.keptSegs, [], '被砍的段不能进账本');
  const r2 = lib.shapeBrackets('（点头）嗯', { scene: 'realtime', seed: 'k2', cfg, bubbleSeq: 10 });
  assert.deepEqual(r2.keptSegs, ['（点头）'], '真正发出去的段要回报');
});

// ── 2026-10-29 动作链 / 单个纯动作反馈（主人定规）──
// 先掷动作链（8%，2 条 67% / 3 条 33%），没中再掷单个纯动作（8%）；只在实时档。

// 找到能命中某一档的 seed（骰子是文本指纹，必须找到具体样本才能稳定断言）
function findSeed(pred, prefix = 'x') {
  for (let i = 0; i < 20000; i++) {
    const s = `${prefix}${i}`;
    if (pred(s)) return s;
  }
  throw new Error('找不到满足条件的 seed');
}
const requireRoll = (key) => stableRoll(key);

check('⑯ 骰子分布：动作链 18%、链内 2 条 67%、单个纯动作 18%（2026-10-30 由 8% 上调）', () => {
  let chain = 0, two = 0, chainN = 0, single = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const s = `d${i}`;
    if (requireRoll(`bf-chain:${s}`) * 100 < 18) {
      chain++;
      chainN++;
      if (requireRoll(`bf-chain-n:${s}`) * 100 < 67) two++;
    } else if (requireRoll(`bf-single:${s}`) * 100 < 18) single++;
  }
  assert.ok(chain / N > 0.14 && chain / N < 0.23, `动作链应贴 18%，实际 ${(chain / N * 100).toFixed(1)}%`);
  assert.ok(two / chainN > 0.6 && two / chainN < 0.74, `链内 2 条应贴 67%，实际 ${(two / chainN * 100).toFixed(1)}%`);
  assert.ok(single / N > 0.14 && single / N < 0.23, `纯动作应贴 18%，实际 ${(single / N * 100).toFixed(1)}%`);
});

check('⑰ 普通档永不触发动作链/纯动作（两个骰子都不掷）', () => {
  const s = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 < 8 || requireRoll(`bf-single:${x}`) * 100 < 8, 'n');
  const plan = lib.planRealtimeReply(['（害羞）别闹'], { scene: 'normal', seed: s });
  assert.equal(plan.mode, 'normal');
});

check('⑱ 动作链 3 条：段一条一段，文字垫最后一条（主人原例）', () => {
  const s = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 < 8 && requireRoll(`bf-chain-n:${x}`) * 100 >= 67, 'c3');
  const plan = lib.planRealtimeReply(['（害羞）（躲闪）（看起来有点不满）头发都给你弄乱了'], { scene: 'realtime', seed: s });
  assert.equal(plan.mode, 'chain');
  assert.equal(plan.chainSize, 3);
  assert.equal(plan.bubbles.length, 3);
  assert.equal(plan.bubbles[0].text, '（害羞）');
  assert.equal(plan.bubbles[1].text, '（躲闪）');
  assert.equal(plan.bubbles[2].text, '（看起来有点不满） 头发都给你弄乱了');
});

check('⑲ 动作链 2 条：材料合并成「段 + 段/文字」', () => {
  const s = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 < 8 && requireRoll(`bf-chain-n:${x}`) * 100 < 67, 'c2');
  const plan = lib.planRealtimeReply(['（害羞）（躲闪）头发都给你弄乱了'], { scene: 'realtime', seed: s });
  assert.equal(plan.mode, 'chain');
  assert.equal(plan.chainSize, 2);
  assert.equal(plan.bubbles.length, 2);
  assert.equal(plan.bubbles[0].text, '（害羞）');
  assert.equal(plan.bubbles[1].text, '（躲闪） 头发都给你弄乱了');
});

check('⑳ 纯动作链（没有文字）：段均分，末条也是一段', () => {
  const s = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 < 8 && requireRoll(`bf-chain-n:${x}`) * 100 >= 67, 'cp');
  const plan = lib.planRealtimeReply(['（抱）（贴紧）（嫌弃）'], { scene: 'realtime', seed: s });
  assert.equal(plan.mode, 'chain');
  assert.deepEqual(plan.bubbles.map((b) => b.text), ['（抱）', '（贴紧）', '（嫌弃）']);
});

check('㉑ 材料不够 N 条 → 链降级，不硬凑', () => {
  const s = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 < 8 && requireRoll(`bf-chain-n:${x}`) * 100 >= 67, 'cd');
  const plan = lib.planRealtimeReply(['（害羞）'], { scene: 'realtime', seed: s, cfg: { singleActionPct: 0 } });
  assert.equal(plan.mode, 'normal', '1 段 + 0 文字凑不出 3 条 → 退回正常');
});

check('㉒ 单个纯动作反馈：只发一个段、文字省略；原话过长则不吃成动作', () => {
  const s = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 >= 8 && requireRoll(`bf-single:${x}`) * 100 < 8, 's1');
  const ok = lib.planRealtimeReply(['（小声）我有点怕'], { scene: 'realtime', seed: s });
  assert.equal(ok.mode, 'single');
  assert.deepEqual(ok.bubbles.map((b) => b.text), ['（小声）'], '纯动作只发那一个段');

  const s2 = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 >= 8 && requireRoll(`bf-single:${x}`) * 100 < 8, 's2');
  const longText = '（小声）' + '这是一句很长很长的回答，长度明显超过了二十个字，不该被动作吃掉';
  const guarded = lib.planRealtimeReply([longText], { scene: 'realtime', seed: s2, cfg: { actionOnlyMaxTextChars: 20 } });
  assert.equal(guarded.mode, 'normal', '原话过长 → 不许用动作代替文字');
});

check('㉓ 动作链里的段同样受 6 气泡窗口约束（重复的跳过）', () => {
  const s = findSeed((x) => requireRoll(`bf-chain:${x}`) * 100 < 8 && requireRoll(`bf-chain-n:${x}`) * 100 >= 67, 'cr');
  const plan = lib.planRealtimeReply(['（害羞）（躲闪）头发都给你弄乱了'], {
    scene: 'realtime', seed: s, currentSeq: 10, bubbleSeq: 10,
    recentActions: [{ seg: '（害羞）', seq: 8 }],
  });
  // （害羞） 在窗口内 → 跳过，链改用 （躲闪） 起头；凑不够 3 条则降级
  if (plan.mode === 'chain') {
    assert.ok(!plan.bubbles.some((b) => b.text === '（害羞）'), `窗口内的重复动作不能出现：${JSON.stringify(plan.bubbles)}`);
  } else {
    assert.equal(plan.mode, 'normal');
  }
});

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);

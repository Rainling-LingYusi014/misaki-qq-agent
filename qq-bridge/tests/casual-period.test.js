/* ── 闲聊短句的句尾句号（2026-10-28 主人：「正常人聊天打字不会额外打句号」）──────────
 *
 * 现场：「收下啦。」——三个字挂个句号，读起来像公文。
 * 但主人也说了「完全禁用掉又不现实、不合适」：长段落、正式说明里句号是对的。
 * 所以桥侧只兜最明显的一类：单行、≤20 字、结尾是「。」；其余一律不动。
 *
 * 跑法：cd qq-bridge && node tests/casual-period.test.js
 */
import assert from 'node:assert/strict';
import { trimCasualPeriod } from '../src/lib/outbound-text.js';

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

console.log('== 闲聊短句句尾句号 ==');

t('现场原文「收下啦。」→ 摘掉句号', () => {
  assert.equal(trimCasualPeriod('收下啦。'), '收下啦');
});
t('单个字「好。」「嗯。」→ 摘掉', () => {
  assert.equal(trimCasualPeriod('好。'), '好');
  assert.equal(trimCasualPeriod('嗯。'), '嗯');
});
t('短句但结尾是问号/感叹号/省略号 → 不动', () => {
  assert.equal(trimCasualPeriod('吃了吗？'), '吃了吗？');
  assert.equal(trimCasualPeriod('好呀！'), '好呀！');
  assert.equal(trimCasualPeriod('晚安…'), '晚安…');
});
t('短句没有句号 → 原样', () => {
  assert.equal(trimCasualPeriod('困就别硬撑了'), '困就别硬撑了');
});
t('超过 20 字的长句 → 保留句号（长段落里句号是对的）', () => {
  const long = '这份说明按你要的顺序排，先讲背景，再讲做法，最后是注意事项，句号要留着。';
  assert.ok(long.length > 20);
  assert.equal(trimCasualPeriod(long), long);
});
t('带换行的多行文本 → 不动', () => {
  const s = '第一行。\n第二行。';
  assert.equal(trimCasualPeriod(s), s);
});
t('带链接的 → 不动', () => {
  const s = '看这个 https://b23.tv/abc。';
  assert.equal(trimCasualPeriod(s), s);
});
t('以引号/括号收尾 → 不动（不是纯句号）', () => {
  assert.equal(trimCasualPeriod('他说「走吧」'), '他说「走吧」');
  assert.equal(trimCasualPeriod('就这样（大概）'), '就这样（大概）');
});
t('空串/null → 原样返回', () => {
  assert.equal(trimCasualPeriod(''), '');
  assert.equal(trimCasualPeriod(null), '');
});
t('阈值可配：maxChars=4 时 5 个字不动', () => {
  assert.equal(trimCasualPeriod('我回来了。', { maxChars: 4 }), '我回来了。');
  assert.equal(trimCasualPeriod('我回来。', { maxChars: 4 }), '我回来');
});

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${failures.length}`);
process.exit(failures.length ? 1 : 0);

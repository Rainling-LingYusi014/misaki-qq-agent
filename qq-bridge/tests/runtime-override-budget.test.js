// 规则文件必须放得进注入上限（2026-10-29）
//
// 现场：speech-rules.md 长到 13458 字符，而唤醒补丁的上限还是 12000 —— 保头 9500 + 保尾 2500，
// 中段第 9501~10958 字符（#32~#37、初识档）一个字都没进模型。日志里只有一行 `[wake] ... 未进模型`，
// 很容易漏看：规则写了却不生效，跟"没写"没有区别。
//
// 这个测试守的是：**追加规则先红，而不是先静默丢**。上限抬了也要守住，不然下次长大又会悄悄截断。
//
// 用法：node tests/runtime-override-budget.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

// 只读源码里的常量，不 import wake-send.js：那个模块在 import 期会拉起配置与状态，测试没必要背那口锅。
const wakeSrc = fs.readFileSync(path.join(SRC, 'core', 'wake-send.js'), 'utf8');
const m = /RUNTIME_OVERRIDE_MAX\s*=\s*\{([^}]*)\}/.exec(wakeSrc);
assert.ok(m, 'wake-send.js 里找不到 RUNTIME_OVERRIDE_MAX');

const caps = {};
for (const hit of m[1].matchAll(/'([^']+)'\s*:\s*(\d+)/g)) caps[hit[1]] = Number(hit[2]);

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

console.log('== 人设/发言规则注入预算 ==');

t('两份规则文件都声明了上限', () => {
  for (const f of ['persona.md', 'speech-rules.md']) assert.ok(caps[f] > 0, `${f} 没有上限`);
});

for (const [file, cap] of Object.entries(caps)) {
  t(`${file} 不超过 ${cap} 字符（超了唤醒补丁会静默截掉中段）`, () => {
    const p = path.join(HERE, '..', file);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(
      text.length <= cap,
      `${file} 现有 ${text.length} 字符，超出上限 ${cap} 共 ${text.length - cap} 字——` +
      '请先压缩正文或抬高 RUNTIME_OVERRIDE_MAX，否则中段规则不会进模型'
    );
  });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

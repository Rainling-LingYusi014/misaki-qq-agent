// 回归测试：气泡偏好按「单个联系人」隔离（2026-10-29 主人定规）
//
// 规则原话：「单气泡依旧40字上限，除非被用户质疑了你说话怎么这么爱分气泡断句（不过得注意这是
// 每个单个的用户，而不是说一个用户质疑了，结果对所有人生效了）」。
//
// 这个文件守三件事：
//   ① 默认是 auto（70/25/5），谁也没被特殊对待；
//   ② 把某一位设成 single 之后，落盘、读回、只影响他自己；
//   ③ 别的人和群聊读到的仍是 auto —— 隔离性是这个功能的重点，不是附带。
//
// 做法与其它状态测试一致：src 拷进临时沙盒再 import，绝不碰真实 state。
// 用法：node tests/bubble-style-pref.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-bstyle-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-bstyle-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '123456789', allowAllWhenEmpty: true, social: {} }));

let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { fails += 1; console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const url = (v) => pathToFileURL(path.join(sandbox, 'src', 'core', 'social-state.js')).href + (v ? `?v=${v}` : '');
const cfg = { ownerQQ: '123456789', allowAllWhenEmpty: true, allow: {}, deny: {}, social: { tools: {}, send: { linearEnabled: false } } };
const modUrl = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
for (const p of ['core/mode.js', 'core/qq-send.js', 'core/social-flow.js']) {
  try { const m = await import(modUrl(p)); (m.initModeCore || m.initQqSendCore || m.initSocialFlowCore)?.(cfg); } catch { /* 可选依赖 */ }
}
const mod = await import(url());
mod.initSocialCore(cfg);

console.log('== 气泡偏好（按单个联系人）==');

check('默认是 auto：新建会话不被特殊对待', () => {
  const st = mod.getSocialState('private:111');
  assert.equal(st.bubbleStyle, 'auto');
  assert.equal(mod.bubbleStyleOf('private:111'), 'auto');
});

check('设成 single 只影响这一位，别人仍是 auto', () => {
  const st = mod.getSocialState('private:111');
  st.bubbleStyle = 'single';
  mod.saveSocialState();
  assert.equal(mod.bubbleStyleOf('private:111'), 'single');
  assert.equal(mod.bubbleStyleOf('private:222'), 'auto', '另一位联系人被传染了');
  assert.equal(mod.bubbleStyleOf('group:333'), 'auto', '群聊被影响了');
});

check('落盘并在重启后读回（按会话持久化）', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'social-state.json'), 'utf8'));
  assert.equal(onDisk.conversations['private:111']?.bubbleStyle, 'single', '没有写进 state');
  assert.equal(onDisk.conversations['private:222']?.bubbleStyle ?? 'auto', 'auto');
});

check('回退到 auto 也生效', () => {
  const st = mod.getSocialState('private:111');
  st.bubbleStyle = 'auto';
  mod.saveSocialState();
  assert.equal(mod.bubbleStyleOf('private:111'), 'auto');
});

check('脏值一律按 auto 处理，不产生第三种状态', () => {
  const st = mod.getSocialState('private:444');
  st.bubbleStyle = 'whatever';
  mod.saveSocialState();
  assert.equal(mod.bubbleStyleOf('private:444'), 'auto');
});

// 重新加载模块（模拟桥重启），验证持久化真的能读回来
const mod2 = await import(url('reload'));
mod2.initSocialCore(cfg);
mod2.getSocialState('private:555').bubbleStyle = 'single';
mod2.saveSocialState();
const mod3 = await import(url('reload2'));
mod3.initSocialCore(cfg);
mod3.loadSocialState();   // 新进程启动时会读回持久化状态
check('新进程读回 single（模拟桥重启）', () => {
  assert.equal(mod3.bubbleStyleOf('private:555'), 'single', '重启后偏好丢了');
  assert.equal(mod3.bubbleStyleOf('private:666'), 'auto');
});

console.log(`\n${fails === 0 ? 'ALL PASS' : 'FAILED'}  fail=${fails}`);
process.exit(fails === 0 ? 0 : 1);

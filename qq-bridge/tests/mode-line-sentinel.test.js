// 回归测试：模式切换对「极简哨兵轮」可见（2026-10-29 真机事故）
//
// 现场（主人小号泠岚 14:22–14:23）：
//   14:22:22 对方发 msk@companion → 桥切换成功并替她回执「好呀。那从现在起…」
//   14:23:07 她答「还没切呢，现在是常规模式」
//   14:23:39 又说「我这边还是常规模式，切成功的话桥会直接回你一句」
// 根因：`[Mode]` 行与 `[ModeChanged]` 一次性说明只拼在 buildWakePrompt（首轮/轮换后首轮）里；
//   会话首轮之后每轮走的是 sendWakePrompt 的「哨兵极简正文」，那里两样都没有 —— 模式切换对她不可见。
//   同类 bug 2026-10-26 修过一次，但只在完整路径上修，等于没修（这正是本文件要钉住的东西）。
//
// 守三件事：
//   ① 哨兵极简正文的两条模板（有工具/无工具兜底）都必须插 modeSentinel / bracketSentinel；
//   ② 切模式后 consumeModeNote 一次性给出「切到了哪个模式」，再消费即为空；
//   ③ 文案本身不能自相矛盾（陪伴模式行必须点名陪伴、切换说明必须点名新模式）。
// 用法：node tests/mode-line-sentinel.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { fails += 1; console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const src = fs.readFileSync(path.join(repo, 'src', 'core', 'wake-send.js'), 'utf8');

check('① 哨兵极简正文的两条模板都插了模式行（有工具 / 无工具兜底）', () => {
  const withTools = /promptText = `\[Token\] \$\{st\.agentToken\}\\n\$\{nowSentinel\}\$\{ownerTag\}\$\{trustedHereTag\}\$\{notOwnerTag\}\$\{modeSentinel\}\$\{bracketSentinel\}/.test(src);
  const noTools = /promptText = `\[Token\] \$\{st\.agentToken\}\\n\$\{nowSentinel\}\[Session\] \$\{key\}\\n\$\{modeSentinel\}/.test(src);
  assert.ok(withTools, '有工具流的哨兵正文必须插 ${modeSentinel}');
  assert.ok(noTools, '无工具兜底正文必须插 ${modeSentinel}');
});

check('② 模式行必须在 hasAnyTool 分支之前算好（否则兜底路径拿到空串）', () => {
  const iDefine = src.indexOf('let modeSentinel');
  const iBranch = src.indexOf('const hasAnyTool =');
  assert.ok(iDefine > 0 && iBranch > 0);
  assert.ok(iDefine < iBranch, 'modeSentinel 的赋值要早于 hasAnyTool 分支');
});

check('③ 切模式后一次性说明点名新模式，消费一次即清空', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-modeline-'));
  fs.cpSync(path.join(repo, 'src'), path.join(sandbox, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qb-modeline', private: true, type: 'module' }));
  fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '1736784911', allowAllWhenEmpty: true }));
  const cfg = { ownerQQ: '1736784911', allowAllWhenEmpty: true, allow: {}, deny: {}, social: {} };
  const modUrl = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
  for (const p of ['core/mode.js', 'core/qq-send.js', 'core/social-flow.js']) {
    try { const m = await import(modUrl(p)); (m.initModeCore || m.initQqSendCore || m.initSocialFlowCore)?.(cfg); } catch { /* 可选 */ }
  }
  const social = await import(modUrl('core/social-state.js'));
  const companion = await import(modUrl('core/companion-mode.js'));
  social.initSocialCore(cfg);
  const KEY = 'private:1832746340';
  social.getSocialState(KEY);

  assert.equal(social.conversationMode(KEY), 'regular', '默认是常规模式');
  social.setConversationMode(KEY, 'companion');
  assert.equal(social.conversationMode(KEY), 'companion');

  const note = social.consumeModeNote(KEY);
  assert.ok(note && note.mode === 'companion', '应拿到「切到陪伴模式」的一次性说明');
  const line = companion.modeChangedNoteLine(note.at, note.mode);
  assert.match(line, /\[ModeChanged\]/);
  assert.match(line, /陪伴模式/, '切换说明必须点名新模式');
  assert.equal(social.consumeModeNote(KEY), null, '消费一次就该清空（不能每轮重复解释）');

  // 当前模式行：陪伴态必须自己说清是陪伴，并给得出退出指令
  const modeLineC = companion.modeLineForWake(social.conversationMode(KEY));
  assert.match(modeLineC, /\[Mode\] 陪伴模式/);
  assert.match(modeLineC, /msk@standard/, '必须给得出切回常规的指令原文');

  social.setConversationMode(KEY, 'regular');
  const modeLineR = companion.modeLineForWake(social.conversationMode(KEY));
  assert.match(modeLineR, /\[Mode\] 常规模式/);
});

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);

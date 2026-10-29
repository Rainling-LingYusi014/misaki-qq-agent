// 回归测试：misaki@reaction（陪伴模式括号反馈总开关，2026-10-29 主人定规）
//
// 规格原话要点：
//   · 只有开/关两种状态，像按按钮——开启状态下输入指令默认关闭，反之开启；
//   · help 里这一行的文本是「陪伴模式反馈总开关（当前：x）」，x = 开/关；
//   · 文本与指令本体用「空格 竖线 空格」分隔。
//
// 守六件事：
//   ① 默认开；翻转一次变关、再翻一次回开（按钮语义）；
//   ② 按会话独立（一人关掉不牵连别人）；
//   ③ 落盘 + 重启读回（脏值回落开）；
//   ④ help 行格式精确：`misaki@reaction | 陪伴模式反馈总开关（当前：开）`；
//   ⑤ 解析器认得 misaki@reaction（含结尾标点容错）；
//   ⑥ 三条执行路径都读这个开关（发送成形 / 唤醒档位行 / 入站动作检测），源码级接线断言。
// 用法：node tests/reaction-switch.test.js
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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-reaction-'));
fs.cpSync(path.join(repo, 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qb-reaction', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '1000000001', allowAllWhenEmpty: true }));
const cfg = { ownerQQ: '1000000001', allowAllWhenEmpty: true, allow: {}, deny: {}, social: {} };
const modUrl = (p, v) => pathToFileURL(path.join(sandbox, 'src', p)).href + (v ? `?v=${v}` : '');
for (const p of ['core/mode.js', 'core/qq-send.js', 'core/social-flow.js']) {
  try { const m = await import(modUrl(p)); (m.initModeCore || m.initQqSendCore || m.initSocialFlowCore)?.(cfg); } catch { /* 可选 */ }
}
const social = await import(modUrl('core/social-state.js'));
social.initSocialCore(cfg);
const companion = await import(modUrl('core/companion-mode.js'));

const A = 'private:1000000002';
const B = 'private:1000000003';
social.getSocialState(A);
social.getSocialState(B);

check('① 默认关闭；翻一次开、再翻一次关（按钮语义）', () => {
  assert.equal(social.bracketReactionOf(A), false, '默认必须是关（主人定规：不发指令就没有括号反馈）');
  assert.equal(social.toggleBracketReaction(A), true);
  assert.equal(social.bracketReactionOf(A), true);
  assert.equal(social.toggleBracketReaction(A), false);
  assert.equal(social.bracketReactionOf(A), false);
});

check('② 按会话独立：A 打开不影响 B', () => {
  social.toggleBracketReaction(A); // A → 开
  assert.equal(social.bracketReactionOf(A), true);
  assert.equal(social.bracketReactionOf(B), false, '别人的开关不能跟着变');
  social.toggleBracketReaction(A); // 还原为关
});

check('③ 落盘 + 重启读回；脏值回落关', () => {
  social.toggleBracketReaction(B); // B → 开
  social.saveSocialState();
  const raw = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'social-state.json'), 'utf8'));
  assert.equal(raw.conversations[B]?.bracketReaction, true, '开启状态必须落盘');
  social.toggleBracketReaction(B); // 还原为关
  social.saveSocialState();
  const raw2 = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'social-state.json'), 'utf8'));
  assert.equal(raw2.conversations[B]?.bracketReaction, false, '关闭状态同样要落盘');
});

check('④ help 行格式：misaki@reaction | 陪伴模式反馈总开关（当前：开/关）', () => {
  const on = companion.helpText('companion', true);
  const off = companion.helpText('companion', false);
  assert.ok(on.includes('misaki@reaction | 陪伴模式反馈总开关（当前：开）'), `开态行不对：\n${on}`);
  assert.ok(off.includes('misaki@reaction | 陪伴模式反馈总开关（当前：关）'), `关态行不对：\n${off}`);
  assert.match(on, /misaki@reaction \| /, '指令与文本之间必须是「空格 竖线 空格」');
  assert.ok(!on.includes('misaki@reaction|'), '不能少了空格');
  const unknown = companion.helpText('companion', null);
  assert.ok(unknown.includes('misaki@reaction | 陪伴模式反馈总开关'), '状态未知时不硬编开/关');
  assert.ok(!unknown.includes('当前：'), '状态未知就不该显示「当前：」');
});

check('⑤ 解析器认得 misaki@reaction（结尾标点容错，正文带尾巴不算指令）', () => {
  assert.equal(companion.parseMisakiCommand('misaki@reaction')?.kind, 'action-reaction');
  assert.equal(companion.parseMisakiCommand('misaki@reaction。')?.kind, 'action-reaction');
  assert.equal(companion.parseMisakiCommand('MISAKI@REACTION')?.kind, 'action-reaction', '大小写不敏感');
  assert.equal(companion.parseMisakiCommand('misaki@reaction 开吗'), null, '带尾巴的话按普通聊天放行');
  assert.equal(companion.parseMisakiCommand('随便说说 misaki@reaction'), null, '句中提及不触发');
});

check('⑥ 三条执行路径都读这个开关（源码级接线断言）', () => {
  const consoleSrc = fs.readFileSync(path.join(repo, 'src', 'core', 'console-server.js'), 'utf8');
  assert.ok(/agentMode === 'companion' && bracketReactionOf\(key\)/.test(consoleSrc), '发送成形必须查开关');
  const wakeSrc = fs.readFileSync(path.join(repo, 'src', 'core', 'wake-send.js'), 'utf8');
  const hits = (wakeSrc.match(/bracketReactionOf\(key\)/g) || []).length;
  assert.ok(hits >= 2, `唤醒正文两条路径（完整/哨兵）都要查开关，实际 ${hits} 处`);
  const flowSrc = fs.readFileSync(path.join(repo, 'src', 'core', 'social-flow.js'), 'utf8');
  assert.ok(/bracketReactionOf\(key\)/.test(flowSrc), '入站动作检测也要尊重开关');
  const muxSrc = fs.readFileSync(path.join(repo, 'src', 'core', 'mux.js'), 'utf8');
  assert.ok(/kind === 'action-reaction'/.test(muxSrc), 'mux 必须处理这条指令');
  assert.ok(/helpText\(conversationMode\(key\), bracketReactionOf\(key\)\)/.test(muxSrc), 'help 要把状态带上');
});

check('⑦ 常规模式一律不出括号，跟开关状态无关（源码级：所有成形都要求 companion）', () => {
  const consoleSrc = fs.readFileSync(path.join(repo, 'src', 'core', 'console-server.js'), 'utf8');
  assert.ok(/bfCfg\.enabled && stBf\?\.agentMode === 'companion' && bracketReactionOf\(key\)/.test(consoleSrc),
    '发送成形必须是「开关开 + 陪伴模式 + 本人开关开」三重条件');
  const wakeSrc = fs.readFileSync(path.join(repo, 'src', 'core', 'wake-send.js'), 'utf8');
  const gate = (wakeSrc.match(/conversationMode\(key\) === 'companion'/g) || []).length;
  assert.ok(gate >= 2, `两条唤醒路径都必须先判陪伴模式，实际 ${gate} 处`);
});

check('⑧ 模式来回切换不重置开关；misaki@reset 也只清认知、不动这项偏好', () => {
  const K = 'private:1000000002';
  social.setConversationMode(K, 'companion');
  assert.equal(social.bracketReactionOf(K), false, '默认关');
  assert.equal(social.toggleBracketReaction(K), true, '本人打开');
  social.setConversationMode(K, 'regular');
  assert.equal(social.bracketReactionOf(K), true, '切回常规：状态保留（只是不再生效）');
  social.setConversationMode(K, 'companion');
  assert.equal(social.bracketReactionOf(K), true, '切回陪伴：仍是开，不会被重置成关');
  social.setConversationMode(K, 'regular');
  social.setConversationMode(K, 'companion');
  assert.equal(social.bracketReactionOf(K), true, '连续来回切也不许重置');

  // reset：清空认知但保住偏好（bubbleStyle / bracketReaction 都是「怎么说话」，不是认知）
  social.getSocialState(K).bubbleStyle = 'single';
  social.resetConversationKeepingLedger(K);
  assert.equal(social.bracketReactionOf(K), true, 'reset 后开关状态必须保住');
  assert.equal(social.bubbleStyleOf(K), 'single', 'reset 后气泡偏好也要保住');
});

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);

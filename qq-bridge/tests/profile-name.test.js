// 回归测试：通讯录昵称不能被「会话类型标签」污染（2026-10-29）。
//
// 现场：四个好友的 profiles.name 全被写成「私聊」——mux 给私聊消息的 sender 填的是显示标签
// '私聊'，appendSocialMessage 把它当昵称交给 rememberContactName 写进通讯录；而
// rememberContactName 在「已有名字」时拒绝覆盖，所以这个错名字永远不会自愈，只能手工清库。
// 表现：模型在 [Contacts] 里看到一排「私聊」，会照字面把好友叫成"私聊"。
//
// 现在的契约：
//   ① rememberContactName 拒收占位标签（私聊/群聊/对方/陌生人…），不当昵称入库；
//   ② 真昵称照常写入；已有名字仍不被覆盖（画像学习的结果优先）；
//   ③ 「名字本身就是号码」与超长串照旧拒绝。
//
// 做法与仓库其它记忆测试一致：src 拷进临时沙盒再 import，绝不碰真实 state/memory.db。
// 用法：node tests/profile-name.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-profile-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-profile-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '123456789', allowAllWhenEmpty: true, social: {} }));

let fails = 0;
const check = (n, f) => { try { f(); console.log('PASS  ' + n); } catch (e) { fails += 1; console.log('FAIL  ' + n + '  ' + (e?.message ?? e)); } };

const mem = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'memory.js')).href);
const db = mem.initMemoryDb();
const FRIEND = '1000000003';
const nameOf = (uid) => db.prepare('SELECT name FROM profiles WHERE uid = ?').get(uid)?.name ?? '';

// ── ① 占位标签一律拒收 ───────────────────────────────────────────────────
for (const label of ['私聊', '群聊', '对方', '陌生人', '未知', '文件传输助手']) {
  check(`拒收占位标签「${label}」`, () => {
    assert.equal(mem.rememberContactName(FRIEND, label), false);
    assert.equal(nameOf(FRIEND), '', `占位标签被写进了通讯录：${nameOf(FRIEND)}`);
  });
}

// ── ② 真昵称照常写入，且不被后续覆盖 ─────────────────────────────────────
check('真昵称写入成功', () => {
  assert.equal(mem.rememberContactName(FRIEND, '我1267'), true);
  assert.equal(nameOf(FRIEND), '我1267');
});
check('已有名字不被第二次覆盖（画像优先）', () => {
  assert.equal(mem.rememberContactName(FRIEND, '别的名字'), false);
  assert.equal(nameOf(FRIEND), '我1267');
});
check('先写名字再收到占位标签 → 名字不受影响', () => {
  mem.rememberContactName('3763302862', '忘忧');
  mem.rememberContactName('3763302862', '私聊');
  assert.equal(nameOf('3763302862'), '忘忧');
});

// ── ③ 原有的两道过滤不退化 ───────────────────────────────────────────────
check('名字是纯号码 → 拒收', () => {
  assert.equal(mem.rememberContactName('1000000002', '1000000002'), false);
  assert.equal(nameOf('1000000002'), '');
});
check('超长串（疑似误传正文）→ 拒收', () => {
  assert.equal(mem.rememberContactName('1000000002', '啊'.repeat(80)), false);
  assert.equal(nameOf('1000000002'), '');
});
check('uid 不是 QQ 号 → 拒收', () => {
  assert.equal(mem.rememberContactName('group:990002', '某人'), false);
});

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);

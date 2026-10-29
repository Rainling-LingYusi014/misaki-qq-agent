// 回归测试：长期记忆的「覆盖」语义（2026-10-28 主人定规）。
//
// 现场：好友说「那我也喜欢你」→ 她记下「这个人有对象」；19 秒后对方说「可是早分了」，
// 库里没有任何修订，旧事实一直有效。根因有两层：① qq_memory_remember 的触发词只写
// 「the owner … corrects you」，好友的更正不在指令范围内；② 工具本身没有"替换"语义，
// 即使想改也只能 search→remove→remember 三步。
//
// 现在的契约：
//   · rememberEntry({supersedes:[id]}) 把旧条目标 superseded_by=新id，旧行留档不删；
//   · 所有检索（listMemoryEntries / memoryDigest）默认排除失效条目，效果等同"直接覆盖"；
//   · 只认同一个 uid —— 不能顺着旧 id 把别人的事实冲掉；
//   · 主人自己的记忆与全局规矩（uid=''）不许被自动覆盖。
//
// 做法与仓库其它测试一致：把 src 拷进临时沙盒再 import，绝不碰真实 state/memory.db。
// 用法：node tests/memory-supersede.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-supersede-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-supersede-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '123456789', allowAllWhenEmpty: true, social: {} }));

let fails = 0;
const check = (n, f) => { try { f(); console.log('PASS  ' + n); } catch (e) { fails += 1; console.log('FAIL  ' + n + '  ' + (e?.message ?? e)); } };

const mem = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'memory.js')).href);
const db = mem.initMemoryDb();
const OWNER = '123456789';
const FRIEND = '1000000003';

// ── 基础覆盖 ──────────────────────────────────────────────────────────────
const oldFact = mem.rememberEntry({ uid: FRIEND, category: 'fact', content: '这个人有对象' });
const newFact = mem.rememberEntry({
  uid: FRIEND, category: 'fact', content: '这个人已经分手一年半，目前单身',
  supersedes: [oldFact.id], protectUids: [OWNER],
});

check('新事实写入成功', () => assert.equal(newFact.ok, true));
check('返回值标明覆盖了哪条', () => assert.deepEqual(newFact.superseded, [oldFact.id]));

check('旧行留档（不物理删除）且指向新条目', () => {
  const row = db.prepare('SELECT content, superseded_by FROM memory_entries WHERE id = ?').get(oldFact.id);
  assert.equal(row.content, '这个人有对象');
  assert.equal(Number(row.superseded_by), Number(newFact.id));
});

check('检索默认看不到旧事实，只看到新事实', () => {
  const text = mem.listMemoryEntries({ uid: FRIEND, limit: 20 }).entries.map((e) => e.content).join(' | ');
  assert.ok(!text.includes('有对象'), `旧事实仍被返回：${text}`);
  assert.ok(text.includes('分手一年半'), text);
});

check('每轮摘要也看不到旧事实', () => {
  const digest = mem.memoryDigest({ uid: FRIEND, limit: 20, maxChars: 2000 });
  assert.ok(!digest.includes('有对象'), digest);
  assert.ok(digest.includes('分手一年半'), digest);
});

check('排障时可以带 includeSuperseded 看回历史', () => {
  const text = mem.listMemoryEntries({ uid: FRIEND, limit: 20, includeSuperseded: true })
    .entries.map((e) => e.content).join(' | ');
  assert.ok(text.includes('有对象'), text);
});

// 直接查库而不是走 memoryStats()：那个函数会顺带打开 chat.db，沙盒里的句柄关不掉，
// Windows 下 rmSync 就会 EPERM（临时目录越攒越多）。
const supersededCount = () => Number(db.prepare('SELECT COUNT(*) AS c FROM memory_entries WHERE superseded_by > 0').get().c);

check('库里只有一条被标失效', () => assert.equal(supersededCount(), 1));

// ── 不许越界 ──────────────────────────────────────────────────────────────
check('跨 uid 覆盖被拒（别人的旧事实冲不掉）', () => {
  const other = mem.rememberEntry({ uid: '9999999002', category: 'fact', content: '另一个人有对象' });
  const r = mem.rememberEntry({
    uid: '9999999002', category: 'fact', content: '试图用别人的 id 覆盖',
    supersedes: [oldFact.id], protectUids: [OWNER],
  });
  assert.deepEqual(r.superseded, []);
  const row = db.prepare('SELECT superseded_by FROM memory_entries WHERE id = ?').get(oldFact.id);
  assert.equal(Number(row.superseded_by), Number(newFact.id), '旧行被跨 uid 改写了');
  assert.equal(db.prepare('SELECT superseded_by FROM memory_entries WHERE id = ?').get(other.id).superseded_by, 0);
});

check('主人自己的记忆不许被自动覆盖', () => {
  const o = mem.rememberEntry({ uid: OWNER, category: 'fact', content: '主人说：周末要整理相册' });
  const r = mem.rememberEntry({
    uid: OWNER, category: 'fact', content: '模型自作主张改写主人的事实',
    supersedes: [o.id], protectUids: [OWNER],
  });
  assert.ok(r.supersedeNote, '没有给出拒绝原因');
  assert.equal(Number(db.prepare('SELECT superseded_by FROM memory_entries WHERE id = ?').get(o.id).superseded_by), 0);
});

check('全局规矩（uid 为空）不许被自动覆盖', () => {
  const g = mem.rememberEntry({ uid: '', category: 'rule', content: '单条回复保持简短', tier: 'permanent' });
  const r = mem.rememberEntry({
    uid: '', category: 'rule', content: '模型试图改全局规矩', tier: 'permanent',
    supersedes: [g.id], protectUids: [OWNER],
  });
  assert.ok(r.supersedeNote, '没有给出拒绝原因');
  assert.equal(Number(db.prepare('SELECT superseded_by FROM memory_entries WHERE id = ?').get(g.id).superseded_by), 0);
});

// ── 幂等 ──────────────────────────────────────────────────────────────────
check('重复覆盖同一条不报错、不重复计数', () => {
  const again = mem.rememberEntry({
    uid: FRIEND, category: 'fact', content: '这个人已经分手一年半，目前单身',
    supersedes: [oldFact.id], protectUids: [OWNER],
  });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true, '同内容应命中去重');
  assert.deepEqual(again.superseded, [], '已失效的条目不应再被标记一次');
  assert.equal(supersededCount(), 1);
});

// 先关库再删沙盒：Windows 下 SQLite 的文件句柄还开着时 rmSync 会 EPERM。
try { db.close(); } catch { /* 已关或库里还有别的连接，忽略 */ }
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.log(`WARN  沙盒清理失败（不影响结论）: ${e?.message ?? e}`); }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

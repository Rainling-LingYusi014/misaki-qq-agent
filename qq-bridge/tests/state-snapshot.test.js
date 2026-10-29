// 回归测试：状态每日快照（2026-10-29 主人定：需要做）
//
// 背景：2026-10-29 凌晨测试把真实 state/social-state.json 覆盖成假会话，5 个真实会话全丢，
// 当时没有任何快照可回滚。这个模块保证「每天至少有一份 7 天内的状态副本」。
//
// 守护点：
//   ① 同一天只做一份（重启不重复写、不刷屏）；
//   ② 白名单拷贝，缺失文件跳过不报错；
//   ③ SQLite 库要么 VACUUM 出来、要么普通拷贝，文件必须可用；
//   ④ 只留最近 7 天，旧的自动清掉。
//
// 用法：node tests/state-snapshot.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotState, beijingDay, SNAPSHOT_FILES } from '../src/lib/state-snapshot.js';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-snapshot-'));
const stateDir = path.join(tmp, 'state');
const root = tmp;
fs.mkdirSync(stateDir, { recursive: true });

// 造几份真实文件
fs.writeFileSync(path.join(stateDir, 'social-state.json'), JSON.stringify({ conversations: { 'private:1': { bubbleStyle: 'single' } } }));
fs.writeFileSync(path.join(stateDir, 'sessions.json'), '{"s":1}');
fs.writeFileSync(path.join(stateDir, 'not-in-list.json'), '{"ignore":true}');
fs.writeFileSync(path.join(root, 'config.json'), '{"ownerQQ":"1"}');
const srcDb = new DatabaseSync(path.join(stateDir, 'chat.db'));
srcDb.exec('CREATE TABLE m (id INTEGER PRIMARY KEY, t TEXT)');
srcDb.exec("INSERT INTO m (t) VALUES ('hello')");
srcDb.close();

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

console.log('== 状态每日快照 ==');

const at = new Date('2026-10-29T02:00:00Z');
const first = snapshotState({ stateDir, root, keepDays: 7, now: at });

t('第一次：建目录、写 manifest、拷到白名单文件', () => {
  assert.equal(first.ok, true);
  assert.equal(first.snapshot, true);
  assert.equal(first.day, beijingDay(at));
  const dir = path.join(stateDir, 'snapshots', first.day);
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dir, 'social-state.json')));
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'not-in-list.json')), '白名单外的文件不该进快照');
  assert.ok(!SNAPSHOT_FILES.includes('not-in-list.json'));
});

t('数据库可用（VACUUM 或拷贝，读得回数据）', () => {
  const dir = path.join(stateDir, 'snapshots', first.day);
  const db = new DatabaseSync(path.join(dir, 'chat.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT t FROM m').get();
    assert.equal(row?.t, 'hello');
  } finally { db.close(); }
});

t('同一天再做一次：跳过，不重复写', () => {
  const again = snapshotState({ stateDir, root, keepDays: 7, now: at });
  assert.equal(again.snapshot, false);
});

t('只保留最近 7 天：造 9 个旧目录 → 清掉最老的 2 个', () => {
  const snapRoot = path.join(stateDir, 'snapshots');
  for (const d of ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']) {
    fs.mkdirSync(path.join(snapRoot, d), { recursive: true });
    fs.writeFileSync(path.join(snapRoot, d, 'manifest.json'), '{}');
  }
  const next = snapshotState({ stateDir, root, keepDays: 7, now: new Date('2026-10-30T02:00:00Z') });
  assert.equal(next.snapshot, true);
  const left = fs.readdirSync(snapRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  assert.equal(left.length, 7, `应剩 7 份，实剩 ${left.length}：${left.join(', ')}`);
  assert.ok(!left.includes('2026-10-18'));
  assert.ok(left.includes('2026-10-30'));
});

t('北京时间分日：UTC 16:00 属于第二天', () => {
  assert.equal(beijingDay(new Date('2026-10-29T15:59:00Z')), '2026-10-29');
  assert.equal(beijingDay(new Date('2026-10-29T16:00:00Z')), '2026-10-30');
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

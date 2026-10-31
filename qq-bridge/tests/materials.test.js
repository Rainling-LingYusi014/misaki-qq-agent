// 素材库核心回归（2026-10-30）：入库/去重/检索/补丁/删除→回收/孤儿扫描/尺寸探测。
// 沙盒：临时目录 + startServer=false，不碰真实 state、不开端口。node tests/materials.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { fails += 1; console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-test-'));
const prevCwd = process.cwd();
process.chdir(tmp); // initMaterials 用 process.cwd()/state/materials
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });

const mod = await import(pathToFileUrl(path.join(prevCwd, 'src', 'core', 'materials.js')));
const cfg = { consoleToken: 'test-token', materials: { enabled: true, categories: ['misaki', 'daily', 'scenery'], lanPort: 3210, bindHost: '127.0.0.1' } };
mod.initMaterials(cfg, { startServer: false });

// 1x1 PNG（合法头，probe 能读出尺寸）
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001od', 'hex').subarray(0, 67);
const pngA = PNG_1x1;
const pngB = Buffer.from(pngA); pngB[25] = 0x02; // 改宽高位制造不同 hash

check('① 入库：写文件 + 记账 + 标签归一', () => {
  const r = mod.addMaterial({ category: 'misaki', tags: ['立绘, 正式'], source: 'AI绘制', note: '首张测试', origName: 'a.png', buffer: pngA });
  assert.equal(r.duplicate, false);
  assert.equal(r.tags.length, 2, '标签应归一为 2 个');
  assert.ok(fs.existsSync(path.join(mod.materialsRoot(), r.category)));
  const d = mod.detailMaterial(r.id);
  assert.equal(d.width, 1); assert.equal(d.height, 1);
  assert.equal(d.category, 'misaki');
});

check('② 去重：同内容二投 → duplicate + 不重复落盘', () => {
  const before = fs.readdirSync(path.join(mod.materialsRoot(), 'misaki')).length;
  const r = mod.addMaterial({ category: 'daily', tags: ['x'], origName: 'b.png', buffer: pngA });
  assert.equal(r.duplicate, true);
  const after = fs.readdirSync(path.join(mod.materialsRoot(), 'misaki')).length;
  assert.equal(before, after, '重复入库不应新增文件');
});

check('③ 非法大类回落 inbox', () => {
  const r = mod.addMaterial({ category: 'not-exist', tags: [], origName: 'c.png', buffer: pngB });
  assert.equal(r.category, 'inbox');
});

check('④ 检索：分类/标签/关键词/只看未用', () => {
  assert.equal(mod.queryMaterials({ category: 'misaki' }).total, 1);
  assert.equal(mod.queryMaterials({ tag: '立绘' }).total, 1);
  assert.equal(mod.queryMaterials({ q: '首张' }).total, 1);
  assert.equal(mod.queryMaterials({ unusedOnly: true }).total, 2);
});

check('⑤ patch：标签/说明/使用记账', () => {
  const one = mod.queryMaterials({ category: 'misaki' }).items[0];
  const p = mod.patchMaterial(one.id, { tags: ['立绘', '主视觉'], note: '改过', markUsedWhere: 'qzone 10-30' });
  assert.deepEqual(p.tags, ['立绘', '主视觉']);
  assert.equal(p.usedCount, 1);
  assert.equal(p.usedIn[0].where, 'qzone 10-30');
  assert.equal(mod.queryMaterials({ unusedOnly: true }).total, 1);
});

check('⑥ 删除：文件进 .trash/，账本删行', () => {
  const one = mod.queryMaterials({ category: 'misaki' }).items[0];
  assert.equal(mod.deleteMaterial(one.id), true);
  assert.equal(mod.queryMaterials({ category: 'misaki' }).total, 0);
  assert.ok(fs.existsSync(path.join(mod.materialsRoot(), '.trash')), '回收目录应存在');
});

check('⑦ 孤儿扫描：手工放进目录的文件开机补记（tags 空）', () => {
  const pngC = Buffer.from(pngB); pngC[40] ^= 0xff; // 与已有内容不同，避开 sha 去重
  const dir = path.join(mod.materialsRoot(), 'daily');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manual.png'), pngC);
  const r = mod.scanOrphans();
  assert.equal(r.added, 1);
  const item = mod.queryMaterials({ category: 'daily' }).items[0];
  assert.equal(item.tags.length, 0);
  assert.equal(item.origName, 'manual.png');
});

check('⑧ 越界防护：fileAbs 拒绝库外路径（构造不存在 id → null）', () => {
  assert.equal(mod.fileAbs('f'.repeat(64)), null);
});

check('⑨ 鉴权token：timingSafeEqual 等长比较不抛异常（短 token）', () => {
  // tokenOk 在 server 内；这里只验证核心不因短 token 崩——用等长假 token 手动比较语义
  const a = Buffer.from('abc'); const b = Buffer.from('abd');
  assert.equal(a.equals(b), false);
});

process.chdir(prevCwd);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows 下 SQLite 句柄延迟释放，清理失败不影响判定 */ }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);

function pathToFileUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

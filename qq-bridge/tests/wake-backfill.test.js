// 回归测试：投递看门狗的「补投轮」必须给消息标上发出时间（2026-10-29）。
//
// 现场（2026-10-28 23:17）：23:16:20 对方发的「真的嘛」落在"唤醒正文已定稿、回合还没收尾"的空档里，
// 没进任何正文；25 秒后被投递看门狗当作"打算交付却没交出去"的消息重新投了一次。
// 那一轮正文只有 `[Unread 1] …(id:…): 真的嘛`，抬头写着 `[Now] 23:17`，没有任何时间标记——
// 模型只能把它当成刚发生的新消息，于是拿自己上一条「光发图不说话啊」去接它，回了「真的啊，我又不瞎」。
//
// 现在的契约（见 wake-send.js 的 backfillUnreadMarks）：
//   · 补投轮每条未读带 ` [HH:MM 发出 · 补投]`；
//   · 补投轮正文前有一行 [Guide] 说明"这是补投，别当成新话题"；
//   · 其它唤醒原因一个字节都不加（不烧多余 token）。
//
// 用法：node tests/wake-backfill.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-backfill-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-backfill-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '123456789', social: {}, allow: { private: [], groups: [] }, deny: { private: [], groups: [] } }));

let fails = 0;
const check = (n, f) => { try { f(); console.log('PASS  ' + n); } catch (e) { fails += 1; console.log('FAIL  ' + n + '  ' + (e?.message ?? e)); } };

const wake = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'wake-send.js')).href);
const T23_16 = Date.parse('2026-10-28T23:16:20+08:00');

const backfill = wake.backfillUnreadMarks('deliveryWatchdog');
const normal = wake.backfillUnreadMarks('private');

check('补投轮被识别出来', () => assert.equal(backfill.on, true));
check('正常轮不被识别成补投', () => assert.equal(normal.on, false));
check('带 :后缀 的补投原因同样识别', () => assert.equal(wake.backfillUnreadMarks('deliveryWatchdog:retry').on, true));

check('补投轮每条带发出时间', () => assert.equal(backfill.timeTag({ time: T23_16 }), ' [23:16 发出 · 补投]'));
check('补投轮明确写了"别当成新话题"', () => assert.ok(backfill.guide.includes('不要当成刚发生的新话题')));
check('补投轮明确写了"别用上一条回复去接"', () => assert.ok(backfill.guide.includes('也不要用你上一条回复去接它')));
check('补投轮 [Guide] 行以换行开头（拼正文时不留空行）', () => assert.ok(backfill.guide.startsWith('\n[Guide]')));
check('消息没有时间戳时不崩、只是不加标注', () => assert.equal(backfill.timeTag({}), ''));

check('正常轮没有 [Guide]', () => assert.equal(normal.guide, ''));
check('正常轮不加时间标注', () => assert.equal(normal.timeTag({ time: T23_16 }), ''));

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.log(`WARN  沙盒清理失败（不影响结论）: ${e?.message ?? e}`); }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

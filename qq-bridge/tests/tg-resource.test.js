// TG 资源域单元测试（2026-10-30，M2）：纯策略层——频道名归一化、白名单闸、启用开关。
// 真连接路径（侧车/下载/交付）不在此覆盖：它们要真 session 和 mihomo TG 专线，
// 属 M2 手工验收（TG资源管线_设计_20261029.md §9）。与仓库其它测试一致：src 拷进临时沙盒再 import。
// 用法：node tests/tg-resource.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-tgres-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-tgres-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '1000000001', allowAllWhenEmpty: true, social: {} }));

let fails = 0;
const check = (n, f) => { try { f(); console.log('PASS  ' + n); } catch (e) { fails += 1; console.log('FAIL  ' + n + '  ' + (e?.message ?? e)); } };

const tg = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'tg-resource.js')).href);

// ── ① 频道名归一化：t.me 链接 / @名 / 裸名 都收到 @名；空串保持空
check('normalizeChannel: t.me 链接', () => {
  assert.equal(tg.tgNormalizeChannel('https://t.me/YuanShen'), '@YuanShen');
  assert.equal(tg.tgNormalizeChannel('https://t.me/YuanShen?tgshare=1'), '@YuanShen');
});
check('normalizeChannel: t.me 裸链', () => assert.equal(tg.tgNormalizeChannel('t.me/YuanShen'), '@YuanShen'));
check('normalizeChannel: @名与裸名', () => {
  assert.equal(tg.tgNormalizeChannel('@YuanShen'), '@YuanShen');
  assert.equal(tg.tgNormalizeChannel('YuanShen'), '@YuanShen');
});
check('normalizeChannel: 空值安全', () => assert.equal(tg.tgNormalizeChannel(''), ''));

// ── ② 单条目白名单：缺省频道自动取唯一条目；白名单外拒绝
check('gateChannel: 单条目白名单缺省自动命中', () => {
  tg.initTgResource({ telegram: { enabled: false, whitelist: ['@YuanShen'] } });
  assert.equal(tg.tgGateChannel(''), '@YuanShen');
  assert.equal(tg.tgGateChannel('t.me/YuanShen'), '@YuanShen');
});
check('gateChannel: 白名单外拒绝', () => {
  assert.throws(() => tg.tgGateChannel('@SomeRandom'), /不在白名单/);
});

// ── ③ 多条目白名单：缺省必须报「指定频道」，命中条目放行
check('gateChannel: 多条目缺省报错', () => {
  tg.initTgResource({ telegram: { enabled: false, whitelist: ['@YuanShen', '@TestCh2'] } });
  assert.throws(() => tg.tgGateChannel(''), /未指定频道/);
  assert.equal(tg.tgGateChannel('@TestCh2'), '@TestCh2');
});

// ── ④ 启用开关：enabled:false 时 tgEnabled=false 且不落盘 token；enabled:true 无 session 时不 spawn 但开关为 true
check('tgEnabled 开关语义', () => {
  tg.initTgResource({ telegram: { enabled: false, whitelist: [] } });
  assert.equal(tg.tgEnabled(), false);
  tg.initTgResource({ telegram: { enabled: true, whitelist: ['@YuanShen'] } }); // 沙盒无 session → 不 spawn，无定时器泄漏
  assert.equal(tg.tgEnabled(), true);
});

// ── ⑤ 白名单归一化：配置里写裸名/t.me 链接也能被 gate 接受
check('whitelist 配置形态宽容', () => {
  tg.initTgResource({ telegram: { enabled: false, whitelist: ['t.me/YuanShen'] } });
  assert.equal(tg.tgGateChannel('@YuanShen'), '@YuanShen');
});

// ── ⑥ 时间窗归一化：date-only 按北京日界展开；ISO 串原样；空串=不限；非法串报错
check('parseDay: date-only 北京日界', () => {
  const day0 = tg.tgParseDay('2026-01-01', false);
  const dayEnd = tg.tgParseDay('2026-01-01', true);
  assert.equal(day0, Date.parse('2026-01-01T00:00:00+08:00') / 1000);
  assert.equal(dayEnd, Date.parse('2026-01-01T23:59:59+08:00') / 1000);
  assert.ok(dayEnd - day0 === 86399);
});
check('parseDay: ISO 串与空值', () => {
  assert.equal(tg.tgParseDay('2026-01-15T12:00:00+08:00'), Date.parse('2026-01-15T12:00:00+08:00') / 1000);
  assert.equal(tg.tgParseDay(''), 0);
  assert.equal(tg.tgParseDay(undefined), 0);
});
check('parseDay: 非法串报错', () => {
  assert.throws(() => tg.tgParseDay('上个月'), /时间参数看不懂/);
});

// ── ⑦ 侧车秒契约（2026-10-30 修 Bug①）：秒透传、毫秒误传折算、0/null/undefined 边界
check('toSidecarSec: 秒透传（与 parseDay 链路一致）', () => {
  assert.equal(tg.toSidecarSec(1790784000), 1790784000); // 2026-10-01 北京零点（brief 验证用常量）
  assert.equal(tg.toSidecarSec(tg.tgParseDay('2026-10-01')), 1790784000);
});
check('toSidecarSec: 毫秒误传折算', () => {
  assert.equal(tg.toSidecarSec(1790784000000), 1790784000);
  assert.equal(tg.toSidecarSec(tg.tgParseDay('2026-11-01', true) * 1000), tg.tgParseDay('2026-11-01', true));
});
check('toSidecarSec: 0/null/undefined 边界', () => {
  assert.equal(tg.toSidecarSec(0), 0);
  assert.equal(tg.toSidecarSec(null), 0);
  assert.equal(tg.toSidecarSec(undefined), 0);
  assert.equal(tg.toSidecarSec(''), 0);
});

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);

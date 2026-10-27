// 二维码离线回归：参数校验 / 能力表；服务器装了引擎才真跑
//   node tools/test-qrcode.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildQrCapabilities, validateQrOptions, probeQrTools, generateQrCode } from '../src/core/qrcode-tool.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};
const throws = (name, fn, re) => {
  try { fn(); ok(name, false, '没有抛错'); } catch (e) { ok(name, re.test(e.message), e.message); }
};

console.log('== ① 参数校验 ==');
{
  const d = validateQrOptions({});
  ok('默认 M / 6 / 4', d.level === 'M' && d.scale === 6 && d.margin === 4);
  throws('纠错等级非法', () => validateQrOptions({ level: 'X' }), /L \/ M \/ Q \/ H/);
  throws('scale 超界', () => validateQrOptions({ scale: 50 }), /1~20/);
  throws('margin 超界', () => validateQrOptions({ margin: -1 }), /0~16/);
  throws('前景色非法', () => validateQrOptions({ dark: 'black' }), /#RRGGBB/);
  const o = validateQrOptions({ level: 'h', scale: 10, margin: 2, dark: '#123456', light: '#ABCDEF' });
  ok('大小写归一 + 颜色保留', o.level === 'H' && o.scale === 10 && o.dark === '#123456' && o.light === '#ABCDEF');
}

console.log('== ② 能力表 ==');
{
  const full = buildQrCapabilities({ qrencode: true, pythonQrcode: true, segno: false, pyCmd: 'python3', mode: 'qrencode' });
  ok('有 qrencode 时可用且引擎正确', full.available && full.engine === 'qrencode');
  const py = buildQrCapabilities({ qrencode: false, pythonQrcode: true, segno: true, pyCmd: 'python3', mode: 'python-qrcode' });
  ok('退而用 python-qrcode', py.engine === 'python-qrcode');
  const none = buildQrCapabilities({ qrencode: false, pythonQrcode: false, segno: false, pyCmd: '', mode: '' });
  ok('都没有时不可用并说明', none.available === false && /qrencode/.test(none.note));
}

console.log('== ③ 本机真跑（有引擎才跑）==');
{
  const t = probeQrTools(true);
  if (!t.mode) {
    console.log('  SKIP 本机没有 qrencode / python qrcode / segno，部署后服务器上会真跑');
  } else {
    const cfg = { convert: { enabled: true } };
    const r = await generateQrCode({ cfg, text: 'https://example.com/qr', uid: 'test-owner', isOwner: true, options: { level: 'H', scale: 8 } });
    try {
      ok('二维码 PNG 产出', r.fileName.endsWith('.png') && r.bytes > 100, JSON.stringify(r));
      const py = t.pyCmd || 'python3';
      const check = spawnSync(py, ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.format, im.size[0]==im.size[1])', r.filePath], { encoding: 'utf8' });
      ok('产出是正方形 PNG', /PNG True/.test(String(check.stdout || '')), check.stdout || check.stderr);
    } finally {
      try { fs.unlinkSync(r.filePath); } catch { /* ignore */ }
      const usage = path.join('state', 'convert-usage.json');
      try { if (fs.existsSync(usage) && fs.readFileSync(usage, 'utf8').includes('"test-owner"')) fs.unlinkSync(usage); } catch { /* ignore */ }
    }
    try { await generateQrCode({ cfg, text: '  ', uid: 'test-owner', isOwner: true }); ok('空文本拒绝', false, '没有抛错'); }
    catch (e) { ok('空文本拒绝', /空的/.test(e.message), e.message); }
  }
}

console.log(`\n${pass} passed${process.exitCode ? '，有失败' : ''}`);

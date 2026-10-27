/* ══════════════════════════════════════════════════════════════════════════
 * 二维码生成（2026-10-27 晚，ling014 工作站第三批）
 *
 * 文本/链接 → QR PNG 文件发回。实现按服务器实际有的工具自动挑：
 *   1) qrencode CLI（apt install qrencode）——最省事；
 *   2) Python qrcode 库（pip install qrcode[pil]）；
 *   3) Python segno 库。
 * 三个都没有就能力表如实说不可用。
 * 额度与文件转换共用（10 次/天，主人不限）；产物落 state/convert-out。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { reserveMediaQuota, refundMediaQuota, cleanupConvertOutputs } from './file-convert.js';

/* 控制台交付失败时回补额度用（与 file-convert 同一份小本本）。 */
export { refundMediaQuota };

const OUT_DIR = path.join(STATE_DIR, 'convert-out');
const TMP_DIR = path.join(STATE_DIR, 'qrcode-tmp');
const MAX_TEXT = 1000;

const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

let _qrTools = null;
export function probeQrTools(force = false) {
  if (_qrTools && !force) return _qrTools;
  const has = (cmd) => {
    try { return spawnSync('which', [cmd], { encoding: 'utf8', timeout: 4000 }).status === 0; } catch { return false; }
  };
  let pyCmd = '';
  const pyHas = (code) => {
    for (const cmd of ['python3', 'python']) {
      try {
        const r = spawnSync(cmd, ['-c', code], { encoding: 'utf8', timeout: 6000 });
        if (r.status === 0) { pyCmd = pyCmd || cmd; return true; }
      } catch { /* ignore */ }
    }
    return false;
  };
  _qrTools = {
    qrencode: has('qrencode'),
    pythonQrcode: pyHas('import qrcode'),
    segno: pyHas('import segno'),
    pyCmd,
    mode: has('qrencode') ? 'qrencode' : (pyHas('import qrcode') ? 'python-qrcode' : (pyHas('import segno') ? 'segno' : '')),
  };
  return _qrTools;
}

export function buildQrCapabilities(t = probeQrTools()) {
  return {
    available: !!t.mode,
    engine: t.mode || null,
    ops: t.mode ? ['qrcode'] : [],
    text: `≤${MAX_TEXT} 字符（URL / 文本 / WiFi / vCard 原样放进去）`,
    options: { level: 'L / M / Q / H 纠错（默认 M）', scale: '模块像素 1~20（默认 6）', margin: '留白 0~16（默认 4）', dark: '#RRGGBB 前景（默认黑）', light: '#RRGGBB 背景（默认白）' },
    note: t.mode ? '' : '二维码需要 qrencode（apt install qrencode）或 Python 的 qrcode / segno 库，服务器上都没装',
  };
}

export function qrCapabilities() {
  return buildQrCapabilities(probeQrTools(true));
}

export function validateQrOptions(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const level = String(o.level ?? 'M').trim().toUpperCase();
  if (!['L', 'M', 'Q', 'H'].includes(level)) throw new Error('纠错等级 level 只有 L / M / Q / H');
  const scale = o.scale == null ? 6 : Math.round(num(o.scale, 6));
  if (scale < 1 || scale > 20) throw new Error('scale（每个模块的像素）要在 1~20 之间');
  const margin = o.margin == null ? 4 : Math.round(num(o.margin, 4));
  if (margin < 0 || margin > 16) throw new Error('margin（四周留白）要在 0~16 之间');
  const dark = String(o.dark ?? '').trim();
  const light = String(o.light ?? '').trim();
  if (dark && !/^#[0-9a-fA-F]{6}$/.test(dark)) throw new Error('dark 要写成 #RRGGBB');
  if (light && !/^#[0-9a-fA-F]{6}$/.test(light)) throw new Error('light 要写成 #RRGGBB');
  return { level, scale, margin, dark, light };
}

const PY_QRCODE = String.raw`
import sys, json
dst, raw, textfile = sys.argv[1], sys.argv[2], sys.argv[3]
o = json.loads(raw)
text = open(textfile, encoding="utf-8").read()
import qrcode
from qrcode import constants
ec = getattr(constants, "ERROR_CORRECT_" + o["level"], constants.ERROR_CORRECT_M)
qr = qrcode.QRCode(error_correction=ec, box_size=int(o["scale"]), border=int(o["margin"]))
qr.add_data(text)
qr.make(fit=True)
img = qr.make_image(fill_color=o.get("dark") or "black", back_color=o.get("light") or "white")
img.save(dst)
print(json.dumps({"engine": "python-qrcode", "modules": qr.modules_count}))
`;

const PY_SEGNO = String.raw`
import sys, json
dst, raw, textfile = sys.argv[1], sys.argv[2], sys.argv[3]
o = json.loads(raw)
text = open(textfile, encoding="utf-8").read()
import segno
qr = segno.make(text, error=o["level"].lower())
qr.save(dst, scale=int(o["scale"]), border=int(o["margin"]),
        dark=o.get("dark") or "#000000", light=o.get("light") or "#FFFFFF")
print(json.dumps({"engine": "segno", "version": qr.version}))
`;

export async function generateQrCode({ cfg, text, uid, isOwner, options } = {}) {
  const t = probeQrTools();
  if (!t.mode) throw new Error('二维码需要 qrencode（apt install qrencode）或 Python 的 qrcode / segno 库，服务器上都没装');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const theText = String(text ?? '');
  if (!theText.trim()) throw new Error('要生成二维码的内容是空的（text）');
  if (theText.length > MAX_TEXT) throw new Error(`内容 ${theText.length} 字符，二维码最多 ${MAX_TEXT} 字符`);
  const opts = validateQrOptions(options);
  reserveMediaQuota({ cfg, uid: requester, isOwner: isOwner === true });

  ensureDir(OUT_DIR);
  const tmp = ensureDir(path.join(TMP_DIR, `qr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));
  const started = Date.now();
  try {
    const dst = path.join(tmp, 'qrcode.png');
    let info = {};
    if (t.mode === 'qrencode') {
      const args = ['-8', '-o', dst, '-s', String(opts.scale), '-l', opts.level, '-m', String(opts.margin)];
      if (opts.dark) args.push(`--foreground=${opts.dark.replace('#', '')}`);
      if (opts.light) args.push(`--background=${opts.light.replace('#', '')}`);
      args.push(theText);
      const r = spawnSync('qrencode', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      if (r.error) throw new Error(`qrencode 启动失败：${r.error.message}`);
      if (r.status !== 0) throw new Error(`qrencode 失败：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
      info = { engine: 'qrencode' };
    } else {
      const textFile = path.join(tmp, 'text.txt');
      fs.writeFileSync(textFile, theText, 'utf8');
      const script = t.mode === 'python-qrcode' ? PY_QRCODE : PY_SEGNO;
      const r = spawnSync(t.pyCmd, ['-c', script, dst, JSON.stringify(opts), textFile], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      if (r.error) throw new Error(`${t.pyCmd} 启动失败：${r.error.message}`);
      if (r.status !== 0) throw new Error(`二维码生成失败：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
      try { info = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop() || '{}'); } catch { /* ignore */ }
    }
    if (!fs.existsSync(dst)) throw new Error('二维码没有产出文件');
    const outBytes = fs.statSync(dst).size;
    const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let fileName = `qrcode-${stamp}.png`;
    let outPath = path.join(OUT_DIR, fileName);
    for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
      fileName = `qrcode-${stamp}-${n}.png`;
      outPath = path.join(OUT_DIR, fileName);
    }
    fs.copyFileSync(dst, outPath);
    cleanupConvertOutputs();
    log(`[qrcode] ${opts.level} scale=${opts.scale} ${outBytes}B ${info.engine ?? ''} uid=${requester}`);
    return { ok: true, filePath: outPath, fileName, op: 'qrcode', engine: info.engine ?? t.mode, bytes: outBytes, ms: Date.now() - started };
  } catch (e) {
    refundMediaQuota(requester, isOwner === true);
    throw e;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

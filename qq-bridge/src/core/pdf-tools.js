/* ══════════════════════════════════════════════════════════════════════════
 * PDF 工具（2026-10-27 晚，ling014 工作站第二批）：合并 / 拆分 / 加水印
 *
 * 依赖 Python 的 pypdf（合并/拆分/贴水印）+ reportlab（生成水印 stamp 层）。
 * 没装就能力表明确说不可用，不假装。加密 PDF 一律拒绝并给一句人话。
 *
 * 设计要点：
 *   · 合并：多个 PDF 按顺序拼成一个（pypdf writer.append）。
 *   · 拆分：两种形态——按页码抽取（"1-3,5" → 一个 PDF）或每 N 页一拆
 *     （产出多个 PDF → 打包成 ZIP 一次发回，zip 用标准库 zipfile）。
 *   · 水印：reportlab 先按首页尺寸画一层 stamp（文字或图片、九宫格/tile、
 *     透明度、旋转角），再逐页 merge 到源 PDF 上；页面尺寸不齐时等比缩放置中。
 *   · 中文字体：reportlab 只吃 TrueType 轮廓，逐个尝试 image-edit 的候选
 *     （wqy/uming/simhei 优先）；全失败且文字含非 ASCII 时如实报错。
 *   · 额度与文件转换共用（10 次/天，主人不限）；产物落 state/convert-out。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { probeTools, convertCfg, reserveMediaQuota, commitMediaQuota, cleanupConvertOutputs } from './file-convert.js';
import { watermarkFontCandidates, normalizeWatermarkColor } from './image-edit.js';

const OUT_DIR = path.join(STATE_DIR, 'convert-out');
const TMP_DIR = path.join(STATE_DIR, 'convert-tmp');

const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* ── 依赖探测 ── */
let _pdfTools = null;
export function probePdfTools(force = false) {
  if (_pdfTools && !force) return _pdfTools;
  const pyOk = (code) => {
    for (const cmd of ['python3', 'python']) {
      try {
        const r = spawnSync(cmd, ['-c', code], { encoding: 'utf8', timeout: 6000 });
        if (r.status === 0) return { ok: true, cmd };
      } catch { /* ignore */ }
    }
    return { ok: false, cmd: '' };
  };
  const pypdf = pyOk('import pypdf');
  const pypdfCmd = pypdf.ok ? pypdf.cmd : pyOk('import PyPDF2').cmd;
  const reportlab = pyOk('import reportlab');
  _pdfTools = {
    pypdf: !!pypdfCmd,
    pypdfCmd,
    reportlab: reportlab.ok && reportlab.cmd === pypdfCmd ? true : reportlab.ok,
    reportlabCmd: reportlab.ok ? reportlab.cmd : '',
    fonts: watermarkFontCandidates(),
  };
  return _pdfTools;
}

export function buildPdfCapabilities(t = probePdfTools()) {
  const engine = !!t.pypdf;
  return {
    available: engine,
    pypdf: engine,
    reportlab: !!t.reportlab,
    ops: engine ? ['merge', 'split', 'watermark'] : [],
    merge: engine ? { min: 2, max: 20 } : null,
    split: engine ? { pages: '如 "1-3,5" 抽页成一个 PDF', every: '每 N 页一拆，产出 ZIP（1~500）' } : null,
    watermark: engine ? {
      types: ['text', 'image'],
      positions: ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right', 'tile'],
      rotation: '-180~180 度，正值顺时针（防盗平铺常用 -20 或 30~45）',
      fontSize: '磅值 8-144，或 fontSizePct=页宽百分比（默认 5%，与网页版一致）',
      density: '平铺密度 1-20，越大越密（默认 5）',
      color: '#RRGGBB（模型负责把"红色"这类口语翻成 hex）',
      font: t.fonts.cjk.length ? 'cjk-ok' : 'missing-cjk-font（中文水印需要 fonts-wqy-zenhei）',
      needs: t.reportlab ? '' : '加水印还需要 python3-reportlab',
    } : null,
    note: engine ? '' : 'PDF 工具需要 Python pypdf（pip install pypdf 或 apt install python3-pypdf）',
  };
}

export function pdfCapabilities() {
  return buildPdfCapabilities(probePdfTools(true));
}

/* ── 纯函数：页码解析 "1-3,5" → [1,2,3,5]（1 起始、去重保序、上限 1000 页）── */
export function parsePageRange(str, maxPages = null) {
  const s = String(str ?? '').trim();
  if (!s) throw new Error('页码范围是空的，写成 "1-3,5" 这种');
  const out = [];
  const seen = new Set();
  for (const part of s.split(/[,，]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(p);
    if (!m) throw new Error(`页码 "${p}" 看不懂；写成 3 或 1-3`);
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    if (a < 1 || b < 1) throw new Error('页码从 1 开始，不能有 0 或负数');
    if (b < a) throw new Error(`范围 "${p}" 起止反了`);
    for (let i = a; i <= b; i += 1) {
      if (!seen.has(i)) { seen.add(i); out.push(i); }
      if (out.length > 1000) throw new Error('一次最多抽 1000 页');
    }
  }
  if (!out.length) throw new Error('页码范围是空的');
  if (maxPages && out.some((p) => p > maxPages)) throw new Error(`页码超出范围：这份 PDF 只有 ${maxPages} 页`);
  return out;
}

/* ── 纯校验：水印参数 ── */
export function validatePdfWatermarkOptions(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const text = String(o.text ?? '');
  const position = String(o.position ?? 'bottom-right').trim().toLowerCase();
  if (!['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right', 'tile'].includes(position)) {
    throw new Error('position 只有 top-left/top/top-right/left/center/right/bottom-left/bottom/bottom-right/tile');
  }
  const fontSize = o.fontSize == null ? 0 : Math.round(num(o.fontSize, 36));
  if (fontSize && (fontSize < 8 || fontSize > 144)) throw new Error('fontSize 要在 8~144 之间（PDF 是磅值）');
  /* 工作站对齐：字号默认相对页宽 5%；给了 fontSizePct 就按页宽百分比。 */
  const fontSizePct = o.fontSizePct == null ? (fontSize ? 0 : 5) : num(o.fontSizePct, 5);
  if (fontSizePct && (fontSizePct < 1 || fontSizePct > 50)) throw new Error('fontSizePct（字号占页宽百分比）要在 1~50 之间');
  const color = normalizeWatermarkColor(o.color, '#888888');
  const opacity = o.opacity == null ? 0.5 : num(o.opacity, 0.5);
  if (!(opacity > 0 && opacity <= 1)) throw new Error('opacity 要在 0.01~1 之间');
  const margin = o.margin == null ? 24 : Math.round(num(o.margin, 24));
  if (margin < 0 || margin > 200) throw new Error('margin 要在 0~200pt 之间');
  const rotation = o.rotation == null ? 0 : num(o.rotation, 0);
  if (rotation < -180 || rotation > 180) throw new Error('rotation 要在 -180~180 度之间（正值为顺时针）');
  const density = o.density == null ? 5 : Math.round(num(o.density, 5));
  if (density < 1 || density > 20) throw new Error('density（平铺密度）要在 1~20 之间，越大越密');
  const scale = o.scale == null ? 0.25 : num(o.scale, 0.25);
  if (!(scale >= 0.02 && scale <= 1)) throw new Error('scale（图片水印宽度占页宽比）要在 0.02~1 之间');
  return { text, position, fontSize, fontSizePct, color, opacity, margin, rotation, density, scale };
}

/* ── Python 脚本 ── */
const PY_MERGE = String.raw`
import sys, json
src_out, raw = sys.argv[1], sys.argv[2]
files = json.loads(raw)
try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    from PyPDF2 import PdfReader, PdfWriter
w = PdfWriter()
n = 0
for f in files:
    r = PdfReader(f)
    if getattr(r, "is_encrypted", False):
        raise SystemExit("有一份 PDF 设了密码，先解密再合并")
    w.append(r)
    n += len(r.pages)
if n <= 0:
    raise SystemExit("合并结果没有页面")
w.write(src_out)
print(json.dumps({"pages": n, "inputs": len(files)}))
`;

const PY_SPLIT = String.raw`
import sys, json, os, zipfile
src, dst, raw = sys.argv[1], sys.argv[2], sys.argv[3]
o = json.loads(raw)
try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    from PyPDF2 import PdfReader, PdfWriter
r = PdfReader(src)
if getattr(r, "is_encrypted", False):
    raise SystemExit("这份 PDF 设了密码，先解密再拆分")
total = len(r.pages)
if total <= 0:
    raise SystemExit("PDF 没有页面")
pages = o.get("pages")
every = int(o.get("every") or 0)
if pages:
    idx = [p - 1 for p in pages]
    for i in idx:
        if i < 0 or i >= total:
            raise SystemExit("页码 %d 超出范围（共 %d 页）" % (i + 1, total))
    w = PdfWriter()
    for i in idx:
        w.add_page(r.pages[i])
    w.write(dst)
    print(json.dumps({"mode": "range", "pages": len(idx), "total": total}))
elif every > 0:
    tmpdir = o["tmpdir"]
    chunks = []
    for start in range(0, total, every):
        w = PdfWriter()
        for i in range(start, min(start + every, total)):
            w.add_page(r.pages[i])
        name = "part-%03d.pdf" % (start // every + 1)
        w.write(os.path.join(tmpdir, name))
        chunks.append(name)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for name in chunks:
            z.write(os.path.join(tmpdir, name), name)
    print(json.dumps({"mode": "every", "every": every, "total": total, "parts": len(chunks)}))
else:
    raise SystemExit('要给 pages（如 "1-3,5"）或 every（每 N 页一拆）')
`;

const PY_WATERMARK = String.raw`
import sys, json, os
src, dst, raw = sys.argv[1], sys.argv[2], sys.argv[3]
o = json.loads(raw)
tmpdir = os.path.dirname(dst)
try:
    from pypdf import PdfReader, PdfWriter, Transformation
except ImportError:
    from PyPDF2 import PdfReader, PdfWriter, Transformation
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
r = PdfReader(src)
if getattr(r, "is_encrypted", False):
    raise SystemExit("这份 PDF 设了密码，请先解密再加水印")
pages = r.pages
if not len(pages):
    raise SystemExit("PDF 没有页面")
W = float(pages[0].mediabox.width)
H = float(pages[0].mediabox.height)
font_name = ""
for cand in (o.get("fonts") or []):
    try:
        pdfmetrics.registerFont(TTFont("WMF", cand, subfontIndex=0))
        font_name = "WMF"
        break
    except Exception:
        continue
text = str(o.get("text") or "")
has_img = bool(o.get("wmPath"))
if not font_name and not has_img:
    if any(ord(ch) > 127 for ch in text):
        raise SystemExit("reportlab 注册不了任何候选字体，中文水印做不了；装 fonts-wqy-zenhei 后重试")
    font_name = "Helvetica"
opacity = max(0.01, min(1.0, float(o.get("opacity", 0.5))))
margin = float(o.get("margin", 24))
rot = float(o.get("rotation") or 0)
pos = o.get("position") or "bottom-right"
stamp_path = os.path.join(tmpdir, "stamp.pdf")
c = canvas.Canvas(stamp_path, pagesize=(W, H))
c.setFillColor(HexColor(o.get("color") or "#888888"))
c.setFillAlpha(opacity)
line_h = 0.0
if has_img:
    from PIL import Image as PILImage
    from reportlab.lib.utils import ImageReader
    im = PILImage.open(o["wmPath"]).convert("RGBA")
    if opacity < 1.0:
        im.putalpha(im.getchannel("A").point(lambda v: int(v * opacity)))
    wm_png = os.path.join(tmpdir, "wm.png")
    im.save(wm_png)
    bw = W * min(1.0, max(0.02, float(o.get("scale", 0.25))))
    bh = bw * im.height / im.width
    img = ImageReader(wm_png)
    def draw_one(x, y):
        c.saveState(); c.translate(x, y); c.rotate(rot)
        c.drawImage(img, -bw / 2, -bh / 2, bw, bh, mask="auto")
        c.restoreState()
else:
    size = float(o.get("fontSize") or 0)
    if not size and o.get("fontSizePct"):
        size = W * min(50.0, max(1.0, float(o["fontSizePct"]))) / 100.0
    if not size:
        size = W * 0.05
    lines = text.split("\n")
    if font_name:
        c.setFont(font_name, size)
    bw = max(pdfmetrics.stringWidth(ln, font_name, size) for ln in lines)
    line_h = size * 1.3
    bh = line_h * len(lines)
    def draw_one(x, y):
        c.saveState(); c.translate(x, y); c.rotate(rot)
        if font_name:
            c.setFont(font_name, size)
        y0 = (len(lines) - 1) * line_h / 2
        for i, ln in enumerate(lines):
            c.drawCentredString(0, y0 - i * line_h, ln)
        c.restoreState()
def anchor():
    if pos == "top-left": return margin + bw / 2, H - margin - bh / 2
    if pos == "top": return W / 2, H - margin - bh / 2
    if pos == "top-right": return W - margin - bw / 2, H - margin - bh / 2
    if pos == "left": return margin + bw / 2, H / 2
    if pos == "center": return W / 2, H / 2
    if pos == "right": return W - margin - bw / 2, H / 2
    if pos == "bottom-left": return margin + bw / 2, margin + bh / 2
    if pos == "bottom": return W / 2, margin + bh / 2
    return W - margin - bw / 2, margin + bh / 2
if pos == "tile":
    dens = max(1, min(20, int(o.get("density") or 5)))
    gapf = max(0.2, (18.0 - dens) / 6.5)
    sx = bw * gapf + margin
    sy = bh * gapf * 1.4 + margin
    y = bh / 2
    row = 0
    while y - bh / 2 < H:
        x = -(row % 2) * sx / 2 + bw / 2
        while x - bw / 2 < W:
            draw_one(x, y)
            x += sx
        y += sy
        row += 1
else:
    ax, ay = anchor()
    draw_one(ax, ay)
c.save()
stamp_r = PdfReader(stamp_path)
sp = stamp_r.pages[0]
sw, sh = float(sp.mediabox.width), float(sp.mediabox.height)
w = PdfWriter()
for page in pages:
    pw, ph = float(page.mediabox.width), float(page.mediabox.height)
    try:
        s = min(pw / sw, ph / sh)
        page.merge_transformed_page(sp, Transformation().scale(s, s).translate((pw - sw * s) / 2, (ph - sh * s) / 2))
    except AttributeError:
        page.merge_page(sp)
    w.add_page(page)
w.write(dst)
try:
    os.remove(stamp_path)
except OSError:
    pass
print(json.dumps({"pages": len(pages), "position": pos}))
`;

function run(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) {
    const msg = `${r.stderr || r.stdout || ''}`.trim().slice(0, 300);
    throw new Error(`${cmd} 退出码 ${r.status}${msg ? `：${msg}` : ''}`);
  }
  return r;
}

function parseInfo(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop() || '{}'); } catch { return {}; }
}

function stampOut(base, suffix, ext) {
  const clean = String(base || 'pdf').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || 'pdf';
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  let fileName = `${clean}-${suffix}-${stamp}.${ext}`;
  let outPath = path.join(OUT_DIR, fileName);
  for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
    fileName = `${clean}-${suffix}-${stamp}-${n}.${ext}`;
    outPath = path.join(OUT_DIR, fileName);
  }
  return { fileName, outPath };
}

function checkInOut(outBytes) {
  const c = convertCfg({});
  if (outBytes > c.maxOutputBytes) {
    throw new Error(`产物 ${(outBytes / 1048576).toFixed(1)}MB，超过 ${(c.maxOutputBytes / 1048576).toFixed(0)}MB 上限`);
  }
}

/* ── 合并 ── */
export async function pdfMerge({ cfg, files, uid, isOwner } = {}) {
  const t = probePdfTools();
  if (!t.pypdf) throw new Error('PDF 合并需要 Python pypdf（pip install pypdf），服务器上没装');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const list = Array.isArray(files) ? files.filter((x) => x?.buf?.length) : [];
  if (list.length < 2) throw new Error('合并至少要 2 份 PDF');
  if (list.length > 20) throw new Error(`一次最多合并 20 份，这次给了 ${list.length} 份`);
  const c = convertCfg(cfg);
  for (const f of list) {
    if (!/^\.?pdf$/i.test(path.extname(String(f.name || 'x.pdf')))) throw new Error(`「${f.name}」不是 PDF`);
    if (f.buf.length > c.maxInputBytes) throw new Error(`有一份 ${(f.buf.length / 1048576).toFixed(1)}MB，超过 ${(c.maxInputBytes / 1048576).toFixed(0)}MB 上限`);
  }
  const total = list.reduce((s, f) => s + f.buf.length, 0);
  if (total > c.maxOutputBytes) throw new Error(`文件总量 ${(total / 1048576).toFixed(0)}MB，超过 ${(c.maxOutputBytes / 1048576).toFixed(0)}MB 上限`);
  const { u } = reserveMediaQuota({ cfg, uid: requester, isOwner: isOwner === true });
  ensureDir(OUT_DIR);
  const tmp = ensureDir(path.join(TMP_DIR, `pdfm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));
  const started = Date.now();
  try {
    const paths = list.map((f, i) => {
      const p = path.join(tmp, `in-${String(i + 1).padStart(2, '0')}.pdf`);
      fs.writeFileSync(p, f.buf);
      return p;
    });
    const dst = path.join(tmp, 'merged.pdf');
    const info = parseInfo(run(t.pypdfCmd, ['-c', PY_MERGE, dst, JSON.stringify(paths)], c.timeoutMs));
    if (!fs.existsSync(dst)) throw new Error('合并没有产出文件');
    const outBytes = fs.statSync(dst).size;
    checkInOut(outBytes);
    const { fileName, outPath } = stampOut('merged', 'pdf', 'pdf');
    fs.copyFileSync(dst, outPath);
    commitMediaQuota(u, requester, isOwner === true);
    cleanupConvertOutputs();
    log(`[pdf] merge ${info.inputs ?? list.length} 份 → ${info.pages ?? '?'} 页：${fileName} uid=${requester}`);
    return { ok: true, filePath: outPath, fileName, op: 'merge', pages: info.pages, inputs: list.length, bytes: outBytes, ms: Date.now() - started };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── 拆分 ── */
export async function pdfSplit({ cfg, name, buf, uid, isOwner, options } = {}) {
  const t = probePdfTools();
  if (!t.pypdf) throw new Error('PDF 拆分需要 Python pypdf（pip install pypdf），服务器上没装');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  if (!buf?.length) throw new Error('PDF 内容为空');
  const o = options && typeof options === 'object' ? options : {};
  const hasPages = o.pages != null && String(o.pages).trim();
  const every = o.every == null ? 0 : Math.round(num(o.every));
  if (hasPages && every > 0) throw new Error('pages 和 every 二选一');
  let pages = null;
  if (hasPages) pages = parsePageRange(o.pages);
  else if (every > 0) {
    if (every < 1 || every > 500) throw new Error('every（每几页一拆）要在 1~500 之间');
  } else throw new Error('拆分要给 pages（如 "1-3,5"）或 every（每 N 页一拆）');
  const c = convertCfg(cfg);
  if (buf.length > c.maxInputBytes) throw new Error(`PDF ${(buf.length / 1048576).toFixed(1)}MB，超过 ${(c.maxInputBytes / 1048576).toFixed(0)}MB 上限`);
  const { u } = reserveMediaQuota({ cfg, uid: requester, isOwner: isOwner === true });
  ensureDir(OUT_DIR);
  const tmp = ensureDir(path.join(TMP_DIR, `pdfs-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));
  const started = Date.now();
  try {
    const src = path.join(tmp, 'input.pdf');
    fs.writeFileSync(src, buf);
    const base = path.basename(String(name || 'pdf'), path.extname(String(name || '')));
    const expectZip = !hasPages;
    const dst = path.join(tmp, expectZip ? 'parts.zip' : 'out.pdf');
    const info = parseInfo(run(t.pypdfCmd, ['-c', PY_SPLIT, src, dst, JSON.stringify({ pages, every, tmpdir: tmp })], c.timeoutMs));
    if (!fs.existsSync(dst)) throw new Error('拆分没有产出文件');
    const outBytes = fs.statSync(dst).size;
    checkInOut(outBytes);
    const { fileName, outPath } = stampOut(base, info.mode === 'every' ? `split${every}` : 'extract', expectZip ? 'zip' : 'pdf');
    fs.copyFileSync(dst, outPath);
    commitMediaQuota(u, requester, isOwner === true);
    cleanupConvertOutputs();
    log(`[pdf] split ${info.mode} 共 ${info.total ?? '?'} 页：${fileName} uid=${requester}`);
    return {
      ok: true, filePath: outPath, fileName, op: 'split', mode: info.mode,
      pages: info.mode === 'range' ? info.pages : undefined, every: info.mode === 'every' ? every : undefined,
      total: info.total, parts: info.parts, bytes: outBytes, ms: Date.now() - started,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── 加水印 ── */
export async function pdfWatermark({ cfg, name, buf, watermarkBuf, watermarkName, uid, isOwner, options } = {}) {
  const t = probePdfTools();
  if (!t.pypdf) throw new Error('PDF 加水印需要 Python pypdf（pip install pypdf），服务器上没装');
  if (!t.reportlab) throw new Error('PDF 加水印还需要 python3-reportlab（生成水印层），服务器上没装');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  if (!buf?.length) throw new Error('PDF 内容为空');
  const opts = validatePdfWatermarkOptions(options);
  if (!opts.text.trim() && !watermarkBuf?.length) throw new Error('加水印需要 text（文字）或水印图片（watermarkMessageId）');
  if (opts.text.trim() && watermarkBuf?.length) throw new Error('文字水印和图片水印一次用一个就好');
  const needCjk = /[^\x00-\x7F]/.test(opts.text);
  if (opts.text.trim() && needCjk && !t.fonts.cjk.length) {
    throw new Error('中文水印需要中文字体（Debian/Ubuntu: apt install fonts-wqy-zenhei），服务器上没装');
  }
  const c = convertCfg(cfg);
  if (buf.length > c.maxInputBytes) throw new Error(`PDF ${(buf.length / 1048576).toFixed(1)}MB，超过 ${(c.maxInputBytes / 1048576).toFixed(0)}MB 上限`);
  const { u } = reserveMediaQuota({ cfg, uid: requester, isOwner: isOwner === true });
  ensureDir(OUT_DIR);
  const tmp = ensureDir(path.join(TMP_DIR, `pdfw-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));
  const started = Date.now();
  try {
    const src = path.join(tmp, 'input.pdf');
    fs.writeFileSync(src, buf);
    if (watermarkBuf?.length) {
      if (watermarkBuf.length > c.maxInputBytes) throw new Error('水印图片太大');
      opts.wmPath = path.join(tmp, `wm${path.extname(String(watermarkName || '')) || '.png'}`);
      fs.writeFileSync(opts.wmPath, watermarkBuf);
    }
    opts.fonts = t.fonts.all;
    const dst = path.join(tmp, 'out.pdf');
    const info = parseInfo(run(t.pypdfCmd, ['-c', PY_WATERMARK, src, dst, JSON.stringify(opts)], c.timeoutMs));
    if (!fs.existsSync(dst)) throw new Error('加水印没有产出文件');
    const outBytes = fs.statSync(dst).size;
    checkInOut(outBytes);
    const base = path.basename(String(name || 'pdf'), path.extname(String(name || '')));
    const { fileName, outPath } = stampOut(base, 'watermark', 'pdf');
    fs.copyFileSync(dst, outPath);
    commitMediaQuota(u, requester, isOwner === true);
    cleanupConvertOutputs();
    log(`[pdf] watermark ${info.position} × ${info.pages ?? '?'} 页：${fileName} uid=${requester}`);
    return { ok: true, filePath: outPath, fileName, op: 'watermark', pages: info.pages, position: opts.position, bytes: outBytes, ms: Date.now() - started };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

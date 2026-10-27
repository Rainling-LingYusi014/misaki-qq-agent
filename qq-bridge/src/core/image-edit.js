/* ══════════════════════════════════════════════════════════════════════════
 * 图片编辑（2026-10-27）：压缩 / 缩放 / 裁剪 / 图形裁剪 / 水印 / 多图合成 GIF
 *
 * 为什么用 Pillow：这些操作里"图形裁剪"需要 alpha 遮罩，ffmpeg 能做但表达式
 * 难维护；Pillow 的 ImageDraw 一行一个形状，且能同时做 targetKB 迭代压缩。
 * 所以本模块要求 python3 + Pillow（python3-pil）。没装就如实说不可用，不假装。
 *
 * 2026-10-27 晚补（ling014 工作站对齐）：
 *   · watermark：文字/图片水印，9 宫格定位或平铺；文字水印要中文字体，
 *     找不到 CJK 字体时如实报错（提示装 fonts-wqy-zenhei），不输出方框糊弄。
 *   · gif：2~60 张图合成动图；fps 优先于 delay；宽度过大/帧数过多时如实报错。
 *
 * 与文件转换共用：
 *   · 同一条私聊身份绑定；
 *   · 同一份额度（state/convert-usage.json，10 次/天，主人不限）；
 *   · 同一个上传通道（转换结果以文件发回，不发图片消息，避免 QQ 二次压缩）。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { probeTools, fetchImageFromMessage, reserveMediaQuota, commitMediaQuota } from './file-convert.js';

const OUT_DIR = path.join(STATE_DIR, 'image-out');
const TMP_DIR = path.join(STATE_DIR, 'image-tmp');
const MAX_BYTES = 50 * 1024 * 1024;
const RETENTION_DAYS = 3;

const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* 水印字体：优先 CJK（中文水印必需），arial/DejaVu 只配纯 ASCII 文本。
 * 服务器装 fonts-wqy-zenhei 或 Noto CJK 后自动生效；Windows 本机用 msyh 测试。 */
const FONT_CANDIDATES = [
  { cjk: true, paths: ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyh.ttf', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf', '/usr/share/fonts/truetype/arphic/uming.ttc', '/usr/share/fonts/truetype/arphic/ukai.ttc'] },
  { cjk: false, paths: ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'] },
];
let _fontCache = null;
function findWatermarkFont(needCjk) {
  if (!_fontCache) {
    _fontCache = { cjk: '', any: '' };
    for (const group of FONT_CANDIDATES) {
      for (const p of group.paths) {
        try { if (fs.existsSync(p)) { _fontCache.any = _fontCache.any || p; if (group.cjk) _fontCache.cjk = _fontCache.cjk || p; break; } } catch { /* ignore */ }
      }
    }
  }
  return needCjk ? _fontCache.cjk : (_fontCache.cjk || _fontCache.any);
}

/* 水印颜色：常用中文/口语词 → 十六进制；模型把自然语言翻译成 hex，
 * 这里兜一层最常用的词，认不出的词给人话（不会瞎猜一个颜色）。 */
const COLOR_ALIASES = {
  '红': '#FF0000', '红色': '#FF0000', '粉': '#FFC0CB', '粉色': '#FFC0CB', '粉红': '#FFC0CB',
  '橙': '#FFA500', '橙色': '#FFA500', '黄': '#FFFF00', '黄色': '#FFFF00',
  '绿': '#008000', '绿色': '#008000', '青': '#00FFFF', '青色': '#00FFFF',
  '蓝': '#0000FF', '蓝色': '#0000FF', '紫': '#800080', '紫色': '#800080',
  '金': '#FFD700', '金色': '#FFD700', '银': '#C0C0C0', '银色': '#C0C0C0',
  '黑': '#000000', '黑色': '#000000', '白': '#FFFFFF', '白色': '#FFFFFF',
  '灰': '#808080', '灰色': '#808080', '浅灰': '#D3D3D3', '深灰': '#696969',
  '棕': '#8B4513', '棕色': '#8B4513', '褐': '#8B4513', '褐色': '#8B4513',
};
export function normalizeWatermarkColor(v, fallback = '#FFFFFF') {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  const hit = COLOR_ALIASES[s];
  if (hit) return hit;
  throw new Error(`颜色「${s.slice(0, 12)}」认不出；给 #RRGGBB，或常用词：${Object.keys(COLOR_ALIASES).filter((k) => k.length <= 2).slice(0, 14).join('/')}`);
}

/* 给其他模块（PDF 水印的 reportlab）用的字体候选：存在的文件，CJK 在前。
 * reportlab 只吃 TrueType 轮廓；候选里 wqy/uming/simhei 是 TrueType，
 * Noto CJK 的 .otf 是 CFF 轮廓会被它拒——所以 python 侧逐个尝试、失败换下一个。 */
export function watermarkFontCandidates() {
  findWatermarkFont(true);
  const cjk = FONT_CANDIDATES[0].paths.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const any = FONT_CANDIDATES[1].paths.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
  return { cjk, any, all: [...cjk, ...any] };
}

export function buildImageCapabilities(t = probeTools()) {
  return {
    available: !!t.pillow,
    pillow: !!t.pillow,
    pyCmd: t.pyCmd || '',
    actions: t.pillow ? ['compress', 'resize', 'crop', 'shape', 'watermark', 'gif', 'demo-watermark'] : [],
    formats: ['jpg', 'png', 'webp'],
    shapes: t.pillow ? ['circle', 'rounded', 'ellipse'] : [],
    watermark: t.pillow ? {
      types: ['text', 'image'],
      positions: ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right', 'tile'],
      font: findWatermarkFont(true) ? 'cjk-ok' : 'missing-cjk-font (中文水印需要 fonts-wqy-zenhei 或 Noto CJK)',
    } : null,
    gif: t.pillow ? { minFrames: 2, maxFrames: 60, delayMs: '20-10000', fps: '0.5-30', width: '16-1280' } : null,
    batch: t.pillow ? { min: 2, max: 12, note: 'messageIds 多张 + 同一组参数逐张处理，打包成 ZIP 发回' } : null,
    note: t.pillow ? '' : '图片编辑需要 Python Pillow（Debian/Ubuntu: apt install python3-pil）',
  };
}

export function imageCapabilities() {
  return buildImageCapabilities(probeTools(true));
}

/** 纯校验：把模型传进来的松散参数收成可执行参数。 */
export function validateImageOptions(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const action = String(o.action ?? 'compress').trim().toLowerCase();
  if (!['compress', 'resize', 'crop', 'shape', 'watermark', 'gif'].includes(action)) {
    throw new Error('action 只有 compress / resize / crop / shape / watermark / gif');
  }
  let format = String(o.format ?? 'png').trim().toLowerCase().replace(/^\./, '');
  if (format === 'jpeg') format = 'jpg';
  if (action === 'gif') format = 'gif';
  if (!['jpg', 'png', 'webp', 'gif'].includes(format)) throw new Error('输出格式只有 jpg / png / webp（gif 动图合成固定为 gif）');

  const width = o.width == null ? 0 : Math.round(num(o.width));
  const height = o.height == null ? 0 : Math.round(num(o.height));
  if ((width && (width < 16 || width > 8192)) || (height && (height < 16 || height > 8192))) {
    throw new Error('宽高必须在 16~8192 之间');
  }
  if (action === 'gif' && width > 1280) throw new Error('GIF 宽度最大 1280（太大文件会爆炸）');
  const maxDim = o.maxDim == null ? 0 : Math.round(num(o.maxDim));
  if (maxDim && (maxDim < 16 || maxDim > 8192)) throw new Error('maxDim 必须在 16~8192 之间');
  const quality = o.quality == null ? 85 : Math.round(num(o.quality, 85));
  if (quality < 1 || quality > 100) throw new Error('quality 必须在 1~100 之间');
  const targetKB = o.targetKB == null ? 0 : Math.round(num(o.targetKB));
  if (targetKB && (targetKB < 1 || targetKB > 50000)) throw new Error('targetKB 必须在 1~50000 之间');

  const mode = String(o.mode ?? 'fit').trim().toLowerCase();
  if (!['fit', 'crop', 'stretch'].includes(mode)) throw new Error('mode 只有 fit / crop / stretch');

  let crop = null;
  if (o.crop != null) {
    if (!Array.isArray(o.crop) || o.crop.length !== 4) throw new Error('crop 需要 [x, y, 宽, 高] 四个数字');
    const [x, y, w, h] = o.crop.map((v) => Math.round(num(v)));
    if (x < 0 || y < 0 || w <= 0 || h <= 0) throw new Error('crop 的 x/y 不能为负，宽/高必须大于 0');
    crop = [x, y, w, h];
  }
  let aspect = '';
  if (o.aspect != null && String(o.aspect).trim()) {
    aspect = String(o.aspect).trim();
    if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(aspect)) throw new Error('aspect 要写成 1:1 / 16:9 这种比例');
    const [a, b] = aspect.split(':').map(Number);
    if (!(a > 0 && b > 0)) throw new Error('aspect 的比例必须大于 0');
  }
  const shape = String(o.shape ?? '').trim().toLowerCase();
  if (shape && !['circle', 'rounded', 'ellipse'].includes(shape)) throw new Error('shape 只有 circle / rounded / ellipse');
  const radius = o.radius == null ? 0 : Math.round(num(o.radius));
  if (radius && (radius < 1 || radius > 4096)) throw new Error('radius 必须在 1~4096 之间');

  /* 水印：文字或图片；position 十宫格（含 tile 平铺）。 */
  let watermark = null;
  if (o.watermark != null) {
    if (typeof o.watermark !== 'object' || Array.isArray(o.watermark)) throw new Error('watermark 要写成对象 {text/position/opacity/...}');
    const w = o.watermark;
    const wtype = String(w.type ?? '').trim().toLowerCase();
    if (wtype && !['text', 'image'].includes(wtype)) throw new Error('watermark.type 只有 text / image');
    const position = String(w.position ?? 'bottom-right').trim().toLowerCase();
    if (!['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right', 'tile'].includes(position)) {
      throw new Error('watermark.position 只有 top-left/top/top-right/left/center/right/bottom-left/bottom/bottom-right/tile');
    }
    const fontSize = w.fontSize == null ? 0 : Math.round(num(w.fontSize));
    if (fontSize && (fontSize < 8 || fontSize > 512)) throw new Error('watermark.fontSize 要在 8~512 之间');
    const fontSizePct = w.fontSizePct == null ? 0 : num(w.fontSizePct);
    if (fontSizePct && (fontSizePct < 1 || fontSizePct > 50)) throw new Error('watermark.fontSizePct（字号占图宽百分比）要在 1~50 之间');
    const color = normalizeWatermarkColor(w.color, '#FFFFFF');
    const opacity = w.opacity == null ? 0.65 : num(w.opacity, 0.65);
    if (!(opacity > 0 && opacity <= 1)) throw new Error('watermark.opacity 要在 0.01~1 之间');
    const margin = w.margin == null ? 12 : Math.round(num(w.margin, 12));
    if (margin < 0 || margin > 512) throw new Error('watermark.margin 要在 0~512 之间');
    const scale = w.scale == null ? 0.25 : num(w.scale, 0.25);
    if (!(scale >= 0.02 && scale <= 1)) throw new Error('watermark.scale（图片水印宽度占比）要在 0.02~1 之间');
    const rotation = w.rotation == null ? 0 : num(w.rotation, 0);
    if (rotation < -180 || rotation > 180) throw new Error('watermark.rotation 要在 -180~180 度之间（正值为顺时针）');
    const density = w.density == null ? 5 : Math.round(num(w.density, 5));
    if (density < 1 || density > 20) throw new Error('watermark.density（平铺密度）要在 1~20 之间，越大越密');
    const text = String(w.text ?? '');
    watermark = { type: wtype === 'image' ? 'image' : (text.trim() ? 'text' : ''), text, position, fontSize, fontSizePct, color, opacity, margin, scale, rotation, density };
  }
  if (action === 'watermark') {
    if (!watermark) throw new Error('加水印需要 watermark 参数（text 文字，或配 watermarkMessageId 图片水印）');
    if (watermark.type !== 'image' && !watermark.text.trim()) throw new Error('文字水印需要 watermark.text');
  }

  /* GIF 帧参数。 */
  const delay = o.delay == null ? 500 : Math.round(num(o.delay, 500));
  if (action === 'gif' && (delay < 20 || delay > 10000)) throw new Error('每帧延时 delay 要在 20~10000ms 之间');
  const fps = o.fps == null ? 0 : num(o.fps);
  if (action === 'gif' && fps && !(fps >= 0.5 && fps <= 30)) throw new Error('fps 要在 0.5~30 之间');
  const loop = o.loop == null ? 0 : Math.round(num(o.loop, 0));
  if (action === 'gif' && (loop < 0 || loop > 65535)) throw new Error('loop 是循环次数，0 表示无限循环');

  if (action === 'resize' && !(width > 0 && height > 0)) throw new Error('resize 需要 width 和 height');
  if (action === 'crop' && !crop && !aspect) throw new Error('crop 需要 crop 区域或 aspect 比例');
  if (action === 'shape' && !shape) throw new Error('shape 需要 circle / rounded / ellipse');
  if (action === 'shape' && format === 'jpg') throw new Error('图形裁剪需要 png 或 webp（jpg 没有透明通道）');

  return { action, format, width, height, maxDim, quality, targetKB, mode, crop, aspect, shape, radius, watermark, delay, fps, loop };
}

const PILLOW_SCRIPT = String.raw`
import sys, json, io, os, re
from PIL import Image, ImageOps, ImageDraw, ImageFont
src, dst, raw = sys.argv[1], sys.argv[2], sys.argv[3]
o = json.loads(raw)
im = ImageOps.exif_transpose(Image.open(src))
if o.get('crop'):
    x, y, w, h = [int(v) for v in o['crop']]
    im = im.crop((x, y, x + w, y + h))
if o.get('aspect'):
    aw, ah = [float(v) for v in o['aspect'].split(':')]
    W, H = im.size
    target = aw / ah
    if W / H > target:
        nw = max(1, int(H * target)); left = (W - nw) // 2; im = im.crop((left, 0, left + nw, H))
    else:
        nh = max(1, int(W / target)); top = (H - nh) // 2; im = im.crop((0, top, W, top + nh))
w = int(o.get('width') or 0); h = int(o.get('height') or 0)
mode = o.get('mode') or 'fit'
fmt = (o.get('format') or 'png').lower()
if w > 0 and h > 0:
    if mode == 'stretch':
        im = im.resize((w, h), Image.LANCZOS)
    elif mode == 'crop':
        im = ImageOps.fit(im, (w, h), Image.LANCZOS, centering=(0.5, 0.5))
    else:
        im2 = ImageOps.contain(im, (w, h), Image.LANCZOS)
        if fmt == 'jpg':
            canvas = Image.new('RGB', (w, h), (255, 255, 255))
            canvas.paste(im2.convert('RGB'), ((w - im2.width) // 2, (h - im2.height) // 2))
        else:
            canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
            im2 = im2.convert('RGBA')
            canvas.paste(im2, ((w - im2.width) // 2, (h - im2.height) // 2), im2)
        im = canvas
elif o.get('maxDim'):
    im.thumbnail((int(o['maxDim']), int(o['maxDim'])), Image.LANCZOS)
if o.get('action') == 'shape':
    im = im.convert('RGBA')
    if o.get('shape') == 'circle':
        side = min(im.size)
        im = ImageOps.fit(im, (side, side), Image.LANCZOS)
    W, H = im.size
    mask = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(mask)
    if o.get('shape') in ('circle', 'ellipse'):
        d.ellipse((0, 0, W - 1, H - 1), fill=255)
    else:
        r = int(o.get('radius') or max(1, min(W, H) // 8))
        d.rounded_rectangle((0, 0, W - 1, H - 1), radius=r, fill=255)
    im.putalpha(mask)
wm = o.get('watermark')
if wm and (wm.get('wm_path') or str(wm.get('text') or '').strip()):
    im = im.convert('RGBA')
    W, H = im.size
    m = max(0, int(wm.get('margin') or 12))
    opac = max(0.01, min(1.0, float(wm.get('opacity') or 0.65)))
    pos = wm.get('position') or 'bottom-right'
    rot = max(-180.0, min(180.0, float(wm.get('rotation') or 0)))
    dens = max(1, min(20, int(wm.get('density') or 5)))
    gap = max(0.2, (18.0 - dens) / 6.5)
    if wm.get('wm_path'):
        wim = ImageOps.exif_transpose(Image.open(wm['wm_path'])).convert('RGBA')
        nw = max(1, int(W * min(1.0, max(0.02, float(wm.get('scale') or 0.25)))))
        nh = max(1, int(wim.height * nw / wim.width))
        wim = wim.resize((nw, nh), Image.LANCZOS)
        if opac < 1.0:
            wim.putalpha(wim.getchannel('A').point(lambda v: int(v * opac)))
        stamp = wim.rotate(-rot, expand=True, resample=Image.BICUBIC) if rot % 360 != 0 else wim
    else:
        text = str(wm.get('text') or '')
        fsize = int(wm.get('fontSize') or 0)
        if not fsize and wm.get('fontSizePct'):
            fsize = max(8, int(W * min(50.0, max(1.0, float(wm['fontSizePct']))) / 100.0))
        if not fsize:
            fsize = max(12, int(W * 0.04))
        try:
            font = ImageFont.truetype(wm['fontPath'], fsize) if wm.get('fontPath') else ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()
        rgb = (255, 255, 255)
        mm = re.match(r'^#([0-9a-fA-F]{6})$', str(wm.get('color') or '#FFFFFF'))
        if mm:
            rgb = tuple(int(mm.group(1)[i:i + 2], 16) for i in (0, 2, 4))
        fill = rgb + (int(round(255 * opac)),)
        probe = ImageDraw.Draw(Image.new('RGBA', (8, 8)))
        bb = probe.textbbox((0, 0), text, font=font)
        tw, th = max(1, bb[2] - bb[0]), max(1, bb[3] - bb[1])
        pad = max(2, fsize // 4)
        layer = Image.new('RGBA', (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.text((pad - bb[0], pad - bb[1]), text, font=font, fill=fill)
        stamp = layer.rotate(-rot, expand=True, resample=Image.BICUBIC) if rot % 360 != 0 else layer
    sw, sh = stamp.size
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    def paste(x, y):
        px, py = int(x - sw / 2), int(y - sh / 2)
        sx0, sy0 = max(0, -px), max(0, -py)
        sx1, sy1 = min(sw, W - px), min(sh, H - py)
        if sx1 <= sx0 or sy1 <= sy0:
            return
        overlay.alpha_composite(stamp.crop((sx0, sy0, sx1, sy1)), (max(0, px), max(0, py)))
    if pos == 'tile':
        step_x = sw * gap + m
        step_y = sh * gap * 1.4 + m
        y = sh / 2
        row = 0
        while y - sh / 2 < H:
            x = -(row % 2) * step_x / 2 + sw / 2
            while x - sw / 2 < W:
                paste(x, y)
                x += step_x
            y += step_y
            row += 1
    else:
        if pos == 'top-left': ax, ay = m + sw / 2, m + sh / 2
        elif pos == 'top': ax, ay = W / 2, m + sh / 2
        elif pos == 'top-right': ax, ay = W - m - sw / 2, m + sh / 2
        elif pos == 'left': ax, ay = m + sw / 2, H / 2
        elif pos == 'center': ax, ay = W / 2, H / 2
        elif pos == 'right': ax, ay = W - m - sw / 2, H / 2
        elif pos == 'bottom-left': ax, ay = m + sw / 2, H - m - sh / 2
        elif pos == 'bottom': ax, ay = W / 2, H - m - sh / 2
        else: ax, ay = W - m - sw / 2, H - m - sh / 2
        paste(ax, ay)
    im = Image.alpha_composite(im, overlay)
if fmt == 'jpg':
    im = im.convert('RGB'); pil_fmt = 'JPEG'
elif fmt == 'webp':
    pil_fmt = 'WEBP'
else:
    pil_fmt = 'PNG'
q = int(o.get('quality') or 85)
target = int(o.get('targetKB') or 0)
def save(path, img, quality):
    kw = {'format': pil_fmt, 'optimize': True}
    if pil_fmt == 'PNG':
        kw['compress_level'] = 9
    if pil_fmt in ('JPEG', 'WEBP'):
        kw['quality'] = quality
    img.save(path, **kw)
if target > 0:
    best = None
    last = None
    for scale in (1.0, 0.85, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2):
        cur = im if scale == 1.0 else im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)
        last = cur
        for quality in range(q, 9, -10):
            bio = io.BytesIO()
            kw = {'format': pil_fmt, 'optimize': True}
            if pil_fmt == 'PNG':
                kw['compress_level'] = 9
            if pil_fmt in ('JPEG', 'WEBP'):
                kw['quality'] = quality
            cur.save(bio, **kw)
            if bio.tell() <= target * 1024:
                best = (bio.getvalue(), quality)
                break
        if best:
            break
    if best:
        open(dst, 'wb').write(best[0])
    elif last is not None:
        save(dst, last, 10)
    else:
        save(dst, im, 10)
else:
    save(dst, im, q)
print(json.dumps({'width': im.width, 'height': im.height, 'format': fmt, 'bytes': os.path.getsize(dst)}))
`;

/* 多图合成 GIF：所有帧 contain 到首页尺寸、白底合成，单次保存为动图。 */
const PILLOW_GIF_SCRIPT = String.raw`
import sys, json, os
from PIL import Image, ImageOps
src_dir, dst, raw = sys.argv[1], sys.argv[2], sys.argv[3]
o = json.loads(raw)
files = o['frames']
W = int(o.get('width') or 0)
delay = int(o.get('delayMs') or 500)
loop = int(o.get('loop') or 0)
frames = []
base = None
for f in files:
    im = ImageOps.exif_transpose(Image.open(os.path.join(src_dir, f)))
    if im.mode != 'RGBA':
        im = im.convert('RGBA')
    if base is None:
        w = W or min(im.width, 800)
        h = max(1, round(im.height * w / im.width))
        base = (w, h)
    im2 = ImageOps.contain(im, base, Image.LANCZOS)
    canvas = Image.new('RGB', base, (255, 255, 255))
    canvas.paste(im2, ((base[0] - im2.width) // 2, (base[1] - im2.height) // 2), im2)
    frames.append(canvas)
if not frames:
    raise SystemExit('no frames')
frames[0].save(dst, format='GIF', save_all=True, append_images=frames[1:], duration=delay, loop=loop, optimize=True)
print(json.dumps({'frames': len(frames), 'width': base[0], 'height': base[1], 'delayMs': delay, 'bytes': os.path.getsize(dst)}))
`;

function cleanOld() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const dir of [OUT_DIR, TMP_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          if (st.isDirectory()) {
            if (st.mtimeMs < Date.now() - 86400000) fs.rmSync(p, { recursive: true, force: true });
          } else if (st.mtimeMs < cutoff) fs.unlinkSync(p);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

/* 文字水印的字体解析（editImage / batchEditImages 共用）：
 * 中文必须有 CJK 字体，缺就如实报错，不输出方框。 */
function applyWatermarkFont(opts) {
  if (!opts.watermark?.text?.trim()) return;
  const needCjk = /[^\x00-\x7F]/.test(opts.watermark.text);
  if (needCjk) {
    const cjkPath = findWatermarkFont(true);
    if (cjkPath) { opts.watermark.fontPath = cjkPath; return; }
    if (findWatermarkFont(false)) throw new Error('中文水印需要中文字体（Debian/Ubuntu: apt install fonts-wqy-zenhei），服务器上没装；可先用英文/数字水印');
    throw new Error('服务器上找不到任何可用字体，无法加文字水印');
  }
  const anyPath = findWatermarkFont(false);
  if (!anyPath) throw new Error('服务器上找不到任何可用字体，无法加文字水印');
  opts.watermark.fontPath = anyPath;
}

function runPillowEdit(t, src, dst, opts) {
  const r = spawnSync(t.pyCmd, ['-c', PILLOW_SCRIPT, src, dst, JSON.stringify(opts)], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${t.pyCmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`图片处理失败：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  if (!fs.existsSync(dst)) throw new Error('图片处理没有产出文件');
  return r;
}

function stampName(base, suffix, ext) {
  const clean = String(base || 'image').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || 'image';
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  let fileName = `${clean}-${suffix}-${stamp}.${ext}`;
  let outPath = path.join(OUT_DIR, fileName);
  for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
    fileName = `${clean}-${suffix}-${stamp}-${n}.${ext}`;
    outPath = path.join(OUT_DIR, fileName);
  }
  return { fileName, outPath };
}

export async function editImage({ cfg, name, buf, watermarkBuf, watermarkName, uid, isOwner, options } = {}) {
  const t = probeTools();
  if (!t.pillow) throw new Error('图片编辑需要 Python Pillow（Debian/Ubuntu: apt install python3-pil）');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const opts = validateImageOptions(options);
  if (!buf?.length) throw new Error('图片内容为空');
  const maxIn = Number(cfg?.convert?.maxInputBytes) || MAX_BYTES;
  if (buf.length > maxIn) throw new Error(`图片 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${(maxIn / 1048576).toFixed(0)}MB 上限`);
  if (watermarkBuf?.length && watermarkBuf.length > maxIn) throw new Error(`水印图片 ${(watermarkBuf.length / 1048576).toFixed(1)}MB，超过 ${(maxIn / 1048576).toFixed(0)}MB 上限`);
  if (opts.watermark?.type === 'image' && !watermarkBuf?.length) {
    throw new Error('图片水印需要再给一张水印图（watermarkMessageId）');
  }
  applyWatermarkFont(opts);
  const { u } = reserveMediaQuota({ cfg, uid: requester, isOwner: isOwner === true });

  ensureDir(OUT_DIR);
  const jobId = `img-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = ensureDir(path.join(TMP_DIR, jobId));
  const src = path.join(tmp, `input${path.extname(String(name || '')) || '.png'}`);
  const dst = path.join(tmp, `output.${opts.format}`);
  fs.writeFileSync(src, buf);
  if (watermarkBuf?.length) {
    opts.watermark = opts.watermark || {};
    opts.watermark.wmPath = path.join(tmp, `wm${path.extname(String(watermarkName || '')) || '.png'}`);
    fs.writeFileSync(opts.watermark.wmPath, watermarkBuf);
  }
  const started = Date.now();
  try {
    const r = runPillowEdit(t, src, dst, opts);
    let info = {};
    try { info = JSON.parse(String(r.stdout || '{}').trim().split(/\r?\n/).pop() || '{}'); } catch { /* ignore */ }
    const outBytes = fs.statSync(dst).size;
    const base = path.basename(String(name || 'image'), path.extname(String(name || '')));
    const { fileName, outPath } = stampName(base, opts.action === 'watermark' ? 'watermark' : 'edited', opts.format);
    fs.copyFileSync(dst, outPath);
    commitMediaQuota(u, requester, isOwner === true);
    cleanOld();
    log(`[image-edit] ${opts.action} ${opts.format} 完成：${fileName} ${(outBytes / 1024).toFixed(0)}KB ${((Date.now() - started) / 1000).toFixed(1)}s uid=${requester} owner=${isOwner === true}`);
    return { ok: true, filePath: outPath, fileName, format: opts.format, bytes: outBytes, ms: Date.now() - started, ...info };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 多图合成 GIF（2~60 帧）。额度与单图编辑共用，一次合成算一次。 */
export async function makeGif({ cfg, images, uid, isOwner, options } = {}) {
  const t = probeTools();
  if (!t.pillow) throw new Error('GIF 合成需要 Python Pillow（Debian/Ubuntu: apt install python3-pil）');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const frames = Array.isArray(images) ? images.filter((x) => x?.buf?.length) : [];
  if (frames.length < 2) throw new Error('合成 GIF 至少要 2 张图（按发送顺序作为帧顺序）');
  if (frames.length > 60) throw new Error(`一次最多 ${60} 帧，这次给了 ${frames.length} 张`);
  const opts = validateImageOptions({ ...(options ?? {}), action: 'gif', format: 'gif' });
  const maxIn = Number(cfg?.convert?.maxInputBytes) || MAX_BYTES;
  for (const f of frames) {
    if (f.buf.length > maxIn) throw new Error(`有一帧 ${(f.buf.length / 1048576).toFixed(1)}MB，超过 ${(maxIn / 1048576).toFixed(0)}MB 上限`);
  }
  const total = frames.reduce((s, f) => s + f.buf.length, 0);
  if (total > 200 * 1024 * 1024) throw new Error(`帧图片总量 ${(total / 1048576).toFixed(0)}MB，超过 200MB 上限，请先压缩`);
  const { u } = reserveMediaQuota({ cfg, uid: requester, isOwner: isOwner === true });

  ensureDir(OUT_DIR);
  const jobId = `gif-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = ensureDir(path.join(TMP_DIR, jobId));
  const dst = path.join(tmp, 'output.gif');
  const names = [];
  frames.forEach((f, i) => {
    const ext = (path.extname(String(f.name || '')) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
    const n = `frame-${String(i + 1).padStart(3, '0')}${ext}`;
    fs.writeFileSync(path.join(tmp, n), f.buf);
    names.push(n);
  });
  const payload = { frames: names, width: opts.width, delayMs: opts.fps > 0 ? Math.round(1000 / opts.fps) : opts.delay, loop: opts.loop };
  const started = Date.now();
  try {
    const r = spawnSync(t.pyCmd, ['-c', PILLOW_GIF_SCRIPT, tmp, dst, JSON.stringify(payload)], {
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) throw new Error(`${t.pyCmd} 启动失败：${r.error.message}`);
    if (r.status !== 0) throw new Error(`GIF 合成失败：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    if (!fs.existsSync(dst)) throw new Error('GIF 合成没有产出文件');
    const outBytes = fs.statSync(dst).size;
    if (outBytes > MAX_BYTES) {
      throw new Error(`GIF 有 ${(outBytes / 1048576).toFixed(1)}MB，超过 50MB 上限；请减少帧数、缩小宽度或缩短播放时长`);
    }
    let info = {};
    try { info = JSON.parse(String(r.stdout || '{}').trim().split(/\r?\n/).pop() || '{}'); } catch { /* ignore */ }
    const { fileName, outPath } = stampName(path.basename(String(frames[0].name || 'frames'), path.extname(String(frames[0].name || ''))), 'gif', 'gif');
    fs.copyFileSync(dst, outPath);
    commitMediaQuota(u, requester, isOwner === true);
    cleanOld();
    log(`[image-edit] gif ${info.frames ?? frames.length} 帧 ${info.width ?? '?'}x${info.height ?? '?'} 完成：${fileName} ${(outBytes / 1024).toFixed(0)}KB ${((Date.now() - started) / 1000).toFixed(1)}s uid=${requester} owner=${isOwner === true}`);
    return { ok: true, filePath: outPath, fileName, format: 'gif', bytes: outBytes, ms: Date.now() - started, ...info };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export async function fetchImageForEdit({ cfg, messageId } = {}) {
  return fetchImageFromMessage({ cfg, messageId });
}

/* 打包 ZIP：Python 标准库 zipfile，不引入新依赖。 */
const PY_ZIP = String.raw`
import sys, json, os, zipfile
dst, raw = sys.argv[1], sys.argv[2]
o = json.loads(raw)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for item in o["files"]:
        z.write(item["path"], item["name"])
print(json.dumps({"entries": len(o["files"]), "bytes": os.path.getsize(dst)}))
`;

/** 批量图片处理（ling014 工作站第三批）：2~12 张图用同一组参数逐张处理，
 *  打包成 ZIP 一次发回。额度算 1 次（一次批量操作）。 */
export async function batchEditImages({ cfg, images, watermarkBuf, watermarkName, uid, isOwner, options } = {}) {
  const t = probeTools();
  if (!t.pillow) throw new Error('批量图片处理需要 Python Pillow（Debian/Ubuntu: apt install python3-pil）');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const list = Array.isArray(images) ? images.filter((x) => x?.buf?.length) : [];
  if (list.length < 2) throw new Error('批量处理至少要 2 张图；单张直接用普通编辑就行');
  if (list.length > 12) throw new Error(`一次最多批量 12 张，这次给了 ${list.length} 张`);
  const opts = validateImageOptions(options);
  if (opts.action === 'gif') throw new Error('批量处理不做 GIF；要多图动图请用 action=gif');
  const maxIn = Number(cfg?.convert?.maxInputBytes) || MAX_BYTES;
  for (const f of list) {
    if (f.buf.length > maxIn) throw new Error(`有一张图 ${(f.buf.length / 1048576).toFixed(1)}MB，超过 ${(maxIn / 1048576).toFixed(0)}MB 上限`);
  }
  const total = list.reduce((s, f) => s + f.buf.length, 0);
  if (total > 150 * 1024 * 1024) throw new Error(`图片总量 ${(total / 1048576).toFixed(0)}MB，超过 150MB 上限，请先压缩`);
  if (opts.watermark?.type === 'image' && !watermarkBuf?.length) {
    throw new Error('图片水印需要再给一张水印图（watermarkMessageId）');
  }
  if (watermarkBuf?.length && watermarkBuf.length > maxIn) throw new Error('水印图片太大');
  applyWatermarkFont(opts);
  const { u } = reserveMediaQuota({ cfg, uid: requester, isOwner: isOwner === true });

  ensureDir(OUT_DIR);
  const tmp = ensureDir(path.join(TMP_DIR, `batch-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));
  const started = Date.now();
  try {
    if (watermarkBuf?.length) {
      opts.watermark = opts.watermark || {};
      opts.watermark.wmPath = path.join(tmp, `wm${path.extname(String(watermarkName || '')) || '.png'}`);
      fs.writeFileSync(opts.watermark.wmPath, watermarkBuf);
    }
    const files = [];
    for (const [i, f] of list.entries()) {
      const ext = (path.extname(String(f.name || '')) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      const src = path.join(tmp, `in-${i}${ext}`);
      const dst = path.join(tmp, `out-${String(i + 1).padStart(2, '0')}.${opts.format}`);
      fs.writeFileSync(src, f.buf);
      try {
        runPillowEdit(t, src, dst, opts);
      } catch (e) {
        throw new Error(`第 ${i + 1} 张（${f.name || '未命名'}）处理失败：${e.message}`);
      }
      const base = path.basename(String(f.name || `image-${i + 1}`), path.extname(String(f.name || ''))).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 24) || `image-${i + 1}`;
      files.push({ path: dst, name: `${String(i + 1).padStart(2, '0')}-${base}-${opts.action}.${opts.format}` });
    }
    const zipPath = path.join(tmp, 'batch.zip');
    const zr = spawnSync(t.pyCmd, ['-c', PY_ZIP, zipPath, JSON.stringify({ files })], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    if (zr.error) throw new Error(`${t.pyCmd} 打包失败：${zr.error.message}`);
    if (zr.status !== 0) throw new Error(`ZIP 打包失败：${(zr.stderr || zr.stdout || '').trim().slice(0, 200)}`);
    if (!fs.existsSync(zipPath)) throw new Error('ZIP 打包没有产出文件');
    const outBytes = fs.statSync(zipPath).size;
    if (outBytes > 200 * 1024 * 1024) throw new Error(`ZIP 有 ${(outBytes / 1048576).toFixed(0)}MB，超过 200MB 上限`);
    let info = {};
    try { info = JSON.parse(String(zr.stdout || '{}').trim().split(/\r?\n/).pop() || '{}'); } catch { /* ignore */ }
    const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let fileName = `batch-${opts.action}-${stamp}.zip`;
    let outPath = path.join(OUT_DIR, fileName);
    for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
      fileName = `batch-${opts.action}-${stamp}-${n}.zip`;
      outPath = path.join(OUT_DIR, fileName);
    }
    fs.copyFileSync(zipPath, outPath);
    commitMediaQuota(u, requester, isOwner === true);
    cleanOld();
    log(`[image-edit] batch ${opts.action} × ${list.length} 完成：${fileName} ${(outBytes / 1024).toFixed(0)}KB ${((Date.now() - started) / 1000).toFixed(1)}s uid=${requester} owner=${isOwner === true}`);
    return { ok: true, filePath: outPath, fileName, format: 'zip', action: opts.action, images: list.length, bytes: outBytes, ms: Date.now() - started, ...info };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── 水印演示图（教学用，2026-10-27）────────────────────────────────────────
 * 程序化画一张样例背景（渐变+光斑，不碰用户素材），走同一条 PILLOW 管线
 * 加水印——演示效果和真实交付永远同一套实现，不会漂。
 * 教学用途不占媒体额度（不读用户图、产物几百 KB）；用 WATERMARK_DEMO_DEFAULTS
 * 兜底，用户可以只改其中一两个旋钮看变化。 */
export const WATERMARK_DEMO_DEFAULTS = {
  text: '© 玲結美咲',
  position: 'bottom-right',
  fontSizePct: 4,
  color: '#FFFFFF',
  opacity: 0.65,
  margin: 12,
};

const DEMO_BG_SCRIPT = String.raw`
import sys, random
from PIL import Image, ImageDraw
out = sys.argv[1]
W, H = 960, 640
grad = Image.new("RGB", (1, H))
for y in range(H):
    t = y / (H - 1)
    grad.putpixel((0, y), (int(38 + 190 * t), int(70 + 100 * t), int(130 + 50 * (1 - t))))
bg = grad.resize((W, H))
d = ImageDraw.Draw(bg, "RGBA")
random.seed(7)
for i in range(7):
    x, y = random.randint(0, W), random.randint(0, H)
    r = random.randint(60, 190)
    d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, 26))
d.rectangle((0, H - 96, W, H), fill=(255, 255, 255, 34))
d.rectangle((0, 0, W, 64), fill=(0, 0, 0, 40))
bg.save(out)
`;

export async function demoWatermark({ cfg, uid, isOwner, options } = {}) {
  const t = probeTools();
  if (!t.pillow) throw new Error('演示图需要 Python Pillow（Debian/Ubuntu: apt install python3-pil）');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const userWm = options?.watermark && typeof options.watermark === 'object' ? options.watermark : {};
  const merged = { ...WATERMARK_DEMO_DEFAULTS, ...Object.fromEntries(Object.entries(userWm).filter(([, v]) => v != null && v !== '')) };
  const opts = validateImageOptions({ action: 'watermark', format: 'png', watermark: merged });
  applyWatermarkFont(opts);
  ensureDir(OUT_DIR);
  const tmp = ensureDir(path.join(TMP_DIR, `demo-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));
  const started = Date.now();
  try {
    const bg = path.join(tmp, 'bg.png');
    const bgr = spawnSync(t.pyCmd, ['-c', DEMO_BG_SCRIPT, bg], { encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    if (bgr.error) throw new Error(`${t.pyCmd} 启动失败：${bgr.error.message}`);
    if (bgr.status !== 0 || !fs.existsSync(bg)) throw new Error(`样例背景生成失败：${(bgr.stderr || bgr.stdout || '').trim().slice(0, 200)}`);
    const dst = path.join(tmp, 'demo.png');
    runPillowEdit(t, bg, dst, opts);
    const outBytes = fs.statSync(dst).size;
    const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let fileName = `watermark-demo-${stamp}.png`;
    let outPath = path.join(OUT_DIR, fileName);
    for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
      fileName = `watermark-demo-${stamp}-${n}.png`;
      outPath = path.join(OUT_DIR, fileName);
    }
    fs.copyFileSync(dst, outPath);
    cleanOld();
    const { fontPath, wmPath, ...applied } = opts.watermark;
    log(`[image-edit] watermark-demo（${applied.position}）生成 uid=${requester} owner=${isOwner === true}`);
    return { ok: true, filePath: outPath, fileName, format: 'png', bytes: outBytes, applied, demoDefaults: WATERMARK_DEMO_DEFAULTS, ms: Date.now() - started };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// 生成水印参数参考图（2×2 四宫格）到 assets/，供教学与目视回归
//   node tools/make-watermark-demo.mjs
// 演示走 demoWatermark（同一水印管线，不占额度），四格分别是：
//   ① 默认角标  ② 全页防盗默认  ③ 密度加大  ④ 金色+顺时针30°
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { demoWatermark, watermarkFontCandidates } from '../src/core/image-edit.js';
import { probeTools } from '../src/core/file-convert.js';

const t = probeTools(true);
if (!t.pillow) {
  console.error('需要 Python Pillow（python3-pil）');
  process.exit(1);
}
const OUT = process.argv[2] || 'assets/水印参数参考_20261027.png';

const variants = [
  { label: '① 默认角标：右下 · 白字 · 65% · 字号4%', wm: {} },
  { label: '② 全页防盗默认：平铺 · 角度-20° · 密度5', wm: { position: 'tile', rotation: -20, density: 5, opacity: 0.5 } },
  { label: '③ 密度加大：density 5 → 12', wm: { position: 'tile', rotation: -20, density: 12, opacity: 0.5 } },
  { label: '④ 换色换角度：金色 #FFD700 · 角度+30°', wm: { position: 'tile', rotation: 30, density: 6, color: '#FFD700', opacity: 0.6 } },
];

const outs = [];
for (const v of variants) {
  const r = await demoWatermark({
    cfg: { convert: { enabled: true } },
    uid: 'demo-builder',
    isOwner: true,
    options: { watermark: v.wm },
  });
  outs.push({ file: r.filePath, label: v.label });
  console.log(`  已生成：${r.fileName}（${(r.bytes / 1024).toFixed(0)}KB）`);
}

const sheetTmp = path.join('state', '_wm_sheet.png');
const fontCands = watermarkFontCandidates().all.join('|');
const r = spawnSync(t.pyCmd, ['-c', `
import sys, json
from PIL import Image, ImageDraw, ImageFont
items = json.loads(sys.argv[1])
out = sys.argv[2]
cands = [c for c in sys.argv[3].split("|") if c]
lbl_font = title_font = None
for c in cands:
    try:
        lbl_font = ImageFont.truetype(c, 24)
        title_font = ImageFont.truetype(c, 30)
        break
    except Exception:
        continue
PW, PH, LBL, PAD = 470, 313, 42, 20
COLS = 2
W = COLS * PW + (COLS + 1) * PAD
H = 64 + PAD + 2 * (PH + LBL + PAD)
sheet = Image.new("RGB", (W, H), (245, 246, 248))
d = ImageDraw.Draw(sheet)
d.text((PAD, 16), "水印参数参考（玲結美咲 · 默认配方与可调旋钮）", font=title_font or lbl_font, fill=(30, 34, 40))
for i, it in enumerate(items):
    col, row = i % COLS, i // COLS
    x = PAD + col * (PW + PAD)
    y = 64 + PAD + row * (PH + LBL + PAD)
    im = Image.open(it["file"]).convert("RGB").resize((PW, PH), Image.LANCZOS)
    sheet.paste(im, (x, y))
    d.rectangle((x, y, x + PW - 1, y + PH - 1), outline=(200, 204, 210))
    d.text((x + 2, y + PH + 8), it["label"], font=lbl_font, fill=(30, 34, 40))
sheet.save(out)
print("sheet", sheet.size)
`, JSON.stringify(outs), sheetTmp, fontCands], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (r.error || r.status !== 0) {
  console.error(`四宫格合成失败：${(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 300)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(sheetTmp, OUT);
for (const o of outs) { try { fs.unlinkSync(o.file); } catch { /* ignore */ } }
try { fs.unlinkSync(sheetTmp); } catch { /* ignore */ }
const usage = path.join('state', 'convert-usage.json');
try { if (fs.existsSync(usage) && fs.readFileSync(usage, 'utf8').includes('"demo-builder"')) fs.unlinkSync(usage); } catch { /* ignore */ }
console.log(`参考图已输出：${OUT}`);

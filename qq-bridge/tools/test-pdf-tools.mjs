// PDF 工具离线回归：页码解析 / 水印参数 / 能力表；pypdf+reportlab 可用时真跑一遍
//   node tools/test-pdf-tools.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPdfCapabilities, parsePageRange, validatePdfWatermarkOptions, probePdfTools } from '../src/core/pdf-tools.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const throws = (name, fn, re) => {
  try { fn(); ok(name, false, '没有抛错'); } catch (e) { ok(name, re.test(e.message), e.message); }
};

console.log('== ① 页码解析 ==');
{
  eq('单页', parsePageRange('3'), [3]);
  eq('区间', parsePageRange('1-3'), [1, 2, 3]);
  eq('混合（中文逗号也认）', parsePageRange('1-3，5'), [1, 2, 3, 5]);
  eq('去重保序', parsePageRange('2,1,2,4'), [2, 1, 4]);
  throws('空范围', () => parsePageRange('  '), /空的/);
  throws('起止反了', () => parsePageRange('5-3'), /反了/);
  throws('0 页码', () => parsePageRange('0'), /从 1 开始/);
  throws('乱写', () => parsePageRange('abc'), /看不懂/);
  throws('超界检测', () => parsePageRange('1,5', 4), /只有 4 页/);
}

console.log('== ② 水印参数 ==');
{
  const d = validatePdfWatermarkOptions({});
  ok('默认值（字号转 5% 页宽，工作站对齐）', d.position === 'bottom-right' && d.fontSize === 0 && d.fontSizePct === 5 && d.opacity === 0.5 && d.rotation === 0 && d.density === 5);
  throws('位置非法', () => validatePdfWatermarkOptions({ position: 'middle' }), /position/);
  throws('字号超界', () => validatePdfWatermarkOptions({ fontSize: 500 }), /8~144/);
  throws('相对字号超界', () => validatePdfWatermarkOptions({ fontSizePct: 80 }), /1~50/);
  throws('密度超界', () => validatePdfWatermarkOptions({ density: 30 }), /1~20/);
  throws('角度超界', () => validatePdfWatermarkOptions({ rotation: 270 }), /-180~180/);
  ok('颜色别名 灰色→#808080', validatePdfWatermarkOptions({ color: '灰色' }).color === '#808080');
  ok('显式字号时不用百分比', validatePdfWatermarkOptions({ fontSize: 36 }).fontSizePct === 0);
  const w = validatePdfWatermarkOptions({ text: '内部资料', position: 'tile', rotation: 45, opacity: 0.3, color: '#FF0000', density: 10 });
  ok('斜平铺水印参数', w.position === 'tile' && w.rotation === 45 && w.opacity === 0.3 && w.density === 10);
}

console.log('== ③ 能力表 ==');
{
  const full = buildPdfCapabilities({ pypdf: true, pypdfCmd: 'python3', reportlab: true, reportlabCmd: 'python3', fonts: { cjk: ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'], any: [], all: ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'] } });
  ok('齐全时三个操作', full.available && full.ops.join(',') === 'merge,split,watermark');
  ok('有 CJK 字体标记', full.watermark.font === 'cjk-ok');
  const noRl = buildPdfCapabilities({ pypdf: true, pypdfCmd: 'python3', reportlab: false, reportlabCmd: '', fonts: { cjk: [], any: [], all: [] } });
  ok('缺 reportlab 时合并/拆分仍可用', noRl.available && noRl.ops.includes('merge'));
  ok('缺 reportlab 时给提示', /reportlab/.test(noRl.watermark.needs));
  const none = buildPdfCapabilities({ pypdf: false, pypdfCmd: '', reportlab: false, reportlabCmd: '', fonts: { cjk: [], any: [], all: [] } });
  ok('没有 pypdf 时不可用', none.available === false && none.ops.length === 0);
}

console.log('== ④ 本机真跑（pypdf + reportlab 都有才跑）==');
{
  const t = probePdfTools(true);
  if (!t.pypdf || !t.reportlab) {
    console.log(`  SKIP 本机缺依赖（pypdf=${t.pypdf} reportlab=${t.reportlab}），部署后服务器上会真跑`);
  } else {
    const { pdfMerge, pdfSplit, pdfWatermark } = await import('../src/core/pdf-tools.js');
    const py = t.pypdfCmd;
    const mkPdf = (file, n, label) => spawnSync(py, ['-c', `
import sys
from reportlab.pdfgen import canvas
f, n, label = sys.argv[1], int(sys.argv[2]), sys.argv[3]
c = canvas.Canvas(f)
for i in range(n):
    c.setFont("Helvetica", 24)
    c.drawString(72, 400, f"{label} page {i + 1}")
    c.showPage()
c.save()
`, file, String(n), label], { encoding: 'utf8' });
    const tmp = path.join('state', '_pdf_test');
    fs.mkdirSync(tmp, { recursive: true });
    const created = [];
    const cfg = { convert: { enabled: true } };
    try {
      const a = path.join(tmp, 'a.pdf');
      const b = path.join(tmp, 'b.pdf');
      ok('造测试 PDF a(3页)', mkPdf(a, 3, 'AAA').status === 0);
      ok('造测试 PDF b(2页)', mkPdf(b, 2, 'BBB').status === 0);
      const merged = await pdfMerge({ cfg, files: [{ name: 'a.pdf', buf: fs.readFileSync(a) }, { name: 'b.pdf', buf: fs.readFileSync(b) }], uid: 'test-owner', isOwner: true });
      created.push(merged.filePath);
      ok('合并 2 份 = 5 页', merged.pages === 5, JSON.stringify(merged));
      const ext = await pdfSplit({ cfg, name: 'merged.pdf', buf: fs.readFileSync(merged.filePath), uid: 'test-owner', isOwner: true, options: { pages: '1,3-4' } });
      created.push(ext.filePath);
      ok('抽取 1,3-4 = 3 页', ext.pages === 3 && ext.mode === 'range', JSON.stringify(ext));
      const parts = await pdfSplit({ cfg, name: 'merged.pdf', buf: fs.readFileSync(merged.filePath), uid: 'test-owner', isOwner: true, options: { every: 2 } });
      created.push(parts.filePath);
      ok('每 2 页一拆 = 3 个包', parts.parts === 3 && parts.fileName.endsWith('.zip'), JSON.stringify(parts));
      const wm = await pdfWatermark({ cfg, name: 'a.pdf', buf: fs.readFileSync(a), uid: 'test-owner', isOwner: true, options: { text: 'INTERNAL', position: 'center', rotation: 45, opacity: 0.5, color: '#FF0000', fontSize: 48 } });
      created.push(wm.filePath);
      const check = spawnSync(py, ['-c', `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
txt = "".join((p.extract_text() or "") for p in r.pages)
print(len(r.pages), "INTERNAL" in txt)
`, wm.filePath], { encoding: 'utf8' });
      ok('水印后仍 3 页且文字可提取', /3 True/.test(String(check.stdout || '')), check.stdout || check.stderr);
      try { await pdfMerge({ cfg, files: [{ name: 'a.pdf', buf: fs.readFileSync(a) }], uid: 'test-owner', isOwner: true }); ok('单份 PDF 拒绝合并', false, '没有抛错'); }
      catch (e) { ok('单份 PDF 拒绝合并', /至少要 2 份/.test(e.message), e.message); }
    } finally {
      for (const p of created) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      const usage = path.join('state', 'convert-usage.json');
      try { if (fs.existsSync(usage) && fs.readFileSync(usage, 'utf8').includes('"test-owner"')) fs.unlinkSync(usage); } catch { /* ignore */ }
    }
  }
}

console.log(`\n${pass} passed${process.exitCode ? '，有失败' : ''}`);

// 文件转换能力表 + 执行计划的离线回归（不调用任何外部工具）
//   node tools/test-file-convert.mjs
import { buildCapabilities, planFor, validateConvertOptions, validatePdfOptions, sumZipListing } from '../src/core/file-convert.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};
const has = (cap, from, to) => (cap.targets[from] || []).includes(to);

const all = {
  ffmpeg: true, soffice: true, sofficeCmd: 'soffice', pandoc: true,
  pdftoppm: true, pdftotext: true, img2pdf: true, unzip: true, unshare: true,
  magick: true, convert: false, pillow: true, pyCmd: 'python3',
  ico: true, icoMode: 'magick', icoCmd: 'magick',
};
const onlyFfmpeg = { ...all, soffice: false, sofficeCmd: '', pandoc: false, pdftoppm: false, pdftotext: false, img2pdf: false, ico: false, icoMode: '', icoCmd: '', magick: false, pillow: false };
const none = { ffmpeg: false, soffice: false, sofficeCmd: '', pandoc: false, pdftoppm: false, pdftotext: false, img2pdf: false, unzip: false, unshare: false, ico: false, icoMode: '', icoCmd: '', magick: false, pillow: false };

console.log('== ① 能力表 ==');
{
  const c = buildCapabilities(all);
  ok('docx → pdf', has(c, 'docx', 'pdf'));
  ok('xlsm → xlsx', has(c, 'xlsm', 'xlsx'));
  ok('pptx → pdf', has(c, 'pptx', 'pdf'));
  ok('mp3 → flac', has(c, 'mp3', 'flac'));
  ok('mp4 → gif', has(c, 'mp4', 'gif'));
  ok('mp4 → m4a（音频提取）', has(c, 'mp4', 'm4a'));
  ok('mkv → flac（音频提取）', has(c, 'mkv', 'flac'));
  ok('mov → mp3', has(c, 'mov', 'mp3'));
  ok('png → webp', has(c, 'png', 'webp'));
  ok('png → ico', has(c, 'png', 'ico'));
  ok('ico → png', has(c, 'ico', 'png'));
  ok('pdf → txt', has(c, 'pdf', 'txt'));
  ok('pdf → png', has(c, 'pdf', 'png'));
  ok('md → docx', has(c, 'md', 'docx'));
  ok('pdf → docx 不提供', !has(c, 'pdf', 'docx'));
  ok('notes 说明 PDF→docx 不支持', c.notes.some((x) => /PDF → docx/.test(x)));
  ok('notes 说明同格式视频压缩', c.notes.some((x) => /mp4→mp4/.test(x)));
  ok('notes 说明多图 PDF', c.notes.some((x) => /多张图/.test(x)));
}
{
  const c = buildCapabilities(onlyFfmpeg);
  ok('只有 ffmpeg：音频可用', has(c, 'mp3', 'wav'));
  ok('只有 ffmpeg：Office 不可用', !has(c, 'docx', 'pdf'));
  ok('只有 ffmpeg：ICO 不可用', !has(c, 'png', 'ico'));
  ok('只有 ffmpeg：提示缺 LibreOffice', c.notes.some((x) => /LibreOffice/.test(x)));
}
{
  const c = buildCapabilities(none);
  ok('什么都没有：目标表为空', Object.keys(c.targets).length === 0, JSON.stringify(c.targets));
}

console.log('== ② 执行计划 ==');
{
  ok('docx→pdf 走 soffice', planFor('docx', 'pdf', all).kind === 'soffice');
  ok('xlsm→xlsx 走 soffice', planFor('xlsm', 'xlsx', all).kind === 'soffice');
  ok('mp3→flac 走 ffmpeg', planFor('mp3', 'flac', all).kind === 'ffmpeg');
  ok('mp4→gif 走 ffmpeg', planFor('mp4', 'gif', all).kind === 'ffmpeg');
  ok('pdf→png 走 pdftoppm', planFor('pdf', 'png', all).kind === 'pdftoppm');
  ok('pdf→txt 走 pdftotext', planFor('pdf', 'txt', all).kind === 'pdftotext');
  ok('md→docx 走 pandoc', planFor('md', 'docx', all).kind === 'pandoc');
  ok('png→pdf 走 img2pdf', planFor('png', 'pdf', all).kind === 'img2pdf');
  ok('png→ico 走 ImageMagick/Pillow', planFor('png', 'ico', all).kind === 'ico');
  ok('ico→png 走 ffmpeg', planFor('ico', 'png', all).kind === 'ffmpeg');
  let msg = '';
  try { planFor('pdf', 'docx', all); } catch (e) { msg = e.message; }
  ok('pdf→docx 明确拒绝', /不支持 pdf → docx/.test(msg), msg);
  msg = '';
  try { planFor('docx', 'pdf', onlyFfmpeg); } catch (e) { msg = e.message; }
  ok('缺 LibreOffice 给人话', /LibreOffice/.test(msg), msg);
  msg = '';
  try { planFor('png', 'ico', onlyFfmpeg); } catch (e) { msg = e.message; }
  ok('缺 ICO 工具给人话', /ImageMagick|Pillow/.test(msg), msg);
  ok('源/目标相同拒绝（非视频）', (() => { try { planFor('mp3', 'mp3', all); return false; } catch { return true; } })());
}

console.log('== ③ 视频选项 / 同格式压缩 ==');
{
  const p = planFor('mp4', 'mp4', all);
  ok('mp4→mp4 允许（压缩）', p.kind === 'ffmpeg' && p.ext === 'mp4');
  ok('压缩默认 crf=23', p.args.includes('23'));
  const c = planFor('mp4', 'mp4', all, validateConvertOptions({ level: 'low', maxHeight: 720, mute: true }));
  ok('level=low → crf 32', c.args[c.args.indexOf('-crf') + 1] === '32', c.args.join(' '));
  ok('限高 720 有 scale', c.args.join(' ').includes('scale=-2:720'));
  ok('mute → -an', c.args.includes('-an'));
  const g = planFor('mov', 'gif', all, { start: 3, duration: 15, fps: 12, width: 640 });
  ok('GIF 带预截段', g.pre.join(' ') === '-ss 3 -t 15', g.pre.join(' '));
  ok('GIF 带调色板滤镜', g.args.join(' ').includes('palettegen') && g.args.join(' ').includes('fps=12,scale=640:-2'));
  ok('webm→m4a 走 ffmpeg 提取', planFor('webm', 'm4a', all).kind === 'ffmpeg' && planFor('webm', 'm4a', all).args.includes('-vn'));
  let msg = '';
  try { planFor('mp4', 'gif', all, { duration: 120 }); } catch (e) { msg = e.message; }
  ok('GIF 超 60 秒明确拒绝', /60 秒/.test(msg), msg);
  msg = '';
  try { planFor('mp3', 'mp3', all); } catch (e) { msg = e.message; }
  ok('mp3→mp3 仍拒绝', /相同/.test(msg), msg);
}

console.log('== ④ 选项校验 ==');
{
  let msg = '';
  try { validateConvertOptions({ crf: 50 }); } catch (e) { msg = e.message; }
  ok('crf 超界拒绝', /14~40/.test(msg), msg);
  msg = '';
  try { validateConvertOptions({ level: 'ultra' }); } catch (e) { msg = e.message; }
  ok('非法 level 拒绝', /low \/ medium \/ high/.test(msg), msg);
  msg = '';
  try { validateConvertOptions({ maxHeight: 777 }); } catch (e) { msg = e.message; }
  ok('非法 maxHeight 拒绝', /240 \/ 360/.test(msg), msg);
  msg = '';
  try { validateConvertOptions({ width: 2000 }); } catch (e) { msg = e.message; }
  ok('GIF 宽度超界拒绝', /64~1280/.test(msg), msg);
  const v = validateConvertOptions({ level: 'high', mute: 'no' });
  ok('level=high → crf 20', v.crf === 20);
  ok('mute 只有 true 生效', v.mute === false);
  const p = validatePdfOptions({ pageSize: 'a4', margin: 12 });
  ok('PDF a4+边距通过', p.pageSize === 'a4' && p.margin === 12);
  msg = '';
  try { validatePdfOptions({ pageSize: 'a3' }); } catch (e) { msg = e.message; }
  ok('非法 pageSize 拒绝', /auto \/ a4 \/ letter/.test(msg), msg);
  msg = '';
  try { validatePdfOptions({ margin: 500 }); } catch (e) { msg = e.message; }
  ok('边距超界拒绝', /0~144/.test(msg), msg);
}

{
  /* 2026-10-28 审查 P1-1 回归：zip 清单求和要吃下 unzip 6.x（YYYY-MM-DD）与 5.x（MM-DD-YY）
   * 两种日期格式——旧正则两种都匹配 0 行，防线从上线起就没工作过。 */
  const listing6 = 'Archive:  a.docx\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n      1030  2026-10-27 23:41   word/document.xml\n       200  2026-10-27 23:41   [Content_Types].xml\n---------                     -------\n      1230                     2 files';
  ok('zip 清单求和（unzip 6.x YYYY-MM-DD）', sumZipListing(listing6) === 1230, String(sumZipListing(listing6)));
  const listing5 = '     1030  10-27-26 23:41   word/document.xml\n      200  10-27-26 23:41   b.xml';
  ok('zip 清单求和（unzip 5.x MM-DD-YY）', sumZipListing(listing5) === 1230, String(sumZipListing(listing5)));
  ok('空/垃圾输入不误加', sumZipListing('') === 0 && sumZipListing('no listing here') === 0);
}

console.log(`\n${pass} passed${process.exitCode ? '，有失败' : ''}`);

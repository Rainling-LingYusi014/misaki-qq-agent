// PPTX / XLSX 生成核心（2026-10-26，办公 office 补全）。
//
// 定位：与 docx.js 平行的「内容进参数 → 桥生成文件」模式。模型把结构化内容
// （大纲/表格）作为工具参数传入，桥用 pptxgenjs / exceljs 生成文件后走
// uploadFileToQQ 送出——模型只搬运结构，不搬运二进制。
//
// 设计约束：
// - 参数上限从严（见 LIMITS）：PPT 本质是「大纲演示」，不是排版工具；Excel 限行列。
//   超限直接抛错（端点转 400），不静默截断——让模型自己拆分或精简。
// - 纯 JS 依赖（pptxgenjs / exceljs），无系统调用、无外部字体要求，服务器/容器通跑。
// - 布局固定为「标题页 + 内容页」极简风格：QQ 场景要的是能看的大纲稿，
//   花哨排版交给用户拿到文件后自己改。

import fs from 'node:fs';
import path from 'node:path';
import { DOC_TMP_DIR } from './docx.js';
import { log } from '../lib/log.js';

export const LIMITS = {
  maxSlides: 60,
  maxBulletsPerSlide: 15,
  maxBulletChars: 300,
  maxTitleChars: 120,
  maxNotesChars: 1000,
  maxSheets: 10,
  maxRows: 5000,
  maxCols: 100,
  maxCellChars: 2000,
};

function safeTitleForFile(title) {
  const t = String(title ?? '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').trim().slice(0, 40) || '未命名';
  return t;
}

/** 校验并归一化 slides 参数；不合法直接 throw（端点负责转 400）。 */
function normalizeSlides(slides) {
  if (!Array.isArray(slides) || slides.length === 0) throw new Error('slides 不能为空');
  if (slides.length > LIMITS.maxSlides) throw new Error(`页数超限：最多 ${LIMITS.maxSlides} 页（本次 ${slides.length}），请精简或拆分`);
  return slides.map((sl, i) => {
    const title = String(sl?.title ?? '').trim().slice(0, LIMITS.maxTitleChars) || `第 ${i + 1} 页`;
    let bullets = sl?.bullets;
    if (bullets != null && !Array.isArray(bullets)) throw new Error(`第 ${i + 1} 页 bullets 必须是字符串数组`);
    bullets = (bullets ?? []).map((b) => String(b ?? '').trim().slice(0, LIMITS.maxBulletChars)).filter(Boolean);
    if (bullets.length > LIMITS.maxBulletsPerSlide) throw new Error(`第 ${i + 1} 页要点超限：最多 ${LIMITS.maxBulletsPerSlide} 条`);
    const notes = String(sl?.notes ?? '').slice(0, LIMITS.maxNotesChars).trim();
    return { title, bullets, notes };
  });
}

/** 校验并归一化 sheets 参数。cell 一律转字符串写盘（保留前导零等原样性）。 */
function normalizeSheets(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('sheets 不能为空');
  if (sheets.length > LIMITS.maxSheets) throw new Error(`工作表超限：最多 ${LIMITS.maxSheets} 个`);
  return sheets.map((sh, i) => {
    const name = String(sh?.name ?? '').trim().slice(0, 31) || `Sheet${i + 1}`;
    if (!Array.isArray(sh?.rows) || sh.rows.length === 0) throw new Error(`「${name}」的 rows 不能为空`);
    if (sh.rows.length > LIMITS.maxRows) throw new Error(`「${name}」行数超限：最多 ${LIMITS.maxRows} 行`);
    const rows = sh.rows.map((r) => {
      if (!Array.isArray(r)) throw new Error(`「${name}」的每一行必须是数组`);
      if (r.length > LIMITS.maxCols) throw new Error(`「${name}」列数超限：最多 ${LIMITS.maxCols} 列`);
      return r.map((c) => {
        if (c === null || c === undefined) return '';
        if (typeof c === 'number' && Number.isFinite(c)) return c; // 数字保持数值型（可求和）
        return String(c).slice(0, LIMITS.maxCellChars);
      });
    });
    return { name, rows };
  });
}

/** 生成 PPTX Buffer：标题页 + 大纲内容页（16:9，极简风格）。 */
export async function makePptxBuffer(title, slides) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const norm = normalizeSlides(slides);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W16x9', width: 13.33, height: 7.5 });
  pptx.layout = 'W16x9';
  pptx.title = String(title ?? '');
  // 标题页
  const cover = pptx.addSlide();
  cover.addText(String(title ?? '未命名演示'), { x: 0.8, y: 2.6, w: 11.7, fontSize: 40, bold: true, color: '1F3864' });
  cover.addText(`${norm.length} 页`, { x: 0.8, y: 4.0, fontSize: 18, color: '666666' });
  // 内容页
  for (const sl of norm) {
    const s = pptx.addSlide();
    s.addText(sl.title, { x: 0.6, y: 0.4, w: 12.1, fontSize: 28, bold: true, color: '1F3864' });
    if (sl.bullets.length) {
      s.addText(
        sl.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.9, y: 1.6, w: 11.5, h: 5.4, fontSize: 18, valign: 'top' }
      );
    }
    if (sl.notes) s.addNotes(sl.notes);
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

/** 生成 XLSX Buffer：首行表头加粗 + 冻结。 */
export async function makeXlsxBuffer(title, sheets) {
  const ExcelJS = (await import('exceljs')).default;
  const norm = normalizeSheets(sheets);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'qq-bridge';
  if (title) wb.title = String(title);
  for (const sh of norm) {
    const ws = wb.addWorksheet(sh.name.slice(0, 31));
    for (const row of sh.rows) ws.addRow(row);
    if (sh.rows.length > 1) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
    }
    // 列宽自适应（按各列最长内容估宽，上限 60）
    const colCount = Math.max(...sh.rows.map((r) => r.length));
    for (let c = 1; c <= colCount; c++) {
      let w = 8;
      for (const row of sh.rows) {
        const v = row[c - 1];
        if (v !== '' && v !== undefined && v !== null) w = Math.max(w, String(v).length * 1.2 + 2);
      }
      ws.getColumn(c).width = Math.min(60, Math.round(w));
    }
  }
  return wb.xlsx.writeBuffer();
}

/** 落盘到 doc-tmp（与 docx 同一目录同一命名法），返回 uploadFileToQQ 需要的三件套。 */
export function writeOfficeToMount(title, buf, ext) {
  const fileName = `${safeTitleForFile(title)}-${Date.now()}.${ext}`;
  const hostPath = path.join(DOC_TMP_DIR, fileName);
  fs.writeFileSync(hostPath, buf);
  return { fileName, hostPath, napcatPath: hostPath, size: buf.length };
}

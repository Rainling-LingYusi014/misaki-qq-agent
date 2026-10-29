// 文档读取回归（2026-10-28）：PDF/Excel/PPT 走文本层，纯图片页才走识图。
// 测试用 Python 现场生成最小 xlsx/pdf 夹具；本机缺 python 或库时整组跳过（不误报红）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isComplexDocument, readDocumentBuffer } from '../src/core/document-read.js';

function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-read-'));
  const d = dir.replace(/\\/g, '/');
  const py = [
    'import openpyxl, pymupdf, os',
    `d = ${JSON.stringify(d)}`,
    "wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Sheet1'",
    "ws['A1'] = '标题'; ws['B1'] = '数值'; ws['A2'] = '测试文案'; ws['B2'] = 42",
    "wb.save(os.path.join(d, 't.xlsx'))",
    "doc = pymupdf.open(); p = doc.new_page(); p.insert_text((72, 72), 'Hello PDF 123')",
    "doc.save(os.path.join(d, 't.pdf'))",
  ].join('\n');
  try {
    execFileSync('python', ['-c', py], { timeout: 60000, stdio: 'ignore' });
    return dir;
  } catch {
    return null;
  }
}

const dir = makeFixtures();

test('isComplexDocument 只认 pdf/xlsx/xlsm/pptx', () => {
  assert.equal(isComplexDocument('a.pdf'), true);
  assert.equal(isComplexDocument('a.xlsx'), true);
  assert.equal(isComplexDocument('a.xlsm'), true);
  assert.equal(isComplexDocument('a.pptx'), true);
  assert.equal(isComplexDocument('a.docx'), false);
  assert.equal(isComplexDocument('a.txt'), false);
});

test('xlsx：单元格值按工作表/行抽出', { skip: !dir }, async () => {
  const buf = fs.readFileSync(path.join(dir, 't.xlsx'));
  const r = await readDocumentBuffer(buf, 't.xlsx');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'xlsx');
  assert.match(r.text, /工作表：Sheet1/);
  assert.match(r.text, /测试文案/);
  assert.match(r.text, /42/);
});

test('pdf：文本层直读，不需要识图', { skip: !dir }, async () => {
  const buf = fs.readFileSync(path.join(dir, 't.pdf'));
  const r = await readDocumentBuffer(buf, 't.pdf');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'pdf');
  assert.match(r.text, /Hello PDF 123/);
  assert.equal(r.visionPages, 0);
});

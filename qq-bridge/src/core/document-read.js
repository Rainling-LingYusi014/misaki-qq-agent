// 文档读取（2026-10-28 主人拍板）：PDF / Excel / PPT 的统一入口。
//
// 为什么不是"整份转图片给视觉模型"：
//   · 表格数字看图会看错，xlsx 有 openpyxl 就该精确读单元格；
//   · PPT/PDF 的文字层是现成的，渲染+识图既慢又贵；
//   · 视觉模型只用来救"这一页根本没有文本层"的情况（扫描件、整页图片）。
//
// 三层口径：
//   ① 文本层：PDF 用 PyMuPDF（对中文 CID 字体比 pdftotext 好）、xlsx 用 openpyxl、pptx 读 slide XML；
//   ② 视觉兜底：某页有效字符 < 30 → 渲染成 PNG，用桥的独立识图模型按"逐字转录"提示词读；
//   ③ 聚合：按页拼文本，总长封顶，标注页数与视觉页数；任何失败都如实写进 note，不假装读过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { ROOT } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { describeImageWithVisionModel } from './vision.js';

const DOC_EXTS = new Set(['.pdf', '.xlsx', '.xlsm', '.pptx', '.pptm']);
/** 文档转录专用提示词：与"聊天看图"的 VISION_PROMPT 分开——那个会概括画面，这个要逐字。 */
export const DOC_VISION_PROMPT = '你在做文档转录。请逐字转录这一页所有可见文字，按阅读顺序；'
  + '表格用 TSV（制表符分隔）保留行列；标题保留层级；看不清的字标 [?]；'
  + '不要总结、不要评价、不要客套。只输出转录内容。';

export function isComplexDocument(name) {
  return DOC_EXTS.has(path.extname(String(name || '')).toLowerCase());
}

function pythonCandidates(opts = {}) {
  return [...new Set([
    String(process.env.QQ_DOC_PYTHON || '').trim(),
    String(opts.pythonBin || '').trim(),
    'python',
    'py',
    'python3',
  ].filter(Boolean))];
}

function runExtractor(py, args) {
  return new Promise((resolve, reject) => {
    execFile(py, args, { timeout: 120000, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(`文档解析失败：${error.message}${stderr ? `（${String(stderr).trim().slice(-300)}）` : ''}`);
        err.code = error.code;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 读一份文档字节为可读文本。
 * @param {Buffer} buf
 * @param {string} name 原始文件名（决定格式）
 * @param {{maxChars?:number,maxVisionPages?:number,visionMaxTokens?:number,deadlineMs?:number,pythonBin?:string}} opts
 */
export async function readDocumentBuffer(buf, name, opts = {}) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!DOC_EXTS.has(ext)) throw new Error(`不支持的文档类型：${ext || '未知'}`);
  const script = path.join(ROOT, 'python', 'doc_extract.py');
  if (!fs.existsSync(script)) throw new Error(`缺少文档解析脚本：${script}`);
  const maxChars = Math.max(2000, Math.min(60000, Number(opts.maxChars) || 30000));
  const tmp = path.join(os.tmpdir(), `qq-doc-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`);
  fs.writeFileSync(tmp, buf);
  let data;
  try {
    const args = [script, '--path', tmp, '--max-chars', String(maxChars)];
    let lastErr = null;
    for (const py of pythonCandidates(opts)) {
      try {
        const stdout = await runExtractor(py, args);
        data = JSON.parse(stdout);
        lastErr = null;
        break;
      } catch (error) {
        // 只有"找不到解释器"才换下一个候选；解析失败直接报，不白跑三遍
        if (error?.code === 'ENOENT') { lastErr = error; continue; }
        throw error;
      }
    }
    if (lastErr) throw lastErr;
    if (!data || data.ok !== true) throw new Error(data?.error || '解析器没有返回结果');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响结果 */ }
  }

  /* ── 视觉兜底：只处理 needsVision 的页，默认最多 8 页；超时/失败如实标注 ── */
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const visionLimit = Math.max(0, Math.min(8, Number(opts.maxVisionPages ?? 8)));
  const deadline = Date.now() + Math.max(15000, Number(opts.deadlineMs) || 150000);
  let visionUsed = 0;
  let visionFailed = 0;
  for (const p of pages) {
    if (!p || !p.needsVision || !p.image) continue;
    if (visionUsed >= visionLimit) { p.note = '超过视觉转录页数上限，未转录'; delete p.image; continue; }
    if (Date.now() > deadline) { p.note = '视觉转录超时，未完成'; delete p.image; continue; }
    try {
      const r = await describeImageWithVisionModel(Buffer.from(p.image, 'base64'), 'image/png', {
        prompt: DOC_VISION_PROMPT,
        maxTokens: Math.max(500, Math.min(4000, Number(opts.visionMaxTokens) || 3000)),
      });
      if (r.ok && r.text) {
        p.text = r.text;
        p.chars = r.text.length;
        p.vision = true;
        visionUsed += 1;
        log(`[document] 第 ${p.index} 页无文本层，识图转录 ${r.text.length} 字（${r.ms}ms）`);
      } else {
        visionFailed += 1;
        p.note = `视觉转录失败：${r.error || '空结果'}`;
      }
    } catch (error) {
      visionFailed += 1;
      p.note = `视觉转录失败：${error?.message ?? error}`;
    }
    delete p.image;
  }

  /* ── 聚合：按页拼，总长封顶；页数/视觉页数/失败页数都写进 note ── */
  const parts = [];
  let total = 0;
  let truncated = false;
  for (const p of pages) {
    const head = p.name ? `[${p.name}]` : `[第${p.index}页]`;
    const body = String(p.text || '').trim();
    const block = body ? `${head}\n${body}` : `${head}（无文字${p.note ? `：${p.note}` : ''}）`;
    if (total + block.length > maxChars) {
      parts.push(block.slice(0, Math.max(0, maxChars - total)));
      truncated = true;
      break;
    }
    parts.push(block);
    total += block.length;
  }
  const notes = [];
  if (data.note) notes.push(data.note);
  if (visionUsed) notes.push(`其中 ${visionUsed} 页无文本层，已用识图模型转录`);
  if (visionFailed) notes.push(`${visionFailed} 页视觉转录失败`);
  if (truncated) notes.push(`内容超过 ${maxChars} 字符已截断`);
  return {
    ok: true,
    kind: data.kind || ext.replace('.', ''),
    text: parts.join('\n\n'),
    size: buf.length,
    pages: pages.length,
    visionPages: visionUsed,
    truncated,
    note: notes.length ? notes.join('；') : null,
  };
}

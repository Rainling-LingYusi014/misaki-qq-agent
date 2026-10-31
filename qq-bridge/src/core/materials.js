// 素材库（2026-10-30 主人定规）：美咲自己发空间/动态用的素材仓库 + 主人双端投递入口。
//
// 结构：state/materials/<大类目录>/<文件>；分类账本 state/materials/index.db（node:sqlite）。
// 大类目录只管「人眼浏览」，检索靠 SQLite 标签（tags JSON 数组，一图多标签）；
// sha256 做内容去重（同图不重复入库）；used_in 记账防短期重发（消费方 M2 接线）。
// 投递通道：LAN 上传页（materials-server.js，手机/PC 浏览器直投，主人拍板局域网直绑）；
// QQ「入库」关键字投递是 M3 备选。她的取用面（qq_material_search）走同一份 SQLite，M2 接线。
//
// 设计继承 sticker 库的教训：扫描/同步永不覆盖已有元数据（只补缺行，不动既有行）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../lib/log.js';
import { startMaterialsServer } from './materials-server.js';

let cfgRef = null;
let db = null;
let ROOT = '';

export const MATERIALS_INBOX = 'inbox';
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

function categories() {
  const list = Array.isArray(cfgRef?.materials?.categories) ? cfgRef.materials.categories.map((c) => String(c).trim()).filter(Boolean) : [];
  return [...new Set([...list, MATERIALS_INBOX])];
}

function validCategory(c) {
  return categories().includes(String(c ?? '').trim());
}

/** 轻量尺寸探测：PNG/JPEG/GIF 三种头部直读，其余返回 0（不做重依赖）。 */
export function probeImageDims(buf) {
  try {
    if (!buf || buf.length < 24) return { width: 0, height: 0 };
    // PNG: IHDR 在固定偏移
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF: 6-9 字节小端
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG: 扫 SOF0~SOF15（跳过 DHT/SOS 等）
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off += 1; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        const segLen = buf.readUInt16BE(off + 2);
        if (segLen <= 0) break;
        off += 2 + segLen;
      }
    }
  } catch { /* 尺寸拿不到就 0，不挡入库 */ }
  return { width: 0, height: 0 };
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

export function mimeOfName(name) {
  return MIME_BY_EXT[path.extname(String(name ?? '')).toLowerCase()] || 'application/octet-stream';
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,           -- 内容 sha256 全 hex（天然去重键）
      category TEXT NOT NULL,
      file TEXT NOT NULL,            -- 相对 materials 根的路径（/ 分隔）
      orig_name TEXT DEFAULT '',
      sha256 TEXT UNIQUE NOT NULL,
      bytes INTEGER DEFAULT 0,
      mime TEXT DEFAULT '',
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      note TEXT DEFAULT '',
      source TEXT DEFAULT '',
      used_count INTEGER DEFAULT 0,
      last_used_at INTEGER DEFAULT 0,
      used_in TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
  `);
}

function rowToItem(r) {
  if (!r) return null;
  return {
    id: r.id, category: r.category, file: r.file, origName: r.orig_name, bytes: r.bytes,
    mime: r.mime, width: r.width, height: r.height,
    tags: JSON.parse(r.tags || '[]'), note: r.note || '', source: r.source || '',
    usedCount: r.used_count || 0, lastUsedAt: r.last_used_at || 0,
    usedIn: JSON.parse(r.used_in || '[]'), createdAt: r.created_at,
  };
}

function safeName(name) {
  const base = path.basename(String(name ?? '')).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'img';
  if (!ALLOWED_EXT.has(path.extname(base).toLowerCase())) return `${base}.png`;
  return base;
}

/** 入库：buffer 直接写文件 + 记账。重复内容（sha256 命中）不重复落盘，返回 duplicate 标记。 */
export function addMaterial({ category, tags = [], note = '', source = '', origName = '', buffer }) {
  if (!db) throw new Error('素材库未初始化');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('空文件');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`超过单文件上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
  const cat = validCategory(category) ? String(category).trim() : MATERIALS_INBOX;
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const old = db.prepare('SELECT id FROM materials WHERE sha256 = ?').get(sha);
  if (old) return { id: old.id, duplicate: true };
  const dims = probeImageDims(buffer);
  const now = Date.now();
  const rel = path.posix.join(cat, `${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}-${safeName(origName)}`);
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  const tagList = [...new Set((Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，]/)).flatMap((t) => String(t).split(/[,，]/)).map((t) => t.trim()).filter(Boolean).slice(0, 12))];
  db.prepare(`INSERT INTO materials (id, category, file, orig_name, sha256, bytes, mime, width, height, tags, note, source, used_count, last_used_at, used_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', ?)`)
    .run(sha, cat, rel, safeName(origName), sha, buffer.length, mimeOfName(rel), dims.width, dims.height,
      JSON.stringify(tagList), String(note ?? '').slice(0, 200), String(source ?? '').slice(0, 20), now);
  return { id: sha, duplicate: false, category: cat, tags: tagList };
}

/** 开机扫描：目录里存在但账本缺失的文件补记（tags 空，等主人补打）；账本有但文件没了的只告警不动行。 */
export function scanOrphans() {
  let added = 0;
  const seenFiles = new Set();
  for (const cat of categories()) {
    const dir = path.join(ROOT, cat);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;
      const rel = path.posix.join(cat, name);
      seenFiles.add(rel);
      const known = db.prepare('SELECT id FROM materials WHERE file = ?').get(rel);
      if (known) continue;
      try {
        const buf = fs.readFileSync(path.join(ROOT, rel));
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        const dims = probeImageDims(buf);
        db.prepare(`INSERT OR IGNORE INTO materials (id, category, file, orig_name, sha256, bytes, mime, width, height, tags, note, source, used_count, last_used_at, used_in, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '', '', 0, 0, '[]', ?)`)
          .run(sha, cat, rel, name, sha, buf.length, mimeOfName(name), dims.width, dims.height, Date.now());
        added += 1;
      } catch (e) { log(`[materials] 扫描补记失败 ${rel}: ${e?.message ?? e}`); }
    }
  }
  const orphanRows = db.prepare('SELECT id, file FROM materials').all().filter((r) => !seenFiles.has(r.file) && !fs.existsSync(path.join(ROOT, r.file)));
  if (orphanRows.length) log(`[materials] 账本有但文件缺失 ${orphanRows.length} 条（不删行，等待人工处理）`);
  return { added, missing: orphanRows.length };
}

export function listCategories() {
  const out = [];
  for (const cat of categories()) {
    const rows = db.prepare('SELECT id, tags, created_at FROM materials WHERE category = ? ORDER BY created_at DESC').all(cat);
    const untagged = rows.filter((r) => (JSON.parse(r.tags || '[]')).length === 0).length;
    out.push({ name: cat, count: rows.length, untagged, coverId: rows[0]?.id || '' });
  }
  return out;
}

export function queryMaterials({ category = '', tag = '', source = '', unusedOnly = false, q = '', offset = 0, limit = 30 } = {}) {
  const where = [];
  const args = [];
  if (category && validCategory(category)) { where.push('category = ?'); args.push(category); }
  if (source) { where.push('source = ?'); args.push(source); }
  if (unusedOnly) where.push('used_count = 0');
  if (tag) { where.push('tags LIKE ?'); args.push(`%"${String(tag).slice(0, 40)}"%`); }
  if (q) {
    const like = `%${String(q).slice(0, 40).toLowerCase()}%`;
    where.push("(LOWER(note) LIKE ? OR LOWER(orig_name) LIKE ? OR LOWER(tags) LIKE ?)");
    args.push(like, like, like);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM materials ${cond}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM materials ${cond} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(120, Math.max(1, limit)), Math.max(0, offset));
  return { total, items: rows.map(rowToItem) };
}

export function detailMaterial(id) {
  return rowToItem(db.prepare('SELECT * FROM materials WHERE id = ?').get(String(id ?? '')));
}

export function fileAbs(id) {
  const r = db.prepare('SELECT file, category FROM materials WHERE id = ?').get(String(id ?? ''));
  if (!r) return null;
  const abs = path.join(ROOT, r.file);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) return null; // 越界/缺失双防
  return abs;
}

export function patchMaterial(id, { tags, note, source, category, markUsedWhere = '' } = {}) {
  const r = db.prepare('SELECT * FROM materials WHERE id = ?').get(String(id ?? ''));
  if (!r) return null;
  const sets = [];
  const args = [];
  if (tags !== undefined) {
    const tagList = [...new Set((Array.isArray(tags) ? tags : String(tags).split(/[,，]/)).map((t) => String(t).trim()).filter(Boolean).slice(0, 12))];
    sets.push('tags = ?'); args.push(JSON.stringify(tagList));
  }
  if (note !== undefined) { sets.push('note = ?'); args.push(String(note).slice(0, 200)); }
  if (source !== undefined) { sets.push('source = ?'); args.push(String(source).slice(0, 20)); }
  if (category !== undefined && validCategory(category)) { sets.push('category = ?'); args.push(category); }
  if (markUsedWhere) {
    sets.push('used_count = used_count + 1', 'last_used_at = ?', 'used_in = ?');
    const ledger = JSON.parse(r.used_in || '[]');
    ledger.push({ where: String(markUsedWhere).slice(0, 60), at: Date.now() });
    args.push(Date.now(), JSON.stringify(ledger.slice(-50)));
  }
  if (!sets.length) return rowToItem(r);
  db.prepare(`UPDATE materials SET ${sets.join(', ')} WHERE id = ?`).run(...args, r.id);
  return detailMaterial(r.id);
}

/** 删除 = 文件挪进 .trash/（可人工找回），账本删行。 */
export function deleteMaterial(id) {
  const r = db.prepare('SELECT * FROM materials WHERE id = ?').get(String(id ?? ''));
  if (!r) return false;
  const abs = path.join(ROOT, r.file);
  try {
    const trashDir = path.join(ROOT, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    if (fs.existsSync(abs)) fs.renameSync(abs, path.join(trashDir, `${Date.now()}-${path.basename(r.file)}`));
  } catch (e) { log(`[materials] 删除挪回收失败 ${r.file}: ${e?.message ?? e}`); }
  db.prepare('DELETE FROM materials WHERE id = ?').run(r.id);
  return true;
}

/** 给她（M2 qq_material_search）与提示词摘要用的轻量统计。 */
export function statsSummary() {
  const total = db.prepare('SELECT COUNT(*) n FROM materials').get().n;
  const byCat = db.prepare('SELECT category, COUNT(*) n FROM materials GROUP BY category').all();
  const unused = db.prepare('SELECT COUNT(*) n FROM materials WHERE used_count = 0').get().n;
  const recentUnused = db.prepare("SELECT id, category, note FROM materials WHERE used_count = 0 ORDER BY created_at DESC LIMIT 5").all();
  return { total, unused, byCategory: byCat, recentUnused };
}

export function materialsRoot() { return ROOT; }

export function initMaterials(cfg, { startServer = true } = {}) {
  cfgRef = cfg;
  const m = cfg?.materials ?? {};
  if (m.enabled === false) { log('[materials] 素材库已按配置关闭（materials.enabled=false）'); return null; }
  ROOT = path.join(process.cwd(), 'state', 'materials');
  fs.mkdirSync(ROOT, { recursive: true });
  for (const cat of categories()) fs.mkdirSync(path.join(ROOT, cat), { recursive: true });
  db = new DatabaseSync(path.join(ROOT, 'index.db'));
  ensureSchema();
  const { added, missing } = scanOrphans();
  const total = db.prepare('SELECT COUNT(*) n FROM materials').get().n;
  log(`[materials] 素材库已就绪：${total} 张（本次扫描补记 ${added}${missing ? `，文件缺失 ${missing}` : ''}）`);
  if (startServer) {
    const port = Math.max(1024, Number(m.lanPort) || 3210);
    const host = String(m.bindHost || '0.0.0.0');
    startMaterialsServer({ port, host, token: String(cfg?.consoleToken ?? ''), root: ROOT });
    const ips = [];
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets ?? []) if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
    log(`[materials] LAN 上传页：http://127.0.0.1:${port}（本机）${ips.map((ip) => ` | http://${ip}:${port}（手机）`).join('')}`);
  }
  return { root: ROOT };
}

/** 测试与排障用 */
export function _resetMaterials() {
  cfgRef = null; db = null; ROOT = '';
}

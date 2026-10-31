// 素材库 LAN 上传页服务（2026-10-30 主人拍板「局域网直绑」）：
// 独立小端口只挂素材库三件事——页面、图片、/api/materials/*。绝不复用 3100 管理端全权限。
// 鉴权：console token，cookie（mtk，登录后页面写入，<img> 自动携带）或 x-console-token 头皆可。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from '../lib/log.js';
import { materialsPageHtml } from './materials-page.js';
import {
  listCategories, queryMaterials, detailMaterial, addMaterial,
  patchMaterial, deleteMaterial, statsSummary, fileAbs, mimeOfName, materialsRoot,
} from './materials.js';

let server = null;

function tokenOk(req, url, token) {
  if (!token) return true; // 无 token 配置 = 本机内网工具，不设闸（与 console 行为一致）
  const cookie = String(req.headers.cookie ?? '');
  const m = /(?:^|;\s*)mtk=([A-Za-z0-9_\-]+)/.exec(cookie);
  if (m && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(token))) return true;
  const hdr = String(req.headers['x-console-token'] ?? '');
  if (hdr && crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(token))) return true;
  const q = String(url.searchParams.get('tk') ?? '');
  if (q && crypto.timingSafeEqual(Buffer.from(q), Buffer.from(token))) return true;
  return false;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new Error('body 超限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function startMaterialsServer({ port, host, token, root }) {
  if (server) return server;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const p = url.pathname;
      // ── 免鉴权面：登录后的页面骨架本身（无数据）──
      if ((p === '/' || p === '/materials') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(materialsPageHtml());
        return;
      }
      // ── 其余一律鉴权 ──
      if (!tokenOk(req, url, token)) {
        if (p.startsWith('/api/')) { sendJson(res, 401, { ok: false, error: 'token 不对' }); return; }
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('401'); return;
      }
      // 图片：/m/<id>
      const imgM = /^\/m\/([0-9a-f]{64})$/.exec(p);
      if (imgM && req.method === 'GET') {
        const abs = fileAbs(imgM[1]);
        if (!abs) { res.writeHead(404); res.end('404'); return; }
        res.writeHead(200, { 'content-type': mimeOfName(abs), 'cache-control': 'private, max-age=86400' });
        fs.createReadStream(abs).pipe(res);
        return;
      }
      const api = /^\/api\/materials\/(\w+)$/.exec(p);
      if (!api) { res.writeHead(404); res.end('404'); return; }
      const action = api[1];
      if (action === 'upload' && req.method === 'POST') {
        const buf = await readBody(req, 60 * 1024 * 1024);
        const r = addMaterial({
          category: url.searchParams.get('category') || 'inbox',
          tags: url.searchParams.get('tags') || '',
          source: url.searchParams.get('source') || '',
          note: url.searchParams.get('note') || '',
          origName: url.searchParams.get('name') || 'img.png', // URLSearchParams 已做百分号解码
          buffer: buf,
        });
        sendJson(res, 200, { ok: true, ...r });
        return;
      }
      if (action === 'list' && req.method === 'GET') { sendJson(res, 200, { ok: true, categories: listCategories() }); return; }
      if (action === 'query' && req.method === 'GET') {
        const r = queryMaterials({
          category: url.searchParams.get('category') || '',
          tag: url.searchParams.get('tag') || '',
          source: url.searchParams.get('source') || '',
          unusedOnly: url.searchParams.get('unused') === '1',
          q: url.searchParams.get('q') || '',
          offset: Number(url.searchParams.get('offset')) || 0,
          limit: Number(url.searchParams.get('limit')) || 30,
        });
        sendJson(res, 200, { ok: true, ...r });
        return;
      }
      if (action === 'detail' && req.method === 'GET') {
        const item = detailMaterial(url.searchParams.get('id'));
        sendJson(res, item ? 200 : 404, item ? { ok: true, item } : { ok: false, error: 'not found' });
        return;
      }
      if (action === 'patch' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
        const item = patchMaterial(String(body.id ?? ''), body);
        sendJson(res, item ? 200 : 404, item ? { ok: true, item } : { ok: false, error: 'not found' });
        return;
      }
      if (action === 'delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
        sendJson(res, 200, { ok: deleteMaterial(String(body.id ?? '')) });
        return;
      }
      if (action === 'stats' && req.method === 'GET') { sendJson(res, 200, { ok: true, stats: statsSummary() }); return; }
      sendJson(res, 404, { ok: false, error: 'unknown action' });
    } catch (e) {
      log(`[materials] ${req.method} ${url.pathname} 失败: ${e?.message ?? e}`);
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });
  server.on('error', (e) => log(`[materials] LAN 服务错误: ${e?.message ?? e}`));
  server.listen(port, host, () => { /* 启动日志由 initMaterials 统一打（含各网卡地址） */ });
  return server;
}

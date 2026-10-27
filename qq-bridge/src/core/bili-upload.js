/* ══════════════════════════════════════════════════════════════════════════
 * B 站视频投稿（2026-10-27，M4，主人定规①「可发动态投稿」）
 *
 * 协议全部实抓自网页真实投稿（2026-10-27 01:38，主人手动投出 BV1u2nf6BE1M），
 * **不是 biliup 的 upos 老路**——新版是 member 域的 multipart 接口 + S3 预签名 PUT：
 *
 *   1) POST upload/file          {profile:'fxmeta/bup', name:'file_meta.txt'} → {uri, reqs:[{method:'PUT',url}]}
 *   2) PUT  meta 到 reqs[0].url（S3 预签名，PUT 即可）
 *   3) POST upload/multipart/new {profile:'ugcfx/bup', init_params:{meta_upos_uri:uri}, name, size}
 *        → {uri, upload_token, biz_id, chunk_size(10MB), threads(4), retry, retry_delay, timeout}
 *   4) 每片：POST upload/multipart/part {uri, upload_token, part_number}
 *        → {reqs:[{method:'PUT', url:<S3 预签名，含 partNumber/uploadId>} …多 CDN]} → PUT 二进制 → 取 ETag
 *   5) POST upload/multipart/complete {uri, upload_token, parts:[{part_number, etag}],
 *        upload_params:{biz_id, profile:'ugcfx/bup'}} → cid
 *   6) POST x/vupre/web/archive/videocheck {cid, filename, video_meta_json}
 *   7) POST x/vu/web/cover/up（multipart/form，cover=data:image/jpeg;base64,…）（可选）
 *   8) POST x/vu/web/add/v3?csrf=&w_rid=&wts=  JSON：
 *        {cover, cover43, ai_cover, title, copyright:1, **creation_statement:{id:1}**, human_type2,
 *         tid, tag, desc, dynamic, videos:[{filename, title, desc, cid}], no_reprint:1, …}
 *
 * 等级/权限：vupre/web/archive/pre code=0 即有投稿权；Lv0 曾 601 拦截（新号首传人机验证），
 * 人工过一次后（gaia_vtoken 出现即为验证通过），API 直传 code=0。
 * AIGC 声明：creation_statement:{id:1} = 内容由 AI 生成（明牌 AI 运营的硬要求，默认开启）。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { biliJson, readAuth, wbiSign, circuitOpen, circuitState, BILI_AUTH_FILE, BILI_CIRCUIT_FILE } from '../lib/bili-api.js';

const UPLOAD_STATE = path.join(STATE_DIR, 'bili-upload.json');
const MEMBER = 'https://member.bilibili.com';
const REFERER = 'https://member.bilibili.com/platform/upload/video/frame';
const DEVQ = 'x-bili-device-req-json=' + encodeURIComponent('{"platform":"web","device":"pc","mobi_app":"web_cn","spmid":"0.0"}');

const st = () => readJsonSafe(UPLOAD_STATE, { lastResult: '', lastAt: 0, lastCid: 0, lastBvid: '' });
const saveSt = (s) => atomicWriteJson(UPLOAD_STATE, s);
const api = (url, opts = {}) => biliJson(url, { ...opts, referer: REFERER, scope: 'upload', tripOnRisk: false });

/** 1-5 步：把本地视频传完，返回 { ok, cid, filename, uri }。 */
export async function uploadVideoFile({ filePath, onProgress }) {
  if (circuitOpen(BILI_CIRCUIT_FILE)) {
    const c = circuitState(BILI_CIRCUIT_FILE);
    return { ok: false, why: `熔断中（${c.scope} code ${c.code}）` };
  }
  if (!fs.existsSync(filePath)) return { ok: false, why: `文件不存在：${filePath}` };
  const size = fs.statSync(filePath).size;
  if (size > 16 * 1024 ** 3) return { ok: false, why: '超过 16G 上限' };
  const name = path.basename(filePath);

  /* 3-1 元数据：先拿 meta uri（失败不阻断，init_params 可为空） */
  let metaUri = '';
  try {
    const mj = await api(MEMBER + '/upload/file', { method: 'POST', json: true, body: JSON.stringify({ profile: 'fxmeta/bup', name: 'file_meta.txt' }) });
    if (mj.code === 0 && mj.data?.uri) {
      metaUri = mj.data.uri;
      const put = mj.data.reqs?.[0];
      if (put?.url) await fetch(put.url, { method: 'PUT', body: JSON.stringify({ name, size }) }).catch(() => {});
    }
  } catch (e) { log(`[bili-upload] meta 上传跳过：${e?.message ?? e}`); }

  /* 3-2 创建会话 */
  const nj = await api(MEMBER + '/upload/multipart/new', {
    method: 'POST', json: true,
    body: JSON.stringify({ profile: 'ugcfx/bup', ...(metaUri ? { init_params: { meta_upos_uri: metaUri } } : {}), name, size }),
  });
  if (nj.code === 601) return { ok: false, needVoucher: true, voucher: nj.data?.v_voucher ?? nj.detail?.v_voucher ?? '', why: nj.message ?? '601' };
  if (nj.code !== 0 || !nj.data?.upload_token) return { ok: false, why: `multipart/new code=${nj.code} ${nj.message ?? ''}` };
  const sess = nj.data;
  const chunkSize = Number(sess.chunk_size) || 10 * 1024 * 1024;
  const parts = Math.max(1, Math.ceil(size / chunkSize));
  log(`[bili-upload] 会话就绪：${name} ${(size / 1048576).toFixed(1)}MB / ${parts} 片 × ${(chunkSize / 1048576).toFixed(0)}MB（biz_id=${sess.biz_id}）`);

  /* 3-3 逐片 PUT（S3 预签名，多 CDN 线路，失败换下一路） */
  const fd = await fs.promises.open(filePath, 'r');
  const done = [];
  try {
    for (let i = 0; i < parts; i++) {
      const start = i * chunkSize;
      const len = Math.min(chunkSize, size - start);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, start);
      const pj = await api(MEMBER + '/upload/multipart/part', {
        method: 'POST', json: true,
        body: JSON.stringify({ uri: sess.uri, upload_token: sess.upload_token, part_number: i + 1 }),
      });
      if (pj.code !== 0) return { ok: false, why: `part ${i + 1} 申请失败 code=${pj.code} ${pj.message ?? ''}` };
      const reqs = pj.data?.reqs ?? [];
      let etag = '';
      let lastErr = '';
      for (const r of reqs) {
        try {
          const res = await fetch(r.url, { method: r.method || 'PUT', body: buf, headers: r.headers ?? {} });
          if (res.ok) { etag = (res.headers.get('etag') ?? '').replace(/"/g, ''); break; }
          lastErr = `HTTP ${res.status}`;
        } catch (e) { lastErr = String(e?.message ?? e); }
      }
      if (!etag) return { ok: false, why: `part ${i + 1} 上传失败：${lastErr || '所有线路无 ETag'}` };
      done.push({ part_number: i + 1, etag });
      onProgress?.(i + 1, parts);
    }
  } finally { await fd.close().catch(() => {}); }

  /* 3-4 完成 */
  const cj = await api(MEMBER + '/upload/multipart/complete', {
    method: 'POST', json: true,
    body: JSON.stringify({ uri: sess.uri, upload_token: sess.upload_token, parts: done, upload_params: { biz_id: sess.biz_id, profile: 'ugcfx/bup' } }),
  });
  if (cj.code !== 0) {
    /* -409 = 同名同大小的文件已上传过（B 站去重）——换文件名或改内容即可，不必重试 */
    if (cj.code === -409) return { ok: false, why: '文件重复（同名同大小已上传过，-409）——改文件名或换内容再传' };
    return { ok: false, why: `complete code=${cj.code} ${cj.message ?? ''}` };
  }
  /* 实抓对照：网页 videocheck/add_v3 用的 cid 与上传会话 biz_id 是同一个数（43080616370）；
     complete 响应不一定带 cid，故以响应优先、biz_id 兜底 */
  const cid = Number(cj.data?.cid) || Number(cj.data?.biz_id) || Number(sess.biz_id) || 0;
  const filename = cj.data?.filename ?? sess.filename ?? String(sess.uri).split('/').pop().replace(/\.mp4$/, '');
  log(`[bili-upload] 上传完成：cid=${cid} filename=${filename}（complete 响应 ${JSON.stringify(cj.data ?? {}).slice(0, 120)}）`);
  return { ok: true, cid, filename, uri: sess.uri, bizId: sess.biz_id };
}

/** 封面上传（可选）。coverPath 指向本地图片；返回封面 URL。 */
export async function uploadCover({ coverPath }) {
  if (!coverPath || !fs.existsSync(coverPath)) return { ok: false, why: '无封面文件' };
  const auth = readAuth();
  const csrf = auth.bili_jct ?? '';
  const b64 = 'data:image/jpeg;base64,' + fs.readFileSync(coverPath).toString('base64');
  const form = new FormData();
  form.append('cover', b64);
  form.append('csrf', csrf);
  const res = await fetch(`${MEMBER}/x/vu/web/cover/up?t=${Date.now()}&${DEVQ}&csrf=${encodeURIComponent(csrf)}`, {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      referer: REFERER, origin: 'https://member.bilibili.com',
      ...(auth.bili_jct ? { cookie: Object.entries(auth).filter(([k]) => !['savedAt', 'mode', 'fingerprint'].includes(k)).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: form,
  });
  const j = await res.json().catch(() => ({ code: -999 }));
  if (j.code !== 0) return { ok: false, why: `cover/up code=${j.code} ${j.message ?? ''}` };
  return { ok: true, url: j.data?.url ?? '' };
}

/** 8 步：提交稿件。aiGenerated=true → creation_statement:{id:1}（AI 生成声明）。 */
export async function submitArchive({ title, desc = '', tag = '', tid = 229, filename, cid, cover = '', dynamic = '', copyright = 1, aiGenerated = true, noReprint = 1, onlySelf = false }) {
  const auth = readAuth();
  const csrf = auth.bili_jct ?? '';
  if (!csrf) return { ok: false, why: '无 csrf（登录态缺失）' };
  if (!filename || !cid) return { ok: false, why: '缺少 filename/cid（未完成上传）' };
  const body = {
    cover, cover43: cover, ai_cover: 0, is_ab_cover: 0, ab_cover_info: null,
    title: String(title).slice(0, 80), copyright,
    ...(aiGenerated ? { creation_statement: { id: 1 } } : {}),
    human_type2: 1003, tid: Number(tid), tag: String(tag).slice(0, 200),
    desc: String(desc).slice(0, 2000), dynamic: String(dynamic).slice(0, 233), recreate: 0, interactive: 0,
    videos: [{ filename, title: String(title).slice(0, 80), desc: '', cid: Number(cid) }],
    act_reserve_create: 0, act_reserve_create_title: '', no_disturbance: 0,
    is_only_self: onlySelf ? 1 : 0, space_hidden: 2,
    watermark: { state: 0 }, subtitle: { open: 0, lan: '' }, no_reprint: noReprint,
    up_selection_reply: false, up_close_reply: false, up_close_danmu: false,
    dolby: 0, lossless_music: 0, web_os: 1,
  };
  const qs = await wbiSign({}, { authFile: BILI_AUTH_FILE, circuitFile: BILI_CIRCUIT_FILE, scope: 'upload' });
  const url = `${MEMBER}/x/vu/web/add/v3?web_location=333.1024&t=${Date.now()}&csrf=${encodeURIComponent(csrf)}&${DEVQ}&${qs}`;
  const j = await api(url, { method: 'POST', json: true, body: JSON.stringify(body) });
  if (j.code !== 0) return { ok: false, why: `add/v3 code=${j.code} ${j.message ?? ''}` };
  const bvid = j.data?.bvid ?? '';
  const s = st();
  s.lastResult = `已投稿 ${bvid}（aid=${j.data?.aid ?? ''}）`; s.lastAt = Date.now(); s.lastBvid = bvid; s.lastCid = Number(cid);
  try { saveSt(s); } catch {}
  log(`[bili-upload] 投稿成功：${bvid} 《${String(title).slice(0, 24)}》 https://www.bilibili.com/video/${bvid}`);
  return { ok: true, bvid, aid: j.data?.aid ?? '' };
}

/** 一键：上传 → 封面 → 提交。默认 onlySelf=false；dryRun=true 只做 1-2 步探测。 */
export async function publishVideo({ filePath, title, desc, tag, tid = 229, coverPath, dynamic, copyright = 1, aiGenerated = true, dryRun = false }) {
  const s0 = st();
  if (dryRun) {
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    return { ok: true, dryRun: true, size, note: '干跑：不创建上传会话、不提交' };
  }
  const up = await uploadVideoFile({ filePath });
  if (!up.ok) return up;
  let cover = '';
  if (coverPath) {
    const cv = await uploadCover({ coverPath }).catch((e) => ({ ok: false, why: String(e?.message ?? e) }));
    if (cv.ok) cover = cv.url;
    else log(`[bili-upload] 封面跳过：${cv.why}`);
  }
  return submitArchive({ title, desc, tag, tid, filename: up.filename, cid: up.cid, cover, dynamic, copyright, aiGenerated });
}

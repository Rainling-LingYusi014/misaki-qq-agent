/* ══════════════════════════════════════════════════════════════════════════
 * 视频字幕直读（2026-10-31，主人拍板 P1）
 *
 * 病根：msk 对视频内容零感知——只会复述标题/分辨率/时长这些元数据，讲不出大意
 * （10-31 阿清原话复放实测；10-30 晚主人转视频来问她，转发媒体也没到桥端）。
 *
 * 思路来自主人观察的 B 站总结类插件（鱼灾）：**视频说过的话 = 字幕轨**。
 * 本模块把字幕拉成纯文本交给模型，她读完用自己的话讲大意。
 *
 * 两条线（2026-10-31 实测定案）：
 *   · B站：**SSH 调服务器 bili-cli `video subtitle`**——服务器登录态拿 AI 字幕（ai-zh）
 *     实测全通；本机直连 B 站 API 会 412 风控（实测踩过，还误触了共享熔断），不走。
 *   · YouTube：本地 yt-dlp --write-auto-subs → 解析 vtt/srt → 行文本。
 *
 * 防编造契约（调用方必须遵守，工具描述/persona 同步写了）：kind='none' 表示这条视频
 * 没有可转写的对白（纯画面/音乐类），**只能如实说没有对白可总结**，绝不允许编大意。
 *
 * 2026-10-31 审查复核修复：
 *   · P0-2  yt 字幕每次请求独立 mkdtemp 目录（finally 兜底删）——并发/超时残留不再串台，
 *     「上一个视频的字幕当成这一个的」这种错内容进模型的路径被根除；
 *   · P1-4  B站域名改 host 白名单 + SSRF 闸 + 手动跟随 ≤2 跳 + 10s 超时（原来是
 *     字符串包含 + redirect:follow + 无超时，内网探测面已闭合）；
 *   · P1-6  服务器线撞 -412 也落共享熔断器（scope=bili-server-subs），熔断开着时
 *     直接拒绝派发——「任何 scope 撞 -412 全线停」现在两条线都守约；
 *   · P2-2  capLines 截断标志改布尔量（原来恰好 MAX_LINES+1 行时漏报）；
 *   · P2-3  ASR 按视频去重 in-flight（同视频并发只跑一个服务器转写任务）。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { log } from './log.js';
/* 熔断器（bili-api）与 SSRF 闸（safe-fetch）用函数内动态 import：本模块被多个
 * 沙箱型测试按文件子集拷贝，静态扩依赖面会让拷贝清单缺件直接炸（实测踩过）。 */

const MAX_LINES = 600;
const MAX_CHARS = 15000;

/* B站字幕走服务器 bili-cli（与 mcp-bili-remote 同一目标、同一把钥匙） */
const BILI_SSH = {
  host: process.env.BILI_MCP_HOST || 'ubuntu@<SERVER_IP>',
  key: process.env.BILI_MCP_KEY || path.join(os.homedir(), '.ssh', '<SSH_KEY_FILE>'),
  bin: process.env.BILI_MCP_BIN || '/home/ubuntu/bili-cli/.venv/bin/bili',
};

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function runSsh(remoteCmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15',
      '-i', BILI_SSH.key, BILI_SSH.host, remoteCmd],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (e, so, se) => {
        if (e) { const tail = String(se || e.message).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200); reject(new Error(tail || e.message)); }
        else resolve(String(so));
      });
  });
}

/* ── 共享熔断感知（审查 P1-6）：服务器线与本地线共守「-412 全线停」 ── */
async function assertCircuitOpen() {
  const { circuitOpen, circuitState } = await import('./bili-api.js');
  if (!circuitOpen()) return;
  const st = circuitState();
  throw new Error(`B 站风控熔断中（${st.scope || 'bili'}，停至 ${new Date(st.until).toLocaleTimeString('zh-CN')}），B 站请求全部暂停`);
}
async function noteBiliRisk(e, scope) {
  const msg = String(e?.message ?? e);
  if (!/412|风控/.test(msg)) return '';
  const { tripCircuit } = await import('./bili-api.js');
  const rec = tripCircuit({ code: '412', message: msg.slice(0, 120), scope });
  log(`[video-subs] 服务器线撞风控，已落共享熔断（${scope}）`);
  return `（已触发共享熔断，全线停至 ${new Date(rec.until).toLocaleTimeString('zh-CN')}）`;
}

/** 服务器 bili-cli 调用 → {ok,data} JSON。风控识别 + 熔断感知统一在这里。 */
async function biliCliJson(subcommand, timeoutMs, scope) {
  await assertCircuitOpen();
  let out;
  try {
    out = await runSsh(`${BILI_SSH.bin} ${subcommand}`, timeoutMs);
  } catch (e) {
    throw new Error(`服务器 bili-cli：${String(e?.message ?? e).slice(0, 160)}${await noteBiliRisk(e, scope)}`);
  }
  let j;
  try { j = JSON.parse(out.trim()); } catch {
    const a = out.indexOf('{'); const b = out.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error(`服务器 bili-cli 输出不像 JSON：${out.slice(0, 120)}`);
    j = JSON.parse(out.slice(a, b + 1));
  }
  if (j.ok === false) {
    const em = String(j.error?.message ?? '未知错误');
    throw new Error(`服务器 bili-cli：${em.slice(0, 160)}${await noteBiliRisk({ message: em }, scope)}`);
  }
  return j.data ?? {};
}

/* ── B站 URL 处理（审查 P1-4）：host 白名单 + SSRF 闸 + 手动跟随 ≤2 跳 ── */
const BILI_HOSTS = new Set(['b23.tv', 'www.bilibili.com', 'bilibili.com', 'm.bilibili.com']);
async function resolveBiliUrl(rawUrl) {
  const { validateFetchUrl } = await import('./safe-fetch.js');
  let cur = String(rawUrl ?? '').trim();
  for (let hop = 0; hop < 2; hop++) {
    let u;
    try { u = new URL(cur); } catch { throw new Error('链接格式不对'); }
    if (!BILI_HOSTS.has(u.hostname)) throw new Error(`不认这个 B 站域名：${u.hostname}`);
    await validateFetchUrl(cur); // 禁内网/环回/DNS rebinding
    const res = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('短链没有给出跳转目标');
      cur = new URL(loc, u).toString();
      continue;
    }
    return cur;
  }
  return cur; // 两跳后交给 BV 号正则把关，提不出 BV 会在这里报错
}
function bvOf(url) {
  const m = /BV[0-9A-Za-z]{10}/.exec(String(url ?? ''));
  if (!m) throw new Error('链接里没有 BV 号，认不出这是 B 站哪个视频');
  return m[0];
}

/** vtt/srt → 行文本（去时间轴、去连续重复——自动字幕是滚动字幕会成对重复）。 */
export function parseVtt(text) {
  const out = [];
  let last = '';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^WEBVTT|^Kind:|^Language:|^\d+$|^\s*\{\\/.test(line) || line.includes('-->')) continue;
    const clean = line.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
    if (!clean || clean === last) continue;
    last = clean;
    out.push(clean);
  }
  return out;
}

function capLines(lines) {
  let chars = 0;
  const kept = [];
  let truncated = false; // 审查 P2-2：布尔量直接判，不再靠 kept.length 反推
  for (const l of lines) {
    if (kept.length >= MAX_LINES || chars + l.text.length > MAX_CHARS) { truncated = true; break; }
    kept.push(l);
    chars += l.text.length;
  }
  if (truncated) kept.push({ t: 0, text: '…（字幕过长，已截断，后文未收录）' });
  return { lines: kept, truncated };
}

/* ── ASR in-flight 去重（审查 P2-3）：同视频并发只跑一个服务器转写任务 ── */
const asrInFlight = new Map();

/** B站 ASR 兜底（P2）：字幕缺失时 SSH 调服务器 `bili video transcribe`（本地 sherpa-onnx 引擎）。 */
export function fetchBiliAsr(url) {
  const s = String(url ?? '').trim();
  const dedupKey = /BV[0-9A-Za-z]{10}/.exec(s)?.[0] ?? s; // 有 BV 按 BV 去重；短链按原文（resolve 后同 BV 的并发窗口极小，可接受）
  const running = asrInFlight.get(dedupKey);
  if (running) return running;
  const job = (async () => {
    const bv = bvOf(await resolveBiliUrl(s));
    const d = await biliCliJson(`video transcribe ${shq(`https://www.bilibili.com/video/${bv}`)}`, 15 * 60 * 1000, 'bili-server-asr');
    const items = Array.isArray(d.items) ? d.items : (Array.isArray(d.segments) ? d.segments : (Array.isArray(d.text) ? d.text.map((t) => ({ from: 0, content: t })) : []));
    const lines = items.map((l) => ({ t: Number(l.from ?? l.start ?? 0) || 0, text: String(l.content ?? l.text ?? '').trim() })).filter((l) => l.text);
    const capped = capLines(lines);
    return { provider: 'bilibili', kind: 'asr', lang: 'zh', title: String(d.bvid ?? bv), durationSec: 0, ...capped };
  })().finally(() => asrInFlight.delete(dedupKey));
  asrInFlight.set(dedupKey, job);
  return job;
}

/** B站：SSH 调服务器 bili-cli video subtitle（登录态，AI 字幕实测全通）。 */
export async function fetchBiliSubtitles(url) {
  const bv = bvOf(await resolveBiliUrl(url));
  const d = await biliCliJson(`video subtitle ${shq(`https://www.bilibili.com/video/${bv}`)}`, 90 * 1000, 'bili-server-subs');
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) {
    return { provider: 'bilibili', kind: 'none', title: String(d.bvid ?? bv), durationSec: 0, lines: [], note: '这条视频没有可拉取的字幕轨（纯画面/音乐类，或平台没给这条生成字幕）' };
  }
  const lines = items.map((l) => ({ t: Number(l.from) || 0, text: String(l.content ?? '').trim() })).filter((l) => l.text);
  const capped = capLines(lines);
  return {
    provider: 'bilibili',
    kind: String(d.lang ?? '').includes('ai') ? 'ai' : 'cc',
    lang: String(d.lang ?? ''),
    title: String(d.bvid ?? bv),
    durationSec: 0,
    ...capped,
  };
}

/** YouTube：本地 yt-dlp 拉自动/人工字幕。每次请求独立临时目录（审查 P0-2），finally 必清。 */
export async function fetchYtSubtitles(url, { ytBin, proxyUrl, workDir }) {
  if (!ytBin) throw new Error('未配置 yt-dlp（config.ytdl.bin）');
  fs.mkdirSync(workDir, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(workDir, 'yt-'));
  try {
    const args = ['--proxy', proxyUrl, '--skip-download', '--write-subs', '--write-auto-subs',
      '--sub-langs', 'zh-Hans,zh-CN,zh-TW,zh,en', '--sub-format', 'vtt/srt/best',
      '-o', path.join(runDir, '%(id)s.%(ext)s'), String(url)];
    await new Promise((resolve, reject) => {
      execFile(ytBin, args, { timeout: 90 * 1000, maxBuffer: 8 * 1024 * 1024, cwd: runDir }, (e, so, se) => {
        if (e) { const tail = String(se || e.message).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200); reject(new Error(tail || e.message)); }
        else resolve(String(so));
      });
    });
    const files = fs.readdirSync(runDir).filter((f) => /\.(vtt|srt)$/i.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(runDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) {
      return { provider: 'youtube', kind: 'none', title: '', durationSec: 0, lines: [], note: 'YouTube 没有可用的字幕轨（自动字幕缺失）' };
    }
    const text = fs.readFileSync(path.join(runDir, files[0].f), 'utf8');
    const lines = parseVtt(text).map((t, i) => ({ t: i * 3, text: t }));
    const capped = capLines(lines);
    return { provider: 'youtube', kind: 'auto', lang: files[0].f.match(/\.([a-zA-Z-]+)\.(vtt|srt)$/i)?.[1] ?? '', title: '', durationSec: 0, ...capped };
  } finally {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }
}

/** 统一入口：按域名分流；B站字幕缺失时自动落 ASR（P2 兜底，字幕在就不花转写的钱）。 */
export async function fetchVideoSubtitles(url, opts = {}) {
  const s = String(url ?? '');
  if (/youtube\.com|youtu\.be/i.test(s)) return fetchYtSubtitles(s, opts);
  if (/(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i.test((() => { try { return new URL(s.trim()).hostname; } catch { return ''; } })())) {
    const r = await fetchBiliSubtitles(s);
    if (r.kind === 'none' && opts.asrFallback !== false) {
      try {
        return await fetchBiliAsr(s);
      } catch (e) {
        log(`[video-subs] ASR 兜底失败：${e?.message ?? e}`);
        return { ...r, note: `${r.note}（转写兜底也未成功：${String(e?.message ?? '').slice(0, 80)}）` };
      }
    }
    return r;
  }
  throw new Error('只认 B 站和 YouTube 链接（其他站点没有字幕通道）');
}

/* ── P3：视频看画面（GLM-5.3-Flash 视觉，主人拍板）────────────────────────
 * 针对无对白内容（过场动画/PV）：字幕和 ASR 都无解，唯一的内容层入口是画面。
 * 纪律：只描述看得见的，不推测剧情、不编对话——工具描述与 persona 同步约束。 */

export function ffprobeDuration(ffprobeBin, file) {
  return new Promise((resolve) => {
    execFile(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', String(file)],
      { timeout: 20 * 1000, maxBuffer: 64 * 1024 }, (e, so) => resolve(e ? 0 : (Number(String(so).trim()) || 0)));
  });
}

export function extractFrame(ffmpegBin, file, atSec, outJpg) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, ['-y', '-ss', String(Math.max(0, atSec)), '-i', String(file), '-frames:v', '1',
      '-vf', 'scale=640:-2', '-q:v', '5', String(outJpg)],
      { timeout: 30 * 1000, maxBuffer: 64 * 1024 }, (e) => (e ? reject(new Error(`抽帧失败 @${atSec}s：${e.message}`)) : resolve(outJpg)));
  });
}

/**
 * 看一段本地视频：抽 4 帧 → 视觉模型描述。
 * @param {object} o { file, ffmpegBin, ffprobeBin, tmpDir, vision: {baseUrl, apiKey, model} }
 * @returns {Promise<{ok:true, text:string, model:string, frames:number}|{ok:false, error:string}>}
 */
export async function lookVideoFile(o = {}) {
  const { file, ffmpegBin, ffprobeBin, tmpDir, vision } = o;
  if (!file || !fs.existsSync(file)) return { ok: false, error: `文件不存在：${file}` };
  if (!ffmpegBin) return { ok: false, error: '未配置本地 ffmpeg' };
  const dur = ffprobeBin ? await ffprobeDuration(ffprobeBin, file) : 0;
  const n = 4;
  const stamps = dur > 0
    ? Array.from({ length: n }, (_, i) => (dur * (i + 1)) / (n + 1))
    : [1, 3, 5, 7];
  fs.mkdirSync(tmpDir, { recursive: true });
  const tag = `vf-${Date.now()}`;
  const frames = [];
  try {
    for (let i = 0; i < n; i++) {
      const out = path.join(tmpDir, `${tag}-${i}.jpg`);
      try { await extractFrame(ffmpegBin, file, stamps[i], out); } catch (e) { log(`[video-look] ${e.message}`); continue; }
      if (fs.existsSync(out)) frames.push({ index: i + 1, t: stamps[i], buf: fs.readFileSync(out) });
    }
    if (!frames.length) return { ok: false, error: '一帧都没抽出来（文件损坏或不是视频？）' };
  } finally {
    try { for (const f of fs.readdirSync(tmpDir)) if (f.startsWith(tag)) fs.unlinkSync(path.join(tmpDir, f)); } catch { /* 清不掉就算了 */ }
  }
  const { describeVideoFrames } = await import('../core/vision.js');
  return describeVideoFrames(frames, vision ?? {});
}

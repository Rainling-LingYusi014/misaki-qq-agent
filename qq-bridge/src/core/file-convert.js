/* ══════════════════════════════════════════════════════════════════════════
 * 通用文件格式转换（2026-10-27）
 *
 * 设计原则：不追求"什么都能转"，只承诺**装了什么工具就能转什么**。
 *   · 启动/调用时探测 ffmpeg / LibreOffice / pandoc / poppler / img2pdf；
 *   · 能力表由探测结果生成，前端/模型先查能力再转，不会承诺一个必然失败的格式；
 *   · 只走白名单格式对，不接受任意命令/任意扩展名；
 *   · 全部 spawnSync 参数数组，不经过 shell；临时目录 + 输出大小 + 超时上限。
 *
 * 安全边界：
 *   · 只对私聊开放（与语音复刻同一套身份绑定），群聊一律拒绝；
 *   · Office 文件先查 zip 解压总量（防 zip bomb），再用**宏安全级别=3**的
 *     临时 LibreOffice 配置转换；能用 unshare 就断网跑；
 *   · 宏不会被执行，也不会保留：xlsm/docm → xlsx/docx 会丢宏（这是预期行为）；
 *   · PDF → docx 不提供（版式必丢，容易让用户以为"转换坏了"）。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { fetchFileBytes } from '../lib/message-parse.js';

const OUT_DIR = path.join(STATE_DIR, 'convert-out');
const TMP_DIR = path.join(STATE_DIR, 'convert-tmp');
const USAGE_FILE = path.join(STATE_DIR, 'convert-usage.json');

const BJ = 8 * 3600 * 1000;
const dayKey = (ms = Date.now()) => new Date(ms + BJ).toISOString().slice(0, 10);

const AUDIO_IN = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma', 'amr'];
const AUDIO_OUT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma'];
const VIDEO_IN = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv'];
/* 视频可去的格式：含完整音频提取族（工作站"提取音频"要求 mp3/m4a/wav 等）。 */
const VIDEO_OUT = ['mp4', 'mkv', 'webm', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
const IMAGE_IN = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'ico'];
const IMAGE_OUT = ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff'];
const DOC_IN = ['doc', 'docx', 'odt', 'rtf', 'txt', 'html'];
const DOC_OUT = ['pdf', 'docx', 'odt', 'txt', 'html'];
const SHEET_IN = ['xls', 'xlsm', 'xlsx', 'ods', 'csv'];
const SHEET_OUT = ['xlsx', 'ods', 'csv', 'pdf', 'html'];
const SLIDE_IN = ['ppt', 'pptx', 'odp'];
const SLIDE_OUT = ['pdf', 'pptx', 'odp'];
const ZIP_OFFICE = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'xlsm', 'docm']);

const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* ── 工具探测与能力表 ── */
let _tools = null;
export function probeTools(force = false) {
  if (_tools && !force) return _tools;
  const has = (cmd) => {
    try {
      return spawnSync('which', [cmd], { encoding: 'utf8', timeout: 4000 }).status === 0;
    } catch { return false; }
  };
  const soffice = has('soffice') || has('libreoffice');
  /* ICO 输出：ImageMagick 能做多尺寸；没有就退到 Python Pillow（也能一次写多尺寸）。
   * convert.exe 在 Windows 上是系统盘符转换工具，所以必须用 -version 里的 "ImageMagick" 确认。 */
  const imOk = (cmd) => {
    try {
      const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 5000 });
      return r.status === 0 && /ImageMagick/i.test(`${r.stdout || ''}${r.stderr || ''}`);
    } catch { return false; }
  };
  const magick = has('magick') && imOk('magick');
  const convert = !magick && has('convert') && imOk('convert');
  let pyCmd = '';
  for (const cmd of ['python3', 'python']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import PIL; print(PIL.__version__)'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) { pyCmd = cmd; break; }
    } catch { /* ignore */ }
  }
  _tools = {
    ffmpeg: has('ffmpeg'),
    soffice,
    sofficeCmd: has('soffice') ? 'soffice' : (has('libreoffice') ? 'libreoffice' : ''),
    pandoc: has('pandoc'),
    pdftoppm: has('pdftoppm'),
    pdftotext: has('pdftotext'),
    img2pdf: has('img2pdf'),
    unzip: has('unzip'),
    unshare: has('unshare'),
    magick,
    convert,
    pillow: !!pyCmd,
    pyCmd,
    ico: !!(magick || convert || pyCmd),
    icoMode: magick ? 'magick' : (convert ? 'convert' : (pyCmd ? 'pillow' : '')),
    icoCmd: magick ? 'magick' : (convert ? 'convert' : pyCmd),
  };
  return _tools;
}

function addPair(map, from, to) {
  if (!from || !to || from === to) return;
  if (!map[from]) map[from] = [];
  if (!map[from].includes(to)) map[from].push(to);
}

/** 纯函数：给定工具可用性，生成"从 X 能转到哪些格式"的表。 */
export function buildCapabilities(t = probeTools()) {
  const targets = {};
  if (t.ffmpeg) {
    for (const f of AUDIO_IN) for (const o of AUDIO_OUT) addPair(targets, f, o);
    for (const f of VIDEO_IN) for (const o of VIDEO_OUT) addPair(targets, f, o);
    for (const f of IMAGE_IN) for (const o of IMAGE_OUT) addPair(targets, f, o);
    for (const f of AUDIO_IN) addPair(targets, f, 'wma');
  }
  if (t.soffice) {
    for (const f of DOC_IN) for (const o of DOC_OUT) addPair(targets, f, o);
    for (const f of SHEET_IN) for (const o of SHEET_OUT) addPair(targets, f, o);
    for (const f of SLIDE_IN) for (const o of SLIDE_OUT) addPair(targets, f, o);
    for (const f of [...DOC_IN, ...SHEET_IN, ...SLIDE_IN]) addPair(targets, f, 'pdf');
  }
  if (t.pandoc) {
    for (const f of ['md', 'html', 'txt', 'docx']) for (const o of ['md', 'html', 'txt', 'docx', 'odt']) addPair(targets, f, o);
  }
  if (t.pdftotext) addPair(targets, 'pdf', 'txt');
  if (t.pdftoppm) { addPair(targets, 'pdf', 'png'); addPair(targets, 'pdf', 'jpg'); }
  if (t.ico) for (const f of IMAGE_IN) if (f !== 'ico') addPair(targets, f, 'ico');
  if (t.img2pdf) for (const f of IMAGE_IN) if (f !== 'ico') addPair(targets, f, 'pdf');
  for (const k of Object.keys(targets)) targets[k].sort();

  const notes = [];
  if (!t.ffmpeg) notes.push('ffmpeg 未安装：音频/视频/图片互转不可用');
  if (!t.soffice) notes.push('LibreOffice 未安装：docx/xlsm/pptx 等 Office 转换不可用');
  if (!t.pandoc) notes.push('pandoc 未安装：md/html/docx 互转少一条路径');
  if (!t.pdftoppm) notes.push('pdftoppm 未安装：PDF 转图片不可用');
  if (!t.pdftotext) notes.push('pdftotext 未安装：PDF 转文本不可用');
  if (!t.img2pdf) notes.push('img2pdf 未安装：图片转 PDF 不可用');
  if (!t.ico) notes.push('转 ICO 需要 ImageMagick（magick/convert）或 Python Pillow');
  notes.push('PDF → docx 不提供（版式会丢）；可转 txt/png/jpg');
  notes.push('xlsm/docm → xlsx/docx 会丢弃宏，这是预期行为');
  notes.push('视频同格式（如 mp4→mp4）= 压缩，可带 crf / level(low/medium/high) / maxHeight / mute');
  notes.push('视频→gif 可带 start / duration(≤60s) / fps / width；视频可直接提取音频 mp3/m4a/wav/flac 等');
  notes.push('多张图可合成一个 PDF（messageIds 传多条 + target=pdf，pageSize auto/a4/letter）');
  return { tools: { ...t }, targets, notes };
}

export function capabilities() {
  return buildCapabilities(probeTools(true));
}

/* ── 转码器 ── */
let _oggEncoder = null;
function oggEncoder() {
  if (_oggEncoder) return _oggEncoder;
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
    const s = `${r.stdout || ''}${r.stderr || ''}`;
    _oggEncoder = /\blibopus\b/.test(s) ? 'libopus' : (/\blibvorbis\b/.test(s) ? 'libvorbis' : 'libopus');
  } catch { _oggEncoder = 'libopus'; }
  return _oggEncoder;
}

function audioArgs(to) {
  switch (to) {
    case 'mp3': return ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
    case 'wav': return ['-vn', '-c:a', 'pcm_s16le'];
    case 'm4a': return ['-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
    case 'aac': return ['-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts'];
    case 'ogg': return ['-vn', '-c:a', oggEncoder(), '-b:a', '96k'];
    case 'flac': return ['-vn', '-c:a', 'flac'];
    case 'wma': return ['-vn', '-c:a', 'wmav2', '-b:a', '192k'];
    default: return ['-vn'];
  }
}

/** 视频转码参数。opts 来自 validateConvertOptions：
 *  · 压缩（mp4/mkv/webm，含同格式压缩）：crf / preset / maxHeight / mute
 *  · GIF：start / duration / fps / width（两遍调色板，画质比裸 fps=10 好一截） */
function videoArgs(to, opts = {}) {
  switch (to) {
    case 'mp4': return [
      '-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-crf', String(opts.crf || 23),
      ...(opts.maxHeight ? ['-vf', `scale=-2:${opts.maxHeight}:flags=lanczos`] : []),
      ...(opts.mute ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
      '-movflags', '+faststart',
    ];
    case 'mkv': return [
      '-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-crf', String(opts.crf || 23),
      ...(opts.maxHeight ? ['-vf', `scale=-2:${opts.maxHeight}:flags=lanczos`] : []),
      ...(opts.mute ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
    ];
    case 'webm': return [
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '5', '-crf', String(opts.crf || 32), '-b:v', '0',
      ...(opts.maxHeight ? ['-vf', `scale=-2:${opts.maxHeight}:flags=lanczos`] : []),
      ...(opts.mute ? ['-an'] : ['-c:a', 'libopus']),
    ];
    case 'gif': return [
      '-vf',
      `fps=${opts.fps || 10},scale=${opts.width || 480}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`,
      '-loop', '0',
    ];
    case 'mp3': return ['-vn', ...audioArgs('mp3')];
    case 'wav': return ['-vn', ...audioArgs('wav')];
    case 'm4a': return ['-vn', ...audioArgs('m4a')];
    case 'aac': return ['-vn', ...audioArgs('aac')];
    case 'ogg': return ['-vn', ...audioArgs('ogg')];
    case 'flac': return ['-vn', ...audioArgs('flac')];
    default: return [];
  }
}

function imageArgs(to) {
  const first = ['-frames:v', '1'];
  switch (to) {
    case 'jpg': return [...first, '-q:v', '2'];
    case 'webp': return [...first, '-quality', '85'];
    case 'gif': return ['-loop', '0'];
    default: return first;
  }
}

function sofficeFilter(to) {
  /* 直接用目标扩展名：LibreOffice 会按文档类型挑默认 filter，跨版本最稳；
   * 写死 "Calc MS Excel 2007 XML" 这类 filter 名反而在版本升级后容易失配。 */
  return to;
}

/** 纯校验：视频相关可选项（GIF 截段/帧率/宽度；压缩 crf/档位/限高/静音）。
 *  level 是给人看的档位：low=更小（crf 32）、medium=均衡（26）、high=更高画质（20）；显式 crf 优先。 */
export function validateConvertOptions(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const out = {};
  const start = o.start == null ? 0 : num(o.start);
  if (start < 0 || start > 3600) throw new Error('start（开始秒数）要在 0~3600 之间');
  if (start > 0) out.start = start;
  const duration = o.duration == null ? 0 : num(o.duration);
  if (duration < 0 || duration > 600) throw new Error('duration（时长秒数）要在 0~600 之间');
  if (duration > 0) out.duration = duration;
  const fps = o.fps == null ? 0 : num(o.fps);
  if (fps && !(fps >= 1 && fps <= 30)) throw new Error('fps 要在 1~30 之间');
  if (fps) out.fps = fps;
  const width = o.width == null ? 0 : Math.round(num(o.width));
  if (width && (width < 64 || width > 1280)) throw new Error('GIF 宽度要在 64~1280 之间');
  if (width) out.width = width;
  const crf = o.crf == null ? 0 : Math.round(num(o.crf));
  if (crf && (crf < 14 || crf > 40)) throw new Error('crf 要在 14~40 之间（越大文件越小、画质越低）');
  if (crf) out.crf = crf;
  const level = String(o.level ?? '').trim().toLowerCase();
  if (level && !['low', 'medium', 'high'].includes(level)) throw new Error('压缩档位 level 只有 low / medium / high');
  if (level) out.level = level;
  if (!out.crf && out.level) out.crf = out.level === 'low' ? 32 : (out.level === 'high' ? 20 : 26);
  const maxHeight = o.maxHeight == null ? 0 : Math.round(num(o.maxHeight));
  if (maxHeight && ![240, 360, 480, 540, 720, 1080, 1440].includes(maxHeight)) {
    throw new Error('maxHeight 只支持 240 / 360 / 480 / 540 / 720 / 1080 / 1440');
  }
  if (maxHeight) out.maxHeight = maxHeight;
  out.mute = o.mute === true;
  return out;
}

/* 输入侧 seek/截段：-ss / -t 放在 -i 前面（快速定位）。 */
function ffmpegPre(opts) {
  const pre = [];
  if (opts?.start > 0) pre.push('-ss', String(opts.start));
  if (opts?.duration > 0) pre.push('-t', String(opts.duration));
  return pre;
}

/** 纯函数：给定 from/to/工具/选项，返回执行计划；不支持时抛出可读原因。 */
export function planFor(from, to, t = probeTools(), opts = {}) {
  const f = String(from ?? '').toLowerCase().replace(/^\./, '');
  const o = String(to ?? '').toLowerCase().replace(/^\./, '');
  if (!f || !o) throw new Error('缺少源格式或目标格式');
  if (f === o) {
    /* 同格式只放行视频压缩（重编码），例如 mp4→mp4 压体积；其他同格式没有意义。 */
    if (VIDEO_IN.includes(f)) {
      if (!t.ffmpeg) throw new Error('ffmpeg 未安装，视频压缩不可用');
      return { kind: 'ffmpeg', pre: ffmpegPre(opts), args: videoArgs(o, opts), ext: o };
    }
    throw new Error(`源格式和目标格式相同（${f}）`);
  }

  if (AUDIO_IN.includes(f) && AUDIO_OUT.includes(o)) {
    if (!t.ffmpeg) throw new Error('ffmpeg 未安装，音频转换不可用');
    return { kind: 'ffmpeg', args: audioArgs(o), ext: o };
  }
  if (VIDEO_IN.includes(f) && VIDEO_OUT.includes(o)) {
    if (!t.ffmpeg) throw new Error('ffmpeg 未安装，视频转换不可用');
    if (o === 'gif' && (opts.duration || 0) > 60) throw new Error('GIF 一次最多截取 60 秒；要更长的请保持视频格式或分段转换');
    return { kind: 'ffmpeg', pre: ffmpegPre(opts), args: videoArgs(o, opts), ext: o };
  }
  if (IMAGE_IN.includes(f) && o === 'ico') {
    if (!t.ico) throw new Error('转 ICO 需要 ImageMagick（magick/convert）或 Python Pillow');
    return { kind: 'ico', mode: t.icoMode, cmd: t.icoCmd, ext: 'ico' };
  }
  if (IMAGE_IN.includes(f) && IMAGE_OUT.includes(o)) {
    if (!t.ffmpeg) throw new Error('ffmpeg 未安装，图片转换不可用');
    return { kind: 'ffmpeg', args: imageArgs(o), ext: o };
  }
  if (f === 'pdf' && (o === 'txt' || o === 'png' || o === 'jpg')) {
    if (o === 'txt') {
      if (!t.pdftotext) throw new Error('pdftotext 未安装，PDF 转文本不可用');
      return { kind: 'pdftotext', ext: 'txt' };
    }
    if (!t.pdftoppm) throw new Error('pdftoppm 未安装，PDF 转图片不可用');
    return { kind: 'pdftoppm', ext: o };
  }
  if (IMAGE_IN.includes(f) && f !== 'ico' && o === 'pdf') {
    if (!t.img2pdf) throw new Error('img2pdf 未安装，图片转 PDF 不可用');
    return { kind: 'img2pdf', ext: 'pdf' };
  }
  if ((DOC_IN.includes(f) && DOC_OUT.includes(o))
    || (SHEET_IN.includes(f) && SHEET_OUT.includes(o))
    || (SLIDE_IN.includes(f) && SLIDE_OUT.includes(o))) {
    if (!t.soffice) throw new Error('LibreOffice 未安装，Office 文件转换不可用');
    if (f === 'docx' && o === 'md') {
      if (!t.pandoc) throw new Error('pandoc 未安装，docx→md 不可用');
      return { kind: 'pandoc', ext: 'md' };
    }
    return { kind: 'soffice', filter: sofficeFilter(o), ext: o };
  }
  if (t.pandoc && ['md', 'html', 'txt', 'docx'].includes(f) && ['md', 'html', 'txt', 'docx', 'odt'].includes(o)) {
    return { kind: 'pandoc', ext: o };
  }
  throw new Error(`不支持 ${f} → ${o}；可用目标：${(buildCapabilities(t).targets[f] || []).join('/') || '无'}`);
}

/* ── 安全：zip 解压总量 / 宏安全配置 ── */
function zipUncompressedBytes(file) {
  const t = probeTools();
  if (!t.unzip) return null;
  const r = spawnSync('unzip', ['-l', file], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return null;
  let total = 0;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+\d{2}[-:]\d{2}\s+/.exec(line);
    if (m) total += Number(m[1]);
  }
  return total;
}

function macroSafeProfile(dir) {
  const base = path.join(dir, 'lo-profile');
  const user = path.join(base, 'user');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
</oor:items>
`);
  return `file://${base.replace(/\\/g, '/')}`;
}

function run(cmd, args, timeoutMs, { cwd } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  if (r.error) throw new Error(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) {
    const msg = `${r.stderr || r.stdout || ''}`.trim().slice(0, 300);
    throw new Error(`${cmd} 退出码 ${r.status}${msg ? `：${msg}` : ''}`);
  }
  return r;
}

/* ── 额度 ── */
const fresh = () => ({ count: 0 });
function loadUsage(uid) {
  const key = String(uid ?? '').trim();
  if (!key) throw new Error('缺少请求者 uid');
  const u = readJsonSafe(USAGE_FILE, {});
  if (u.day !== dayKey()) { u.day = dayKey(); u.global = fresh(); u.users = {}; }
  if (!u.global) u.global = fresh();
  u.global.count = num(u.global.count);
  if (!u.users || typeof u.users !== 'object') u.users = {};
  if (!u.users[key]) u.users[key] = fresh();
  u.users[key].count = num(u.users[key].count);
  return { u, per: u.users[key] };
}
function convertCfg(cfg) {
  const c = cfg?.convert ?? {};
  return {
    enabled: c.enabled !== false,
    userDailyJobs: Math.max(1, num(c.userDailyJobs, 10)),
    globalDailyJobs: Math.max(0, num(c.globalDailyJobs, 100)),
    maxInputBytes: Math.max(1, num(c.maxInputBytes, 50 * 1024 * 1024)),
    maxOutputBytes: Math.max(1, num(c.maxOutputBytes, 150 * 1024 * 1024)),
    timeoutMs: Math.max(10000, num(c.timeoutMs, 180000)),
    videoTimeoutMs: Math.max(30000, num(c.videoTimeoutMs, 300000)),
    retentionDays: Math.max(1, num(c.retentionDays, 3)),
  };
}
export { convertCfg };
function commit(u, uid, isOwner) {
  const key = String(uid);
  u.users[key] = u.users[key] || fresh();
  u.users[key].count += 1;
  if (!isOwner) u.global.count += 1;
  atomicWriteJson(USAGE_FILE, u);
}
function checkQuota(cfg, uid, isOwner) {
  const c = convertCfg(cfg);
  if (!c.enabled) throw new Error('文件转换未启用（config.json 的 convert.enabled）');
  const { u, per } = loadUsage(uid);
  if (isOwner) return { u, c, per };
  if (per.count >= c.userDailyJobs) throw new Error(`今天 ${c.userDailyJobs} 次转换已经用完，明天 0 点（北京时）恢复`);
  if (c.globalDailyJobs > 0 && u.global.count >= c.globalDailyJobs) throw new Error('今天全站转换次数已满，请明天再试');
  return { u, c, per };
}

/* ── 从 QQ 消息取文件 ── */
async function napcatPost(cfg, action, body) {
  const base = String(cfg?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.napcat?.accessToken || cfg?.napcat?.wsAccessToken || '');
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.status !== 'ok') throw new Error(`NapCat ${action} 失败：${j?.wording || j?.message || res.status}`);
  return j.data ?? j;
}

export async function fetchFileFromMessage({ cfg, messageId } = {}) {
  const id = String(messageId ?? '').trim();
  if (!id) throw new Error('缺少 messageId');
  const data = await napcatPost(cfg, 'get_msg', { message_id: /^-?\d+$/.test(id) ? Number(id) : id });
  const segs = Array.isArray(data?.message) ? data.message : [];
  const file = segs.find((s) => s?.type === 'file');
  if (!file) {
    if (segs.some((s) => s?.type === 'record')) throw new Error('这是一条语音，不是文件；请用「文件」方式发送要转换的文档/音频');
    throw new Error('这条消息里没有文件');
  }
  const d = file.data ?? {};
  const name = String(d.name || d.file || '').trim();
  const buf = await fetchFileBytes({ name, fileId: String(d.file || ''), url: String(d.url || ''), size: num(d.size, 0) }, cfg?.napcat);
  if (!buf?.length) throw new Error(`「${name}」读出来是空文件`);
  return { name, buf, messageId: id };
}

/** 取一条图片消息（image 段）或文件消息（file 段）的字节；图片编辑用。 */
export async function fetchImageFromMessage({ cfg, messageId } = {}) {
  const id = String(messageId ?? '').trim();
  if (!id) throw new Error('缺少 messageId');
  const data = await napcatPost(cfg, 'get_msg', { message_id: /^-?\d+$/.test(id) ? Number(id) : id });
  const segs = Array.isArray(data?.message) ? data.message : [];
  const seg = segs.find((s) => s?.type === 'image') || segs.find((s) => s?.type === 'file');
  if (!seg) {
    if (segs.some((s) => s?.type === 'record')) throw new Error('这是一条语音，不是图片；请直接发图片或图片文件');
    throw new Error('这条消息里没有图片');
  }
  const d = seg.data ?? {};
  let name = String(d.name || d.file || 'image');
  if (!path.extname(name)) name = `image-${Date.now()}.jpg`;
  const buf = await fetchFileBytes({ name, fileId: String(d.file || ''), url: String(d.url || ''), size: num(d.size, 0) }, cfg?.napcat);
  if (!buf?.length) throw new Error('图片读出来是空文件');
  return { name, buf, messageId: id };
}

/** 图片编辑与文件转换共用同一份额度（10 次/天；主人不限）。 */
export function reserveMediaQuota({ cfg, uid, isOwner }) {
  return checkQuota(cfg, uid, isOwner === true);
}
export function commitMediaQuota(u, uid, isOwner) {
  return commit(u, uid, isOwner === true);
}

/* ── 转换主入口 ── */
export async function convertFile({ cfg, name, buf, target, uid, isOwner, options } = {}) {
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const c = convertCfg(cfg);
  if (!c.enabled) throw new Error('文件转换未启用');
  const from = path.extname(String(name || '')).toLowerCase().replace(/^\./, '');
  const to = String(target ?? '').toLowerCase().replace(/^\./, '').trim();
  if (!from) throw new Error('文件名没有扩展名，无法判断源格式');
  if (!/^[a-z0-9]{2,6}$/.test(to)) throw new Error('目标格式非法');
  if (!buf?.length) throw new Error('文件内容为空');
  if (buf.length > c.maxInputBytes) throw new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${(c.maxInputBytes / 1048576).toFixed(0)}MB 上限`);

  const t = probeTools();
  const vopts = validateConvertOptions(options ?? {});
  const plan = planFor(from, to, t, vopts);
  const { u } = checkQuota(cfg, requester, isOwner === true);

  ensureDir(OUT_DIR);
  const jobId = `conv-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = ensureDir(path.join(TMP_DIR, jobId));
  const input = path.join(tmp, `input.${from}`);
  fs.writeFileSync(input, buf);
  const started = Date.now();
  try {
    if (ZIP_OFFICE.has(from)) {
      const bytes = zipUncompressedBytes(input);
      if (bytes != null && bytes > 300 * 1024 * 1024) {
        throw new Error(`Office 文件解压后 ${(bytes / 1048576).toFixed(0)}MB，超过 300MB 安全上限`);
      }
    }
    let produced = '';
    const timeoutMs = VIDEO_IN.includes(from) ? c.videoTimeoutMs : c.timeoutMs;

    if (plan.kind === 'ffmpeg') {
      produced = path.join(tmp, `output.${plan.ext}`);
      run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...(plan.pre ?? []), '-i', input, ...plan.args, produced], timeoutMs);
    } else if (plan.kind === 'pdftotext') {
      produced = path.join(tmp, 'output.txt');
      run('pdftotext', ['-layout', input, produced], timeoutMs);
    } else if (plan.kind === 'pdftoppm') {
      const outBase = path.join(tmp, 'page');
      run('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', `-${plan.ext}`, '-r', '150', input, outBase], timeoutMs);
      produced = `${outBase}.${plan.ext}`;
    } else if (plan.kind === 'ico') {
      produced = path.join(tmp, 'output.ico');
      if (plan.mode === 'pillow') {
        const code = [
          'from PIL import Image, ImageOps',
          'import sys',
          'im = Image.open(sys.argv[1]).convert("RGBA")',
          'im = ImageOps.pad(im, (256, 256), color=(0, 0, 0, 0), method=Image.LANCZOS)',
          'im.save(sys.argv[2], format="ICO", sizes=[(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)])',
        ].join('\n');
        run(plan.cmd, ['-c', code, input, produced], timeoutMs);
      } else {
        const alpha = ['png', 'webp', 'gif', 'tiff', 'tif'].includes(from);
        run(plan.cmd, [
          input, '-background', alpha ? 'none' : 'white', '-gravity', 'center',
          '-resize', '256x256', '-extent', '256x256',
          '-define', 'icon:auto-resize=256,128,64,48,32,16', produced,
        ], timeoutMs);
      }
    } else if (plan.kind === 'img2pdf') {
      produced = path.join(tmp, 'output.pdf');
      run('img2pdf', [input, '-o', produced], timeoutMs);
    } else if (plan.kind === 'pandoc') {
      produced = path.join(tmp, `output.${plan.ext}`);
      run('pandoc', [input, '-o', produced], timeoutMs);
    } else if (plan.kind === 'soffice') {
      const outdir = ensureDir(path.join(tmp, 'out'));
      const profile = macroSafeProfile(tmp);
      const args = ['--headless', '--nologo', '--nofirststartwizard', '--norestore', '--nolockcheck',
        `-env:UserInstallation=${profile}`, '--convert-to', plan.filter, '--outdir', outdir, input];
      if (t.unshare) {
        try {
          run('unshare', ['-n', '--', t.sofficeCmd, ...args], timeoutMs);
        } catch (e) {
          log(`[convert] unshare 断网失败，退回直接运行：${e?.message ?? e}`);
          run(t.sofficeCmd, args, timeoutMs);
        }
      } else {
        run(t.sofficeCmd, args, timeoutMs);
      }
      const files = fs.readdirSync(outdir);
      const hit = files.find((f) => path.extname(f).toLowerCase() === `.${plan.ext}`) || files[0];
      if (!hit) throw new Error('LibreOffice 没有产出文件');
      produced = path.join(outdir, hit);
    } else {
      throw new Error(`未知转换方式：${plan.kind}`);
    }

    if (!fs.existsSync(produced)) throw new Error('转换没有产出文件');
    const outBytes = fs.statSync(produced).size;
    if (outBytes > c.maxOutputBytes) {
      throw new Error(`转换结果 ${(outBytes / 1048576).toFixed(1)}MB，超过 ${(c.maxOutputBytes / 1048576).toFixed(0)}MB 上限`);
    }
    const base = path.basename(String(name || 'file'), path.extname(String(name || ''))).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || 'file';
    const stamp = new Date(Date.now() + BJ).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let fileName = `${base}-${stamp}.${plan.ext}`;
    let outPath = path.join(OUT_DIR, fileName);
    for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
      fileName = `${base}-${stamp}-${n}.${plan.ext}`;
      outPath = path.join(OUT_DIR, fileName);
    }
    fs.copyFileSync(produced, outPath);
    commit(u, requester, isOwner === true);
    cleanup(c);
    log(`[convert] ${from}→${plan.ext} 完成：${fileName} ${(outBytes / 1024).toFixed(0)}KB ${((Date.now() - started) / 1000).toFixed(1)}s uid=${requester} owner=${isOwner === true}`);
    return { ok: true, filePath: outPath, fileName, from, to: plan.ext, bytes: outBytes, ms: Date.now() - started };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function cleanup(c) {
  const cutoff = Date.now() - c.retentionDays * 86400000;
  for (const dir of [OUT_DIR, TMP_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          if (st.isDirectory()) {
            if (st.mtimeMs < Date.now() - 86400000) fs.rmSync(p, { recursive: true, force: true });
          } else if (st.mtimeMs < cutoff) fs.unlinkSync(p);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

/* PDF 工具 / 二维码等共用 convert-out 的模块，写完产物后调这个清过期文件。 */
export function cleanupConvertOutputs() {
  cleanup(convertCfg({}));
}

/* ── 多图合成 PDF（2026-10-27 晚，ling014 工作站对齐）─────────────────────────
 * 单张图→pdf 走 convertFile 正常链路；这里只处理"多条 messageIds 合一个 PDF"。
 * img2pdf 优先（页面可设 A4/Letter + 边距）；没装就退 Pillow（页面=图片尺寸，
 * 白底压平透明通道），在结果里如实标注用了哪条引擎。 */
export function validatePdfOptions(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const pageSize = String(o.pageSize ?? 'auto').trim().toLowerCase();
  if (!['auto', 'a4', 'letter'].includes(pageSize)) throw new Error('pageSize 只有 auto / a4 / letter');
  const margin = o.margin == null ? 0 : num(o.margin);
  if (margin < 0 || margin > 144) throw new Error('margin（页边距，单位 pt）要在 0~144 之间（仅 a4/letter 生效）');
  return { pageSize, margin };
}

export async function convertImagesToPdf({ cfg, images, uid, isOwner, options } = {}) {
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const c = convertCfg(cfg);
  if (!c.enabled) throw new Error('文件转换未启用');
  const list = Array.isArray(images) ? images.filter((x) => x?.buf?.length) : [];
  if (list.length < 2) throw new Error('多图合成 PDF 至少要 2 张图；单张图直接 target=pdf 就行');
  if (list.length > 50) throw new Error(`一次最多 50 张图，这次给了 ${list.length} 张`);
  const po = validatePdfOptions(options);
  for (const f of list) {
    if (f.buf.length > c.maxInputBytes) {
      throw new Error(`有一张图 ${(f.buf.length / 1048576).toFixed(1)}MB，超过 ${(c.maxInputBytes / 1048576).toFixed(0)}MB 上限`);
    }
  }
  const t = probeTools();
  if (!t.img2pdf && !t.pillow) throw new Error('图片合成 PDF 需要 img2pdf 或 Python Pillow（两者都没装）');
  const { u } = checkQuota(cfg, requester, isOwner === true);

  ensureDir(OUT_DIR);
  const jobId = `pdf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = ensureDir(path.join(TMP_DIR, jobId));
  const started = Date.now();
  try {
    const names = [];
    list.forEach((f, i) => {
      const ext = (path.extname(String(f.name || '')) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      const n = `img-${String(i + 1).padStart(3, '0')}${ext}`;
      fs.writeFileSync(path.join(tmp, n), f.buf);
      names.push(n);
    });
    const produced = path.join(tmp, 'output.pdf');
    let engine;
    let info = {};
    if (t.img2pdf) {
      engine = 'img2pdf';
      const args = names.map((n) => path.join(tmp, n));
      if (po.pageSize === 'a4') args.push('--pagesize', 'A4');
      if (po.pageSize === 'letter') args.push('--pagesize', 'Letter');
      if (po.margin > 0 && po.pageSize !== 'auto') args.push('--border', `${po.margin}pt`);
      args.push('-o', produced);
      run('img2pdf', args, c.timeoutMs);
    } else {
      engine = 'pillow';
      const code = [
        'import sys, json, os',
        'from PIL import Image, ImageOps',
        'd, dst, raw = sys.argv[1], sys.argv[2], sys.argv[3]',
        'o = json.loads(raw)',
        'pages = []',
        'for f in o["frames"]:',
        '    im = ImageOps.exif_transpose(Image.open(os.path.join(d, f)))',
        '    if im.mode != "RGB":',
        '        im = im.convert("RGBA")',
        '        bg = Image.new("RGB", im.size, (255, 255, 255))',
        '        bg.paste(im, mask=im.getchannel("A"))',
        '        im = bg',
        '    pages.append(im)',
        'pages[0].save(dst, format="PDF", save_all=True, append_images=pages[1:], resolution=150)',
        'print(json.dumps({"pages": len(pages), "bytes": os.path.getsize(dst)}))',
      ].join('\n');
      const r = run(t.pyCmd, ['-c', code, tmp, produced, JSON.stringify({ frames: names })], c.timeoutMs);
      try { info = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop() || '{}'); } catch { /* ignore */ }
      info.note = 'Pillow 合成：每页尺寸=图片尺寸，pageSize/margin 未生效（装 img2pdf 可控页面）';
    }
    if (!fs.existsSync(produced)) throw new Error('PDF 合成没有产出文件');
    const outBytes = fs.statSync(produced).size;
    if (outBytes > c.maxOutputBytes) {
      throw new Error(`PDF 有 ${(outBytes / 1048576).toFixed(1)}MB，超过 ${(c.maxOutputBytes / 1048576).toFixed(0)}MB 上限`);
    }
    const stamp = new Date(Date.now() + BJ).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let fileName = `images-${stamp}.pdf`;
    let outPath = path.join(OUT_DIR, fileName);
    for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
      fileName = `images-${stamp}-${n}.pdf`;
      outPath = path.join(OUT_DIR, fileName);
    }
    fs.copyFileSync(produced, outPath);
    commit(u, requester, isOwner === true);
    cleanup(c);
    log(`[convert] images×${list.length}→pdf（${engine}）完成：${fileName} ${(outBytes / 1024).toFixed(0)}KB ${((Date.now() - started) / 1000).toFixed(1)}s uid=${requester} owner=${isOwner === true}`);
    return {
      ok: true, filePath: outPath, fileName, from: 'images', to: 'pdf', engine,
      images: list.length, bytes: outBytes, ms: Date.now() - started,
      ...(po.pageSize !== 'auto' ? { pageSize: po.pageSize, margin: po.margin } : {}),
      ...info,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

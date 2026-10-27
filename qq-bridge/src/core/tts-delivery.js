/* ══════════════════════════════════════════════════════════════════════════
 * TTS 交付链路（2026-10-27，主人定规：只收音频文件、只交付音频文件、复刻走千问）
 *
 * 定位：一次性交付任务，不是聊天语音。
 *   输入：1~5 个音频文件（wav/mp3/m4a…，干净单人人声）
 *   输出：一个音频文件（默认 mp3，可选 wav / m4a / ogg / flac）
 *
 * 权限与额度（2026-10-27 第二轮定规）：
 *   · 只对**私聊**开放；群聊一律拒绝（群里的语音复刻容易被拿去冒充，且无法可靠绑定请求者）。
 *   · 主人（cfg.ownerQQ）不限额；普通用户每天 10 条、2,000 字、3 次建音色、3 个音色档案；普通用户总池 20,000 字/天、100 条、30 次建音色。
 *   · 全局（仅普通用户）每天 100 条、100,000 字、30 次建音色，防止多人叠加把账单打穿。
 *   · 全部按北京日 0 点刷新（state/tts-usage.json）。
 *
 * 硬规矩：
 *   · **不收语音气泡**：QQ 语音是 silk 有损压缩，拿它做复刻样本先天缺高频；
 *     气泡消息会被明确拒绝，并提示改用"文件"发送。
 *   · **不发语音气泡**：交付物只有文件，避免"听起来不像"被误判成模型能力不行。
 *   · 音色档案按 ownerUid 隔离：A 用户不能用、看不到、删不掉 B 用户的音色。
 *   · 多段样本先逐段质检打分，选最好的一段建音色；千问一个音色只吃一段样本。
 *   · 音色绑定 target_model：档案里必须存 targetModel，合成时用它。
 *   · 任何一块合成失败 → 整体失败、删半成品，不交付缺段的文件。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { fetchFileBytes } from '../lib/message-parse.js';
import { createQwenClient } from '../lib/qwen-tts.js';

const SAMPLE_DIR = path.join(STATE_DIR, 'tts-samples');
const OUT_DIR = path.join(STATE_DIR, 'tts-out');
const TMP_DIR = path.join(STATE_DIR, 'tts-tmp');
const PROFILE_FILE = path.join(STATE_DIR, 'qwen-voices.json');
const USAGE_FILE = path.join(STATE_DIR, 'tts-usage.json');

const BJ = 8 * 3600 * 1000;
const dayKey = (ms = Date.now()) => new Date(ms + BJ).toISOString().slice(0, 10);

const MIN_SAMPLE_SEC = 5;
const MAX_SAMPLE_SEC = 60;
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;   // 千问上限
const MAX_SAMPLES = 5;
const OWNER_MAX_PROFILES = 50;
const DEFAULT_USER_MAX_VOICES = 3;
const DEFAULT_CHUNK_CHARS = 450;
const DEFAULT_JOB_CHARS = 3000;
const DEFAULT_USER_DAILY_CHARS = 2000;
const SILENCE_DB = '-45dB';
const SILENCE_MIN_SEC = 0.7;
const MAX_PAUSE_SEC = 2.5;                    // 官方要求停顿 ≤2s，留 0.5s 容差
const RETENTION_DAYS = 7;

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.amr', '.wma']);

/* 交付格式：千问统一给 wav（无损源），桥这边再编码成用户要的容器。
 * 说明：wav/flac 是无损容器，但源是 TTS 输出（44.1k），不是"比模型更真"；
 *       m4a/ogg/mp3 是有损压缩，文件小、兼容性好。 */
export const OUTPUT_FORMAT_IDS = ['mp3', 'wav', 'm4a', 'ogg', 'flac'];
const OUTPUT_META = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg' },
  wav: { ext: 'wav', mime: 'audio/wav' },
  m4a: { ext: 'm4a', mime: 'audio/mp4' },
  ogg: { ext: 'ogg', mime: 'audio/ogg' },
  flac: { ext: 'flac', mime: 'audio/flac' },
};

export function normalizeOutputFormat(value, fallback = 'mp3') {
  const v = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  if (OUTPUT_META[v]) return v;
  const fb = String(fallback ?? 'mp3').trim().toLowerCase();
  return OUTPUT_META[fb] ? fb : 'mp3';
}

const ensureDir = (dir) => { fs.mkdirSync(dir, { recursive: true }); return dir; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ownerOf = (cfg) => String(cfg?.ownerQQ ?? '').trim();

/* ── 配置 ── */
function deliveryCfg(cfg) {
  const d = cfg?.voice?.delivery ?? {};
  return {
    chunkChars: Math.max(120, Math.min(600, num(d.chunkChars, DEFAULT_CHUNK_CHARS))),
    maxJobChars: Math.max(200, Math.min(10000, num(d.maxChars, DEFAULT_JOB_CHARS))),
    ownerDailyChars: Math.max(0, num(d.ownerDailyChars, 0)),
    userDailyJobs: Math.max(1, Math.min(1000, num(d.userDailyJobs, 10))),
    userDailyChars: Math.max(0, num(d.userDailyChars, num(d.dailyChars, DEFAULT_USER_DAILY_CHARS))),
    userEnrollPerDay: Math.max(0, Math.min(100, num(d.userEnrollPerDay, 5))),
    userMaxVoices: Math.max(1, num(d.userMaxVoices, 3)),
    /* 2026-10-28 额度定稿：全站池 = 单用户 600%（60 条 / 12000 字 / 30 次建音色）。 */
    globalDailyJobs: Math.max(0, num(d.globalDailyJobs, 60)),
    globalDailyChars: Math.max(0, num(d.globalDailyChars, 12000)),
    globalEnrollPerDay: Math.max(0, num(d.globalEnrollPerDay, 30)),
    defaultFormat: normalizeOutputFormat(d.defaultFormat, 'mp3'),
    bitrate: String(d.bitrate || '192k'),
    retentionDays: Math.max(1, Math.min(90, num(d.retentionDays, RETENTION_DAYS))),
  };
}

/* ── 额度（按北京日 0 点重置） ── */
const freshBucket = () => ({ jobs: 0, chars: 0, enrolls: 0 });

function loadUsage(uid) {
  const key = String(uid ?? '').trim();
  if (!key) throw new Error('缺少请求者 uid，无法计额度');
  const u = readJsonSafe(USAGE_FILE, {});
  const t = dayKey();
  if (u.day !== t) {
    u.day = t;
    u.global = freshBucket();
    u.users = {};
  }
  if (!u.global || typeof u.global !== 'object') {
    u.global = { jobs: num(u.jobs), chars: num(u.chars), enrolls: num(u.enrolls) };
  }
  u.global = { jobs: num(u.global.jobs), chars: num(u.global.chars), enrolls: num(u.global.enrolls) };
  if (!u.users || typeof u.users !== 'object') u.users = {};
  if (!u.users[key]) u.users[key] = freshBucket();
  else u.users[key] = { jobs: num(u.users[key].jobs), chars: num(u.users[key].chars), enrolls: num(u.users[key].enrolls) };
  return { u, per: u.users[key] };
}

const saveUsage = (u) => atomicWriteJson(USAGE_FILE, u);

function commitUsage(u, uid, isOwner, { chars = 0, jobs = 0, enrolls = 0 } = {}) {
  const key = String(uid ?? '').trim();
  const b = u.users[key] || (u.users[key] = freshBucket());
  b.chars += chars; b.jobs += jobs; b.enrolls += enrolls;
  if (!isOwner) {
    u.global.chars += chars; u.global.jobs += jobs; u.global.enrolls += enrolls;
  }
  saveUsage(u);
}

function checkRenderQuota({ cfg, chars, uid, isOwner }) {
  const d = deliveryCfg(cfg);
  if (d.maxJobChars > 0 && chars > d.maxJobChars) {
    throw new Error(`单次最多 ${d.maxJobChars} 字（当前 ${chars} 字）；长文请拆成多次交付`);
  }
  const { u, per } = loadUsage(uid);
  if (isOwner) {
    if (d.ownerDailyChars > 0 && per.chars + chars > d.ownerDailyChars) {
      throw new Error(`主人日额度已用尽（${per.chars}/${d.ownerDailyChars} 字），明天 0 点（北京时）恢复`);
    }
    return { u, d, per, owner: true };
  }
  if (per.jobs >= d.userDailyJobs) {
    throw new Error(`今天 ${d.userDailyJobs} 条已经用完，明天 0 点（北京时）恢复`);
  }
  if (d.userDailyChars > 0 && per.chars + chars > d.userDailyChars) {
    throw new Error(`今天字符额度不足：已用 ${per.chars}/${d.userDailyChars} 字，本条需要 ${chars} 字，明天 0 点恢复`);
  }
  if (d.globalDailyJobs > 0 && u.global.jobs >= d.globalDailyJobs) {
    throw new Error('今天全站交付条数已满，请明天再试');
  }
  if (d.globalDailyChars > 0 && u.global.chars + chars > d.globalDailyChars) {
    throw new Error('今天全站字符额度已满，请明天再试');
  }
  return { u, d, per, owner: false };
}

function checkEnrollQuota({ cfg, uid, isOwner, voiceCount }) {
  const d = deliveryCfg(cfg);
  const { u, per } = loadUsage(uid);
  const maxVoices = isOwner ? OWNER_MAX_PROFILES : d.userMaxVoices;
  if (voiceCount >= maxVoices) {
    throw new Error(`音色档案已满（${voiceCount}/${maxVoices}）；先删掉不用的音色再建（tts_voice_delete）`);
  }
  if (!isOwner) {
    if (d.userEnrollPerDay > 0 && per.enrolls >= d.userEnrollPerDay) {
      throw new Error(`今天建音色次数已用完（${d.userEnrollPerDay} 次），明天 0 点恢复`);
    }
    if (d.globalEnrollPerDay > 0 && u.global.enrolls >= d.globalEnrollPerDay) {
      throw new Error('今天全站建音色次数已满，请明天再试');
    }
  }
  return { u, d, per, owner: isOwner };
}

/* 2026-10-27（审查 P1-1）：渲染/建音色在检查与提交之间隔着网络 await（synthesize/enroll），
 * 旧「检查→长活→提交」在并发下拿旧快照写回会丢计数（少扣、可绕日限）。
 * 改为预扣：reserve 先检查再立即落盘（同步临界区），失败用 refundUsage 回补。
 * pre 是预扣前快照，保证「剩余条数/字数」的展示口径与旧实现一致（当前这条已算进去）。 */
function reserveRenderQuota({ cfg, chars, uid, isOwner }) {
  const r = checkRenderQuota({ cfg, chars, uid, isOwner }); /* 满了在这里抛 */
  const pre = { jobs: r.per.jobs, chars: r.per.chars };
  commitUsage(r.u, uid, isOwner === true, { chars, jobs: 1 });
  return { d: r.d, per: r.per, pre };
}
function refundRenderUsage({ uid, isOwner, chars, jobs = 1 }) {
  const key = String(uid ?? '').trim();
  if (!key) return;
  const { u } = loadUsage(key);
  const b = u.users[key];
  if (b) {
    b.chars = Math.max(0, b.chars - chars);
    b.jobs = Math.max(0, b.jobs - jobs);
  }
  if (!isOwner) {
    u.global.chars = Math.max(0, u.global.chars - chars);
    u.global.jobs = Math.max(0, u.global.jobs - jobs);
  }
  saveUsage(u);
}
function reserveEnrollQuota({ cfg, uid, isOwner, voiceCount }) {
  const r = checkEnrollQuota({ cfg, uid, isOwner, voiceCount }); /* 档案满/次数满在这里抛 */
  commitUsage(r.u, uid, isOwner === true, { enrolls: 1 });
  return { d: r.d, per: r.per };
}
function refundEnrollUsage({ uid, isOwner }) {
  const key = String(uid ?? '').trim();
  if (!key) return;
  const { u } = loadUsage(key);
  const b = u.users[key];
  if (b) b.enrolls = Math.max(0, b.enrolls - 1);
  if (!isOwner) u.global.enrolls = Math.max(0, u.global.enrolls - 1);
  saveUsage(u);
}
/* 交付失败回补（控制台 /api/voice/qwen/render 上传两次失败时调）。 */
export { refundRenderUsage, refundEnrollUsage };

/* ── 声音复刻用户侧授权（2026-10-28，审查 P1-3 修复）──────────────────────
 * consent=true 只是模型的转述（软闸，仍要求传）；真闸门是用户本人在 QQ 里
 * 发过一次「misaki@confirm」（桥层指令，mux.js 拦截记账，零 token）。
 * 状态落 state/voice-consent.json；file 参数可注入（测试用）。 */
const CONSENT_FILE = path.join(STATE_DIR, 'voice-consent.json');
export function hasVoiceConsent(uid, file = CONSENT_FILE) {
  const d = readJsonSafe(file, {});
  return !!(d.uids && d.uids[String(uid ?? '').trim()]);
}
export function markVoiceConsent(uid, key = '', file = CONSENT_FILE) {
  const q = String(uid ?? '').trim();
  if (!q) throw new Error('缺少 uid，无法记授权');
  const d = readJsonSafe(file, {});
  d.uids = (d.uids && typeof d.uids === 'object') ? d.uids : {};
  if (!d.uids[q]) d.uids[q] = { at: new Date().toISOString(), key: String(key ?? '') };
  atomicWriteJson(file, d);
}

/* ── 音色档案（按 ownerUid 隔离） ── */
function loadProfiles(cfg) {
  const d = readJsonSafe(PROFILE_FILE, {});
  d.voices = Array.isArray(d.voices) ? d.voices : [];
  /* 旧档案（没有 ownerUid）是主人自己建的：迁移成 ownerQQ，避免升级后"一个音色都找不到"。 */
  const owner = ownerOf(cfg);
  let changed = false;
  for (const v of d.voices) {
    if (!v.ownerUid) { v.ownerUid = owner; changed = true; }
  }
  if (changed) saveProfiles(d);
  return d;
}
const saveProfiles = (d) => atomicWriteJson(PROFILE_FILE, d);

export function listProfiles({ cfg, uid } = {}) {
  const key = String(uid ?? '').trim();
  return loadProfiles(cfg).voices
    .filter((v) => String(v.ownerUid ?? '') === key)
    .map((v) => ({
      id: v.id,
      name: v.name,
      provider: v.provider || 'qwen',
      voiceId: v.voiceId,
      targetModel: v.targetModel,
      sample: v.sample ?? null,
      consentAt: v.consentAt ?? null,
      createdAt: v.createdAt,
    }));
}

export function findProfile(nameOrId, { cfg, uid } = {}) {
  const want = String(nameOrId ?? '').trim();
  const key = String(uid ?? '').trim();
  if (!want || !key) return null;
  return loadProfiles(cfg).voices.find((v) => String(v.ownerUid ?? '') === key
    && (v.id === want || v.name === want || v.voiceId === want)) ?? null;
}

/* ── ffmpeg / ffprobe ── */
let _ffmpegOn = null;
function ffmpegAvailable() {
  if (_ffmpegOn !== null) return _ffmpegOn;
  try {
    _ffmpegOn = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 }).status === 0
      && spawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 5000 }).status === 0;
  } catch {
    _ffmpegOn = false;
  }
  if (!_ffmpegOn) log('[tts-delivery] 本机没有 ffmpeg/ffprobe：无法质检/转码/拼接，交付链路不可用');
  return _ffmpegOn;
}

function ff(args, timeoutMs = 60000) {
  return spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function ffLog(args, timeoutMs = 60000) {
  return spawnSync('ffmpeg', ['-hide_banner', ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
}

let _oggEncoder = null;
function oggEncoder() {
  if (_oggEncoder) return _oggEncoder;
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
    const s = `${r.stdout || ''}${r.stderr || ''}`;
    _oggEncoder = /\blibopus\b/.test(s) ? 'libopus' : (/\blibvorbis\b/.test(s) ? 'libvorbis' : 'libopus');
  } catch {
    _oggEncoder = 'libopus';
  }
  return _oggEncoder;
}

function encodeArgs(format, bitrate) {
  switch (format) {
    case 'wav': return ['-c:a', 'pcm_s16le'];
    case 'm4a': return ['-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart'];
    case 'ogg': return ['-c:a', oggEncoder(), '-b:a', '96k'];
    case 'flac': return ['-c:a', 'flac'];
    case 'mp3':
    default: return ['-c:a', 'libmp3lame', '-b:a', bitrate];
  }
}

function probeAudio(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', String(file),
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffprobe 读不了音频：${(r.stderr || '').trim().slice(0, 200) || '未知错误'}`);
  let j;
  try { j = JSON.parse(r.stdout || '{}'); } catch { throw new Error('ffprobe 返回无法解析'); }
  const stream = (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!stream) throw new Error('这个文件里没有音轨');
  const duration = num(j.format?.duration, num(stream.duration));
  return {
    duration,
    sampleRate: num(stream.sample_rate),
    channels: num(stream.channels, 1),
    bitRate: num(stream.bit_rate, num(j.format?.bit_rate)),
    codec: String(stream.codec_name || ''),
    format: String(j.format?.format_name || ''),
  };
}

function silenceIntervals(file, duration) {
  const r = ffLog([
    '-i', String(file),
    '-af', `silencedetect=noise=${SILENCE_DB}:d=${SILENCE_MIN_SEC}`,
    '-f', 'null', '-',
  ], 60000);
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  const re = /silence_(start|end):\s*(-?[\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/g;
  const out = [];
  let cur = null;
  for (const m of text.matchAll(re)) {
    if (m[1] === 'start') {
      cur = num(m[2], 0);
    } else if (cur != null) {
      const end = num(m[2], cur);
      out.push({ start: cur, end, dur: Math.max(0, num(m[3], end - cur)) });
      cur = null;
    }
  }
  if (cur != null && duration > cur) out.push({ start: cur, end: duration, dur: duration - cur });
  return out;
}

function volumeStats(file) {
  const r = ffLog(['-i', String(file), '-af', 'volumedetect', '-f', 'null', '-'], 60000);
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(text);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(text);
  return {
    meanDb: mean ? num(mean[1], -99) : null,
    maxDb: max ? num(max[1], -99) : null,
  };
}

/** 逐段质检：时长、采样率、静音、响度。返回分数与"为什么不合格"的人话。 */
export function analyzeSample(file) {
  if (!ffmpegAvailable()) throw new Error('服务器缺少 ffmpeg/ffprobe，无法质检音频样本');
  const info = probeAudio(file);
  const sil = silenceIntervals(file, info.duration);
  const vol = volumeStats(file);
  const silenceTotal = sil.reduce((a, b) => a + b.dur, 0);
  const longestSilence = sil.reduce((a, b) => Math.max(a, b.dur), 0);
  /* 首尾静音是录音的开头/结尾，不算"句中停顿"；只把内部停顿按官方 ≤2s 卡。 */
  const interior = sil.filter((s) => s.start > 0.4 && s.end < info.duration - 0.4);
  const longestPause = interior.reduce((a, b) => Math.max(a, b.dur), 0);
  const silenceRatio = info.duration > 0 ? silenceTotal / info.duration : 1;
  const speechSec = Math.max(0, info.duration - silenceTotal);

  const reasons = [];
  if (!(info.duration >= MIN_SAMPLE_SEC)) reasons.push(`只有 ${info.duration.toFixed(1)} 秒，至少 5 秒`);
  if (info.duration > MAX_SAMPLE_SEC) reasons.push(`超过 ${MAX_SAMPLE_SEC} 秒，请裁短后再发`);
  if (info.sampleRate < 16000) reasons.push(`采样率 ${info.sampleRate}Hz，要求 ≥16kHz`);
  if (speechSec < 5) reasons.push(`有效人声只有 ${speechSec.toFixed(1)} 秒，至少 5 秒`);
  if (silenceRatio > 0.6) reasons.push(`静音占比 ${(silenceRatio * 100).toFixed(0)}%，太安静或中间空太久`);
  if (longestPause > MAX_PAUSE_SEC) reasons.push(`句中有一段连续静音 ${longestPause.toFixed(1)} 秒，要求停顿 ≤2 秒`);
  if (vol.meanDb != null && vol.meanDb < -40) reasons.push(`平均音量只有 ${vol.meanDb.toFixed(0)}dB，太小声`);

  const warnings = [];
  if (info.duration < 10) warnings.push('样本偏短，10~20 秒的相似度会更好');
  if (info.sampleRate < 24000) warnings.push(`采样率 ${info.sampleRate}Hz 偏低，建议 24kHz 以上`);
  if (vol.maxDb != null && vol.maxDb > -0.5) warnings.push('峰值接近 0dB，可能有削波');

  const durScore = Math.max(0, 100 - Math.abs(info.duration - 20) * 4);
  const silScore = Math.max(0, 100 - silenceRatio * 220);
  const levelScore = vol.meanDb == null ? 60
    : vol.meanDb < -30 ? Math.max(0, 100 - (-30 - vol.meanDb) * 5)
      : vol.meanDb > -10 ? Math.max(0, 100 - (vol.meanDb + 10) * 5) : 100;
  const rateScore = info.sampleRate >= 24000 ? 100 : info.sampleRate >= 16000 ? 85 : 0;
  const clipScore = vol.maxDb != null && vol.maxDb > -0.5 ? 40 : 100;
  const score = Math.round(durScore * 0.35 + silScore * 0.3 + levelScore * 0.2 + rateScore * 0.1 + clipScore * 0.05);

  return {
    ok: reasons.length === 0,
    score,
    reasons,
    warnings,
    speechSec,
    duration: info.duration,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitRate: info.bitRate,
    codec: info.codec,
    silenceRatio,
    longestSilence,
    longestPause,
    meanDb: vol.meanDb,
    maxDb: vol.maxDb,
    silences: sil,
  };
}

/** 长样本选最佳窗口：优先从"静音结束"处起（句子边界），其次静音最少。 */
function pickWindow(info, targetSec = 20) {
  if (info.duration <= targetSec + 2) return null;
  const starts = new Set([0]);
  for (const s of info.silences) {
    if (s.end + targetSec <= info.duration + 0.01) starts.add(Number(s.end.toFixed(2)));
  }
  for (let s = 0; s + targetSec <= info.duration + 0.01; s += 1) starts.add(s);
  let best = { start: 0, score: Infinity };
  for (const s of starts) {
    const e = s + targetSec;
    const silence = info.silences.reduce((a, b) => a + Math.max(0, Math.min(e, b.end) - Math.max(s, b.start)), 0);
    const boundary = s === 0 || info.silences.some((b) => Math.abs(b.end - s) <= 0.35);
    const score = silence + (boundary ? 0 : 0.6);
    if (score < best.score - 0.01) best = { start: s, score };
  }
  return { start: best.start, dur: Math.min(targetSec, info.duration - best.start) };
}

function toCanonicalWav(input, output, { start = null, duration = null, sampleRate = 24000 } = {}) {
  const args = ['-y', '-i', String(input)];
  if (start != null) args.push('-ss', start.toFixed(3));
  if (duration != null) args.push('-t', duration.toFixed(3));
  args.push('-vn', '-ac', '1', '-ar', String(Math.max(16000, Math.min(48000, num(sampleRate, 24000)))), '-sample_fmt', 's16', String(output));
  const r = ff(args, 120000);
  if (r.status !== 0) throw new Error(`音频转码失败：${(r.stderr || '').trim().slice(0, 200)}`);
  return output;
}

/* ── 从 QQ 消息里取音频文件（只认 file 段，明确拒绝 record 气泡） ── */
async function napcatPost(cfg, action, body) {
  const base = String(cfg?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.napcat?.accessToken || cfg?.napcat?.wsAccessToken || '');
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.status !== 'ok') {
    throw new Error(`NapCat ${action} 失败：${j?.wording || j?.message || res.status}`);
  }
  return j.data ?? j;
}

export async function fetchAudioFilesFromMessages({ cfg, messageIds } = {}) {
  const ids = (Array.isArray(messageIds) ? messageIds : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!ids.length) throw new Error('没有给音频消息 id');
  if (ids.length > MAX_SAMPLES) throw new Error(`最多 ${MAX_SAMPLES} 个样本，当前 ${ids.length} 个`);

  const files = [];
  const bubbles = [];
  for (const id of ids) {
    const data = await napcatPost(cfg, 'get_msg', { message_id: /^-?\d+$/.test(id) ? Number(id) : id });
    const segs = Array.isArray(data?.message) ? data.message : [];
    for (const seg of segs) {
      if (seg?.type === 'record') { bubbles.push(id); continue; }
      if (seg?.type !== 'file') continue;
      const d = seg.data ?? {};
      const name = String(d.name || d.file || '').trim();
      const ext = path.extname(name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) {
        throw new Error(`「${name || '未命名文件'}」不是音频文件（只收 wav/mp3/m4a 等）`);
      }
      const buf = await fetchFileBytes({ name, fileId: String(d.file || ''), url: String(d.url || ''), size: num(d.size, 0) }, cfg?.napcat);
      if (!buf?.length) throw new Error(`「${name}」读出来是空文件`);
      if (buf.length > MAX_SAMPLE_BYTES) {
        throw new Error(`「${name}」${(buf.length / 1048576).toFixed(1)}MB，超过千问 10MB 上限`);
      }
      files.push({ name, buf, messageId: id });
    }
  }
  if (!files.length) {
    if (bubbles.length) {
      throw new Error('收到的是语音气泡。复刻只收音频文件：请点「文件」把 wav/mp3/m4a 原文件发过来，不要用按住说话的语音。');
    }
    throw new Error('这几条消息里没有音频文件');
  }
  if (bubbles.length) {
    log(`[tts-delivery] 有 ${bubbles.length} 条语音气泡被忽略（只用文件样本）`);
  }
  return files;
}

/* ── 建音色：多段质检 → 选最好的一段 → 千问建音色 → 轮询可用 ── */
export async function enrollFromSamples({ cfg, files, name, targetModel, uid, isOwner, consent } = {}) {
  if (!ffmpegAvailable()) throw new Error('服务器缺少 ffmpeg/ffprobe，无法处理样本');
  if (!Array.isArray(files) || !files.length) throw new Error('没有样本文件');
  if (files.length > MAX_SAMPLES) throw new Error(`最多 ${MAX_SAMPLES} 个样本`);
  /* 双闸（2026-10-28）：consent=true 是模型转述的软闸（仍必须传）；
   * 硬闸是用户侧授权——用户本人发过「misaki@confirm」（见上方 CONSENT 段）。 */
  if (consent !== true) throw new Error('建音色需要明确确认：这是你本人的声音，或你已获得本人授权（consent=true）');
  if (!hasVoiceConsent(uid)) {
    throw new Error('这位用户还没开通声音复刻授权：请让用户本人发送「misaki@confirm」（桥会直接回执开通，不耗对话），开通后再重试建音色。不要替用户传 consent=true 绕过。');
  }
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');

  const d = loadProfiles(cfg);
  const myVoices = d.voices.filter((v) => String(v.ownerUid ?? '') === requester).length;
  reserveEnrollQuota({ cfg, uid: requester, isOwner: isOwner === true, voiceCount: myVoices });
  /* 先建客户端：缺 key / 缺 workspace 时立刻报错，不要让用户先等完整套质检再看到"没配置"。 */
  const client = createQwenClient(cfg);

  ensureDir(SAMPLE_DIR);
  const jobId = `enroll-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = ensureDir(path.join(TMP_DIR, jobId));
  const candidates = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const ext = path.extname(f.name).toLowerCase() || '.audio';
      const raw = path.join(tmp, `sample-${String(i + 1).padStart(2, '0')}${ext}`);
      fs.writeFileSync(raw, f.buf);
      try {
        const a = analyzeSample(raw);
        candidates.push({ ...a, name: f.name, file: raw, index: i });
        log(`[tts-delivery] 样本 ${i + 1}/${files.length} 「${f.name}」：${a.score} 分，${a.duration.toFixed(1)}s，${a.sampleRate}Hz，静音 ${(a.silenceRatio * 100).toFixed(0)}%${a.warnings?.length ? `，提醒：${a.warnings.join('；')}` : ''}${a.ok ? '' : `，不合格：${a.reasons.join('；')}`}`);
      } catch (e) {
        candidates.push({ ok: false, score: 0, reasons: [String(e?.message ?? e)], name: f.name, index: i });
      }
    }
    const valid = candidates.filter((c) => c.ok).sort((a, b) => b.score - a.score);
    if (!valid.length) {
      const why = candidates.map((c) => `${c.name}：${(c.reasons || []).join('；') || '读不出来'}`).join('\n');
      throw new Error(`没有一个样本合格：\n${why}`);
    }
    const best = valid[0];
    const win = pickWindow(best);
    const profileId = `qw-${crypto.randomBytes(4).toString('hex')}`;
    const samplePath = path.join(SAMPLE_DIR, `${profileId}.wav`);
    toCanonicalWav(best.file, samplePath, { start: win?.start ?? null, duration: win?.dur ?? null, sampleRate: 24000 });

    const sampleInfo = probeAudio(samplePath);
    /* 裁剪后重新质检一次：档案里记的应该是"真正送去建音色的那段"的分数/时长，而不是原文件。 */
    let finalScore = best.score;
    try {
      const re = analyzeSample(samplePath);
      finalScore = re.score;
      if (!re.ok) log(`[tts-delivery] 裁剪后的样本仍有告警：${re.reasons.join('；')}`);
    } catch (e) {
      log(`[tts-delivery] 裁剪后复检失败（沿用原分数）：${e?.message ?? e}`);
    }
    const b64 = fs.readFileSync(samplePath).toString('base64');
    const dataUrl = `data:audio/wav;base64,${b64}`;
    if (Buffer.byteLength(b64, 'utf8') > 14 * 1024 * 1024) {
      throw new Error('样本转 wav 后过大，请把原文件裁到 20~30 秒');
    }

    const tm = String(targetModel || client.config.targetModel);
    const prefix = `misaki${dayKey().replace(/-/g, '')}${crypto.randomBytes(2).toString('hex')}`;
    const { voiceId } = await client.enroll({ audio: dataUrl, targetModel: tm, prefix });
    await client.waitReady({ voiceId });

    let nm = String(name ?? '').trim().replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || `主人-${dayKey().slice(5).replace('-', '')}`;
    const same = d.voices.filter((v) => String(v.ownerUid ?? '') === requester && v.name === nm).length;
    if (same) nm = `${nm}-${same + 1}`;

    const profile = {
      id: profileId,
      name: nm,
      ownerUid: requester,
      provider: 'qwen',
      voiceId,
      targetModel: tm,
      consentAt: new Date().toISOString(),
      sample: {
        file: path.basename(samplePath),
        sourceName: best.name,
        duration: Number(sampleInfo.duration.toFixed(2)),
        sampleRate: sampleInfo.sampleRate,
        channels: sampleInfo.channels,
        score: finalScore,
        window: win ? { start: Number(win.start.toFixed(1)), dur: Number(win.dur.toFixed(1)) } : null,
      },
      createdAt: new Date().toISOString(),
    };
    d.voices.push(profile);
    saveProfiles(d);
    log(`[tts-delivery] 千问音色已建好：${nm}（owner=${requester}，${voiceId}，model=${tm}，样本 ${profile.sample.duration}s/${finalScore} 分）`);
    return { ok: true, profile, candidates: candidates.map((c) => ({ name: c.name, ok: c.ok, score: c.score, duration: c.duration, reasons: c.reasons, warnings: c.warnings })) };
  } catch (e) {
    refundEnrollUsage({ uid: requester, isOwner: isOwner === true });
    throw e;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export async function deleteProfile({ cfg, id, uid } = {}) {
  const requester = String(uid ?? '').trim();
  const d = loadProfiles(cfg);
  const idx = d.voices.findIndex((v) => String(v.ownerUid ?? '') === requester
    && (v.id === String(id ?? '') || v.name === String(id ?? '')));
  if (idx < 0) throw new Error(`找不到音色：${id}`);
  const [gone] = d.voices.splice(idx, 1);
  let providerDeleted = false;
  let warning = '';
  try {
    const client = createQwenClient(cfg);
    await client.remove({ voiceId: gone.voiceId });
    providerDeleted = true;
  } catch (e) {
    warning = `千问侧删除失败（本地档案已删）：${e?.message ?? e}`;
    log(`[tts-delivery] ${warning}`);
  }
  try { if (gone.sample?.file) fs.unlinkSync(path.join(SAMPLE_DIR, gone.sample.file)); } catch { /* ignore */ }
  saveProfiles(d);
  return { ok: true, deleted: gone.name, providerDeleted, ...(warning ? { warning } : {}) };
}

/* ── 文本分块 ── */
export function splitText(text, maxChars = DEFAULT_CHUNK_CHARS) {
  const max = Math.max(80, num(maxChars, DEFAULT_CHUNK_CHARS));
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) return [];
  const out = [];
  const push = (x) => { const t = String(x ?? '').trim(); if (t) out.push(t); };

  for (const para of s.split(/\n+/)) {
    const sentences = para.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [para];
    let buf = '';
    for (const raw of sentences) {
      let sent = raw.trim();
      if (!sent) continue;
      const chars = [...sent];
      while (chars.length > max) {
        if (buf) { push(buf); buf = ''; }
        let cut = max;
        for (let i = max - 1; i > Math.floor(max * 0.45); i -= 1) {
          if (/[，,、：:\s]/.test(chars[i])) { cut = i + 1; break; }
        }
        push(chars.slice(0, cut).join(''));
        chars.splice(0, cut);
        sent = chars.join('').trim();
      }
      if (!sent) continue;
      if ([...buf].length + [...sent].length > max) { push(buf); buf = sent; }
      else buf += sent;
    }
    push(buf);
  }
  return out;
}

/* ── 合成 → 拼接 → 响度归一 → 目标格式 ── */
function concatLine(p) {
  return `file '${String(p).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

function safeTitle(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || '语音';
}

function cleanOld(cfg) {
  const d = deliveryCfg(cfg);
  const cutoff = Date.now() - d.retentionDays * 86400000;
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

/**
 * 把文本合成一个音频文件并落盘（不发消息；发送由 console 端做）。
 * @param {object} opts
 * @param {string} opts.uid 请求者 QQ（额度与音色归属）
 * @param {boolean} opts.isOwner 主人不限额
 * @param {string} [opts.format] mp3|wav|m4a|ogg|flac
 */
export async function renderToAudio({ cfg, voice, text, title, uid, isOwner, format } = {}) {
  if (!ffmpegAvailable()) throw new Error('服务器缺少 ffmpeg/ffprobe，无法拼接与导出音频');
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const d0 = deliveryCfg(cfg);
  const fmt = normalizeOutputFormat(format, d0.defaultFormat);
  const meta = OUTPUT_META[fmt];
  const profile = findProfile(voice, { cfg, uid: requester });
  if (!profile) throw new Error(`找不到音色：${voice ?? '（空）'}；先用 tts_enroll_voice 建一个，或把音色名说清楚`);
  const t = String(text ?? '').trim();
  if (!t) throw new Error('要读的文本是空的');
  const chars = [...t].length;
  const { d, per } = reserveRenderQuota({ cfg, chars, uid: requester, isOwner: isOwner === true });
  const chunks = splitText(t, d.chunkChars);
  if (!chunks.length) throw new Error('文本分块后为空');

  const client = createQwenClient(cfg);
  const jobId = `render-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  ensureDir(OUT_DIR);
  const tmp = ensureDir(path.join(TMP_DIR, jobId));
  const started = Date.now();
  try {
    const parts = [];
    let actualRate = client.config.sampleRate;
    for (let i = 0; i < chunks.length; i += 1) {
      const r = await client.synthesize({
        text: chunks[i],
        voiceId: profile.voiceId,
        targetModel: profile.targetModel,
        format: 'wav',
        sampleRate: actualRate,
      });
      actualRate = r.sampleRate || actualRate;
      const raw = path.join(tmp, `raw-${String(i + 1).padStart(3, '0')}.${r.format === 'wav' ? 'wav' : r.format}`);
      fs.writeFileSync(raw, r.buf);
      const canon = path.join(tmp, `chunk-${String(i + 1).padStart(3, '0')}.wav`);
      toCanonicalWav(raw, canon, { sampleRate: actualRate });
      parts.push(canon);
      log(`[tts-delivery] 合成 ${i + 1}/${chunks.length}：${[...chunks[i]].length} 字 → ${(r.buf.length / 1024).toFixed(0)}KB`);
    }

    const silence = path.join(tmp, 'gap.wav');
    const sr = ff(['-y', '-f', 'lavfi', '-i', `anullsrc=r=${actualRate}:cl=mono`, '-t', '0.18', '-c:a', 'pcm_s16le', silence], 30000);
    if (sr.status !== 0) throw new Error(`生成静音失败：${(sr.stderr || '').trim().slice(0, 160)}`);

    const list = path.join(tmp, 'concat.txt');
    const lines = [];
    parts.forEach((p, i) => {
      lines.push(concatLine(p));
      if (i < parts.length - 1) lines.push(concatLine(silence));
    });
    fs.writeFileSync(list, lines.join('\n') + '\n');

    const joined = path.join(tmp, 'joined.wav');
    const jr = ff(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', joined], 180000);
    if (jr.status !== 0) throw new Error(`拼接失败：${(jr.stderr || '').trim().slice(0, 200)}`);

    const norm = path.join(tmp, 'normalized.wav');
    const nr = ff(['-y', '-i', joined, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-ac', '1', norm], 180000);
    if (nr.status !== 0) throw new Error(`响度归一失败：${(nr.stderr || '').trim().slice(0, 200)}`);

    const titleSafe = safeTitle(title || t.slice(0, 16));
    const stamp = new Date(Date.now() + BJ).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let fileName = `${titleSafe}-${stamp}.${meta.ext}`;
    let outPath = path.join(OUT_DIR, fileName);
    for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
      fileName = `${titleSafe}-${stamp}-${n}.${meta.ext}`;
      outPath = path.join(OUT_DIR, fileName);
    }
    const er = ff([
      '-y', '-i', norm, '-vn',
      ...encodeArgs(fmt, d.bitrate),
      '-ar', '44100', '-ac', '1',
      '-metadata', `title=${titleSafe}`,
      '-metadata', 'artist=玲結美咲_Chanel (AI)',
      '-metadata', `comment=AI-generated voice (Qwen TTS) | ${profile.name}`,
      outPath,
    ], 180000);
    if (er.status !== 0) throw new Error(`导出 ${fmt.toUpperCase()} 失败：${(er.stderr || '').trim().slice(0, 200)}`);

    const outInfo = probeAudio(outPath);
    cleanOld(cfg);
    const remainingJobs = isOwner === true ? null : Math.max(0, d.userDailyJobs - per.jobs);
    log(`[tts-delivery] 交付完成：${fileName}（${fmt}），owner=${requester}，${chars} 字 / ${chunks.length} 块 / ${outInfo.duration.toFixed(1)}s / ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return {
      ok: true,
      filePath: outPath,
      fileName,
      format: fmt,
      mime: meta.mime,
      durationSec: Number(outInfo.duration.toFixed(1)),
      chars,
      chunks: chunks.length,
      voice: profile.name,
      voiceId: profile.voiceId,
      targetModel: profile.targetModel,
      remainingJobs,
      remainingChars: isOwner === true || d.userDailyChars === 0 ? null : Math.max(0, d.userDailyChars - per.chars),
    };
  } catch (e) {
    refundRenderUsage({ uid: requester, isOwner: isOwner === true, chars });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 兼容旧调用名（console 仍可能用 renderToMp3）。 */
export const renderToMp3 = renderToAudio;

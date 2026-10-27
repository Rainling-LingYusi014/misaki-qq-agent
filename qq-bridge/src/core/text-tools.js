/* ══════════════════════════════════════════════════════════════════════════
 * 文本 / JSON 工具（2026-10-27 晚，ling014 工作站对齐）
 *
 * 工作站上的"JSON 格式化""文本处理"是一堆纯字符操作，不需要 ffmpeg/Pillow，
 * 全部在 Node 里同步完成；唯一的状态是自己的小额度文件（state/text-usage.json）。
 *
 * 输入来源两种：模型直接把文本放在工具参数里，或给一条文件消息的 messageId
 * （桥会去 NapCat 取文件按 UTF-8 读，≤1MB）。输出短的（≤5000 字符）直接内联
 * 返回给模型转述；长的落盘成文件发回，不在聊天里刷屏。
 * ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';

const OUT_DIR = path.join(STATE_DIR, 'convert-out'); // 与转换产物同目录、同 3 天保留
const USAGE_FILE = path.join(STATE_DIR, 'text-usage.json');
const BJ = 8 * 3600 * 1000;
const dayKey = (ms = Date.now()) => new Date(ms + BJ).toISOString().slice(0, 10);

export const TEXT_INLINE_LIMIT = 5000;

export const TEXT_OPS = [
  'json-format', 'json-minify', 'json-validate',
  'base64-encode', 'base64-decode', 'url-encode', 'url-decode',
  'hash', 'count', 'dedupe', 'sort-lines', 'reverse-lines',
  'upper', 'lower', 'trim-lines', 'replace',
];

export function textCapabilities() {
  return {
    available: true,
    ops: TEXT_OPS,
    jsonFormat: { indent: '2 / 4 / tab / 0(收成一行)', sortKeys: '布尔，默认 false' },
    hash: { algo: 'md5 / sha1 / sha256 / sha512', default: 'sha256' },
    sortLines: { order: 'asc / desc / length', numeric: '布尔，按数字大小排' },
    replace: { find: '必填', replaceWith: '默认空串', regex: '布尔，默认 false（字面替换）', all: '布尔，默认 true' },
    input: 'text 直接传文本，或 messageId（文件消息，UTF-8，≤1MB）',
    output: '≤5000 字符内联回来；超过就落成 .txt 文件发回',
  };
}

/** 纯函数：执行一个文本操作。测试直接打这个。 */
export function runTextOp(op, text, options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  switch (String(op ?? '').trim().toLowerCase()) {
    case 'json-format': {
      const parsed = parseJsonStrict(text);
      const indentRaw = String(o.indent ?? '2').toLowerCase();
      const indent = indentRaw === 'tab' ? '\t' : (indentRaw === '0' || indentRaw === 'min' ? 0 : Number(indentRaw) || 2);
      /* JSON.stringify 不会自己排键；sortKeys 就先深拷贝重排一遍。 */
      const body = o.sortKeys === true
        ? JSON.stringify(sortKeysDeep(parsed), null, indent || undefined)
        : JSON.stringify(parsed, null, indent || undefined);
      return indent === 0 ? body : `${body}\n`;
    }
    case 'json-minify':
      return JSON.stringify(parseJsonStrict(text));
    case 'json-validate': {
      try {
        parseJsonStrict(text);
        return 'JSON 合法 ✓';
      } catch (e) {
        return `JSON 不合法：${e.message}`;
      }
    }
    case 'base64-encode':
      return Buffer.from(text, 'utf8').toString('base64');
    case 'base64-decode': {
      const buf = Buffer.from(text.trim(), 'base64');
      if (buf.toString('base64').replace(/=+$/, '') !== text.trim().replace(/=+$/, '')) {
        throw new Error('这不是合法的 base64');
      }
      return buf.toString('utf8');
    }
    case 'url-encode':
      return encodeURIComponent(text);
    case 'url-decode':
      return decodeURIComponent(text.replace(/\+/g, '%20'));
    case 'hash': {
      const algo = String(o.algo ?? 'sha256').toLowerCase();
      if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) throw new Error('algo 只有 md5 / sha1 / sha256 / sha512');
      return crypto.createHash(algo).update(text, 'utf8').digest('hex');
    }
    case 'count': {
      const chars = [...text].length; // 按码点数，emoji 不算两个
      const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
      const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
      const latinWords = (text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'\-]+/g) || []).length;
      return `字符（码点）：${chars}\n字节（UTF-8）：${Buffer.byteLength(text, 'utf8')}\n行数：${lines}\n中日韩字符：${cjk}\n西文单词：${latinWords}`;
    }
    case 'dedupe': {
      const seen = new Set();
      const out = [];
      for (const line of text.split(/\r\n|\r|\n/)) {
        const key = o.trim === false ? line : line.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
      }
      return out.join('\n');
    }
    case 'sort-lines': {
      const order = String(o.order ?? 'asc').toLowerCase();
      if (!['asc', 'desc', 'length'].includes(order)) throw new Error('order 只有 asc / desc / length');
      const lines = text.split(/\r\n|\r|\n/);
      const cmp = o.numeric
        ? (a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0)
        : (a, b) => a.localeCompare(b, 'zh-Hans-CN');
      lines.sort(order === 'desc' ? (a, b) => -cmp(a, b) : (order === 'length' ? (a, b) => a.length - b.length : cmp));
      return lines.join('\n');
    }
    case 'reverse-lines':
      return text.split(/\r\n|\r|\n/).reverse().join('\n');
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'trim-lines':
      return text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l !== '' || o.keepEmpty === true).join('\n');
    case 'replace': {
      const find = String(o.find ?? '');
      if (!find) throw new Error('replace 需要 options.find（要找什么）');
      const rep = String(o.replaceWith ?? '');
      if (o.regex) {
        const flags = o.all === false ? '' : 'g';
        return text.replace(new RegExp(find, flags), rep);
      }
      return o.all === false ? text.replace(find, rep) : text.split(find).join(rep);
    }
    default:
      throw new Error(`未知操作 ${op}；支持：${TEXT_OPS.join(' / ')}`);
  }
}

function parseJsonStrict(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const pos = Number(/position (\d+)/.exec(e.message)?.[1] ?? -1);
    if (pos >= 0) {
      const upto = text.slice(0, pos);
      const line = upto.split(/\r\n|\r|\n/).length;
      const col = pos - (upto.lastIndexOf('\n') + 1) + 1;
      throw new Error(`${e.message}（第 ${line} 行第 ${col} 列附近）`);
    }
    throw e;
  }
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
  }
  return v;
}

/* ── 额度：独立小本本；主人不限 ── */
const fresh = () => ({ count: 0 });
function textCfg(cfg) {
  const c = cfg?.text ?? {};
  return {
    enabled: c.enabled !== false,
    userDailyJobs: Math.max(1, Number(c.userDailyJobs) || 50),
    globalDailyJobs: Math.max(0, Number(c.globalDailyJobs) || 500),
    maxInputChars: Math.max(1000, Number(c.maxInputChars) || 1000000),
  };
}
function loadUsage(uid) {
  const key = String(uid ?? '').trim();
  if (!key) throw new Error('缺少请求者 uid');
  const u = readJsonSafe(USAGE_FILE, {});
  if (u.day !== dayKey()) { u.day = dayKey(); u.global = fresh(); u.users = {}; }
  if (!u.global) u.global = fresh();
  u.global.count = Number(u.global.count) || 0;
  if (!u.users || typeof u.users !== 'object') u.users = {};
  if (!u.users[key]) u.users[key] = fresh();
  u.users[key].count = Number(u.users[key].count) || 0;
  return { u, per: u.users[key] };
}
function checkQuota(cfg, uid, isOwner) {
  const c = textCfg(cfg);
  if (!c.enabled) throw new Error('文本工具未启用（config.json 的 text.enabled）');
  const { u, per } = loadUsage(uid);
  if (isOwner) return { u, c, per };
  if (per.count >= c.userDailyJobs) throw new Error(`今天 ${c.userDailyJobs} 次文本处理已经用完，明天 0 点（北京时）恢复`);
  if (c.globalDailyJobs > 0 && u.global.count >= c.globalDailyJobs) throw new Error('今天全站文本处理次数已满，请明天再试');
  return { u, c, per };
}

/**
 * 文本工具入口：取输入 → 跑操作 → 短的内联回，长的落盘。
 * 返回 { inline: true, result } 或 { inline: false, filePath, fileName, ... }。
 */
export async function runTextTool({ cfg, op, text, uid, isOwner, options } = {}) {
  const requester = String(uid ?? '').trim();
  if (!requester) throw new Error('缺少请求者 uid');
  const theOp = String(op ?? '').trim().toLowerCase();
  if (!theOp) return { ok: true, capabilities: textCapabilities() };
  if (!TEXT_OPS.includes(theOp)) {
    return { ok: true, capabilities: textCapabilities(), error: `未知操作 ${theOp}` };
  }
  const c = textCfg(cfg);
  const input = String(text ?? '');
  if (!input.length) throw new Error('没有输入文本（text 直接给，或给带文件的 messageId）');
  if (input.length > c.maxInputChars) throw new Error(`输入 ${(input.length / 1000).toFixed(0)}k 字符，超过 ${(c.maxInputChars / 1000).toFixed(0)}k 上限`);
  const { u, per } = checkQuota(cfg, requester, isOwner === true);

  const started = Date.now();
  const result = runTextOp(theOp, input, options);
  u.users[requester].count += 1;
  if (!isOwner) u.global.count += 1;
  atomicWriteJson(USAGE_FILE, u);

  if (result.length <= TEXT_INLINE_LIMIT) {
    return { ok: true, inline: true, op: theOp, chars: result.length, result, ms: Date.now() - started };
  }
  const stamp = new Date(Date.now() + BJ).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let fileName = `${theOp}-${stamp}.txt`;
  let outPath = path.join(OUT_DIR, fileName);
  for (let n = 2; fs.existsSync(outPath) && n < 100; n += 1) {
    fileName = `${theOp}-${stamp}-${n}.txt`;
    outPath = path.join(OUT_DIR, fileName);
  }
  fs.writeFileSync(outPath, result, 'utf8');
  log(`[text] ${theOp} 完成：${fileName} ${(result.length / 1000).toFixed(1)}k 字符 uid=${requester} owner=${isOwner === true} 剩余=${isOwner ? '不限' : Math.max(0, (textCfg(cfg).userDailyJobs) - per.count)}`);
  return { ok: true, inline: false, op: theOp, filePath: outPath, fileName, chars: result.length, ms: Date.now() - started };
}

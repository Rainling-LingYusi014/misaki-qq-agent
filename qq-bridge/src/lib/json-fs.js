// JSON/文本安全读写（原 bridge.js 模块级 73–98）
// 纯 fs 工具：容错读取（BOM）、原子写入（临时文件+rename）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
 *  required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。 */
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/** 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置。 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 原子写文本文件。 */
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 清扫崩溃残留的原子写临时文件（2026-10-28 审查 P3-10）：atomicWrite* 写 <file>.<pid>.<rand>.tmp
 * 再 rename，进程中途崩溃会留残片。只删 1 小时前的 *.tmp（刚写的绝不动），逐个容错。 */
export function sweepStaleTmpFiles(dir) {
  try {
    const cutoff = Date.now() - 3600 * 1000;
    let n = 0;
    for (const f of fs.readdirSync(String(dir))) {
      if (!f.endsWith('.tmp')) continue;
      const p = path.join(String(dir), f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.rmSync(p, { force: true }); n += 1; }
      } catch { /* 单个失败跳过 */ }
    }
    return n;
  } catch { return 0; }
}

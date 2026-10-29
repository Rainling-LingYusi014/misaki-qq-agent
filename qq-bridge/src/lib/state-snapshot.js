// 状态每日快照（2026-10-29 主人定：需要做）
//
// 为什么有这个东西：2026-10-29 凌晨出过一次事故——测试把真实 `state/social-state.json` 覆盖成
// 只有假会话的内存，5 个真实会话全丢，最后只能从 `chat.db` 一条条重建。当时 `state/` 没有任何快照，
// 能不能救回来全看另一份数据里还剩什么。
//
// 设计取舍：
//   · **白名单，不整目录拷**：state 里现在 221MB，大头是媒体/临时产物；真正会丢人的是那几个
//     JSON 与两个 SQLite 库。整目录拷既慢又会把快照自己拷进去。
//   · **每天一份、保留 7 天**：按北京时间分日；同一天只做一次（重启不重复写）。
//   · **库用 VACUUM INTO**：直接拷一个正在写的 SQLite 可能拿到半截状态；VACUUM INTO 产出的是一份
//     一致的库文件。node:sqlite 不可用时退回普通拷贝，并在 manifest 里记下方式。
//   · **失败必须出声**：快照失败只少一层保险，不影响主流程，但日志要留一行，否则等于没有。
import fs from 'node:fs';
import path from 'node:path';

/** node:sqlite 在 Node 22.5+ 才有；没有就退回普通拷贝。 */
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }

/** 每天要留一份的文件（相对于 state 目录）。缺失的跳过，不算错。 */
export const SNAPSHOT_FILES = Object.freeze([
  'social-state.json',        // 会话状态：模式、偏好、配额、水位——事故主角
  'sessions.json',
  'session-archive.json',
  'silent-sessions.json',
  'mode.json',
  'current-role.json',
  'activity-windows.json',
  'activity.json',
  'context-savings.json',
  'dsh-seq.json',
  'friend-requests.json',
  'stickers.json',
  'napcat-guard.json',
  'token-reconcile.json',
  'docx-quota.json',
  'gen-image-quota.json',
]);
/** 需要一致快照的 SQLite 库（VACUUM INTO；失败退回普通拷贝） */
export const SNAPSHOT_DBS = Object.freeze(['chat.db', 'memory.db']);

/** 北京时间日期 YYYY-MM-DD（快照按这一天分组，避免跨零点时按 UTC 分错） */
export function beijingDay(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

function pruneSnapshots(snapRoot, keepDays) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(snapRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch { return []; }
  const drop = dirs.slice(Math.max(1, keepDays));
  for (const d of drop) {
    try { fs.rmSync(path.join(snapRoot, d), { recursive: true, force: true }); } catch { /* 下次再清 */ }
  }
  return drop;
}

/**
 * 做一份今天的快照。同一天已存在则跳过（除非 force）。
 * @returns {{ok:boolean, day:string, dir:string, snapshot:boolean, copied:string[], skipped:string[],
 *            dbs:{file:string, how:string}[], pruned:string[], error?:string}}
 */
export function snapshotState({ stateDir, root = '', keepDays = 7, force = false, now = new Date(), log = () => {} } = {}) {
  const day = beijingDay(now);
  const snapRoot = path.join(stateDir, 'snapshots');
  const dir = path.join(snapRoot, day);
  const manifestPath = path.join(dir, 'manifest.json');
  const out = { ok: true, day, dir, snapshot: false, copied: [], skipped: [], dbs: [], pruned: [] };
  try {
    if (fs.existsSync(manifestPath) && !force) return out;
    fs.mkdirSync(dir, { recursive: true });

    for (const f of SNAPSHOT_FILES) {
      const src = path.join(stateDir, f);
      if (!fs.existsSync(src)) { out.skipped.push(f); continue; }
      try { fs.copyFileSync(src, path.join(dir, f)); out.copied.push(f); }
      catch (e) { out.skipped.push(f); log(`[snapshot] 复制失败 ${f}：${e?.message ?? e}`); }
    }

    // 仓库根的配置：小，且是"她怎么说话/多久主动"的另一半真相
    for (const f of ['config.json', 'config.example.json']) {
      if (!root) break;
      const src = path.join(root, f);
      if (!fs.existsSync(src)) continue;
      try { fs.copyFileSync(src, path.join(dir, f)); out.copied.push(f); } catch { /* 忽略 */ }
    }

    for (const f of SNAPSHOT_DBS) {
      const src = path.join(stateDir, f);
      if (!fs.existsSync(src)) { out.skipped.push(f); continue; }
      const dst = path.join(dir, f);
      let how = '';
      if (DatabaseSync) {
        try {
          fs.rmSync(dst, { force: true });
          const db = new DatabaseSync(src);
          try { db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); how = 'vacuum'; }
          finally { db.close(); }
        } catch { /* 退回拷贝 */ }
      }
      if (!how) {
        try { fs.copyFileSync(src, dst); how = 'copy'; } catch { how = ''; }
      }
      if (how) out.dbs.push({ file: f, how });
      else out.skipped.push(f);
    }

    const manifest = { day, at: new Date(now).toISOString(), keepDays, copied: out.copied, skipped: out.skipped, dbs: out.dbs };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    out.snapshot = true;
    out.pruned = pruneSnapshots(snapRoot, keepDays);
    log(`[snapshot] 已快照 ${out.copied.length + out.dbs.length} 个文件 → ${path.relative(stateDir, dir)}（保留 ${keepDays} 天）`);
    if (out.pruned.length) log(`[snapshot] 清理过期快照 ${out.pruned.length} 个：${out.pruned.join(', ')}`);
    return out;
  } catch (e) {
    log(`[snapshot] 失败：${e?.message ?? e}`);
    return { ...out, ok: false, error: String(e?.message ?? e) };
  }
}

/** 调度：启动时做一次，之后每小时检查一次（同一天只做一份）。 */
export function scheduleStateSnapshots({ stateDir, root = '', keepDays = 7, log = () => {}, intervalMs = 3600 * 1000 } = {}) {
  const run = () => snapshotState({ stateDir, root, keepDays, log });
  run();
  const timer = setInterval(run, Math.max(60 * 1000, Number(intervalMs) || 3600 * 1000));
  timer.unref?.();
  return timer;
}

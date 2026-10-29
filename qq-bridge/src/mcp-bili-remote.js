#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
 * mcp-bili-remote.js —— 把服务器上的 bili-cli 当成本地 MCP 服务器用
 *
 * 为什么这么搭（2026-10-28 主人拍板方案 A）：
 *   · B 站只能在服务器上碰（双 IP 铁律），而美咲的大脑（DSH）在本机；
 *   · bili-cli（pip: bili-agent）的 MCP 是 stdio 模式，所以用 ssh 把它接过来，
 *     不开监听端口、本地不落任何 B 站凭据。
 *
 * 这个代理不是单纯转发，它做三件事：
 *   1. **工具白名单**：上游 17 个工具里，评论 / 私信 / 动态 / 关注一律不暴露；
 *      `run_bili`（任意命令）对模型完全不可见——否则白名单形同虚设。
 *   2. **投稿参数由这里构造**：模型给的是结构化参数（文件、标题、标签），
 *      argv 在本文件里拼，没有拼接注入的空间。
 *   3. **发布闸**：默认只投「仅自己可见」；要公开发布必须配置显式打开
 *      social.biliUpload.allowPublic === true，否则强制转私有。
 *
 * 红线（与 M2 规约一致）：不评论、不私信、不关注、不点赞、不投币。
 * ══════════════════════════════════════════════════════════════════════════ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REMOTE = {
  host: process.env.BILI_MCP_HOST || 'ubuntu@<SERVER_IP>',
  key: process.env.BILI_MCP_KEY || path.join(os.homedir(), '.ssh', '<SSH_KEY_FILE>'),
  bin: process.env.BILI_MCP_BIN || '/home/ubuntu/bili-cli/.venv/bin/bili',
};
const SSH_ARGS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-i', REMOTE.key, REMOTE.host];
const COVER_SCRIPT = process.env.BILI_COVER_SCRIPT || '/home/ubuntu/qq-agent/deploy/media-gen/make-cover.sh';
const DEFAULT_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 20 * 60_000;

function log(msg) { try { process.stderr.write(`[mcp-bili] ${msg}\n`); } catch {} }
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/* ── 上游工具白名单（只读类；写类一律不经上游暴露） ─────────────────────── */
const UPSTREAM_READONLY = new Set([
  'status',
  'search_videos',
  'watch_video',
  'video_transcript',
  'trending',
  'list_comments',
  'recommended_videos',
]);

/* ── 我们自己合成的工具（argv 在本文件里拼） ────────────────────────────── */
const SYNTH = {
  bili_me: {
    description: 'Your own Bilibili account profile (UID / nickname / sign / level / coins / avatar). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['me', 'show'],
  },
  bili_creator_stats: {
    description: 'Creator-center stats for YOUR account: plays, visitors, follower delta, interactions, traffic split. Read-only. Numbers update next day.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['me', 'stats'],
  },
  bili_login: {
    description: 'Start QR login for the Bilibili account. Returns a LOCAL image path for the QR code plus the raw url. Show the image to the owner and ask them to scan, then call bili_wait_login.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['auth', 'login'],
    post: 'login',
  },
  bili_wait_login: {
    description: 'Wait for the owner to finish scanning the QR code (up to `seconds`). Returns logged-in account info on success.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'How long to wait (default 120, max 300)' } }, additionalProperties: false },
    argv: ({ seconds }) => ['auth', 'status', '--wait', String(Math.max(10, Math.min(300, Number(seconds) || 120)))],
  },
  bili_upload_list: {
    description: 'List YOUR uploads (newest first) with audit status and per-video data. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'published', 'reviewing', 'rejected'], description: 'Filter (default all)' },
        size: { type: 'number', description: 'How many (default 10, max 50)' },
        page: { type: 'number', description: 'Page number (default 1)' },
      },
      additionalProperties: false,
    },
    argv: ({ status, size, page }) => {
      const st = ['all', 'published', 'reviewing', 'rejected'].includes(String(status)) ? String(status) : 'all';
      const n = Math.max(1, Math.min(50, Number(size) || 10));
      const p = Math.max(1, Number(page) || 1);
      return ['upload', 'list', '--status', st, '--size', String(n), '--page', String(p)];
    },
  },
  bili_upload_status: {
    description: 'Audit status of one of your archives, plus the tags / zone / AI-declaration / visibility Bilibili actually recorded. Read-only.',
    inputSchema: { type: 'object', properties: { bvid: { type: 'string', description: 'BV id' } }, required: ['bvid'], additionalProperties: false },
    argv: ({ bvid }) => ['upload', 'status', mustBvid(bvid)],
  },
  bili_upload_stats: {
    description: 'Per-video stats: plays, interactions, interaction rate, completion rate, average watch time. Read-only.',
    inputSchema: { type: 'object', properties: { bvid: { type: 'string', description: 'BV id' } }, required: ['bvid'], additionalProperties: false },
    argv: ({ bvid }) => ['upload', 'stats', mustBvid(bvid)],
  },
  bili_upload_zones: {
    description: 'List current Bilibili zones (partition ids) for upload. Read-only; pass one as `zone` to bili_upload_video (omit it and Bilibili guesses from the title).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['upload', 'zones'],
  },
  bili_upload_video: {
    description:
      'Upload a video and submit it as an archive. Defaults to PRIVATE (only you can see it) so the owner can review before anything goes public — ' +
      'public submission only works when the owner has switched it on in config. AI-generated declaration is ON by default and must not be turned off. ' +
      '`file` is a path on the machine this server runs on; a path starting with / is treated as already on the server side. ' +
      'Needs: file, title (<=80 chars), 1-10 tags. When `cover` is omitted a cover is generated automatically on the server ' +
      '(a video frame + the title drawn in Chinese); if that fails, Bilibili grabs a frame itself.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Video file path (local path will be copied to the server automatically)' },
        title: { type: 'string', description: 'Title, max 80 chars' },
        tags: { type: 'array', items: { type: 'string' }, description: '1 to 10 tags' },
        desc: { type: 'string', description: 'Description, max 2000 chars' },
        zone: { type: 'number', description: 'Zone id from bili_upload_zones (omit to let Bilibili guess)' },
        cover: { type: 'string', description: 'Cover image path (optional)' },
        private: { type: 'boolean', description: 'true = 仅自己可见 (default true)' },
        schedule: { type: 'string', description: 'ISO publish time, 2 hours to 15 days ahead (optional)' },
        dry_run: { type: 'boolean', description: 'Preview the exact request without uploading or submitting (default false)' },
      },
      required: ['file', 'title', 'tags'],
      additionalProperties: false,
    },
    argv: buildUploadArgv,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    upload: true,
  },
};

function mustBvid(v) {
  const s = String(v ?? '').trim();
  if (!/^BV[0-9A-Za-z]{8,12}$/.test(s)) throw new Error(`不是合法的 BV 号：${s.slice(0, 24)}`);
  return s;
}

function readAllowPublic() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    return cfg?.social?.biliUpload?.allowPublic === true;
  } catch { return false; }
}

/** 上传参数 → argv（在这里拼，模型无法注入任意命令） */
function buildUploadArgv(p = {}) {
  const title = String(p.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  if (!title) throw new Error('title 不能为空');
  const tags = (Array.isArray(p.tags) ? p.tags : []).map((t) => String(t).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean).slice(0, 10);
  if (!tags.length) throw new Error('至少一个 tag');
  const argv = p.dry_run ? ['--dry-run'] : [];
  // 位置参数（文件）由调用处塞进来；--dry-run 是全局开关，必须排在子命令前面
  argv.push('upload', 'video', '__FILE__', '--title', title);
  for (const t of tags) argv.push('--tag', t);
  const desc = String(p.desc ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (desc) argv.push('--desc', desc);
  if (p.zone != null) {
    const z = Number(p.zone);
    if (Number.isFinite(z) && z > 0) argv.push('--zone', String(Math.trunc(z)));
  }
  if (p.cover) argv.push('__COVER__');
  const allowPublic = readAllowPublic();
  if (p.private === false && allowPublic) { /* 公开发布：什么都不加 */ } else argv.push('--private');
  if (p.schedule) argv.push('--schedule', String(p.schedule).slice(0, 40));
  return { argv, forcedPrivate: !(p.private === false && allowPublic) };
}

/* ── 执行 ───────────────────────────────────────────────────────────────── */
function runRemote(remoteCmd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...SSH_ARGS, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: String(e?.message ?? e), code: -1 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err, code }); });
  });
}

function scpFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', REMOTE.key, localPath, `${REMOTE.host}:${remotePath}`], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`scp 启动失败：${e?.message ?? e}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`scp 失败（${code}）：${err.slice(0, 300)}`))));
  });
}

/** 把文件弄到服务器：绝对路径视为已在服务器上 */
async function stageFile(local, remoteDir, label) {
  const p = String(local ?? '').trim();
  if (!p) throw new Error(`${label} 路径为空`);
  if (p.startsWith('/')) return p;
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`${label} 不存在：${abs}`);
  const base = path.basename(abs);
  const remote = `${remoteDir}/${base}`;
  if (remoteDir) await runRemote(`mkdir -p ${shq(remoteDir)}`, 30_000);
  await scpFile(abs, remote);
  return remote;
}

async function callBili(remoteCmd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const r = await runRemote(remoteCmd, timeoutMs);
  const text = (r.out || '').trim();
  if (text) return { text, raw: r };
  return { text: JSON.stringify({ ok: false, error: { code: 'no_output', message: r.err.slice(0, 500) || `exit ${r.code}` } }), raw: r };
}

function mcpText(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function handleSynthCall(name, params = {}) {
  const spec = SYNTH[name];
  if (!spec) throw new Error(`未知工具 ${name}`);
  let argv = spec.upload ? null : spec.argv(params);

  if (spec.upload) {
    const remoteDir = `/tmp/bili-up/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const remoteFile = await stageFile(params.file, remoteDir, '视频文件');
    let remoteCover = '';
    if (params.cover) {
      remoteCover = await stageFile(params.cover, remoteDir, '封面');
    } else {
      // 没给封面 → 从视频抽帧 + 压暗底栏 + 中文标题，比 B 站自动截帧好看得多。
      // 失败不算致命：B 站会自己抽一帧当封面。
      const genOut = `${remoteDir}/cover.jpg`;
      await runRemote(`mkdir -p ${shq(remoteDir)}`, 30_000);
      const g = await callBili(`bash ${COVER_SCRIPT} ${shq(remoteFile)} ${shq(String(params.title ?? ''))} ${shq(genOut)}`, 180_000);
      if (String(g.text).includes('cover:')) remoteCover = genOut;
      else log(`自动封面失败，改由 B 站抽帧：${String(g.text).slice(0, 160)}`);
    }
    const built = buildUploadArgv({ ...params, cover: remoteCover || '' });
    const cmdParts = [];
    for (const a of built.argv) {
      if (a === '__FILE__') cmdParts.push(shq(remoteFile));
      else if (a === '__COVER__') cmdParts.push('--cover', shq(remoteCover));
      else cmdParts.push(shq(a));
    }
    log(`上传：title=${String(params.title).slice(0, 30)} private=${built.forcedPrivate}`);
    try {
      const { text } = await callBili(`${REMOTE.bin} ${cmdParts.join(' ')}`, spec.timeoutMs ?? UPLOAD_TIMEOUT_MS);
      const note = built.forcedPrivate
        ? '\n\n(本次按「仅自己可见」投稿；公开发布需主人在配置里打开 social.biliUpload.allowPublic)'
        : '';
      return mcpText(text + note);
    } finally {
      runRemote(`rm -rf ${shq(remoteDir)}`, 30_000).catch(() => {});
    }
  }

  if (spec.post === 'login') {
    const { text } = await callBili(`${REMOTE.bin} ${argv.map(shq).join(' ')}`);
    // 二维码在服务器上是本地路径，拷回来才能给主人看
    try {
      const j = JSON.parse(text);
      const qr = j?.data?.qr_image || j?.qr_image;
      if (qr && String(qr).startsWith('/')) {
        const dir = path.join(REPO_ROOT, 'state', 'bili-qr');
        fs.mkdirSync(dir, { recursive: true });
        const local = path.join(dir, `qr-${Date.now()}.png`);
        // 二维码在服务器上是本地路径，拷回本机才能弹给主人看
        const r2 = spawn('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', REMOTE.key, `${REMOTE.host}:${qr}`, local], { windowsHide: true });
        await new Promise((res) => { r2.on('close', res); r2.on('error', res); });
        if (fs.existsSync(local)) {
          j.local_qr_image = local;
          return mcpText(JSON.stringify(j, null, 2) + `\n\n二维码已保存到 ${local}，用图片查看器打开给主人扫。`);
        }
      }
    } catch { /* 不是 JSON 就原样返回 */ }
    return mcpText(text);
  }

  const { text } = await callBili(`${REMOTE.bin} ${argv.map(shq).join(' ')}`, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return mcpText(text);
}

/* ── MCP 传输层：ssh 到服务器上的 `bili mcp serve` ──────────────────────── */
const POLICY = [
  'Bilibili tools (bili-cli over SSH, runs on the server).',
  'Available: read/research (search, watch, transcript, trending, comments list), your account profile & creator stats, login, and UPLOAD.',
  'Deliberately NOT available: commenting, replying, private messages, posting 动态, following/blocking, danmaku, liking. Do not promise these to anyone.',
  'Uploads default to 仅自己可见 (private) for the owner\'s review; AI-generated declaration is always on.',
  'Never invent numbers: every stat must come from a tool result.',
].join(' ');

const child = spawn('ssh', [...SSH_ARGS, `${REMOTE.bin} mcp serve`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.on('error', (e) => log(`ssh 启动失败：${e?.message ?? e}`));
child.on('close', (code) => { log(`上游退出 code=${code}`); try { process.exit(0); } catch {} });
child.stderr.on('data', (d) => log(`上游 stderr: ${String(d).slice(0, 300)}`));

const pending = new Map(); // 我们自己改写的请求 id → {kind}

function sendUpstream(msg) {
  try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) { log(`写上游失败：${e?.message ?? e}`); }
}
function sendClient(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch {}
}

// 上游 → 客户端
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg && msg.id != null && pending.has(msg.id)) {
    const kind = pending.get(msg.id);
    pending.delete(msg.id);
    if (kind === 'tools/list' && msg.result) {
      const keep = (msg.result.tools || []).filter((t) => UPSTREAM_READONLY.has(t.name));
      const mine = Object.entries(SYNTH).map(([name, s]) => ({ name, description: s.description, inputSchema: s.inputSchema }));
      msg.result.tools = [...keep, ...mine];
      log(`工具表：上游 ${(msg.result.tools.length - mine.length)} 个只读 + 自造 ${mine.length} 个`);
      sendClient(msg);
      return;
    }
    if (kind === 'initialize' && msg.result) {
      msg.result.instructions = POLICY;
      sendClient(msg);
      return;
    }
    sendClient(msg);
    return;
  }
  sendClient(msg);
});

// 客户端 → 上游
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg?.method === 'tools/call' && msg.id != null) {
    const name = String(msg.params?.name ?? '');
    if (name in SYNTH) {
      try {
        const res = await handleSynthCall(name, msg.params?.arguments ?? {});
        sendClient({ jsonrpc: '2.0', id: msg.id, result: res });
      } catch (e) {
        sendClient({ jsonrpc: '2.0', id: msg.id, result: mcpText(`${name} 失败：${e?.message ?? e}`, true) });
      }
      return;
    }
    if (!UPSTREAM_READONLY.has(name)) {
      sendClient({ jsonrpc: '2.0', id: msg.id, result: mcpText(`工具 ${name} 未开放（本机只开只读与投稿）`, true) });
      return;
    }
    sendUpstream(msg);
    return;
  }

  if (msg?.id != null && (msg.method === 'tools/list' || msg.method === 'initialize')) pending.set(msg.id, msg.method);
  sendUpstream(msg);
});

process.stdin.on('end', () => { try { child.kill(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { child.kill(); } catch {} process.exit(0); });

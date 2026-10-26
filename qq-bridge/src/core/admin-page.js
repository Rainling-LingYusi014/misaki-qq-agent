/* 2026-10-26（仪表盘化）：在方案B管理页基础上重排为移动优先仪表盘 + PWA。
 * 数据面：/api/health（新增：三单元+QQ+看门狗）、/api/status、/api/whitelist、
 * /api/silent-sessions、/api/token-report、/api/friend-requests（新增：审批卡）。
 * 历史注记：/api/status 的 activity 字段在服务器版是 string，本页按 Array.isArray 双形态
 * 兼容（2026-10-26 手机实机验收抓出的登录死循环根因，勿回退成 (s.activity||[]).join）。
 * 本文件整体是一个模板字符串：内部 JS 一律 '+' 拼接，禁用反引号与 ${}；换行字面量写 \\n。 */
export function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2563eb">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.ico">
<title>kizuna 仪表盘</title>
<style>
  :root { --bg:#f4f6f9; --card:#fff; --line:#dfe5ec; --tx:#1c2733; --mut:#68788c; --acc:#2563eb; --ok:#16a34a; --warn:#dc2626; }
  * { box-sizing:border-box; margin:0; }
  body { font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--tx); padding:16px; max-width:640px; margin:0 auto; }
  h1 { font-size:20px; margin-bottom:2px; }
  .sub { color:var(--mut); font-size:12px; margin-bottom:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:12px; }
  .card h2 { font-size:15px; margin-bottom:10px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .kv { display:flex; gap:6px; flex-wrap:wrap; }
  .pill { background:#eef2f7; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:13px; }
  .pill.ok { color:var(--ok); } .pill.warn { color:var(--warn); }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; background:#cbd5e1; margin-right:5px; vertical-align:1px; }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); }
  .dot.off { background:#94a3b8; }
  .pill.off { color:var(--mut); }
  input, textarea { font:inherit; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  textarea { width:100%; min-height:52px; font-family:Consolas,monospace; font-size:13px; }
  button { font:inherit; border:1px solid var(--line); background:#fff; border-radius:8px; padding:8px 16px; cursor:pointer; }
  button.pri { background:var(--acc); border-color:var(--acc); color:#fff; }
  button.danger { background:#fff; color:var(--warn); border-color:var(--warn); }
  button.mini { padding:4px 12px; font-size:12px; }
  .mut { color:var(--mut); font-size:12px; }
  pre { background:#0f172a; color:#dbeafe; border-radius:8px; padding:10px; font-size:12px; overflow:auto; max-height:260px; white-space:pre-wrap; }
  #login { max-width:420px; margin:80px auto; }
  .msg { font-size:12px; } .msg.ok{color:var(--ok);} .msg.err{color:var(--warn);}
  .fr { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:8px; }
  .qrow { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:8px; }
  .qtoggle { cursor:pointer; }
  .qrow .bar { height:6px; background:#e8edf3; border-radius:3px; margin-top:6px; overflow:hidden; }
  .qrow .bar i { display:block; height:6px; background:var(--acc); border-radius:3px; }
  .qrow .bar i.hot { background:#d97706; } .qrow .bar i.over { background:var(--warn); }
  .qchart { display:flex; align-items:flex-end; gap:2px; height:56px; margin-top:8px; }
  .qchart i { flex:1; background:#93b4f8; border-radius:2px 2px 0 0; min-height:2px; }
  .qchart i.today { background:var(--acc); }
  @media (pointer: coarse) { button { padding:10px 18px; } }
</style>
</head>
<body>
<div id="login" class="card">
  <h1>kizuna 仪表盘</h1>
  <p class="sub">输入控制台令牌（config.json 的 consoleToken）</p>
  <div class="row"><input id="tk" type="password" placeholder="console token" style="flex:1"><button class="pri" onclick="login()">进入</button></div>
  <p class="msg err" id="lgerr"></p>
</div>
<div id="app" style="display:none">
  <h1>kizuna 仪表盘</h1>
  <p class="sub">玲結美咲 · 健康与管控；数据每 30 秒自动刷新</p>

  <div class="card"><h2>运行状态</h2><div class="kv" id="health">加载中…</div><div class="kv" id="status" style="margin-top:6px"></div></div>

  <div class="card"><h2>今日用量（计费日）</h2><div class="kv" id="tok">…</div><p class="mut" style="margin-top:6px">预算闸当前关闭（social.budget 未配置即不限额）；要开启把额度写回 config.json 即热生效。</p></div>

  <div class="card"><h2>好友额度（按会话 · 计费日）</h2><div id="quota">…</div>
  <p class="mut" style="margin-top:6px">计费日 = 北京 08:00 换日（与提供方控制台同口径）；点行展开近 14 天柱状图；¥ 为按 config.tokenCost 的估算（含高峰倍率）。系统内部 = 子代理/起标题等无会话归属的消耗。</p></div>

  <div class="card"><h2>看门狗</h2><div id="guard" class="mut">…</div></div>

  <div class="card"><h2>待审批好友申请</h2><div id="friends">…</div></div>

  <div class="card"><h2>白名单与 owner（写 config.json，热生效）</h2>
    <p class="mut">私聊白名单（逗号分隔 QQ 号）</p>
    <textarea id="wlPri"></textarea>
    <p class="mut" style="margin-top:6px">ownerQQ（管理员）</p>
    <div class="row"><input id="wlOwner" style="flex:1"><button class="pri" onclick="saveWl()">保存</button><span class="msg" id="wlm"></span></div>
    <p class="mut" style="margin-top:6px">本部署不接群聊：groups 名单恒为空，此处不提供编辑。</p>
  </div>

  <div class="card"><h2>会话开关</h2>
    <p class="mut">按会话静默</p>
    <div id="silentList" style="margin:6px 0"></div>
    <div class="row"><input id="silentKey" placeholder="private:123456" style="flex:1">
      <button onclick="setSilent(true)">静默</button><button onclick="setSilent(false)">恢复</button><span class="msg" id="slm"></span></div>
    <p class="mut" style="margin-top:10px">暂停/全局静默与唤醒细节在 QQ 里用 /silent /active /set 管理（模型工具面）。</p>
  </div>

  <div class="card"><h2>活动日志（尾部 100 条）</h2><pre id="act">…</pre></div>

  <div class="card"><h2>维护</h2>
    <div class="row">
      <button class="danger" onclick="restart()">重启桥接</button>
      <span class="mut">systemd Restart=always 守护，约 5 秒恢复</span>
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const H = () => ({ 'x-console-token': sessionStorage.tk || '', 'content-type': 'application/json' });
async function api(p, opt = {}) {
  const r = await fetch(p, { headers: H(), method: opt.body ? 'POST' : 'GET', body: opt.body ? JSON.stringify(opt.body) : undefined });
  if (r.status === 401) { sessionStorage.removeItem('tk'); location.reload(); throw new Error('401'); }
  return r.json();
}
function msg(id, text, ok) { const el = $(id); el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); if (text) setTimeout(() => { el.textContent = ''; }, 4000); }
function login() {
  sessionStorage.tk = $('tk').value.trim();
  load().then(show).catch(() => { $('lgerr').textContent = '令牌无效或服务不可达'; });
}
function show() { $('login').style.display = 'none'; $('app').style.display = ''; }
const numList = (s) => s.split(/[,，\\s]+/).map((x) => x.trim()).filter(Boolean);
const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
const fmtT = (ts) => ts ? new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
const light = (t, ok, detail) => '<span class="pill ' + (ok ? 'ok' : 'warn') + '"><span class="dot ' + (ok ? 'ok' : 'warn') + '"></span>' + t + (detail ? '·' + detail : '') + '</span>';
/* 运行状态四灯专用：失效=灰（服务挂了是事实状态不是告警，红色留给看门狗那类需要行动的事） */
const lightOff = (t, ok, detail) => '<span class="pill ' + (ok ? 'ok' : 'off') + '"><span class="dot ' + (ok ? 'ok' : 'off') + '"></span>' + t + (detail ? '·' + detail : '') + '</span>';
const esc = (s) => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtWan = (n) => { const v = Number(n) || 0; if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'; if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'; return String(Math.round(v)); };
let quotaData = null; let quotaOpen = '';
function renderQuota() {
  const el = $('quota'); if (!el) return;
  if (!quotaData || !quotaData.ok) { el.innerHTML = '<span class="mut">用量数据不可读</span>'; return; }
  const limit = quotaData.dailyPerConv || 0;
  el.innerHTML = (quotaData.rows || []).map(function (r) {
    const name = r.isOwner
      ? '主人' + (r.nickname ? ' · ' + esc(r.nickname) : '')
      : (r.kind === 'internal' ? '系统内部' : (r.nickname ? esc(r.nickname) : (r.qq || esc(r.key))));
    const pct = limit > 0 && !r.isOwner ? Math.min(100, Math.round(r.today / limit * 100)) : 0;
    const barCls = pct >= 100 ? 'over' : (pct >= 80 ? 'hot' : '');
    const rightTxt = r.isOwner ? '不限额' : (limit > 0 ? '剩 ' + fmtWan(Math.max(0, limit - r.today)) : '未配置限额');
    const head = '<div class="qrow qtoggle" onclick="toggleQuota(\\'' + String(r.key).replace(/[^a-zA-Z0-9:()_-]/g, '') + '\\')">'
      + '<div class="row" style="justify-content:space-between"><b>' + name + '</b><span class="mut">' + rightTxt + '</span></div>'
      + '<div class="row" style="justify-content:space-between; margin-top:2px"><span class="mut">今日 ' + fmtWan(r.today) + (r.todayCost ? ' · ¥' + r.todayCost.toFixed(2) : '') + '</span><span class="mut">' + (r.lastTs ? fmtT(r.lastTs) : '') + '</span></div>'
      + ((r.isOwner || limit <= 0) ? '' : '<div class="bar"><i class="' + barCls + '" style="width:' + pct + '%"></i></div>')
      + '</div>';
    if (quotaOpen !== r.key) return head;
    const dates = quotaData.dates || []; const ser = r.series || {}; const cs = r.costSeries || {};
    let max = 1; for (const d of dates) { if ((ser[d] || 0) > max) max = ser[d] || 0; }
    let bars = ''; for (const d of dates) {
      const h = Math.max(2, Math.round((ser[d] || 0) / max * 54));
      bars += '<i' + (d === quotaData.todayKey ? ' class="today"' : '') + ' style="height:' + h + 'px" title="' + d + '：' + fmtWan(ser[d] || 0) + '"></i>';
    }
    let total7 = 0, cost7 = 0; for (const d of dates.slice(-7)) { total7 += ser[d] || 0; cost7 += cs[d] || 0; }
    return head + '<div style="padding:0 2px 4px"><div class="qchart">' + bars + '</div>'
      + '<div class="mut" style="margin-top:4px">' + (dates[0] || '') + ' ~ ' + (dates[dates.length - 1] || '')
      + ' · 近7日 ' + fmtWan(total7) + '（日均 ' + fmtWan(Math.round(total7 / 7)) + '）· ¥' + cost7.toFixed(2) + '</div></div>';
  }).join('') || '<span class="mut">暂无任何会话用量记录</span>';
}
function toggleQuota(k) { quotaOpen = (quotaOpen === k ? '' : k); renderQuota(); }
async function load() {
  const [hR, sR] = await Promise.all([api('/api/health'), api('/api/status')]);
  const u = hR.units || {};
  $('health').innerHTML =
    lightOff('DSH', !!(u.dsh && u.dsh.alive), u.dsh && u.dsh.alive && u.dsh.detail ? u.dsh.detail : '')
    + lightOff('桥', !!(u.bridge && u.bridge.alive))
    + lightOff('NapCat', !!(u.napcat && u.napcat.alive))
    + lightOff('QQ', !!(u.qq && u.qq.alive), u.qq && u.qq.alive && u.qq.nickname ? u.qq.nickname : '');
  $('status').innerHTML =
    '<span class="pill ' + (sR.socialPaused ? 'warn">⏸ 已暂停' : 'ok">✔ 运行中') + '</span>'
    + light('owner ' + (sR.ownerQQ ?? '未设置'), !!sR.ownerQQ)
    + light('私聊白名单 ' + (sR.allowPrivate ? sR.allowPrivate.length : 0) + ' 人', true)
    + light('静默会话 ' + (sR.silentSessionCount || 0), !(sR.silentSessionCount > 0));
  const g = hR.guard || {};
  $('guard').innerHTML = g.enabled
    ? '<span class="pill ' + (g.lastHealAt ? 'warn">⚡ 曾自愈' : 'ok">✔ 监控中') + '</span> <span class="mut">' + (g.lastHealAt ? '最近自愈 ' + fmtT(g.lastHealAt) + '：' + (g.lastHealResult || '') : '无自愈记录') + '</span>'
    : '<span class="mut">未启用（' + (g.detail || '看门狗状态文件不存在') + '）</span>';
  try {
    const fr = await api('/api/friend-requests');
    const list = fr.requests || [];
    $('friends').innerHTML = list.length
      ? list.map((x) => '<div class="fr"><b>' + (x.nickname || x.userId) + '</b> <span class="mut">(' + x.userId + ')</span>'
          + (x.comment ? '<div class="mut">验证消息：' + String(x.comment).replace(/</g, '&lt;') + '</div>' : '')
          + '<div class="row" style="margin-top:6px"><button class="pri mini" onclick="decideFriend(\\'' + x.userId + '\\',true)">通过</button>'
          + '<button class="danger mini" onclick="decideFriend(\\'' + x.userId + '\\',false)">拒绝</button>'
          + '<span class="mut">申请于 ' + fmtT(x.createdAt) + '</span></div></div>').join('')
      : '<span class="mut">无待审批申请（新申请会出现在这里）</span>';
  } catch { $('friends').innerHTML = '<span class="mut">读取失败</span>'; }
  const wl = await api('/api/whitelist');
  $('wlPri').value = (wl.allow && wl.allow.private ? wl.allow.private : []).join(', ');
  $('wlOwner').value = wl.ownerQQ ?? '';
  const si = await api('/api/silent-sessions');
  $('silentList').innerHTML = si.sessions.length
    ? si.sessions.map((x) => '<span class="pill warn">' + x.key + ' <a href="javascript:void(0)" onclick="setSilent(false,\\'' + x.key + '\\')">✕</a></span>').join(' ')
    : '<span class="mut">无</span>';
  try {
    const t = await api('/api/token-report?days=1');
    const d = (t && t.dates && t.dates[0]) || {};
    $('tok').innerHTML = '<span class="pill">输入 ' + fmt(d.prompt) + '</span><span class="pill">输出 ' + fmt(d.completion) + '</span><span class="pill">缓存读 ' + fmt(d.cacheRead) + '</span><span class="pill">缓存写 ' + fmt(d.cacheWrite) + '</span><span class="pill">请求 ' + fmt(d.samples) + ' 次</span>';
  } catch { $('tok').innerHTML = '<span class="mut">用量数据不可读</span>'; }
  try {
    const q = await api('/api/quota/overview?days=14');
    if (q && q.ok) { quotaData = q; renderQuota(); }
  } catch { if (!quotaData) $('quota').innerHTML = '<span class="mut">用量数据不可读</span>'; }
  $('act').textContent = Array.isArray(sR.activity) ? sR.activity.join('\\n') : (String(sR.activity ?? '') || '（空）');
}
async function saveWl() {
  const r = await api('/api/whitelist', { body: { allow: { private: numList($('wlPri').value), groups: [] }, ownerQQ: $('wlOwner').value.trim() } });
  msg('wlm', r.ok ? '已保存并热生效' : (r.error || '失败'), r.ok); load().catch(() => {});
}
async function setSilent(on, keyArg) {
  const key = keyArg || $('silentKey').value.trim(); if (!key) return msg('slm', '填会话 key', false);
  const r = await api('/api/silent-sessions', { body: { key, silent: on } });
  msg('slm', r.ok ? (on ? '已静默' : '已恢复') : (r.error || '失败'), r.ok); load().catch(() => {});
}
async function decideFriend(uid, approve) {
  if (!confirm((approve ? '通过' : '拒绝') + ' ' + uid + ' 的好友申请？（通过后仍需手动加入白名单才能对话）')) return;
  const r = await api('/api/friend-requests', { body: { userId: uid, approve: approve } });
  msg('wlm', r.ok ? '已' + (approve ? '通过' : '拒绝') + (r.nickname ? ' ' + r.nickname : '') : (r.error || '失败'), r.ok);
  load().catch(() => {});
}
async function restart() { if (!confirm('确认重启桥接？')) return; await api('/api/restart', { body: {} }); msg('wlm', '重启指令已发出', true); }
setInterval(() => { if (sessionStorage.tk && $('app').style.display !== 'none') load().catch(() => {}); }, 30000);
if (sessionStorage.tk) { load().then(show).catch(() => { sessionStorage.removeItem('tk'); }); }
</script>
</body>
</html>`;
}

// kizuna 素材库页（2026-10-30）：单文件自托管 HTML，照 admin-page.js 先例。
// 手机优先：缩略图懒加载、大点击目标、上传走原生文件选择器（支持相册多选）。
// 登录：输入 console token → 写 cookie mtk（<img> 与 fetch 自动携带），sessionStorage 记住。
export function materialsPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=2">
<title>kizuna 素材库</title>
<style>
  :root { --bg:#0f1115; --card:#181c24; --line:#262c38; --txt:#e8eaf0; --dim:#8a93a6; --acc:#5b8cff; --ok:#3fb27f; --err:#e06c60; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:15px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  header { position:sticky; top:0; z-index:9; background:var(--card); border-bottom:1px solid var(--line); padding:10px 14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  header h1 { font-size:17px; margin:0 auto 0 0; }
  .chips { display:flex; gap:8px; overflow-x:auto; padding:10px 14px 2px; scrollbar-width:none; }
  .chips::-webkit-scrollbar { display:none; }
  .chip { flex:0 0 auto; background:var(--card); border:1px solid var(--line); border-radius:18px; padding:6px 14px; cursor:pointer; white-space:nowrap; }
  .chip.on { border-color:var(--acc); color:var(--acc); }
  .chip small { color:var(--dim); margin-left:4px; }
  .filters { display:flex; gap:8px; padding:10px 14px; flex-wrap:wrap; }
  .filters input, .filters select, .uprow input, .uprow select { background:var(--card); border:1px solid var(--line); color:var(--txt); border-radius:8px; padding:8px 10px; font-size:14px; }
  .filters input[type=search] { flex:1; min-width:120px; }
  label.chk { display:flex; align-items:center; gap:5px; color:var(--dim); cursor:pointer; }
  #grid { columns:3 120px; column-gap:8px; padding:4px 10px 90px; }
  #grid .cell { break-inside:avoid; margin-bottom:8px; border-radius:10px; overflow:hidden; background:var(--card); position:relative; cursor:pointer; }
  #grid img { width:100%; display:block; min-height:60px; }
  #grid .cell.used::after { content:'已用'; position:absolute; right:6px; top:6px; background:rgba(0,0,0,.55); color:#ffd479; font-size:11px; padding:1px 6px; border-radius:8px; }
  #more { display:block; margin:0 auto 100px; padding:10px 26px; background:var(--card); color:var(--txt); border:1px solid var(--line); border-radius:10px; cursor:pointer; }
  .empty { text-align:center; color:var(--dim); padding:60px 20px; }
  /* 上传面板 */
  #upbar { position:fixed; left:0; right:0; bottom:0; z-index:9; background:var(--card); border-top:1px solid var(--line); padding:10px 14px; }
  #uphead { display:flex; align-items:center; gap:10px; }
  #uphead b { margin-right:auto; }
  #uptoggle { background:var(--acc); color:#fff; border:0; border-radius:8px; padding:9px 18px; font-size:15px; cursor:pointer; }
  #upbody { display:none; padding-top:10px; }
  #upbody.open { display:block; }
  .uprow { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
  .uprow input, .uprow select { flex:1; min-width:110px; }
  #drop { border:2px dashed var(--line); border-radius:12px; padding:18px; text-align:center; color:var(--dim); cursor:pointer; }
  #drop.drag { border-color:var(--acc); color:var(--acc); }
  .upitem { display:flex; gap:8px; align-items:center; padding:5px 0; font-size:13px; color:var(--dim); }
  .upitem .st-ok { color:var(--ok); } .upitem .st-err { color:var(--err); } .upitem .st-dup { color:#ffd479; }
  /* 详情弹窗 */
  #mask { position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:20; display:none; align-items:center; justify-content:center; padding:14px; }
  #mask.open { display:flex; }
  #detail { background:var(--card); border:1px solid var(--line); border-radius:14px; max-width:860px; width:100%; max-height:92vh; overflow:auto; display:flex; flex-direction:column; }
  #detail img { width:100%; max-height:52vh; object-fit:contain; background:#000; }
  #dmeta { padding:12px 14px; display:flex; flex-direction:column; gap:9px; }
  #dmeta .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  #dmeta input, #dmeta select { flex:1; min-width:100px; background:var(--bg); border:1px solid var(--line); color:var(--txt); border-radius:8px; padding:8px 10px; font-size:14px; }
  .btn { border:0; border-radius:8px; padding:9px 16px; cursor:pointer; font-size:14px; }
  .btn.pri { background:var(--acc); color:#fff; } .btn.ghost { background:transparent; border:1px solid var(--line); color:var(--txt); } .btn.danger { background:transparent; border:1px solid var(--err); color:var(--err); }
  .dim { color:var(--dim); font-size:13px; }
  /* 登录 */
  #login { position:fixed; inset:0; background:var(--bg); z-index:30; display:flex; align-items:center; justify-content:center; }
  #login .box { width:min(360px, 88vw); background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px; }
  #login input { width:100%; margin:12px 0; }
  .toast { position:fixed; left:50%; bottom:80px; transform:translateX(-50%); background:#000c; color:#fff; border-radius:10px; padding:9px 18px; z-index:40; }
</style>
</head>
<body>
<div id="login"><div class="box">
  <b>kizuna 素材库</b>
  <div class="dim">输入管理端令牌（console token）</div>
  <input id="tk" type="password" placeholder="token">
  <button class="btn pri" style="width:100%" onclick="doLogin()">进入</button>
  <div class="dim" id="lmsg" style="margin-top:8px"></div>
</div></div>

<header><h1>kizuna 素材库</h1><span class="dim" id="total"></span></header>
<div class="chips" id="cats"></div>
<div class="filters">
  <input type="search" id="q" placeholder="搜备注 / 标签 / 文件名">
  <select id="src"><option value="">来源全部</option><option>拍摄</option><option>AI绘制</option><option>收集</option></select>
  <label class="chk"><input type="checkbox" id="unused">只看没用过</label>
</div>
<div id="grid"></div>
<button id="more" onclick="loadMore()">加载更多</button>

<div id="upbar">
  <div id="uphead"><b>投递素材</b><span class="dim">拖图到页面任意位置也行</span><button id="uptoggle" onclick="toggleUp()">上传</button></div>
  <div id="upbody">
    <div class="uprow">
      <select id="upcat"></select>
      <input id="uptags" placeholder="标签，逗号分隔（如：日常,猫）">
      <select id="upsrc"><option value="">来源</option><option>拍摄</option><option>AI绘制</option><option>收集</option></select>
      <input id="upnote" placeholder="一句话说明（可选）">
    </div>
    <div id="drop" onclick="$('file').click()">点选文件 或 拖图片到这里（可多选）</div>
    <input id="file" type="file" accept="image/*" multiple hidden onchange="pickFiles(this.files)">
    <div id="uplist"></div>
  </div>
</div>

<div id="mask" onclick="if(event.target===this)closeDetail()"><div id="detail">
  <img id="dimg" alt="">
  <div id="dmeta">
    <div class="row"><input id="dtags" placeholder="标签，逗号分隔"><select id="dcat"></select></div>
    <div class="row"><input id="dnote" placeholder="一句话说明"><select id="dsrc"><option value="">来源未设</option><option>拍摄</option><option>AI绘制</option><option>收集</option></select></div>
    <div class="row"><span class="dim" id="dinfo"></span></div>
    <div class="row" style="justify-content:space-between">
      <button class="btn ghost" onclick="closeDetail()">关闭</button>
      <span><button class="btn danger" onclick="delOne()">删除</button> <button class="btn pri" onclick="saveOne()">保存</button></span>
    </div>
  </div>
</div></div>

<script>
const $ = (id) => document.getElementById(id);
let CATS = ['inbox']; let cat = ''; let offset = 0; let cur = null;

function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 2600); }
async function api(p, opt = {}) {
  const r = await fetch(p, { ...opt, headers: { 'x-console-token': sessionStorage.tk || '', ...(opt.headers || {}) } });
  if (r.status === 401) { $('login').style.display = 'flex'; throw new Error('token 失效'); }
  return r.json();
}
async function doLogin() {
  sessionStorage.tk = $('tk').value.trim();
  document.cookie = 'mtk=' + encodeURIComponent(sessionStorage.tk) + '; path=/; max-age=31536000';
  try { const r = await api('/api/materials/list'); if (!r.ok) throw 0;
    $('login').style.display = 'none'; boot(r.categories);
  } catch (e) { $('lmsg').textContent = e.message === 'token 失效' ? 'token 不对，再试试' : '连不上：' + e.message; }
}
function optList(sel, arr, val) { sel.innerHTML = arr.map((c) => \`<option\${c === val ? ' selected' : ''}>\${c}</option>\`).join(''); }
function boot(cats) {
  CATS = cats.map((c) => c.name);
  $('cats').innerHTML = \`<div class="chip\${cat === '' ? ' on' : ''}" onclick="setCat('')">全部<small>\${cats.reduce((s, c) => s + c.count, 0)}</small></div>\` +
    cats.map((c) => \`<div class="chip\${cat === c.name ? ' on' : ''}" onclick="setCat('\${c.name}')">\${c.name}<small>\${c.count}\${c.untagged ? ' · 未打标' + c.untagged : ''}</small></div>\`).join('');
  optList($('upcat'), CATS, 'inbox');
  optList($('dcat'), CATS, '');
  refresh();
}
function setCat(c) { cat = c; refresh(); }
function refresh() { offset = 0; $('grid').innerHTML = ''; loadMore(); api('/api/materials/list').then((r) => { if (r.ok) { CATS = r.categories.map((c) => c.name); $('cats').innerHTML = \`<div class="chip\${cat === '' ? ' on' : ''}" onclick="setCat('')">全部<small>\${r.categories.reduce((s, c) => s + c.count, 0)}</small></div>\` + r.categories.map((c) => \`<div class="chip\${cat === c.name ? ' on' : ''}" onclick="setCat('\${c.name}')">\${c.name}<small>\${c.count}\${c.untagged ? ' · 未打标' + c.untagged : ''}</small></div>\`).join(''); optList($('upcat'), CATS, 'inbox'); } }); }
async function loadMore() {
  const u = new URL('/api/materials/query', location.origin);
  u.searchParams.set('offset', offset); u.searchParams.set('limit', 30);
  if (cat) u.searchParams.set('category', cat);
  if ($('q').value.trim()) u.searchParams.set('q', $('q').value.trim());
  if ($('src').value) u.searchParams.set('source', $('src').value);
  if ($('unused').checked) u.searchParams.set('unused', '1');
  const r = await api(u);
  if (!r.ok) return;
  $('total').textContent = r.total ? ('共 ' + r.total + ' 张') : '';
  if (!r.items.length && offset === 0) { $('grid').innerHTML = '<div class="empty">库里还什么都没有——点右下角「上传」投第一张</div>'; $('more').style.display = 'none'; return; }
  $('more').style.display = r.items.length < 30 ? 'none' : '';
  $('grid').insertAdjacentHTML('beforeend', r.items.map((it) =>
    \`<div class="cell\${it.usedCount ? ' used' : ''}" onclick="openDetail('\${it.id}')"><img loading="lazy" src="/m/\${it.id}"></div>\`).join(''));
  offset += r.items.length;
}
async function openDetail(id) {
  const r = await api('/api/materials/detail?id=' + id);
  if (!r.ok) return toast('读不到这张');
  cur = r.item;
  $('dimg').src = '/m/' + id;
  $('dtags').value = r.item.tags.join(',');
  $('dnote').value = r.item.note;
  $('dsrc').value = r.item.source;
  optList($('dcat'), CATS, r.item.category);
  $('dinfo').textContent = \`入库 \${new Date(r.item.createdAt).toLocaleDateString()} · \${(r.item.bytes / 1024).toFixed(0)}KB\${r.item.width ? ' · ' + r.item.width + '×' + r.item.height : ''} · 用过 \${r.item.usedCount} 次\${r.item.usedIn.length ? '（最近：' + r.item.usedIn[r.item.usedIn.length - 1].where + '）' : ''}\`;
  $('mask').classList.add('open');
}
function closeDetail() { $('mask').classList.remove('open'); }
async function saveOne() {
  const r = await api('/api/materials/patch', { method: 'POST', body: JSON.stringify({ id: cur.id, tags: $('dtags').value, note: $('dnote').value, source: $('dsrc').value, category: $('dcat').value }) });
  if (r.ok) { toast('已保存'); closeDetail(); refresh(); } else toast('保存失败');
}
async function delOne() {
  if (!confirm('删除这张？（文件进回收目录，可找回）')) return;
  const r = await api('/api/materials/delete', { method: 'POST', body: JSON.stringify({ id: cur.id }) });
  if (r.ok) { toast('已删除'); closeDetail(); refresh(); }
}
function toggleUp() { $('upbody').classList.toggle('open'); }
function pickFiles(files) { for (const f of files) uploadOne(f); $('file').value = ''; }
function uploadOne(f) {
  const row = document.createElement('div'); row.className = 'upitem';
  row.innerHTML = \`<span>\${f.name}</span><span class="dim">\${(f.size / 1024).toFixed(0)}KB</span><span>上传中…</span>\`;
  $('uplist').prepend(row);
  const st = row.lastElementChild;
  const u = new URL('/api/materials/upload', location.origin);
  u.searchParams.set('category', $('upcat').value);
  u.searchParams.set('tags', $('uptags').value.trim());
  u.searchParams.set('source', $('upsrc').value);
  u.searchParams.set('note', $('upnote').value.trim());
  u.searchParams.set('name', f.name);
  fetch(u, { method: 'POST', body: f, headers: { 'x-console-token': sessionStorage.tk || '' } })
    .then((r) => r.json())
    .then((r) => {
      if (r.duplicate) { st.className = 'st-dup'; st.textContent = '库里已有同图（未重复入库）'; }
      else if (r.ok) { st.className = 'st-ok'; st.textContent = '✓ 已入库到 ' + r.category; refresh(); }
      else { st.className = 'st-err'; st.textContent = '✗ ' + (r.error || '失败'); }
    })
    .catch((e) => { st.className = 'st-err'; st.textContent = '✗ ' + e.message; });
}
$('drop').addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('drag'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('drag'));
document.addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('drag'); if (e.dataTransfer.files.length) pickFiles(e.dataTransfer.files); });
let searchTimer = 0;
$('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refresh, 400); });
$('src').addEventListener('change', refresh);
$('unused').addEventListener('change', refresh);
if (sessionStorage.tk) doLogin();
</script>
</body>
</html>`;
}

// console 工作站端点鉴权链 + 急停闸（2026-10-27，全项目审查 P2-5 补测优先级 #1）
//
// 背景：工作站七个新端点（voice/qwen、convert、image、pdf、qrcode、text、help）与老端点
// 共用同一条身份规则——token 必填、只私聊、token 必须精确等于该会话的 agentToken。
// 审查此前只能人工逐行核对；本测试把它钉成回归防线，鉴权段将来被改坏会立刻红。
//
// 判据（真起 console-server + 真 HTTP，沙箱里跑）：
//   ① 无 token → 403（agent token 必填）
//   ② 群 key → 403（工作站只在私聊开放）
//   ③ 私聊 key + 错误 token → 403（会话令牌不匹配——换个会话的 token 冒充不了别人）
//   ④ 私聊 key + 本会话正确 token → 过鉴权，200
//   ⑤ AI 暂停（social.paused=true）→ 工作站端点同被急停（含七个新前缀；P1-4 的回归钉：
//      暂停后历史会话的旧 token 不能再调用工作站能力）
// 跑法：node tests/console-auth.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let sandbox = path.join(HERE, '.tmp-console-auth');
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  sandbox = path.join(HERE, `.tmp-console-auth-${process.pid}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-console-auth', private: true, type: 'module' }));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const consolePort = await freePort();

// napcat/dsh 指向死端口：鉴权链的放行路径（capabilities/help）不碰它们；真被碰到也只会失败，不影响断言
const cfg = {
  ownerQQ: '100001',
  consolePort,
  consoleToken: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  sendDelayMs: 0,
  napcat: { httpUrl: 'http://127.0.0.1:1', accessToken: '' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: {}, deny: {}, allowAllWhenEmpty: true,
  social: { tools: {}, send: { linearEnabled: false } },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));

const modUrl = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const socialState = await import(modUrl('core/social-state.js'));
socialState.initSocialCore(cfg);
/* getSocialState 会级联到 mode/qq-send/social-flow（排程/发送判定），它们的 cfgRef 也要先喂 */
const modeMod = await import(modUrl('core/mode.js'));
modeMod.initModeCore(cfg);
const qqSend = await import(modUrl('core/qq-send.js'));
qqSend.initQqSendCore(cfg);
const socialFlow = await import(modUrl('core/social-flow.js'));
socialFlow.initSocialFlowCore(cfg);
const consoleSrv = await import(modUrl('core/console-server.js'));
consoleSrv.initConsoleCore(cfg);
consoleSrv.setConsoleBot(null);
consoleSrv.startConsoleServer();

// 会话令牌 = getSocialState 创建会话时落下的 agentToken（生产链路同一来源）
const OWNER_KEY = 'private:100001';
const USER_KEY = 'private:100002';
const TOK = String(socialState.getSocialState(USER_KEY).agentToken ?? '');
assert.ok(TOK.length >= 4, '会话 agentToken 未生成'); /* 令牌=会话号本身（fixedTokenForKey），与生产同源 */
socialState.getSocialState(OWNER_KEY); // owner 会话也建好（不用，但保持真实形态）

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ✗ ${name}\n    ${e?.message ?? e}`);
  }
};

async function call(method, pathName, { body, token, key } = {}) {
  const url = new URL(`http://127.0.0.1:${consolePort}${pathName}`);
  if (key) url.searchParams.set('key', key);
  const res = await fetch(url, {
    method,
    /* 生产 MCP 通道同样要过外层 consoleToken 闸（2026-10-25 fail-closed），这里带上同款头 */
    headers: {
      'content-type': 'application/json',
      'x-console-token': cfg.consoleToken,
      ...(token ? { 'x-agent-token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON 也算结果 */ }
  return { status: res.status, j };
}

console.log('console-auth: 鉴权链四断言 × 工作站端点');

await t('help：无 token → 403', async () => {
  const r = await call('POST', '/api/help', { body: { key: USER_KEY } });
  assert.equal(r.status, 403);
  assert.match(String(r.j?.error ?? ''), /agent token/);
});
await t('help：群 key → 403（只私聊）', async () => {
  const r = await call('POST', '/api/help', { body: { key: 'group:868756515' }, token: TOK });
  assert.equal(r.status, 403);
});
await t('help：私聊 key + 他人会话令牌 → 403', async () => {
  const r = await call('POST', '/api/help', { body: { key: USER_KEY }, token: `${TOK}x` });
  assert.equal(r.status, 403);
  assert.match(String(r.j?.error ?? ''), /令牌不匹配/);
});
await t('help：私聊 key + 本会话令牌 → 200', async () => {
  const r = await call('POST', '/api/help', { body: { key: USER_KEY }, token: TOK });
  assert.equal(r.status, 200);
  assert.equal(r.j?.ok, true);
});
await t('convert/capabilities：无 token → 403；本会话令牌 → 200', async () => {
  const bad = await call('GET', '/api/convert/capabilities', { key: USER_KEY });
  assert.equal(bad.status, 403);
  const ok = await call('GET', '/api/convert/capabilities', { key: USER_KEY, token: TOK });
  assert.equal(ok.status, 200);
  assert.equal(ok.j?.ok, true);
});
await t('qrcode：无 token → 403；本会话令牌（能力表）→ 200', async () => {
  const bad = await call('POST', '/api/qrcode', { body: { key: USER_KEY } });
  assert.equal(bad.status, 403);
  const ok = await call('POST', '/api/qrcode', { body: { key: USER_KEY }, token: TOK });
  assert.equal(ok.status, 200);
  assert.equal(ok.j?.ok, true);
});
await t('text：群 key → 403；本会话令牌（能力表）→ 200', async () => {
  const bad = await call('POST', '/api/text', { body: { key: 'group:868756515' }, token: TOK });
  assert.equal(bad.status, 403);
  const ok = await call('POST', '/api/text', { body: { key: USER_KEY }, token: TOK });
  assert.equal(ok.status, 200);
  assert.equal(ok.j?.ok, true);
});
await t('image/capabilities：无 token → 403；本会话令牌 → 200', async () => {
  const bad = await call('GET', '/api/image/capabilities', { key: USER_KEY });
  assert.equal(bad.status, 403);
  const ok = await call('GET', '/api/image/capabilities', { key: USER_KEY, token: TOK });
  assert.equal(ok.status, 200);
});
await t('pdf：无 token → 403；本会话令牌（能力表）→ 200', async () => {
  const bad = await call('POST', '/api/pdf', { body: { key: USER_KEY } });
  assert.equal(bad.status, 403);
  const ok = await call('POST', '/api/pdf', { body: { key: USER_KEY }, token: TOK });
  assert.equal(ok.status, 200);
  assert.equal(ok.j?.ok, true);
});

console.log('console-auth: 急停闸覆盖工作站新端点（P1-4 回归钉）');
socialState.social.paused = true;
try {
  for (const [name, fn] of [
    ['help', () => call('POST', '/api/help', { body: { key: USER_KEY }, token: TOK })],
    ['convert', () => call('GET', '/api/convert/capabilities', { key: USER_KEY, token: TOK })],
    ['qrcode', () => call('POST', '/api/qrcode', { body: { key: USER_KEY }, token: TOK })],
    ['text', () => call('POST', '/api/text', { body: { key: USER_KEY }, token: TOK })],
  ]) {
    await t(`paused：${name} 也被急停 → 403`, async () => {
      const r = await fn();
      assert.equal(r.status, 403);
      assert.match(String(r.j?.error ?? ''), /paused/i);
    });
  }
} finally {
  socialState.social.paused = false;
}
await t('解除暂停后同一令牌立刻恢复（闸是逐请求生效的）', async () => {
  const r = await call('POST', '/api/help', { body: { key: USER_KEY }, token: TOK });
  assert.equal(r.status, 200);
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 句柄未释放时留给下一轮重建 */ }
console.log(`console-auth: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);

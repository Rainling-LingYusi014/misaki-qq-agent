/* B 站数据面板（2026-10-28）离线回归：
 * 创作中心只读链路（lib/bili-dashboard.js）——状态码人话、指标求和、自己 mid 读取、
 * 汇总组装（粉丝失败不连累稿件数据、审核中清单、登录失效如实上抛）。
 * 全程 fetch 打桩 + 临时 auth/circuit 文件注入，绝不真连 B 站（双 IP 铁律：真请求只在服务器）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardSummary, listMyArchives, stateLabel, sumStats, normStat, readSelfMid } from '../src/lib/bili-dashboard.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '.tmp-bili-dashboard-'));
const authFile = path.join(tmp, 'bilibili-auth.json');
const circuitFile = path.join(tmp, 'bili-circuit.json');
fs.writeFileSync(authFile, JSON.stringify({ savedAt: 1, DedeUserID: '42', bili_jct: 'tok' }));

/* ── 纯函数 ── */
assert.equal(stateLabel(0), '已公开');
assert.equal(stateLabel(-30), '审核中');
assert.equal(stateLabel(-40), '被打回（待修改）');
assert.equal(stateLabel(-9), '转码中');
assert.equal(stateLabel(7), 'state=7');

assert.deepEqual(normStat({ view: 5 }), { view: 5, like: 0, coin: 0, favorite: 0, share: 0, reply: 0, danmaku: 0 });
assert.deepEqual(sumStats([{ stat: { view: 10, like: 2 } }, { stat: { view: 5, coin: 1 } }]), { view: 15, like: 2, coin: 1, favorite: 0, share: 0, reply: 0, danmaku: 0 });

assert.equal(readSelfMid(authFile), '42');
fs.writeFileSync(authFile, JSON.stringify({ DedeUserID: { value: '99' } }));
assert.equal(readSelfMid(authFile), '99');
fs.writeFileSync(authFile, JSON.stringify({ bili_jct: 'tok' }));
assert.equal(readSelfMid(authFile), '');

/* ── 汇总链路（fetch 打桩；形状=2026-10-28 服务器实测：
 *    新投稿在 arc_audits（x.Archive，过审也在），archives 要有播放数据才进，总数 page.count） ── */
fs.writeFileSync(authFile, JSON.stringify({ DedeUserID: '42', bili_jct: 'tok' }));
const ARC_1 = { aid: 1, bvid: 'BV1aaa', title: '第一条', tname: '科技', ptime: 1761000000, state: 0, stat: { view: 100, like: 20, coin: 5, favorite: 3, share: 2, reply: 4, danmaku: 7 } };
const ARC_2 = { aid: 2, bvid: 'BV1bbb', title: '第二条', tname: '科技', ptime: 1761100000, state: -30, stat: {} };
const ARCHIVES = {
  code: 0,
  data: {
    class: { pubed: 1, is_pubing: 1, not_pubed: 0 },
    arc_audits: [{ Archive: ARC_2 }, { Archive: ARC_1 }],
    archives: [ARC_1], /* 同一条也会出现在 archives（有播放数据后）——必须去重 */
    page: { pn: 1, ps: 20, count: 2 },
  },
};
let seenUrls = [];
let seenCookie = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  seenUrls.push(u);
  seenCookie = String(opts.headers?.cookie ?? '');
  if (u.includes('member.bilibili.com/x/web/archives')) return { status: 200, json: async () => ARCHIVES };
  if (u.includes('x/relation/stat?vmid=42')) return { status: 200, json: async () => ({ code: 0, data: { follower: 123 } }) };
  return { status: 404, json: async () => ({ code: -404, message: 'not mocked' }) };
};
try {
  const s = await dashboardSummary({ authFile, circuitFile });
  assert.equal(s.ok, true);
  assert.equal(s.total, 2);
  assert.equal(s.fetched, 2);
  assert.deepEqual(s.auditClass, { pubed: 1, auditing: 1, rejected: 0 });
  assert.equal(s.fans, 123);
  assert.deepEqual(s.sum, { view: 100, like: 20, coin: 5, favorite: 3, share: 2, reply: 4, danmaku: 7 });
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].bvid, 'BV1bbb');
  assert.equal(s.pending[0].label, '审核中');
  const bbb = s.videos.find((v) => v.bvid === 'BV1bbb');
  assert.equal(bbb.url, 'https://www.bilibili.com/video/BV1bbb');
  assert.equal(s.videos.length, 2, '同 bvid 出现在两表必须去重');
  assert.ok(s.sumScope.includes('最近 2 条'), `sumScope 说明缺失：${s.sumScope}`);
  assert.ok(seenUrls.some((u) => u.includes('member.bilibili.com/x/web/archives?status=all&pn=1&ps=20')), `archives URL 不符：${seenUrls.join(' | ')}`);
  assert.ok(seenCookie.includes('DedeUserID=42'), '登录 cookie 没带全');

  /* 稿件接口报错 → 如实返回 why */
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ code: 62012, message: '稿件不可见' }) });
  const bad = await listMyArchives({ authFile, circuitFile });
  assert.equal(bad.ok, false);
  assert.ok(String(bad.why).includes('62012'));

  /* 登录失效（-101）→ biliJson 上抛，不吞 */
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ code: -101, message: '账号未登录' }) });
  await assert.rejects(() => dashboardSummary({ authFile, circuitFile }), /登录失效/);

  /* 粉丝接口炸 → 不连累稿件数据（fans=null，其余照常） */
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('member.bilibili.com')) return { status: 200, json: async () => ARCHIVES };
    return { status: 200, json: async () => { throw new Error('boom'); } };
  };
  const nf = await dashboardSummary({ authFile, circuitFile });
  assert.equal(nf.ok, true);
  assert.equal(nf.fans, null);
  assert.equal(nf.total, 2);
  console.log('bili-dashboard ALL PASS');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
}

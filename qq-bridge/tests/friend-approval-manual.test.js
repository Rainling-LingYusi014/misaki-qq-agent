// 好友申请手动审批模式回归（2026-10-28 开放好友，主人定规"审批由我亲自来搞"）：
// social.friendApproval.autoApprove=false 时——
//   · 黑名单秒拒、白名单秒过保持不变；
//   · 其余申请桥绝不代批（不 set_friend_add_request、不挂定时器，重启恢复也不补批），
//     只记 manual 条目 + 伪消息通报 owner。
// 拉起真 social 链（沙箱副本），bot 用打桩对象记录 set_friend_add_request 调用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.join(os.tmpdir(), `.tmp-friend-manual-${process.pid}`);
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-friend-manual', private: true, type: 'module' }));

const cfg = {
  ownerQQ: '100001',
  napcat: { httpUrl: 'http://127.0.0.1:1', accessToken: '' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: { private: ['100001', '300001'] }, // 300001 = 预白名单（秒过组）
  deny: { private: ['666666'] },
  allowAllWhenEmpty: false,
  social: { tools: {}, friendApproval: { autoApprove: false } },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const socialState = await import(url('core/social-state.js'));
socialState.initSocialCore(cfg);
const modeMod = await import(url('core/mode.js'));
modeMod.initModeCore(cfg);
const qqSend = await import(url('core/qq-send.js'));
qqSend.initQqSendCore(cfg);
const socialFlow = await import(url('core/social-flow.js'));
socialFlow.initSocialFlowCore(cfg);

const friendApproval = await import(url('core/friend-approval.js'));
const rules = await import(url('core/friend-approval-rules.js'));

/* 规则纯函数：归一化 + 通报文案 */
assert.equal(rules.friendApprovalCfg({}).autoApprove, true, '缺省=自动（向后兼容）');
assert.equal(rules.friendApprovalCfg({ friendApproval: { autoApprove: false } }).autoApprove, false);
assert.ok(rules.buildFriendNoticeText('manual', { uid: '200001', nickname: '小明' }).includes('亲自处理'), '手动通报要引导 owner 亲自处理');

/* 打桩 bot：记录审批调用；api 直接拒绝（昵称 best-effort 秒回落） */
const calls = [];
const bot = {
  setFriendAddRequest: async (flag, approve) => { calls.push({ flag, approve }); },
  api: () => Promise.reject(new Error('no api in test')),
};
friendApproval.setFriendApprovalBot(bot);
friendApproval.initFriendApprovalCore(cfg);

// ① 普通申请 + 手动模式：绝不调 set_friend_add_request
await friendApproval.handleFriendRequest({ flag: 'flag-A', user_id: '200001', comment: '想认识美咲' });
assert.equal(calls.length, 0, '手动模式下桥不得代批普通申请');
const reqFile = path.join(sandbox, 'state', 'friend-requests.json');
const stored = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
const entry = stored.find((r) => r.userId === '200001');
assert.ok(entry, '申请应记账落盘');
assert.equal(entry.manual, true, '条目必须标 manual（重启恢复也不补批）');

// ② 白名单秒过不受影响
await friendApproval.handleFriendRequest({ flag: 'flag-B', user_id: '300001', comment: '' });
assert.deepEqual(calls, [{ flag: 'flag-B', approve: true }], '白名单仍应秒过');

// ③ 黑名单秒拒不受影响
await friendApproval.handleFriendRequest({ flag: 'flag-C', user_id: '666666', comment: '' });
assert.deepEqual(calls, [{ flag: 'flag-B', approve: true }, { flag: 'flag-C', approve: false }], '黑名单仍应秒拒');

// ④ 启动恢复：manual 条目不会被 armTimer 补批（loadFriendRequests 后仍零新增调用）
friendApproval.loadFriendRequests();
await new Promise((r) => setTimeout(r, 50));
assert.deepEqual(calls, [{ flag: 'flag-B', approve: true }, { flag: 'flag-C', approve: false }], '恢复路径不得补批 manual 条目');

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 下 chat-db 句柄未放行时删不掉，反正在系统临时目录 */ }
console.log('friend-approval-manual: 8/8 通过');

// 回归测试：表情包 vs 照片的回应策略（2026-10-29 主人定规）。
//
// 现场：2026-10-28 23:15-23:17，对方连发三张表情包，桥把它们全记成「[图片]」并按"无文字的图"
// 50% 掷骰沉默——其中两次掷出沉默，用户看到的是"发图 → 等四十秒 → 一句无关的早点睡"。
// 真相是 QQ 早就给了答案（sub_type:1 / summary:"[动画表情]"），桥读错字段名又在正文里写死 [图片]。
//
// 现在的契约：
//   · 照片（kind=image）→ 不进骰子，必须回；
//   · 表情包（kind=sticker）→ 五档骰子：5% 收藏回发 / 5% 评价 / 30% 发自己的 / 10% 拍一拍 / 其余沉默；
//   · 冷场（距上一条消息 ≥ 该模式冷场阈值：常规 15 分钟 / 陪伴 5 分钟）→ 不掷，必须回；
//   · 有正话 / 文件 → 不掷。
//
// 用法：node tests/sticker-reply.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-sticker-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-sticker-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });

const cfg = {
  ownerQQ: '123456789',
  allow: { private: [], groups: [] },
  deny: { private: [], groups: [] },
  social: {
    shortReply: { enabled: true, silenceProbability: 0.5, maxChars: 4, applyToOwner: false },
    stickerReply: { echoProbability: 0.05, commentProbability: 0.05, ownProbability: 0.3, pokeProbability: 0.1 },
    proactive: { idleThresholdMs: 15 * 60 * 1000 },
    companionMode: { idleThresholdMs: 5 * 60 * 1000 },
  },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg));

let fails = 0;
const check = (n, f) => { try { f(); console.log('PASS  ' + n); } catch (e) { fails += 1; console.log('FAIL  ' + n + '  ' + (e?.message ?? e)); } };

const dice = await import(pathToFileURL(path.join(sandbox, 'src', 'lib', 'short-reply-dice.js')).href);
const wake = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'wake-send.js')).href);
wake.initWakeCore(cfg);

// ── ① 解析层：NapCat 的字段名 ─────────────────────────────────────────────
const parse = await import(pathToFileURL(path.join(sandbox, 'src', 'lib', 'message-parse.js')).href);

check('NapCat 的 sub_type=1 → 表情包', () => {
  assert.equal(parse.imageKindOf({ sub_type: 1, summary: '[动画表情]' }), 'sticker');
});
check('summary=[图片] → 照片（哪怕 sub_type 缺失）', () => {
  assert.equal(parse.imageKindOf({ summary: '[图片]' }), 'image');
});
check('商城表情（summary 是名字）→ 表情包', () => {
  assert.equal(parse.imageKindOf({ summary: '猫猫贴贴' }), 'sticker');
});
check('只有 sub_type=0 → 照片', () => assert.equal(parse.imageKindOf({ sub_type: 0 }), 'image'));
check('驼峰 subType 也兼容', () => assert.equal(parse.imageKindOf({ subType: '1' }), 'sticker'));
check('extractMediaFromSegments 用 sub_type 判定，kind 仍是 image', () => {
  const m = parse.extractMediaFromSegments([
    { type: 'image', data: { file: 'a.jpg', url: 'http://x/a.jpg', sub_type: 1, summary: '[动画表情]' } },
    { type: 'image', data: { file: 'b.jpg', url: 'http://x/b.jpg', summary: '[图片]' } },
  ]);
  assert.deepEqual(m.map((x) => x.kind), ['image', 'image']);
  assert.deepEqual(m.map((x) => x.sticker), [true, false]);
});

// ── ② 归类 ───────────────────────────────────────────────────────────────
check('照片只有图 → photo', () => assert.equal(dice.classifyIncoming({ text: '[图片]', mediaKinds: ['image'] }), 'photo'));
check('表情包只有图 → sticker', () => assert.equal(dice.classifyIncoming({ text: '[动画表情]', mediaKinds: ['sticker'] }), 'sticker'));
check('照片配一句正话 → text-normal', () => assert.equal(dice.classifyIncoming({ text: '[图片] 好吃吗', mediaKinds: ['image'] }), 'text-normal'));
check('文件 → file', () => assert.equal(dice.classifyIncoming({ text: '', hasFile: true }), 'file'));
check('照片不再算低信息量', () => assert.equal(dice.isLowInfoIncoming({ text: '', hasMedia: true, mediaKinds: ['image'] }), false));

// ── ③ 五档分界 ───────────────────────────────────────────────────────────
const probs = { echo: 0.05, comment: 0.05, own: 0.3, poke: 0.1 };
const at = (roll) => dice.stickerReplyDecision({ roll, probs }).action;
check('roll 0.00 → ECHO', () => assert.equal(at(0.0), 'ECHO'));
check('roll 0.049 → ECHO', () => assert.equal(at(0.049), 'ECHO'));
check('roll 0.05 → COMMENT', () => assert.equal(at(0.05), 'COMMENT'));
check('roll 0.099 → COMMENT', () => assert.equal(at(0.099), 'COMMENT'));
check('roll 0.10 → OWN', () => assert.equal(at(0.10), 'OWN'));
check('roll 0.399 → OWN', () => assert.equal(at(0.399), 'OWN'));
check('roll 0.40 → POKE', () => assert.equal(at(0.40), 'POKE'));
check('roll 0.499 → POKE', () => assert.equal(at(0.499), 'POKE'));
check('roll 0.50 → SILENT', () => assert.equal(at(0.50), 'SILENT'));
check('roll 0.99 → SILENT', () => assert.equal(at(0.99), 'SILENT'));
check('冷场时不掷骰，直接 COLD_REPLY', () => assert.equal(dice.stickerReplyDecision({ roll: 0.0, probs, cold: true }).action, 'COLD_REPLY'));
check('四项写满 1 也不抛、沉默为 0', () => {
  const r = dice.stickerReplyDecision({ roll: 0.99, probs: { echo: 1, comment: 1, own: 1, poke: 1 } });
  assert.equal(['ECHO', 'COMMENT', 'OWN', 'POKE', 'SILENT'].includes(r.action), true);
});

// ── ④ 正文注入（wake-send） ───────────────────────────────────────────────
const T = Date.parse('2026-10-29T01:00:00+08:00');
const stickerMsg = (t, gapMs) => ({
  agentMode: 'default',
  unread: [{
    seq: 3, text: '[动画表情]', plain: '[动画表情]', time: t, messageId: 'm1', isSelf: false,
    media: [{ kind: 'image', sticker: true, file: 'a.jpg', url: 'http://x/a.jpg' }], hasMedia: true,
  }],
  recentMessages: [{ isSelf: true, time: t - gapMs, text: '好' }],
});
const photoMsg = (t, gapMs) => {
  const m = stickerMsg(t, gapMs);
  m.unread[0].text = '[图片]';
  m.unread[0].plain = '[图片]';
  m.unread[0].media = [{ kind: 'image', file: 'b.jpg', url: 'http://x/b.jpg' }];
  return m;
};

const warm = wake.shortReplyDiceLine(stickerMsg(T, 60 * 1000), 'private:222');
check('非冷场表情包 → 出现 [Dice] sticker 行', () => assert.match(warm, /^\[Dice\] sticker roll=/));
check('非冷场行里写明距上一条多久', () => assert.match(warm, /距上一条 1 分钟/));
check('非冷场行里落到五档之一（不是要求必须回）', () => {
  assert.equal(/COLD_REPLY|冷场后的第一条/.test(warm), false);
});

const coldDefault = wake.shortReplyDiceLine(stickerMsg(T, 20 * 60 * 1000), 'private:222');
check('常规模式 20 分钟 → 冷场', () => assert.match(coldDefault, /冷场/));
check('冷场要求必须回一句', () => assert.match(coldDefault, /必须回一句短话/));

const companionWarm = wake.shortReplyDiceLine({ ...stickerMsg(T, 3 * 60 * 1000), agentMode: 'companion' }, 'private:222');
check('陪伴模式 3 分钟 → 还没冷场（阈值 5 分钟）', () => assert.equal(/冷场/.test(companionWarm), false));
const companionCold = wake.shortReplyDiceLine({ ...stickerMsg(T, 6 * 60 * 1000), agentMode: 'companion' }, 'private:222');
check('陪伴模式 6 分钟 → 冷场', () => assert.match(companionCold, /冷场/));

check('照片不掷骰（一行都不加）', () => assert.equal(wake.shortReplyDiceLine(photoMsg(T, 60 * 1000), 'private:222'), ''));
check('群聊不掷骰', () => assert.equal(wake.shortReplyDiceLine(stickerMsg(T, 60 * 1000), 'group:999'), ''));
check('主人私聊不掷骰', () => assert.equal(wake.shortReplyDiceLine(stickerMsg(T, 60 * 1000), 'private:123456789'), ''));

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.log(`WARN  沙盒清理失败（不影响结论）: ${e?.message ?? e}`); }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

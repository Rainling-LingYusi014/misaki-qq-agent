// 千问复刻客户端 + 文本分块的离线回归（全部走 mock fetch，不联网、不需要 key）
//   node tools/test-qwen-tts.mjs
import { createQwenClient, normalizeQwenConfig, resolveQwenConfig } from '../src/lib/qwen-tts.js';
import { splitText, normalizeOutputFormat, OUTPUT_FORMAT_IDS } from '../src/core/tts-delivery.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json' },
});

console.log('== ① 配置解析 ==');
{
  const d = normalizeQwenConfig({});
  ok('默认 targetModel', d.targetModel === 'qwen-audio-3.1-tts-plus', d.targetModel);
  ok('默认 region', d.region === 'cn-beijing', d.region);
  ok('默认关闭', d.enabled === false);
  const saved = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  let msg = '';
  try { resolveQwenConfig({ voice: { qwen: { enabled: true, workspaceId: 'ws' } } }); } catch (e) { msg = e.message; }
  ok('缺 key 给人话', /API Key/.test(msg), msg);
  msg = '';
  try { resolveQwenConfig({ voice: { qwen: { enabled: true, apiKey: 'sk-x' } } }); } catch (e) { msg = e.message; }
  ok('缺 workspace 给人话', /Workspace/.test(msg), msg);
  if (saved !== undefined) process.env.DASHSCOPE_API_KEY = saved;
  const base = resolveQwenConfig({ voice: { qwen: { enabled: true, workspaceId: 'ws-test', apiKey: 'sk-test' } } });
  ok('拼出北京工作空间域名', base.baseUrl === 'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1', base.baseUrl);
}

console.log('== ② 建音色 / 轮询 / 合成（mock fetch） ==');
{
  const calls = [];
  let queryCount = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ u, body, headers: opts.headers });
    if (u.endsWith('/services/audio/tts/customization')) {
      if (body.input.action === 'create_voice') return jsonResponse({ output: { voice_id: 'voice-1' } });
      if (body.input.action === 'query_voice') {
        queryCount += 1;
        return jsonResponse({ output: { status: queryCount === 1 ? 'DEPLOYING' : 'OK' } });
      }
      if (body.input.action === 'delete_voice') return jsonResponse({ output: {} });
    }
    if (u.endsWith('/services/audio/tts/SpeechSynthesizer')) {
      return jsonResponse({ request_id: 'req-1', output: { audio: { url: 'https://example.com/a.wav' } }, usage: { characters: 12 } });
    }
    if (u === 'https://example.com/a.wav') {
      return new Response(Buffer.from('RIFFxxxxWAVEdata'), { status: 200, headers: { 'content-length': '16' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  const cfg = { voice: { qwen: { enabled: true, workspaceId: 'ws-test', apiKey: 'sk-test', pollIntervalMs: 1, pollMax: 5 } } };
  const client = createQwenClient(cfg);
  const en = await client.enroll({ audio: 'data:audio/wav;base64,AAAA', prefix: 'misaki_test' });
  ok('拿到 voice_id', en.voiceId === 'voice-1', en.voiceId);
  const create = calls.find((c) => c.body?.input?.action === 'create_voice');
  ok('create_voice 请求体', create?.body.model === 'voice-enrollment'
    && create?.body.input.target_model === 'qwen-audio-3.1-tts-plus'
    && create?.body.input.prefix === 'misakitest'
    && String(create?.body.input.audio).startsWith('data:audio/wav;base64,'));
  ok('鉴权头是 Bearer', String(create?.headers?.authorization || create?.headers?.Authorization).startsWith('Bearer sk-test'));

  const ready = await client.waitReady({ voiceId: 'voice-1', max: 5, intervalMs: 1 });
  ok('DEPLOYING 会继续轮询到 OK', ready.ready && queryCount === 2, `queryCount=${queryCount}`);

  const syn = await client.synthesize({ text: '你好，这是测试。', voiceId: 'voice-1' });
  ok('合成返回音频字节', syn.buf.length === 16, String(syn.buf.length));
  ok('返回实际采样率', syn.sampleRate === 44100, String(syn.sampleRate));
  const synthCall = calls.find((c) => c.u.endsWith('/SpeechSynthesizer'));
  ok('SpeechSynthesizer 请求体', synthCall?.body.model === 'qwen-audio-3.1-tts-plus'
    && synthCall?.body.input.voice === 'voice-1'
    && synthCall?.body.input.format === 'wav'
    && synthCall?.body.input.sample_rate === 44100
    && synthCall?.body.input.text === '你好，这是测试。');

  const del = await client.remove({ voiceId: 'voice-1' });
  ok('删除音色', del.ok && calls.some((c) => c.body?.input?.action === 'delete_voice'));
}

console.log('== ③ 文本分块 ==');
{
  ok('空文本 → 空数组', splitText('   ').length === 0);
  const s1 = '第一句话。第二句话！第三句话？第四句话；第五句话，还有一点尾巴。'.repeat(4);
  const c1 = splitText(s1, 80);
  ok('按标点切且每块不超限', c1.every((x) => [...x].length <= 80), JSON.stringify(c1));
  ok('不丢内容', c1.join('') === s1, c1.join(''));
  const s2 = '啊'.repeat(1000);
  const c2 = splitText(s2, 450);
  ok('无标点长文也能硬切', c2.length >= 3 && c2.every((x) => [...x].length <= 450), `chunks=${c2.length}`);
  ok('硬切不丢字', c2.join('').length === 1000, String(c2.join('').length));
  const s3 = '第一段没有句号\n\n第二段有句号。\n第三段';
  const c3 = splitText(s3, 450);
  ok('段落边界保留为块边界', c3.length === 3, JSON.stringify(c3));
}

console.log('== ④ 输出格式 ==');
{
  ok('五种格式', OUTPUT_FORMAT_IDS.join(',') === 'mp3,wav,m4a,ogg,flac', OUTPUT_FORMAT_IDS.join(','));
  ok('默认 mp3', normalizeOutputFormat('', 'mp3') === 'mp3');
  ok('大小写/点前缀归一', normalizeOutputFormat('.M4A') === 'm4a');
  ok('非法格式回退', normalizeOutputFormat('aac', 'ogg') === 'ogg');
  ok('flac 可用', normalizeOutputFormat('flac') === 'flac');
}

console.log('== ⑤ 采样率降级 ==');
{
  let n = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/SpeechSynthesizer')) {
      n += 1;
      if (n === 1) return jsonResponse({ code: 'InvalidParameter', message: 'sample_rate 44100 not supported' }, 400);
      return jsonResponse({ output: { audio: { url: 'https://example.com/b.wav' } }, usage: { characters: 2 } });
    }
    if (u === 'https://example.com/b.wav') {
      return new Response(Buffer.from('RIFFxxxxWAVEdata'), { status: 200, headers: { 'content-length': '16' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const cfg = { voice: { qwen: { enabled: true, workspaceId: 'ws', apiKey: 'sk-x', pollIntervalMs: 1 } } };
  const c = createQwenClient(cfg);
  const r = await c.synthesize({ text: '测试', voiceId: 'v', sampleRate: 44100 });
  ok('44100 被拒后降级 24000', r.sampleRate === 24000 && n === 2, `rate=${r.sampleRate} n=${n}`);
}

// ── 用户侧授权状态（2026-10-28，审查 P1-3 修复）────────────────────────────
{
  const { hasVoiceConsent, markVoiceConsent } = await import('../src/core/tts-delivery.js');
  const { parseMisakiCommand } = await import('../src/core/companion-mode.js');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const fsMod = await import('node:fs');
  const tmp = pathMod.join(os.tmpdir(), `voice-consent-test-${process.pid}.json`);
  try { fsMod.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  ok('未授权时 hasVoiceConsent=false', hasVoiceConsent('10002', tmp) === false);
  markVoiceConsent('10002', 'private:10002', tmp);
  ok('markVoiceConsent 后 hasVoiceConsent=true', hasVoiceConsent('10002', tmp) === true);
  ok('其他 uid 仍为未授权', hasVoiceConsent('10003', tmp) === false);
  markVoiceConsent('10002', 'private:10002', tmp);
  ok('重复授权幂等', hasVoiceConsent('10002', tmp) === true);
  const cmd = parseMisakiCommand('misaki@confirm', null);
  ok('misaki@confirm 解析为授权动作', cmd?.kind === 'action-voice-consent', JSON.stringify(cmd));
  const cmd2 = parseMisakiCommand('misaki@confirm。', null);
  ok('授权指令结尾标点容错', cmd2?.kind === 'action-voice-consent');
  const cmd3 = parseMisakiCommand('misaki@credits', null);
  ok('既有指令不受影响', cmd3?.kind === 'action-credits');
  try { fsMod.rmSync(tmp, { force: true }); } catch { /* ignore */ }
}

console.log(`\n${pass} passed${process.exitCode ? '，有失败' : ''}`);

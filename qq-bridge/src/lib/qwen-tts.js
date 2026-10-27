/* ══════════════════════════════════════════════════════════════════════════
 * 千问（阿里云百炼 Model Studio）声音复刻 + 语音合成客户端
 *
 * 为什么单独一个文件，而不是塞进 core/voice.js：
 *   · core/voice.js 是 MiMo 那条链（零样本复刻：每次请求把样本 DataURL 带上）；
 *     千问是**服务端建音色**（create_voice → voice_id → 之后只传 voice_id），
 *     两条链的请求体、错误码、幂等语义都不一样，混在一起会把"当前用的是哪家"变成
 *     一个只能靠日志猜的问题。
 *   · 这里只做 HTTP：建音色 / 查状态 / 列音色 / 删音色 / 合成 / 下载音频。
 *     样本质检、分块、拼接、额度、发文件全在 core/tts-delivery.js。
 *
 * 接口口径（2026-10-27 按官方文档核对）：
 *   基址   https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1
 *          （新加坡：ap-southeast-1；复刻走工作空间域名，不是 dashscope.aliyuncs.com）
 *   建音色 POST /services/audio/tts/customization
 *          { model:"voice-enrollment", input:{ action:"create_voice",
 *            target_model, prefix, audio:"data:audio/wav;base64,..." } }
 *          → output.voice_id
 *   查状态 POST 同一端点 { input:{ action:"query_voice", voice_id } }
 *          → output.status: OK / DEPLOYING（样例按 1s 间隔轮询 30 次）
 *   列音色 { action:"list_voice", prefix?, page_index?, page_size? }
 *   删音色 { action:"delete_voice", voice_id }
 *   合成   POST /services/audio/tts/SpeechSynthesizer
 *          { model:target_model, input:{ text, voice:voice_id,
 *            format:"wav", sample_rate:24000 } }
 *          → output.audio.url（24 小时有效）或 output.audio.data（base64）
 *
 * 硬约束（文档写明）：
 *   · 音色绑定 target_model，不能跨模型使用 —— 所以 voice 档案必须把 targetModel 一起存；
 *   · 样本 5s 起，推荐 10–20s，最长 60s，≤10MB，≥16kHz，WAV/MP3/M4A；
 *   · 账号默认音色配额 1000 个（与声音设计共用）；建音色按次计费（0.01 元/次量级）。
 * ══════════════════════════════════════════════════════════════════════════ */
import { log } from './log.js';

export const QWEN_DEFAULTS = Object.freeze({
  enabled: false,
  workspaceId: '',
  apiKey: '',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  region: 'cn-beijing',
  baseUrl: '',
  targetModel: 'qwen-audio-3.1-tts-plus',
  sampleRate: 44100,
  format: 'wav',
  pollMax: 30,
  pollIntervalMs: 1000,
  timeoutMs: 120000,
});

const REGION_HOST = {
  'cn-beijing': 'cn-beijing.maas.aliyuncs.com',
  'ap-southeast-1': 'ap-southeast-1.maas.aliyuncs.com',
};

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/** 合并默认值；空串一律当"没配"（与控制台其它模块同一口径）。 */
export function normalizeQwenConfig(raw = {}) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = { ...QWEN_DEFAULTS };
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      out[k] = v.trim();
      continue;
    }
    out[k] = v;
  }
  out.enabled = out.enabled === true;
  out.region = REGION_HOST[out.region] ? out.region : 'cn-beijing';
  out.sampleRate = Math.max(16000, Math.min(48000, Number(out.sampleRate) || 44100));
  out.pollMax = Math.max(1, Math.min(120, Number(out.pollMax) || 30));
  out.pollIntervalMs = Math.max(200, Math.min(10000, Number(out.pollIntervalMs) || 1000));
  out.timeoutMs = Math.max(5000, Math.min(600000, Number(out.timeoutMs) || 120000));
  out.format = ['wav', 'mp3'].includes(out.format) ? out.format : 'wav';
  return out;
}

/** 从整份 bridge config / voice.qwen / 裸 qwen 段里取配置（三种都认）。 */
export function qwenSection(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (c.qwen && typeof c.qwen === 'object') return c.qwen;
  if (c.voice?.qwen && typeof c.voice.qwen === 'object') return c.voice.qwen;
  return c;
}

/** 解析成可直接发请求的配置；缺 key / 缺 workspace 时给人话，而不是发一个必然 401 的请求。 */
export function resolveQwenConfig(cfg) {
  const q = normalizeQwenConfig(qwenSection(cfg));
  const apiKey = String(q.apiKey || process.env[q.apiKeyEnv] || process.env.DASHSCOPE_API_KEY || '').trim();
  const baseUrl = String(q.baseUrl || (q.workspaceId ? `https://${q.workspaceId}.${REGION_HOST[q.region]}/api/v1` : '')).replace(/\/+$/, '');
  if (!q.enabled) throw new Error('千问语音未启用：在 config.json 的 voice.qwen.enabled 打开');
  if (!apiKey) throw new Error('缺少 DashScope API Key：填 voice.qwen.apiKey，或把 DASHSCOPE_API_KEY 放进 ~/.config/qq-agent.env');
  if (!baseUrl) throw new Error('缺少 Workspace ID：填 voice.qwen.workspaceId（千问复刻走 {WorkspaceId}.cn-beijing.maas.aliyuncs.com），或直接填 baseUrl');
  return { ...q, apiKey, baseUrl };
}

const maskKey = (k) => (k ? `${String(k).slice(0, 4)}…${String(k).slice(-4)}` : '（无）');

function safeJson(text, status) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`千问返回非 JSON（HTTP ${status}）：${String(text).slice(0, 200)}`);
  }
}

/** 从各种可能的成功响应形状里取 output；错误优先用服务端的 message。 */
function pickOutput(j, what) {
  if (!j || typeof j !== 'object') throw new Error(`千问 ${what} 返回为空`);
  const code = j.code ?? j.status_code;
  const bad = (code != null && String(code) !== '200' && String(code) !== '0' && String(code).toLowerCase() !== 'ok');
  if (bad && !j.output) throw new Error(`千问 ${what} 失败（code=${code}）：${j.message || j.error?.message || ''}`.trim());
  return j.output ?? j.data ?? j;
}

export function createQwenClient(cfg) {
  const q = resolveQwenConfig(cfg);
  log(`[qwen-tts] 客户端就绪：base=${q.baseUrl} key=${maskKey(q.apiKey)} model=${q.targetModel}`);

  const post = async (pathname, body, { timeoutMs = q.timeoutMs, what = '请求' } = {}) => {
    const res = await fetch(`${q.baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${q.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const j = safeJson(text, res.status);
    if (!res.ok) {
      const msg = j?.message || j?.error?.message || String(text).slice(0, 200);
      throw new Error(`千问 ${what} HTTP ${res.status}：${msg}`);
    }
    return j;
  };

  /** 建音色：audio 必须是 data: 开头的 Data URL（官方文档明确支持 Base64 Data URI）。 */
  const enroll = async ({ audio, targetModel = q.targetModel, prefix = 'misaki' } = {}) => {
    const dataUrl = String(audio ?? '').trim();
    if (!/^data:audio\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
      throw new Error('建音色需要 audio Data URL（data:audio/wav;base64,...）');
    }
    const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
    if (bytes > 10 * 1024 * 1024) throw new Error(`样本过大（${(bytes / 1048576).toFixed(1)}MB），千问上限 10MB`);
    const cleanPrefix = String(prefix || 'misaki').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'misaki';
    const j = await post('/services/audio/tts/customization', {
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: String(targetModel || q.targetModel),
        prefix: cleanPrefix,
        audio: dataUrl,
      },
    }, { what: '建音色' });
    const out = pickOutput(j, '建音色');
    const voiceId = String(out.voice_id ?? out.voice ?? '').trim();
    if (!voiceId) throw new Error(`千问建音色没有返回 voice_id：${JSON.stringify(j).slice(0, 300)}`);
    log(`[qwen-tts] 建音色已提交：voice_id=${voiceId} target=${targetModel || q.targetModel}`);
    return { voiceId, targetModel: String(targetModel || q.targetModel) };
  };

  /** 查状态；OK=可用，DEPLOYING=继续等。 */
  const query = async ({ voiceId } = {}) => {
    const id = String(voiceId ?? '').trim();
    if (!id) throw new Error('voice_id 不能为空');
    const j = await post('/services/audio/tts/customization', {
      model: 'voice-enrollment',
      input: { action: 'query_voice', voice_id: id },
    }, { what: '查音色状态' });
    const out = pickOutput(j, '查音色状态');
    return {
      voiceId: id,
      status: String(out.status ?? out.voice_status ?? '').trim().toUpperCase(),
      raw: out,
    };
  };

  /** 建完轮询到可用；超时把最后一次状态带回去，方便定位是"还在部署"还是"失败了"。 */
  const waitReady = async ({ voiceId, max = q.pollMax, intervalMs = q.pollIntervalMs } = {}) => {
    let last = '';
    for (let i = 0; i < max; i += 1) {
      const r = await query({ voiceId });
      last = r.status;
      if (last === 'OK' || last === 'AVAILABLE' || last === 'READY') return { ...r, ready: true };
      if (last && !['DEPLOYING', 'PENDING', 'PROCESSING', 'RUNNING'].includes(last)) {
        throw new Error(`千问音色状态异常：${last}（voice_id=${voiceId}）`);
      }
      await new Promise((r2) => setTimeout(r2, intervalMs));
    }
    throw new Error(`千问音色 ${voiceId} 在 ${max} 次轮询内仍未就绪（最后状态：${last || '未知'}）`);
  };

  const list = async ({ prefix = '', pageIndex = 0, pageSize = 100 } = {}) => {
    const j = await post('/services/audio/tts/customization', {
      model: 'voice-enrollment',
      input: {
        action: 'list_voice',
        ...(prefix ? { prefix: String(prefix) } : {}),
        page_index: Math.max(0, Number(pageIndex) || 0),
        page_size: Math.max(1, Math.min(100, Number(pageSize) || 100)),
      },
    }, { what: '列音色' });
    const out = pickOutput(j, '列音色');
    return Array.isArray(out.voice_list) ? out.voice_list : [];
  };

  const remove = async ({ voiceId } = {}) => {
    const id = String(voiceId ?? '').trim();
    if (!id) throw new Error('voice_id 不能为空');
    await post('/services/audio/tts/customization', {
      model: 'voice-enrollment',
      input: { action: 'delete_voice', voice_id: id },
    }, { what: '删音色' });
    log(`[qwen-tts] 音色已删除：${id}`);
    return { ok: true, voiceId: id };
  };

  /** 合成一句（调用方负责分块，这里不切文本）。返回音频 Buffer；默认 wav，便于后面统一拼接。 */
  const synthesize = async ({
    text,
    voiceId,
    targetModel = q.targetModel,
    format = q.format,
    sampleRate = q.sampleRate,
  } = {}) => {
    const t = String(text ?? '').trim();
    const id = String(voiceId ?? '').trim();
    if (!t) throw new Error('合成文本为空');
    if (!id) throw new Error('合成需要 voice_id');
    let sr = Math.max(16000, Math.min(48000, Number(sampleRate) || 44100));
    const request = (rate) => post('/services/audio/tts/SpeechSynthesizer', {
      model: String(targetModel || q.targetModel),
      input: {
        text: t,
        voice: id,
        format: ['wav', 'mp3'].includes(format) ? format : 'wav',
        sample_rate: rate,
      },
    }, { what: '语音合成', timeoutMs: Math.max(q.timeoutMs, 180000) });
    let j;
    try {
      j = await request(sr);
    } catch (e) {
      /* 文档说 44.1k 可用，但模型/区域偶有差异：只对"采样率"这一类错误降级重试一次。 */
      if (sr !== 24000 && /sample.?rate|采样率/i.test(String(e?.message ?? e))) {
        log(`[qwen-tts] ${sr}Hz 被拒，降级 24000Hz 重试一次：${e?.message ?? e}`);
        sr = 24000;
        j = await request(sr);
      } else {
        throw e;
      }
    }
    const out = pickOutput(j, '语音合成');
    const audio = out.audio ?? {};
    let buf = null;
    if (audio.data) {
      const b64 = String(audio.data).replace(/^data:[^,]+,/, '');
      buf = Buffer.from(b64, 'base64');
    } else if (audio.url) {
      const res = await fetch(String(audio.url), { signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`下载千问合成音频失败：HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_AUDIO_BYTES) throw new Error(`千问合成音频过大（${(len / 1048576).toFixed(1)}MB）`);
      buf = Buffer.from(await res.arrayBuffer());
    }
    if (!buf?.length) throw new Error('千问合成没有返回音频数据');
    return {
      buf,
      format: ['wav', 'mp3'].includes(format) ? format : 'wav',
      sampleRate: sr,
      chars: Number(j?.usage?.characters ?? out?.characters ?? 0) || [...t].length,
      requestId: j?.request_id || out?.request_id || '',
    };
  };

  return { config: q, enroll, query, waitReady, list, remove, synthesize };
}

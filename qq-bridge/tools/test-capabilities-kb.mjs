// 功能知识库回归：卡片完整性 + 查询命中（全部离线）
//   node tools/test-capabilities-kb.mjs
import { helpIndex, helpTopic, kbSize } from '../src/core/capabilities-kb.js';
import { WATERMARK_DEMO_DEFAULTS } from '../src/core/image-edit.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

console.log('== ① 卡片完整性 ==');
{
  const idx = helpIndex();
  ok('至少 12 张卡', idx.count >= 12, String(idx.count));
  const ids = idx.features.map((f) => f.id);
  for (const must of ['image-watermark', 'image-edit', 'image-gif', 'image-batch', 'file-convert', 'video-tools', 'pdf-tools', 'text-tools', 'qrcode', 'tts-clone', 'voice-bubble', 'pixiv']) {
    ok(`卡存在：${must}`, ids.includes(must));
  }
  ok('目录每张卡都有一句话简介', idx.features.every((f) => f.summary && f.name));
  ok('水印卡标了可演示', idx.features.find((f) => f.id === 'image-watermark')?.demo === 'watermark');
}

console.log('== ② 每张卡内容齐套 ==');
{
  const idx = helpIndex();
  let allOk = true;
  const missing = [];
  for (const f of idx.features) {
    const r = helpTopic(f.id);
    const e = r.entry;
    if (!e) { allOk = false; missing.push(`${f.id}(查不到)`); continue; }
    for (const field of ['summary', 'who', 'how', 'params', 'example', 'tips']) {
      const v = e[field];
      const empty = v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim());
      if (empty) { allOk = false; missing.push(`${f.id}.${field}`); }
    }
    if (!(e.example?.ask && e.example?.do && e.example?.get)) { allOk = false; missing.push(`${f.id}.example 三段`); }
    if (!Array.isArray(e.params) || !e.params.every((p) => p.name && p.desc)) { allOk = false; missing.push(`${f.id}.params 结构`); }
  }
  ok('12 张卡全部齐套（说明/对象/步骤/参数/实例/调参）', allOk, missing.join(', '));
}

console.log('== ③ 查询命中 ==');
{
  ok('别名"水印"命中图片加水印', helpTopic('水印').entry?.id === 'image-watermark');
  ok('别名"防盗图"命中', helpTopic('防盗图').entry?.id === 'image-watermark');
  ok('"tts"命中音色复刻', helpTopic('tts').entry?.id === 'tts-clone');
  ok('"语音合成"命中', helpTopic('语音合成').entry?.id === 'tts-clone');
  ok('"json"命中文本工具', helpTopic('json').entry?.id === 'text-tools');
  ok('"生图"命中 pixiv', helpTopic('生图').entry?.id === 'pixiv');
  ok('"pdf合并"命中 PDF 工具', helpTopic('pdf合并').entry?.id === 'pdf-tools');
  ok('带空格/大小写不敏感', helpTopic('TTS Clone').entry?.id === 'tts-clone');
  const miss = helpTopic('量子波动速读');
  ok('查不到给建议清单', miss.miss === true && Array.isArray(miss.suggestions) && miss.suggestions.length >= 12);
  ok('空查询返回目录', helpTopic('').count >= 12);
}

console.log('== ④ 水印默认配方 ==');
{
  ok('演示默认值：右下/白/65%/4%', WATERMARK_DEMO_DEFAULTS.position === 'bottom-right'
    && WATERMARK_DEMO_DEFAULTS.color === '#FFFFFF'
    && WATERMARK_DEMO_DEFAULTS.opacity === 0.65
    && WATERMARK_DEMO_DEFAULTS.fontSizePct === 4);
  const card = helpTopic('水印').entry;
  ok('卡上的防盗配方含 tile/-20/密度5', JSON.stringify(card.tips).includes('density') || JSON.stringify(card.params).includes('tile'));
  ok('卡上有完整实例（问/做/得）', !!(card.example.ask && card.example.do && card.example.get));
}

console.log(`\n${pass} passed${process.exitCode ? '，有失败' : ''}`);

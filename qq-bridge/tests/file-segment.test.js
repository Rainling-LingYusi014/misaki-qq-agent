// 入站文件段解析回归（2026-10-28）：
// OneBot v11 私聊文件段的标准字段是 {file, file_id, file_size}，没有 name。
// 旧实现只读 d.name、把 d.file 当 fileId → 所有收到的文件都显示「未命名文件 · 未知类型」，
// 且 get_file 永远 file not found（主子 16:02 的实训3.2.docx 实测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFilesFromSegments, fileMarker, segmentsToText } from '../src/lib/message-parse.js';

const realSegment = {
  type: 'file',
  data: {
    file: '实训3.2.docx',
    file_id: '4d552827f95b09df4de35ea1c783c368_f3169a4a-d2a5-11f1-84a9-2311cd9e4c7b',
    file_size: '146342',
  },
};

test('私聊文件段：name/fileId/size/kind 全部按 OneBot 标准字段映射', () => {
  const [f] = extractFilesFromSegments([realSegment]);
  assert.equal(f.name, '实训3.2.docx');
  assert.equal(f.fileId, '4d552827f95b09df4de35ea1c783c368_f3169a4a-d2a5-11f1-84a9-2311cd9e4c7b');
  assert.equal(f.size, 146342);
  assert.equal(f.kind, 'Word');
  assert.equal(f.ext, 'docx');
  assert.match(f.marker, /实训3\.2\.docx/);
  assert.match(f.marker, /Word/);
});

test('缺 name 时 marker 用 file 兜底，不再渲染成未命名文件', async () => {
  const text = await segmentsToText([{ type: 'file', data: { file: '实训3.2.docx', file_size: '146342' } }]);
  assert.match(text, /实训3\.2\.docx/);
  assert.match(text, /Word/);
  assert.doesNotMatch(text, /未命名文件/);
});

test('老式段（只有 file，没有 file_id）fileId 退回 file，保持兼容', () => {
  const [f] = extractFilesFromSegments([{ type: 'file', data: { file: 'abc', size: 12 } }]);
  assert.equal(f.fileId, 'abc');
  assert.equal(f.size, 12);
  assert.equal(fileMarker(undefined, undefined), '[文件:未命名文件 · 未知类型]');
});

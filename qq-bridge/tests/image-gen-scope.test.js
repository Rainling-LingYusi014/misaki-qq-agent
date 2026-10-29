// 生图链路回归（2026-10-28）：
// stageImageBytes 曾定义在 `if (tools.imageSearch !== false)` 的块内，
// 而 qq_generate_image 注册在并列的另一个 if 块里 —— ESM 严格模式下块内函数声明
// 不外泄，调用时抛 ReferenceError: stageImageBytes is not defined，
// 表现为"生图失败（已送出 0 张）"，与网络/余额无关。
// 这里守住结构约束：声明必须出现在两个使用它的注册块之前（即模块顶层）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'mcp-napcat-safe.js'), 'utf8');

test('stageImageBytes 必须声明在使用它的注册块之前（模块顶层）', () => {
  const decl = src.indexOf('function stageImageBytes(');
  const searchBlock = src.indexOf("if (cfg.social?.tools?.imageSearch !== false) {");
  const genBlock = src.indexOf("if (cfg.social?.tools?.generateImage !== false) {");
  assert.ok(decl > 0, '缺少 stageImageBytes 声明');
  assert.ok(searchBlock > 0, '找不到 imageSearch 注册块');
  assert.ok(genBlock > 0, '找不到 generateImage 注册块');
  assert.ok(
    decl < searchBlock,
    'stageImageBytes 必须在 imageSearch 块之前声明；放进块内会让 qq_send_image 之外的调用方 ReferenceError',
  );
  assert.ok(
    decl < genBlock,
    'stageImageBytes 必须在 generateImage 块之前声明；否则生图在暂存阶段必抛 ReferenceError',
  );
});

test('生图代理分支保留 curl 错误细节（-sS 与退出码）', () => {
  // 2026-10-28 事故：-s 把 curl 自身错误文本一并吞掉，只剩 "Command failed" 无法定位。
  assert.match(src, /execFile\(curlBin, \['-sS'/);
  assert.match(src, /退出码 \$\{code\}/);
});

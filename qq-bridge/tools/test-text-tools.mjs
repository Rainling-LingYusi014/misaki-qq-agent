// 文本 / JSON 工具的离线回归（runTextOp 是纯函数，全部可本地真跑）
//   node tools/test-text-tools.mjs
import { runTextOp, textCapabilities, TEXT_OPS } from '../src/core/text-tools.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};
const eq = (name, got, want) => ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const throws = (name, fn, re) => {
  try { fn(); ok(name, false, '没有抛错'); } catch (e) { ok(name, re.test(e.message), e.message); }
};

console.log('== ① 能力表 ==');
{
  const c = textCapabilities();
  ok('16 个操作', TEXT_OPS.length === 16, TEXT_OPS.join(','));
  ok('能力表与操作清单一致', c.ops.length === TEXT_OPS.length);
}

console.log('== ② JSON ==');
{
  eq('json-format 默认 2 空格', runTextOp('json-format', '{"a":1}'), '{\n  "a": 1\n}\n');
  eq('json-format tab 缩进', runTextOp('json-format', '[1,2]', { indent: 'tab' }), '[\n\t1,\n\t2\n]\n');
  eq('json-format 收一行', runTextOp('json-format', '{"a": 1}', { indent: '0' }), '{"a":1}');
  eq('json-format 键排序', runTextOp('json-format', '{"b":1,"a":2}', { sortKeys: true }).indexOf('"a"') < runTextOp('json-format', '{"b":1,"a":2}', { sortKeys: true }).indexOf('"b"'), true);
  eq('json-minify', runTextOp('json-minify', '{\n  "a": 1\n}'), '{"a":1}');
  eq('json-validate 合法', runTextOp('json-validate', '{"ok":true}'), 'JSON 合法 ✓');
  const bad = runTextOp('json-validate', '{\n"a":1\n}x');
  ok('json-validate 报行列', /不合法/.test(bad) && /第 3 行第 2 列/.test(bad), bad);
  throws('json-format 对非 JSON 抛错', () => runTextOp('json-format', 'not json'), /JSON/);
}

console.log('== ③ 编码 / 哈希 ==');
{
  eq('base64-encode', runTextOp('base64-encode', '玲結美咲'), '546y57WQ576O5ZKy');
  eq('base64-decode 往返', runTextOp('base64-decode', '546y57WQ576O5ZKy'), '玲結美咲');
  throws('坏 base64 拒绝', () => runTextOp('base64-decode', 'not!!!'), /base64/);
  eq('url-encode', runTextOp('url-encode', 'a b&c=d'), 'a%20b%26c%3Dd');
  eq('url-decode', runTextOp('url-decode', 'a%20b%26c%3Dd'), 'a b&c=d');
  eq('hash 默认 sha256', runTextOp('hash', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  eq('hash md5', runTextOp('hash', 'abc', { algo: 'md5' }), '900150983cd24fb0d6963f7d28e17f72');
  throws('非法 algo', () => runTextOp('hash', 'x', { algo: 'crc32' }), /md5 \/ sha1/);
}

console.log('== ④ 统计 / 行操作 ==');
{
  const out = runTextOp('count', 'hello 世界\n第二行');
  ok('count 报码点/字节/行数', out.includes('字符（码点）：12') && out.includes('字节（UTF-8）：22') && out.includes('行数：2') && out.includes('中日韩字符：5'), out);
  eq('dedupe 保序', runTextOp('dedupe', 'b\na\nb\na\nc'), 'b\na\nc');
  eq('sort asc', runTextOp('sort-lines', 'b\na\nc'), 'a\nb\nc');
  eq('sort desc', runTextOp('sort-lines', 'b\na\nc', { order: 'desc' }), 'c\nb\na');
  eq('sort numeric', runTextOp('sort-lines', '10\n9\n100', { numeric: true }), '9\n10\n100');
  eq('sort by length', runTextOp('sort-lines', 'ccc\na\nbb', { order: 'length' }), 'a\nbb\nccc');
  eq('reverse-lines', runTextOp('reverse-lines', '1\n2\n3'), '3\n2\n1');
  eq('upper', runTextOp('upper', 'aBc'), 'ABC');
  eq('lower', runTextOp('lower', 'aBc'), 'abc');
  eq('trim-lines 去空行', runTextOp('trim-lines', '  a  \n\n b '), 'a\nb');
  eq('trim-lines 保留空行', runTextOp('trim-lines', ' a \n\n b ', { keepEmpty: true }), 'a\n\nb');
  eq('replace 字面全部', runTextOp('replace', 'aXaX', { find: 'X', replaceWith: 'y' }), 'ayay');
  eq('replace 只第一个', runTextOp('replace', 'aXaX', { find: 'X', replaceWith: 'y', all: false }), 'ayaX');
  eq('replace 正则', runTextOp('replace', 'a1b22c333', { find: '\\d+', replaceWith: '-', regex: true }), 'a-b-c-');
  throws('replace 缺 find', () => runTextOp('replace', 'abc'), /find/);
}

console.log('== ⑤ 杂项 ==');
{
  throws('未知操作', () => runTextOp('nope', 'x'), /未知操作/);
  ok('unicode 按码点计', runTextOp('count', '👍').includes('字符（码点）：1'));
  eq('中文排序 locale', runTextOp('sort-lines', '玲\n美\n結', { order: 'asc' }), runTextOp('sort-lines', '玲\n美\n結'));
}

console.log(`\n${pass} passed${process.exitCode ? '，有失败' : ''}`);

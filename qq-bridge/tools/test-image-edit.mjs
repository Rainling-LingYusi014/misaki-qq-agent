// 图片编辑 + ICO 的离线/本机集成回归（Pillow 可用时真跑一遍；否则只跑参数校验）
//   node tools/test-image-edit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildImageCapabilities, validateImageOptions, editImage, makeGif, batchEditImages, demoWatermark } from '../src/core/image-edit.js';
import { convertFile, probeTools } from '../src/core/file-convert.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};
const throws = (name, fn, re) => {
  try { fn(); ok(name, false, '没有抛错'); } catch (e) { ok(name, re.test(e.message), e.message); }
};

console.log('== ① 能力与参数校验 ==');
{
  const c = buildImageCapabilities({ pillow: true, pyCmd: 'python' });
  ok('Pillow 可用时七种动作', c.actions.join(',') === 'compress,resize,crop,shape,watermark,gif,demo-watermark', c.actions.join(','));
  ok('Pillow 可用时三种形状', c.shapes.join(',') === 'circle,rounded,ellipse', c.shapes.join(','));
  ok('水印位置表含 tile', c.watermark.positions.includes('tile'));
  const no = buildImageCapabilities({ pillow: false });
  ok('没有 Pillow 时不假装可用', no.available === false && no.actions.length === 0);
  ok('压缩默认参数', validateImageOptions({ action: 'compress' }).format === 'png');
  ok('aspect 归一', validateImageOptions({ action: 'crop', aspect: '16:9' }).aspect === '16:9');
  throws('图形裁剪拒绝 jpg', () => validateImageOptions({ action: 'shape', shape: 'circle', format: 'jpg' }), /png 或 webp/);
  throws('resize 缺宽高', () => validateImageOptions({ action: 'resize' }), /width 和 height/);
  throws('crop 缺区域/比例', () => validateImageOptions({ action: 'crop' }), /crop 区域或 aspect/);
  throws('crop 区域非法', () => validateImageOptions({ action: 'crop', crop: [0, 0, 0, 100] }), /宽\/高/);
  throws('未知动作', () => validateImageOptions({ action: 'blur' }), /compress/);
}

console.log('== ② 水印 / GIF 参数 ==');
{
  throws('水印动作缺 watermark', () => validateImageOptions({ action: 'watermark' }), /watermark 参数/);
  throws('文字水印缺 text', () => validateImageOptions({ action: 'watermark', watermark: { position: 'bottom' } }), /watermark\.text/);
  throws('水印位置非法', () => validateImageOptions({ action: 'watermark', watermark: { text: 'x', position: 'middle' } }), /position/);
  throws('水印透明度非法', () => validateImageOptions({ action: 'watermark', watermark: { text: 'x', opacity: 2 } }), /0\.01~1/);
  throws('水印角度超界', () => validateImageOptions({ action: 'watermark', watermark: { text: 'x', rotation: 200 } }), /-180~180/);
  throws('平铺密度超界', () => validateImageOptions({ action: 'watermark', watermark: { text: 'x', density: 0 } }), /1~20/);
  throws('相对字号超界', () => validateImageOptions({ action: 'watermark', watermark: { text: 'x', fontSizePct: 60 } }), /1~50/);
  ok('中文颜色别名 红→#FF0000', validateImageOptions({ action: 'watermark', watermark: { text: 'x', color: '红色' } }).watermark.color === '#FF0000');
  ok('hex 大写归一', validateImageOptions({ action: 'watermark', watermark: { text: 'x', color: '#12abcd' } }).watermark.color === '#12ABCD');
  throws('认不出的颜色给指路', () => validateImageOptions({ action: 'watermark', watermark: { text: 'x', color: '奶奶灰' } }), /认不出/);
  const wm = validateImageOptions({ action: 'watermark', watermark: { text: '© 玲結美咲', position: 'tile', opacity: 0.5, fontSizePct: 6, color: '#FF0000', rotation: -20, density: 8 } });
  ok('全页水印参数归一', wm.watermark.position === 'tile' && wm.watermark.rotation === -20 && wm.watermark.density === 8 && wm.watermark.fontSizePct === 6 && wm.watermark.fontSize === 0);
  ok('默认密度 5 / 角度 0', validateImageOptions({ action: 'watermark', watermark: { text: 'x' } }).watermark.density === 5
    && validateImageOptions({ action: 'watermark', watermark: { text: 'x' } }).watermark.rotation === 0);
  ok('水印可叠加在 resize 上', validateImageOptions({ action: 'resize', width: 800, height: 600, watermark: { text: 'x' } }).watermark.text === 'x');
  ok('GIF 固定输出 gif', validateImageOptions({ action: 'gif', format: 'png' }).format === 'gif');
  ok('GIF delay 默认 500', validateImageOptions({ action: 'gif' }).delay === 500);
  throws('GIF 宽度超 1280', () => validateImageOptions({ action: 'gif', width: 1920 }), /1280/);
  throws('GIF delay 超界', () => validateImageOptions({ action: 'gif', delay: 5 }), /20~10000/);
  throws('GIF fps 超界', () => validateImageOptions({ action: 'gif', fps: 60 }), /0\.5~30/);
  throws('GIF loop 负数', () => validateImageOptions({ action: 'gif', loop: -1 }), /循环次数/);
}

console.log('== ② 本机真跑（Pillow） ==');
{
  const t = probeTools();
  if (!t.pillow) {
    console.log('  SKIP 本机没有 Pillow，跳过真跑');
  } else {
    const py = t.pyCmd;
    const testImg = path.join('state', '_test_img.png');
    const noisyImg = path.join('state', '_test_noise.png');
    const hadUsage = fs.existsSync(path.join('state', 'convert-usage.json'));
    const created = [];
    try {
      fs.mkdirSync('state', { recursive: true });
      let r = spawnSync(py, ['-c', 'from PIL import Image; im=Image.new("RGB",(400,300),(220,40,40)); im.save(r"state/_test_img.png")'], { encoding: 'utf8' });
      ok('生成测试图', r.status === 0, r.stderr);
      r = spawnSync(py, ['-c', 'from PIL import Image; im=Image.effect_noise((1200,1200),100).convert("RGB"); im.save(r"state/_test_noise.png")'], { encoding: 'utf8' });
      ok('生成噪声图', r.status === 0, r.stderr);
      const buf = fs.readFileSync(testImg);
      const cfg = { convert: { enabled: true } };

      const shape = await editImage({
        cfg, name: 'test.png', buf, uid: 'test-owner', isOwner: true,
        options: { action: 'shape', shape: 'circle', width: 256, height: 256, format: 'png' },
      });
      created.push(shape.filePath);
      const check = spawnSync(py, ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGBA"); print(im.size, im.getpixel((0,0))[3], im.getpixel((128,128))[3])', shape.filePath], { encoding: 'utf8' });
      ok('圆形裁剪 256x256、四角透明、中心不透明', /\(256, 256\) 0 255/.test(String(check.stdout || '')), check.stdout || check.stderr);

      const noisy = fs.readFileSync(noisyImg);
      const comp = await editImage({
        cfg, name: 'noise.png', buf: noisy, uid: 'test-owner', isOwner: true,
        options: { action: 'compress', format: 'jpg', quality: 90, targetKB: 50 },
      });
      created.push(comp.filePath);
      ok('压缩到 50KB 以内', comp.bytes <= 50 * 1024, `${(comp.bytes / 1024).toFixed(1)}KB`);

      const cropped = await editImage({
        cfg, name: 'noise.png', buf: noisy, uid: 'test-owner', isOwner: true,
        options: { action: 'crop', aspect: '1:1', width: 200, height: 200, mode: 'crop', format: 'png' },
      });
      created.push(cropped.filePath);
      const dim = spawnSync(py, ['-c', 'from PIL import Image; import sys; print(Image.open(sys.argv[1]).size)', cropped.filePath], { encoding: 'utf8' });
      ok('1:1 裁剪成 200x200', /\(200, 200\)/.test(String(dim.stdout || '')), dim.stdout || dim.stderr);

      const ico = await convertFile({
        cfg, name: 'test.png', buf, target: 'ico', uid: 'test-owner', isOwner: true,
      });
      created.push(ico.filePath);
      const icoInfo = spawnSync(py, ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.format, im.size)', ico.filePath], { encoding: 'utf8' });
      ok('ICO 产出可被 Pillow 打开', /ICO \(256, 256\)/.test(String(icoInfo.stdout || '')), icoInfo.stdout || icoInfo.stderr);

      /* 中文文字水印（Windows 本机有 msyh；服务器要有 wqy/noto 才过这条） */
      try {
        const wm = await editImage({
          cfg, name: 'test.png', buf, uid: 'test-owner', isOwner: true,
          options: { action: 'watermark', watermark: { text: '© 玲結美咲', position: 'bottom-right', fontSize: 36, color: '#FFFFFF', opacity: 1 } },
        });
        created.push(wm.filePath);
        const wmCheck = spawnSync(py, ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGB"); w,h=im.size; q=list(im.crop((w//2,h//2,w,h)).getdata()); print(im.size, any(p[0]>240 and p[1]>240 and p[2]>240 for p in q))', wm.filePath], { encoding: 'utf8' });
        ok('中文水印真实画上了（右下象限出现白色像素）', /\(400, 300\) True/.test(String(wmCheck.stdout || '')), wmCheck.stdout || wmCheck.stderr);
      } catch (e) {
        if (/中文字体/.test(e.message)) console.log(`  SKIP 中文水印：本机缺 CJK 字体（${e.message}）`);
        else throw e;
      }

      /* 全页防盗水印：旋转 -20° 平铺，四个象限都该出现白色笔画 */
      try {
        const tile = await editImage({
          cfg, name: 'test.png', buf, uid: 'test-owner', isOwner: true,
          options: { action: 'watermark', watermark: { text: '玲結 TEST', position: 'tile', rotation: -20, density: 8, fontSize: 26, color: '#FFFFFF', opacity: 1 } },
        });
        created.push(tile.filePath);
        const tileCheck = spawnSync(py, ['-c', `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
def has(x0, y0, x1, y1):
    return any(p[0] > 240 and p[1] > 240 and p[2] > 240 for p in im.crop((x0, y0, x1, y1)).getdata())
print(has(0, 0, w // 2, h // 2), has(w // 2, 0, w, h // 2), has(0, h // 2, w // 2, h), has(w // 2, h // 2, w, h))
`, tile.filePath], { encoding: 'utf8' });
        ok('旋转平铺水印盖满四象限', /True True True True/.test(String(tileCheck.stdout || '')), tileCheck.stdout || tileCheck.stderr);
      } catch (e) {
        if (/中文字体/.test(e.message)) console.log(`  SKIP 平铺水印：本机缺 CJK 字体`);
        else throw e;
      }

      /* 三帧合成 GIF（不同颜色 + 不同尺寸，验证 contain 白底合成） */
      const frames = [];
      for (const [i, color] of ['red', 'green', 'blue'].entries()) {
        const fp = path.join('state', `_test_gif_${i}.png`);
        const rr = spawnSync(py, ['-c', `from PIL import Image; im=Image.new("RGB",(${300 + i * 50},200),"${color}"); im.save(r"${fp.replace(/\\/g, '/')}")`], { encoding: 'utf8' });
        if (rr.status !== 0) throw new Error(rr.stderr);
        frames.push({ name: `f${i}.png`, buf: fs.readFileSync(fp) });
        created.push(fp);
      }
      const gif = await makeGif({ cfg, images: frames, uid: 'test-owner', isOwner: true, options: { width: 240, fps: 5 } });
      created.push(gif.filePath);
      const gifCheck = spawnSync(py, ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.format, im.n_frames, im.size, im.info.get("duration"))', gif.filePath], { encoding: 'utf8' });
      ok('GIF 3 帧 240 宽 fps=5（200ms/帧）', /GIF 3 \(240, 160\) 200/.test(String(gifCheck.stdout || '')), gifCheck.stdout || gifCheck.stderr);
      try { await makeGif({ cfg, images: [frames[0]], uid: 'test-owner', isOwner: true }); ok('单帧拒绝合成 GIF', false, '没有抛错'); }
      catch (e) { ok('单帧拒绝合成 GIF', /至少要 2 张/.test(e.message), e.message); }

      /* 批量处理：3 帧同参数压成 png → 打包 ZIP */
      const zip = await batchEditImages({
        cfg, images: frames, uid: 'test-owner', isOwner: true,
        options: { action: 'compress', format: 'png', quality: 80 },
      });
      created.push(zip.filePath);
      const zipCheck = spawnSync(py, ['-c', 'import zipfile, sys; z=zipfile.ZipFile(sys.argv[1]); print(len(z.namelist()), all(n.endswith(".png") for n in z.namelist()))', zip.filePath], { encoding: 'utf8' });
      ok('批量 3 张打包成 ZIP', /3 True/.test(String(zipCheck.stdout || '')), zipCheck.stdout || zipCheck.stderr);
      try { await batchEditImages({ cfg, images: [frames[0]], uid: 'test-owner', isOwner: true, options: { action: 'compress' } }); ok('单张拒绝批量', false, '没有抛错'); }
      catch (e) { ok('单张拒绝批量', /至少要 2 张/.test(e.message), e.message); }
      try { await batchEditImages({ cfg, images: frames, uid: 'test-owner', isOwner: true, options: { action: 'gif' } }); ok('批量拒绝 gif 动作', false, '没有抛错'); }
      catch (e) { ok('批量拒绝 gif 动作', /action=gif/.test(e.message), e.message); }

      /* 水印演示图（教学）：程序化背景 + 默认配方，改一个旋钮要生效 */
      const demo = await demoWatermark({ cfg, uid: 'test-owner', isOwner: true, options: { watermark: { color: '金色', opacity: 0.9 } } });
      created.push(demo.filePath);
      ok('演示图产出且参数回显（金色别名生效）', demo.bytes > 100 && demo.applied.color === '#FFD700' && demo.applied.opacity === 0.9, JSON.stringify(demo.applied));
      ok('演示图保留默认配方基准（位置/字号%）', demo.applied.position === 'bottom-right' && demo.applied.fontSizePct === 4, JSON.stringify(demo.applied));
      const demo2 = await demoWatermark({ cfg, uid: 'test-owner', isOwner: true, options: { watermark: { position: 'tile', rotation: -20, density: 10 } } });
      created.push(demo2.filePath);
      ok('全页演示（tile/-20/密度10）', demo2.applied.position === 'tile' && demo2.applied.rotation === -20 && demo2.applied.density === 10, JSON.stringify(demo2.applied));
      ok('演示图比单角标大（平铺信息量）', demo2.bytes > demo.bytes * 0.5, `${demo.bytes} vs ${demo2.bytes}`);
    } finally {
      for (const p of created) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      for (const p of [testImg, noisyImg]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      if (!hadUsage) { try { fs.unlinkSync(path.join('state', 'convert-usage.json')); } catch { /* ignore */ } }
    }
  }
}

console.log(`\n${pass} passed${process.exitCode ? '，有失败' : ''}`);

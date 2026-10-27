/* 沙箱读白名单自检（2026-10-27，审查 P2-2）
 *
 * 背景：landlock 读白名单与禁提权是打在 DSH node_modules 里的就地 patch（.bak 备份在，
 * deploy/patches/ 有重建物料）。DSH 任何升级都会冲掉 patch，届时 bash/subagent 重新
 * 可读全盘（config 的 API key、B站 cookie），且无告警。桥启动时校验 patch 标记仍在，
 * 缺失则醒目告警——物理防线失效时，preset 教学层就是唯一防线，必须让人知道。
 *
 * 成功也留一行：否则「检查通过」与「路径写错/根本没检查」在日志上无法区分（本文件初版
 * 就把包名拼成 @deepseeai，静默空转了一版）。 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.js';

export function auditSandboxPatch(dshRoot) {
  try {
    const root = String(dshRoot || '/home/ubuntu/qq-agent/dsh');
    const local = path.join(root, 'node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js');
    const esc = path.join(root, 'node_modules/@deepseek-ai/dsh-sandbox/lib/index.js');
    const localOk = fs.existsSync(local);
    const escOk = fs.existsSync(esc);
    if (!localOk && !escOk) {
      log(`[security] 沙箱自检跳过：未找到 DSH 沙箱包（root=${root}）——非 DSH 部署可忽略`);
      return { checked: false, localOk: false, escOk: false };
    }
    const localPatched = localOk && fs.readFileSync(local, 'utf8').includes('yt-dlp');
    const escPatched = escOk && /ESCALATION_TARGETS\s*=\s*\[\]/.test(fs.readFileSync(esc, 'utf8'));
    if (localOk && !localPatched) {
      log('[security][P0告警] 沙箱读白名单 patch 缺失（readOnly 疑似回退全盘可读）——按 deploy/patches/README 重打并重启 DSH！');
    }
    if (escOk && !escPatched) {
      log('[security][P0告警] 沙箱禁提权 patch 缺失（ESCALATION_TARGETS 非空）——按 deploy/patches/README 重打并重启 DSH！');
    }
    if ((!localOk || localPatched) && (!escOk || escPatched)) {
      log(`[security] 沙箱 patch 自检通过（读白名单 ${localOk ? '✓' : '跳过'} / 禁提权 ${escOk ? '✓' : '跳过'}）`);
    }
    return { checked: true, localOk: localPatched, escOk: escPatched };
  } catch (e) {
    log('[security] 沙箱自检异常：' + (e?.message ?? e));
    return { checked: false, error: String(e?.message ?? e) };
  }
}

# DSH 沙箱凭据硬化补丁（2026-10-26 建立，2026-10-27 入库）

**为什么要这两个补丁**：DSH 的 `bash` 执行通道在 landlock 沙箱里跑。原版 `dsh-sandbox-local`
的 Landlock 读权限是 `readOnly: ["/"]`（**全盘可读**）——子代理能以同一用户身份读
`qq-bridge/config.json`（DeepSeek API key）、`state/bilibili-auth.json`（B 站 cookie）、
`/etc/systemd/system/*.service`（cloudflared token）、`/proc/<pid>/environ`（桥的环境变量）。
写权限本来就有白名单，读没有。这两份补丁把「读」也收窄，并把提权通道彻底关掉。

**它们是就地修改 DSH node_modules 的补丁，不是 npm 包的一部分。DSH 一旦升级/重装就会被冲掉，
必须按本文重打，然后重启 DSH。** 桥启动时会自检（`src/core/sandbox-audit.js`），缺失会在
journal 打出 `[security][P0告警]`。

## 01-sandbox-local-read-allowlist.patch

目标文件：`<dsh-root>/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js`
作用：`landlockProfileArgs()` 里的 `readOnly: ["/"]` → 运行时依赖白名单（/usr /bin /sbin
/lib /lib64 + 散装 /etc 安全文件 + /etc/fonts + yt-dlp 独立二进制）。
刻意排除：`/etc` 整体（systemd unit 含 token）、`/proc`（environ 可读）、`/home` 非 workspace
部分、`/var`、`/root`、`/opt`。

## 02-sandbox-no-escalation.patch

目标文件：`<dsh-root>/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js`
作用：`ESCALATION_TARGETS = ["workspace-write", "danger-full-access"]` → `[]`。
原因：桥的 approval 机制把审批发回**当前会话**，即可能由提问的朋友自己点「同意」，
把沙箱提权到 `danger-full-access`——等于沙箱白设。deny 之后 denied 命令没有升级提示、
升级参数过不了 schema 校验。

## 应用方法（DSH 升级/重装后）

```bash
cd <dsh-root>/node_modules/@deepseek-ai
# 备份（补丁本身要求原版内容，先确认是否原版）
cp dsh-sandbox-local/lib/index.js dsh-sandbox-local/lib/index.js.bak-$(date +%Y%m%d)
cp dsh-sandbox/lib/index.js       dsh-sandbox/lib/index.js.bak-$(date +%Y%m%d)
# 重打（-p0 因为 patch 头里带完整相对路径）
patch -p0 --dry-run < <repo>/deploy/patches/01-sandbox-local-read-allowlist.patch
patch -p0 < <repo>/deploy/patches/01-sandbox-local-read-allowlist.patch
patch -p0 < <repo>/deploy/patches/02-sandbox-no-escalation.patch
sudo systemctl restart qq-agent-dsh
```

注意：patch 头部记录的旧路径是 `.bak-pre-cred-hardening-20261026`；若用 `patch -p0`
提示目标不存在，直接按 `01/02` 的 `@@` 内容手工改两处（改动很小，见 patch 正文）。

## 验证

```bash
# 1. 标记在位（桥自检同款判据）
grep -c "yt-dlp" <dsh-root>/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js   # 期望 1
grep -o "ESCALATION_TARGETS = \[\]" <dsh-root>/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js   # 期望命中

# 2. 行为验证：子代理读 state 应被拒（在 QQ 里让她 delegate 一次 cat state/bilibili-auth.json，
#    预期沙箱 deny；若读到了内容，说明 patch 未生效）
```

## 历史

- 2026-10-26：凭据安全 5 路审查发现读全盘漏洞 → 就地打补丁（.bak 备份留档）
- 2026-10-27：审查发现「补丁文件已随仓库发布」是假断言（git 全历史无 deploy/patches/）→
  从服务器 .bak diff 重建为正式 patch 入库 + 桥启动自检

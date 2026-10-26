# DSH npm 补丁（凭据硬化，2026-10-26）

这两个 patch 修改 DSH 0.1.2-rc.1 的 npm 包源码。**升级 DSH 后需要重打**（见主手册坑 13）。

| 文件 | 作用 |
|---|---|
| `dsh-sandbox-local-read-allowlist.patch` | 沙箱读白名单化：原版 `readOnly: ["/"]`（子代理可读全盘，含 qq-bridge 的 config.json/state）收窄为运行必需集（/usr + 散装 /etc 安全文件），并放行 `~/.local/bin/yt-dlp` |
| `dsh-sandbox-no-escalation.patch` | 一刀切禁用沙箱提权（`ESCALATION_TARGETS = []`）：QQ 桥场景下 DSH 的审批流会发回当前会话，朋友可自批提权到 danger-full-access——禁掉后 denied 就是 final |

## 应用方法

在 DSH 安装目录（含 `node_modules`）执行：

```bash
cd /path/to/dsh   # 其下有 node_modules/@deepseek-ai/
patch -p0 < deploy/patches/dsh-sandbox-local-read-allowlist.patch
patch -p0 < deploy/patches/dsh-sandbox-no-escalation.patch
```

patch 内的目标路径形如 `node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js`，`-p0` 按相对路径原样应用；如果你的安装布局不同，先 `-p0 --dry-run` 试跑再调整。

## 应用后验证（必做）

用 landlock launcher 直测（不依赖模型）：

```bash
L=$(find node_modules/@deepseek-ai -path "*landlock-run-linux-x64/bin/landlock-run" | head -1)
# 负向：应 Permission denied
$L --ro /usr --ro /bin --ro /lib --ro /lib64 --ro /etc/ssl --rw /tmp --rw "$PWD" -- \
  cat /path/to/qq-bridge/config.json
# 正向：应正常输出版本号
$L --ro /usr --ro /bin --ro /lib --ro /lib64 --ro /etc/ssl --rw /tmp --rw "$PWD" -- ffmpeg -version
```

完整验证清单（含 /etc/systemd unit、TLS、python 等）见 `deploy/安装与接入.md` 坑 13。
注意：patch 前先备份原文件（`cp file file.bak-$(date +%F)`）。

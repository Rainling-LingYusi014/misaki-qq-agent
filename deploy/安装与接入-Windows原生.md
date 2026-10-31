# 部署与接入手册 · Windows 原生路线（qq 工具型 agent）

> **读者**：AI agent（执行者）或照着敲命令的人。按步骤顺序执行，**每一步末尾的验证通过再进下一步**；失败先查 §故障表。
> **置信度声明**：本路线是作者自己的 Windows 生产环境（Win10/11 x64 + Node 22）每天在跑的形态，不是理论推导。个别标了「未逐字验证」的小节（主要是 NapCat 安装器界面，版本迭代快）请以 NapCat 官方文档为准，**不要脑补**。
> 姊妹篇：Linux 服务器部署见 [`deploy/安装与接入.md`](./安装与接入.md)。两篇的验证清单、人设占位、config 字段语义是共享的，本文只写 Windows 差异与完整落地步骤。

---

## 0. 路线选择（先读再动手）

| 路线 | 适合谁 | 代价 |
|---|---|---|
| **本文：Windows 原生** | 只有一台 Windows 电脑、想立刻跑起来 | 没有 landlock 沙箱（§4 有补偿措施）；systemd 换成 bat/计划任务 |
| WSL2 | Windows 10/11 都行 | 装完 WSL2 + Ubuntu（`wsl --install -d Ubuntu`，`/etc/wsl.conf` 写 `[boot]\nsystemd=true`）后，**直接照抄 Linux 手册**，landlock 也能用（内核 ≥5.13） |
| Linux 云服务器 | 想要 7×24 在线 | 要花钱；按 Linux 手册走 |

急着用、手头只有 Windows → 用本文路线，全程零编译。

## 1. 与 Linux 版的差异总览

| Linux 手册里的做法 | Windows 原生对应 | 说明 |
|---|---|---|
| 解包 QQ Linux deb + `g++` 编 `.so` 注入器 | **NapCat Shell Windows 发行版**，官方 release zip 解压即用 | 零编译，这是两版最大的分岔 |
| landlock 沙箱 + `deploy/patches/01、02` 两个补丁 | **不适用，跳过**。landlock 是 Linux 内核特性 | 补偿措施见 §4.3；桥的 `[security][P0告警]` 自检日志在 Windows 属预期 |
| systemd 三单元守护 | `start.bat` 循环 + `start-hidden.vbs` + `restart.bat`（本仓库自带） | 开机自启用任务计划程序（§6） |
| `unshare` 断网隔离 | 无对应物 | 不要给 DSH 配置会拉起 Linux 专用工具的任务 |
| bash / zstd / tar 工具链 | Git Bash（可选，跑测试用） | 运行本体只需要 Node |

## 2. 前置条件

1. Windows 10 / 11 x64，能登录 Microsoft Store 或下载 exe。
2. **Node ≥ 22.13**（桥的 package.json 要求）：装 LTS 版后 `node -v` 应输出 `v22.x`。
3. 一个用作 bot 的 QQ 号 + 一台能登手机 QQ 的设备（扫码登录用）。
4. DeepSeek API key（`sk-xxxx` 形态，只放环境变量/本地 env 文件，**不进 git**）。
5. 可选：境外代理（只有要让她「生图」才需要，纯聊天不需要）。

## 3. 目录规划

按仓库既有布局（`<ROOT>` 换成你的安装根目录，**路径含中文没问题，但 cmd 脚本内的匹配串要保持 ASCII**，原因见 §故障表）：

```
<ROOT>\
├─ qq-bridge\      桥源码（npm ci 在这里跑）
├─ dsh-local\      DSH 运行包（npm i 在这里跑）
├─ dsh-home\       DSH 的 home（首次启动自动初始化，不用手建）
├─ deploy\         本手册、补丁、参考配置
└─ NapCat\         NapCat Shell 解压地（任意盘，下文以 D:\NapCat\Shell 为例）
```

## 4. 六步安装

### 4.1 第 1 步：QQ NT（Windows 版 QQ）

装官方 QQ 并登录一次（完成初始化即可退出）。NapCat Windows 版依赖本机 QQ NT 客户端。

### 4.2 第 2 步：NapCat Shell（Windows）

> 本小节「未逐字验证」：安装器 UI 随 NapCat 版本变化，以 [NapCat 官方仓库](https://github.com/NapNeko/NapCatQQ) 的 Windows 安装文档为准。以下是被本机生产验证过的**结果形态**：

1. 从官方 release 下载 Windows 版（NapCat.Shell zip），解压到 `D:\NapCat\Shell`。
2. 按 NapCat 文档初始化（会生成针对某个 QQ 号的启动 bat，本机形态是 `launcher-bot.bat`）。
3. 启动后扫码登录 bot 号（二维码会落在 NapCat 的 `cache\qrcode.png`，也能在 WebUI 看）。
4. **OneBot v11 网络配置**（NapCat WebUI 里配，两侧 token 必须与桥的 config 一致）：
   - WS 服务端：监听 `3001`，`accessToken` = 之后写进桥 config 的 `napcat.wsAccessToken`；
   - HTTP 服务端：监听 `3000`，`accessToken` = config 的 `napcat.accessToken`。

**多实例踢线警告（真机事故教训）**：扫码等待期间 3000 端口可能是关的——**判「NapCat 在不在跑」要看进程（根进程名 `NapCatWinBootMain`），不能只看端口**。重复拉起第二套实例会让多套实例共用同一 qq-data 互相踢线，登录态直接废掉。

### 4.3 第 3 步：DSH（模型大脑，端口 10721）

DSH 是 npm 包，Windows 原生可跑（作者生产就在 Windows 跑）：

```powershell
mkdir <ROOT>\dsh-local ; cd <ROOT>\dsh-local
npm init -y
npm i @deepseek-ai/dsh@0.1.2-rc.1   # 固定版本，勿追新
```

启动（PowerShell，先注入环境变量）：

```powershell
$env:DEEPSEEK_API_KEY = 'sk-xxxx'
$env:DSH_HOME     = '<ROOT>\dsh-home'
$env:QQB_DSH_HOME = '<ROOT>\dsh-home'
node node_modules\@deepseek-ai\dsh\lib\bin.js web --port 10721 --no-open
```

验证：`Test-NetConnection 127.0.0.1 -Port 10721` 通；日志输出里出现 web token（桥要从日志解析它，见 §5）。

**沙箱差异（必读）**：Linux 版用 landlock 把 DSH 的 bash 通道关进读白名单，并打 `deploy/patches/01、02` 两个补丁。**Windows 无 landlock，这两件事都不做**。补偿措施：

- 用普通（非管理员）账户跑 DSH；账户里别存无关敏感物；
- API key 只经环境变量注入，不写进任何被 agent 可读的工作文件；
- 不把 10721/3100 端口暴露到局域网（默认绑 127.0.0.1 即可）；
- 桥启动自检（`src/core/sandbox-audit.js`）会打 `[security][P0告警]`——**在 Windows 这是预期内的**，确认其余启动行正常即可。

### 4.4 第 4 步：桥（qq-bridge，控制台 3100）

```powershell
cd <ROOT>\qq-bridge
npm ci          # better-sqlite3 在 Node 22 有 Windows 预编译；若走到源码编译，装 VS Build Tools 再重试
copy config.example.json config.json
```

**config.json 必填项**（逐项看 example 里的 `_note` 注释，这里只列字段）：

- `napcat`：`wsUrl: ws://127.0.0.1:3001`、`httpUrl: http://127.0.0.1:3000`、`accessToken` / `wsAccessToken`（与 §4.2 第 4 点两侧一致）、`launcherPath` / `homeDir` 指向你的 NapCat 目录（**JSON 里路径用正斜杠** `D:/NapCat/Shell`，已验证）。
- `dsh`：`baseUrl: http://127.0.0.1:10721`；`apiKey` 留空则走 `DEEPSEEK_API_KEY` 环境变量。
- `allow.private`：bot 要理谁的 QQ 号数组；`ownerQQ`：主人号。
- `consoleToken`：留空则首次启动自动生成到 `state/console-token`（fail-closed：3100 所有 API 都要 `x-console-token`）。
- 其余 `social.*` 开关保持 example 默认值起步，跑通后再调。

人设：把 Linux 手册 §人设占位 的 `persona.md` 最小模板放进 `qq-bridge\`（后续可热改，即时生效）。

**启动与守护（三选一，本仓库自带前两个）**：

- 前台调试：`start.bat`——循环拉起 `node src/bridge.js`，桥崩了 5 秒自动重启；打印 `bridge already running`（退出码 2）说明另一个窗口在跑，勿双开。
- 后台常驻：`wscript.exe start-hidden.vbs`——完全隐藏窗口跑 start.bat，日志落 `qq-bridge\state\bridge.log`。
- 重启桥：`restart.bat`——按命令行特征杀旧 node 进程（ASCII 匹配串，见 §故障表）、清 `state\bridge.lock`、重拉。

### 4.5 第 5 步：配置热加载认知

桥监听 `config.json`（目录监听 + 2 秒轮询），改配置**不需要重启**；改 `persona.md` / `speech-rules.md` 同样热生效。DSH 的 patch 层（`dsh-home\cordis.patch.yml`，桥在 `dshCompaction.enabled` 时自动写）由 DSH 自己热加载。

### 4.6 第 6 步：开机自启（可选）

任务计划程序 → 创建基本任务 → 触发器「登录时」→ 操作「启动程序」：`wscript.exe <ROOT>\qq-bridge\start-hidden.vbs`；再各建一条启动 NapCat 和 DSH 的（启动顺序：NapCat → DSH → 等 3 秒 → 桥；桥自身带循环守护）。或者写一个按序拉起三件套的 ps1/bat 挂任务计划，脚本内**按端口/进程判重**（照 §4.2 的教训，NapCat 按进程判）。

## 5. 验收清单（全部打勾才算完）

1. `Test-NetConnection 127.0.0.1 -Port 3000/3001/10721/3100` 四个端口全在听。
2. `state\bridge.log` 尾部依次出现：NapCat 已连（ws://127.0.0.1:3001）、DSH 就绪、preset 刷新行、（若配了早安）早安槽位在册。
3. 用另一个 QQ 号（在 `allow.private` 里）给 bot 发一句话，收到人设口径的回复。
4. 浏览器开 `http://127.0.0.1:3100/`，输入 console token 能进管理页。
5. `restart.bat` 跑一遍，桥重启后第 3 条仍复现（确认守护链没把登录态搞坏）。

## 6. 日常运维

- **看日志**：`state\bridge.log`（桥）、`dsh-web.log`（DSH）。注意**桥日志时间戳是 UTC**，本地时间要 +8。
- **改配置**：直接改 `config.json`，2 秒内热生效，日志打 `已热加载，变更字段: …`。
- **重启全套**：任务计划里那几条各跑一遍，或手敲 §4.3/§4.4 的启动命令（都有判重，不会双开——NapCat 的判重是进程名）。

## 7. 故障表（按出现频率排）

| 症状 | 原因 | 处置 |
|---|---|---|
| NapCat 反复掉线/登录态废 | 双实例互踢（扫码期端口未开导致脚本又拉起一套） | 杀掉多余 `NapCatWinBootMain`，只留一套；判重改按进程 |
| 桥退出码 2 | 另一个窗口已在跑（`bridge.lock`） | 别双开；确要换窗口先 `restart.bat` |
| `npm ci` 报 better-sqlite3 编译错 | Node 版本不匹配触发源码编译 | 确认 Node ≥22.13；或装 VS Build Tools 后重试 |
| bat/ps1 里中文匹配失效 | cmd 在 GBK 代码页下吃非 ASCII 串会静默不匹配 | 脚本开头 `chcp 65001`；匹配串一律 ASCII |
| 日志时间对不上 | 桥日志是 UTC | 本地时间 +8；做排期判断时先换算 |
| 桥起不来：DSH token 解析失败 | 桥要从 DSH 启动日志解析 web token | 保持 DSH 输出重定向到固定文件并把该路径设进 `DSH_ISOLATED_LOG_FILE` 再启桥 |
| QQ 官方更新后 NapCat 连不上 | NapCat 版本落后于 QQ 协议 | NapCat 升级到适配版，重启即用（登录态一般保留） |
| 扫码后仍显示未登录 | 扫码时多实例并存 / 二维码过期 | 见第一条；重新生成二维码再扫 |
| 防火墙弹窗 | node/NapCat 首次监听端口 | 只允许专用网络/本机即可，勿选公用网络 |
| 管理页 401 | console token 不对 | 读 `state\console-token`（fail-closed 自动生成的那份） |

## 8. 明确不在本档范围

- landlock 补丁、unshare 断网隔离、systemd 单元——Linux 专属，Windows 不做（见 §4.3 的补偿）。
- 群聊接入（本栈按设计不接群）。
- B 站自动化线、SSH 反向隧道——那是「服务器 + 本地混合」形态的组件，纯 Windows 单机部署用不到。
- 人格/角色素材的分发限制照仓库 README，不在部署档展开。

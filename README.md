# QQ 工具型 Agent（qq工具agent_20261025）

私聊工具型 agent：AI 接入 QQ 号，定位是 agent 工具而非情感陪伴。
平台层复用泠娜项目封存的 qq-bridge（Kizuna 2.0.5 系），经 2026-10-25 审计修复后裁剪。

## 与泠娜项目的关系

- 代码同源（`AbyssalQuill/Kizuna` 上游 → 泠娜服务器热改版），但**完全隔离**：
  独立目录、独立 config/state、独立 systemd 单元；泠娜封存包与其服务器残留一律未动。
- 泠娜的人格/记忆/聊天数据（实例层）全部留在封存包，本项目不含、不复用。

## 目录

| 路径 | 内容 |
|---|---|
| `qq-bridge/` | 桥端源码（git 仓库在本目录上级） |
| `deploy/config.json` | 新部署配置（**含 consoleToken，勿外传、勿入库**——已在 .gitignore） |
| `deploy/安装与接入.md` | 服务器部署：NapCat 扫码、systemd 单元 |
| `deploy/安装与接入-Windows原生.md` | Windows 原生路线：QQ NT + NapCat Shell + DSH + 桥六步安装、验收清单、故障表 |

## git 历史（版本基线，泠娜栈最缺的东西）

```
4608b2b 基线1: 上游 Kizuna 2.0.5 原版
14566ad 基线2: 服务器版覆盖（8改+4新，与审计 diff 一致）
be5ffca 补丁001-004: P0 重复消息 + P1 fail-open/原子写/原型污染
9509343 修复①: consoleToken fail-closed + 自动生成
4fa7082 修复②: mux.js 四处 config 原子写
0f7da0a 修复③: media.js SSRF 收敛进 safe-fetch
ae603e3 修复④: 纯图片/文件消息放行
a18e4e8 修复⑤: token 预算闸门（会话日+全局日）
672a6ee 方案B: console-server 内置轻量管理页（GET /）
a71218f 裁剪: 陪伴层配置禁用（companionInjects/qzoneEnabled/slang/pixiv/ritual）
7b03c4a gitignore: 测试沙箱
```

## 相对泠娜服务器版的行为变化（部署须知）

1. **控制台鉴权常开**（fail-closed）：3100 所有 API 需要 `x-console-token`（config.consoleToken
   优先，否则自动生成 `state/console-token`）。管理页 = 浏览器开 `http://127.0.0.1:3100/` 输入 token。
2. **Manager 四跳链退役**：不再部署 manager/vite；日常管理用内置页 + QQ 内 `/命令`。
3. **纯图片/文件消息放行**：只发图/文件（无文字）也会入库、唤醒（原版会静默丢弃）。
4. **预算闸门**：`social.budget.dailyGlobal` / `dailyPerConv`（默认 200 万/日全局、30 万/日会话），
   超限拒绝投递并在 QQ 提示，次日自动恢复。
   额度日边界由顶层 `dayOffsetMinutes` 决定（分钟；0=北京自然日 00:00，480=北京 08:00；
   2026-10-27 起部署配置 0——tokens 与生图统一每日北京 0 点重置）。
5. **陪伴层默认下线**（配置禁用而非删除，代码保留可重开）：
   - `social.companionInjects: false` → 班表/活动账本/事件池不进 prompt，早安晚安/日记闪回关闭
   - `social.qzoneEnabled: false` → QZone 全家下线
   - `slang.enabled: false` → 黑话学习（含夜间任务）关闭
   - pixiv 看护仅在配置了登录态时启动；工具未配 = 不启动
   - `social.deepsleep: true` → 群聊兜底静默（本部署不接群聊）
6. 测试注意：`tests/steer-merge` 等整链并行跑会出现资源竞争型失败（上游自带 flaky），
   **单跑为准**；`node tests/<file>` 逐个跑全绿。

## 测试现状（2026-10-25）

- 修复新增：`tests/budget-gate.test.js` 3 项全过
- 受影响回归：wake-trigger 19 项、no-auto-quote 7/7（补 token 后）、typing-hold 8 项、
  mid-turn-steer、at-userid-guard、reset-reply-idempotency、voice-local 全过
- 整链 `npm run check`：steer-merge 4 项 + session-silent 1 项 flaky（stash 对照证实改动前同样失败）

## 待办（部署前）

- [x] 服务器已续费至 2027-11（用户 2026-10-25 确认）
- [ ] 朋友 QQ 号进 `deploy/config.json` 的 `allow.private`
- [x] 模型拍板：DeepSeek V4.1 Flash + DSH 0.1.2-rc.1 不升级；部署手册 deploy/安装与接入.md 就绪
- [ ] bot 名字/说话风格 → persona.md（占位「小助」已写进手册)
- [ ] 新 QQ 号 NapCat 扫码
- [ ] 重写版 time.js/json-store.js 接线（26 处手算 +8 / 7 处 toLocale*，部署后第一周做）

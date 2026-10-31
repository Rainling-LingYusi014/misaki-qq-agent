# Misaki QQ Agent

私聊工具型 agent：把一个 AI agent 接进一个 QQ 号——她收发消息、调工具、交付成品，
定位是 agent 工具而非情感陪伴。

平台层基于开源项目 [Kizuna](https://github.com/AbyssalQuill/Kizuna)（MIT）深度扩展与裁剪，
经一轮完整安全审计（fail-closed 鉴权、SSRF 收敛、预算闸门、沙箱管束）后形成本仓库。

## 架构

```
QQ NT ── NapCat（协议端）── qq-bridge（本仓库：桥与编排）── DSH（模型运行时）
```

- **NapCat** 负责 QQ 协议（HTTP 3000 / WS 3001）；
- **qq-bridge** 负责一切编排：唤醒调度、气泡成形、幂等账本、工具注册、预算与风控、
  控制台（127.0.0.1:3100，fail-closed token）；
- **DSH** 是模型侧运行时（端口 10721），桥以事件流与其对接。

## 能力概览

- **100+ 工具面**：办公文档（docx/pptx/xlsx 生成与解读）、生图、YouTube / B站 / Telegram
  资源检索与交付、媒体合成（ffmpeg）、文档读取、记忆检索、subagent 外包（沙箱管束）
- **视频理解栈**：字幕轨直读（B站 AI 字幕 / YT 自动字幕）→ 服务器 ASR 兜底 → 抽帧视觉描述，
  全程「讲不出就明说，绝不编大意」
- **发送纪律**：骰子气泡（70/25/5）、幂等发送账本（同输入必同切法）、节奏与打字窗口模拟
- **治理**：token 预算闸门（全局日 + 会话日）、逐工具配额、好友额度仪表盘、手机端面板
- **运营自动化**：B站投稿管线（本地化部署时按双线路由）、空间定时点赞（四窗 ±30min 摆动）、
  好友资料卡早安点赞

## 目录

| 路径 | 内容 |
|---|---|
| `qq-bridge/` | 桥端源码（Node.js ESM；测试与检查见下方） |
| `deploy/安装与接入.md` | 服务器部署：NapCat 扫码、systemd 单元、踩坑手册 |
| `deploy/安装与接入-Windows原生.md` | Windows 原生路线：QQ NT + NapCat Shell + DSH + 桥六步安装、验收清单、故障表 |
| `deploy/patches/` | DSH npm 补丁（沙箱白名单化等，升级 DSH 后需重打） |
| `qq-bridge/persona.md` / `speech-rules.md` | 人格与发言规则（发言规则含 40+ 条定规） |

## 部署要点（相对上游的默认行为）

1. **控制台鉴权常开**（fail-closed）：3100 所有 API 需要 `x-console-token`（config.consoleToken
   优先，否则自动生成 `state/console-token`）。管理页 = 浏览器开 `http://127.0.0.1:3100/` 输入 token。
2. **预算闸门**：`social.budget.dailyGlobal` / `dailyPerConv`，超限拒绝投递并在 QQ 提示，
   额度日边界由顶层 `dayOffsetMinutes` 决定（0=北京自然日）。
3. **纯图片/文件消息放行**：只发图/文件（无文字）也会入库、唤醒。
4. **非工具面默认裁剪**（配置禁用而非删除，代码保留可重开）：陪伴层注入、群聊、黑话学习等
   各自的开关在 `config.json` 的 `social.*`，按需启用。
5. **测试**：`npm run check` 全链约 70 个测试文件；个别整链并行跑存在资源竞争型 flaky，
   以单跑 `node tests/<file>` 为准。

## License

[MIT](LICENSE) — Copyright (c) 2026 the Reiyu-Misaki-QQ-Agent contributors &
Kizuna upstream authors。

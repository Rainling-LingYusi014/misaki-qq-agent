// 模式系统 & misaki@ 指令通道（2026-10-26）
//
// 三个职责，全部保持纯函数（不读会话状态、不发网络），便于单测：
//   1. misaki@ 指令解析 —— 统一前缀 `misaki@` 的指令注册表；2026-10-27 起三模式直切
//      （misaki@standard / misaki@companion / misaki@interactive），未来加模式 = MODES 注册表加一条
//      + wake-send.js 的 [Mode] 行文案 + preset 对应规则段。
//   2. 陪伴模式参数档 —— 主动消息/打字等待/工具白名单/静默时段/无回应退避的默认值全在这里，
//      config.json 的 social.companionMode.* 可逐项覆盖（具体数值后续可调）。
//   3. 模式相关固定文案 —— 进入/退出/重复进入/未知指令提醒，改口径只动这个文件。
//
// 会话状态的读写都在 social-state.js（conversationMode / setConversationMode / companionToolBlock /
// applyMisakiCommand），本模块不 import 它——避免 companion-mode ↔ social-state 循环依赖。

import { bjMinutes, parseClockMin } from '../lib/time.js';

// ── 模式注册表 ──────────────────────────────────────────────────────────────
// 常规模式是默认模式：进入任何模式后，用该模式的 off 指令退出 → 回到常规模式。
// 目前只有两种模式，进出陪伴模式用 on/off 即可。
export const DEFAULT_MODE = 'regular';
export const MODES = [
  // 2026-10-27 主人定版：三模式直切指令（废弃 companion mode on/off）。cmd = 直切指令 token；
  // id 保持原值（'regular' 等），存量 conversationMode 状态无需迁移。
  { id: 'regular', label: '常规模式', cmd: 'standard', default: true },
  { id: 'companion', label: '陪伴模式', cmd: 'companion' },
  // 2026-10-28 主人拍板：交互模式还在内测，暂不开放——beta=true 时切换指令一律回内测提示、不切状态
  // （方案见《交互模式设计方案_20261027.md》，开放时把 beta 去掉即可）。
  { id: 'interactive', label: '交互模式', cmd: 'interactive', beta: true },
];
export function modeLabel(modeId) {
  const m = MODES.find((x) => x.id === String(modeId));
  return m ? m.label : String(modeId ?? DEFAULT_MODE);
}

// ── misaki@ 指令解析 ────────────────────────────────────────────────────────
export const MISAKI_CMD_PREFIX = 'misaki@';
// 白名单后缀：misaki@ 后紧跟这些串时按普通聊天放行（不进指令通道、不提醒）。
// misaki@ 后缀是美咲自己的域名邮箱（域名见 PASSTHROUGH_DEFAULT，真值不写进注释——开源仓同步不带走），
// 聊天中被提及不能报「指令不认识」。
const PASSTHROUGH_DEFAULT = ['ling014.com'];
// 一次性动作指令（非模式）。token 必须整条精确匹配；reset 只认原文（带标点不触发），独占气泡防误触。
// 2026-10-27 主人定版：consumption×3 合并为单条 credits；reset -1 简化为 reset（防误输入位取消），简介同步精简。
export const ACTIONS = [
  { token: 'help', kind: 'action-help', label: '查看指令列表与用法' },
  { token: 'stop', kind: 'action-stop', label: '停止当前任务' },
  { token: 'reset', kind: 'action-reset', label: '清空所有过往认知' },
  { token: 'credits', kind: 'action-credits', label: '查询今日额度用量' },
  // 2026-10-28（审查 P1-3 修复）：声音复刻的用户侧授权闸——用户本人发过这条才算授权，
  // 模型传的 consent=true 只是转述。执行在 mux.js（记账落 state/voice-consent.json）。
  { token: '确认授权', kind: 'action-voice-consent', label: '开通声音复刻授权（建音色前发一次）' },
];

/** misaki@help：指令一览（注册表自动生成，加新模式/动作自动出现）+ 用法规范（只讲规范，不举例）。
 * 2026-10-27 主人定版版式：help 置顶；模式指令行按 currentModeId 标（当前）；无（默认）标记。
 * currentModeId 省略时（纯函数直调/测试）不标（当前）。 */
export function helpText(currentModeId = null) {
  const lines = ['目前的全部指令：'];
  const help = ACTIONS.find((a) => a.kind === 'action-help');
  if (help) lines.push(`misaki@${help.token} —— ${help.label}`);
  for (const m of MODES) {
    if (!m.cmd) continue;
    const cur = currentModeId && m.id === String(currentModeId) ? '（当前）' : '';
    const beta = m.beta ? '（内测中，暂不开放）' : '';
    lines.push(`misaki@${m.cmd} —— 切换到${m.label}${beta}${cur}`);
  }
  for (const a of ACTIONS) {
    if (a.kind === 'action-help') continue;
    lines.push(`misaki@${a.token} —— ${a.label}`);
  }
  lines.push('用法：指令以 misaki@ 开头、独占一条完整消息（后面不能再跟别的内容）；忽略大小写，连续空格视为一个；结尾多打的标点会自动忽略；指令在句中提到时不算指令，按普通聊天处理；指令只在私聊生效，任何模式下都可用；打错会收到提醒，可发 misaki@help 查询全部指令；reset 不可逆，且必须一字不差（结尾带标点不会触发），发之前想清楚。');
  return lines.join('\n');
}

/** 额度显示格式：1234567 → "123.5万"，9999 → "9999"（misaki@credits 用） */
export function fmtWanTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 10000) {
    const w = Math.round(v / 1000) / 10;
    return `${Number.isInteger(w) ? w : w.toFixed(1)}万`;
  }
  return String(v);
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 解析一条私聊消息是否为 misaki@ 指令。返回：
 *   null                        —— 不以 misaki@ 开头，是普通聊天（句中提及也不触发）
 *   { kind:'passthrough' }      —— misaki@白名单后缀（如邮箱），原样放行给模型
 *   { kind:'mode-switch', mode }—— 切换到该模式（2026-10-27 三模式直切，取代 on/off）
 *   { kind:'unknown', token }   —— misaki@ 后是不认识的串 → 提醒检查输入
 * 匹配规则：忽略大小写、全角＠归一为@、合并连续空白；指令必须是 misaki@ 后的全部内容（不带尾巴）。
 * 2026-10-26 实测补充：普通指令容忍结尾标点/空白（misaki@stop。手机输入很常见，别回「没认出来」）；
 * 唯一例外 reset——主人规格是独占气泡且不允许其他字符，标点也算字符，带标点一律不触发（引用保护优先）。
 */
export function parseMisakiCommand(rawText, cfgRef = null) {
  const norm = String(rawText ?? '').replace(/＠/g, '@').trim();
  if (!norm.toLowerCase().startsWith(MISAKI_CMD_PREFIX)) return null;
  const body = norm.slice(MISAKI_CMD_PREFIX.length).trim().replace(/\s+/g, ' ').toLowerCase();
  const cfg = cfgRef?.social?.misakiCommands ?? {};
  const passthrough = Array.isArray(cfg.passthroughSuffixes) && cfg.passthroughSuffixes.length > 0
    ? cfg.passthroughSuffixes.map((s) => String(s).toLowerCase())
    : PASSTHROUGH_DEFAULT;
  for (const suf of passthrough) {
    // `ling014.com` / `ling014.com 是你的邮箱吗` 都算提及；边界断言避免 `ling014.comXxx` 误放行
    if (body === suf || new RegExp(`^${escapeRe(suf)}(?![a-z0-9._-])`).test(body)) {
      return { kind: 'passthrough', suffix: suf };
    }
  }
  // 结尾标点容错：先按原文精确匹配（reset 只走这条路），再把尾部标点剥掉匹配普通指令。
  const bodyStripped = body.replace(/[.,!?;:~、。，！？；：…～]+$/u, '');
  for (const m of MODES) {
    if (!m.cmd) continue;
    if (body === m.cmd || bodyStripped === m.cmd) return { kind: 'mode-switch', mode: m.id };
  }
  for (const a of ACTIONS) {
    if (a.kind === 'action-reset') { if (body === a.token) return { kind: a.kind, action: a.token }; continue; }
    if (body === a.token || bodyStripped === a.token) return { kind: a.kind, action: a.token };
  }
  return { kind: 'unknown', token: body.slice(0, 40) };
}

// ── 陪伴模式参数档（默认值；config.json social.companionMode.* 可覆盖） ─────
export const COMPANION_DEFAULTS = {
  // 主动消息：比常规模式（15–40min 检查、每天至多 2 次）更稀疏、更像"想起来你"
  checkIntervalMinMs: 40 * 60 * 1000,
  checkIntervalMaxMs: 90 * 60 * 1000,
  idleThresholdMs: 10 * 60 * 1000,        // 冷场阈值：对方安静 10 分钟才考虑主动
  dailyMax: 3,                            // 每日主动上限（与常规模式的 proactiveCount 分开计数）
  quietStart: '23:30',                    // 静默时段：不再"凌晨想起你"
  quietEnd: '07:30',
  unansweredWindowMs: 6 * 60 * 60 * 1000, // 主动后对方 6h 没回 = 记一次"无回应"
  unansweredStreakLimit: 2,               // 连续 2 次无回应 → 退避降档
  backoffDailyMax: 1,                     // 退避期每天至多 1 次（对方一回话立即解除）
  // 打字等待：陪伴回合绝不插话（常规模式 breakProbability=0.3，有 30% 概率抢话）
  typingHoldMaxMs: 45 * 1000,
  typingRefreshMs: 5000,
  // 工具白名单：陪伴回合只保留记忆/发送/表情包/看图（桥侧 companionToolBlock 强制）
  allowedTools: ['reply', 'sendMessage', 'markRead', 'sendSticker', 'collectSticker', 'listStickers', 'getStickerImage', 'getImages', 'memoryRemember', 'memorySearch', 'memory'],
};

export function companionCfg(cfgRef) {
  const o = cfgRef?.social?.companionMode ?? {};
  const num = (k, d) => (Number.isFinite(Number(o[k])) ? Number(o[k]) : d);
  return {
    checkIntervalMinMs: Math.max(60 * 1000, num('checkIntervalMinMs', COMPANION_DEFAULTS.checkIntervalMinMs)),
    checkIntervalMaxMs: Math.max(60 * 1000, num('checkIntervalMaxMs', COMPANION_DEFAULTS.checkIntervalMaxMs)),
    idleThresholdMs: Math.max(60 * 1000, num('idleThresholdMs', COMPANION_DEFAULTS.idleThresholdMs)),
    dailyMax: Math.max(0, num('dailyMax', COMPANION_DEFAULTS.dailyMax)),
    quietStart: String(o.quietStart ?? COMPANION_DEFAULTS.quietStart),
    quietEnd: String(o.quietEnd ?? COMPANION_DEFAULTS.quietEnd),
    unansweredWindowMs: Math.max(60 * 1000, num('unansweredWindowMs', COMPANION_DEFAULTS.unansweredWindowMs)),
    unansweredStreakLimit: Math.max(1, num('unansweredStreakLimit', COMPANION_DEFAULTS.unansweredStreakLimit)),
    backoffDailyMax: Math.max(0, num('backoffDailyMax', COMPANION_DEFAULTS.backoffDailyMax)),
    typingHoldMaxMs: Math.max(5000, num('typingHoldMaxMs', COMPANION_DEFAULTS.typingHoldMaxMs)),
    typingRefreshMs: Math.max(0, num('typingRefreshMs', COMPANION_DEFAULTS.typingRefreshMs)),
    allowedTools: Array.isArray(o.allowedTools) ? o.allowedTools.map(String) : COMPANION_DEFAULTS.allowedTools.slice(),
  };
}

/** 陪伴模式静默时段（北京时间，默认 23:30–07:30，支持跨午夜）：期间不主动关心。 */
export function inCompanionQuietHours(nowMs = Date.now(), cfgRef = null) {
  const cp = companionCfg(cfgRef);
  const start = parseClockMin(cp.quietStart);
  const end = parseClockMin(cp.quietEnd);
  if (start == null || end == null) return false;
  const now = bjMinutes(nowMs);
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // 跨午夜 wrap
}

/** 陪伴模式打字等待覆盖：绝不插话 + 更长等待窗。产物直接传给 typingHoldDecision 的 cfg。 */
export function companionTypingDecisionCfg(cfgRef) {
  const cp = companionCfg(cfgRef);
  return {
    ...(cfgRef ?? {}),
    social: {
      ...(cfgRef?.social ?? {}),
      typing: { enabled: true, holdMaxMs: cp.typingHoldMaxMs, refreshOnMessageMs: cp.typingRefreshMs, breakProbability: 0 },
    },
  };
}

/** 陪伴模式下任务类工具的拒绝话术（纯函数）。 */
export function companionToolRefusal(flag, cfgRef) {
  const cp = companionCfg(cfgRef);
  return cp.allowedTools.includes(String(flag))
    ? null
    : '陪伴模式下该工具不可用（记忆/回复/表情包/看图可用）。对方需要任务类帮助时，建议对方发 misaki@standard 切回常规模式后再做。';
}

// ── 固定文案（桥层直发，零 token；要改口径只动这里） ────────────────────────
// 2026-10-27 三模式直切：切换回执按目标模式取；目标=当前模式时统一回「当前已处于X模式。」（主人定版句式）。
export const COMPANION_ENTER_TEXT = '好呀。那从现在起，我只做一件事——陪着你。想说就说，不想说我也在。想切换的时候发 misaki@standard 就好，我不会多问。';
export const STANDARD_ENTER_TEXT = '嗯，已经切回常规模式了——之后想聊的、要跑的任务，随时叫我。';
export const INTERACTIVE_ENTER_TEXT = '好，已经切到交互模式了。想换模式随时发 misaki@standard 或 misaki@companion。';
export function enterModeText(modeId) {
  if (modeId === 'companion') return COMPANION_ENTER_TEXT;
  if (modeId === 'interactive') return INTERACTIVE_ENTER_TEXT;
  return STANDARD_ENTER_TEXT;
}
export function alreadyInModeText(modeId) {
  return `当前已处于${modeLabel(modeId)}。`;
}
/** 2026-10-28 主人拍板：beta 模式（interactive）的切换一律回这句，不切状态。 */
export function modeBetaText(modeId) {
  return `${modeLabel(modeId)}还在内测中，暂时不开放～先用着常规模式和陪伴模式吧。`;
}
// misaki@stop：桥层即时回执；「已经被停止」的另行说明由下一条 [Stopped] 唤醒注入完成（见 stopNoteLine）。
export const STOP_ACK_TEXT = '好，停了。';
export const NOTHING_TO_STOP_TEXT = '现在没有在跑的活。';
// misaki@reset：还原到"没认识过"。文案必须诚实：已发出的消息还在对方聊天框里，删的是"我这边的一切"。
export const RESET_DONE_TEXT = '好。你这个人在我这里的记忆已经全部清掉了——对话、记住的事、档案，都回到刚认识的样子。之前发出去的消息还在你的聊天框里，但那些内容我不再记得了。';

export function unknownCommandText(token = '') {
  // 2026-10-27 主人定版：不再罗列全部指令，只回显打错的串并指向 misaki@help（回显用归一化后的 body）。
  const lines = [`未知指令[misaki@${token}]，请检查输入。可使用misaki@help查询可用的指令。`];
  // 2026-10-26：reset 带标点是高频误触发形态——专门提醒它必须一字不差独占气泡。
  if (String(token).toLowerCase().startsWith('reset')) {
    lines.push('注意：reset 必须一字不差、独占一个气泡，结尾带任何标点都不会触发。');
  }
  return lines.join('\n');
}

// [Stopped] 唤醒注入行（stop 的"另行说明已经被停止"）：她自己在下一轮用人设口吻说明任务已被叫停。
export function stopNoteLine(atMs) {
  const min = Math.max(1, Math.round((Date.now() - Number(atMs) || 60000) / 60000));
  return `[Stopped] 上一轮任务在 ${min} 分钟前被对方用 misaki@stop 主动终止（桥已即时回执"好，停了"）。本轮用自己的话自然说明"任务已按你的要求停止"即可——已经发出去的部分结果仍在聊天里；绝不要继续执行被停的任务，也不要反过来追问"停的是什么"。`;
}

// [ModeChanged] 唤醒注入行（2026-10-26 实测事故后加）：桥替她切模式时她毫无感知——
// 桥的固定回执（好呀/嗯，陪你到这儿）只有对方看得到，实测她据此否认退场回执、自称
// 「还在陪伴模式」并反索一次指令。此行让她下一轮立即对齐，与 [Stopped] 同构（一次性）。
export function modeChangedNoteLine(atMs, modeId) {
  const min = Math.max(1, Math.round((Date.now() - Number(atMs) || 60000) / 60000));
  return `[ModeChanged] ${min} 分钟前，对方发指令把模式切到了「${modeLabel(modeId)}」（桥已直接回执，不需要你再说一遍）。立即以此行更新你对当前模式的认知，之后按新模式行事；绝不要再说与 [Mode]/本行矛盾的模式状态，也不要追问或复述这次切换。`;
}

// [Mode] 唤醒注入行（仅私聊注入，见 wake-send.js）：她必须永远知道自己处于哪个模式——
// 被问到「现在是什么模式/怎么退出」时答得出、给得出指令原文，杜绝「进得去出不来」。
export function modeLineForWake(modeId) {
  if (modeId === 'companion') {
    return '[Mode] 陪伴模式：本回合遵循 preset [COMPANION] 全部规则（接住情绪、等完整表达、不站队不裁决、倾听为主）；可用工具仅限记忆/回复/表情包/看图。对方问起当前模式时如实回答并给出切换指令：misaki@standard（常规）/ misaki@interactive（交互）。\n';
  }
  if (modeId === 'interactive') {
    // 2026-10-27：交互模式已可切换；行为规则段（对应 preset [INTERACTIVE]）尚未定义，当前按常规模式规则行事。
    return '[Mode] 交互模式：该模式暂无特殊规则段，本回合按常规模式的全部规则行事。对方问起当前模式时如实回答并给出切换指令：misaki@standard（常规）/ misaki@companion（陪伴）。\n';
  }
  return '[Mode] 常规模式（默认）。可切换：misaki@companion（陪伴模式）、misaki@interactive（交互模式）。对方问起模式状态时如实回答并给出指令原文。\n';
}

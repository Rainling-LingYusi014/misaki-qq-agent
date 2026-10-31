// activity-ledger.js — 她的动作账本（2026-10-16）
// 目的：解决「1 分钟前刚说面下锅，下一句就说吃完了」——每轮唤醒独立生成，模型不会
// 自觉对时间线。本模块在她**已成功发出**的文本里匹配动作声明，记进 state/activity.json，
// 并在每轮唤醒注入一行 [Doing]：「刚刚（HH:MM）你说『面下锅』——还没好，提它别提前说做完」。
// 与 shift-roster 同一哲学：shift 管日级（今天上不上班），本模块管分钟级（事情进行到哪）。
// 设计约束：任何异常退化为空串/不记账，绝不阻塞发送与唤醒；宁可漏记，不可误记。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtBeijing } from '../lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, '..', '..', 'state', 'activity.json');

// 动作字典：正则（命中=她声明了这个动作）→ 类目 / 展示名 / 大致完成耗时（分钟）。
// 白名单从窄：只收她生活里高频且耗时明确的动作。
const RULES = [
  { cat: 'cook',   re: /(煮|下)点?面|面下锅|煮点?(东西|饭)|做(个)?饭|炒(个)?菜/, label: '做饭', doneMin: 15 },
  { cat: 'eat',    re: /吃(饭|面|东西)|开(饭|吃)|动筷|点(了)?外卖/,               label: '吃饭', doneMin: 20 },
  { cat: 'shower', re: /洗澡|冲凉/,                                               label: '洗澡', doneMin: 25 },
  { cat: 'wash',   re: /洗(衣服|衣物)|晾衣服/,                                    label: '洗衣服', doneMin: 40 },
  { cat: 'dishes', re: /洗碗/,                                                    label: '洗碗', doneMin: 10 },
  { cat: 'clean',  re: /打扫|收拾(屋子|房间)|拖地/,                               label: '收拾屋子', doneMin: 30 },
];

const STALE_MIN = 45; // 完成后再过这么久就从账本里消失

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    if (j && Array.isArray(j.entries)) return j;
  } catch { /* 首次或损坏都重来 */ }
  return { entries: [] };
}

function save(j) {
  try { fs.writeFileSync(LEDGER_PATH, JSON.stringify(j, null, 2)); } catch { /* 写失败退化为无注入 */ }
}

/**
 * 她的一条文本已成功发出（含"送达未确认"）后调用。命中动作声明就记账，
 * 同类目只留最新一条；已完成且过了 STALE 的旧记录顺手清掉。
 */
export function recordFromOutbound(text, nowMs = Date.now()) {
  const t = String(text || '');
  if (!t || t.length > 500) return;              // 过长的大概率是卡片/长文，不扫
  if (/^\[引用|\[转发/.test(t)) return;          // 引用/转发开头不扫，避免把别人的话记成她的动作
  const now = Number(nowMs) || Date.now();
  const hits = [];
  for (const r of RULES) {
    const m = r.re.exec(t);
    if (!m) continue;
    // 否定句不记：他没吃饭/还没洗 之类（「还没吃饭」≠ 在吃饭）
    const pre = t.slice(Math.max(0, m.index - 2), m.index);
    if (/[没别不未]/.test(pre)) continue;
    hits.push({ cat: r.cat, label: r.label, doneMin: r.doneMin, claim: m[0], at: now });
  }
  if (!hits.length) return;
  const st = load();
  st.entries = st.entries.filter((e) => now - e.at < (e.doneMin + STALE_MIN) * 60000 && !hits.some((h) => h.cat === e.cat));
  st.entries.push(...hits);
  st.entries = st.entries.slice(-4);             // 账本只留最近几条
  save(st);
}

/** 每轮唤醒注入的一行 [Doing]；无事可报返回空串。 */
export function doingNowLine(nowMs = Date.now()) {
  try {
    const now = Number(nowMs) || Date.now();
    const st = load();
    const lines = [];
    for (const e of st.entries) {
      const min = Math.floor((now - e.at) / 60000);
      if (min < 0) continue;
      const at = fmtBeijing(e.at).slice(-5);     // HH:mm
      if (min < e.doneMin) {
        lines.push(`${min <= 0 ? '刚刚' : min + '分钟前'}（${at}）你说「${e.claim}」——${e.label}还没到完成时间（一般约${e.doneMin}分钟），提它别提前说做完了`);
      } else if (min < e.doneMin + STALE_MIN) {
        lines.push(`${e.label}按时间算应该已经完成了（${at}说的）`);
      }
    }
    if (!lines.length) return '';
    return '[Doing] ' + lines.join('；') + '\n';
  } catch {
    return '';
  }
}

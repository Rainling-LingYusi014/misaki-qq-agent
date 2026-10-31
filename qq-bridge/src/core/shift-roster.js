// shift-roster.js — 她的排班状态层（2026-10-15）
// 目的：解决「被问在做什么永远在家躺」——persona 是便利店两班倒晚班多，
// 但没有任何机制告诉模型「今天上不上班、现在在不在店里」，于是每轮独立生成时
// 总是滑向阻力最小的「躺着」。本模块生成并持久化一份排班表，每轮唤醒注入一行
// [Shift]，让「我在做什么」有可对账的事实来源（时间线不矛盾）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROSTER_PATH = path.join(__dirname, '..', '..', 'state', 'shift-roster.json');

const SHIFTS = {
  early: { label: '早班', start: 8, end: 16 },
  late: { label: '晚班', start: 15, end: 23 },
  off: { label: '休', start: -1, end: -1 },
};
// 晚班多（persona：晚班排得多）——权重 早2 : 晚4 : 休1
const POOL = ['early', 'early', 'late', 'late', 'late', 'late', 'off'];

function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); } // UTC+8
function bjDateStr(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function loadRoster() {
  try {
    const j = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
    if (j && j.days && typeof j.days === 'object') return j;
  } catch { /* 首次或损坏都重新生成 */ }
  return null;
}

function saveRoster(j) {
  try { fs.writeFileSync(ROSTER_PATH, JSON.stringify(j, null, 2)); } catch { /* 写失败就退化为无注入 */ }
}

function generateFrom(startMs, keep) {
  const days = {};
  if (keep && keep.days) {
    // 保留旧表中「未来」的日子，避免同一周内已说出口的排班被打脸
    const today = bjDateStr(new Date(startMs + 8 * 3600 * 1000));
    for (const [k, v] of Object.entries(keep.days)) if (k >= today) days[k] = v;
  }
  const d = new Date(startMs);
  let offRun = 0, workRun = 0;
  for (let i = 0; i < 10; i++) { // 今天起 10 天，覆盖一周且防边界
    let s = 'off';
    for (let tries = 0; tries < 8; tries++) {
      s = POOL[Math.floor(Math.random() * POOL.length)];
      if (s === 'off' && offRun >= 2) continue; // 连休≤2
      if (s !== 'off' && workRun >= 5) continue; // 连班≤5
      break;
    }
    days[bjDateStr(d)] = s;
    offRun = s === 'off' ? offRun + 1 : 0;
    workRun = s !== 'off' ? workRun + 1 : 0;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { generatedAt: Date.now(), days };
}

// 返回一行 [Shift]（含当日状态与行为指引）；任何异常都退化为空串，绝不阻塞唤醒。
export function shiftNowLine() {
  try {
    const now = beijingNow();
    const today = bjDateStr(now);
    let roster = loadRoster();
    if (!roster || !roster.days || !roster.days[today]) {
      roster = generateFrom(Date.now(), roster);
      saveRoster(roster);
    }
    const s = roster.days[today] || 'off';
    const h = now.getUTCHours();
    const sh = SHIFTS[s] || SHIFTS.off;
    let state;
    if (s === 'off') {
      state = '今天休，不在班上';
    } else if (h >= sh.start && h < sh.end) {
      state = '现在正上' + sh.label + ' ' + String(sh.start).padStart(2, '0') + ':00-' + sh.end + ':00，人在店里';
    } else if (h >= sh.end) {
      state = '今天' + sh.label + '已下班';
    } else {
      state = '今天' + sh.label + ' ' + String(sh.start).padStart(2, '0') + ':00-' + sh.end + ':00，还没到点';
    }
    return '[Shift] ' + state + '。被问「在做什么/在忙吗」按这个答，不临场编排班；上班中=在店里（看店、理货、收银间隙回消息，可以说在忙）\n';
  } catch {
    return '';
  }
}

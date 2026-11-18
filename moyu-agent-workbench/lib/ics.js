'use strict';

/**
 * ICS（iCalendar / RFC 5545）能力层（P5）
 *
 * 为什么是 ICS：这是"从教务系统拿课表"最合规的路径——
 * 学生自己在教务系统/手机日历里导出 .ics，本工具只解析文件，
 * 不登录、不抓取、不接触账号密码。
 *
 * 支持范围（够用且可验证，不假装支持全部 RFC）：
 *  - 行折叠（CRLF + 空格/Tab 续行）、CRLF/LF 混排；
 *  - VEVENT 的 SUMMARY / LOCATION / DESCRIPTION / DTSTART / DTEND / RRULE；
 *  - RRULE 仅 WEEKLY：COUNT / UNTIL / INTERVAL / BYDAY（多天）；
 *  - 时间→节次映射（按作息表，允许 ±10 分钟容差）；
 *  - 导出：按周次步长生成 RRULE，不规则的周次拆成多个 VEVENT，附 10 分钟提醒。
 *
 * 明确不支持（返回 warning 而不是静默丢弃或猜）：
 *  - 非 WEEKLY 的重复规则、全天事件、EXDATE 例外、UTC↔本地时区换算。
 */

const WEEKDAY_CODES = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
const MAX_WEEKS = 30;

// ---------- 基础 ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function addMinutes(d, n) { return new Date(d.getTime() + n * 60000); }
function isoDay(d) { return d.getDay() === 0 ? 7 : d.getDay(); }
function timeToMin(t) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function daysBetween(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}
function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

// ---------- 解析 ----------
/** 反转义文本值（\\n、\\,、\\;、\\\\） */
function unescapeText(v) {
  return String(v == null ? '' : v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIcsDate(value, params = {}) {
  const v = String(value || '').trim();
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (dt) {
    return {
      date: new Date(Number(dt[1]), Number(dt[2]) - 1, Number(dt[3]), Number(dt[4]), Number(dt[5]), Number(dt[6] || 0)),
      utc: Boolean(dt[7]), allDay: false,
    };
  }
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d) return { date: new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])), utc: false, allDay: true };
  return null;
}

function parseRRule(value, warnings, label) {
  const map = {};
  String(value || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) map[p.slice(0, i).toUpperCase()] = p.slice(i + 1);
  });
  const freq = String(map.FREQ || '').toUpperCase();
  if (freq !== 'WEEKLY') {
    warnings.push(`事件「${label}」的重复规则 FREQ=${freq || '未指定'} 暂不支持（仅支持 WEEKLY），已跳过`);
    return { freq, supported: false };
  }
  const untilParsed = map.UNTIL ? parseIcsDate(map.UNTIL) : null;
  const byday = map.BYDAY
    ? map.BYDAY.split(',').map((x) => WEEKDAY_CODES[x.trim().toUpperCase().slice(-2)]).filter(Boolean)
    : null;
  return {
    freq, supported: true,
    interval: Math.max(1, Number(map.INTERVAL) || 1),
    count: map.COUNT ? Math.max(1, Number(map.COUNT)) : null,
    until: untilParsed ? dateOnly(untilParsed.date) : null,
    byday: byday && byday.length ? [...new Set(byday)] : null,
  };
}

/**
 * 解析 ICS 文本 → 事件数组。
 * 同一属性只取第一次出现（足够覆盖常见导出），多值属性（如 EXDATE）忽略并提示。
 */
function parseIcs(text) {
  const warnings = [];
  const raw = String(text || '').replace(/^\uFEFF/, '');
  // RFC 5545 折叠：CRLF 后紧跟空格/Tab 表示续行
  const unfolded = raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;

  for (const line of lines) {
    const t = line.trim();
    if (/^BEGIN:VEVENT$/i.test(t)) { cur = {}; continue; }
    if (/^END:VEVENT$/i.test(t)) { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const parts = left.split(';');
    const name = parts.shift().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(cur, name)) continue; // 取第一次
    cur[name] = { value, params: parts.reduce((acc, p) => { const i = p.indexOf('='); if (i > 0) acc[p.slice(0, i).toUpperCase()] = p.slice(i + 1); return acc; }, {}) };
  }

  const out = [];
  for (const e of events) {
    const label = e.SUMMARY ? unescapeText(e.SUMMARY.value).slice(0, 40) : '未命名';
    const dtstart = e.DTSTART ? parseIcsDate(e.DTSTART.value, e.DTSTART.params) : null;
    const dtend = e.DTEND ? parseIcsDate(e.DTEND.value, e.DTEND.params) : null;
    if (!dtstart) { warnings.push(`事件「${label}」缺少可解析的 DTSTART，已跳过`); continue; }
    if (dtstart.utc) warnings.push(`事件「${label}」使用 UTC 时间，已按字面本地时刻处理（未做时区换算）`);
    if (dtstart.allDay) { warnings.push(`事件「${label}」是全天事件，无法映射到节次，已跳过`); continue; }
    out.push({
      summary: e.SUMMARY ? unescapeText(e.SUMMARY.value).trim() : '',
      location: e.LOCATION ? unescapeText(e.LOCATION.value).trim() : '',
      description: e.DESCRIPTION ? unescapeText(e.DESCRIPTION.value).trim() : '',
      uid: e.UID ? String(e.UID.value).trim() : '',
      dtstart,
      dtend,
      rrule: e.RRULE ? parseRRule(e.RRULE.value, warnings, label) : null,
    });
  }
  return { events: out, warnings };
}

// ---------- 时间 → 节次 ----------
function findPeriod(periods, minutes, tolerance = 10) {
  for (const p of periods) {
    const s = timeToMin(p.start), e = timeToMin(p.end);
    if (s == null || e == null) continue;
    if (minutes >= s && minutes < e) return p.period;
  }
  let best = null, bestDiff = Infinity;
  for (const p of periods) {
    const s = timeToMin(p.start);
    if (s == null) continue;
    const diff = Math.abs(s - minutes);
    if (diff <= tolerance && diff < bestDiff) { best = p.period; bestDiff = diff; }
  }
  return best;
}

/** 把周次数组压缩成表达式（1-16 / 1-15单 / 1-3,5） */
function compressWeeks(list) {
  const w = [...new Set(list.filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  if (!w.length) return '';
  if (w.length >= 2) {
    const step2 = w.every((x, i) => i === 0 || x - w[i - 1] === 2);
    const allOdd = w.every((x) => x % 2 === 1);
    const allEven = w.every((x) => x % 2 === 0);
    if (step2 && (allOdd || allEven)) return `${w[0]}-${w[w.length - 1]}${allOdd ? '单' : '双'}`;
  }
  const runs = [];
  let s = w[0], p = w[0];
  for (let i = 1; i < w.length; i++) {
    if (w[i] === p + 1) { p = w[i]; continue; }
    runs.push([s, p]); s = w[i]; p = w[i];
  }
  runs.push([s, p]);
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',');
}

function extractTeacher(description) {
  const m = /(?:教师|老师|任课教师|授课教师)\s*[:：]\s*([^\n;；,，]{1,20})/.exec(String(description || ''));
  return m ? m[1].trim() : '';
}

function expandOccurrences(ev, maxWeeks) {
  const start = ev.dtstart.date;
  const durationMin = ev.dtend && ev.dtend.date > start
    ? Math.max(1, Math.round((ev.dtend.date - start) / 60000))
    : 45;
  if (!ev.rrule || !ev.rrule.supported) return [{ start, end: addMinutes(start, durationMin) }];

  const { interval, count, until, byday } = ev.rrule;
  const days = byday && byday.length ? byday : [isoDay(start)];
  const out = [];
  let produced = 0;
  for (let i = 0; i < maxWeeks; i++) {
    // 关键：基准日必须保留开课时刻，不能先 dateOnly 再回填（会把 08:00 清成 00:00）
    const base = addDays(start, i * 7 * interval);
    if (until && dateOnly(base) > until) break;
    const monday = addDays(base, -(isoDay(base) - 1));
    for (const d of days) {
      const date = addDays(monday, d - 1);
      if (dateOnly(date) < dateOnly(start)) continue;
      if (until && dateOnly(date) > until) continue;
      if (count != null && produced >= count) break;
      out.push({ start: date, end: addMinutes(date, durationMin) });
      produced++;
    }
    if (count != null && produced >= count) break;
  }
  return out;
}

/**
 * 事件 → 课程（按"名称+星期+节次+地点+教师"合并周次）。
 * 需要 term（开学日期/总周数）把日期换算成教学周。
 */
function eventsToCourses(events, { term, periods, maxWeeks = MAX_WEEKS } = {}) {
  const errors = [];
  const warnings = [];
  const groups = new Map();
  const termStart = term && parseIsoDate(term.startDate);
  if (!termStart) return { courses: [], errors: ['缺少有效学期开学日期，无法把日期换算成周次'], warnings };
  const totalWeeks = Math.max(1, Math.min(MAX_WEEKS, Number(term.totalWeeks) || 20));

  for (const ev of events) {
    const label = ev.summary || '未命名';
    // 不支持的重复规则只取首场会制造假课表，直接跳过（解析阶段已给出 warning）
    if (ev.rrule && !ev.rrule.supported) continue;
    const occ = expandOccurrences(ev, maxWeeks);
    if (!occ.length) { warnings.push(`事件「${label}」没有可用场次，已跳过`); continue; }
    for (const o of occ) {
      const week = Math.floor(daysBetween(termStart, dateOnly(o.start)) / 7) + 1;
      if (week < 1 || week > totalWeeks) continue; // 学期外场次静默跳过，最后统一提示
      const sm = o.start.getHours() * 60 + o.start.getMinutes();
      const em = o.end.getHours() * 60 + o.end.getMinutes();
      const sp = findPeriod(periods, sm);
      const ep = findPeriod(periods, Math.max(sm, em - 1)) || sp;
      if (!sp) { errors.push(`事件「${label}」开始时间 ${pad2(o.start.getHours())}:${pad2(o.start.getMinutes())} 不在任何节次内（课间或作息不匹配）`); break; }
      if (ep < sp) { errors.push(`事件「${label}」结束时间早于开始节次，请检查作息表`); break; }
      const day = isoDay(o.start);
      const teacher = extractTeacher(ev.description);
      const location = ev.location || '';
      const key = [label, day, sp, ep, location, teacher].join('|');
      if (!groups.has(key)) {
        groups.set(key, { name: label, day, startPeriod: sp, endPeriod: ep, location, teacher, note: ev.description ? ev.description.slice(0, 120) : '', weeks: new Set() });
      }
      groups.get(key).weeks.add(week);
    }
  }

  const courses = [];
  for (const g of groups.values()) {
    const weeks = compressWeeks([...g.weeks]);
    if (!weeks) continue;
    courses.push({
      name: g.name.slice(0, 60), day: g.day, startPeriod: g.startPeriod, endPeriod: g.endPeriod,
      location: g.location.slice(0, 40), teacher: g.teacher.slice(0, 40), weeks,
      note: g.note,
    });
  }
  if (!courses.length && !errors.length) warnings.push('没有事件落在当前学期周次范围内，未生成课程');
  return { courses, errors: [...new Set(errors)], warnings };
}

// ---------- 生成 ----------
function escapeText(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
function fmtLocal(date, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}T${pad2(h)}${pad2(m)}00`;
}
function utcStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}
/** 按 75 字节折行（RFC 5545），中文按 UTF-8 字节计 */
function fold(line) {
  const s = String(line);
  if (Buffer.byteLength(s, 'utf8') <= 74) return s;
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  if (cur) out.push(cur);
  return out.join('\r\n');
}
/** 把周次切成可表达的等差段（步长 1 或 2） */
function weekRuns(weeks) {
  const w = [...new Set(weeks)].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < w.length) {
    let step = 1;
    if (i + 1 < w.length && w[i + 1] - w[i] === 2 && (i + 2 >= w.length || w[i + 2] - w[i + 1] === 2)) step = 2;
    let j = i;
    while (j + 1 < w.length && w[j + 1] - w[j] === step) j++;
    out.push({ start: w[i], step, count: j - i + 1 });
    i = j + 1;
  }
  return out;
}

/**
 * 课表 → ICS 文本。无学期（缺日期）时抛错，不生成不可用的日历。
 * 每个课程段附 10 分钟前提醒；不规则的周次拆成多个 VEVENT 以保证正确。
 */
function buildIcs(data, { periods, now = new Date() } = {}) {
  const term = data && data.term;
  if (!term || !parseIsoDate(term.startDate)) {
    const err = new Error('设置学期（开学日期）后才能导出日历');
    err.code = 'TIMETABLE_TERM_REQUIRED';
    throw err;
  }
  const start = parseIsoDate(term.startDate);
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Moyu Agent Workbench//Timetable//CN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:摸鱼课表',
  ];
  let count = 0;
  for (const c of data.courses || []) {
    const weeks = String(c.weeks || '').split(/[,，、;；\s]+/).filter(Boolean).flatMap((tok) => {
      const m = /^(\d{1,2})(?:[-~](\d{1,2}))?(单|双)?$/.exec(tok);
      if (!m) return [];
      const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
      const parity = m[3];
      const out = [];
      for (let i = a; i <= b; i++) {
        if (parity === '单' && i % 2 === 0) continue;
        if (parity === '双' && i % 2 === 1) continue;
        out.push(i);
      }
      return out;
    });
    if (!weeks.length) continue;
    const sp = periods[Number(c.startPeriod) - 1];
    const ep = periods[Number(c.endPeriod) - 1];
    if (!sp || !ep) continue;
    for (const run of weekRuns(weeks)) {
      const date = addDays(start, (run.start - 1) * 7 + (Number(c.day) - 1));
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${c.id}-${run.start}@moyu-workbench`);
      lines.push(`DTSTAMP:${stamp}`);
      lines.push(`DTSTART:${fmtLocal(date, sp.start)}`);
      lines.push(`DTEND:${fmtLocal(date, ep.end)}`);
      if (run.count > 1) lines.push(`RRULE:FREQ=WEEKLY;${run.step === 2 ? 'INTERVAL=2;' : ''}COUNT=${run.count}`);
      lines.push(`SUMMARY:${escapeText(c.name)}`);
      if (c.location) lines.push(`LOCATION:${escapeText(c.location)}`);
      const desc = [c.teacher ? `教师：${c.teacher}` : '', `周次：${c.weeks}`, c.note || ''].filter(Boolean).join('\n');
      if (desc) lines.push(`DESCRIPTION:${escapeText(desc)}`);
      lines.push('BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(c.name + ' 10 分钟后开始')}`, 'END:VALARM');
      lines.push('END:VEVENT');
      count++;
    }
  }
  lines.push('END:VCALENDAR');
  return { ics: lines.map(fold).join('\r\n') + '\r\n', events: count };
}

module.exports = {
  parseIcs, eventsToCourses, buildIcs,
  compressWeeks, weekRuns, findPeriod, parseIcsDate, parseRRule,
  MAX_WEEKS,
};

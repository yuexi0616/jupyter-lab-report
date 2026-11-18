'use strict';

/**
 * 课程表能力层（P4）
 *
 * 定位：学生的"学期时间底座"——把课表、周次、当前/下节课、连续空闲时段
 * 变成可查询的本地事实，供刷课/作业等版块判断"什么时候有空、什么时候在上课"。
 *
 * 边界（与项目诚实声明一致）：
 *  - 纯本地手动录入 / JSON 批量导入，**不登录教务系统、不爬取、不代抢课**；
 *  - 只读判断，不修改任何学校系统数据；
 *  - 数据落在 data/timetable.json（可用 MOYU_TIMETABLE_FILE 覆盖），属个人数据，不应提交。
 *
 * 关键正确性约束：
 *  - 周次表达式（1-16 / 1-16单 / 2-16双 / 1,3,5）必须可解析，解析失败明确报错；
 *  - 同一天、节次重叠、且周次有交集 → 判定冲突，默认拒绝写入（force 可强制并留痕）；
 *  - 所有时间计算接受 now 注入，保证可测试、不依赖系统时区以外的隐式状态。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ics = require('./ics');

const DATA_FILE = process.env.MOYU_TIMETABLE_FILE
  ? path.resolve(process.env.MOYU_TIMETABLE_FILE)
  : path.join(__dirname, '..', 'data', 'timetable.json');

const MAX_COURSES = 200;
const MAX_WEEKS = 30;
const MAX_PERIODS = 20;
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 默认作息（可在学期设置里整体覆盖）
const DEFAULT_PERIODS = Object.freeze([
  { period: 1, start: '08:00', end: '08:45' },
  { period: 2, start: '08:55', end: '09:40' },
  { period: 3, start: '10:00', end: '10:45' },
  { period: 4, start: '10:55', end: '11:40' },
  { period: 5, start: '14:00', end: '14:45' },
  { period: 6, start: '14:55', end: '15:40' },
  { period: 7, start: '16:00', end: '16:45' },
  { period: 8, start: '16:55', end: '17:40' },
  { period: 9, start: '19:00', end: '19:45' },
  { period: 10, start: '19:55', end: '20:40' },
  { period: 11, start: '20:50', end: '21:35' },
  { period: 12, start: '21:45', end: '22:30' },
]);

// ---------- 基础工具 ----------
function fail(message, code = 'TIMETABLE_INVALID', extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}
function str(v, max) {
  return String(v == null ? '' : v)
    // 去掉控制字符，避免导出/渲染时破坏结构
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 反向校验，拒绝 2026-02-31 这类"看起来合法"的日期
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}
function timeToMin(t) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function minToTime(min) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function isoDay(d) { return d.getDay() === 0 ? 7 : d.getDay(); } // 1=周一 … 7=周日

// ---------- 周次表达式 ----------
/**
 * 解析周次表达式，返回升序去重的周次数组。
 * 支持：1-16、1-16单、2-16双、1,3,5-9、1-16odd/even。
 */
function parseWeeks(expr) {
  const raw = String(expr == null ? '' : expr).trim();
  if (!raw) throw fail('周次不能为空（示例：1-16 / 1-16单 / 2-16双 / 1,3,5）');
  const tokens = raw.split(/[,，、;；\s]+/).filter(Boolean);
  const set = new Set();
  for (const t of tokens) {
    const m = /^(\d{1,2})(?:\s*[-~至]\s*(\d{1,2}))?(单|双|odd|even)?$/i.exec(t);
    if (!m) throw fail(`无法解析周次片段「${t}」（支持 1-16、1-16单、2-16双、1,3,5）`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b > MAX_WEEKS || a > b) {
      throw fail(`周次范围「${t}」非法（需 1-${MAX_WEEKS} 且起始不大于结束）`);
    }
    const suffix = (m[3] || '').toLowerCase();
    const parity = suffix === '单' || suffix === 'odd' ? 'odd' : (suffix === '双' || suffix === 'even' ? 'even' : null);
    for (let i = a; i <= b; i++) {
      if (parity === 'odd' && i % 2 === 0) continue;
      if (parity === 'even' && i % 2 === 1) continue;
      set.add(i);
    }
  }
  if (!set.size) throw fail(`周次「${raw}」解析结果为空（单/双周条件过滤掉了全部周次）`);
  return [...set].sort((x, y) => x - y);
}

// ---------- 存储 ----------
function defaultState() {
  return { version: 1, term: null, courses: [], demo: false, updatedAt: null };
}
function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function read() {
  if (!fs.existsSync(DATA_FILE)) return defaultState();
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.courses)) throw new Error('结构不符');
    return { ...defaultState(), ...data, courses: data.courses };
  } catch (e) {
    throw fail(`课表文件损坏或结构不符：${e.message}（请修复或删除 ${DATA_FILE} 后重试）`, 'TIMETABLE_CORRUPT');
  }
}
/** 原子写：先写临时文件再 rename，避免写一半崩溃留下坏 JSON */
function save(data) {
  ensureDir();
  const out = { ...data, version: 1, updatedAt: new Date().toISOString() };
  const tmp = DATA_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  return out;
}

// ---------- 节次 ----------
function normalizePeriods(input) {
  if (!Array.isArray(input) || !input.length) return DEFAULT_PERIODS.map((p) => ({ ...p }));
  if (input.length > MAX_PERIODS) throw fail(`节次最多 ${MAX_PERIODS} 节`);
  let prevEnd = -1;
  return input.map((raw, i) => {
    const period = i + 1;
    const start = str(raw && raw.start, 5);
    const end = str(raw && raw.end, 5);
    const s = timeToMin(start);
    const e = timeToMin(end);
    if (s == null || e == null) throw fail(`第 ${period} 节时间格式需为 HH:MM`);
    if (e <= s) throw fail(`第 ${period} 节结束时间必须晚于开始时间`);
    if (s < prevEnd) throw fail(`第 ${period} 节与上一节时间重叠`);
    prevEnd = e;
    return { period, start, end };
  });
}
function periodsOf(data) {
  const list = data && data.term && Array.isArray(data.term.periods) && data.term.periods.length
    ? data.term.periods
    : DEFAULT_PERIODS;
  return list;
}
function periodBounds(periods, p) {
  const item = periods[p - 1];
  if (!item) return null;
  return { period: p, start: item.start, end: item.end, startMin: timeToMin(item.start), endMin: timeToMin(item.end) };
}

// ---------- 冲突 ----------
function rangesOverlap(a1, a2, b1, b2) { return a1 <= b2 && b1 <= a2; }
function safeWeeks(expr) { try { return parseWeeks(expr); } catch (_) { return null; } }

function findConflicts(data, candidate, excludeId) {
  const candWeeks = safeWeeks(candidate.weeks);
  if (!candWeeks) return [];
  const out = [];
  for (const c of data.courses) {
    if (!c || c.id === excludeId) continue;
    if (c.day !== candidate.day) continue;
    if (!rangesOverlap(Number(c.startPeriod), Number(c.endPeriod), candidate.startPeriod, candidate.endPeriod)) continue;
    const cw = safeWeeks(c.weeks);
    if (!cw) continue;
    const shared = cw.filter((w) => candWeeks.includes(w));
    if (!shared.length) continue;
    out.push({
      id: c.id, name: c.name, day: c.day,
      startPeriod: c.startPeriod, endPeriod: c.endPeriod,
      weeks: c.weeks, sharedWeeks: shared,
    });
  }
  return out;
}

/** 全表冲突扫描（独立于写入路径，用于自检/视图提示） */
function scanConflicts(data) {
  const out = [];
  const list = (data.courses || []).slice().sort((a, b) => a.day - b.day || a.startPeriod - b.startPeriod);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.day !== b.day) continue;
      if (!rangesOverlap(Number(a.startPeriod), Number(a.endPeriod), Number(b.startPeriod), Number(b.endPeriod))) continue;
      const aw = safeWeeks(a.weeks), bw = safeWeeks(b.weeks);
      if (!aw || !bw) continue;
      const shared = aw.filter((w) => bw.includes(w));
      if (!shared.length) continue;
      out.push({ a: a.id, b: b.id, aName: a.name, bName: b.name, day: a.day, sharedWeeks: shared.slice(0, 8) });
    }
  }
  return out;
}

// ---------- 课程增删改 ----------
function validateCourse(input, data, excludeId) {
  const errors = [];
  const periods = periodsOf(data);
  const name = str(input && input.name, 60);
  if (!name) errors.push('课程名称必填');

  const day = Number(input && input.day);
  if (!Number.isInteger(day) || day < 1 || day > 7) errors.push('day 必须是 1-7（周一至周日）');

  const sp = Number(input && input.startPeriod);
  const epRaw = input && input.endPeriod;
  const ep = epRaw == null || epRaw === '' ? sp : Number(epRaw);
  if (!Number.isInteger(sp) || sp < 1 || sp > periods.length) errors.push(`开始节次需在 1-${periods.length} 之间`);
  if (!Number.isInteger(ep) || ep < 1 || ep > periods.length) errors.push(`结束节次需在 1-${periods.length} 之间`);
  if (Number.isInteger(sp) && Number.isInteger(ep) && ep < sp) errors.push('结束节次不能早于开始节次');

  const term = data.term;
  const defaultWeeks = term && term.totalWeeks ? `1-${term.totalWeeks}` : '1-16';
  const weeksExpr = str((input && input.weeks) || defaultWeeks, 80);
  let weeks = null;
  try { weeks = parseWeeks(weeksExpr); } catch (e) { errors.push(e.message); }

  if (errors.length) throw fail('课程信息不合法：' + errors.join('；'), 'TIMETABLE_INVALID', { details: errors });

  const course = {
    id: (input && /^[A-Za-z0-9_-]{1,32}$/.test(String(input.id || ''))) ? input.id : 'T-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    name,
    teacher: str(input.teacher, 40),
    location: str(input.location, 40),
    day,
    startPeriod: sp,
    endPeriod: ep,
    weeks: weeksExpr,
    note: str(input.note, 120),
  };
  return { course, weeks };
}

function addCourse(input, { force = false } = {}) {
  const data = read();
  if (data.courses.length >= MAX_COURSES) throw fail(`课程数量上限 ${MAX_COURSES}，请先清理`, 'TIMETABLE_LIMIT');
  const { course } = validateCourse(input, data, null);
  const conflictList = findConflicts(data, course, null);
  if (conflictList.length && !force) {
    throw fail(
      `时间冲突（${conflictList.length} 处），已拒绝写入（可勾选「冲突也强制保存」）`,
      'TIMETABLE_CONFLICT',
      { conflicts: conflictList }
    );
  }
  course.conflict = conflictList.length > 0;
  data.courses.push(course);
  if (data.demo) data.demo = false; // 用户自己加课即视为离开示例状态
  save(data);
  return { course, conflicts: conflictList, warnings: course.conflict ? ['存在冲突，已按 force 强制保存'] : [] };
}

function updateCourse(id, patch, { force = false } = {}) {
  const data = read();
  const idx = data.courses.findIndex((c) => c.id === id);
  if (idx < 0) throw fail('课程不存在', 'TIMETABLE_NOT_FOUND');
  const merged = { ...data.courses[idx], ...(patch || {}), id };
  const { course } = validateCourse(merged, data, id);
  const conflictList = findConflicts(data, course, id);
  if (conflictList.length && !force) {
    throw fail(
      `时间冲突（${conflictList.length} 处），已拒绝写入（可勾选「冲突也强制保存」）`,
      'TIMETABLE_CONFLICT',
      { conflicts: conflictList }
    );
  }
  course.conflict = conflictList.length > 0;
  data.courses[idx] = course;
  save(data);
  return { course, conflicts: conflictList };
}

function removeCourse(id) {
  const data = read();
  const before = data.courses.length;
  data.courses = data.courses.filter((c) => c.id !== id);
  if (data.courses.length === before) return { deleted: false };
  save(data);
  return { deleted: true };
}

function clearCourses() {
  const data = read();
  const n = data.courses.length;
  data.courses = [];
  data.demo = false;
  save(data);
  return { cleared: n };
}

// ---------- 学期 ----------
function setTerm(input) {
  const data = read();
  const name = str(input && input.name, 40) || '本学期';
  const startDate = str(input && input.startDate, 10);
  const d = parseISODate(startDate);
  if (!d) throw fail('开学日期需为 YYYY-MM-DD 且真实存在（建议填第 1 周周一）', 'TIMETABLE_INVALID');
  const totalWeeks = Number(input && input.totalWeeks);
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > MAX_WEEKS) {
    throw fail(`学期总周数需为 1-${MAX_WEEKS} 的整数`, 'TIMETABLE_INVALID');
  }
  const periods = input && input.periods !== undefined
    ? normalizePeriods(input.periods)
    : (data.term && data.term.periods) || periodsOf(data).map((p) => ({ ...p }));

  const warnings = [];
  if (d.getDay() !== 1) warnings.push(`开学日期 ${startDate} 不是周一，周次将从该日期起算（建议改为第 1 周周一）`);
  data.term = { name, startDate, totalWeeks, periods };
  if (data.demo) data.demo = false;
  save(data);
  return { term: data.term, warnings };
}

function weekOf(term, now = new Date()) {
  if (!term || !term.startDate) return { week: null, totalWeeks: term ? term.totalWeeks : null, beforeTerm: false, afterTerm: false };
  const start = parseISODate(term.startDate);
  if (!start) return { week: null, totalWeeks: term.totalWeeks, beforeTerm: false, afterTerm: false };
  const diffDays = Math.floor((dateOnly(now) - dateOnly(start)) / 86400000);
  const raw = Math.floor(diffDays / 7) + 1;
  return {
    week: raw,
    totalWeeks: term.totalWeeks,
    beforeTerm: raw < 1,
    afterTerm: raw > term.totalWeeks,
  };
}

// ---------- 查询 ----------
function activeOn(course, day, week) {
  if (Number(course.day) !== day) return false;
  if (week == null) return true;
  const w = safeWeeks(course.weeks);
  return Boolean(w && w.includes(week));
}
function coursesOn(data, day, week) {
  return (data.courses || [])
    .filter((c) => activeOn(c, day, week))
    .sort((a, b) => a.startPeriod - b.startPeriod || a.endPeriod - b.endPeriod);
}
function occupancy(courses, periodCount) {
  const used = new Array(periodCount + 1).fill(null);
  for (const c of courses) {
    for (let p = Number(c.startPeriod); p <= Number(c.endPeriod); p++) if (p >= 1 && p <= periodCount) used[p] = c;
  }
  return used;
}
function freeSlotsFor(courses, periods, minPeriods) {
  const used = occupancy(courses, periods.length);
  const slots = [];
  let runStart = null;
  for (let p = 1; p <= periods.length + 1; p++) {
    const free = p <= periods.length && !used[p];
    if (free && runStart == null) runStart = p;
    if ((!free || p > periods.length) && runStart != null) {
      const end = p - 1;
      const count = end - runStart + 1;
      if (count >= minPeriods) {
        const s = periodBounds(periods, runStart);
        const e = periodBounds(periods, end);
        slots.push({ startPeriod: runStart, endPeriod: end, periods: count, from: s.start, to: e.end });
      }
      runStart = null;
    }
  }
  return slots;
}

function view(data, { week, now = new Date(), minPeriods = 2 } = {}) {
  const periods = periodsOf(data);
  const wo = weekOf(data.term, now);
  const requested = Number(week);
  const w = Number.isInteger(requested) && requested >= 1 && requested <= MAX_WEEKS
    ? requested
    : (wo.week && wo.week >= 1 ? Math.min(wo.week, data.term ? data.term.totalWeeks : wo.week) : 1);
  const start = data.term && parseISODate(data.term.startDate);
  const min = Math.max(1, Math.min(8, Number(minPeriods) || 2));

  const days = WEEKDAY_NAMES.map((name, i) => {
    const day = i + 1;
    const courses = coursesOn(data, day, w);
    return {
      day, name,
      date: start ? isoDate(addDays(start, (w - 1) * 7 + i)) : null,
      courses,
      freeSlots: freeSlotsFor(courses, periods, min).map((s) => ({ ...s, day, dayName: name })),
    };
  });

  const freeSlots = days.flatMap((d) => d.freeSlots)
    .sort((a, b) => a.day - b.day || a.startPeriod - b.startPeriod)
    .map((s) => ({ ...s, label: `${s.dayName} 第 ${s.startPeriod}-${s.endPeriod} 节 · ${s.from}-${s.to}` }));

  return {
    week: w,
    currentWeek: wo.week,
    term: data.term,
    periods,
    days,
    conflicts: scanConflicts(data),
    freeSlots,
    stats: {
      courses: (data.courses || []).length,
      weeklyPeriods: days.reduce((n, d) => n + d.courses.reduce((m, c) => m + (c.endPeriod - c.startPeriod + 1), 0), 0),
      weeklyCourses: days.reduce((n, d) => n + d.courses.length, 0),
      freeSlotCount: freeSlots.length,
    },
    demo: Boolean(data.demo),
  };
}

function nextCourse(data, now, lookaheadDays = 7) {
  const periods = periodsOf(data);
  const startDay = dateOnly(now);
  for (let offset = 0; offset <= lookaheadDays; offset++) {
    const date = addDays(startDay, offset);
    const wo = weekOf(data.term, date);
    const day = isoDay(date);
    const list = coursesOn(data, day, wo.beforeTerm || wo.afterTerm ? null : wo.week);
    for (const c of list) {
      const b = periodBounds(periods, c.startPeriod);
      if (!b) continue;
      if (offset === 0 && b.startMin <= now.getHours() * 60 + now.getMinutes()) continue;
      const e = periodBounds(periods, c.endPeriod);
      if (!e) continue;
      return {
        courseId: c.id, name: c.name, location: c.location,
        day, dayName: WEEKDAY_NAMES[day - 1], date: isoDate(date), dayOffset: offset,
        startPeriod: c.startPeriod, endPeriod: c.endPeriod, startAt: b.start, endAt: e.end,
      };
    }
  }
  return null;
}

function today(data, { now = new Date() } = {}) {
  const periods = periodsOf(data);
  const wo = weekOf(data.term, now);
  const day = isoDay(now);
  const list = coursesOn(data, day, wo.beforeTerm || wo.afterTerm ? null : wo.week);
  const minutes = now.getHours() * 60 + now.getMinutes();

  const currentEntry = list.find((c) => {
    const b = periodBounds(periods, c.startPeriod);
    const e = periodBounds(periods, c.endPeriod);
    return b && e && minutes >= b.startMin && minutes < e.endMin;
  });
  const current = currentEntry ? (() => {
    const s = periodBounds(periods, currentEntry.startPeriod);
    const e = periodBounds(periods, currentEntry.endPeriod);
    return {
      courseId: currentEntry.id, name: currentEntry.name, location: currentEntry.location, teacher: currentEntry.teacher,
      startPeriod: currentEntry.startPeriod, endPeriod: currentEntry.endPeriod,
      startAt: s.start, endAt: e.end, remainingMin: e.endMin - minutes,
    };
  })() : null;

  const upcomingToday = list.find((c) => {
    const b = periodBounds(periods, c.startPeriod);
    return b && b.startMin > minutes;
  });
  const next = upcomingToday ? (() => {
    const s = periodBounds(periods, upcomingToday.startPeriod);
    const e = periodBounds(periods, upcomingToday.endPeriod);
    return {
      courseId: upcomingToday.id, name: upcomingToday.name, location: upcomingToday.location,
      startPeriod: upcomingToday.startPeriod, endPeriod: upcomingToday.endPeriod,
      startAt: s.start, endAt: e.end, startsInMin: s.startMin - minutes,
      // 统一字段：当天课也算 dayOffset=0，避免下游判断 undefined 漏提醒
      dayOffset: 0, dayName: WEEKDAY_NAMES[day - 1], date: isoDate(now),
    };
  })() : nextCourse(data, now, 7);

  return {
    at: `${isoDate(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    week: wo.week,
    weekday: day,
    weekdayName: WEEKDAY_NAMES[day - 1],
    beforeTerm: wo.beforeTerm,
    afterTerm: wo.afterTerm,
    courses: list,
    current,
    next,
    freeSlotsToday: freeSlotsFor(list, periods, 2).map((s) => ({ ...s, day, dayName: WEEKDAY_NAMES[day - 1], label: `今天 第 ${s.startPeriod}-${s.endPeriod} 节 · ${s.from}-${s.to}` })),
  };
}

/**
 * 今日摘要（给侧栏/提醒器用的紧凑结构）。
 * 只读、可注入时钟；文案由后端统一生成，避免前端多处拼装产生口径漂移。
 */
function digest(now = new Date()) {
  const data = read();
  const t = today(data, { now });
  const courseCount = (t.courses || []).length;
  const conflicts = scanConflicts(data);
  let text;
  if (!data.term) {
    text = '未设置学期：先填开学日期，或载入示例课表';
  } else if (!courseCount) {
    text = '今天没有课';
  } else {
    const names = t.courses.map((c) => `${c.name}（第 ${c.startPeriod}-${c.endPeriod} 节）`).join('、');
    text = `今天 ${courseCount} 节课：${names}`;
    if (t.current) {
      text += `；正在上「${t.current.name}」，还剩 ${Math.max(0, t.current.remainingMin)} 分钟`;
    } else if (t.next && t.next.dayOffset === 0) {
      text += `；下一节 ${t.next.startAt}「${t.next.name}」`;
    } else if (t.next) {
      text += `；下一节在${t.next.dayName} ${t.next.startAt}「${t.next.name}」`;
    } else {
      text += '；今天已经没有课了';
    }
  }
  return {
    at: t.at,
    date: t.at.slice(0, 10),
    week: t.week,
    weekday: t.weekday,
    weekdayName: t.weekdayName,
    hasTerm: Boolean(data.term),
    term: data.term ? { name: data.term.name, startDate: data.term.startDate, totalWeeks: data.term.totalWeeks } : null,
    courseCount,
    courses: t.courses.map((c) => ({
      id: c.id, name: c.name, startPeriod: c.startPeriod, endPeriod: c.endPeriod,
      startAt: (periodBounds(periodsOf(data), c.startPeriod) || {}).start, location: c.location || '',
    })),
    current: t.current,
    next: t.next,
    freeSlotsToday: t.freeSlotsToday,
    conflicts: conflicts.length,
    demo: Boolean(data.demo),
    text,
  };
}

// ---------- 导入 / 示例 ----------
function importData(payload, { mode = 'replace', dryRun = false } = {}) {
  const data = read();
  const errors = [];
  const incoming = Array.isArray(payload && payload.courses) ? payload.courses : null;
  if (!incoming) throw fail('导入内容缺少 courses 数组', 'TIMETABLE_INVALID');
  if (incoming.length > MAX_COURSES) throw fail(`导入课程数超过上限 ${MAX_COURSES}`, 'TIMETABLE_LIMIT');

  const base = { ...data, courses: mode === 'merge' ? data.courses.slice() : [] };
  let term = data.term;
  if (payload.term) {
    try { term = setTermCandidate(payload.term); } catch (e) { errors.push(e.message); }
  }
  if (!term && incoming.length) errors.push('导入前需先设置学期（term.startDate / totalWeeks）');
  base.term = term;

  const preview = [];
  for (let i = 0; i < incoming.length; i++) {
    try {
      const { course } = validateCourse(incoming[i], base, null);
      const conflictList = findConflicts(base, course, null);
      if (conflictList.length) {
        errors.push(`第 ${i + 1} 条「${course.name}」与已有课程冲突：${conflictList.map((c) => c.name).join('、')}`);
      }
      base.courses.push(course);
      preview.push({ index: i + 1, id: course.id, name: course.name, day: course.day, startPeriod: course.startPeriod, endPeriod: course.endPeriod, weeks: course.weeks });
    } catch (e) {
      errors.push(`第 ${i + 1} 条：${e.message}`);
    }
  }

  if (dryRun) {
    return { ok: errors.length === 0, dryRun: true, errors, preview, total: base.courses.length };
  }
  if (errors.length) throw fail('导入未通过校验，未写入任何数据：\n' + errors.join('\n'), 'TIMETABLE_INVALID', { details: errors });
  base.demo = false;
  save(base);
  return { ok: true, imported: preview.length, total: base.courses.length, preview };
}

function setTermCandidate(input) {
  const startDate = str(input && input.startDate, 10);
  if (!parseISODate(startDate)) throw fail('学期 startDate 需为 YYYY-MM-DD');
  const totalWeeks = Number(input && input.totalWeeks);
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > MAX_WEEKS) throw fail(`学期 totalWeeks 需为 1-${MAX_WEEKS}`);
  return {
    name: str(input && input.name, 40) || '本学期',
    startDate,
    totalWeeks,
    periods: input && input.periods ? normalizePeriods(input.periods) : periodsOf({ term: null }).map((p) => ({ ...p })),
  };
}

/** 示例课表：明确标记 demo=true，前端提示"示例数据，可一键清空" */
function loadDemo({ replace = true } = {}) {
  const data = read();
  if (!replace && data.courses.length) throw fail('已有课程，示例仅可替换导入', 'TIMETABLE_INVALID');
  const term = data.term || { name: '示例学期', startDate: '2026-09-07', totalWeeks: 20, periods: DEFAULT_PERIODS.map((p) => ({ ...p })) };
  const demoCourses = [
    { name: '高等数学', teacher: '张老师', location: '教三-201', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' },
    { name: '大学英语', teacher: '李老师', location: '外语楼-305', day: 1, startPeriod: 3, endPeriod: 4, weeks: '1-16' },
    { name: '数据结构', teacher: '王老师', location: '计算机楼-402', day: 2, startPeriod: 3, endPeriod: 4, weeks: '1-16' },
    { name: '操作系统', teacher: '赵老师', location: '计算机楼-401', day: 2, startPeriod: 7, endPeriod: 8, weeks: '2-16双' },
    { name: '大学物理', teacher: '陈老师', location: '理科楼-108', day: 3, startPeriod: 1, endPeriod: 2, weeks: '1-15单' },
    { name: '体育（篮球）', teacher: '刘老师', location: '东区体育馆', day: 3, startPeriod: 5, endPeriod: 6, weeks: '1-16' },
    { name: '计算机网络', teacher: '周老师', location: '计算机楼-305', day: 4, startPeriod: 3, endPeriod: 4, weeks: '1-16' },
    { name: '形势与政策', teacher: '孙老师', location: '教一-501', day: 4, startPeriod: 9, endPeriod: 10, weeks: '1-8' },
    { name: '算法设计', teacher: '吴老师', location: '计算机楼-402', day: 5, startPeriod: 1, endPeriod: 2, weeks: '1-16' },
  ];
  const courses = demoCourses.map((c) => {
    const { course } = validateCourse(c, { term }, null);
    return { ...course, teacher: c.teacher };
  });
  const out = { ...data, term, courses, demo: true };
  save(out);
  return { term, courses: courses.length, demo: true };
}

/**
 * ICS（日历）导入：最合规的"教务系统→本地课表"通道。
 * 学生自行导出 .ics，本工具只读文件，不登录、不抓取、不接触账号密码。
 * 事务式：任何一条校验失败或冲突，整体不写盘。
 */
function importIcs(text, { dryRun = false, mode = 'merge' } = {}) {
  const data = read();
  if (!data.term || !data.term.startDate) {
    throw fail('导入 ICS 前需先设置学期（开学日期 / 总周数），否则无法把日期换算成教学周', 'TIMETABLE_TERM_REQUIRED');
  }
  const parsed = ics.parseIcs(text);
  if (!parsed.events.length) {
    throw fail('ICS 中没有解析到可用的 VEVENT（日历事件）', 'TIMETABLE_INVALID', { details: parsed.warnings });
  }
  const built = ics.eventsToCourses(parsed.events, { term: data.term, periods: periodsOf(data), maxWeeks: MAX_WEEKS });
  const errors = [...built.errors];
  const warnings = [...parsed.warnings, ...built.warnings];

  const base = { ...data, courses: mode === 'merge' ? data.courses.slice() : [] };
  const preview = [];
  for (const c of built.courses) {
    try {
      const { course } = validateCourse(c, base, null);
      const conflicts = findConflicts(base, course, null);
      if (conflicts.length) {
        errors.push(`「${course.name}」与已有课程冲突：${conflicts.map((x) => x.name).join('、')}`);
        continue;
      }
      base.courses.push(course);
      preview.push({
        index: preview.length + 1, id: course.id, name: course.name, day: course.day,
        startPeriod: course.startPeriod, endPeriod: course.endPeriod, weeks: course.weeks, location: course.location,
      });
    } catch (e) {
      errors.push(`「${c.name || '未命名'}」：${e.message}`);
    }
  }

  if (dryRun) {
    return { ok: errors.length === 0, dryRun: true, mode, errors, warnings, preview, parsedEvents: parsed.events.length, total: base.courses.length };
  }
  if (errors.length) {
    throw fail('ICS 导入未通过校验，未写入任何数据：\n' + errors.join('\n'), 'TIMETABLE_INVALID', { details: errors, warnings });
  }
  base.demo = false;
  save(base);
  return { ok: true, imported: preview.length, parsedEvents: parsed.events.length, total: base.courses.length, preview, warnings, merged: mode === 'merge' };
}

/** 导出 .ics（含上课前 10 分钟提醒）；缺学期日期时明确报错 */
function exportIcs({ now } = {}) {
  const data = read();
  return ics.buildIcs(data, { periods: periodsOf(data), now });
}

// ---------- 对外描述 ----------
function describe() {
  return {
    weekdays: WEEKDAY_NAMES.map((name, i) => ({ day: i + 1, name })),
    periods: DEFAULT_PERIODS.map((p) => ({ ...p })),
    maxWeeks: MAX_WEEKS,
    maxCourses: MAX_COURSES,
    dataFile: (path.relative(path.join(__dirname, '..'), DATA_FILE) || 'data/timetable.json').split(path.sep).join('/'),
    weekExpr: '1-16 / 1-16单 / 2-16双 / 1,3,5-9',
    boundary: '纯本地课表：不登录教务系统、不爬取、不代抢课；所有数据仅存本机，用于判断上课与空闲时间。',
    demoHint: '空课表可一键载入示例（demo=true），随时可清空。',
  };
}

module.exports = {
  DATA_FILE, DEFAULT_PERIODS, WEEKDAY_NAMES, MAX_WEEKS,
  parseWeeks, periodBounds, periodsOf,
  read, save, describe,
  validateCourse, findConflicts, scanConflicts,
  addCourse, updateCourse, removeCourse, clearCourses,
  setTerm, normalizePeriods, weekOf,
  view, today, nextCourse, digest,
  importData, loadDemo,
  importIcs, exportIcs,
};

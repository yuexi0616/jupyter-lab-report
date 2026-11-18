'use strict';

/**
 * P5 ICS（iCalendar）专项测试：解析 / 重复规则 / 节次映射 / 导出回环 / 导入事务性。
 * 运行：node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '.tmp-timetable-p5.json');
process.env.MOYU_TIMETABLE_FILE = FILE;

const ics = require('../lib/ics');
const tt = require('../lib/timetable');

function cleanup() { try { fs.rmSync(FILE, { force: true }); } catch (_) {} }
test.beforeEach(cleanup);
test.after(cleanup);

function icsText(body) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//CN', body, 'END:VCALENDAR'].join('\r\n');
}
function event(lines) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}
function seedTerm() {
  tt.setTerm({ name: '2026 秋', startDate: '2026-09-07', totalWeeks: 20 });
}

// ---------- 解析 ----------
test('ics: 解析基本事件（CRLF / 文本反转义）', () => {
  const text = icsText(event([
    'UID:a@b', 'DTSTART:20260907T080000', 'DTEND:20260907T094000',
    'SUMMARY:高等数学', 'LOCATION:教三-201', 'DESCRIPTION:教师：张老师\\n备注',
  ]));
  const r = ics.parseIcs(text);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].summary, '高等数学');
  assert.equal(r.events[0].location, '教三-201');
  assert.equal(r.events[0].dtstart.date.getHours(), 8);
  assert.match(r.events[0].description, /张老师\n备注/);
});
test('ics: 行折叠与 LF-only / BOM 兼容', () => {
  const long = '一门名字特别长的课程用于验证折行处理是否正确不会把续行当成新属性';
  const folded = 'SUMMARY:' + long.slice(0, 20) + '\r\n ' + long.slice(20);
  const text = '\uFEFF' + icsText(event(['DTSTART:20260907T080000', 'DTEND:20260907T084500', folded])).replace(/\r\n/g, '\n');
  const r = ics.parseIcs(text);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].summary, long);
});
test('ics: 全天事件跳过并给出 warning', () => {
  const r = ics.parseIcs(icsText(event(['DTSTART;VALUE=DATE:20260907', 'SUMMARY:国庆放假'])));
  assert.equal(r.events.length, 0);
  assert.ok(r.warnings.some((w) => /全天/.test(w)));
});

// ---------- 重复规则 ----------
test('ics: WEEKLY + COUNT 展开次数正确', () => {
  const r = ics.parseIcs(icsText(event([
    'DTSTART:20260907T080000', 'DTEND:20260907T084500', 'SUMMARY:A',
    'RRULE:FREQ=WEEKLY;COUNT=5',
  ])));
  const built = ics.eventsToCourses(r.events, { term: { startDate: '2026-09-07', totalWeeks: 20 }, periods: tt.DEFAULT_PERIODS });
  assert.equal(built.courses.length, 1);
  assert.equal(built.courses[0].weeks, '1-5');
});
test('ics: BYDAY 多天 → 同周两门课（按星期拆分）', () => {
  const r = ics.parseIcs(icsText(event([
    'DTSTART:20260907T080000', 'DTEND:20260907T084500', 'SUMMARY:英语',
    'RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE',
  ])));
  const built = ics.eventsToCourses(r.events, { term: { startDate: '2026-09-07', totalWeeks: 20 }, periods: tt.DEFAULT_PERIODS });
  assert.equal(built.courses.length, 2);
  assert.deepEqual(built.courses.map((c) => c.day).sort(), [1, 3]);
  assert.ok(built.courses.every((c) => c.weeks === '1-2' || c.weeks === '1-3'));
});
test('ics: INTERVAL=2 单双周', () => {
  const r = ics.parseIcs(icsText(event([
    'DTSTART:20260907T080000', 'DTEND:20260907T084500', 'SUMMARY:物理',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8',
  ])));
  const built = ics.eventsToCourses(r.events, { term: { startDate: '2026-09-07', totalWeeks: 20 }, periods: tt.DEFAULT_PERIODS });
  assert.equal(built.courses[0].weeks, '1-15单');
});
test('ics: 不支持的重复规则不制造假课表', () => {
  const r = ics.parseIcs(icsText(event([
    'DTSTART:20260907T080000', 'DTEND:20260907T084500', 'SUMMARY:每日打卡',
    'RRULE:FREQ=DAILY;COUNT=10',
  ])));
  assert.ok(r.warnings.some((w) => /仅支持 WEEKLY/.test(w)));
  const built = ics.eventsToCourses(r.events, { term: { startDate: '2026-09-07', totalWeeks: 20 }, periods: tt.DEFAULT_PERIODS });
  assert.equal(built.courses.length, 0);
});

// ---------- 节次映射 ----------
test('ics: 时间 → 节次（含 ±10 分钟容差）', () => {
  const p = tt.DEFAULT_PERIODS;
  assert.equal(ics.findPeriod(p, 8 * 60 + 10), 1);
  assert.equal(ics.findPeriod(p, 8 * 60 + 50), 2, '课间 08:50 容差映射到第 2 节');
  assert.equal(ics.findPeriod(p, 12 * 60 + 30), null);
});
test('ics: 课间开始时间无法映射 → 明确报错', () => {
  const r = ics.parseIcs(icsText(event([
    'DTSTART:20260907T123000', 'DTEND:20260907T133000', 'SUMMARY:午间讲座',
  ])));
  const built = ics.eventsToCourses(r.events, { term: { startDate: '2026-09-07', totalWeeks: 20 }, periods: tt.DEFAULT_PERIODS });
  assert.equal(built.courses.length, 0);
  assert.ok(built.errors.some((e) => /不在任何节次内/.test(e)));
});

// ---------- 周次压缩 ----------
test('ics: 周次压缩为可读表达式', () => {
  assert.equal(ics.compressWeeks([1, 2, 3, 4]), '1-4');
  assert.equal(ics.compressWeeks([1, 3, 5, 7]), '1-7单');
  assert.equal(ics.compressWeeks([2, 4, 6]), '2-6双');
  assert.equal(ics.compressWeeks([1, 2, 5]), '1-2,5');
  assert.equal(ics.compressWeeks([]), '');
});

// ---------- 导入事务性 ----------
test('import ics: 未设置学期 → 拒绝', () => {
  const text = icsText(event(['DTSTART:20260907T080000', 'DTEND:20260907T084500', 'SUMMARY:A']));
  assert.throws(() => tt.importIcs(text), (e) => e.code === 'TIMETABLE_TERM_REQUIRED');
});
test('import ics: dryRun 不写盘，正式导入写入并可自检', () => {
  seedTerm();
  const text = icsText(event([
    'DTSTART:20260907T080000', 'DTEND:20260907T094000', 'SUMMARY:高等数学',
    'LOCATION:教三-201', 'DESCRIPTION:教师：张老师', 'RRULE:FREQ=WEEKLY;COUNT=8',
  ]));
  const dry = tt.importIcs(text, { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.preview.length, 1);
  assert.equal(tt.read().courses.length, 0, 'dryRun 不应写入');

  const r = tt.importIcs(text, { mode: 'replace' });
  assert.equal(r.imported, 1);
  const saved = tt.read().courses[0];
  assert.equal(saved.name, '高等数学');
  assert.equal(saved.weeks, '1-8');
  assert.equal(saved.teacher, '张老师');
  assert.equal(require('../lib/eval/timetable.eval').evaluate(tt.read()).verdict, 'PASS');
});
test('import ics: 与已有课程冲突 → 整体拒绝且不写入', () => {
  seedTerm();
  tt.addCourse({ name: '已有课', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' });
  const text = icsText(event([
    'DTSTART:20260907T080000', 'DTEND:20260907T094000', 'SUMMARY:冲突课', 'RRULE:FREQ=WEEKLY;COUNT=4',
  ]));
  assert.throws(() => tt.importIcs(text), (e) => e.code === 'TIMETABLE_INVALID');
  assert.equal(tt.read().courses.length, 1, '冲突时不应写入任何课程');
});

// ---------- 导出 ----------
test('export: 无学期 → 明确报错', () => {
  assert.throws(() => tt.exportIcs(), (e) => e.code === 'TIMETABLE_TERM_REQUIRED');
});
test('export → parse 回环一致（含单双周与不规则周次）', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' });
  tt.addCourse({ name: '物理', day: 3, startPeriod: 3, endPeriod: 4, weeks: '1-15单' });
  tt.addCourse({ name: '选修', day: 5, startPeriod: 5, endPeriod: 6, weeks: '1-2,5,9-10' });

  const out = tt.exportIcs({ now: new Date(2026, 10, 18, 12, 0, 0) });
  assert.ok(out.events >= 3);
  assert.match(out.ics, /BEGIN:VCALENDAR/);
  assert.match(out.ics, /BEGIN:VALARM/);

  const parsed = ics.parseIcs(out.ics);
  const back = ics.eventsToCourses(parsed.events, { term: tt.read().term, periods: tt.DEFAULT_PERIODS });
  const key = (c) => [c.name, c.day, c.startPeriod, c.endPeriod, c.weeks].join('|');
  assert.deepEqual(back.courses.map(key).sort(), tt.read().courses.map(key).sort());
});

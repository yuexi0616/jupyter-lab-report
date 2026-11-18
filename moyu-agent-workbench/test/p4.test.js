'use strict';

/**
 * P4 课程表专项测试（周次解析 / 周次计算 / 冲突 / 今日 / 空闲窗口 / 导入 / 三态自检）。
 * 运行：node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '.tmp-timetable-p4.json');
process.env.MOYU_TIMETABLE_FILE = FILE;

const tt = require('../lib/timetable');
const evalTt = require('../lib/eval/timetable.eval');

function cleanup() { try { fs.rmSync(FILE, { force: true }); } catch (_) {} }
test.beforeEach(cleanup);
test.after(cleanup);

function seedTerm() {
  tt.setTerm({ name: '2026 秋', startDate: '2026-09-07', totalWeeks: 20 });
}

// ---------- 周次表达式 ----------
test('week expr: 区间 / 单双周 / 列表', () => {
  assert.deepEqual(tt.parseWeeks('1-4'), [1, 2, 3, 4]);
  assert.deepEqual(tt.parseWeeks('1-6单'), [1, 3, 5]);
  assert.deepEqual(tt.parseWeeks('2-6双'), [2, 4, 6]);
  assert.deepEqual(tt.parseWeeks('1,3,5-7'), [1, 3, 5, 6, 7]);
  assert.deepEqual(tt.parseWeeks('1，3、5'), [1, 3, 5]);
});
test('week expr: 非法表达式明确报错（不猜测）', () => {
  for (const bad of ['', 'abc', '0-4', '5-2', '31', '1-40']) {
    assert.throws(() => tt.parseWeeks(bad), (e) => e.code === 'TIMETABLE_INVALID', `应拒绝 ${bad}`);
  }
});

// ---------- 周次计算 ----------
test('weekOf: 开学周 / 周末 / 跨周 / 学期外', () => {
  const term = { startDate: '2026-09-07', totalWeeks: 20 };
  assert.equal(tt.weekOf(term, new Date(2026, 8, 7)).week, 1);
  assert.equal(tt.weekOf(term, new Date(2026, 8, 13)).week, 1, '周日仍属第 1 周');
  assert.equal(tt.weekOf(term, new Date(2026, 8, 14)).week, 2);
  assert.equal(tt.weekOf(term, new Date(2026, 7, 31)).week, 0);
  assert.equal(tt.weekOf(term, new Date(2026, 7, 31)).beforeTerm, true);
  assert.equal(tt.weekOf(term, new Date(2027, 1, 1)).afterTerm, true);
  assert.equal(tt.weekOf(null, new Date()).week, null);
});

// ---------- 校验与冲突 ----------
test('course: 字段校验（名称/星期/节次/周次）', () => {
  seedTerm();
  assert.throws(() => tt.addCourse({ name: '', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-4' }), /名称必填/);
  assert.throws(() => tt.addCourse({ name: 'X', day: 8, startPeriod: 1, endPeriod: 2, weeks: '1-4' }), /day/);
  assert.throws(() => tt.addCourse({ name: 'X', day: 1, startPeriod: 5, endPeriod: 3, weeks: '1-4' }), /结束节次/);
  assert.throws(() => tt.addCourse({ name: 'X', day: 1, startPeriod: 13, endPeriod: 13, weeks: '1-4' }), /开始节次/);
});
test('course: 同天 + 节次重叠 + 周次交集 → 冲突拒绝（409 语义）', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' });
  let err = null;
  try { tt.addCourse({ name: '线代', day: 1, startPeriod: 2, endPeriod: 3, weeks: '1-16' }); }
  catch (e) { err = e; }
  assert.ok(err, '应抛出冲突错误');
  assert.equal(err.code, 'TIMETABLE_CONFLICT');
  assert.equal(err.conflicts.length, 1);
});
test('course: 节次相邻 / 周次不相交 / 不同天 → 不算冲突', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-8' });
  assert.equal(tt.addCourse({ name: '英语', day: 1, startPeriod: 3, endPeriod: 4, weeks: '1-8' }).conflicts.length, 0);
  assert.equal(tt.addCourse({ name: '物理', day: 1, startPeriod: 1, endPeriod: 2, weeks: '9-16' }).conflicts.length, 0);
  assert.equal(tt.addCourse({ name: '体育', day: 2, startPeriod: 1, endPeriod: 2, weeks: '1-8' }).conflicts.length, 0);
});
test('course: force 可强制保存并标记 conflict', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' });
  const r = tt.addCourse({ name: '讲座', day: 1, startPeriod: 1, endPeriod: 2, weeks: '5' }, { force: true });
  assert.equal(r.course.conflict, true);
  assert.equal(r.warnings.length, 1);
});
test('course: 非法 id 不会造成越权（重新生成 id）', () => {
  seedTerm();
  const r = tt.addCourse({ id: '../../evil', name: 'X', day: 3, startPeriod: 1, endPeriod: 2, weeks: '1-4' });
  assert.match(r.course.id, /^T-[A-Z0-9]+$/);
});

// ---------- 视图 / 今日 / 空闲 ----------
test('view: 按周次过滤单双周课程并给出日期', () => {
  seedTerm();
  tt.addCourse({ name: '单周课', day: 3, startPeriod: 1, endPeriod: 2, weeks: '1-15单' });
  tt.addCourse({ name: '双周课', day: 3, startPeriod: 3, endPeriod: 4, weeks: '2-16双' });
  const odd = tt.view(tt.read(), { week: 3 });
  assert.deepEqual(odd.days[2].courses.map((c) => c.name), ['单周课']);
  assert.equal(odd.days[2].date, '2026-09-23', '第 3 周周三日期');
  const even = tt.view(tt.read(), { week: 4 });
  assert.deepEqual(even.days[2].courses.map((c) => c.name), ['双周课']);
});
test('view: 连续空闲窗口只取 ≥2 节，且避开已有课', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-4' });
  const v = tt.view(tt.read(), { week: 1 });
  const mon = v.freeSlots.filter((s) => s.day === 1);
  assert.ok(mon.some((s) => s.startPeriod === 3 && s.endPeriod >= 4), '第 3 节起应为连续空闲');
  assert.ok(!mon.some((s) => s.startPeriod === 1), '已有课的节次不应出现');
  assert.ok(mon.every((s) => s.periods >= 2));
});
test('today: 正在上课 → current 带剩余分钟；下一节 → next', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 3, startPeriod: 1, endPeriod: 2, weeks: '1-20' });
  tt.addCourse({ name: '体育', day: 3, startPeriod: 5, endPeriod: 6, weeks: '1-20' });
  const t = tt.today(tt.read(), { now: new Date(2026, 10, 18, 8, 10) }); // 周三 08:10
  assert.equal(t.weekdayName, '周三');
  assert.equal(t.current.name, '高数');
  assert.equal(t.current.remainingMin, 90); // 到 09:40
  assert.equal(t.next.name, '体育');
  assert.ok(t.next.startsInMin > 0);
});
test('today: 当天没课 → current/next 为 null 或跨天下一节', () => {
  seedTerm();
  tt.addCourse({ name: '周一课', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-20' });
  const t = tt.today(tt.read(), { now: new Date(2026, 10, 18, 15, 0) }); // 周三下午
  assert.equal(t.current, null);
  assert.ok(t.next === null || t.next.dayOffset > 0);
});

// ---------- 今日摘要（digest） ----------
test('digest: 未设学期 → 明确提示，不等同于“今天没课”', () => {
  const d = tt.digest(new Date(2026, 10, 18, 8, 0));
  assert.equal(d.hasTerm, false);
  assert.match(d.text, /未设置学期/);
  assert.equal(d.courseCount, 0);
});
test('digest: 课程数 / 正在上课 / 下一节文案', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 3, startPeriod: 1, endPeriod: 2, weeks: '1-20' });
  tt.addCourse({ name: '体育', day: 3, startPeriod: 5, endPeriod: 6, weeks: '1-20' });
  const during = tt.digest(new Date(2026, 10, 18, 8, 10));
  assert.equal(during.courseCount, 2);
  assert.equal(during.current.name, '高数');
  assert.match(during.text, /今天 2 节课/);
  assert.match(during.text, /正在上「高数」/);
  assert.equal(during.week, 11);

  const after = tt.digest(new Date(2026, 10, 18, 12, 0));
  assert.equal(after.current, null);
  assert.match(after.text, /下一节 14:00「体育」/);
  assert.equal(after.next.startsInMin, 120);
});
test('digest: 今天没课与冲突计数', () => {
  seedTerm();
  tt.addCourse({ name: '周一课', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-4' });
  const d = tt.digest(new Date(2026, 10, 18, 10, 0)); // 周三
  assert.equal(d.courseCount, 0);
  assert.match(d.text, /今天没有课/);

  tt.addCourse({ name: '周一课2', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-4' }, { force: true });
  assert.equal(tt.digest(new Date(2026, 10, 18, 10, 0)).conflicts, 1);
});

// ---------- 导入 ----------
test('import: 预校验不写盘；有错时整体拒绝', () => {
  seedTerm();
  const before = tt.read().courses.length;
  const dry = tt.importData({ courses: [{ name: 'A', day: 2, startPeriod: 1, endPeriod: 2, weeks: '1-4' }] }, { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(tt.read().courses.length, before, 'dryRun 不应写入');

  assert.throws(() => tt.importData({
    courses: [
      { name: 'A', day: 2, startPeriod: 1, endPeriod: 2, weeks: '1-4' },
      { name: 'B', day: 2, startPeriod: 2, endPeriod: 3, weeks: '1-4' }, // 与 A 冲突
    ],
  }), (e) => e.code === 'TIMETABLE_INVALID');
  assert.equal(tt.read().courses.length, before, '校验失败应整体不写');
});
test('import: 合法数据覆盖导入并统计', () => {
  seedTerm();
  const r = tt.importData({ courses: [
    { name: 'A', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-4' },
    { name: 'B', day: 3, startPeriod: 5, endPeriod: 6, weeks: '1-4' },
  ] }, { mode: 'replace' });
  assert.equal(r.imported, 2);
  assert.equal(tt.read().courses.length, 2);
});
test('import: 未设置学期时拒绝导入（周次无从校验）', () => {
  assert.throws(() => tt.importData({ courses: [{ name: 'A', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-4' }] }),
    (e) => e.code === 'TIMETABLE_INVALID');
});

// ---------- 自检三态 ----------
test('eval: 未设学期 / 空课表 → INCONCLUSIVE', () => {
  assert.equal(evalTt.evaluate(tt.read()).verdict, 'INCONCLUSIVE');
  seedTerm();
  assert.equal(evalTt.evaluate(tt.read()).verdict, 'INCONCLUSIVE');
});
test('eval: 正常课表 → PASS', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' });
  const v = evalTt.evaluate(tt.read());
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.failures.length, 0);
});
test('eval: 手工制造的冲突与周次越界 → FAIL', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' });
  const data = tt.read();
  data.courses.push({ ...data.courses[0], id: 'T-DUP', name: '重复课' });
  data.courses[0].weeks = '1-25'; // 超出 20 周
  const v = evalTt.evaluate(data);
  assert.equal(v.verdict, 'FAIL');
  assert.ok(v.failures.some((f) => /超出学期总周数/.test(f)));
  assert.ok(v.failures.some((f) => /时间冲突/.test(f)));
});
test('eval: 重复 id → FAIL', () => {
  seedTerm();
  tt.addCourse({ name: '高数', day: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16' });
  const data = tt.read();
  data.courses.push({ ...data.courses[0] });
  const v = evalTt.evaluate(data);
  assert.ok(v.failures.some((f) => /id 重复/.test(f)));
});

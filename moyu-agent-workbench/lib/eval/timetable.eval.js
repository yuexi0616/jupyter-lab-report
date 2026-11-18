'use strict';

/**
 * 课程表 V 层自检（P4）
 *
 * 与写入路径的即时校验相互独立：这里直接扫描落盘数据，重新解析周次、节次、
 * 冲突与学期边界。用于发现"手工改文件 / 导入不规范 / 学期周数调整后遗留"的问题。
 *
 * 三态裁决（沿用 P1-P3 的证据驱动口径）：
 *  - PASS：学期已配置、课程结构合法、无冲突、周次未越界；
 *  - FAIL：存在结构性错误（冲突 / 周次越界 / 字段非法 / id 重复）；
 *  - INCONCLUSIVE：没有学期或没有课程，证据不足，不强行判成功。
 */

const timetable = require('../timetable');

function evaluate(data) {
  const evidence = [];
  const failures = [];

  if (!data) return { verdict: 'INCONCLUSIVE', evidence, failures: ['课表数据不存在'] };

  const courses = Array.isArray(data.courses) ? data.courses : [];
  evidence.push({ source: 'timetable-file', courses: courses.length, hasTerm: Boolean(data.term) });

  if (!data.term || !data.term.startDate) {
    return { verdict: 'INCONCLUSIVE', evidence, failures: ['未设置学期（开学日期 / 总周数），无法判断周次与边界'] };
  }
  if (!courses.length) {
    return { verdict: 'INCONCLUSIVE', evidence, failures: ['课表为空，无可核验内容'] };
  }

  // 1) 节次表自身合法性
  let periods = null;
  try {
    periods = data.term.periods ? timetable.normalizePeriods(data.term.periods) : timetable.periodsOf(data);
    evidence.push({ source: 'periods', count: periods.length });
  } catch (e) {
    failures.push('作息节次表非法：' + e.message);
  }
  const periodCount = periods ? periods.length : timetable.periodsOf(data).length;

  // 2) 逐条结构校验（复用能力层的校验器，但不写入）
  const seen = new Set();
  const weekSets = new Map();
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i] || {};
    const tag = `第 ${i + 1} 条「${c.name || '未命名'}」`;
    if (!c.id || typeof c.id !== 'string') failures.push(`${tag} 缺少合法 id`);
    else if (seen.has(c.id)) failures.push(`${tag} id 重复：${c.id}`);
    else seen.add(c.id);

    if (!c.weeks) {
      failures.push(`${tag} 缺少周次表达式`);
      continue;
    }
    let weeks = null;
    try { weeks = timetable.parseWeeks(c.weeks); }
    catch (e) { failures.push(`${tag} 周次非法：${e.message}`); continue; }
    weekSets.set(c.id, weeks);

    if (!Number.isInteger(Number(c.day)) || Number(c.day) < 1 || Number(c.day) > 7) {
      failures.push(`${tag} day 非法：${c.day}`);
    }
    const sp = Number(c.startPeriod), ep = Number(c.endPeriod);
    if (!Number.isInteger(sp) || sp < 1 || sp > periodCount) failures.push(`${tag} 开始节次越界：${c.startPeriod}`);
    if (!Number.isInteger(ep) || ep < sp || ep > periodCount) failures.push(`${tag} 结束节次越界：${c.endPeriod}`);

    const maxWeek = weeks[weeks.length - 1];
    if (maxWeek > Number(data.term.totalWeeks)) {
      failures.push(`${tag} 周次 ${maxWeek} 超出学期总周数 ${data.term.totalWeeks}（请调整学期设置或课程周次）`);
    }
  }

  // 3) 冲突扫描（同一天 / 节次重叠 / 周次有交集）
  const conflicts = timetable.scanConflicts(data);
  for (const c of conflicts) {
    failures.push(`时间冲突：「${c.aName}」与「${c.bName}」周${'一二三四五六日'[c.day - 1]}共享第 ${c.sharedWeeks.join(',')} 周`);
  }
  evidence.push({ source: 'conflicts', count: conflicts.length });
  evidence.push({ source: 'week-ranges', checked: weekSets.size });

  return {
    verdict: failures.length ? 'FAIL' : 'PASS',
    evidence,
    failures,
    stats: { courses: courses.length, conflicts: conflicts.length, totalWeeks: data.term.totalWeeks },
  };
}

module.exports = { evaluate };

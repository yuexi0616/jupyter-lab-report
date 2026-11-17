'use strict';

/**
 * P1 刷课专项测试（平台识别 / 进度机 / 断点 / 验证码 / evaluator 三态 / 边界）。
 * 运行：node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '.tmp-course-p1');
process.env.MOYU_COURSE_STATE_DIR = STATE_DIR;
const course = require('../lib/course');
const courseEval = require('../lib/eval/course.eval');

function cleanup() { try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (_) {} }
test.beforeEach(cleanup);
test.after(cleanup);

// ---------- 平台识别 ----------
test('course: 识别 OCS 支持的平台', () => {
  assert.equal(course.detectPlatform('https://i.chaoxing.com/lesson')?.id, 'chaoxing');
  assert.equal(course.detectPlatform('智慧树 课程页')?.id, 'zhihuishu');
  assert.equal(course.detectPlatform('www.icourse163.org/course')?.id, 'icourse163');
});
test('course: 未知平台返回 null（不硬编码猜测）', () => {
  assert.equal(course.detectPlatform('https://example.com/random'), null);
});
test('course: 平台清单与答题默认关对外可见', () => {
  const d = course.describeBackends();
  assert.ok(d.platforms.length >= 5);
  assert.equal(d.autoAnswerDefault, false);
  assert.match(d.boundary, /不改成绩/);
});

// ---------- 会话与进度机 ----------
test('course: 创建 mock 会话标记为 simulated', async () => {
  const s = await course.createSession({ url: 'https://i.chaoxing.com/lesson', total: 10, sessionId: 'S1' });
  assert.equal(s.simulated, true);
  assert.equal(s.progress.total, 10);
  assert.equal(s.autoAnswer, false);
});
test('course: 自动答题默认关（K4 默认安全）', async () => {
  const s = await course.createSession({ url: '智慧树', total: 5, sessionId: 'A0' });
  assert.equal(s.autoAnswer, false);
});
test('course: 自动答题无 U2 授权 token 时拒绝', async () => {
  await assert.rejects(
    course.createSession({ url: '智慧树', total: 5, autoAnswer: true }),
    (e) => e.code === 'AUTO_ANSWER_AUTH_REQUIRED'
  );
});
test('course: 自动答题携带 U2 授权 token 时允许并留痕', async () => {
  const s = await course.createSession({ url: '智慧树', total: 5, autoAnswer: true, answerAuthToken: 'ask-token-123', sessionId: 'A1' });
  assert.equal(s.autoAnswer, true);
  assert.equal(s.answerAuth.token, 'ask-token-123');
  assert.ok(s.sideEffects.some((x) => /学术诚信责任/.test(x)));
  const s2 = await course.tick('A1', { steps: 1 });
  assert.ok(s2.sideEffects.some((x) => /自动答题/.test(x)));
});
test('course: 进度推进到完成', async () => {
  let s = await course.createSession({ url: '职教云', total: 5, sessionId: 'S2' });
  s = await course.tick('S2', { steps: 3 });
  assert.equal(s.progress.current, 3);
  s = await course.tick('S2', { steps: 5 });
  assert.equal(s.progress.current, 5);
  assert.equal(s.status, 'done');
});
test('course: 验证码触发暂停转人工', async () => {
  let s = await course.createSession({ url: '学习通', total: 10, sessionId: 'S3' });
  s = await course.tick('S3', { steps: 1, mockCaptchaAt: 1 });
  assert.equal(s.status, 'awaiting_human');
  assert.ok(s.sideEffects.some((x) => /验证码/.test(x)));
  // 人工处理后恢复
  s = course.resumeAfterHuman('S3');
  assert.equal(s.status, 'running');
});
test('course: 断点续播暂停/恢复', async () => {
  await course.createSession({ url: '中国大学MOOC', total: 8, sessionId: 'S4' });
  await course.tick('S4', { steps: 3 });
  let s = course.pause('S4');
  assert.equal(s.status, 'paused');
  await assert.rejects(course.tick('S4', { steps: 1 }), (e) => e.code === 'COURSE_PAUSED');
  assert.equal(course.getSession('S4').progress.current, 3, '暂停时进度不应变化');
  s = course.pause('S4');
  assert.equal(s.status, 'running');
});
test('course: 非法 sessionId 被拒（防路径穿越）', () => {
  assert.throws(() => course.getSession('../../evil'), /非法 sessionId/);
});

// ---------- evaluator 三态 ----------
test('eval: mock 完成也只能判 INCONCLUSIVE（不把模拟当真实）', async () => {
  let s = await course.createSession({ url: '智慧树', total: 3, sessionId: 'E1' });
  s = await course.tick('E1', { steps: 3 });
  const v = await courseEval.evaluate(s);
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.ok(v.failures[0].includes('模拟'));
});
test('eval: 未完成判 FAIL', async () => {
  const s = await course.createSession({ url: '智慧树', total: 5, sessionId: 'E2' });
  const v = await courseEval.evaluate(s);
  assert.equal(v.verdict, 'FAIL');
});
test('eval: 验证码待人工判 INCONCLUSIVE', async () => {
  let s = await course.createSession({ url: '学习通', total: 10, sessionId: 'E3' });
  s = await course.tick('E3', { steps: 1, mockCaptchaAt: 1 });
  const v = await courseEval.evaluate(s);
  assert.equal(v.verdict, 'INCONCLUSIVE');
});
test('eval: 不存在会话判 INCONCLUSIVE', async () => {
  const v = await courseEval.evaluate(null);
  assert.equal(v.verdict, 'INCONCLUSIVE');
});

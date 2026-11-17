'use strict';

/**
 * P2 作业专项测试（notebook 骨架 / SOP / 脱敏 / 追溯 / U2 门禁 / evaluator 三态）。
 * 运行：node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '.tmp-homework-p2');
process.env.MOYU_HOMEWORK_STATE_DIR = STATE_DIR;
const hw = require('../lib/homework');
const evalHw = require('../lib/eval/homework.eval');

function cleanup() { try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (_) {} }
test.beforeEach(cleanup);
test.after(cleanup);

const AUTH = { genAuthToken: 'u2-before-token' };

// ---------- 骨架与 SOP ----------
test('homework: notebook 骨架是合法结构且含占位单元', () => {
  const nb = hw.buildNotebook('测试题');
  assert.equal(nb.nbformat, 4);
  assert.ok(nb.cells.length >= 3);
  assert.ok(nb.cells.some((c) => c.cell_type === 'code'));
});
test('homework: SOP 九步顺序', () => {
  assert.deepEqual(hw.STEPS, ['doctor', 'check', 'cover', 'build', 'run', 'audit', 'deliver', 'clean', 'pack']);
});
test('homework: 骨架生成需 U2 生成前询问授权', async () => {
  await assert.rejects(hw.createSession({ title: '题' }), (e) => e.code === 'ASK_BEFORE_REQUIRED');
});
test('homework: 创建会话后处于 check 阶段', async () => {
  const s = await hw.createSession({ title: '题', ...AUTH, sessionId: 'H1' });
  assert.equal(s.stage, 'check');
  assert.equal(s.simulated, true);
});

// ---------- 脱敏与追溯 ----------
test('homework: check 检测 REPLACE-* 占位与真实信息泄漏', () => {
  const r = hw.checkSanitization({ name: 'REPLACE-NAME' });
  assert.equal(r.pass, false);
  assert.ok(r.issues.some((x) => /REPLACE/.test(x)));
  const r2 = hw.checkSanitization({}, { name: '张三', student_id: '20210001' });
  assert.ok(r2.issues.some((x) => /name/.test(x)));
});
test('homework: check 通过时无 issue', () => {
  const r = hw.checkSanitization({ name: '匿名', workdir: '/tmp' });
  assert.equal(r.pass, true);
});
test('homework: 结论必须有对应输出才可通过 audit', () => {
  const bad = hw.checkTrace([{ claim: '准确率提升 10%' }]);
  assert.equal(bad.pass, false);
  const good = hw.checkTrace([{ claim: '准确率提升 10%', outputId: 'cell-3-out-1' }]);
  assert.equal(good.pass, true);
});
test('homework: check 未通过则流程 blocked', async () => {
  await hw.createSession({ title: '题', ...AUTH, sessionId: 'H2' });
  const s = await hw.advance('H2', { profile: { name: 'REPLACE-NAME' } });
  assert.equal(s.status, 'blocked');
});

// ---------- U2 生成后询问（交付门禁）----------
test('homework: 报告交付需生成后采用确认（adopt=true）', async () => {
  await hw.createSession({ title: '题', ...AUTH, sessionId: 'H3' });
  // 先推进到 deliver
  const claims = [{ claim: '结论', outputId: 'cell-3-out-1' }];
  for (let i = 0; i < 20 && hw.getSession('H3').stage !== 'deliver'; i++) {
    await hw.advance('H3', { profile: { name: '匿名' }, claims });
  }
  assert.equal(hw.getSession('H3').stage, 'deliver');
  await assert.rejects(hw.advance('H3', {}), (e) => e.code === 'ASK_AFTER_REQUIRED');
});

// ---------- evaluator 三态 ----------
test('eval: 未完成判 FAIL', async () => {
  const s = await hw.createSession({ title: '题', ...AUTH, sessionId: 'E1' });
  assert.equal(evalHw.evaluate(s).verdict, 'FAIL');
});
test('eval: 不存在会话判 INCONCLUSIVE', () => {
  assert.equal(evalHw.evaluate(null).verdict, 'INCONCLUSIVE');
});
test('eval: 完整 mock 流程最多 INCONCLUSIVE（不把模拟当真实）', async () => {
  await hw.createSession({ title: '题', ...AUTH, sessionId: 'E2' });
  const claims = [{ claim: '结论', outputId: 'cell-3-out-1' }];
  for (let i = 0; i < 20 && hw.getSession('E2').status !== 'done'; i++) {
    await hw.advance('E2', { profile: { name: '匿名' }, claims, adopt: true });
  }
  const s = hw.getSession('E2');
  assert.equal(s.status, 'done', '流程应可走到 done');
  const v = evalHw.evaluate(s);
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.ok(v.failures.some((f) => /模拟/.test(f)));
});

'use strict';

/**
 * P3 竞赛专项测试（证据驱动 / 数字冻结 / 引用完整性 / 独立审计三态 / U2 门禁）。
 * 运行：node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '.tmp-project-p3');
process.env.MOYU_PROJECT_STATE_DIR = STATE_DIR;
const proj = require('../lib/project');
const evalProj = require('../lib/eval/project.eval');

function cleanup() { try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (_) {} }
test.beforeEach(cleanup);
test.after(cleanup);
const AUTH = { genAuthToken: 'u2-before-token' };

// ---------- 证据驱动核心 ----------
test('project: Claim 无证据 → INCONCLUSIVE（不强行 PASS）', () => {
  const c = proj.registerClaim('准确率提升 10%', []);
  assert.equal(c.verdict, 'INCONCLUSIVE');
});
test('project: Claim 有证据且数字绑定产物 → PASS', () => {
  const c = proj.registerClaim('准确率提升 10%', ['result-1.csv'], ['0.82']);
  assert.equal(c.verdict, 'PASS');
});
test('project: 数字有值但无来源 → 冻结失败', () => {
  const f = proj.freezeNumber('0.82', '');
  assert.equal(f.ok, false);
  const ok = proj.freezeNumber('0.82', 'result-1');
  assert.equal(ok.ok, true);
});
test('project: 引用必须有 sourceId', () => {
  const r = proj.checkCitations([{ text: '文献A' }]);
  assert.equal(r.pass, false);
  assert.equal(proj.checkCitations([{ text: '文献A', sourceId: 'src-1' }]).pass, true);
});

// ---------- 会话与 U2 门禁 ----------
test('project: 立题需 U2 生成前询问授权', async () => {
  await assert.rejects(proj.createSession({ topic: '题' }), (e) => e.code === 'ASK_BEFORE_REQUIRED');
});
test('project: 创建后处于 research 阶段', async () => {
  const s = await proj.createSession({ topic: '题', ...AUTH, sessionId: 'M1' });
  assert.equal(s.stage, 'research');
  assert.equal(s.simulated, true);
});
test('project: 数字未冻结时 verify 阻断', async () => {
  await proj.createSession({ topic: '题', ...AUTH, sessionId: 'M2' });
  for (let i = 0; i < 10 && proj.getSession('M2').stage !== 'verify'; i++) await proj.advance('M2', {});
  const s = await proj.advance('M2', { numbers: [{ value: '0.82', sourceId: '' }], citations: [{ text: 'A', sourceId: 's1' }] });
  assert.equal(s.status, 'blocked');
  assert.ok(s.sideEffects.some((x) => /数字冻结失败/.test(x)));
});
test('project: 写作交付需 U2 生成后采用确认', async () => {
  await proj.createSession({ topic: '题', ...AUTH, sessionId: 'M3' });
  for (let i = 0; i < 10 && proj.getSession('M3').stage !== 'write'; i++) {
    await proj.advance('M3', { numbers: [{ value: '0.82', sourceId: 'r1' }], citations: [{ text: 'A', sourceId: 's1' }], claims: [{ claim: '结论', evidence: ['r1'], numbers: ['0.82'] }] });
  }
  assert.equal(proj.getSession('M3').stage, 'write');
  await assert.rejects(proj.advance('M3', {}), (e) => e.code === 'ASK_AFTER_REQUIRED');
});

// ---------- evaluator 三态 ----------
test('eval: 未完成判 FAIL', async () => {
  const s = await proj.createSession({ topic: '题', ...AUTH, sessionId: 'E1' });
  assert.equal(evalProj.evaluate(s).verdict, 'FAIL');
});
test('eval: 门控阻断判 FAIL', async () => {
  await proj.createSession({ topic: '题', ...AUTH, sessionId: 'E2' });
  for (let i = 0; i < 10 && proj.getSession('E2').stage !== 'verify'; i++) await proj.advance('E2', {});
  await proj.advance('E2', { numbers: [{ value: '0.82', sourceId: '' }] });
  assert.equal(evalProj.evaluate(proj.getSession('E2')).verdict, 'FAIL');
});
test('eval: 完整 mock 流程最多 INCONCLUSIVE', async () => {
  await proj.createSession({ topic: '题', ...AUTH, sessionId: 'E3' });
  for (let i = 0; i < 10 && proj.getSession('E3').status !== 'done'; i++) {
    await proj.advance('E3', {
      numbers: [{ value: '0.82', sourceId: 'r1' }],
      citations: [{ text: 'A', sourceId: 's1' }],
      claims: [{ claim: '结论', evidence: ['r1.csv'], numbers: ['0.82'] }],
      adopt: true,
    });
  }
  const s = proj.getSession('E3');
  assert.equal(s.status, 'done');
  const v = evalProj.evaluate(s);
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.ok(v.claimVerdicts.some((c) => c.verdict === 'PASS'), '底层 Claim 可 PASS');
  assert.ok(v.failures.some((f) => /模拟/.test(f)));
});
test('eval: 不存在会话判 INCONCLUSIVE', () => {
  assert.equal(evalProj.evaluate(null).verdict, 'INCONCLUSIVE');
});

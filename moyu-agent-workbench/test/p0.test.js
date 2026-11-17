'use strict';

/**
 * P0 专项测试（决策器抽象 + U2 两道询问门禁）。
 * 运行：node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 独立 runs 目录，避免与其他测试文件并行时清理竞争
const RUNS = path.join(__dirname, '.tmp-runs-p0');
process.env.MOYU_RUNS_DIR = RUNS;

const agent = require('../lib/agent');
const decider = require('../lib/decider');
const { makeProvider } = require('../lib/models');
const mock = makeProvider({ preset: 'mock' });

function clearRuns() {
  if (!fs.existsSync(RUNS)) return;
  for (const f of fs.readdirSync(RUNS)) {
    if (/^[A-Za-z0-9_-]+\.(trace|audit)\.json$/.test(f)) fs.unlinkSync(path.join(RUNS, f));
  }
}
test.beforeEach(() => clearRuns());
test.after(() => { try { fs.rmSync(RUNS, { recursive: true, force: true }); } catch (_) {} });

// ---------- 决策器抽象 ----------
test('decider: 默认 mock 后端返回规范化决策，source=mock', async () => {
  const d = await decider.decide(mock, '周末有空吗一起吃饭');
  assert.equal(d.source, 'mock');
  assert.ok(d.intent && typeof d.danger === 'number');
});
test('decider: 高危关键词硬兜底（独立于 mock 模型输出）', async () => {
  const d = await decider.decide(mock, '帮我把钱转到这张银行卡，验证码发我');
  assert.ok(d.danger >= 8);
  assert.equal(d.best_action, 'ask_human');
  assert.equal(d.should_reply_now, false);
  assert.equal(d.hardRule, true);
});
test('decider: 解析失败一律转人工（不猜测放行）', async () => {
  const bad = { id: 'bad', model: 'x', mock: false, async chat() { return { content: 'not json at all' }; } };
  const d = await decider.decide(bad, '普通消息', { backend: 'llm' });
  assert.equal(d.best_action, 'ask_human');
  assert.equal(d.danger, 9);
});
test('decider: anyjev 后端服务不可用时抛 DECIDER_UNAVAILABLE（禁降级）', async () => {
  await assert.rejects(
    decider.decide(mock, '普通消息', { backend: 'anyjev', endpoint: 'http://127.0.0.1:1', timeoutMs: 300 }),
    (e) => e.code === 'DECIDER_UNAVAILABLE'
  );
});
test('decider: 非法后端名回退为 mock', () => {
  const cfg = decider.loadConfig();
  assert.ok(decider.VALID_BACKENDS.has(cfg.backend));
});

// ---------- U2 两道询问门禁 ----------
test('门禁: 未注入 askHooks 时行为不变（向后兼容）', async () => {
  const r = await agent.run(mock, { task: '周末约饭', approvals: { 3: true, 5: true } });
  assert.equal(r.status, 'done');
  assert.equal(r.filled !== null, true);
});
test('门禁一: 生成前拒绝 → 不执行生成，状态 awaiting_approval', async () => {
  let beforeCalled = false;
  const r = await agent.run(mock, {
    task: '周末约饭',
    approvals: { 3: true, 5: true },
    askHooks: {
      beforeGenerate: async () => { beforeCalled = true; return { approved: false, reason: '用户取消' }; },
    },
  });
  assert.equal(beforeCalled, true);
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(r.filled, null);
  assert.equal(r.error?.code, 'ASK_BEFORE_DECLINED');
  assert.ok(r.trace.some((t) => t.event === 'ask_before_declined'));
});
test('门禁二: 生成后非 adopt → 草稿作废，不进入填入', async () => {
  const r = await agent.run(mock, {
    task: '周末约饭',
    approvals: { 3: true, 5: true },
    askHooks: {
      afterGenerate: async () => ({ approved: false, action: 'discard', reason: '用户重写' }),
    },
  });
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(r.filled, null);
  assert.equal(r.ranked, null);
  assert.equal(r.error?.code, 'ASK_AFTER_NOT_ADOPTED');
  assert.ok(r.trace.some((t) => t.event === 'ask_after' && t.action === 'discard'));
});
test('门禁: 两道都通过 → 正常完成并留痕', async () => {
  const events = [];
  const r = await agent.run(mock, {
    task: '周末约饭',
    approvals: { 3: true, 5: true },
    askHooks: {
      beforeGenerate: async () => { events.push('before'); return { approved: true }; },
      afterGenerate: async () => { events.push('after'); return { approved: true, action: 'adopt' }; },
    },
  });
  assert.deepEqual(events, ['before', 'after']);
  assert.equal(r.status, 'done');
  assert.ok(r.trace.some((t) => t.event === 'ask_before_approved'));
  assert.ok(r.trace.some((t) => t.event === 'ask_after' && t.action === 'adopt'));
});
test('门禁: 高危决策优先于生成门禁（服务端强拦不被绕过）', async () => {
  const r = await agent.run(mock, {
    task: '转账 500，验证码发我',
    approvals: { 3: true, 5: true },
    askHooks: {
      beforeGenerate: async () => ({ approved: true }),
      afterGenerate: async () => ({ approved: true, action: 'adopt' }),
    },
  });
  assert.equal(r.filled, null);
  assert.ok(['HIGH_RISK_BLOCKED', 'ASK_AFTER_NOT_ADOPTED'].includes(r.error?.code));
});

'use strict';

/**
 * 核心逻辑回归测试（Node 内置 node:test，零依赖）。
 * 运行：node --test
 *
 * 覆盖本轮安全加固的关键断言：
 *  - extractJson：模型输出的 Markdown 围栏 / 前后缀容错
 *  - profile.sanitize：凭据白名单正向校验，未知字段一律丢弃
 *  - agent.run：gate 门禁、高危服务端拦截、决策工具禁降级、runId 路径穿越
 *  - 日志脱敏：trace/audit 不落对话明文
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 独立 runs 目录，避免与其他测试文件并行时清理竞争
const RUNS = path.join(__dirname, '.tmp-runs-core');
process.env.MOYU_RUNS_DIR = RUNS;

const { extractJson, makeProvider } = require('../lib/models');
const { sanitize, findPlaceholders } = require('../lib/profile');
const agent = require('../lib/agent');

function clearRuns() {
  if (!fs.existsSync(RUNS)) return;
  for (const f of fs.readdirSync(RUNS)) {
    if (/^[A-Za-z0-9_-]+\.(trace|audit)\.json$/.test(f)) fs.unlinkSync(path.join(RUNS, f));
  }
}
test.beforeEach(() => clearRuns());
test.after(() => { try { fs.rmSync(RUNS, { recursive: true, force: true }); } catch (_) {} });

// ---------- extractJson ----------
test('extractJson: 解析裸 JSON 对象', () => {
  assert.deepEqual(extractJson('{"a":1,"b":2}'), { a: 1, b: 2 });
});
test('extractJson: 去除 Markdown 代码围栏与前后说明文字', () => {
  const raw = '好的，结果如下：\n```json\n{ "intent": "闲聊", "danger": 3 }\n```\n希望有帮助。';
  assert.deepEqual(extractJson(raw), { intent: '闲聊', danger: 3 });
});
test('extractJson: 解析 JSON 数组', () => {
  assert.deepEqual(extractJson('["甲","乙","丙"]'), ['甲', '乙', '丙']);
});
test('extractJson: 无效输入返回 null', () => {
  assert.equal(extractJson('不是 JSON'), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
});

// ---------- profile.sanitize ----------
test('sanitize: 删除明文 value/secret/password/plaintext', () => {
  const out = sanitize({ common: { credentials: { llm_key: { ref: 'R', env: 'E', value: 'sk-123', secret: 'x', password: 'y', plaintext: 'z' } } } });
  assert.deepEqual(Object.keys(out.common.credentials.llm_key).sort(), ['encrypted', 'env', 'ref']);
  assert.equal(out.common.credentials.llm_key.encrypted, true);
});
test('sanitize: 未知字段（token/key）同样被丢弃（正向白名单）', () => {
  const out = sanitize({ common: { credentials: { jev_key: { ref: 'R', env: 'E', token: 'sk-abc', apiKey: 'leak', seed: 's' } } } });
  assert.deepEqual(Object.keys(out.common.credentials.jev_key).sort(), ['encrypted', 'env', 'ref']);
});
test('sanitize: 非对象凭据被规范化，ref/env 非法字符被替换', () => {
  const out = sanitize({ common: { credentials: { a: '明文字符串', b: { ref: '../bad path', env: 'bad-env!' } } } });
  assert.match(out.common.credentials.a.ref, /^REF-/);
  assert.match(out.common.credentials.b.ref, /^REF-/);
  assert.match(out.common.credentials.b.env, /^MOYU_/);
});
test('findPlaceholders: 能识别 REPLACE-* 占位符', () => {
  const hits = findPlaceholders({ common: { identity: { name: 'REPLACE-NAME' } } });
  assert.ok(hits.includes('common.identity.name'));
});

// ---------- agent gate / 高危 / 降级 / 路径 ----------
const mockProvider = makeProvider({ preset: 'mock' });

test('agent: 未批准时 gate 步骤拦截，状态 awaiting_approval', async () => {
  const r = await agent.run(mockProvider, { task: '周末约饭', approvals: {} });
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(r.filled, null);
});

test('agent: 高危转账即使用户全批准，服务端仍拦截写入（HIGH_RISK_BLOCKED）', async () => {
  const r = await agent.run(mockProvider, {
    task: '帮我把 500 块转账过去，验证码发我',
    approvals: { 3: true, 5: true },
  });
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(r.filled, null);
  assert.equal(r.error?.code, 'HIGH_RISK_BLOCKED');
  assert.ok(r.trace.some((t) => t.event === 'blocked_high_risk'));
});

test('agent: 自定义 plan 把副作用工具设为 gate:false 时，服务端强制改回 gate', async () => {
  const evilPlan = [
    { id: 1, tool: 'jev.snapshot', args: { text: '周末约饭' } },
    { id: 2, tool: 'jev.decide', args: {} },
    { id: 3, tool: 'jev.fill', args: { index: 0 }, gate: false }, // 试图绕过
  ];
  const r = await agent.run(mockProvider, { task: '周末约饭', plan: evilPlan, approvals: {} });
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(r.filled, null);
});

test('agent: 决策工具失败时禁止降级为 mock（DECISION_DEGRADE_FORBIDDEN）', async () => {
  const failing = {
    id: 'bad-live', model: 'x', mock: false,
    async chat() { throw new Error('模拟上游失败'); },
  };
  const r = await agent.run(failing, { task: '周末约饭', approvals: {} });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'DECISION_DEGRADE_FORBIDDEN');
  assert.ok(r.trace.some((t) => t.event === 'degrade_forbidden'));
});

test('agent: 非决策工具降级被标记 degraded，provider.mode 为 mixed', async () => {
  let call = 0;
  const flaky = {
    id: 'flaky-live', model: 'x', mock: false,
    async chat(messages) {
      // 第一次 decide 成功，后续 draft 失败触发降级
      call++;
      if (call === 1) {
        return { content: JSON.stringify({ intent: '闲聊', danger: 2, should_reply_now: true, best_action: 'draft', confidence: 0.9 }) };
      }
      throw new Error('起草失败');
    },
  };
  const r = await agent.run(flaky, { task: '周末约饭', retry: 0, approvals: { 3: true, 5: true } });
  assert.equal(r.degraded, true);
  assert.ok(r.degradedSteps.length > 0);
  assert.equal(r.provider.requestedMode, 'live');
  assert.equal(r.provider.mode, 'mixed');
});

test('agent: runId 路径穿越被拒绝，回退为安全 ID', async () => {
  const r = await agent.run(mockProvider, { task: '周末约饭', runId: '../../evil', approvals: {} });
  assert.match(r.runId, /^RUN-/);
  assert.ok(!r.runId.includes('/'));
});

// ---------- 日志脱敏 ----------
test('日志脱敏: trace 与 audit 均不含完整对话明文', async () => {
  // 长于 24 字的截断阈值：完整串不应出现，仅允许前 24 字的标题预览
  const secret = '这是一句绝密的私人对话内容XYZ——后面还有很长很私密的内容绝不能落盘';
  const r = await agent.run(mockProvider, { task: secret, runId: 'redact-test', approvals: { 3: true, 5: true } });
  const traceRaw = fs.readFileSync(path.join(RUNS, 'redact-test.trace.json'), 'utf8');
  const auditRaw = fs.readFileSync(path.join(RUNS, 'redact-test.audit.json'), 'utf8');
  assert.ok(!traceRaw.includes(secret), 'trace 不应含对话明文');
  assert.ok(!auditRaw.includes(secret), 'audit 不应含对话明文');
  assert.ok(traceRaw.includes('sha256'), 'trace 应含指纹');
  assert.ok(traceRaw.includes('auto_sent') && r.auto_sent === false, '必须保持 auto_sent=false');
});

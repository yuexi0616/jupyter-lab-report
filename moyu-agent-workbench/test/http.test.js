'use strict';

/**
 * HTTP 层集成测试（Node 内置 node:test，零依赖）。
 * 在独立端口拉起真实 server.js 子进程，验证：
 *  - 访问控制四道防线（Host / token / Origin）
 *  - 四个版块方案数据由后端统一提供（含作业母版）
 *  - 所有版块计划统一走后端 /api/plan
 *  - 审批 token 的一次性 / 绑定 / 高危强拦
 * 运行：node --test（会与 core.test.js 一起执行，端口独立互不干扰）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');

const PORT = 3187 + (process.pid % 100); // 规避与其他测试/服务冲突
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server.js');
let child;

async function waitReady(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server 启动超时');
}

async function api(pathname, { method = 'GET', token, host, origin, body } = {}) {
  const headers = {};
  if (token) headers['X-Moyu-Token'] = token;
  if (host) headers['Host'] = host;
  if (origin) headers['Origin'] = origin;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

test.before(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MOYU_PORT: String(PORT), MOYU_RUNS_DIR: path.join(__dirname, '.tmp-runs-http') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
});
test.after(() => {
  if (child && !child.killed) child.kill();
  try { require('fs').rmSync(path.join(__dirname, '.tmp-runs-http'), { recursive: true, force: true }); } catch (_) {}
});

async function fetchToken() {
  const html = await (await fetch(BASE + '/')).text();
  const m = html.match(/name="moyu-token" content="([a-f0-9]+)"/);
  assert.ok(m, '首页应注入会话 token');
  return m[1];
}

// ---------- 访问控制 ----------
test('HTTP: 无 token 访问 API 被拒（401）', async () => {
  const r = await api('/api/meta');
  assert.equal(r.status, 401);
});
test('HTTP: 伪造 Host（DNS rebinding）被拒（403）', async () => {
  // fetch/undici 不允许覆盖 Host 头，改用原生 http 才能真实模拟 DNS rebinding 的外来 Host
  const http = require('node:http');
  const token = await fetchToken();
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/meta', method: 'GET',
      headers: { Host: 'evil.example.com', 'X-Moyu-Token': token },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});
test('HTTP: 跨站 Origin 写操作被拒（403）', async () => {
  const token = await fetchToken();
  const r = await api('/api/agent/approval', { method: 'POST', token, origin: 'https://evil.example.com', body: { steps: [3, 5] } });
  assert.equal(r.status, 403);
});
test('HTTP: 带 token 同源请求正常（200）', async () => {
  const token = await fetchToken();
  const r = await api('/api/meta', { token });
  assert.equal(r.status, 200);
  assert.ok(r.json.version);
});

// ---------- 方案数据单一事实源 ----------
test('HTTP: /api/sections 含四个版块（含作业母版 homework）', async () => {
  const token = await fetchToken();
  const r = await api('/api/sections', { token });
  assert.equal(r.status, 200);
  const ids = r.json.map((s) => s.id).sort();
  assert.deepEqual(ids, ['course_auto', 'homework', 'jev_reply', 'project_lab']);
});
test('HTTP: /api/sections/homework 返回完整详情', async () => {
  const token = await fetchToken();
  const r = await api('/api/sections/homework', { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.codename, 'jupyter_lab_report');
  assert.ok(Array.isArray(r.json.projects) && r.json.projects.length > 0);
});
test('HTTP: /api/projects/search 已含作业母版项目（前端无需拼接）', async () => {
  const token = await fetchToken();
  const r = await api('/api/projects/search', { token });
  assert.equal(r.status, 200);
  assert.ok(r.json.some((p) => p.section === '作业版块'));
});

// ---------- 计划统一由后端生成 ----------
test('HTTP: 四个版块都能由 /api/plan 生成计划，且作业用 notebook 步骤', async () => {
  const token = await fetchToken();
  for (const id of ['jev_reply', 'course_auto', 'homework', 'project_lab']) {
    const r = await api('/api/plan', { method: 'POST', token, body: { sectionId: id, task: '测试任务' } });
    assert.equal(r.status, 200, `${id} 应能生成计划`);
    assert.ok(Array.isArray(r.json.steps) && r.json.steps.length >= 5, `${id} 步骤数异常`);
  }
  const hw = await api('/api/plan', { method: 'POST', token, body: { sectionId: 'homework', task: 'x' } });
  assert.ok(hw.json.steps.some((s) => s.cmd.includes('notebook')), '作业计划应含 notebook 步骤');
});

// ---------- 审批凭证 ----------
test('HTTP: 审批凭证一次性——同一 token 用第二次被拒（403）', async () => {
  const token = await fetchToken();
  const grant = await api('/api/agent/approval', { method: 'POST', token, body: { steps: [3, 5] } });
  assert.equal(grant.status, 200);
  assert.deepEqual(grant.json.steps, [3, 5]);
  const body = { preset: 'mock', task: '周末约饭', approvalToken: grant.json.token };
  const first = await api('/api/agent/run', { method: 'POST', token, body });
  assert.equal(first.status, 200);
  const second = await api('/api/agent/run', { method: 'POST', token, body });
  assert.equal(second.status, 403);
  assert.match(second.json.error, /凭证|过期|无效/);
});
test('HTTP: 无凭证时 gate 拦截，状态 awaiting_approval', async () => {
  const token = await fetchToken();
  const r = await api('/api/agent/run', { method: 'POST', token, body: { preset: 'mock', task: '周末约饭' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'awaiting_approval');
});
test('HTTP: 高危即使持有效凭证也被服务端强拦（HIGH_RISK_BLOCKED）', async () => {
  const token = await fetchToken();
  const grant = await api('/api/agent/approval', { method: 'POST', token, body: { steps: [3, 5] } });
  const r = await api('/api/agent/run', {
    method: 'POST', token,
    body: { preset: 'mock', task: '帮我把 500 块转账过去，验证码发我', approvalToken: grant.json.token },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'awaiting_approval');
  assert.equal(r.json.filled, null);
  assert.equal(r.json.error?.code, 'HIGH_RISK_BLOCKED');
});
test('HTTP: 审批凭证无效字符串被拒（403）', async () => {
  const token = await fetchToken();
  const r = await api('/api/agent/run', { method: 'POST', token, body: { preset: 'mock', task: 'hi', approvalToken: 'fake-token' } });
  assert.equal(r.status, 403);
});

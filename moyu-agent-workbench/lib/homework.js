'use strict';

/**
 * 作业能力层（P2 · 设计文档 v2 §3.2 / §16）
 *
 * 母版 = jupyter-lab-report（内部模板）的确定性 SOP：
 *   doctor → check → cover → build → run → audit → deliver → clean → pack
 *
 * 本模块定义适配契约 + 可跑通离线闭环（mock），不 vendored 模板源码：
 *   - mock 后端：生成 notebook 骨架（JSON）、模拟单元执行产物、脱敏检查、结论-输出追溯；
 *   - bridge 后端（可插拔）：对接真实 jupyter 执行器，未就绪时拒绝，不伪造产物。
 *
 * 硬边界 + U2：
 *   - 不代写、不伪造数据；AI 生成边界按课程规则标注（披露声明）；
 *   - 骨架生成属生成类动作 → 需生成前询问授权 token；
 *   - 报告导出属交付动作 → 需生成后询问"采用"确认；
 *   - 封面/署名/路径必须脱敏，检测 REPLACE-* 占位与真实姓名泄漏。
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.MOYU_HOMEWORK_STATE_DIR
  ? path.resolve(process.env.MOYU_HOMEWORK_STATE_DIR)
  : path.join(__dirname, '..', 'runs', 'homework');
const BRIDGE_ENDPOINT = process.env.MOYU_HOMEWORK_BRIDGE || 'http://127.0.0.1:11438';
const TIMEOUT = Number(process.env.MOYU_HOMEWORK_TIMEOUT || 3000);

const STEPS = Object.freeze(['doctor', 'check', 'cover', 'build', 'run', 'audit', 'deliver', 'clean', 'pack']);
// 需要在封面脱敏的字段示例（占位档案沿用 profile.json 的 REPLACE-* 约定）
const PII_FIELDS = ['name', 'author', 'student_id', 'workdir', 'email'];

function ensureDir() { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); }
function stateFile(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('非法 sessionId');
  return path.join(STATE_DIR, id + '.json');
}
function save(s) { ensureDir(); fs.writeFileSync(stateFile(s.sessionId), JSON.stringify(s, null, 2), 'utf8'); return s; }

/** 生成 notebook 骨架（mock 实现：合法的 .ipynb JSON 结构，占位单元） */
function buildNotebook(title) {
  return {
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: [`# ${String(title || '作业题目').slice(0, 120)}\n`, '\n', '> 占位骨架 · AI 生成边界按课程规则标注\n'] },
      { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: ['# TODO: 数据输入与假设\n'] },
      { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: ['# TODO: 建模与计算\n'] },
      { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: ['# TODO: 图表输出（结论须可追溯到本单元输出）\n'] },
    ],
  };
}

/** 脱敏检查：检测占位符与疑似真实姓名/路径泄漏 */
function checkSanitization(profile, mockLeak) {
  const issues = [];
  const json = JSON.stringify(profile || {});
  if (/REPLACE-/.test(json)) issues.push('存在 REPLACE-* 占位字段，doctor/check 应拒绝');
  if (mockLeak) {
    // 测试注入的泄漏样例
    for (const f of PII_FIELDS) if (mockLeak[f]) issues.push(`疑似真实信息泄漏字段: ${f}`);
  }
  return { pass: issues.length === 0, issues };
}

/** 结论-输出追溯：每条结论必须绑定一个单元输出 id */
function checkTrace(claims) {
  const issues = [];
  (claims || []).forEach((c, i) => {
    if (!c || !c.claim) issues.push(`结论 #${i + 1} 缺少文本`);
    else if (!c.outputId) issues.push(`结论「${String(c.claim).slice(0, 20)}」无对应单元输出（不可追溯）`);
  });
  return { pass: issues.length === 0, issues };
}

/** doctor：环境体检（mock 返回通过，标 simulated） */
function doctor() {
  return { ok: true, checks: [{ name: 'kernel', ok: true }, { name: 'template', ok: true }, { name: 'profile', ok: true }], simulated: true };
}

/** 创建作业会话。骨架生成需 U2 生成前询问授权 token。 */
async function createSession({ title, totalCells, genAuthToken, sessionId } = {}) {
  if (!genAuthToken) {
    const err = new Error('生成 notebook 骨架属于生成类动作，需 U2 生成前询问授权 token（genAuthToken）。');
    err.code = 'ASK_BEFORE_REQUIRED';
    throw err;
  }
  const sid = /^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId || '')) ? sessionId : 'H-' + Date.now().toString(36).toUpperCase();
  const notebook = buildNotebook(title);
  const cells = Math.max(1, Math.min(200, Number(totalCells) || notebook.cells.length));
  const s = {
    sessionId: sid, title: String(title || '作业题目').slice(0, 120),
    status: 'running', stage: 'check',
    genAuth: { token: String(genAuthToken).slice(0, 128), at: new Date().toISOString() },
    simulated: true,
    notebook: { cells: notebook.cells.length, executed: 0, total: cells },
    artifacts: [`notebooks/${sid}.ipynb`],
    audit: { claims: [], sanitization: null, trace: null },
    sideEffects: ['已生成 notebook 骨架（AI 生成边界需按课程规则标注）'],
    externalVersions: { template: 'jupyter-lab-report' },
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  return save(s);
}

/** 推进 SOP 到下一阶段 */
async function advance(sessionId, opts = {}) {
  const f = stateFile(sessionId);
  if (!fs.existsSync(f)) throw new Error('会话不存在');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.status === 'done') return s;
  const i = STEPS.indexOf(s.stage);
  const cur = STEPS[i];
  if (cur === 'check') {
    const r = checkSanitization(opts.profile, opts.mockLeak);
    s.audit.sanitization = r;
    if (!r.pass) { s.status = 'blocked'; s.sideEffects.push('check 未通过：' + r.issues.join('；')); return save(s); }
  }
  if (cur === 'run') {
    const n = Math.max(1, Math.min(10, Number(opts.cells) || 1));
    s.notebook.executed = Math.min(s.notebook.total, s.notebook.executed + n);
    s.sideEffects.push(`执行单元 ${s.notebook.executed}/${s.notebook.total}（模拟）`);
  }
  if (cur === 'audit') {
    const r = checkTrace(opts.claims || s.audit.claims);
    s.audit.trace = r;
    if (!r.pass) { s.status = 'blocked'; s.sideEffects.push('audit 未通过：' + r.issues.join('；')); return save(s); }
  }
  if (cur === 'deliver') {
    // U2 生成后询问：报告交付需"采用"确认
    if (opts.adopt !== true) {
      const err = new Error('报告交付需 U2 生成后询问"采用"确认（adopt=true）。');
      err.code = 'ASK_AFTER_REQUIRED';
      throw err;
    }
    s.artifacts.push(`reports/${s.sessionId}.md`, `reports/${s.sessionId}.pdf`);
    s.sideEffects.push('报告已生成（含 AI 生成披露声明），待用户确认提交');
  }
  const next = STEPS[i + 1];
  if (next) s.stage = next;
  else { s.stage = 'done'; s.status = 'done'; }
  s.updatedAt = new Date().toISOString();
  return save(s);
}

function getSession(id) {
  const f = stateFile(id);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function listSessions() {
  ensureDir();
  return fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try { const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); return { sessionId: s.sessionId, title: s.title, status: s.status, stage: s.stage, simulated: s.simulated }; }
    catch (_) { return { file: f, status: 'corrupt' }; }
  }).reverse();
}
function deleteSession(id) {
  const f = stateFile(id);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f); return true;
}

module.exports = {
  STEPS, PII_FIELDS, doctor, buildNotebook, checkSanitization, checkTrace,
  createSession, advance, getSession, listSessions, deleteSession,
};

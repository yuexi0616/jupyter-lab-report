'use strict';

/**
 * 毕设/竞赛能力层（P3 · 设计文档 v2 §3.3 / §16）
 *
 * 借鉴 MIT 许可项目（yohanchen1/MathModelingAgent 的 Claim/Obligation/Evidence +
 * 独立 audit skill；handsomeZR/mathmodel-skill 的 10 阶段）——自研实现，不 vendored。
 * 六阶段：topic → research → experiment → verify → write → review
 *
 * 核心机制（反幻觉，学术诚信底线）：
 *   - 每条关键结论登记为 Claim，附带 Obligation（验证义务）与 Evidence（证据）；
 *   - 证据不足保持 INCONCLUSIVE，绝不因"看起来合理"升级 PASS；
 *   - 数字必须绑定到产物 id（number freezing），引用必须绑定来源 id；
 *   - 生成类动作（research/write）需 U2 生成前询问授权；提交需生成后采用确认。
 *
 * mock 后端产出模拟证据链，独立 evaluator 仍会判 INCONCLUSIVE——不把模拟当真实交付。
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.MOYU_PROJECT_STATE_DIR
  ? path.resolve(process.env.MOYU_PROJECT_STATE_DIR)
  : path.join(__dirname, '..', 'runs', 'project');
const STAGES = Object.freeze(['topic', 'research', 'experiment', 'verify', 'write', 'review']);
const VERDICTS = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE']);

function ensureDir() { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); }
function stateFile(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('非法 sessionId');
  return path.join(STATE_DIR, id + '.json');
}
function save(s) { ensureDir(); fs.writeFileSync(stateFile(s.sessionId), JSON.stringify(s, null, 2), 'utf8'); return s; }

/** 登记一条 Claim（结论 + 义务 + 证据，证据缺省则 INCONCLUSIVE） */
function registerClaim(claim, evidenceRefs, frozenNumbers) {
  const c = {
    id: 'C' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000),
    claim: String(claim || '').slice(0, 300),
    obligation: '需绑定到可复现的实验产物与来源',
    evidence: Array.isArray(evidenceRefs) ? evidenceRefs.map((e) => String(e).slice(0, 80)) : [],
    numbers: Array.isArray(frozenNumbers) ? frozenNumbers.map((n) => String(n).slice(0, 40)) : [],
  };
  c.verdict = decideVerdict(c);
  return c;
}

/** 证据驱动裁决：无证据或数字未冻结 → INCONCLUSIVE；证据充分 → PASS；显式失败标记 → FAIL */
function decideVerdict(c) {
  if (!c || !c.claim) return 'FAIL';
  if (c.explicitFail === true) return 'FAIL';
  if (!c.evidence.length) return 'INCONCLUSIVE';
  if (c.numbers.length && !c.evidence.some((e) => /result|csv|out|cell/i.test(e))) return 'INCONCLUSIVE';
  return 'PASS';
}

/** 数字冻结：论文中每个数字必须来自产物 id */
function freezeNumber(value, sourceId) {
  if (sourceId == null || sourceId === '') return { ok: false, reason: '数字缺少来源产物 id（数字冻结失败）' };
  return { ok: true, value: String(value).slice(0, 40), sourceId: String(sourceId).slice(0, 80) };
}

/** 引用完整性：每条 cite 必须有 source */
function checkCitations(cites) {
  const issues = [];
  (cites || []).forEach((c, i) => {
    if (!c || !c.text) issues.push(`引用 #${i + 1} 空`);
    else if (!c.sourceId) issues.push(`引用「${String(c.text).slice(0, 20)}」无来源 id`);
  });
  return { pass: issues.length === 0, issues };
}

/** 创建竞赛会话：研究/写作属生成类，需 U2 生成前询问授权 */
async function createSession({ topic, genAuthToken, sessionId } = {}) {
  if (!genAuthToken) {
    const err = new Error('竞赛检索/写作属生成类动作，需 U2 生成前询问授权 token（genAuthToken）。');
    err.code = 'ASK_BEFORE_REQUIRED';
    throw err;
  }
  const sid = /^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId || '')) ? sessionId : 'M-' + Date.now().toString(36).toUpperCase();
  const s = {
    sessionId: sid, topic: String(topic || '未命名赛题').slice(0, 200),
    status: 'running', stage: 'research',
    genAuth: { token: String(genAuthToken).slice(0, 128), at: new Date().toISOString() },
    simulated: true,
    claims: [], frozenNumbers: [], citations: [],
    artifacts: [],
    sideEffects: ['已登记生成前授权；进入证据驱动流程'],
    externalVersions: { method: 'MIT-mathmodeling-agent-reference' },
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  return save(s);
}

/** 推进阶段 */
async function advance(sessionId, opts = {}) {
  const f = stateFile(sessionId);
  if (!fs.existsSync(f)) throw new Error('会话不存在');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.status === 'done') return s;
  const i = STAGES.indexOf(s.stage);
  const cur = STAGES[i];

  if (cur === 'research' && Array.isArray(opts.sources)) {
    s.artifacts.push(...opts.sources.slice(0, 20).map((x) => 'sources/' + String(x).slice(0, 60)));
  }
  if (cur === 'experiment' && Array.isArray(opts.results)) {
    s.artifacts.push(...opts.results.slice(0, 20).map((x) => 'results/' + String(x).slice(0, 60)));
  }
  if (cur === 'verify') {
    if (opts.claims && Array.isArray(opts.claims)) opts.claims.forEach((c) => s.claims.push(registerClaim(c.claim, c.evidence, c.numbers)));
    if (opts.numbers && Array.isArray(opts.numbers)) opts.numbers.forEach((n) => s.frozenNumbers.push(freezeNumber(n.value, n.sourceId)));
    const citeCheck = checkCitations(opts.citations);
    if (!citeCheck.pass) { s.status = 'blocked'; s.sideEffects.push('引用完整性未通过：' + citeCheck.issues.join('；')); return save(s); }
    s.citations = opts.citations || [];
    // 数字冻结失败即阻断（反幻觉门控）
    const bad = s.frozenNumbers.filter((n) => !n.ok);
    if (bad.length) { s.status = 'blocked'; s.sideEffects.push('数字冻结失败：' + bad.map((b) => b.reason).join('；')); return save(s); }
  }
  if (cur === 'write' && opts.adopt !== true) {
    const err = new Error('论文写作/交付需 U2 生成后询问"采用"确认（adopt=true）。');
    err.code = 'ASK_AFTER_REQUIRED';
    throw err;
  }
  if (cur === 'write') {
    s.artifacts.push('paper/' + s.sessionId + '.typ', 'paper/' + s.sessionId + '.pdf');
    s.sideEffects.push('已生成论文（含 AI 生成披露声明），待独立评审');
  }
  const next = STAGES[i + 1];
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
    try { const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); return { sessionId: s.sessionId, topic: s.topic, status: s.status, stage: s.stage, simulated: s.simulated }; }
    catch (_) { return { file: f, status: 'corrupt' }; }
  }).reverse();
}
function deleteSession(id) {
  const f = stateFile(id);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f); return true;
}

module.exports = {
  STAGES, VERDICTS, registerClaim, decideVerdict, freezeNumber, checkCitations,
  createSession, advance, getSession, listSessions, deleteSession,
};

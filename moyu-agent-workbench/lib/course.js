'use strict';

/**
 * 刷课能力层（P1 · 设计文档 v2 §3.1 / §16）
 *
 * 能力底座 = OCS 助手（ocsjs/ocsjs, MIT）支持的平台；本模块不 vendored OCS 源码，
 * 而是定义"平台识别 + 进度机 + 断点续播 + 验证码转人工"的适配契约，
 * 提供两种后端：
 *   - mock（默认）：离线模拟进度推进，保证闭环与测试，明确标记 simulated=true
 *   - bridge（可插拔）：通过本地 HTTP bridge 与实际浏览器/OCS 脚本交互；
 *     bridge 未就绪时拒绝启动（不假装成功）
 *
 * 硬边界（U1）与 K4（用户决定不保守处理）：
 *   - 只推进度、不改成绩、不产证书；
 *   - "自动答题"默认关闭，但**允许显式开启**——开启时必须携带 U2 生成前询问的
 *     一次性授权 token（askBeforeGenerate 签发），把学术诚信责任交还用户显式确认，
 *     而不是由本工具一刀切禁止；
 *   - 遇验证码/2FA 立即暂停转人工。
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.MOYU_COURSE_STATE_DIR
  ? path.resolve(process.env.MOYU_COURSE_STATE_DIR)
  : path.join(__dirname, '..', 'runs', 'course');
const BRIDGE_ENDPOINT = process.env.MOYU_COURSE_BRIDGE || 'http://127.0.0.1:11437';
const BRIDGE_TIMEOUT = Number(process.env.MOYU_COURSE_TIMEOUT || 3000);

// OCS 官方支持平台（快照 2026-11），id 为内部规范名
const PLATFORMS = Object.freeze({
  chaoxing: { name: '超星学习通', match: /chaoxing|学习通|fanya/i },
  zhihuishu: { name: '知到智慧树', match: /zhihuishu|智慧树|知到/i },
  zhijiaoyun: { name: '职教云', match: /zhijiaoyun|职教云/i },
  zhijiaozhijiao: { name: '智慧职教', match: /icve|智慧职教/i },
  icourse163: { name: '中国大学MOOC', match: /icourse163|中国大学mooc/i },
});

function ensureDir() { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); }
function stateFile(sessionId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId || ''))) throw new Error('非法 sessionId');
  return path.join(STATE_DIR, sessionId + '.json');
}

/** 依据 URL/标题识别平台；未知平台明确拒绝，不硬编码猜测选择器 */
function detectPlatform(urlOrTitle) {
  const s = String(urlOrTitle || '');
  for (const [id, p] of Object.entries(PLATFORMS)) if (p.match.test(s)) return { id, name: p.name };
  return null;
}

/** mock 后端进度推进：按 tick 前进，遇到验证码符号则暂停转人工 */
function mockAdvance(state, tick) {
  const p = state.progress;
  const captchaAt = state.mockCaptchaAt; // 可注入的验证码触发点（测试用）
  if (captchaAt != null && p.current + tick >= captchaAt && !state.captchaHandled) {
    state.captchaHandled = true;
    state.status = 'awaiting_human';
    state.sideEffects.push('检测到验证码/人机验证，已暂停转人工');
    return;
  }
  p.current = Math.min(p.total, p.current + tick);
  state.sideEffects.push(`播放进度 ${p.current}/${p.total}`);
  if (state.autoAnswer) state.sideEffects.push(`[已授权] 自动答题 ${tick} 题（结果未经人工核对，学术诚信责任由用户承担）`);
  if (p.current >= p.total) state.status = 'done';
}

/** bridge 后端：调用本地 bridge；不可用抛错，不降级为 mock */
async function bridgeCall(action, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT);
  try {
    const resp = await fetch(BRIDGE_ENDPOINT.replace(/\/$/, '') + '/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('bridge HTTP ' + resp.status);
    return await resp.json();
  } catch (e) {
    const err = new Error('刷课 bridge 不可用：' + e.message + '（拒绝模拟，避免伪造进度）');
    err.code = 'COURSE_BRIDGE_UNAVAILABLE';
    throw err;
  } finally { clearTimeout(timer); }
}

function describeBackends() {
  return {
    defaultBackend: process.env.MOYU_COURSE_BACKEND === 'bridge' ? 'bridge' : 'mock',
    bridgeEndpoint: BRIDGE_ENDPOINT,
    platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, name: p.name })),
    autoAnswerDefault: false,
    autoAnswerPolicy: 'default-off-but-allowed-with-U2-authorization',
    boundary: '只推进度，不改成绩，不产证书；自动答题默认关闭但可显式开启（须 U2 生成前询问授权 token）；验证码转人工',
  };
}

/** 创建刷课会话 */
async function createSession({ url, total, backend, autoAnswer, answerAuthToken, sessionId } = {}) {
  const plat = detectPlatform(url);
  if (!plat) throw new Error('未识别的平台（支持：' + Object.values(PLATFORMS).map((p) => p.name).join('、') + '）');
  const sid = /^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId || '')) ? sessionId : 'C-' + Date.now().toString(36).toUpperCase();
  const useBridge = (backend || process.env.MOYU_COURSE_BACKEND || 'mock') === 'bridge';
  // K4：允许显式开启自动答题，但必须携带 U2 生成前询问的一次性授权 token。
  // 无 token 不静默关闭也不静默开启——明确报错，把选择权与责任交还用户。
  const wantsAutoAnswer = autoAnswer === true || autoAnswer === 'true';
  if (wantsAutoAnswer && !answerAuthToken) {
    const err = new Error('开启自动答题需要 U2 生成前询问授权 token（answerAuthToken）。请先经生成前询问确认后再开启。');
    err.code = 'AUTO_ANSWER_AUTH_REQUIRED';
    throw err;
  }
  const state = {
    sessionId: sid, platform: plat, url: String(url || '').slice(0, 500),
    status: 'running', backend: useBridge ? 'bridge' : 'mock',
    simulated: !useBridge,
    progress: { current: 0, total: Math.max(1, Math.min(10000, Number(total) || 10)), unit: 'chapter' },
    autoAnswer: wantsAutoAnswer,
    answerAuth: wantsAutoAnswer ? { token: String(answerAuthToken).slice(0, 128), authorizedAt: new Date().toISOString() } : null,
    captchaHandled: false,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    sideEffects: wantsAutoAnswer ? ['已按用户显式授权开启自动答题（学术诚信责任由用户承担）'] : [],
    externalVersions: { ocs: 'v5.4.0' },
  };
  ensureDir();
  fs.writeFileSync(stateFile(sid), JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/** 推进一个 tick */
async function tick(sessionId, { steps = 1, mockCaptchaAt } = {}) {
  const f = stateFile(sessionId);
  if (!fs.existsSync(f)) throw new Error('会话不存在');
  const state = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (state.status === 'done' || state.status === 'awaiting_human') return state;
  if (state.status === 'paused') {
    const err = new Error('会话已暂停，无法推进（断点续播需先恢复）');
    err.code = 'COURSE_PAUSED';
    throw err;
  }
  if (mockCaptchaAt != null) state.mockCaptchaAt = mockCaptchaAt;
  const n = Math.max(1, Math.min(50, Number(steps) || 1));
  if (state.backend === 'bridge') {
    const r = await bridgeCall('tick', { sessionId, steps: n });
    state.progress.current = Number(r.current) || state.progress.current;
    state.status = r.status || state.status;
    if (r.captcha) { state.status = 'awaiting_human'; state.sideEffects.push('bridge 报告验证码，已暂停转人工'); }
  } else {
    mockAdvance(state, n);
  }
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/** 暂停 / 恢复（断点续播） */
function pause(sessionId) {
  const f = stateFile(sessionId);
  if (!fs.existsSync(f)) throw new Error('会话不存在');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.status === 'awaiting_human') throw new Error('验证码待人工处理，无法暂停');
  s.status = s.status === 'paused' ? 'running' : 'paused';
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
  return s;
}

/** 人工处理完验证码后恢复 */
function resumeAfterHuman(sessionId) {
  const f = stateFile(sessionId);
  if (!fs.existsSync(f)) throw new Error('会话不存在');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.status !== 'awaiting_human') throw new Error('当前无需人工处理');
  s.status = 'running'; s.captchaHandled = true;
  s.sideEffects.push('人工已处理验证码，恢复播放');
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
  return s;
}

function getSession(sessionId) {
  const f = stateFile(sessionId);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function listSessions() {
  ensureDir();
  return fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try { const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); return { sessionId: s.sessionId, platform: s.platform?.name, status: s.status, progress: s.progress, simulated: s.simulated, updatedAt: s.updatedAt }; }
    catch (_) { return { file: f, status: 'corrupt' }; }
  }).reverse();
}
function deleteSession(sessionId) {
  const f = stateFile(sessionId);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f); return true;
}

module.exports = {
  PLATFORMS, detectPlatform, describeBackends,
  createSession, tick, pause, resumeAfterHuman, getSession, listSessions, deleteSession,
};

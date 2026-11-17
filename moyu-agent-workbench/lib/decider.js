'use strict';

/**
 * 决策器抽象层（P0 · 设计文档 §8.3）
 *
 * 把"Jev 决策"从具体后端解耦，支持三种后端：
 *   - mock   （默认）：沿用 provider.chat + extractJson —— 保持既有 mock 闭环与回归测试
 *   - llm    ：显式走 provider.chat（语义别名，等价 mock）
 *   - anyjev ：本地 AnyJev HTTP 服务（tools_python/anyjev_server.py）
 *
 * 安全红线（对齐 agent.js 的 DECISION_TOOLS 策略）：
 *   backend=anyjev 时服务不可用 → 抛错转人工，绝不静默降级到 mock。
 *   mock 的高危判断依赖关键词，语义型高危会漏判，一旦被当成真实决策驱动 fill
 *   将突破 fill-only 红线。
 *
 * 无论哪个后端，最终都会过一遍"高危关键词硬兜底"——这是独立于分类器的第二道防线。
 */

const fs = require('fs');
const path = require('path');
const { extractJson } = require('./models');

const VALID_BACKENDS = new Set(['mock', 'llm', 'anyjev']);
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'decider.json');

/** 高危关键词兜底（独立于后端分类器的第二道防线） */
const HIGH_RISK_RE = /转账|借钱|红包|验证码|密码|银行卡|付款|汇款|支付密码/;

function loadConfig() {
  let cfg = {};
  try { if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
  const backend = String(process.env.MOYU_DECIDER_BACKEND || cfg.backend || 'mock').toLowerCase();
  return {
    backend: VALID_BACKENDS.has(backend) ? backend : 'mock',
    endpoint: process.env.MOYU_ANYJEV_ENDPOINT || cfg.endpoint || 'http://127.0.0.1:11436',
    timeoutMs: Number(process.env.MOYU_ANYJEV_TIMEOUT || cfg.timeoutMs || 4000),
    model: process.env.MOYU_ANYJEV_MODEL || cfg.model || 'Qwen/Qwen3-8B',
  };
}

/** 把任意后端返回的决策对象规范化为统一结构，并做类型校验 */
function normalize(raw, backend) {
  const d = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const danger = Number.isFinite(Number(d.danger)) ? Math.max(1, Math.min(9, Math.round(Number(d.danger)))) : 5;
  return {
    intent: typeof d.intent === 'string' && d.intent ? d.intent.slice(0, 80) : '未识别',
    danger,
    should_reply_now: Boolean(d.should_reply_now),
    best_action: d.best_action === 'ask_human' ? 'ask_human' : 'draft',
    confidence: Number.isFinite(Number(d.confidence)) ? Math.max(0, Math.min(1, Number(d.confidence))) : 0,
    source: backend,
  };
}

/** 高危硬兜底：任何后端都不得让高危内容以 draft 放行 */
function enforceHighRisk(d, snapshot) {
  if (HIGH_RISK_RE.test(String(snapshot || ''))) {
    d.danger = Math.max(d.danger, 8);
    d.should_reply_now = false;
    d.best_action = 'ask_human';
    d.hardRule = true;
  }
  return d;
}

/** mock / llm 后端：走现有 provider.chat（保持向后兼容） */
async function decideViaChat(provider, snapshot, backend) {
  const prompt = `你是 jev 决策内核。基于会话快照输出 JSON：{intent, danger(1-9), should_reply_now, best_action(draft|ask_human), confidence}。\n会话：${snapshot || '(无)'}`;
  const r = await provider.chat([
    { role: 'system', content: '你是 jev_decide 决策函数，只输出 JSON，不输出解释。' },
    { role: 'user', content: prompt },
  ]);
  const parsed = extractJson(r && r.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 解析失败一律转人工，不猜测
    return normalize({ intent: '解析失败', danger: 9, should_reply_now: false, best_action: 'ask_human', confidence: 0 }, backend);
  }
  return normalize(parsed, backend);
}

/** anyjev 后端：调用本地 HTTP 服务；不可用则抛错（禁降级） */
async function decideViaAnyJev(snapshot, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const resp = await fetch(cfg.endpoint.replace(/\/$/, '') + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: String(snapshot || ''), questions: ['risk', 'intent'] }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('AnyJev 服务 HTTP ' + resp.status);
    const json = await resp.json();
    // 服务返回 {decision:{...}, level:'L0'|'L2'} 或直接从顶层取字段，兼容两种
    return normalize(json.decision || json, 'anyjev');
  } catch (e) {
    const err = new Error('AnyJev 决策服务不可用：' + e.message + '（禁止降级为 mock，已转人工）');
    err.code = 'DECIDER_UNAVAILABLE';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一决策入口。
 * @param {object} provider  lib/models.js 的 provider（mock/llm 后端使用）
 * @param {string} snapshot  会话快照原文
 * @param {object} [options] { backend, endpoint, timeoutMs } 覆盖配置（测试用）
 * @returns {Promise<object>} 规范化决策对象
 */
async function decide(provider, snapshot, options = {}) {
  const cfg = Object.assign(loadConfig(), options);
  let d;
  if (cfg.backend === 'anyjev') {
    d = await decideViaAnyJev(snapshot, cfg);
  } else {
    d = await decideViaChat(provider, snapshot, cfg.backend);
  }
  return enforceHighRisk(d, snapshot);
}

/** 供体检/前端展示当前决策后端 */
function describe() {
  const cfg = loadConfig();
  return { backend: cfg.backend, endpoint: cfg.endpoint, model: cfg.model };
}

module.exports = { decide, describe, loadConfig, normalize, enforceHighRisk, VALID_BACKENDS, HIGH_RISK_RE };

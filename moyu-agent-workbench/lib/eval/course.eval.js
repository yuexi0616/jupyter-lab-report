'use strict';

/**
 * 刷课 V 层 evaluator（P1 · 设计文档 v2 §4.6）
 *
 * 独立核验：不采信 course.js 自报的 "done"，而是比对"权威来源"的进度。
 *   - mock 后端：权威来源 = 会话 state 的 progress（simulated=true，明确标注非真实）
 *   - bridge 后端：权威来源 = bridge /progress 返回的学习平台真实进度（须与自报一致）
 *
 * 三态裁决：PASS / FAIL / INCONCLUSIVE（借鉴 yohanchen1/MathModelingAgent 的证据驱动思路）
 * 证据不足时不强行判定成功——这是生成者与评估者分离的关键。
 */

const BRIDGE_ENDPOINT = process.env.MOYU_COURSE_BRIDGE || 'http://127.0.0.1:11437';
const TIMEOUT = Number(process.env.MOYU_COURSE_TIMEOUT || 3000);

async function fetchAuthoritativeProgress(session) {
  if (!session || session.backend !== 'bridge') return null; // mock 无外部权威源
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(BRIDGE_ENDPOINT.replace(/\/$/, '') + '/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }), signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Number.isFinite(Number(j.current)) ? { current: Number(j.current), total: Number(j.total) || session.progress?.total, source: 'bridge/platform' } : null;
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

/**
 * 评估刷课会话是否真实完成。
 * @param {object} session course.getSession 返回
 * @returns {Promise<{verdict:'PASS'|'FAIL'|'INCONCLUSIVE', evidence:Array, failures:string[]}>}
 */
async function evaluate(session) {
  const evidence = [];
  const failures = [];
  if (!session) return { verdict: 'INCONCLUSIVE', evidence: [], failures: ['会话不存在'] };

  if (session.status === 'awaiting_human') {
    failures.push('等待人工处理验证码，未完成');
    return { verdict: 'INCONCLUSIVE', evidence, failures };
  }

  const authoritative = await fetchAuthoritativeProgress(session);
  if (session.backend === 'mock') {
    evidence.push({ source: 'session-state', current: session.progress?.current, total: session.progress?.total, simulated: true });
    // mock 只能给 INCONCLUSIVE：进度是模拟的，不能当作真实完成
    if (session.status === 'done') {
      return { verdict: 'INCONCLUSIVE', evidence, failures: ['mock 后端进度为模拟值，不能判定真实完成；需 bridge 后端核验平台真实进度'] };
    }
    return { verdict: 'FAIL', evidence, failures: ['模拟进度未完成'] };
  }

  if (!authoritative) {
    evidence.push({ source: 'bridge/platform', unavailable: true });
    return { verdict: 'INCONCLUSIVE', evidence, failures: ['无法获取学习平台权威进度，证据不足'] };
  }
  evidence.push(authoritative);
  const self = session.progress || {};
  if (Math.abs((authoritative.current || 0) - (self.current || 0)) > 1) {
    failures.push(`自报进度 ${self.current} 与平台真实进度 ${authoritative.current} 不一致（工具回执≠业务事实）`);
  }
  if (authoritative.current < authoritative.total) failures.push(`平台进度 ${authoritative.current}/${authoritative.total} 未完成`);
  let verdict = 'PASS';
  if (failures.length) verdict = 'FAIL';
  return { verdict, evidence, failures };
}

module.exports = { evaluate };

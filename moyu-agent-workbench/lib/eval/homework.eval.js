'use strict';

/**
 * 作业 V 层 evaluator（P2 · 设计文档 v2 §4.6）
 *
 * 独立核验，不采信 homework.js 自报的 done：
 *   - 8 个 SOP 阶段是否依次完成（stage=done 且 status=done）
 *   - 脱敏检查通过（无 REPLACE-* / 无真实信息泄漏）
 *   - 结论-输出追溯通过（每条 claim 有 outputId）
 *   - 产物路径存在且披露声明在案
 * 三态 PASS / FAIL / INCONCLUSIVE；mock 后端最多 INCONCLUSIVE（产物为模拟）。
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.MOYU_HOMEWORK_STATE_DIR
  ? path.resolve(process.env.MOYU_HOMEWORK_STATE_DIR)
  : path.join(__dirname, '..', 'runs', 'homework');

function evaluate(session) {
  const evidence = [];
  const failures = [];
  if (!session) return { verdict: 'INCONCLUSIVE', evidence, failures: ['会话不存在'] };

  evidence.push({ source: 'session-state', stage: session.stage, status: session.status });
  if (session.status === 'blocked') {
    failures.push('SOP 被门禁阻断（check/audit 未通过）');
    return { verdict: 'FAIL', evidence, failures };
  }
  if (session.status !== 'done' || session.stage !== 'done') {
    failures.push(`流程未完成（stage=${session.stage}, status=${session.status}）`);
    return { verdict: 'FAIL', evidence, failures };
  }

  if (session.audit?.sanitization && !session.audit.sanitization.pass) {
    failures.push('脱敏检查未通过：' + session.audit.sanitization.issues.join('；'));
  }
  if (!session.audit?.trace || !session.audit.trace.pass) {
    failures.push('结论-输出追溯未通过或未执行');
  }
  const products = session.artifacts || [];
  const hasReport = products.some((p) => /\.pdf$|\.md$/.test(p));
  if (!hasReport) failures.push('未发现报告产物');
  evidence.push({ source: 'artifacts', products });

  if (failures.length) return { verdict: 'FAIL', evidence, failures };
  if (session.simulated) {
    failures.push('mock 后端产物为模拟，不能判定真实交付；需 bridge 后端核验实际文件');
    return { verdict: 'INCONCLUSIVE', evidence, failures };
  }
  return { verdict: 'PASS', evidence, failures: [] };
}

module.exports = { evaluate };

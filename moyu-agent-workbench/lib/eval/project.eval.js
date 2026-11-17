'use strict';

/**
 * 竞赛 V 层 evaluator（P3 · 独立审计）
 *
 * 借鉴 MIT 版 MathModelingAgent 的独立 audit skill：只看产物与证据记录，
 * 不看生成者推理，逐条 Claim 三态裁决；证据不足保持 INCONCLUSIVE。
 * 数字冻结/引用完整性任一失败 → FAIL；mock 产物即使全通过也最多 INCONCLUSIVE。
 */

function evaluate(session) {
  const evidence = [];
  const failures = [];
  if (!session) return { verdict: 'INCONCLUSIVE', evidence, failures: ['会话不存在'], claimVerdicts: [] };

  evidence.push({ source: 'session-state', stage: session.stage, status: session.status });
  if (session.status === 'blocked') {
    return { verdict: 'FAIL', evidence, failures: ['反幻觉门控阻断（数字冻结/引用完整性未通过）'], claimVerdicts: [] };
  }
  if (session.status !== 'done' || session.stage !== 'done') {
    return { verdict: 'FAIL', evidence, failures: [`流程未完成（${session.stage}/${session.status}）`], claimVerdicts: [] };
  }

  const claimVerdicts = (session.claims || []).map((c, i) => ({ index: i + 1, claim: c.claim, verdict: c.verdict, evidence: c.evidence }));
  evidence.push({ source: 'claims', count: claimVerdicts.length });
  if (!claimVerdicts.length) failures.push('无任何已登记结论（Claim）');
  claimVerdicts.forEach((cv) => {
    if (cv.verdict === 'FAIL') failures.push(`结论 #${cv.index} 判定 FAIL`);
    else if (cv.verdict === 'INCONCLUSIVE') failures.push(`结论 #${cv.index} 证据不足（INCONCLUSIVE），不得当作已验证`);
  });

  const badNumbers = (session.frozenNumbers || []).filter((n) => !n.ok);
  if (badNumbers.length) failures.push(`${badNumbers.length} 个数字未通过冻结校验`);
  const hasPaper = (session.artifacts || []).some((a) => /\.pdf$|\.typ$/.test(a));
  if (!hasPaper) failures.push('未发现论文产物');
  evidence.push({ source: 'artifacts', products: session.artifacts || [] });

  if (failures.length) return { verdict: 'FAIL', evidence, failures, claimVerdicts };
  if (session.simulated) {
    failures.push('mock 后端证据链为模拟，不能判定真实交付；需 bridge 后端核验实际产物');
    return { verdict: 'INCONCLUSIVE', evidence, failures, claimVerdicts };
  }
  return { verdict: 'PASS', evidence, failures: [], claimVerdicts };
}

module.exports = { evaluate };

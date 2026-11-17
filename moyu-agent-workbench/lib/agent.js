'use strict';

/**
 * 自动任务执行引擎（agent loop）
 * 闭环：plan → (tool call → observe → reflect)* → done/fail
 * 关键能力（解决"只能对话、不能执行"）：
 *  - 工具真实调用（这里是 mock 工具集，接口与真实实现同构）
 *  - 审批门禁：gate 步骤需人工确认后才执行
 *  - 异常处理：重试、超时、降级到 mock、失败中断并保留轨迹
 *  - 结构化轨迹：每步可回放，落盘审计
 *
 * 本引擎不联网、不接触真实平台；真实模型调用由 lib/models.js 提供（需用户自备 key）。
 */

const fs = require('fs');
const path = require('path');
const { tools } = require('./jev-tools');

// runs 目录可用 MOYU_RUNS_DIR 覆盖（测试隔离用；生产默认项目内 runs/）
const RUNS = process.env.MOYU_RUNS_DIR
  ? path.resolve(process.env.MOYU_RUNS_DIR)
  : path.join(__dirname, '..', 'runs');

/**
 * 安全策略（服务端强制，不可被前端 approvals 覆盖）：
 * - 副作用工具（写入输入框 / 剪贴板）永远视为 gate 步骤，且在高危决策下强制拦截；
 * - 决策工具（jev.decide）失败时禁止降级为 mock —— mock 的高危判断依赖关键词，
 *   对语义型高危会漏判，一旦被当成真实决策驱动 fill 将突破 fill-only 红线。
 * 这两条是 fill-only / 高危转人工 产品红线的服务端兜底，属于不可配置的安全下限。
 */
const SIDE_EFFECT_TOOLS = new Set(['jev.fill', 'desktop.writeClipboard']);
const DECISION_TOOLS = new Set(['jev.decide']);
// U2 两道询问门禁：生成类步骤需"生成前询问 + 完成后询问"。
// 通过 opts.askHooks 注入，未注入时行为不变（保持 mock 闭环与既有测试）。
const GENERATIVE_TOOLS = new Set(['llm.draft']);

class AgentError extends Error {
  constructor(message, code, step) { super(message); this.code = code; this.step = step; }
}

/** 默认计划：je场景固定安全链；realMode 时用真实剪贴板工具替换 mock 读/填 */
function defaultPlan(taskText, realMode = false) {
  const snapshotStep = realMode
    ? { id: 1, tool: 'desktop.readClipboard', args: {}, gate: false, desc: '[真实] 读取剪贴板会话（用户先复制）' }
    : { id: 1, tool: 'jev.snapshot', args: { text: taskText }, gate: false, desc: '读取会话快照' };
  const fillStep = realMode
    ? { id: 5, tool: 'desktop.writeClipboard', args: { index: 0 }, gate: true, desc: '[真实] 写入剪贴板（需审批，用户自行粘贴）' }
    : { id: 5, tool: 'jev.fill', args: { index: 0 }, gate: true, desc: 'fill-only 填入输入框（需审批）' };
  return [
    snapshotStep,
    { id: 2, tool: 'jev.decide', args: {}, gate: false, desc: 'Jev 判意图/危险/是否回复' },
    { id: 3, tool: 'llm.draft', args: {}, gate: true, desc: '起草 3 条候选（需审批）' },
    { id: 4, tool: 'jev.rank', args: {}, gate: false, desc: '对候选排序' },
    fillStep,
    { id: 6, tool: 'audit.write', args: {}, gate: false, desc: '写审计日志' },
  ];
}

/**
 * 执行任务。
 * @param {object} provider  lib/models.js 的 provider
 * @param {object} opts { task, plan?, approvals?, maxSteps?, retry?, timeoutMs?, runId? }
 */
async function run(provider, opts) {
  const task = String(opts.task || '').slice(0, 4000);
  // runId 来自前端，必须白名单清洗，防止 ../ 路径穿越写到 runs/ 之外
  const requestedId = String(opts.runId || '');
  const runId = /^[A-Za-z0-9_-]{1,64}$/.test(requestedId)
    ? requestedId
    : ('RUN-' + Date.now().toString(36).toUpperCase());
  const rawPlan = opts.plan || defaultPlan(task, opts.realMode === true);
  // 安全策略 1：副作用工具无论在自定义 plan 里怎么写，都强制 gate=true，
  // 杜绝调用方通过传入 gate:false 的 plan 绕过审批。
  const plan = (Array.isArray(rawPlan) ? rawPlan : []).map((s) =>
    SIDE_EFFECT_TOOLS.has(s.tool) ? { ...s, gate: true } : { ...s }
  );
  const approvals = opts.approvals || {};
  const maxSteps = Math.min(Number(opts.maxSteps || 20), 50);
  const retry = Math.min(Number(opts.retry || 1), 3);
  const timeoutMs = Number(opts.timeoutMs || 8000);
  const trace = [];
  const degradedSteps = [];
  const askHooks = (opts.askHooks && typeof opts.askHooks === 'object') ? opts.askHooks : {};
  const ctx = { runId, snapshot: task, plan };

  function log(step, event, extra) {
    trace.push({ ts: new Date().toISOString(), step, event, ...(extra || {}) });
  }
  log(0, 'start', { runId, provider: provider.id, model: provider.model, task: fingerprint(task), steps: plan.length, mode: provider.mock ? 'mock' : 'live' });

  let status = 'done';
  let error = null;

  for (const step of plan.slice(0, maxSteps)) {
    const tool = tools[step.tool];
    if (!tool) {
      log(step.id, 'unknown_tool', { tool: step.tool });
      status = 'failed'; error = new AgentError('未知工具: ' + step.tool, 'UNKNOWN_TOOL', step.id); break;
    }
    // 安全策略 2：高危决策（ask_human）下，无论 approvals 传了什么，
    // 服务端一律拦截副作用工具，确保"高危转人工、不填不发送"不被绕过。
    if (SIDE_EFFECT_TOOLS.has(step.tool) && ctx.decision?.best_action === 'ask_human') {
      log(step.id, 'blocked_high_risk', { tool: step.tool, desc: step.desc, reason: 'ask_human' });
      status = 'awaiting_approval';
      error = new AgentError('高危决策：已升级人工，服务端拒绝执行写入动作', 'HIGH_RISK_BLOCKED', step.id);
      break;
    }
    if (step.gate && approvals[step.id] !== true) {
      log(step.id, 'blocked_by_gate', { tool: step.tool, desc: step.desc });
      status = 'awaiting_approval';
      break;
    }
    // U2 门禁一：生成前询问。用户未确认则不调用模型生成。
    if (GENERATIVE_TOOLS.has(step.tool) && typeof askHooks.beforeGenerate === 'function') {
      let before;
      try {
        before = await askHooks.beforeGenerate({ runId, stepId: step.id, kind: 'before', tool: step.tool, summary: step.desc || '生成内容' });
      } catch (e) { before = { approved: false, reason: e.message }; }
      if (!before || before.approved !== true) {
        log(step.id, 'ask_before_declined', { tool: step.tool, reason: before?.reason || 'user declined' });
        status = 'awaiting_approval';
        error = new AgentError('生成前询问未通过，未执行生成', 'ASK_BEFORE_DECLINED', step.id);
        break;
      }
      log(step.id, 'ask_before_approved', { tool: step.tool });
    }
    let result, lastErr;
    for (let attempt = 1; attempt <= retry + 1; attempt++) {
      let timer;
      try {
        result = await Promise.race([
          tool.run(provider, step.args || {}, ctx),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new AgentError('工具超时', 'TIMEOUT', step.id)), timeoutMs); }),
        ]);
        lastErr = null; break;
      } catch (e) {
        lastErr = e;
        log(step.id, 'retry', { tool: step.tool, attempt, error: e.message });
        if (attempt <= retry) await new Promise((r) => setTimeout(r, 50 * attempt));
      } finally {
        if (timer) clearTimeout(timer); // 防止已完成调用残留定时器
      }
    }
    if (lastErr) {
      // 安全策略 3：决策工具禁止降级。mock 的高危判断仅靠关键词，语义型高危会漏判，
      // 若被当成真实决策驱动写入，将突破 fill-only 红线。此处直接失败并转人工。
      if (DECISION_TOOLS.has(step.tool)) {
        log(step.id, 'degrade_forbidden', { tool: step.tool, reason: lastErr.message });
        status = 'failed';
        error = new AgentError('决策模型调用失败且禁止降级为 mock，已转人工', 'DECISION_DEGRADE_FORBIDDEN', step.id);
        break;
      }
      // 降级：非决策工具失败 → 用 mock provider 重跑，保证闭环不中断；但必须留痕并标记。
      log(step.id, 'degrade_to_mock', { tool: step.tool, reason: lastErr.message });
      try {
        const mockProvider = require('./models').makeProvider({ preset: 'mock' });
        result = await tool.run(mockProvider, step.args || {}, ctx);
        degradedSteps.push(step.id);
        log(step.id, 'degrade_ok', { tool: step.tool, degraded: true });
      } catch (e2) {
        log(step.id, 'failed', { tool: step.tool, error: e2.message });
        status = 'failed'; error = e2; break;
      }
    }
    log(step.id, 'observe', { tool: step.tool, result: summarize(result, step.tool) });

    // U2 门禁二：完成后询问。未"采用"则产物不进入后续填入/导出，并附披露声明。
    if (GENERATIVE_TOOLS.has(step.tool) && typeof askHooks.afterGenerate === 'function') {
      let after;
      try {
        after = await askHooks.afterGenerate({
          runId, stepId: step.id, kind: 'after', tool: step.tool,
          summary: step.desc || '生成内容',
          draftCount: Array.isArray(ctx.drafts) ? ctx.drafts.length : 0,
          disclosure: 'AI 生成草稿，未经发送；最终措辞由用户确认。',
        });
      } catch (e) { after = { approved: false, action: 'discard', reason: e.message }; }
      const action = after?.action || (after?.approved === true ? 'adopt' : 'discard');
      log(step.id, 'ask_after', { tool: step.tool, action, reason: after?.reason || null });
      if (action !== 'adopt') {
        // 产物作废：清空草稿/排序/填入，禁止后续 fill 使用
        ctx.drafts = null; ctx.ranked = null; ctx.filled = null;
        status = 'awaiting_approval';
        error = new AgentError('完成后询问未采用，产物已作废', 'ASK_AFTER_NOT_ADOPTED', step.id);
        break;
      }
    }
  }

  const finished = status === 'done';
  if (finished) log(plan.length + 1, 'done', { filled: fingerprint(ctx.filled), auto_sent: false });
  else log(plan.length + 1, status, { error: error ? error.message : 'awaiting gate' });

  const hasDegrade = degradedSteps.length > 0;
  // 顶层 task 供侧栏会话标题显示，但只保留安全长度的截断预览，不落完整对话原文。
  const taskPreview = task.length > 24 ? task.slice(0, 24) + '…' : task;
  const record = {
    runId, status, task: taskPreview,
    provider: {
      id: provider.id, model: provider.model,
      // 降级透明化：请求的是 live，但实际有 mock 步骤时明确标记，避免误导用户
      requestedMode: provider.mock ? 'mock' : 'live',
      mode: hasDegrade ? 'mixed' : (provider.mock ? 'mock' : 'live'),
    },
    degraded: hasDegrade,
    degradedSteps,
    decision: ctx.decision || null,
    decider: { backend: ctx.decision?.source || 'mock' },
    drafts: ctx.drafts || null,
    ranked: ctx.ranked || null,
    filled: ctx.filled || null,
    auto_sent: false,
    trace,
    error: error ? { message: error.message, code: error.code, step: error.step } : null,
  };

  if (!fs.existsSync(RUNS)) fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(path.join(RUNS, runId + '.trace.json'), JSON.stringify(record, null, 2), 'utf8');
  pruneRuns();

  return record;
}

/** 轨迹脱敏：对话原文只留指纹，避免 trace.json 变相泄露私密内容（前端轨迹面板不展示这些字段）。 */
function fingerprint(s) {
  if (s == null || s === '') return null;
  return { sha256: require('crypto').createHash('sha256').update(String(s)).digest('hex'), length: String(s).length };
}
function summarize(obj, stepTool) {
  // snapshot 工具的 observe result 含对话原文，整段替换为指纹
  if (stepTool === 'jev.snapshot' || stepTool === 'desktop.readClipboard') {
    return { redacted: true, fingerprint: fingerprint(obj && obj.snapshot) };
  }
  try {
    const s = JSON.stringify(obj);
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch (e) { return String(obj); }
}

function listRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).filter((f) => f.endsWith('.trace.json')).map((f) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8')); return { runId: j.runId, status: j.status, task: j.task, provider: j.provider, ts: j.trace?.[0]?.ts }; }
    catch (e) { return { file: f, status: 'corrupt' }; }
  }).reverse();
}
function getRun(runId) {
  const f = path.join(RUNS, path.basename(runId) + '.trace.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/**
 * 保留期清理：默认保留 7 天、最多 100 个 run（约 200 文件），超出按 mtime 从旧到新删除。
 * 可用 MOYU_RUN_TTL_DAYS / MOYU_RUN_MAX 调整；设为 0 关闭对应策略。
 */
function pruneRuns() {
  if (!fs.existsSync(RUNS)) return;
  const ttlDays = Number(process.env.MOYU_RUN_TTL_DAYS ?? 7);
  const maxRuns = Number(process.env.MOYU_RUN_MAX ?? 100);
  const files = fs.readdirSync(RUNS).filter((f) => /^[A-Za-z0-9_-]+\.(trace|audit)\.json$/.test(f));
  const now = Date.now();
  let removed = 0;
  // 按 runId 聚合（trace 与 audit 同进同退）
  const byRun = new Map();
  for (const f of files) {
    const id = f.replace(/\.(trace|audit)\.json$/, '');
    const stat = fs.statSync(path.join(RUNS, f));
    const prev = byRun.get(id);
    if (!prev || stat.mtimeMs < prev.mtimeMs) byRun.set(id, { mtimeMs: stat.mtimeMs, files: prev ? prev.files.concat(f) : [f] });
    else prev.files.push(f);
  }
  const ordered = [...byRun.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  let keep = ttlDays > 0 ? ordered.filter(([, v]) => (now - v.mtimeMs) / 86400000 <= ttlDays) : ordered.slice();
  if (maxRuns > 0 && keep.length > maxRuns) keep = keep.slice(-maxRuns);
  const keepIds = new Set(keep.map(([id]) => id));
  for (const [id, v] of ordered) {
    if (keepIds.has(id)) continue;
    for (const f of v.files) { try { fs.unlinkSync(path.join(RUNS, f)); removed++; } catch (_) {} }
  }
  return removed;
}

/** 删除单个会话：runId 白名单校验，防路径穿越；同时删 trace 与 audit */
function deleteRun(runId) {
  const id = String(runId || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false;
  let removed = 0;
  for (const suffix of ['.trace.json', '.audit.json']) {
    const f = path.join(RUNS, id + suffix);
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed++; }
  }
  return removed > 0;
}

/** 清空全部会话：只删本工具生成的 trace/audit 文件，不碰其他文件 */
function clearRuns() {
  if (!fs.existsSync(RUNS)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(RUNS)) {
    if (/^[A-Za-z0-9_-]+\.(trace|audit)\.json$/.test(f)) {
      fs.unlinkSync(path.join(RUNS, f)); n++;
    }
  }
  return n;
}

module.exports = { run, defaultPlan, listRuns, getRun, deleteRun, clearRuns, pruneRuns, AgentError };

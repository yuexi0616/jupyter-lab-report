'use strict';

/**
 * 摸鱼 Agent 工作台 —— 零依赖本地后端（Node 内置 http）
 * 形态参考 DeepSeek Harness：本地 Web UI + 后端运行时；含真实 agent loop 执行引擎。
 *
 * 安全边界：
 *  - 默认 mock 模式，离线演示闭环，不联网、不消耗 key。
 *  - live 模式需用户在服务端设置环境变量（如 ZHIPU_API_KEY）；API key 只从 process.env 读，
 *    前端只传"用哪个预设/环境变量名"，绝不传、也不落盘任何明文 key。
 *  - jev 工具集 fill-only：只填输入框，绝不自动发送、不碰支付。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const data = require('./lib/data');
const profileStore = require('./lib/profile');
const models = require('./lib/models');
const agent = require('./lib/agent');
const jevTools = require('./lib/jev-tools');
const desktop = require('./lib/desktop');
const decider = require('./lib/decider');
const course = require('./lib/course');
const courseEval = require('./lib/eval/course.eval');
const homework = require('./lib/homework');
const homeworkEval = require('./lib/eval/homework.eval');
const project = require('./lib/project');
const projectEval = require('./lib/eval/project.eval');

// 进程级兜底：本地工具应"出错但不崩"，避免单个漏网 async 拒绝导致整个服务退出。
// 注意：这只是防护网，正常路径仍须在各路由内 try/catch（见 /api/course/create 的教训）。
process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err && err.stack ? err.stack : err);
});

const HOST = process.env.MOYU_HOST || '127.0.0.1';
const PORT = Number(process.env.MOYU_PORT || 3080);
const PUB = path.join(__dirname, 'public');

// ---------- 本地 API 访问控制 ----------
// 威胁：恶意网页通过 DNS rebinding 把域名指向 127.0.0.1，借浏览器同源身份读写本地 API
// （读取 runs/ 里的私密对话、触发 agent.run、篡改 profile）。三层防护：
//   1) Host 白名单 —— 只认 localhost/127.0.0.1/::1，rebinding 的外来 Host 直接拒绝；
//   2) Origin 校验 —— 写操作必须来自同源，跨站 Origin 拒绝；
//   3) 会话 token —— 页面启动时由静态 HTML 注入，API 请求须带 X-Moyu-Token，
//      纯跨站请求无法读取 token（同源策略），彻底阻断伪造请求。
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// 调试/集成开关：显式开启才放行非本地 Host 与无 token 请求，并在启动时醒目警告。
const INSECURE = process.env.MOYU_ALLOW_INSECURE === '1';

function hostOf(req) {
  return String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
}
function originAllowed(req, method) {
  if (INSECURE) return true;
  const origin = req.headers.origin;
  // 无 Origin：curl / 同源导航 / 浏览器 GET 常见，交给 Host + token 判断
  if (!origin) return true;
  let h;
  try { h = new URL(origin).hostname.toLowerCase(); } catch (_) { return false; }
  if (ALLOWED_HOSTS.has(h)) return true;
  // 只有 GET/HEAD 的只读请求容忍外来 Origin（仍需 token）；写操作严格拒绝
  return method === 'GET' || method === 'HEAD';
}

// ---------- 审批凭证（一次性、短期、绑定 session） ----------
// 前端不再直接传裸 approvals（可被任意脚本伪造）。改为先向后端申请批准凭证，
// 后端签发一次性 token 并记录其批准的 step 集合；执行时校验并消费。
// 注意：这是纵深防御的一层，真正的安全下限是 agent.js 的服务端高危强拦。
const APPROVAL_TTL_MS = 60_000;
const approvals = new Map(); // token -> { steps:Set, exp, session }
function issueApproval(steps, session) {
  const token = crypto.randomBytes(24).toString('hex');
  approvals.set(token, { steps: new Set(steps), exp: Date.now() + APPROVAL_TTL_MS, session });
  return token;
}
function consumeApproval(token, session) {
  const rec = approvals.get(token);
  if (!rec) return null;
  approvals.delete(token); // 一次性：无论成功失败都消费，防重放
  if (rec.exp < Date.now()) return null;
  if (rec.session && session && rec.session !== session) return null;
  return rec.steps;
}

function readJsonBody(req, cb) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { cb(null, JSON.parse(raw || '{}')); }
    catch (e) { cb(e); }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 同源前端不需要 CORS；移除通配符，避免任意网页跨域读写本地 profile / 触发 agent 运行。
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUB, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUB)) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  let body = fs.readFileSync(file);
  // 仅对首页注入本次会话 token（同源脚本可读；跨站页面受同源策略无法读取）
  if (file.endsWith('index.html')) {
    const html = body.toString('utf8').replace('</head>', `<meta name="moyu-token" content="${SESSION_TOKEN}" /></head>`);
    body = Buffer.from(html, 'utf8');
  }
  send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
}

// ---------- 计划与审批门禁（模拟） ----------
function buildPlan(sectionId, taskText) {
  const s = data.sections.find((x) => x.id === sectionId);
  if (!s) return null;
  const steps = [
    { id: 1, cmd: `check --section ${s.codename}`, desc: '摊开本次档案与路径，缺字段抛标准题面', gate: false },
    { id: 2, cmd: 'ask --missing', desc: '按 ask-first 一次问全缺失项（只在档案里登记引用）', gate: true },
    ...(s.id === 'course_auto' ? [
      { id: 3, cmd: 'discover --urls <course>', desc: '识别课程页与视频 DOM，探测验证码/弹题', gate: false },
      { id: 4, cmd: 'run --daemon', desc: '启动无人值守播放（外层守护壳）', gate: true },
      { id: 5, cmd: 'audit --progress', desc: '逐章节进度自检，异常交接清单', gate: false },
    ] : s.id === 'jev_reply' ? [
      { id: 3, cmd: 'jev.decide --state <snapshot>', desc: 'Jev 判意图/危险等级/是否该回（choice/score/noul）', gate: false },
      { id: 4, cmd: 'llm.draft --n 3', desc: '生成模型起草 3 条候选并交 Jev 排序', gate: false },
      { id: 5, cmd: 'send --policy draft_only', desc: '只填输入框；发送需人工确认', gate: true },
    ] : s.id === 'homework' ? [
      { id: 3, cmd: 'notebook init -m jupyter-lab-report', desc: '套用母版模板生成可执行 notebook 骨架', gate: false },
      { id: 4, cmd: 'notebook run --cells all', desc: '逐单元执行，产出图表/表格与运行日志', gate: false },
      { id: 5, cmd: 'audit --trace', desc: '结论—输出追溯校验，封面脱敏自检', gate: true },
    ] : [
      { id: 3, cmd: 'ommw init -m dual', desc: '初始化 Research Core 与双渲染工作区', gate: false },
      { id: 4, cmd: 'ommw verify', desc: '反幻觉门控：数字挂 R-xxx、引用挂 S-xxx', gate: true },
      { id: 5, cmd: 'ommw render -m dual && package', desc: 'LaTeX+Word 双渲染 + 竞赛提交包', gate: false },
    ]),
    { id: 6, cmd: 'deliver --no-overwrite', desc: '按命名规则交付，默认不覆盖', gate: true },
    { id: 7, cmd: 'clean && pack', desc: '清临时件、打脱敏分享包（不带出凭据引用清单）', gate: false },
  ];
  return {
    planId: 'PLAN-' + Date.now().toString(36).toUpperCase(),
    section: s.name,
    task: taskText || '(未填写任务描述)',
    steps,
    approvalGates: steps.filter((x) => x.gate).map((x) => x.id),
    disclaimer: '这是方案工作台的模拟计划：不会执行真实刷课/回复/建模，也不接触真实凭据。',
  };
}

function health() {
  const p = profileStore.read();
  const placeholders = profileStore.findPlaceholders(p);
  return {
    engine: { runtime: 'node ' + process.version, mode: 'mock-workbench', ok: true },
    profile: {
      path: 'data/profile.json',
      placeholders,
      verdict: placeholders.length > 0 ? 'DEGRADED（占位档案，模拟 check 会拒绝）' : 'PASS',
    },
    sections: data.sections.map((s) => ({ id: s.id, name: s.name, priority: s.priority, status: s.status })),
    snapshotNote: data.SNAPSHOT_NOTE,
  };
}

// ---------- 路由 ----------
function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method || 'GET';

  if (p === '/api/meta' && method === 'GET') {
    return send(res, 200, { name: '摸鱼 Agent 工作台', version: data.version, updated: data.updated, snapshotNote: data.SNAPSHOT_NOTE, disclaimer: '方案原型，不执行真实自动化、不接触真实凭据。' });
  }
  if (p === '/api/sections' && method === 'GET') {
    return send(res, 200, data.sections.map(({ id, name, icon, priority, status, goal }) => ({ id, name, icon, priority, status, goal })));
  }
  if (p.startsWith('/api/sections/') && method === 'GET') {
    const id = p.split('/')[3];
    const s = data.sections.find((x) => x.id === id);
    return s ? send(res, 200, s) : send(res, 404, { error: 'section not found' });
  }
  if (p === '/api/kernel' && method === 'GET') return send(res, 200, data.sharedKernel);
  if (p === '/api/harness' && method === 'GET') return send(res, 200, data.harness);
  if (p === '/api/roadmap' && method === 'GET') return send(res, 200, data.roadmap);
  if (p === '/api/questions' && method === 'GET') return send(res, 200, data.openQuestions);
  if (p === '/api/health' && method === 'GET') return send(res, 200, health());

  if (p === '/api/profile' && method === 'GET') return send(res, 200, profileStore.read());
  if (p === '/api/profile' && method === 'PUT') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { send(res, 200, profileStore.write(JSON.parse(raw))); }
      catch (e) { send(res, 400, { error: 'invalid json: ' + e.message }); }
    });
    return;
  }

  if (p === '/api/plan' && method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { sectionId, task } = JSON.parse(raw || '{}');
        const plan = buildPlan(sectionId, task);
        return plan ? send(res, 200, plan) : send(res, 404, { error: 'section not found' });
      } catch (e) { send(res, 400, { error: 'invalid json: ' + e.message }); }
    });
    return;
  }
  // ---------- 自动任务执行引擎 ----------
  if (p === '/api/models' && method === 'GET') {
    return send(res, 200, models.listPresets().map((m) => ({
      ...m,
      keyReady: m.id === 'mock' ? true : Boolean(process.env[m.env]),
    })));
  }
  if (p === '/api/tools' && method === 'GET') return send(res, 200, jevTools.listTools());
  if (p === '/api/desktop' && method === 'GET') return send(res, 200, desktop.capabilities());
  if (p === '/api/decider' && method === 'GET') return send(res, 200, decider.describe());

  // ---------- 刷课（P1）----------
  if (p === '/api/course/meta' && method === 'GET') return send(res, 200, course.describeBackends());
  if (p === '/api/course/sessions' && method === 'GET') return send(res, 200, course.listSessions());
  if (p === '/api/course/create' && method === 'POST') {
    return readJsonBody(req, async (err, body) => {
      if (err) return send(res, 400, { error: 'invalid json' });
      // createSession 是 async：必须 await + try/catch，否则 rejected Promise 会逃逸并崩溃进程
      try { return send(res, 200, await course.createSession(body)); }
      catch (e) { return send(res, e.code === 'AUTO_ANSWER_AUTH_REQUIRED' ? 403 : 400, { error: e.message, code: e.code }); }
    });
  }
  if (p.startsWith('/api/course/') && method === 'POST') {
    const rest = p.slice('/api/course/'.length);
    const sid = decodeURIComponent(rest.split('/')[0]);
    const action = rest.split('/')[1] || '';
    if (action === 'tick') {
      return readJsonBody(req, async (err, body) => {
        if (err) return send(res, 400, { error: 'invalid json' });
        try { return send(res, 200, await course.tick(sid, body)); }
        catch (e) { return send(res, e.code === 'COURSE_BRIDGE_UNAVAILABLE' ? 503 : 400, { error: e.message, code: e.code }); }
      });
    }
    if (action === 'pause') {
      try { return send(res, 200, course.pause(sid)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (action === 'resume') {
      try { return send(res, 200, course.resumeAfterHuman(sid)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (action === 'eval') {
      return courseEval.evaluate(course.getSession(sid))
        .then((result) => send(res, 200, result))
        .catch((e) => send(res, 400, { error: e.message }));
    }
  }
  if (p.startsWith('/api/course/') && method === 'DELETE') {
    const sid = decodeURIComponent(p.slice('/api/course/'.length).split('/')[0]);
    return send(res, 200, { deleted: course.deleteSession(sid) });
  }

  // ---------- 作业（P2）----------
  if (p === '/api/homework/meta' && method === 'GET') {
    return send(res, 200, { steps: homework.STEPS, pipeline: 'jupyter-lab-report SOP', boundary: '不代写、不伪造数据；骨架生成需 U2 生成前询问，报告交付需生成后采用确认' });
  }
  if (p === '/api/homework/sessions' && method === 'GET') return send(res, 200, homework.listSessions());
  if (p.startsWith('/api/homework/') && method === 'GET' && !p.endsWith('/sessions') && !p.endsWith('/meta')) {
    const sid = decodeURIComponent(p.slice('/api/homework/'.length).split('/')[0]);
    const s = homework.getSession(sid);
    return s ? send(res, 200, s) : send(res, 404, { error: 'session not found' });
  }
  if (p === '/api/homework/create' && method === 'POST') {
    return readJsonBody(req, async (err, body) => {
      if (err) return send(res, 400, { error: 'invalid json' });
      try { return send(res, 200, await homework.createSession(body)); }
      catch (e) { return send(res, e.code === 'ASK_BEFORE_REQUIRED' ? 403 : 400, { error: e.message, code: e.code }); }
    });
  }
  if (p.startsWith('/api/homework/') && method === 'POST') {
    const rest = p.slice('/api/homework/'.length);
    const sid = decodeURIComponent(rest.split('/')[0]);
    const action = rest.split('/')[1] || '';
    if (action === 'advance') {
      return readJsonBody(req, async (err, body) => {
        if (err) return send(res, 400, { error: 'invalid json' });
        try { return send(res, 200, await homework.advance(sid, body)); }
        catch (e) { return send(res, e.code === 'ASK_AFTER_REQUIRED' ? 403 : 400, { error: e.message, code: e.code }); }
      });
    }
    if (action === 'eval') {
      try { return send(res, 200, homeworkEval.evaluate(homework.getSession(sid))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
  }
  if (p.startsWith('/api/homework/') && method === 'DELETE') {
    const sid = decodeURIComponent(p.slice('/api/homework/'.length).split('/')[0]);
    return send(res, 200, { deleted: homework.deleteSession(sid) });
  }

  // ---------- 竞赛（P3）----------
  if (p === '/api/project/meta' && method === 'GET') {
    return send(res, 200, { stages: project.STAGES, verdicts: project.VERDICTS, method: 'Claim/Obligation/Evidence + 独立审计（MIT 许可借鉴，自研实现）', boundary: '证据不足保持 INCONCLUSIVE；数字须冻结；引用须有来源' });
  }
  if (p === '/api/project/sessions' && method === 'GET') return send(res, 200, project.listSessions());
  if (p.startsWith('/api/project/') && method === 'GET' && !p.endsWith('/sessions') && !p.endsWith('/meta')) {
    const sid = decodeURIComponent(p.slice('/api/project/'.length).split('/')[0]);
    const s = project.getSession(sid);
    return s ? send(res, 200, s) : send(res, 404, { error: 'session not found' });
  }
  if (p === '/api/project/create' && method === 'POST') {
    return readJsonBody(req, async (err, body) => {
      if (err) return send(res, 400, { error: 'invalid json' });
      try { return send(res, 200, await project.createSession(body)); }
      catch (e) { return send(res, e.code === 'ASK_BEFORE_REQUIRED' ? 403 : 400, { error: e.message, code: e.code }); }
    });
  }
  if (p.startsWith('/api/project/') && method === 'POST') {
    const rest = p.slice('/api/project/'.length);
    const sid = decodeURIComponent(rest.split('/')[0]);
    const action = rest.split('/')[1] || '';
    if (action === 'advance') {
      return readJsonBody(req, async (err, body) => {
        if (err) return send(res, 400, { error: 'invalid json' });
        try { return send(res, 200, await project.advance(sid, body)); }
        catch (e) { return send(res, e.code === 'ASK_AFTER_REQUIRED' ? 403 : 400, { error: e.message, code: e.code }); }
      });
    }
    if (action === 'eval') {
      try { return send(res, 200, projectEval.evaluate(project.getSession(sid))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
  }
  if (p.startsWith('/api/project/') && method === 'DELETE') {
    const sid = decodeURIComponent(p.slice('/api/project/'.length).split('/')[0]);
    return send(res, 200, { deleted: project.deleteSession(sid) });
  }
  if (p === '/api/agent/approval' && method === 'POST') {
    // 签发一次性审批凭证。steps 白名单：只接受合法的 gate 步骤 id（1..50 的整数）
    return readJsonBody(req, (err, body) => {
      if (err) return send(res, 400, { error: 'invalid json' });
      const steps = Array.isArray(body.steps)
        ? [...new Set(body.steps.filter((n) => Number.isInteger(n) && n >= 1 && n <= 50))]
        : [];
      const token = issueApproval(steps, req.headers['x-moyu-token'] || '');
      return send(res, 200, { token, steps, expiresInMs: APPROVAL_TTL_MS });
    });
  }
  if (p === '/api/agent/run' && method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const preset = String(body.preset || 'mock');
        // 校验预设合法性：未知 preset 明确报错，不再回退到 custom
        if (!models.PRESETS[preset]) {
          return send(res, 400, { error: `未知模型预设: ${preset}。可用: ${Object.keys(models.PRESETS).join(', ')}` });
        }
        // custom 预设：baseUrl 必填（本地 Ollama 等常无需 key），key 可选
        if (preset === 'custom') {
          const bu = String(body.baseUrl || '').trim();
          if (!/^https?:\/\//.test(bu)) {
            return send(res, 400, { error: 'custom 预设需要 http(s) 开头的 baseUrl（如 http://127.0.0.1:11434/v1）。' });
          }
        }
        // key 只从服务端环境变量取，始终忽略前端传来的任何 apiKey 字段。
        // custom 允许无 key（本地 Ollama/vLLM），若需鉴权则在服务端设置 CUSTOM_API_KEY。
        const apiKey = (preset === 'mock' || preset === 'custom')
          ? (process.env[models.PRESETS[preset]?.env] || '')
          : (process.env[models.PRESETS[preset].env] || '');
        if (preset !== 'mock' && preset !== 'custom' && !apiKey) {
          return send(res, 400, { error: `服务端未设置环境变量 ${models.PRESETS[preset].env}，无法以 live 模式运行。请在启动服务前设置。` });
        }
        // 审批凭证：优先消费服务端签发的一次性 token；无 token 时回退到裸 approvals
        // （保留给 node:test / CLI 直接调用；浏览器 UI 始终走 token，见 app.js）。
        let approvalsObj = {};
        if (body.approvalToken) {
          const granted = consumeApproval(body.approvalToken, req.headers['x-moyu-token'] || '');
          if (!granted) {
            return send(res, 403, { error: '审批凭证无效、已使用或已过期，请重新批准' });
          }
          approvalsObj = {};
          for (const step of granted) approvalsObj[step] = true;
        } else if (body.approvals && typeof body.approvals === 'object') {
          approvalsObj = body.approvals;
        }
        const provider = models.makeProvider({
          preset,
          baseUrl: body.baseUrl,
          model: body.model,
          apiKey,
        });
        const record = await agent.run(provider, {
          task: body.task,
          realMode: body.realMode === true,
          approvals: approvalsObj,
          maxSteps: body.maxSteps,
          retry: body.retry,
          timeoutMs: body.timeoutMs,
          runId: body.runId,
        });
        return send(res, 200, record);
      } catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }
  if (p === '/api/agent/runs' && method === 'GET') return send(res, 200, agent.listRuns());
  if (p === '/api/agent/runs' && method === 'DELETE') {
    const n = agent.clearRuns();
    return send(res, 200, { cleared: n });
  }
  if (p.startsWith('/api/agent/runs/') && method === 'GET') {
    const runRec = agent.getRun(p.split('/')[4]);
    return runRec ? send(res, 200, runRec) : send(res, 404, { error: 'run not found' });
  }
  if (p.startsWith('/api/agent/runs/') && method === 'DELETE') {
    const ok = agent.deleteRun(p.split('/')[4]);
    return ok ? send(res, 200, { deleted: true }) : send(res, 404, { error: 'run not found or invalid id' });
  }

  if (p === '/api/projects/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const all = [];
    data.sections.forEach((s) => s.projects.forEach((pr) => all.push({ section: s.name, ...pr })));
    data.harness.forEach((h) => all.push({ section: '运行底座', role: h.tag, repo: h.repo, stars: h.stars, license: h.license, why: h.why, verify: '' }));
    return send(res, 200, q ? all.filter((x) => (x.repo + x.why + x.role).toLowerCase().includes(q)) : all);
  }

  return send(res, 404, { error: 'api not found' });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); }
  catch (e) { return send(res, 400, { error: 'bad url' }); }

  // 1) Host 白名单：抵御 DNS rebinding（外来域名指向 127.0.0.1）
  if (!INSECURE && !ALLOWED_HOSTS.has(hostOf(req))) {
    return send(res, 403, { error: 'forbidden host' });
  }

  if (url.pathname.startsWith('/api/')) {
    const method = req.method || 'GET';
    // 2) Origin 校验：写操作只接受同源
    if (!originAllowed(req, method)) return send(res, 403, { error: 'forbidden origin' });
    // 3) 会话 token：API 必须携带页面注入的 token
    if (!INSECURE && req.headers['x-moyu-token'] !== SESSION_TOKEN) {
      return send(res, 401, { error: 'missing or invalid session token' });
    }
    return handleApi(req, res, url);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, url.pathname);
});

// 端口占用时不再抛未捕获异常打印整屏堆栈——给出清晰提示后快速退出。
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[启动失败] 端口 ${PORT} 已被占用。服务可能已在运行，请直接访问 http://${HOST}:${PORT}`);
    console.error('如需重启：先停止占用该端口的进程（Ctrl+C 或关闭旧终端），或换端口 MOYU_PORT=3081 node server.js');
    process.exit(1);
  }
  console.error('[启动失败]', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`摸鱼 Agent 工作台 v${data.version} running at http://${HOST}:${PORT}`);
  console.log('含 agent loop 自动执行引擎；默认 mock，live 模式需在服务端设置模型 API key 环境变量。');
  console.log('jev 工具集 fill-only：只填输入框，绝不自动发送、不碰支付。');
  if (INSECURE) {
    console.warn('[安全警告] MOYU_ALLOW_INSECURE=1：已关闭 Host/Origin/token 校验，仅可用于受信任的本地调试，切勿在联网/公网环境使用。');
  } else {
    console.log('[安全] 已启用 Host 白名单 + Origin 校验 + 会话 token（抵御 DNS rebinding）。');
  }
});

module.exports = { server, buildPlan, health };

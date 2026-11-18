'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  models: [], runs: [], currentRun: null, drawer: null, busy: false,
  activeSection: 'jev_reply',
  detailCache: {},
  planBusy: false,
  ttWeek: null,
  ttEditing: null,
};

/**
 * 四个平级版块的导航定义。此处为前端静态定义，
 * 保证即使后端尚未返回 sections，四个入口也始终同时存在且层级一致。
 */
const NAV_SECTIONS = [
  { id: 'jev_reply', name: '回复建议', icon: '✦', hint: '对话式' },
  { id: 'timetable', name: '课程表', icon: '▦', hint: '周视图' },
  { id: 'course_auto', name: '刷课', icon: '▶', hint: '工作台' },
  { id: 'homework', name: '作业版块', icon: '▤', hint: '母版工作台' },
  { id: 'project_lab', name: '毕设 / 竞赛', icon: '∑', hint: '工作台' },
];

/** 拥有方案工作台、没有对话功能的版块 id。 */
const WORKBENCH_IDS = ['course_auto', 'homework', 'project_lab'];

// 会话 token：由后端在首页注入，随每个 API 请求发送，抵御 DNS rebinding / 跨站伪造。
const SESSION_TOKEN = document.querySelector('meta[name="moyu-token"]')?.content || '';
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, SESSION_TOKEN ? { 'X-Moyu-Token': SESSION_TOKEN } : {});
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) {
    const payload = await r.json().catch(() => ({}));
    const err = new Error(payload.error || 'HTTP ' + r.status);
    err.code = payload.code; err.payload = payload; err.status = r.status;
    throw err;
  }
  return r.json();
}
const get = (p) => api(p);
const post = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// ---------- 平级版块导航与视图切换 ----------
function renderNav() {
  const nav = $('#section-nav');
  nav.innerHTML = '';
  NAV_SECTIONS.forEach((s) => {
    const item = el('button', 'nav-item' + (state.activeSection === s.id ? ' active' : ''));
    item.innerHTML = `<span class="nav-ico">${esc(s.icon)}</span><span class="nav-name">${esc(s.name)}</span><span class="nav-hint">${esc(s.hint)}</span>`;
    item.title = `切换到「${s.name}」版块`;
    item.onclick = () => switchSection(s.id);
    nav.appendChild(item);
  });
}

function getSectionById(id) {
  return state.detailCache[id] || NAV_SECTIONS.find((x) => x.id === id) || {};
}

async function getSectionDetail(id) {
  if (state.detailCache[id]) return state.detailCache[id];
  const detail = await get('/api/sections/' + encodeURIComponent(id));
  state.detailCache[id] = detail;
  return detail;
}

/** 从 URL hash 解析版块 id，便于平级版块深链与独立验证。 */
function sectionFromHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  const id = raw.startsWith('section=') ? raw.slice('section='.length) : raw;
  return NAV_SECTIONS.some((s) => s.id === id) ? id : null;
}

async function switchSection(id) {
  if (!NAV_SECTIONS.some((s) => s.id === id)) return;
  state.activeSection = id;
  if (sectionFromHash() !== id) history.replaceState(null, '', '#' + id);
  renderNav();

  const isWorkbench = WORKBENCH_IDS.includes(id);
  const isTimetable = id === 'timetable';
  $('#chat-view').hidden = isWorkbench || isTimetable;
  $('#workbench-view').hidden = !isWorkbench;
  $('#timetable-view').hidden = !isTimetable;
  if (isTimetable) return renderTimetable();
  if (!isWorkbench) return;

  const wb = $('#workbench-view');
  wb.innerHTML = '<div class="wb-loading muted">加载版块方案…</div>';
  try {
    const section = await getSectionDetail(id);
    // 快速连续切换时，丢弃过期响应，避免旧版块覆盖新版块。
    if (state.activeSection !== id) return;
    renderWorkbench(section);
  } catch (e) {
    if (state.activeSection === id) wb.innerHTML = `<div class="warnbox">加载失败：${esc(e.message)}</div>`;
  }
}

// ---------- 方案工作台 ----------
/** 刷课真实执行卡片（P1）：仅在 course_auto 版块注入 */
function courseRunnerHtml() {
  return `
      <section class="wb-card" id="course-runner">
        <h3>刷课执行台 <span class="badge" id="course-mode">检测中…</span></h3>
        <div class="note">边界：<b>只推进度，不改成绩、不产证书</b>；自动答题默认关闭；遇验证码立即暂停转人工。</div>
        <div class="plan-controls" style="margin-top:12px">
          <input id="course-url" class="plan-input" type="text" placeholder="课程页地址（支持超星/智慧树/职教云/智慧职教/中国大学MOOC）" />
          <input id="course-total" class="head-input" type="number" min="1" max="10000" value="10" title="章节总数（演示用）" style="width:88px" aria-label="章节总数" />
          <button class="btn" id="course-create">创建会话</button>
        </div>
        <div id="course-panel" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px;gap:12px">
            <span class="muted small" id="course-status">—</span>
            <span class="badge" id="course-progress-text">0 / 0</span>
          </div>
          <div class="course-bar"><div class="course-bar-fill" id="course-bar-fill"></div></div>
          <div class="plan-controls" style="margin-top:12px;flex-wrap:wrap">
            <button class="btn ghost" id="course-tick">推进一章</button>
            <button class="btn ghost" id="course-pause">暂停 / 恢复</button>
            <button class="btn ghost" id="course-resume" style="display:none">人工已处理 · 继续</button>
            <button class="btn ghost" id="course-eval">独立核验</button>
          </div>
          <div id="course-result" class="plan-result" style="margin-top:10px"></div>
        </div>
        <div id="course-hint" class="muted small" style="margin-top:10px">当前为离线模拟后端；接入真实浏览器需本地 OCS bridge（见 README）。</div>
      </section>`;
}

/** 竞赛执行台（P3）：证据驱动 Claim + 独立审计 + 两道门禁 */
function projectRunnerHtml() {
  return `
      <section class="wb-card" id="proj-runner">
        <h3>竞赛执行台 <span class="badge" id="proj-mode">证据驱动 · 模拟</span></h3>
        <div class="note">反幻觉：<b>结论须有证据，数字须冻结，引用须有来源；证据不足判 INCONCLUSIVE</b>。生成须授权、提交须采用确认（U2）。</div>
        <div class="plan-controls" style="margin-top:12px;flex-wrap:wrap">
          <input id="proj-topic" class="plan-input" type="text" placeholder="赛题 / 研究主题" />
          <input id="proj-auth" class="head-input" type="text" placeholder="生成前授权 token" style="width:170px" aria-label="生成前授权token" />
          <button class="btn" id="proj-create">立题</button>
        </div>
        <div id="proj-panel" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px">
            <span class="muted small" id="proj-status">—</span>
            <span class="badge" id="proj-stage">—</span>
          </div>
          <div class="plan-controls" style="margin-top:6px;flex-wrap:wrap">
            <input id="proj-claim" class="plan-input" type="text" placeholder="结论文本（如：模型准确率提升 10%）" />
            <input id="proj-evidence" class="head-input" type="text" placeholder="证据id,逗号分隔" style="width:150px" aria-label="证据id" />
            <label class="auto-approve"><input type="checkbox" id="proj-adopt" /> 生成后已确认采用</label>
            <button class="btn ghost" id="proj-advance">推进阶段</button>
            <button class="btn ghost" id="proj-eval">独立审计</button>
          </div>
          <div id="proj-result" class="plan-result" style="margin-top:10px"></div>
        </div>
        <div class="muted small" style="margin-top:10px">mock 后端证据链为模拟，独立审计最多判 INCONCLUSIVE；方法借鉴 MIT 许可项目，自研实现。</div>
      </section>`;
}
function bindProjectRunner() {
  const runner = $('#proj-runner');
  if (!runner || state.projBound) return;
  state.projBound = true;
  let sid = null;
  const setResult = (html) => { const r = $('#proj-result'); if (r) r.innerHTML = html; };
  const render = (s) => {
    if (!s) return;
    sid = s.sessionId;
    $('#proj-panel').style.display = '';
    $('#proj-status').textContent = ({ running: '进行中', blocked: '门控阻断', done: '已完成' })[s.status] || s.status;
    $('#proj-stage').textContent = s.stage;
  };
  $('#proj-create').onclick = async () => {
    const topic = $('#proj-topic').value.trim();
    const genAuthToken = $('#proj-auth').value.trim();
    if (!topic || !genAuthToken) { setResult('<div class="warnbox">请填赛题与生成前授权 token（U2 门禁）</div>'); return; }
    try { render(await post('/api/project/create', { topic, genAuthToken })); setResult('<div class="muted small">已立题，进入证据驱动流程。</div>'); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#proj-advance').onclick = async () => {
    if (!sid) return setResult('<div class="warnbox">请先立题</div>');
    const claim = $('#proj-claim').value.trim();
    const ev = $('#proj-evidence').value.split(',').map((x) => x.trim()).filter(Boolean);
    const body = {
      sources: ['paperA', 'paperB'], results: ['result-1'],
      claims: claim ? [{ claim, evidence: ev, numbers: ['0.82'] }] : [],
      numbers: [{ value: '0.82', sourceId: 'result-1' }],
      citations: [{ text: '文献A', sourceId: 'src-1' }],
      adopt: $('#proj-adopt').checked,
    };
    try { render(await post('/api/project/' + encodeURIComponent(sid) + '/advance', body)); setResult('<div class="muted small">已推进阶段。</div>'); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#proj-eval').onclick = async () => {
    if (!sid) return setResult('<div class="warnbox">请先立题</div>');
    try {
      const v = await post('/api/project/' + encodeURIComponent(sid) + '/eval', {});
      const badge = v.verdict === 'PASS' ? 'ok' : v.verdict === 'FAIL' ? 'err' : 'warn';
      const claims = (v.claimVerdicts || []).map((c) => `<div class="trace-row"><span class="n">#${c.index}</span><span>${esc(String(c.claim).slice(0, 30))}</span><span class="badge ${c.verdict === 'PASS' ? 'ok' : c.verdict === 'FAIL' ? 'err' : 'warn'}">${c.verdict}</span></div>`).join('');
      setResult(`<div class="note"><span class="badge ${badge}">独立审计: ${esc(v.verdict)}</span></div>${claims}` +
        (v.failures || []).map((f) => `<div class="warnbox">${esc(f)}</div>`).join(''));
    } catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
}

/** 作业执行台（P2）：notebook SOP + 两道询问门禁 */
function homeworkRunnerHtml() {
  return `
      <section class="wb-card" id="hw-runner">
        <h3>作业执行台 <span class="badge" id="hw-mode">母版 SOP · 模拟</span></h3>
        <div class="note">边界：<b>不代写、不伪造数据</b>；骨架生成需「生成前询问」授权，报告交付需「生成后采用」确认；结论须可追溯到单元输出。</div>
        <div class="plan-controls" style="margin-top:12px;flex-wrap:wrap">
          <input id="hw-title" class="plan-input" type="text" placeholder="作业题目" />
          <input id="hw-auth" class="head-input" type="text" placeholder="生成前授权 token" title="U2 生成前询问签发的授权 token" style="width:170px" aria-label="生成前授权token" />
          <button class="btn" id="hw-create">生成骨架</button>
        </div>
        <div id="hw-panel" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px">
            <span class="muted small" id="hw-status">—</span>
            <span class="badge" id="hw-stage">—</span>
          </div>
          <div class="plan-controls" style="margin-top:6px;flex-wrap:wrap">
            <button class="btn ghost" id="hw-advance">推进 SOP 一步</button>
            <label class="auto-approve"><input type="checkbox" id="hw-adopt" /> 生成后已确认采用</label>
            <button class="btn ghost" id="hw-eval">独立核验</button>
          </div>
          <div id="hw-result" class="plan-result" style="margin-top:10px"></div>
        </div>
        <div id="hw-hint" class="muted small" style="margin-top:10px">mock 后端产物为模拟，独立核验最多判 INCONCLUSIVE。</div>
      </section>`;
}
function bindHomeworkRunner() {
  const runner = $('#hw-runner');
  if (!runner || state.hwBound) return;
  state.hwBound = true;
  let sid = null;
  const setResult = (html) => { const r = $('#hw-result'); if (r) r.innerHTML = html; };
  const render = (s) => {
    if (!s) return;
    sid = s.sessionId;
    $('#hw-panel').style.display = '';
    $('#hw-status').textContent = ({ running: '进行中', blocked: '门禁阻断', done: '已完成' })[s.status] || s.status;
    $('#hw-stage').textContent = s.stage;
  };
  $('#hw-create').onclick = async () => {
    const title = $('#hw-title').value.trim();
    const genAuthToken = $('#hw-auth').value.trim();
    if (!title || !genAuthToken) { setResult('<div class="warnbox">请填题目与生成前授权 token（U2 门禁）</div>'); return; }
    try { render(await post('/api/homework/create', { title, genAuthToken })); setResult('<div class="muted small">骨架已生成，从 check 阶段开始推进。</div>'); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#hw-advance').onclick = async () => {
    if (!sid) return setResult('<div class="warnbox">请先生成骨架</div>');
    const body = { profile: { name: '匿名' }, claims: [{ claim: '示例结论', outputId: 'cell-3-out-1' }], adopt: $('#hw-adopt').checked };
    try { render(await post('/api/homework/' + encodeURIComponent(sid) + '/advance', body)); setResult('<div class="muted small">已推进一步。</div>'); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#hw-eval').onclick = async () => {
    if (!sid) return setResult('<div class="warnbox">请先生成骨架</div>');
    try {
      const v = await post('/api/homework/' + encodeURIComponent(sid) + '/eval', {});
      const badge = v.verdict === 'PASS' ? 'ok' : v.verdict === 'FAIL' ? 'err' : 'warn';
      setResult(`<div class="note"><span class="badge ${badge}">${esc(v.verdict)}</span></div>` +
        (v.failures || []).map((f) => `<div class="warnbox">${esc(f)}</div>`).join(''));
    } catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
}

/** 绑定刷课执行台事件 */
function bindCourseRunner() {
  const runner = $('#course-runner');
  if (!runner || state.courseBound) return;
  state.courseBound = true;
  let sid = null;
  const setResult = (html) => { const r = $('#course-result'); if (r) r.innerHTML = html; };
  const render = (s) => {
    if (!s) return;
    sid = s.sessionId;
    $('#course-panel').style.display = '';
    $('#course-mode').textContent = s.simulated ? '离线模拟' : '真实 bridge';
    $('#course-status').textContent = ({ running: '播放中', paused: '已暂停', done: '已完成', awaiting_human: '待人工处理验证码' })[s.status] || s.status;
    const p = s.progress || { current: 0, total: 0 };
    $('#course-progress-text').textContent = `${p.current} / ${p.total}`;
    $('#course-bar-fill').style.width = (p.total ? Math.round(p.current / p.total * 100) : 0) + '%';
    $('#course-resume').style.display = s.status === 'awaiting_human' ? '' : 'none';
  };
  get('/api/course/meta').then((m) => {
    const hint = $('#course-hint');
    if (hint) hint.textContent = m.defaultBackend === 'bridge'
      ? `真实 bridge 模式 · ${m.platforms.length} 个平台 · 答题默认关`
      : `离线模拟后端 · ${m.platforms.length} 个平台 · 进度为模拟值，独立核验会判 INCONCLUSIVE`;
  }).catch(() => {});
  $('#course-create').onclick = async () => {
    const url = $('#course-url').value.trim();
    const total = Number($('#course-total').value) || 10;
    if (!url) { setResult('<div class="warnbox">请填写课程页地址</div>'); return; }
    try { render(await post('/api/course/create', { url, total })); setResult('<div class="muted small">会话已创建，可推进章节。</div>'); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#course-tick').onclick = async () => {
    if (!sid) return setResult('<div class="warnbox">请先创建会话</div>');
    try { render(await post('/api/course/' + encodeURIComponent(sid) + '/tick', { steps: 1 })); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#course-pause').onclick = async () => {
    if (!sid) return;
    try { render(await post('/api/course/' + encodeURIComponent(sid) + '/pause', {})); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#course-resume').onclick = async () => {
    if (!sid) return;
    try { render(await post('/api/course/' + encodeURIComponent(sid) + '/resume', {})); }
    catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
  $('#course-eval').onclick = async () => {
    if (!sid) return setResult('<div class="warnbox">请先创建会话</div>');
    try {
      const v = await post('/api/course/' + encodeURIComponent(sid) + '/eval', {});
      const badge = v.verdict === 'PASS' ? 'ok' : v.verdict === 'FAIL' ? 'err' : 'warn';
      setResult(`<div class="note"><span class="badge ${badge}">${esc(v.verdict)}</span></div>` +
        (v.failures || []).map((f) => `<div class="warnbox">${esc(f)}</div>`).join(''));
    } catch (e) { setResult(`<div class="warnbox">${esc(e.message)}</div>`); }
  };
}

function renderWorkbench(s) {
  const wb = $('#workbench-view');
  state.courseBound = false; state.hwBound = false; state.projBound = false; // innerHTML 重建后需重新绑定
  const meta = NAV_SECTIONS.find((x) => x.id === s.id) || {};
  const io = s.io || { input: [], output: [], boundary: '' };
  const projects = s.projects || [];
  const statusCls = s.status === 'active' ? ' ok' : '';

  wb.innerHTML = `
    <div class="wb-head">
      <div class="wb-icon">${esc(s.icon || meta.icon || '▦')}</div>
      <div class="wb-titles">
        <div class="wb-name">${esc(s.name || meta.name || s.id)} <span class="badge">${esc(s.priority || '')}</span> <span class="badge${statusCls}">${esc(s.status || '')}</span></div>
        <div class="wb-sub">方案工作台 · 核心目标 / 典型场景 / 所需能力 / 输入输出 / GitHub 选型 / 执行计划演示</div>
      </div>
    </div>
    <div class="wb-scroll">
      <section class="wb-card">
        <h3>核心目标</h3>
        <p class="wb-goal">${esc(s.goal || '')}</p>
        ${io.boundary ? `<div class="note">边界：${esc(io.boundary)}</div>` : ''}
        ${s.definitionNote ? `<div class="warnbox" style="margin-top:8px">${esc(s.definitionNote)}</div>` : ''}
      </section>
      <div class="wb-grid">
        <section class="wb-card">
          <h3>典型场景</h3>
          <ol class="clean">${(s.scenarios || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
        </section>
        <section class="wb-card">
          <h3>所需能力</h3>
          <div class="tags">${(s.capabilities || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
        </section>
      </div>
      <div class="wb-grid">
        <section class="wb-card">
          <h3>输入</h3>
          <ul class="clean">${(io.input || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </section>
        <section class="wb-card">
          <h3>输出</h3>
          <ul class="clean">${(io.output || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </section>
      </div>
      ${s.id === 'course_auto' ? courseRunnerHtml() : ''}
      ${s.id === 'homework' ? homeworkRunnerHtml() : ''}
      ${s.id === 'project_lab' ? projectRunnerHtml() : ''}
      <section class="wb-card">
        <h3>GitHub 选型</h3>
        <table class="wb-table">
          <thead><tr><th>角色</th><th>项目 / 选用理由</th><th>快照 / 许可</th></tr></thead>
          <tbody>${projects.map((p) => `<tr>
            <td>${esc(p.role)}</td>
            <td><code>${esc(p.repo)}</code><div class="muted small">${esc(p.why)}</div>${p.verify ? `<div class="muted small">核验：${esc(p.verify)}</div>` : ''}</td>
            <td class="small">${esc(p.stars || '—')}<br>${esc(p.license || '需核对')}</td>
          </tr>`).join('')}</tbody>
        </table>
        <div class="warnbox" style="margin-top:10px">星标数为不同来源快照，请以 GitHub 实时页为准。</div>
      </section>
      <section class="wb-card">
        <h3>生成执行计划 <span class="badge warn">方案演示 · 非真实执行</span></h3>
        <div class="plan-controls">
          <input id="plan-task" class="plan-input" type="text" placeholder="描述本次任务（仅用于生成演示计划）" />
          <button class="btn" id="plan-gen">生成计划</button>
        </div>
        <div id="plan-result" class="plan-result">
          <div class="muted">点击「生成计划」查看模拟命令链与审批门禁；不会执行任何真实操作，也不接触真实凭据。</div>
        </div>
      </section>
    </div>`;

  $('#plan-gen').onclick = generatePlan;
  $('#plan-task').onkeydown = (e) => { if (e.key === 'Enter') generatePlan(); };
  if (s.id === 'course_auto') bindCourseRunner();
  if (s.id === 'homework') bindHomeworkRunner();
  if (s.id === 'project_lab' && typeof bindProjectRunner === 'function') bindProjectRunner();
}

function planHtml(plan) {
  const steps = plan.steps || [];
  return `<div class="plan-meta">${esc(plan.planId)} · ${esc(plan.section)} · ${esc(plan.task)} · 审批门禁：${esc((plan.approvalGates || []).join(', ') || '无')}</div>
    <div class="plan-steps">${steps.map((st) => `<div class="plan-step${st.gate ? ' gate' : ''}">
      <span class="pn">${st.id}</span><code>${esc(st.cmd)}</code><span class="pd">${esc(st.desc)}</span>${st.gate ? '<span class="badge warn">门禁</span>' : ''}
    </div>`).join('')}</div>
    <div class="warnbox">${esc(plan.disclaimer || '方案演示，非真实执行。')}</div>`;
}

async function generatePlan() {
  if (state.planBusy) return;
  const box = $('#plan-result');
  const input = $('#plan-task');
  if (!box) return;
  state.planBusy = true;
  box.innerHTML = '<div class="muted">生成中…</div>';
  const section = getSectionById(state.activeSection);
  const task = (input ? input.value : '').trim();
  try {
    // 所有版块的计划统一由后端 buildPlan 生成（单一事实源）
    const plan = await post('/api/plan', { sectionId: section.id, task });
    box.innerHTML = planHtml(plan);
  } catch (e) {
    box.innerHTML = `<div class="warnbox">生成失败：${esc(e.message)}</div>`;
  } finally {
    state.planBusy = false;
  }
}

// ---------- 课程表（P4） ----------
// 独立周视图：不套"方案工作台"外壳，因为这是真实可用功能，不是方案卡片。
// 数据全部来自 /api/timetable，前端不保存课表副本（单一事实源）。
const TT = { data: null, reminder: { started: false } };
const TT_WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const TT_WEEK_MAX = 30;
const TT_REMIND_KEY = 'moyu_tt_remind';
const TT_SENT_KEY = 'moyu_tt_sent';

/** 侧栏今日摘要：第几周 · 今天几节 · 正在上/下一节。失败则静默隐藏。 */
async function refreshTodayLine() {
  const line = $('#today-line');
  if (!line) return;
  try {
    const d = await get('/api/timetable/digest');
    if (!d.hasTerm) { line.hidden = true; return; }
    const bits = [];
    if (d.week != null && d.week >= 1) bits.push(`第 ${d.week} 周`);
    bits.push(d.courseCount ? `今天 ${d.courseCount} 节` : '今天没课');
    if (d.current) bits.push(`正在上 ${d.current.name}`);
    else if (d.next && d.next.dayOffset === 0) bits.push(`下一节 ${d.next.startAt} ${d.next.name}`);
    else if (d.next) bits.push(`下节 ${d.next.dayName} ${d.next.startAt}`);
    line.textContent = bits.join(' · ');
    line.title = d.text;
    line.hidden = false;
  } catch (_) { line.hidden = true; }
}

/** 上课提醒：仅在用户显式开启且已授权通知时生效；本地判断，不上传任何数据。 */
async function ttTickReminders() {
  if (localStorage.getItem(TT_REMIND_KEY) !== '1') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  let d;
  try { d = await get('/api/timetable/digest'); } catch (_) { return; }
  const n = d.next;
  // 只提醒今天的下一节；跨天课程交给日历/次日首次打开
  if (!n || n.dayOffset !== 0 || n.startsInMin == null) return;
  let sent = [];
  try { sent = JSON.parse(localStorage.getItem(TT_SENT_KEY) || '[]'); } catch (_) { sent = []; }
  if (!Array.isArray(sent)) sent = [];
  for (const th of [10, 1]) {
    // 轮询 60s，留 2 分钟窗口，避免定时器节流导致错过
    if (n.startsInMin > th || n.startsInMin < th - 2) continue;
    const key = `${n.courseId}|${d.date}|${n.startAt}|${th}`;
    if (sent.includes(key)) continue;
    sent.push(key);
    try { localStorage.setItem(TT_SENT_KEY, JSON.stringify(sent.slice(-50))); } catch (_) {}
    try {
      new Notification(`${n.name} ${th} 分钟后上课`, {
        body: `${n.startAt} · ${n.location || '地点未填'} · 第 ${n.startPeriod}-${n.endPeriod} 节`,
        tag: key,
      });
    } catch (_) {}
  }
}
function ttStartReminderTicker() {
  if (TT.reminder.started) return;
  TT.reminder.started = true;
  ttTickReminders();
  setInterval(ttTickReminders, 60000);
}

function ttHashHue(s) {
  let h = 0;
  for (const ch of String(s || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function ttFmtMin(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 60) return `${n} 分钟`;
  const m = n % 60;
  return m ? `${Math.floor(n / 60)} 小时 ${m} 分` : `${Math.floor(n / 60)} 小时`;
}
function ttMonday(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function ttIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function renderTimetable({ week } = {}) {
  const box = $('#timetable-view');
  if (!box) return;
  if (week !== undefined) state.ttWeek = week;
  const q = new URLSearchParams();
  if (state.ttWeek) q.set('week', String(state.ttWeek));
  box.innerHTML = '<div class="wb-loading muted">加载课表…</div>';
  try {
    TT.data = await get('/api/timetable' + (q.toString() ? '?' + q.toString() : ''));
  } catch (e) {
    box.innerHTML = `<div class="warnbox" style="margin:24px">课表加载失败：${esc(e.message)}</div>`;
    return;
  }
  if (state.activeSection !== 'timetable') return;
  if (TT.data.week) state.ttWeek = TT.data.week;
  paintTimetable();
}

function ttBannerHtml(v) {
  const out = [];
  if (!v.term) {
    out.push('<div class="warnbox">还没有设置学期。先填「开学日期（第 1 周周一）」与总周数，或先载入示例课表体验。</div>');
  } else if (v.currentWeek != null && v.currentWeek < 1) {
    out.push(`<div class="note">学期尚未开始（开学 ${esc(v.term.startDate)}），当前预览第 1 周。</div>`);
  } else if (v.currentWeek != null && v.currentWeek > v.term.totalWeeks) {
    out.push(`<div class="note">学期已结课（共 ${v.term.totalWeeks} 周），当前预览学期最后一周的课程安排。</div>`);
  }
  if (v.demo) out.push('<div class="note">当前是<b>示例课表</b>（demo），可随时「清空全部」后录入自己的课。</div>');
  if (v.conflicts && v.conflicts.length) {
    const list = v.conflicts.slice(0, 3).map((c) => `「${esc(c.aName)}」×「${esc(c.bName)}」${TT_WEEKDAYS[c.day - 1]} 第 ${c.sharedWeeks.join(',')} 周`);
    out.push(`<div class="warnbox">检测到 ${v.conflicts.length} 处时间冲突：${list.join('；')}${v.conflicts.length > 3 ? '…' : ''}。请删除或调整冲突课程。</div>`);
  }
  return out.join('');
}

function ttGridHtml(v) {
  const periods = v.periods || [];
  // 全部单元格显式定位：课程块也是显式 span，若空单元格靠自动排布会被课程块挤到错误列。
  let html = '<div class="tt-corner" style="grid-column:1;grid-row:1">节次</div>';
  v.days.forEach((d, di) => {
    const isToday = v.today && Number(v.today.weekday) === d.day && Number(v.week) === Number(v.currentWeek);
    html += `<div class="tt-dayhead${isToday ? ' today' : ''}" style="grid-column:${di + 2};grid-row:1"><b>${esc(d.name)}</b><span>${d.date ? esc(d.date.slice(5)) : '—'}</span></div>`;
  });
  periods.forEach((p, pi) => {
    const row = pi + 2;
    html += `<div class="tt-time" style="grid-column:1;grid-row:${row}"><b>${p.period}</b><span>${esc(p.start)}</span><span>${esc(p.end)}</span></div>`;
    v.days.forEach((d, di) => { html += `<div class="tt-cell" style="grid-column:${di + 2};grid-row:${row}"></div>`; });
  });
  v.days.forEach((d, di) => {
    d.courses.forEach((c) => {
      const span = Number(c.endPeriod) - Number(c.startPeriod) + 1;
      const hue = ttHashHue(c.name);
      const meta = [c.location, `${c.startPeriod}-${c.endPeriod} 节`].filter(Boolean).join(' · ');
      html += `<div class="tt-course${c.conflict ? ' conflict' : ''}" data-id="${esc(c.id)}" style="grid-column:${di + 2};grid-row:${Number(c.startPeriod) + 1} / span ${span};--h:${hue}"
        title="${esc([c.name, c.teacher, c.location, `第 ${c.startPeriod}-${c.endPeriod} 节`, `周次 ${c.weeks}`].filter(Boolean).join(' · '))}">
        <button class="tt-del" data-id="${esc(c.id)}" title="删除这门课">×</button>
        <div class="tt-c-name">${esc(c.name)}</div>
        <div class="tt-c-meta">${esc(meta)}</div>
        <div class="tt-c-weeks">${esc(c.weeks)} 周</div>
      </div>`;
    });
  });
  return html;
}

function ttTodayHtml(t, totalCourses) {
  if (!t) return '<div class="muted">暂无</div>';
  const out = [];
  if (!totalCourses) {
    return '<div class="muted">课表为空：先设置学期并添加课程，或载入示例课表。</div>';
  }
  if (t.current) {
    out.push(`<div class="tt-now-card live">
      <div class="tt-now-top"><span class="badge ok">正在上课</span><span class="muted small">剩余 ${esc(ttFmtMin(t.current.remainingMin))}</span></div>
      <div class="tt-now-name">${esc(t.current.name)}</div>
      <div class="tt-now-meta">${esc([t.current.location, `第 ${t.current.startPeriod}-${t.current.endPeriod} 节`, `${t.current.startAt}-${t.current.endAt}`].filter(Boolean).join(' · '))}</div>
    </div>`);
  }
  if (t.next) {
    const n = t.next;
    const when = n.dayOffset === 0 || n.dayOffset === undefined ? `今天 ${n.startAt}` : `${n.dayName || ''} ${n.startAt}`;
    const inText = n.startsInMin != null ? ` · ${ttFmtMin(n.startsInMin)}后` : '';
    out.push(`<div class="tt-now-card">
      <div class="tt-now-top"><span class="badge">${n.dayOffset > 0 ? '下节课' : '接下来'}</span><span class="muted small">${esc(when)}${esc(inText)}</span></div>
      <div class="tt-now-name">${esc(n.name)}</div>
      <div class="tt-now-meta">${esc([n.location, `第 ${n.startPeriod}-${n.endPeriod} 节`].filter(Boolean).join(' · '))}</div>
    </div>`);
  }
  if (!t.current && !t.next) out.push('<div class="tt-empty-ok">今天没有课了，去摸鱼吧。</div>');
  if (t.courses && t.courses.length) {
    out.push(`<div class="tt-today-list">${t.courses.map((c) => `<div class="tt-today-row">
      <span class="p">${c.startPeriod}-${c.endPeriod}</span>
      <span class="n">${esc(c.name)}</span>
      <span class="l muted small">${esc(c.location || '')}</span>
    </div>`).join('')}</div>`);
  }
  return out.join('');
}

function ttFreeHtml(v) {
  if (!v.stats || !v.stats.courses) return '<div class="muted">课表为空，暂无有意义的空闲窗口。</div>';
  const slots = v.freeSlots || [];
  if (!slots.length) return '<div class="muted">本周没有连续 ≥2 节的空闲（按当前节次表计算）。</div>';
  return `<div class="tt-free-list">${slots.slice(0, 8).map((s) => `<div class="tt-free-row">
      <span class="d">${esc(s.dayName)}</span>
      <span class="p">第 ${s.startPeriod}-${s.endPeriod} 节</span>
      <span class="t muted small">${esc(s.from)}-${esc(s.to)}</span>
      <span class="badge">${s.periods} 节</span>
    </div>`).join('')}</div>
    <div class="muted small" style="margin-top:8px">仅按课表计算，不含通勤、作业与自习安排；${slots.length > 8 ? `共 ${slots.length} 段，仅显示前 8 段。` : ''}</div>`;
}

function paintTimetable() {
  const v = TT.data;
  const box = $('#timetable-view');
  if (!v || !box) return;
  const term = v.term;
  const weekNo = v.week;
  const isOtherWeek = v.currentWeek != null && Number(weekNo) !== Number(v.currentWeek);
  const weekBadge = !term
    ? '未设置学期'
    : `第 ${weekNo} 周${isOtherWeek && v.currentWeek >= 1 ? `（本周第 ${v.currentWeek} 周）` : ''}`;
  const termLine = term
    ? `${esc(term.name || '本学期')} · ${esc(term.startDate)} 开学 · 共 ${term.totalWeeks} 周 · ${v.periods.length} 节/天`
    : '未设置学期 · 先设置开学日期，或载入示例';
  const weeksDefault = term ? `1-${term.totalWeeks}` : '1-16';
  const dayOptions = v.days.map((d) => `<option value="${d.day}">${esc(d.name)}</option>`).join('');
  const periodOptions = v.periods.map((p) => `<option value="${p.period}">第 ${p.period} 节 · ${esc(p.start)}</option>`).join('');

  box.innerHTML = `
    <header class="tt-head">
      <div class="wb-titles">
        <div class="wb-name">课程表 <span class="badge">${esc(weekBadge)}</span>
          <span class="badge">${v.stats.weeklyPeriods} 节 / 本周</span>
          ${!v.stats.courses ? '<span class="badge">空课表</span>'
            : v.conflicts.length ? `<span class="badge err">${v.conflicts.length} 处冲突</span>`
              : '<span class="badge ok">无冲突</span>'}
        </div>
        <div class="wb-sub">${termLine}</div>
      </div>
      <div class="tt-actions">
        <button class="btn ghost tt-nav" id="tt-prev" title="上一周" ${weekNo <= 1 ? 'disabled' : ''}>‹</button>
        <button class="btn ghost" id="tt-now">本周</button>
        <button class="btn ghost tt-nav" id="tt-next" title="下一周" ${weekNo >= TT_WEEK_MAX ? 'disabled' : ''}>›</button>
      </div>
    </header>
    <div class="tt-scroll">
      <div id="tt-banner">${ttBannerHtml(v)}</div>
      <section class="wb-card tt-card">
        <div class="tt-grid-wrap">
          <div class="tt-grid" style="grid-template-rows:30px repeat(${v.periods.length}, 56px)">${ttGridHtml(v)}</div>
        </div>
        <div class="tt-grid-hint muted small">课时块显示课程名与地点；点右上角 × 删除（需点两次确认）。第 ${weekNo} 周 · 单双周已按周次表达式过滤。</div>
      </section>
      <div class="wb-grid">
        <section class="wb-card">
          <h3>现在 / 下一节</h3>
          ${ttTodayHtml(v.today, v.stats.courses)}
          <div class="tt-remind-row">
            <button class="btn ghost" id="tt-remind">开启上课提醒</button>
            <span class="muted small" id="tt-remind-hint">上课前 10 分钟与 1 分钟各提醒一次；仅本地判断，不上传。</span>
          </div>
        </section>
        <section class="wb-card">
          <h3>摸鱼窗口 <span class="badge">连续 ≥2 节</span></h3>
          ${ttFreeHtml(v)}
        </section>
      </div>

      <section class="wb-card">
        <h3>添加课程</h3>
        <div class="tt-form">
          <label class="tt-field tt-span2">课程名称<input id="tt-name" class="plan-input" type="text" maxlength="60" placeholder="如：高等数学" /></label>
          <label class="tt-field">教师<input id="tt-teacher" class="plan-input" type="text" maxlength="40" placeholder="可选" /></label>
          <label class="tt-field">地点<input id="tt-loc" class="plan-input" type="text" maxlength="40" placeholder="如：教三-201" /></label>
          <label class="tt-field">星期<select id="tt-day" class="plan-input">${dayOptions}</select></label>
          <label class="tt-field">开始节次<select id="tt-start" class="plan-input">${periodOptions}</select></label>
          <label class="tt-field">结束节次<select id="tt-end" class="plan-input">${periodOptions}</select></label>
          <label class="tt-field">周次<input id="tt-weeks" class="plan-input" type="text" value="${esc(weeksDefault)}" placeholder="1-16 / 1-16单 / 2-16双" /></label>
          <div class="tt-form-actions tt-span2">
            <button class="btn" id="tt-add">添加</button>
            <button class="btn ghost" id="tt-cancel-edit" hidden>取消编辑</button>
            <label class="auto-approve"><input type="checkbox" id="tt-force" /> 冲突也强制保存（会标记）</label>
          </div>
        </div>
        <div id="tt-add-result" class="plan-result"></div>
      </section>

      <section class="wb-card">
        <h3>学期设置 <span class="badge">${term ? '已配置' : '待配置'}</span></h3>
        <div class="tt-form">
          <label class="tt-field tt-span2">学期名称<input id="tt-term-name" class="plan-input" type="text" maxlength="40" value="${esc(term ? term.name : '')}" placeholder="如：2026 秋季学期" /></label>
          <label class="tt-field">开学日期（第 1 周周一）<input id="tt-term-start" class="plan-input" type="date" value="${esc(term ? term.startDate : '')}" /></label>
          <label class="tt-field">总周数<input id="tt-term-weeks" class="plan-input" type="number" min="1" max="${TT_WEEK_MAX}" value="${term ? term.totalWeeks : 20}" /></label>
          <div class="tt-form-actions tt-span2">
            <button class="btn" id="tt-term-save">保存学期</button>
            <button class="btn ghost" id="tt-term-monday">以本周周一为第 1 周</button>
          </div>
        </div>
        <div id="tt-term-result" class="plan-result"></div>
      </section>

      <section class="wb-card">
        <h3>批量导入 · 自检 · 数据</h3>
        <div class="note">导入只接受本地 JSON（不登录教务系统、不爬取）。字段：<code>{"term":{...},"courses":[...]}</code>；单双周写在 <code>weeks</code> 里，如 <code>1-16单</code>。</div>
        <textarea id="tt-import-json" class="tt-textarea" rows="7" spellcheck="false" placeholder='{"term":{"name":"2026 秋","startDate":"2026-09-07","totalWeeks":20},"courses":[{"name":"高等数学","teacher":"张老师","location":"教三-201","day":1,"startPeriod":1,"endPeriod":2,"weeks":"1-16"}]}'></textarea>
        <div class="tt-form-actions">
          <button class="btn ghost" id="tt-import-fill">填入当前课表</button>
          <button class="btn ghost" id="tt-import-preview">预览校验</button>
          <button class="btn" id="tt-import-replace">覆盖导入</button>
          <button class="btn ghost" id="tt-import-merge">合并导入</button>
          <button class="btn ghost" id="tt-eval">独立自检</button>
        </div>
        <div id="tt-import-result" class="plan-result"></div>
        <div class="tt-divider"></div>
        <div class="tt-subhead">从日历导入 <span class="badge">.ics · 不登录教务系统</span></div>
        <div class="muted small" style="margin-bottom:8px">在教务系统或手机日历里导出 .ics 后选择文件（或粘贴内容）。按当前作息表把时间换算成节次与周次，只读文件、不需要账号密码。</div>
        <div class="tt-form-actions" style="margin-top:0">
          <input type="file" id="tt-ics-file" class="tt-file" accept=".ics,text/calendar" aria-label="选择 ICS 日历文件" />
          <button class="btn ghost" id="tt-ics-preview">解析预览</button>
          <button class="btn" id="tt-ics-import">合并导入</button>
          <button class="btn ghost" id="tt-ics-export">导出 .ics（含上课提醒）</button>
        </div>
        <textarea id="tt-ics-text" class="tt-textarea" rows="5" spellcheck="false" placeholder="BEGIN:VCALENDAR&#10;VERSION:2.0&#10;...（也可以先选择 .ics 文件，自动填入）"></textarea>
        <div id="tt-ics-result" class="plan-result"></div>
        <div class="tt-form-actions" style="margin-top:14px">
          <button class="btn ghost" id="tt-demo">载入示例课表</button>
          <button class="btn ghost" id="tt-clear">清空全部课程</button>
        </div>
        <div id="tt-data-result" class="plan-result"></div>
      </section>
    </div>`;

  bindTimetable(v);
  refreshTodayLine();
}

function ttSetResult(id, html) { const box = $(id); if (box) box.innerHTML = html; }

function bindTimetable(v) {
  const week = v.week;
  const weeksDefault = v.term ? `1-${v.term.totalWeeks}` : '1-16';
  $('#tt-prev').onclick = () => renderTimetable({ week: Math.max(1, week - 1) });
  $('#tt-next').onclick = () => renderTimetable({ week: Math.min(TT_WEEK_MAX, week + 1) });
  $('#tt-now').onclick = () => { state.ttWeek = null; renderTimetable(); };

  // 上课提醒开关：Notification 授权必须由用户手势触发
  const remindBtn = $('#tt-remind');
  const updateRemindUi = () => {
    if (!remindBtn) return;
    const supported = 'Notification' in window;
    const granted = supported && Notification.permission === 'granted';
    const enabled = granted && localStorage.getItem(TT_REMIND_KEY) === '1';
    remindBtn.textContent = !supported ? '浏览器不支持通知'
      : Notification.permission === 'denied' ? '通知已被拒绝'
        : enabled ? '提醒已开启（点击关闭）' : '开启上课提醒';
    remindBtn.classList.toggle('on', enabled);
    const hint = $('#tt-remind-hint');
    if (hint) {
      hint.textContent = !supported ? '当前浏览器不支持系统通知，可导出 .ics 到手机日历提醒。'
        : Notification.permission === 'denied' ? '通知被站点拒绝：在地址栏权限设置里改为「允许」后重试。'
          : enabled ? '已开启：上课前 10 分钟与 1 分钟各提醒一次（需保持页面打开）。'
            : '开启后会在上课前 10 分钟、1 分钟各提醒一次；仅本地判断，不上传。';
    }
  };
  if (remindBtn) {
    remindBtn.onclick = async () => {
      if (!('Notification' in window)) return updateRemindUi();
      if (localStorage.getItem(TT_REMIND_KEY) === '1') {
        localStorage.setItem(TT_REMIND_KEY, '0');
        return updateRemindUi();
      }
      let perm = Notification.permission;
      if (perm !== 'granted') perm = await Notification.requestPermission();
      if (perm === 'granted') {
        localStorage.setItem(TT_REMIND_KEY, '1');
        ttStartReminderTicker();
        ttTickReminders();
      }
      updateRemindUi();
    };
  }
  updateRemindUi();

  const resetTtForm = () => {
    state.ttEditing = null;
    $('#tt-name').value = ''; $('#tt-teacher').value = ''; $('#tt-loc').value = '';
    $('#tt-weeks').value = weeksDefault;
    $('#tt-force').checked = false;
    $('#tt-add').textContent = '添加';
    $('#tt-cancel-edit').hidden = true;
  };
  $('#tt-cancel-edit').onclick = () => { resetTtForm(); ttSetResult('#tt-add-result', '<div class="muted small">已取消编辑。</div>'); };

  // 点击课程块 → 填入表单进入编辑（删除按钮除外）
  $$('.tt-course').forEach((block) => {
    block.onclick = (e) => {
      if (e.target.closest('.tt-del')) return;
      const c = (v.courses || []).find((x) => x.id === block.dataset.id);
      if (!c) return;
      state.ttEditing = c.id;
      $('#tt-name').value = c.name;
      $('#tt-teacher').value = c.teacher || '';
      $('#tt-loc').value = c.location || '';
      $('#tt-day').value = String(c.day);
      $('#tt-start').value = String(c.startPeriod);
      $('#tt-end').value = String(c.endPeriod);
      $('#tt-weeks').value = c.weeks;
      $('#tt-force').checked = false;
      $('#tt-add').textContent = '保存修改';
      $('#tt-cancel-edit').hidden = false;
      ttSetResult('#tt-add-result', `<div class="muted small">正在编辑「${esc(c.name)}」，改完点「保存修改」。</div>`);
      const form = $('.tt-form');
      if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  });

  // 删除课程：两段式确认（预览面板常禁用原生 confirm）
  $$('.tt-del').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1'; btn.textContent = '?'; btn.classList.add('confirming');
        setTimeout(() => { if (btn.dataset.confirm === '1') { btn.dataset.confirm = ''; btn.textContent = '×'; btn.classList.remove('confirming'); } }, 2500);
        return;
      }
      try {
        await api('/api/timetable/courses/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
        renderTimetable({ week });
      } catch (err) { ttSetResult('#tt-add-result', `<div class="warnbox">${esc(err.message)}</div>`); }
    };
  });

  $('#tt-add').onclick = async () => {
    const body = {
      name: $('#tt-name').value.trim(),
      teacher: $('#tt-teacher').value.trim(),
      location: $('#tt-loc').value.trim(),
      day: Number($('#tt-day').value),
      startPeriod: Number($('#tt-start').value),
      endPeriod: Number($('#tt-end').value),
      weeks: $('#tt-weeks').value.trim(),
      force: $('#tt-force').checked,
    };
    const editing = state.ttEditing;
    try {
      const r = editing
        ? await api('/api/timetable/courses/' + encodeURIComponent(editing), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        : await post('/api/timetable/courses', body);
      state.ttEditing = null;
      await renderTimetable({ week });
      ttSetResult('#tt-add-result', `<div class="muted small">${editing ? '已更新' : '已添加'}「${esc(r.course.name)}」。${r.course.conflict ? '（已强制保存，存在冲突，建议调整）' : ''}</div>`);
    } catch (err) {
      const conflicts = err.payload && err.payload.conflicts;
      const detail = conflicts && conflicts.length
        ? '<div class="tt-conflict-list">' + conflicts.map((c) => `<div>· ${esc(c.name)}：${TT_WEEKDAYS[c.day - 1]} 第 ${c.startPeriod}-${c.endPeriod} 节（共享 ${c.sharedWeeks.length} 周）</div>`).join('') + '</div>'
        : '';
      ttSetResult('#tt-add-result', `<div class="warnbox">${esc(err.message)}${detail}</div>`);
    }
  };

  $('#tt-term-save').onclick = async () => {
    const body = {
      name: $('#tt-term-name').value.trim(),
      startDate: $('#tt-term-start').value,
      totalWeeks: Number($('#tt-term-weeks').value),
    };
    try {
      const r = await post('/api/timetable/term', body);
      state.ttWeek = null;
      await renderTimetable();
      const warn = (r.warnings || []).map((w) => `<div class="warnbox">${esc(w)}</div>`).join('');
      ttSetResult('#tt-term-result', `<div class="muted small">学期已保存。</div>${warn}`);
    } catch (err) { ttSetResult('#tt-term-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };
  $('#tt-term-monday').onclick = () => {
    $('#tt-term-start').value = ttIso(ttMonday());
    ttSetResult('#tt-term-result', '<div class="muted small">已填入本周周一；确认后点「保存学期」。</div>');
  };

  const readImport = () => {
    try { return JSON.parse($('#tt-import-json').value || '{}'); }
    catch (err) { ttSetResult('#tt-import-result', `<div class="warnbox">JSON 解析失败：${esc(err.message)}</div>`); return null; }
  };
  $('#tt-import-fill').onclick = () => {
    $('#tt-import-json').value = JSON.stringify({ term: v.term, courses: v.courses }, null, 2);
    ttSetResult('#tt-import-result', '<div class="muted small">已填入当前课表，可编辑后覆盖导入。</div>');
  };
  const showImport = (r) => {
    const errs = (r.errors || []).map((x) => `<div>· ${esc(x)}</div>`).join('');
    if (r.errors && r.errors.length) {
      ttSetResult('#tt-import-result', `<div class="warnbox">校验未通过：${errs}</div>`);
      return;
    }
    const rows = (r.preview || []).slice(0, 200).map((p) => `<div class="trace-row"><span class="n">#${p.index}</span><span>${esc(p.name)}</span><span class="muted small">${TT_WEEKDAYS[p.day - 1]} ${p.startPeriod}-${p.endPeriod} 节 · ${esc(p.weeks)} 周</span></div>`).join('');
    ttSetResult('#tt-import-result', `<div class="note">${r.dryRun ? '预览通过' : `已导入 ${r.imported} 门`}，当前共 ${r.total} 门。</div>${rows}`);
  };
  $('#tt-import-preview').onclick = async () => {
    const body = readImport(); if (!body) return;
    body.dryRun = true;
    try { showImport(await post('/api/timetable/import', body)); }
    catch (err) { ttSetResult('#tt-import-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };
  const doImport = async (mode) => {
    const body = readImport(); if (!body) return;
    body.mode = mode;
    try {
      const r = await post('/api/timetable/import', body);
      state.ttWeek = null;
      await renderTimetable();
      showImport(r);
    } catch (err) { ttSetResult('#tt-import-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };
  $('#tt-import-merge').onclick = () => doImport('merge');
  const replaceBtn = $('#tt-import-replace');
  replaceBtn.onclick = () => {
    if (v.courses.length && replaceBtn.dataset.confirm !== '1') {
      replaceBtn.dataset.confirm = '1'; replaceBtn.textContent = '确认覆盖？';
      setTimeout(() => { if (replaceBtn.dataset.confirm === '1') { replaceBtn.dataset.confirm = ''; replaceBtn.textContent = '覆盖导入'; } }, 3000);
      return;
    }
    replaceBtn.dataset.confirm = ''; replaceBtn.textContent = '覆盖导入';
    doImport('replace');
  };

  // ---------- ICS 日历导入 / 导出 ----------
  const showIcs = (r) => {
    const errs = (r.errors || []).map((x) => `<div>· ${esc(x)}</div>`).join('');
    if (r.errors && r.errors.length) {
      ttSetResult('#tt-ics-result', `<div class="warnbox">未通过：${errs}</div>`);
      return;
    }
    const rows = (r.preview || []).slice(0, 200).map((p) => `<div class="trace-row"><span class="n">#${p.index}</span><span>${esc(p.name)}</span><span class="muted small">${TT_WEEKDAYS[p.day - 1]} ${p.startPeriod}-${p.endPeriod} 节 · ${esc(p.weeks)} 周 · ${esc(p.location || '未填地点')}</span></div>`).join('');
    const warns = (r.warnings || []).slice(0, 6).map((w) => `<div class="muted small">· ${esc(w)}</div>`).join('');
    ttSetResult('#tt-ics-result', `<div class="note">解析到 ${r.parsedEvents} 个日程，${r.dryRun ? `可生成 ${r.preview.length} 门课程（预览，未写入）` : `已导入 ${r.imported} 门，当前共 ${r.total} 门`}。</div>${rows}${warns}`);
  };
  const previewIcs = async () => {
    const text = $('#tt-ics-text').value.trim();
    if (!text) { ttSetResult('#tt-ics-result', '<div class="warnbox">请选择 .ics 文件或粘贴内容</div>'); return; }
    try { showIcs(await post('/api/timetable/import/ics', { ics: text, dryRun: true, mode: 'merge' })); }
    catch (err) { ttSetResult('#tt-ics-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };
  $('#tt-ics-preview').onclick = previewIcs;
  $('#tt-ics-file').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      $('#tt-ics-text').value = text;
      ttSetResult('#tt-ics-result', `<div class="muted small">已读取 ${esc(f.name)}（${text.length} 字符），解析中…</div>`);
      await previewIcs();
    } catch (err) { ttSetResult('#tt-ics-result', `<div class="warnbox">读取文件失败：${esc(err.message)}</div>`); }
  };
  $('#tt-ics-import').onclick = async () => {
    const text = $('#tt-ics-text').value.trim();
    if (!text) { ttSetResult('#tt-ics-result', '<div class="warnbox">请选择 .ics 文件或粘贴内容</div>'); return; }
    try {
      const r = await post('/api/timetable/import/ics', { ics: text, mode: 'merge' });
      state.ttWeek = null;
      await renderTimetable();
      showIcs(r);
    } catch (err) { ttSetResult('#tt-ics-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };
  $('#tt-ics-export').onclick = async () => {
    try {
      const r = await fetch('/api/timetable/export.ics', { headers: SESSION_TOKEN ? { 'X-Moyu-Token': SESSION_TOKEN } : {} });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'HTTP ' + r.status);
      }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'moyu-timetable.ics';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      ttSetResult('#tt-ics-result', '<div class="muted small">已导出 .ics：可导入手机/电脑日历，含上课前 10 分钟提醒。</div>');
    } catch (err) { ttSetResult('#tt-ics-result', `<div class="warnbox">导出失败：${esc(err.message)}</div>`); }
  };

  $('#tt-eval').onclick = async () => {
    try {
      const r = await post('/api/timetable/eval', {});
      const cls = r.verdict === 'PASS' ? 'ok' : r.verdict === 'FAIL' ? 'err' : 'warn';
      const fails = (r.failures || []).map((f) => `<div class="warnbox">${esc(f)}</div>`).join('');
      ttSetResult('#tt-import-result', `<div class="note"><span class="badge ${cls}">自检 ${esc(r.verdict)}</span> 课程 ${r.stats ? r.stats.courses : '—'} 门 · 冲突 ${r.stats ? r.stats.conflicts : '—'} 处</div>${fails}`);
    } catch (err) { ttSetResult('#tt-import-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };

  const demoBtn = $('#tt-demo');
  demoBtn.onclick = async () => {
    if (v.courses.length && demoBtn.dataset.confirm !== '1') {
      demoBtn.dataset.confirm = '1'; demoBtn.textContent = '确认替换为示例？';
      setTimeout(() => { if (demoBtn.dataset.confirm === '1') { demoBtn.dataset.confirm = ''; demoBtn.textContent = '载入示例课表'; } }, 3000);
      return;
    }
    demoBtn.dataset.confirm = ''; demoBtn.textContent = '载入示例课表';
    try {
      await post('/api/timetable/demo', { replace: true });
      state.ttWeek = null;
      renderTimetable();
    } catch (err) { ttSetResult('#tt-data-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };

  const clearBtn = $('#tt-clear');
  clearBtn.onclick = async () => {
    if (!v.courses.length) { ttSetResult('#tt-data-result', '<div class="muted small">课表已经是空的。</div>'); return; }
    if (clearBtn.dataset.confirm !== '1') {
      clearBtn.dataset.confirm = '1'; clearBtn.textContent = '确认清空？';
      setTimeout(() => { if (clearBtn.dataset.confirm === '1') { clearBtn.dataset.confirm = ''; clearBtn.textContent = '清空全部课程'; } }, 3000);
      return;
    }
    clearBtn.dataset.confirm = ''; clearBtn.textContent = '清空全部课程';
    try {
      const r = await api('/api/timetable/courses', { method: 'DELETE' });
      state.ttWeek = null;
      await renderTimetable();
      ttSetResult('#tt-data-result', `<div class="muted small">已清空 ${r.cleared} 门课程。</div>`);
    } catch (err) { ttSetResult('#tt-data-result', `<div class="warnbox">${esc(err.message)}</div>`); }
  };
}

// ---------- 会话列表 ----------
async function loadRuns() {
  state.runs = await get('/api/agent/runs');
  const box = $('#session-list'); box.innerHTML = '';
  if (!state.runs.length) { box.appendChild(el('div', 'side-empty', '暂无会话，发一条消息开始')); return; }
  state.runs.forEach((r) => {
    const item = el('div', 'session-item' + (state.currentRun === r.runId && state.activeSection === 'jev_reply' ? ' active' : ''));
    item.innerHTML = `<div class="t">${esc((r.task || '(空任务)').slice(0, 22))}</div><span class="s">${esc(r.status === 'done' ? '完成' : r.status === 'awaiting_approval' ? '待批' : '异常')}</span><button class="del-run" title="删除此会话" data-id="${esc(r.runId)}">×</button>`;
    item.title = r.runId;
    item.onclick = (e) => { if (e.target.closest('.del-run')) return; openRun(r.runId); };
    const delBtn = item.querySelector('.del-run');
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      // 两段式确认：不依赖 confirm/alert（预览面板常禁用原生弹窗）
      if (delBtn.dataset.confirm !== '1') {
        delBtn.dataset.confirm = '1';
        delBtn.textContent = '?';
        delBtn.classList.add('confirming');
        setTimeout(() => { if (delBtn.dataset.confirm === '1') { delBtn.dataset.confirm = ''; delBtn.textContent = '×'; delBtn.classList.remove('confirming'); } }, 3000);
        return;
      }
      try {
        await api('/api/agent/runs/' + encodeURIComponent(r.runId), { method: 'DELETE' });
        if (state.currentRun === r.runId) { state.currentRun = null; $('#chat-title').textContent = '新会话'; }
        await loadRuns();
      } catch (err) { delBtn.textContent = '!'; delBtn.title = '删除失败：' + err.message; }
    };
    box.appendChild(item);
  });
}

async function openRun(runId) {
  if (state.activeSection !== 'jev_reply') switchSection('jev_reply');
  const r = await get('/api/agent/runs/' + encodeURIComponent(runId));
  if (!r) return;
  state.currentRun = runId;
  $('#chat-title').textContent = (r.task || '会话').slice(0, 24);
  const m = $('#messages'); m.innerHTML = '';
  addUserMessage(r.task, false);
  addAgentMessage(r, false);
  loadRuns();
}

// ---------- 消息渲染 ----------
function addUserMessage(text, scroll = true) {
  const m = $('#messages');
  const wrap = el('div', 'msg user');
  wrap.innerHTML = `<div class="avatar">你</div><div class="bubble">${esc(text)}</div>`;
  m.appendChild(wrap); if (scroll) scrollBottom();
}
function addAgentMessage(r, scroll = true) {
  const m = $('#messages');
  $('#welcome')?.remove();
  const wrap = el('div', 'msg agent');
  const bubble = el('div', 'bubble');
  // 透明度：降级时明确标注实际执行模式，避免把 mock 结果误认为 live
  const modeTag = r.degraded ? `${r.provider?.requestedMode || ''}→mixed（步骤 ${(r.degradedSteps || []).join(',')} 降级）` : (r.provider?.mode || 'mock');
  const deciderTag = r.decider?.backend ? `决策:${r.decider.backend}` : '';
  bubble.appendChild(el('div', 'label', `摸鱼Agent · ${r.runId} · ${r.provider?.id || 'mock'} / ${r.provider?.model || ''} · ${modeTag}${deciderTag ? ' · ' + deciderTag : ''}`));

  if (r.degraded) {
    bubble.appendChild(el('div', 'warnbox', `⚠ 部分步骤调用失败已降级为本地模拟（${(r.degradedSteps || []).join('、')}），结果仅供参考。`));
  }
  if (r.error) {
    bubble.appendChild(el('div', 'warnbox', `执行异常：${esc(r.error.message)}`));
  }

  if (r.decision) {
    const d = r.decision;
    const g = el('div', 'decision-grid');
    const dangerCls = Number(d.danger) >= 7 ? 'danger-high' : 'danger-low';
    g.innerHTML = `<div class="d"><div class="k">意图</div><div class="v">${esc(d.intent)}</div></div>
      <div class="d"><div class="k">危险等级</div><div class="v ${dangerCls}">${esc(d.danger)}/9</div></div>
      <div class="d"><div class="k">立即回复</div><div class="v">${d.should_reply_now ? '是' : '否'}</div></div>
      <div class="d"><div class="k">最佳动作</div><div class="v">${esc(d.best_action)}</div></div>`;
    bubble.appendChild(el('div', '', 'Jev 决策：'));
    bubble.appendChild(g);
  }

  if (r.ranked?.length) {
    bubble.appendChild(el('div', '', '候选回复（已排序）：'));
    const box = el('div', 'drafts');
    r.ranked.forEach((x, i) => box.appendChild(el('div', 'draft', `<span>${i + 1}. ${esc(x.text)}</span><span class="score">${x.score}</span>`)));
    bubble.appendChild(box);
  }

  if (r.filled) bubble.appendChild(el('div', 'filled', `✓ 已填入输入框：「${esc(r.filled)}」— 未自动发送`));
  else if (r.decision?.best_action === 'ask_human') bubble.appendChild(el('div', 'warnbox', '⚠ 检测到高危内容，已升级人工处理，不填不发送。'));

  const traceBtn = el('button', 'trace-btn', `▸ 执行轨迹（${r.trace?.length || 0} 步）`);
  const trace = el('div', 'trace');
  (r.trace || []).forEach((t) => trace.appendChild(el('div', 'trace-row', `<span class="n">${t.step}</span><span class="e">${esc(t.event)}</span><span>${esc(t.tool || t.reason || t.error || '')}</span>`)));
  traceBtn.onclick = () => { trace.classList.toggle('open'); traceBtn.textContent = (trace.classList.contains('open') ? '▾' : '▸') + ` 执行轨迹（${r.trace?.length || 0} 步）`; };
  bubble.appendChild(traceBtn); bubble.appendChild(trace);
  bubble.appendChild(el('div', 'reply-note', `状态 ${esc(r.status)} · fill-only，发送权在你`));

  wrap.appendChild(bubble); m.appendChild(wrap); if (scroll) scrollBottom();
}
function scrollBottom() { const m = $('#messages'); m.scrollTop = m.scrollHeight; }

// ---------- 发送 ----------
let sendArmed = false; let sendArmTimer = null;
function disarmSend() {
  sendArmed = false;
  if (sendArmTimer) { clearTimeout(sendArmTimer); sendArmTimer = null; }
  const b = $('#send'); if (b && !state.busy) b.textContent = '发送 ▶';
}
async function send() {
  if (state.busy) return;
  if (state.activeSection !== 'jev_reply') switchSection('jev_reply');
  const input = $('#input');
  const real = $('#real-mode').checked;
  const text = input.value.trim() || (real ? '(从剪贴板读取对方消息)' : '');
  if (!text) return;
  // U2 生成前询问（始终生效）：首次点击进入确认态，二次点击才真正生成（与删除/清空的两段式一致）。
  // 该门禁与"自动通过审批门禁"解耦——后者只影响 gate 步骤，不影响生成前确认。
  if (!sendArmed) {
    sendArmed = true;
    $('#send').textContent = '确认生成？';
    sendArmTimer = setTimeout(disarmSend, 4000);
    return;
  }
  disarmSend();
  state.busy = true; $('#send').disabled = true; $('#send').textContent = '运行中…';
  addUserMessage(text);
  input.value = '';

  const preset = $('#model-select').value;
  const approve = $('#auto-approve').checked;
  try {
    // auto-approve 开启时，先向服务端申请一次性审批凭证（前端不再自造 approvals）。
    // 关闭时不申请，gate 步骤会停在 awaiting_approval，由服务端兜底。
    let approvalsPayload = {};
    if (approve) {
      const grant = await post('/api/agent/approval', { steps: [3, 5] });
      approvalsPayload = { approvalToken: grant.token };
    }
    const r = await post('/api/agent/run', {
      preset, task: text,
      model: $('#model-id').value.trim() || undefined,
      baseUrl: $('#base-url').value.trim() || undefined,
      realMode: $('#real-mode').checked,
      ...approvalsPayload,
    });
    state.currentRun = r.runId;
    addAgentMessage(r);
    $('#chat-title').textContent = text.slice(0, 24);
    loadRuns();
  } catch (e) {
    const m = $('#messages');
    const w = el('div', 'msg agent');
    w.innerHTML = `<div class="avatar">M</div><div class="bubble"><div class="warnbox">${esc(e.message)}</div></div>`;
    m.appendChild(w); scrollBottom();
  } finally { state.busy = false; $('#send').disabled = false; $('#send').textContent = '发送 ▶'; }
}

// ---------- 抽屉 ----------
async function openDrawer(kind) {
  state.drawer = kind;
  $('#drawer').classList.add('open');
  const titles = { sections: '版块方案', projects: '开源选型', profile: '环境档案', health: '体检' };
  $('#drawer-title').textContent = titles[kind] || '';
  const body = $('#drawer-body'); body.innerHTML = '<div class="muted">加载中…</div>';
  try {
    if (kind === 'sections') await drawerSections(body);
    else if (kind === 'projects') await drawerProjects(body);
    else if (kind === 'profile') await drawerProfile(body);
    else if (kind === 'health') await drawerHealth(body);
  } catch (e) { body.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}
function closeDrawer() { state.drawer = null; $('#drawer').classList.remove('open'); }

function sectionDetailHtml(d) {
  return `<div class="t">${esc(d.name)} · 详情</div>
    <h2>场景</h2><ul class="clean">${(d.scenarios || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <h2>能力</h2><ul class="clean">${(d.capabilities || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <h2>输入/输出</h2><div class="note">入：${(d.io?.input || []).map(esc).join('、')}<br>出：${(d.io?.output || []).map(esc).join('、')}</div>
    <h2>GitHub 选型</h2><table><tbody>${(d.projects || []).map((p) => `<tr><td>${esc(p.role)}</td><td><code>${esc(p.repo)}</code></td></tr>`).join('')}</tbody></table>`;
}

async function drawerSections(body) {
  // 四个版块（含作业母版）统一由后端 data.sections 提供，单一事实源。
  const sections = await get('/api/sections');
  body.innerHTML = '';
  sections.forEach((s) => {
    const card = el('div', 'd-card');
    card.innerHTML = `<div class="t">${esc(s.icon)} ${esc(s.name)} <span class="badge">${esc(s.priority)}</span></div>
      <div class="goal">${esc(s.goal)}</div>
      <a href="#" data-id="${s.id}">查看六项与选型 →</a>`;
    card.querySelector('a').onclick = async (e) => {
      e.preventDefault();
      const d = await getSectionDetail(s.id);
      const detail = el('div', 'd-card', sectionDetailHtml(d));
      body.prepend(detail);
    };
    body.appendChild(card);
  });
}
async function drawerProjects(body) {
  // 后端 /api/projects/search 已汇总全部版块（含作业母版）的选型，无需前端二次拼接。
  const rows = await get('/api/projects/search');
  const note = await get('/api/meta');
  body.innerHTML = `<div class="warnbox">${esc(note.snapshotNote)}</div>
    <table><thead><tr><th>版块</th><th>角色</th><th>项目</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${esc(p.section)}</td><td>${esc(p.role)}</td><td><code>${esc(p.repo)}</code></td></tr>`).join('')}</tbody></table>`;
}
async function drawerProfile(body) {
  const p = await get('/api/profile');
  body.innerHTML = `<div class="note">凭据字段只存引用 ID / 环境变量名，保存时后端强制清洗明文。</div>
    <pre class="json" id="profile-json">${esc(JSON.stringify(p, null, 2))}</pre>
    <div style="display:flex;gap:6px;margin-top:8px"><button class="btn" id="profile-save">保存</button></div>`;
  $('#profile-save').onclick = async () => {
    try {
      const obj = JSON.parse($('#profile-json').textContent);
      const clean = await api('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
      $('#profile-json').textContent = JSON.stringify(clean, null, 2);
      $('#profile-save').textContent = '✓ 已脱敏保存';
    } catch (e) { alert('JSON 解析失败：' + e.message); }
  };
}
async function drawerHealth(body) {
  const h = await get('/api/health');
  body.innerHTML = `<h2>运行时</h2><div class="d-card"><code>${esc(h.engine.runtime)}</code> · ${esc(h.engine.mode)} · <span class="badge ok">OK</span></div>
    <h2>档案检查</h2><div class="d-card"><div>${esc(h.profile.verdict)}</div><div class="muted small">占位字段：${esc(h.profile.placeholders.join(', ') || '无')}</div></div>
    <h2>版块状态</h2><div class="d-card">${h.sections.map((s) => `<div>${esc(s.name)} — ${esc(s.priority)}</div>`).join('')}</div>`;
}

// ---------- 初始化 ----------
async function boot() {
  renderNav();

  $('#new-chat').onclick = () => {
    switchSection('jev_reply');
    state.currentRun = null; $('#chat-title').textContent = '新会话';
    $('#messages').innerHTML = `<div class="welcome" id="welcome"><div class="welcome-logo">M</div><h1>我是摸鱼Agent</h1>
      <p>输入一段对话内容，我会用 <b>Jev 决策</b> 判断意图与风险，起草候选回复，并<b>只填入输入框、不自动发送</b>。</p>
      <div class="examples"><button class="example" data-text="对方说：周末有空吗？晚上一起吃饭？">周末有空吗？一起吃饭？</button>
      <button class="example" data-text="对方说：帮我把 500 块转账过去，验证码发我">对方要我转账 500（高危）</button>
      <button class="example" data-text="对方说：你为什么不理我，我有点难过">对方情绪低落，怎么回？</button></div></div>`;
    bindExamples(); loadRuns();
  };
  function bindExamples() { $$('.example').forEach((b) => b.onclick = () => { $('#input').value = b.dataset.text; $('#input').focus(); }); }
  bindExamples();

  // 真实桌面：降级为回复建议版块内的可选增强，仍复用原有剪贴板桥接逻辑。
  const realToggle = $('#real-mode');
  realToggle.onchange = async () => {
    const hint = $('#clipboard-hint');
    if (realToggle.checked) {
      const cap = await get('/api/desktop').catch(() => ({}));
      if (!cap.clipboardRead) {
        realToggle.checked = false;
        alert('当前环境剪贴板桥接不可用（仅支持 Windows）');
        return;
      }
      hint.style.display = 'inline';
      $('#disclaimer').textContent = '真实桌面模式 · 读剪贴板 → 决策起草 → 写回剪贴板 · 不自动发送 · 不碰支付';
      $('#input').placeholder = '真实模式：先复制对方消息，点发送即读取剪贴板（此处输入可留空）';
    } else {
      hint.style.display = 'none';
      $('#disclaimer').textContent = '方案原型 · 不自动发送消息 · 不碰支付 · 不接真实聊天软件';
      $('#input').placeholder = '输入对话内容，或描述任务…（Enter 发送，Shift+Enter 换行）';
    }
  };

  const clearBtn = $('#clear-runs');
  clearBtn.onclick = async () => {
    if (!state.runs.length) { clearBtn.textContent = '空'; setTimeout(() => clearBtn.textContent = '清空', 1500); return; }
    // 两段式确认：第一次点变"确认清空?"，第二次点才执行
    if (clearBtn.dataset.confirm !== '1') {
      clearBtn.dataset.confirm = '1';
      clearBtn.textContent = '确认?';
      clearBtn.classList.add('confirming');
      setTimeout(() => { if (clearBtn.dataset.confirm === '1') { clearBtn.dataset.confirm = ''; clearBtn.textContent = '清空'; clearBtn.classList.remove('confirming'); } }, 3000);
      return;
    }
    try {
      await api('/api/agent/runs', { method: 'DELETE' });
      state.currentRun = null; $('#chat-title').textContent = '新会话';
      clearBtn.dataset.confirm = ''; clearBtn.textContent = '清空'; clearBtn.classList.remove('confirming');
      await loadRuns();
    } catch (e) { clearBtn.textContent = '失败'; clearBtn.title = e.message; setTimeout(() => clearBtn.textContent = '清空', 1500); }
  };

  $('#send').onclick = send;
  $('#input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#drawer-close').onclick = closeDrawer;
  $$('.foot-btn').forEach((b) => b.onclick = () => openDrawer(b.dataset.drawer));
  window.addEventListener('hashchange', () => {
    const id = sectionFromHash();
    if (id && id !== state.activeSection) switchSection(id);
  });

  try {
    const meta = await get('/api/meta'); $('#ver').textContent = meta.version;
    state.models = await get('/api/models');
    const sel = $('#model-select');
    sel.innerHTML = state.models.map((m) => `<option value="${m.id}" ${m.id === 'mock' ? 'selected' : ''}>${esc(m.label)}${m.mock ? '' : (m.keyReady ? ' ·✓' : ' ·无key')}</option>`).join('');
    sel.onchange = () => { const m = state.models.find((x) => x.id === sel.value); $('#mode-pill').textContent = m?.mock ? 'mock' : 'live'; };
    await loadRuns();
  } catch (e) {
    $('#messages').innerHTML = `<div class="warnbox">无法连接后端：${esc(e.message)}<br>请先运行 node server.js（127.0.0.1:3080）</div>`;
  }

  // 默认进入「回复建议」（普通 mock 对话）；其余为平级工作台。
  const initial = sectionFromHash() || 'jev_reply';
  state.activeSection = initial;
  switchSection(initial);

  // 今日摘要 + 上课提醒（全局常驻，切到其它版块也能按时提醒）
  refreshTodayLine();
  ttStartReminderTicker();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshTodayLine(); ttTickReminders(); }
  });
}
boot();

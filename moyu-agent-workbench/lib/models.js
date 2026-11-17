'use strict';

/**
 * 可替换大模型适配层
 * 全部走 OpenAI Chat Completions 兼容协议；国内服务只改 base_url + api_key + model。
 * 支持：智谱 GLM / 硅基流动 / 火山方舟(豆包) / 阿里云百炼(通义) / DeepSeek / Moonshot(Kimi) / 自定义。
 * 默认提供 mock 适配器：离线演示闭环，不联网、不消耗任何 key。
 *
 * 安全：api_key 只从环境变量读取名字（profile 里存 ref/env），绝不落盘、绝不进日志。
 */

const PRESETS = {
  mock: {
    label: '本地模拟（离线，不消耗 key）',
    baseUrl: '', model: 'mock-echo',
    env: '', free: true,
    note: '用于验证 agent loop 与工具链，不调用真实模型。',
  },
  hy4: {
    label: '腾讯混元 Hy4 / 混元（当前对话同源模型）',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbo',
    env: 'HUNYUAN_API_KEY',
    free: false,
    alt: ['hunyuan-standard', 'hunyuan-pro', 'hunyuan-lite', 'hy4'],
    note: 'OpenAI 兼容；base_url 来自腾讯云官方文档。Hy4 正式版经 TokenHub 开通、key 在 TokenHub 控制台创建，新用户每模型约100万 token/90天（活动至2026-12-31）；hunyuan-lite 曾永久免费。确切 model id（含 Hy4）以 TokenHub 控制台为准，需进一步验证。',
  },
  zhipu: {
    label: '智谱 GLM（学生首选·有永久免费模型）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    env: 'ZHIPU_API_KEY',
    free: true,
    alt: ['glm-4.5-air', 'glm-4.6'],
    note: 'glm-4-flash 永久免费；注册手机号即可，个人实名后 2000万 token 体验包（90天）。免费额度与模型名以官网为准。',
  },
  siliconflow: {
    label: '硅基流动（一个 key 试多家模型）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    env: 'SILICONFLOW_API_KEY',
    free: true,
    alt: ['deepseek-ai/DeepSeek-V3', 'THUDM/GLM-4-9B-Chat'],
    note: '注册送约 2000万 token；部分 9B 以下模型永久免费。一个 key 切多家模型，适合对比测试。',
  },
  volcengine: {
    label: '火山方舟 / 豆包（每日额度大方）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-lite-251015',
    env: 'ARK_API_KEY',
    free: true,
    note: '需在模型广场手动开通所用模型（否则 key 有效但调不通）；实名后有每日免费 token。模型 ID 以控制台为准。',
  },
  dashscope: {
    label: '阿里云百炼 / 通义千问（稳定、模型全）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    env: 'DASHSCOPE_API_KEY',
    free: false,
    alt: ['qwen-turbo', 'qwen-max'],
    note: '新用户每模型约 100万 token/90天；OpenAI 兼容模式。适合正式/稳定场景。',
  },
  deepseek: {
    label: 'DeepSeek（代码/推理性价比）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    env: 'DEEPSEEK_API_KEY',
    free: false,
    alt: ['deepseek-reasoner'],
    note: '低价按量付费；OpenAI 兼容。适合推理与代码。',
  },
  moonshot: {
    label: 'Moonshot / Kimi（长文本）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.5',
    env: 'MOONSHOT_API_KEY',
    free: false,
    note: '注册个人认证赠少量金额；长文本强。模型名以官网为准。',
  },
  custom: {
    label: '自定义 OpenAI 兼容端点',
    baseUrl: '', model: '', env: 'CUSTOM_API_KEY', free: false,
    note: '任何兼容 /chat/completions 的服务（含本地 Ollama / vLLM）。',
  },
};

/**
 * 从模型返回文本中提取 JSON。真实模型常在 JSON 外包 ```json ``` 或前后加说明文字，
 * 直接 JSON.parse 会失败并触发错误的"降级/转人工"。这里做最小容错：
 * 1) 去 Markdown 代码围栏；2) 截取首个 { 或 [ 到末个 } 或 ]；3) 解析失败返回 null。
 */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1, open, close;
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) { start = firstObj; open = '{'; close = '}'; }
  else if (firstArr >= 0) { start = firstArr; open = '['; close = ']'; }
  if (start < 0) return null;
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); }
  catch (_) { return null; }
}

function listPresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({
    id, label: p.label, baseUrl: p.baseUrl, model: p.model, env: p.env,
    free: p.free, alt: p.alt || [], note: p.note,
  }));
}

/** 构造一个 provider；apiKey 由调用方从环境变量注入，不接收明文入参落盘 */
function makeProvider({ preset, baseUrl, model, apiKey }) {
  const p = PRESETS[preset] || PRESETS.custom;
  const url = (baseUrl || p.baseUrl || '').replace(/\/$/, '');
  const name = model || p.model;
  const key = apiKey || '';

  if (preset === 'mock' || !url) {
    return { id: 'mock', label: p.label, model: name || 'mock-echo', mock: true, chat: mockChat, listPresets };
  }

  async function chat(messages, { temperature = 0.7, timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
        },
        body: JSON.stringify({ model: name, messages, temperature, stream: false }),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        let msg = text.slice(0, 300);
        try { const j = JSON.parse(text); msg = j.error?.message || msg; } catch (_) {}
        const err = new Error(`HTTP ${resp.status}: ${msg}`);
        err.status = resp.status;
        throw err;
      }
      const j = JSON.parse(text);
      const content = j.choices?.[0]?.message?.content ?? '';
      return { content, usage: j.usage || null, model: j.model || name };
    } finally { clearTimeout(timer); }
  }

  return { id: preset, label: p.label, model: name, baseUrl: url, mock: false, chat, listPresets };
}

/** mock 聊天：根据 system 里的工具指令返回可解析的 JSON，驱动闭环演示 */
async function mockChat(messages, opts = {}) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  // 决策型调用：Jev 风格分类/打分
  if (/jev_decide|意图|危险等级/.test(sys) || /jev_decide/.test(last)) {
    const danger = /转账|借钱|红包|验证码|密码/.test(last) ? 8 : 3;
    const intent = /见面|周末|吃饭/.test(last) ? '安排见面' : /生气|不理|难过/.test(last) ? '情绪安抚' : '日常闲聊';
    return {
      content: JSON.stringify({
        intent, danger, should_reply_now: danger < 7,
        best_action: danger >= 7 ? 'ask_human' : 'draft',
        confidence: 0.91,
      }), model: 'mock-echo', usage: { total_tokens: 0 },
    };
  }
  // 起草型调用
  if (/draft|起草|回复候选/.test(sys) || /draft/.test(last)) {
    return {
      content: JSON.stringify([
        '好呀，我也正想着见你呢，周末哪天方便？',
        '听起来你今天有点累，要不要先休息，我们改天再约？',
        '我爱你哟！',
      ]), model: 'mock-echo', usage: { total_tokens: 0 },
    };
  }
  // 规划型调用
  return {
    content: JSON.stringify({
      steps: ['decide', 'draft', 'rank', 'fill'],
      note: 'mock plan for jev reply',
    }), model: 'mock-echo', usage: { total_tokens: 0 },
  };
}

module.exports = { PRESETS, listPresets, makeProvider, extractJson };

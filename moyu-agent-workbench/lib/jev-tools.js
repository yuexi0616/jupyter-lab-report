'use strict';

/**
 * jev 自动回复（男女朋友场景）工具集 —— 全部为 mock，不触碰任何真实平台/账号。
 *
 * 关键边界（继承 v0.2 方案）：
 *  - Jev 负责决策（意图/危险等级/是否回复/最佳动作），生成模型负责起草；
 *  - 默认 fill-only：只把回复写进输入框，绝不自动点发送、不碰转账红包；
 *  - 任何高危信号（转账/借钱/验证码/密码）强制升级人工；
 *  - 全流程写审计日志，可回放、可停止。
 */

const fs = require('fs');
const path = require('path');
const { extractJson } = require('./models');
const decider = require('./decider');
const desktop = require('./desktop');

const RUNS = process.env.MOYU_RUNS_DIR
  ? path.resolve(process.env.MOYU_RUNS_DIR)
  : path.join(__dirname, '..', 'runs');

function safe(s) { return String(s == null ? '' : s).slice(0, 2000); }

/** 工具注册表：agent loop 通过 name 调用 */
const tools = {
  'jev.snapshot': {
    desc: '读取当前会话快照（mock 的对话文本）',
    input: 'conversation text',
    async run(provider, args, ctx) {
      ctx.snapshot = safe(args.text || ctx.snapshot || '');
      return { snapshot: ctx.snapshot, length: ctx.snapshot.length };
    },
  },
  'jev.decide': {
    desc: 'Jev 类型化决策：意图/危险等级(1-9)/是否立即回/最佳动作（后端可插拔：mock/llm/anyjev）',
    async run(provider, args, ctx) {
      // 通过决策器抽象层调用：默认 mock 后端行为与旧实现一致（回归不破）；
      // 切到 anyjev 时服务不可用会抛错（禁降级），由 agent loop 转人工。
      const d = await decider.decide(provider, ctx.snapshot || '', args.decider || {});
      ctx.decision = d;
      return d;
    },
  },
  'llm.draft': {
    desc: '生成模型起草 3 条候选回复',
    async run(provider, args, ctx) {
      const r = await provider.chat([
        { role: 'system', content: '你是 draft 起草函数。基于会话与决策，输出 3 条口语化中文候选回复的 JSON 数组，不输出解释。' },
        { role: 'user', content: `会话：${ctx.snapshot || '(无)'}\n决策：${JSON.stringify(ctx.decision || {})}` },
      ]);
      let list = extractJson(r.content);
      if (!Array.isArray(list)) list = [String(r.content || '').trim()];
      ctx.drafts = list.slice(0, 3).map((x) => safe(x));
      return { drafts: ctx.drafts };
    },
  },
  'jev.rank': {
    desc: '用 Jev 对候选回复排序（score）',
    async run(provider, args, ctx) {
      // mock 排序：优先含关心/询问的回复；真实实现可再调一次 provider 做 score
      const score = (s) => (/见|周末|休息|关心|想你|好呀/.test(s) ? 0.8 : 0.5) + (s.length < 30 ? 0.1 : 0);
      ctx.ranked = (ctx.drafts || []).map((s) => ({ text: s, score: Number(score(s).toFixed(2)) }))
        .sort((a, b) => b.score - a.score);
      return { ranked: ctx.ranked };
    },
  },
  'jev.fill': {
    desc: 'fill-only：把选中回复写入输入框（mock），绝不自动发送',
    async run(provider, args, ctx) {
      if (ctx.decision?.best_action === 'ask_human') {
        return { filled: false, reason: '高危决策：已升级人工，不填不发送' };
      }
      const idx = Number(args.index || 0);
      ctx.filled = ctx.ranked?.[idx]?.text || ctx.drafts?.[idx] || '';
      return { filled: true, text: ctx.filled, auto_sent: false, note: '仅填入输入框，发送由用户决定' };
    },
  },
  // ------- 真实桌面工具（剪贴板桥接，用户主动触发；fill-only 不自动发送）-------
  'desktop.readClipboard': {
    desc: '[真实] 读取系统剪贴板文本作为会话快照（需用户先复制对方消息）',
    async run(provider, args, ctx) {
      const text = desktop.readClipboard();
      ctx.snapshot = safe(text);
      return { snapshot: ctx.snapshot, length: ctx.snapshot.length, source: 'clipboard', real: true };
    },
  },
  'desktop.writeClipboard': {
    desc: '[真实] 把选中回复写入系统剪贴板（用户自行粘贴，绝不自动发送）',
    async run(provider, args, ctx) {
      if (ctx.decision?.best_action === 'ask_human') {
        return { written: false, reason: '高危决策：已升级人工，不写入剪贴板', real: true };
      }
      const idx = Number(args.index || 0);
      const text = ctx.ranked?.[idx]?.text || ctx.drafts?.[idx] || ctx.filled || '';
      if (!text) return { written: false, reason: '无可用回复', real: true };
      desktop.writeClipboard(text);
      ctx.filled = text;
      return { written: true, text, auto_sent: false, note: '已写入剪贴板，请自行粘贴；未自动发送', real: true };
    },
  },
  'audit.write': {
    desc: '写审计日志（默认脱敏：对话原文只存哈希与长度，不落明文）',
    async run(provider, args, ctx) {
      if (!fs.existsSync(RUNS)) fs.mkdirSync(RUNS, { recursive: true });
      // 隐私默认：snapshot 等对话原文仅保留指纹，便于追溯而不泄露内容。
      // 需要完整内容做本地调试时，显式设置 MOYU_AUDIT_FULL=1（自带风险提示）。
      const full = process.env.MOYU_AUDIT_FULL === '1';
      const fingerprint = (s) => {
        if (!s) return null;
        return { sha256: require('crypto').createHash('sha256').update(String(s)).digest('hex'), length: String(s).length };
      };
      const record = {
        ts: new Date().toISOString(),
        runId: ctx.runId,
        snapshot: full ? safe(ctx.snapshot) : fingerprint(ctx.snapshot),
        decision: ctx.decision,
        drafts: full ? ctx.drafts : (ctx.drafts || []).map(() => '[redacted]'),
        ranked: full ? ctx.ranked : (ctx.ranked || []).map((r) => ({ score: r.score, text: '[redacted]' })),
        filled: full ? (ctx.filled || null) : (ctx.filled ? '[redacted]' : null),
        auto_sent: false,
        auditMode: full ? 'full' : 'redacted',
      };
      const file = path.join(RUNS, ctx.runId + '.audit.json');
      fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
      return { file: path.relative(path.join(__dirname, '..'), file), auditMode: record.auditMode };
    },
  },
};

function listTools() {
  return Object.entries(tools).map(([name, t]) => ({ name, desc: t.desc }));
}

module.exports = { tools, listTools };

'use strict';

/**
 * 环境档案：只存"引用"，绝不存明文凭据。
 * 这是 mock 工作台：默认值全部是占位符，不指向任何真实账号/路径。
 */

const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '..', 'data', 'profile.json');

const defaultProfile = {
  _readme: '摸鱼 Agent 工作台占位档案 —— 凭据字段只存引用 ID / 环境变量名，禁止明文。',
  common: {
    machine: { os: 'REPLACE-OS', python: 'REPLACE-PYTHON', workdir: 'REPLACE-WORKDIR' },
    identity: { id: 'REPLACE-ID', name: 'REPLACE-NAME' },
    credentials: {
      llm_key: { ref: 'REF-LLM-KEY', env: 'MOYU_LLM_API_KEY', encrypted: true },
      jev_key: { ref: 'REF-JEV-KEY', env: 'MOYU_JEV_API_KEY', encrypted: true },
    },
  },
  'course.*': {
    platforms: ['REPLACE-PLATFORM'],
    courses: [],
    playback: { rate: 1.8, mute: true, background: true },
    takeover: { onCaptcha: 'pause_and_notify' },
  },
  'messaging.*': {
    accounts: [],
    persona: { style: 'REPLACE-STYLE' },
    rules: { freq_limit: 'REPLACE-LIMIT' },
    send_policy: 'draft_only',
  },
  'project.*': {
    topic: 'REPLACE-TOPIC',
    sources: [],
    toolchain: { engine: 'xelatex', compiler: 'REPLACE-COMPILER' },
    integrity: { digit_trace: true, citation_verify: true },
  },
};

function ensureDir() {
  const dir = path.dirname(PROFILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function read() {
  if (!fs.existsSync(PROFILE_PATH)) {
    ensureDir();
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(defaultProfile, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
}

/**
 * 写回时强制清洗：凭据字段采用「白名单正向校验」——只允许 {ref, env, encrypted}。
 * 相比黑名单删除，正向白名单能阻断任何未知字段（token/key/seed/自定义字段名）夹带明文。
 */
function sanitize(profile) {
  const out = JSON.parse(JSON.stringify(profile));
  const creds = out.common && out.common.credentials;
  if (creds) {
    for (const [k, v] of Object.entries(creds)) {
      const ref = 'REF-' + String(k).toUpperCase();
      const env = 'MOYU_' + String(k).toUpperCase();
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        creds[k] = { ref, env, encrypted: true };
        continue;
      }
      // 只保留白名单字段，其余一律丢弃；ref/env 强制为安全字符串
      const cleanRef = typeof v.ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.ref) ? v.ref : ref;
      const cleanEnv = typeof v.env === 'string' && /^[A-Z0-9_]{1,64}$/.test(v.env) ? v.env : env;
      creds[k] = { ref: cleanRef, env: cleanEnv, encrypted: true };
    }
  }
  return out;
}

function write(profile) {
  const clean = sanitize(profile);
  ensureDir();
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** 占位符检测：用于"体检"里模拟 check 拒占位 */
function findPlaceholders(obj, prefix = '') {
  const hits = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' && /REPLACE-/.test(v)) hits.push(key);
    else if (Array.isArray(v)) v.forEach((item, i) => { if (typeof item === 'string' && /REPLACE-/.test(item)) hits.push(`${key}[${i}]`); });
    else if (v && typeof v === 'object') hits.push(...findPlaceholders(v, key));
  }
  return hits;
}

module.exports = { read, write, findPlaceholders, sanitize, defaultProfile, PROFILE_PATH };

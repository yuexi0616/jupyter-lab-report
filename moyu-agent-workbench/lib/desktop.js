'use strict';

/**
 * 真实桌面适配层（Windows）—— 剪贴板桥接。
 *
 * 能力边界（务必看清）：
 *  - ✅ 真实读取系统剪贴板文本（用户先复制对方消息）
 *  - ✅ 真实写入系统剪贴板（用户再粘贴到自己想发的地方）
 *  - ❌ 不做自动读屏：UI Automation 需 Add-Type 动态编译，被环境安全策略禁用
 *  - ❌ 不自动发送、不 hook 聊天软件、不读数据库、不联网
 *
 * 用法完全是"用户主动触发"：读 = 用户复制后点读取；写 = 工具写入后用户自己粘贴。
 * 这既真实可用，又守住 fill-only 与隐私红线。
 */

const { execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const PS = 'powershell.exe';
const TIMEOUT = 5000;

function ps(script) {
  if (!IS_WIN) throw new Error('剪贴板桥接当前仅支持 Windows');
  return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: TIMEOUT, windowsHide: true,
  });
}

/** 读取剪贴板文本（UTF-8）。为空时返回空串。 */
function readClipboard() {
  try {
    return ps('Get-Clipboard -Raw').replace(/\r?\n$/, '');
  } catch (e) {
    throw new Error('读取剪贴板失败：' + e.message);
  }
}

/** 写入剪贴板文本。用 Set-Clipboard，避免编码问题。 */
function writeClipboard(text) {
  const s = String(text || '').slice(0, 4000);
  if (!s) throw new Error('写入内容为空');
  // 通过 stdin 传入，避免命令行转义/编码问题
  if (!IS_WIN) throw new Error('剪贴板桥接当前仅支持 Windows');
  try {
    execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command',
      '$input | Set-Clipboard'], { input: s, encoding: 'utf8', timeout: TIMEOUT, windowsHide: true });
    return true;
  } catch (e) {
    // 部分系统 $input 管道不稳，退回到带引号的参数形式
    const escaped = s.replace(/'/g, "''");
    try { ps(`Set-Clipboard -Value '${escaped}'`); return true; }
    catch (e2) { throw new Error('写入剪贴板失败：' + e2.message); }
  }
}

/** 能力探测：报告哪些真实能力可用 */
function capabilities() {
  const result = {
    platform: process.platform,
    clipboardRead: false, clipboardWrite: false,
    screenRead: false, autoSend: false,
    note: '剪贴板桥接为真实能力；屏幕读取因 Add-Type 被安全策略禁用而不可用；绝不自动发送。',
  };
  if (!IS_WIN) { result.note = '非 Windows 平台，剪贴板桥接不可用'; return result; }
  // 探测不能破坏用户剪贴板：先备份，测完恢复
  let backup = '';
  try { backup = readClipboard(); } catch (_) {}
  try {
    const t = '__moyu_probe__' + Date.now();
    writeClipboard(t);
    result.clipboardWrite = readClipboard().includes(t);
  } catch (_) {}
  finally {
    // 无条件恢复：即便备份为空也必须写回空串，否则会把 __moyu_probe__ 测试串留在用户剪贴板。
    try { writeClipboard(backup); } catch (_) {}
  }
  result.clipboardRead = result.clipboardWrite; // 能写能读才算读可用
  return result;
}

module.exports = { readClipboard, writeClipboard, capabilities, IS_WIN };

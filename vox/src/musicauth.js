/**
 * 音乐源 Cookie 认证状态管理
 * --------------------------------------------------
 * provider 无关的熔断层。具体的"cookie 有效性校验"和"过期探测"
 * 委托给 provider 实现（provider.applyCookie / provider.probeAuth）。
 *
 * 状态机：
 *   - getPlayUrl 失败多次 → reportAuthFailSignal() 累计信号
 *   - 上层 (server) 决定何时调 probeAuth
 *   - probeAuth='expired' → markAuthRequired → 广播给前端弹窗
 *   - 前端提交新 cookie → updateCookie → applyCookie 验证 → 落盘 → clearAuthRequired
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertEnv } from '../scripts/_lib/env-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// vox/src/musicauth.js → vox/.env
const ENV_PATH = path.resolve(__dirname, '..', '.env');

// ---------- 全局熔断状态 ----------
let _authState = null; // null = OK；string = 未认证，值为最近一次失败原因
const _listeners = new Set();

// ---------- 疑似 authFail 信号的累计 ----------
let _authFailSignals = 0;

export function isAuthRequired() {
  return _authState !== null;
}

export function getAuthReason() {
  return _authState;
}

/** provider 在 getPlayUrl 失败时调（单次失败不立刻熔断） */
export function reportAuthFailSignal() {
  _authFailSignals++;
}

/** getPlayUrl 成功、probe 完、熔断触发时清零 */
export function resetAuthFailSignals() {
  _authFailSignals = 0;
}

export function getAuthFailSignals() {
  return _authFailSignals;
}

/**
 * 主动探测 cookie 是否过期（委托给 provider）
 * @param {{ probeAuth: () => Promise<'ok' | 'expired' | 'unknown'> }} provider
 * @returns {Promise<'ok' | 'expired' | 'unknown'>}
 */
export async function probeCookieAlive(provider) {
  if (!provider?.probeAuth) return 'unknown';
  try {
    return await provider.probeAuth();
  } catch (e) {
    console.warn('[musicauth] probe 异常:', e.message);
    return 'unknown';
  }
}

/** 触发熔断（只有 probe 定性为 expired 后才会调） */
export function markAuthRequired(reason) {
  const was = _authState;
  _authState = reason || 'cookie 失效';
  resetAuthFailSignals();
  if (!was) {
    console.warn(`[musicauth] 🔒 进入熔断: ${_authState}`);
    for (const fn of _listeners) {
      try { fn({ required: true, reason: _authState }); } catch { /* ignore */ }
    }
  }
}

export function clearAuthRequired() {
  resetAuthFailSignals();
  if (_authState !== null) {
    console.log('[musicauth] ✅ 解除熔断');
    _authState = null;
    for (const fn of _listeners) {
      try { fn({ required: false }); } catch { /* ignore */ }
    }
  }
}

export function onAuthChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ---------- cookie 更新流程 ----------

/**
 * 接收用户粘贴的新 cookie，委托给 provider 验证，成功后落盘 + 解除熔断
 * @param {object} opts
 * @param {import('./music/index.js').MusicProvider} opts.provider
 * @param {string} opts.cookieString
 * @param {string} opts.dataDir  项目 data/ 目录绝对路径
 * @returns {Promise<{ok: true, warning?: string, userInfo?: any} | {ok: false, error: string}>}
 */
export async function updateCookie({ provider, cookieString, dataDir }) {
  if (!provider?.applyCookie) {
    return { ok: false, error: 'provider 不支持 cookie 更新' };
  }

  const result = await provider.applyCookie(cookieString);
  if (!result.ok) return result;

  // 落盘 cookie
  if (result.toWrite) {
    try {
      await fs.mkdir(dataDir, { recursive: true });
      const p = path.join(dataDir, result.toWrite.fileName);
      await fs.writeFile(p, result.toWrite.content, 'utf8');
      console.log(`[musicauth] cookie 已落盘: ${p}`);
    } catch (e) {
      return {
        ok: true,
        warning: `cookie 已生效，但写入 ${dataDir}/${result.toWrite.fileName} 失败: ${e.message}（下次重启可能丢失）`,
        userInfo: result.userInfo,
      };
    }
  }

  // 同步把 provider 想持久化的字段（比如 netease 的 NETEASE_UID）写进 vox/.env
  // 这样下次启动 server 创建 provider 时就有 userId 了，不用再走 applyCookie
  if (result.envPatch && typeof result.envPatch === 'object') {
    try {
      // 把字段同步到当前进程 env，server 这次运行内（比如 /api/playlists）也能立刻用
      for (const [k, v] of Object.entries(result.envPatch)) {
        process.env[k] = String(v);
      }
      await upsertEnv(ENV_PATH, result.envPatch);
      console.log(`[musicauth] .env 已更新: ${Object.keys(result.envPatch).join(', ')}`);
    } catch (e) {
      console.warn(`[musicauth] 写 .env 失败（不影响本次会话）:`, e.message);
    }
  }

  clearAuthRequired();
  return { ok: true, userInfo: result.userInfo };
}

/**
 * QQ Cookie 认证状态管理 + 更新
 * --------------------------------------------------
 * 当 QQ 音乐取直链持续失败时，我们需要判断原因：
 *   A. cookie 过期（或从未登录）
 *   B. 歌曲 VIP / 无版权（用户自己是 VIP 也救不了，属于单曲问题）
 *
 * QQMusicApi 的 /song/url 无法从响应区分 A 和 B（都是 result:400）。
 * 所以我们：
 *   1. getPlayUrl 里记录"疑似 authFail"信号（单次失败不下结论）
 *   2. 聚合足够多的信号后，主动调 /user/detail 探测登录态 → 定性
 *   3. 确认 cookie 过期 → 熔断（省 token）+ 弹窗
 *   4. 确认 cookie 没事 → 不熔断（大概率是 VIP / 版权）
 */
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------- 全局熔断状态 ----------
// null = OK；字符串 = 需要重新认证，值为"最近一次失败的原因"
let _authState = null;
const _listeners = new Set();

// ---------- 疑似 authFail 信号的滑动统计（跨 block 累加） ----------
// 每次 getPlayUrl 路A 返回 result:400 或 HTTP 401/403 时 +1
// 一次成功的 getPlayUrl → 清零
// 一次 probe 后也清零（避免重复触发）
let _authFailSignals = 0;

/** 当前是否处于 auth_required 熔断 */
export function isAuthRequired() {
  return _authState !== null;
}

/** 当前熔断原因（或 null） */
export function getAuthReason() {
  return _authState;
}

/** 上报一次疑似 authFail 信号（不立刻熔断，等 probe 定性） */
export function reportAuthFailSignal() {
  _authFailSignals++;
}

/** 清零信号（getPlayUrl 成功、probe 完、熔断触发时都应该调） */
export function resetAuthFailSignals() {
  _authFailSignals = 0;
}

/** 当前累计的疑似 authFail 数 */
export function getAuthFailSignals() {
  return _authFailSignals;
}

/**
 * 主动探测 cookie 是否真的过期
 * 通过 QQMusicApi 的 /user/detail?id={uin}：返回 result:301 或 code:1000 = 未登录
 * @returns {Promise<'expired' | 'ok' | 'unknown'>}
 */
export async function probeCookieAlive({ apiBase, uin }) {
  if (!uin) return 'unknown';
  try {
    const url = apiBase.replace(/\/$/, '') + '/user/detail?id=' + encodeURIComponent(uin);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return 'unknown';
    const json = await res.json().catch(() => ({}));
    // 304 / code:1000 都是"未登录"
    if (json?.result === 301 || json?.code === 1000 || /未登/.test(json?.errMsg || '')) {
      return 'expired';
    }
    // 有正常数据结构 → 登录态有效
    if (json?.result === 100 && json?.data) return 'ok';
    // 其它情况保守说未知
    return 'unknown';
  } catch (e) {
    console.warn('[qqauth] probe 异常:', e.message);
    return 'unknown';
  }
}

/** 触发熔断（由 probe 定性后调用） */
export function markAuthRequired(reason) {
  const was = _authState;
  _authState = reason || 'cookie 失效';
  resetAuthFailSignals();
  if (!was) {
    console.warn(`[qqauth] 🔒 进入熔断: ${_authState}`);
    for (const fn of _listeners) {
      try { fn({ required: true, reason: _authState }); } catch { /* ignore */ }
    }
  }
}

/** 手动清除熔断（cookie 成功验证后调用） */
export function clearAuthRequired() {
  resetAuthFailSignals();
  if (_authState !== null) {
    console.log('[qqauth] ✅ 解除熔断');
    _authState = null;
    for (const fn of _listeners) {
      try { fn({ required: false }); } catch { /* ignore */ }
    }
  }
}

/** 订阅熔断状态变化（server 里用来广播给 ws） */
export function onAuthChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ---------- cookie 更新流程 ----------

/**
 * 把新的 cookie 串写入 data/qq_cookie.json，并推送给 QQMusicApi
 * @param {object} opts
 * @param {string} opts.cookieString   用户粘贴的完整 cookie 文本
 * @param {string} opts.dataDir        项目 data/ 目录绝对路径
 * @param {string} opts.apiBase        QQMusicApi 地址，如 http://127.0.0.1:3300
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function updateCookie({ cookieString, dataDir, apiBase }) {
  const raw = String(cookieString || '').trim();
  if (!raw) return { ok: false, error: 'cookie 不能为空' };

  // 极简校验：必须包含几个关键字段
  const required = ['uin', 'qm_keyst'];
  const missing = required.filter((k) => !new RegExp(`(^|;\\s*)${k}=`).test(raw));
  if (missing.length) {
    return { ok: false, error: `cookie 缺少关键字段: ${missing.join(', ')}（从浏览器复制时要完整）` };
  }

  const payload = JSON.stringify({ data: raw });

  // 1) 推给 QQMusicApi
  let res;
  try {
    res = await fetch(apiBase.replace(/\/$/, '') + '/user/setCookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
  } catch (e) {
    return { ok: false, error: `连不上 QQMusicApi (${apiBase}): ${e.message}` };
  }
  if (!res.ok) {
    return { ok: false, error: `QQMusicApi /user/setCookie HTTP ${res.status}` };
  }
  const setJson = await res.json().catch(() => ({}));
  if (setJson.result !== 100) {
    return { ok: false, error: `setCookie 响应异常: ${JSON.stringify(setJson).slice(0, 200)}` };
  }

  // 2) 立即用一首常见歌验证一下（拿不到直链说明 cookie 还是废的）
  //    用水星记（郭顶）的 songmid，稳定存在 & 有版权
  try {
    const verifyUrl = apiBase.replace(/\/$/, '') + '/song/url?id=00485V8K4InqbZ';
    const vRes = await fetch(verifyUrl);
    const vJson = await vRes.json().catch(() => ({}));
    if (typeof vJson?.data !== 'string' || !vJson.data.startsWith('http')) {
      return {
        ok: false,
        error: `cookie 写入成功但拿不到直链（${vJson?.errMsg || '可能 cookie 还是过期的'}），请重新从浏览器复制完整 cookie`,
      };
    }
  } catch (e) {
    return { ok: false, error: `验证直链失败: ${e.message}` };
  }

  // 3) 验证通过 → 落盘到 data/qq_cookie.json（真源）
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const p = path.join(dataDir, 'qq_cookie.json');
    await fs.writeFile(p, payload + '\n', 'utf8');
    console.log(`[qqauth] cookie 已更新并落盘: ${p}`);
  } catch (e) {
    // 落盘失败不算致命（进程内 cookie 已更新），但要提示
    return {
      ok: true,
      warning: `cookie 已推送成功，但写入 ${dataDir}/qq_cookie.json 失败: ${e.message}（下次重启后可能丢失）`,
    };
  }

  clearAuthRequired();
  return { ok: true };
}

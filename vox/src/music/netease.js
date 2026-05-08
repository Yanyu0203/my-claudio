/**
 * 网易云音乐 provider
 * --------------------------------------------------
 * 基于 api-enhanced（NeteaseCloudMusicApi 的社区维护分支），
 * 作为进程内 npm 模块直接 require，不跑独立 HTTP 服务。
 *
 * 实现 MusicProvider 接口（见 ./index.js 的 JSDoc）
 *
 * 字段映射（Netease 原生 → 通用）：
 *   id        → songId
 *   id (歌单) → playlistId
 *   uid       → userId
 *   subscribed=false && specialType=5 → isFavorite (即"我喜欢的音乐")
 *
 * Cookie：
 *   - 每次 API 调用把 cookieString 作为 {cookie} 参数传入
 *   - 没 cookie 也能工作，只是拿不到 VIP 歌的直链
 *
 * 注意：api-enhanced 是 CommonJS，vox 是 ESM。
 * 用 createRequire 桥接（而不是 dynamic import，避免异步加载）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { reportAuthFailSignal, resetAuthFailSignals } from '../musicauth.js';

const require = createRequire(import.meta.url);

// 相对 vox/src/music/netease.js 的位置：../../../api-enhanced/main.js
const API_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../api-enhanced/main.js'
);

// 懒加载：只有真正使用 netease provider 时才 require，避免 qq 用户也被迫装 api-enhanced
let _api = null;
function getApi() {
  if (_api) return _api;
  try {
    _api = require(API_PATH);
  } catch (e) {
    throw new Error(
      `加载 api-enhanced 失败：${e.message}\n` +
      `请确保已装依赖：cd api-enhanced && npm install`
    );
  }
  return _api;
}

/**
 * 创建一个网易云音乐 provider
 * @param {object} opts
 * @param {string} [opts.userId]        默认用户 ID（拉歌单时用）
 * @param {string} [opts.cookieString]  cookie 字符串；不传会在每次调用时从 cookieFile 读
 * @param {string} [opts.cookieFile]    cookie 文件绝对路径（内容就是 cookie 字符串，支持多行）
 * @returns {import('./index.js').MusicProvider}
 */
export function createNeteaseProvider(opts = {}) {
  let defaultUserId = opts.userId || '';
  let _cookieCache = opts.cookieString || '';
  let _cookieLoadedAt = 0;
  const cookieFile = opts.cookieFile || '';

  /** 取当前 cookie（带 60s 文件读缓存，避免每次 search 都 IO） */
  async function getCookie() {
    if (_cookieCache && Date.now() - _cookieLoadedAt < 60_000) return _cookieCache;
    if (cookieFile) {
      try {
        const raw = await fs.readFile(cookieFile, 'utf8');
        _cookieCache = raw.trim();
        _cookieLoadedAt = Date.now();
        return _cookieCache;
      } catch {
        return '';
      }
    }
    return _cookieCache;
  }

  // ---------- 搜歌 ----------
  async function search(keyword, n = 5) {
    if (!keyword || !keyword.trim()) return [];

    const api = getApi();
    const cookie = await getCookie();
    try {
      const r = await api.cloudsearch({
        keywords: keyword,
        limit: n,
        cookie,
      });
      const songs = r?.body?.result?.songs || [];
      if (!songs.length) {
        console.log(`[netease] search "${keyword}" → 0 hits`);
        return [];
      }
      const out = songs.map((s) => ({
        songId: String(s.id),
        title: s.name || '',
        artist: (s.ar || []).map((a) => a.name).join('/'),
        album: s.al?.name || '',
        cover: s.al?.picUrl || '',
        duration: Math.round((s.dt || 0) / 1000), // 网易是毫秒
      }));
      console.log(`[netease] search "${keyword}" → ${out.length} hits`);
      return out;
    } catch (e) {
      console.warn(`[netease] search throw "${keyword}":`, e.message);
      return [];
    }
  }

  // ---------- 拿播放直链 ----------
  async function getPlayUrl(songId) {
    if (!songId) return { url: '', authFail: false };

    const api = getApi();
    const cookie = await getCookie();
    try {
      const r = await api.song_url({
        id: songId,
        cookie,
        br: 320000, // 320k 足够，更高码率经常拿不到
      });
      const d = r?.body?.data?.[0];
      if (d?.url && typeof d.url === 'string' && d.url.startsWith('http')) {
        resetAuthFailSignals();
        return { url: d.url, authFail: false };
      }
      // url 为 null：可能是 VIP/版权/cookie 过期
      // 无法从 song_url 本身判断 —— 外层靠滑动窗口聚合 + probeCookieAlive 定性
      // 保守上报一次 auth 疑似信号
      reportAuthFailSignal();
      console.warn(
        `[netease] song_url ${songId} url 为空 code=${r?.body?.code} [auth-suspect]`
      );
      return { url: '', authFail: true };
    } catch (e) {
      console.warn(`[netease] song_url ${songId} throw:`, e.message);
      return { url: '', authFail: false };
    }
  }

  // ---------- 拉用户所有歌单 ----------
  async function getMyPlaylists(userId) {
    const uid = userId || defaultUserId;
    if (!uid) throw new Error('getMyPlaylists 需要 userId (网易云 uid)');

    const api = getApi();
    const cookie = await getCookie();
    const r = await api.user_playlist({
      uid,
      limit: 1000,
      cookie,
    });
    if (r?.body?.code !== 200) {
      throw new Error(`user_playlist code=${r?.body?.code} msg=${r?.body?.message || ''}`);
    }
    const list = r?.body?.playlist || [];
    return list
      .filter((p) => p.trackCount > 0)
      .map((p) => ({
        playlistId: String(p.id),
        name: p.name,
        cover: p.coverImgUrl || '',
        songCount: p.trackCount,
        // 网易云的"我喜欢的音乐" = specialType === 5 && 是用户自己建的
        isFavorite: p.specialType === 5,
      }));
  }

  // ---------- 拉单个歌单的歌 ----------
  async function getPlaylistSongs(playlistId) {
    if (!playlistId) throw new Error('getPlaylistSongs 需要 playlistId');

    const api = getApi();
    const cookie = await getCookie();
    // 用 playlist_track_all：支持完整列表，不只 10 首
    const r = await api.playlist_track_all({
      id: playlistId,
      limit: 10000,
      cookie,
    });
    if (r?.body?.code !== 200) {
      throw new Error(
        `playlist_track_all code=${r?.body?.code} msg=${r?.body?.message || ''}`
      );
    }
    const songs = r?.body?.songs || [];
    return {
      name: '', // playlist_track_all 返回里不直接带歌单名；可选之后再补一个 playlist_detail 拉
      total: songs.length,
      songs: songs.map((s) => ({
        songId: String(s.id),
        title: s.name || '',
        artist: (s.ar || []).map((a) => a.name).join('/'),
        album: s.al?.name || '',
        duration: Math.round((s.dt || 0) / 1000),
      })),
    };
  }

  // ---------- cookie 相关（通用 auth 接口） ----------

  /**
   * 接受新 cookie，验证有效性
   * @param {string} cookieString
   * @returns {Promise<{ok: boolean, error?: string, toWrite?: {fileName: string, content: string}}>}
   */
  async function applyCookie(cookieString) {
    const raw = String(cookieString || '').trim();
    if (!raw) return { ok: false, error: 'cookie 不能为空' };

    // 网易云核心字段是 MUSIC_U（有了它就有登录态）
    if (!/(^|;\s*)MUSIC_U=/i.test(raw)) {
      return {
        ok: false,
        error: 'cookie 缺少关键字段 MUSIC_U（从浏览器复制时要完整，包含 MUSIC_U=...）',
      };
    }

    const api = getApi();
    // 用 login_status 验证
    let r;
    try {
      r = await api.login_status({ cookie: raw });
    } catch (e) {
      return { ok: false, error: `验证失败: ${e.message}` };
    }
    const code = r?.body?.data?.code ?? r?.body?.code;
    const profile = r?.body?.data?.profile || r?.body?.profile;
    if (code !== 200 || !profile?.userId) {
      return {
        ok: false,
        error: `cookie 无效（login_status code=${code}），请重新从浏览器复制`,
      };
    }

    // 验证通过 → 更新进程内 cookie + userId（这样后续 getMyPlaylists() 可以零参调用）
    _cookieCache = raw;
    _cookieLoadedAt = Date.now();
    const newUid = String(profile.userId);
    const uidChanged = !defaultUserId || defaultUserId !== newUid;
    defaultUserId = newUid;

    console.log(`[netease] cookie 验证成功，登录用户：${profile.nickname}（uid=${newUid}）`);

    return {
      ok: true,
      toWrite: { fileName: 'netease_cookie.txt', content: raw + '\n' },
      // 新拿到 uid 时把它持久化到 .env，下次启动直接用
      envPatch: uidChanged ? { NETEASE_UID: newUid } : null,
      userInfo: { nickname: profile.nickname, userId: newUid },
    };
  }

  async function probeAuth() {
    const api = getApi();
    const cookie = await getCookie();
    if (!cookie) return 'expired';
    try {
      const r = await api.login_status({ cookie });
      const code = r?.body?.data?.code ?? r?.body?.code;
      const profile = r?.body?.data?.profile || r?.body?.profile;
      if (code === 200 && profile?.userId) {
        // 顺手补一下 userId，避免老 .env 没 NETEASE_UID 时 getMyPlaylists 抛错
        if (!defaultUserId) {
          defaultUserId = String(profile.userId);
          console.log(`[netease] probe 顺便补回 userId=${defaultUserId}（${profile.nickname}）`);
        }
        return 'ok';
      }
      return 'expired';
    } catch (e) {
      console.warn('[netease] probe 异常:', e.message);
      return 'unknown';
    }
  }

  const cookieInstructions = {
    siteUrl: 'https://music.163.com',
    siteName: '网易云音乐',
    requiredFields: ['MUSIC_U'],
    extraNote: 'MUSIC_U 是关键；__csrf / NMTID 等辅助字段带上更稳；登录后任意请求都能复制到',
  };

  // ---------- 扫码登录（网易云独有） ----------
  // 流程：
  //   1) startQrLogin() → { key, qrDataUrl }（base64 PNG）
  //   2) 前端显示二维码，server 每 2s 调 checkQrLogin(key)
  //   3) status='confirmed' 时 cookie 字段就有了，直接走 applyCookie 落盘

  /** 申请 unikey + 生成二维码图片 */
  async function startQrLogin() {
    const api = getApi();
    const keyResp = await api.login_qr_key({});
    const unikey = keyResp?.body?.data?.unikey;
    if (!unikey) {
      throw new Error(`login_qr_key 失败 code=${keyResp?.body?.code}`);
    }
    const qrResp = await api.login_qr_create({ key: unikey, qrimg: true });
    const qrDataUrl = qrResp?.body?.data?.qrimg || '';
    if (!qrDataUrl) {
      throw new Error('login_qr_create 没返回 qrimg（base64 PNG）');
    }
    return { key: unikey, qrDataUrl };
  }

  /**
   * 轮询扫码状态
   * 网易云返回的 code：
   *   800 = 二维码已过期
   *   801 = 等待扫码
   *   802 = 已扫码，等待确认
   *   803 = 授权登录成功（此时 body.cookie 是完整的 cookie 字符串）
   * @param {string} key
   * @returns {Promise<{status: 'waiting'|'scanned'|'confirmed'|'expired', cookie?: string, nickname?: string, userId?: string}>}
   */
  async function checkQrLogin(key) {
    if (!key) throw new Error('checkQrLogin 需要 key');
    const api = getApi();
    const r = await api.login_qr_check({ key });
    const code = r?.body?.code;
    if (code === 803) {
      const cookieStr = r?.body?.cookie || '';
      // 用 login_status 顺手拿一下用户信息（同 applyCookie 的二次校验）
      let nickname, userId;
      try {
        const stat = await api.login_status({ cookie: cookieStr });
        const profile = stat?.body?.data?.profile || stat?.body?.profile;
        if (profile) {
          nickname = profile.nickname;
          userId = String(profile.userId || '');
        }
      } catch {
        /* ignore，cookie 本身已经能用 */
      }
      return { status: 'confirmed', cookie: cookieStr, nickname, userId };
    }
    if (code === 802) return { status: 'scanned' };
    if (code === 800) return { status: 'expired' };
    return { status: 'waiting' };
  }

  return {
    kind: 'netease',
    search,
    getPlayUrl,
    getMyPlaylists,
    getPlaylistSongs,
    applyCookie,
    probeAuth,
    cookieInstructions,
    // 网易云独有：扫码登录
    startQrLogin,
    checkQrLogin,
    // 让上层（server）能问"现在的 userId 是多少"，用来回写 .env
    getCurrentUserId() { return defaultUserId; },
  };
}

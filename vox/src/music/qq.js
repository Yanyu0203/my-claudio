/**
 * QQ 音乐 provider
 * --------------------------------------------------
 * 实现 MusicProvider 接口（见 ./index.js 的 JSDoc）
 *
 * 内部分两路：
 *   - 搜歌：直连腾讯 musicu.fcg 新接口（jsososo 老接口已被腾讯下线）
 *   - 取直链 / 拉歌单：走本地 QQMusicApi（cookie 已托管在那边）
 *
 * 字段映射（QQ 原生 → 通用）：
 *   songmid  → songId
 *   tid      → playlistId
 *   dirid=201 → isFavorite=true
 *   uin      → userId
 */
import { reportAuthFailSignal, resetAuthFailSignals } from '../qqauth.js';

const DEFAULT_API_BASE = 'http://localhost:3300';
const TENCENT_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

// ---------- 全局节流：同进程所有 search 共享 ----------
// 搜歌请求之间强制最小间隔，避免短时间内打爆腾讯风控
const MIN_SEARCH_GAP_MS = 800;
// 连续风控后的冷却窗口（窗口内新请求也先 sleep 一段）
const COOLDOWN_AFTER_BLOCK_MS = 30_000;
let _lastSearchAt = 0;
let _cooldownUntil = 0;
let _searchChain = Promise.resolve(); // 串行队列，防止并行风控

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttleBeforeSearch() {
  const now = Date.now();

  // 1) 处在冷却窗口里 → 等到窗口结束
  if (now < _cooldownUntil) {
    const wait = _cooldownUntil - now;
    console.warn(`[qq] 仍在冷却中，等 ${wait}ms`);
    await sleep(wait);
  }

  // 2) 距上次 search 太近 → 垫到 MIN_SEARCH_GAP_MS
  const gap = Date.now() - _lastSearchAt;
  if (gap < MIN_SEARCH_GAP_MS) {
    await sleep(MIN_SEARCH_GAP_MS - gap);
  }
  _lastSearchAt = Date.now();
}

function triggerCooldown(reason) {
  _cooldownUntil = Date.now() + COOLDOWN_AFTER_BLOCK_MS;
  console.warn(
    `[qq] 触发风控（${reason}），进入 ${COOLDOWN_AFTER_BLOCK_MS / 1000}s 冷却`
  );
}

/**
 * 创建一个 QQ 音乐 provider
 * @param {object} opts
 * @param {string} [opts.apiBase] 本地 QQMusicApi 地址
 * @param {string} [opts.userId]  默认用户 ID（QQ 号，拉歌单时用）
 * @returns {import('./index.js').MusicProvider}
 */
export function createQQProvider(opts = {}) {
  const apiBase = (opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
  const defaultUserId = opts.userId || opts.uin || '';

  // ---------- 内部工具 ----------
  async function callLocal(path, params = {}) {
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`QQMusicApi ${path} HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.result !== 100 && json.result !== undefined) {
      throw new Error(
        `QQMusicApi ${path} 业务异常 result=${json.result} msg=${json.errMsg || ''}`
      );
    }
    return json.data;
  }

  // ---------- 搜歌：腾讯新接口 ----------
  async function search(keyword, n = 5) {
    if (!keyword || !keyword.trim()) return [];
    // 全局串行：前一条 search 没 return 前不发下一条，避免并发打爆风控
    const task = _searchChain.then(() => _doSearch(keyword, n));
    _searchChain = task.catch(() => {});
    return task;
  }

  async function _doSearch(keyword, n) {
    const payload = {
      req_1: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: {
          num_per_page: n,
          page_num: 1,
          query: keyword,
          search_type: 0, // 0=单曲
        },
      },
    };

    // 带最多 3 次重试 + 长退避（应对 code:2001 风控）
    const MAX_RETRY = 3;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      await throttleBeforeSearch();

      const url = `${TENCENT_MUSICU}?data=${encodeURIComponent(JSON.stringify(payload))}`;
      let res;
      try {
        res = await fetch(url, {
          headers: {
            Referer: 'https://y.qq.com',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          },
        });
      } catch (e) {
        if (attempt < MAX_RETRY - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw e;
      }

      if (!res.ok) {
        if (res.status === 429 || res.status === 403) {
          triggerCooldown(`HTTP ${res.status}`);
        }
        if (attempt < MAX_RETRY - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new Error(`腾讯搜歌 HTTP ${res.status}`);
      }
      const json = await res.json();
      const r1 = json?.req_1 || {};
      const list = r1?.data?.body?.song?.list || [];

      if (list.length > 0) {
        const out = list.map((s) => ({
          songId: s.mid,
          title: s.title || s.name,
          artist: (s.singer || []).map((x) => x.name).join('/'),
          album: s.album?.name || '',
          cover: s.album?.mid
            ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${s.album.mid}.jpg`
            : '',
          duration: s.interval || 0,
        }));
        console.log(`[qq] search "${keyword}" → ${out.length} hits`);
        return out;
      }
      // 空结果 + code != 0 → 风控，进入冷却并退避
      if (r1.code !== 0) {
        triggerCooldown(`code=${r1.code}`);
        if (attempt < MAX_RETRY - 1) {
          const wait = 2000 * Math.pow(2, attempt);
          console.warn(
            `[qq] search "${keyword}" code=${r1.code}, 退避 ${wait}ms 重试 [${attempt + 1}/${MAX_RETRY}]`
          );
          await sleep(wait);
          continue;
        }
        const out = [];
        out.rateLimited = true;
        console.warn(`[qq] search "${keyword}" 风控重试用尽 code=${r1.code}`);
        return out;
      }
      console.log(`[qq] search "${keyword}" → 0 hits (真空)`);
      return [];
    }
    return [];
  }

  // ---------- 拿播放直链 ----------
  /**
   * 双路：路 A 本地 QQMusicApi（带 cookie，能拿 VIP） / 路 B 直连腾讯 vkey（兜底）
   */
  async function getPlayUrl(songId) {
    if (!songId) return { url: '', authFail: false };

    let aAuthFail = false;

    // ---- 路 A: 本地 QQMusicApi（推荐路径，带登录 cookie） ----
    let aReason = '';
    try {
      const url = `${apiBase}/song/url?id=${encodeURIComponent(songId)}`;
      const res = await fetch(url);
      if (!res.ok) {
        aReason = `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) aAuthFail = true;
      } else {
        const json = await res.json();
        if (typeof json?.data === 'string' && json.data.startsWith('http')) {
          resetAuthFailSignals();
          return { url: json.data, authFail: false };
        }
        if (json?.result === 400) {
          aAuthFail = true;
        }
        aReason = `result=${json?.result} data="${typeof json?.data === 'string' ? json.data.slice(0, 60) : JSON.stringify(json).slice(0, 120)}"`;
      }
    } catch (e) {
      aReason = `throw ${e.message}`;
    }
    console.warn(`[qq] 路A /song/url ${songId} 失败: ${aReason}${aAuthFail ? ' [auth-suspect]' : ''}`);
    if (aAuthFail) {
      reportAuthFailSignal();
    }

    // ---- 路 B: 直连腾讯（兜底，不需要本地服务） ----
    let bReason = '';
    try {
      const detailPayload = {
        songinfo: {
          method: 'get_song_detail_yqq',
          module: 'music.pf_song_detail_svr',
          param: { song_mid: songId },
        },
      };
      const dRes = await fetch(
        `${TENCENT_MUSICU}?data=${encodeURIComponent(JSON.stringify(detailPayload))}`,
        { headers: { Referer: 'https://y.qq.com' } }
      );
      if (!dRes.ok) {
        bReason = `detail HTTP ${dRes.status}`;
      } else {
        const dJson = await dRes.json();
        const strMediaMid =
          dJson?.songinfo?.data?.track_info?.file?.media_mid || songId;

        const file = `M500${strMediaMid}.mp3`;
        const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
        const vkeyPayload = {
          req_0: {
            module: 'vkey.GetVkeyServer',
            method: 'CgiGetVkey',
            param: {
              filename: [file],
              guid,
              songmid: [songId],
              songtype: [0],
              uin: '0',
              loginflag: 1,
              platform: '20',
            },
          },
        };
        const vRes = await fetch(
          `${TENCENT_MUSICU}?format=json&data=${encodeURIComponent(JSON.stringify(vkeyPayload))}`,
          {
            headers: {
              Referer: 'https://y.qq.com',
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            },
          }
        );
        if (!vRes.ok) {
          bReason = `vkey HTTP ${vRes.status}`;
        } else {
          const vJson = await vRes.json();
          const item = vJson?.req_0?.data?.midurlinfo?.[0];
          const sipList = vJson?.req_0?.data?.sip || [];
          const sip = sipList.find((s) => !s.startsWith('http://ws')) || sipList[0];
          if (item?.purl && sip) {
            resetAuthFailSignals();
            return { url: sip + item.purl, authFail: false };
          }
          bReason = `purl空 item=${JSON.stringify(item).slice(0, 120)} sip=${sipList.length}条`;
        }
      }
    } catch (e) {
      bReason = `throw ${e.message}`;
    }
    console.warn(`[qq] 路B vkey ${songId} 失败: ${bReason}`);

    return { url: '', authFail: aAuthFail };
  }

  // ---------- 拉某用户的所有歌单 ----------
  async function getMyPlaylists(userId) {
    const u = userId || defaultUserId;
    if (!u) throw new Error('getMyPlaylists 需要 userId (QQ 号)');
    const data = await callLocal('/user/songlist', { id: u });
    const list = data?.list || [];
    return list
      .filter((d) => d.tid && d.song_cnt > 0) // 过滤空歌单 + 占位项
      .map((d) => ({
        playlistId: d.tid,
        name: d.diss_name,
        cover: d.diss_cover,
        songCount: d.song_cnt,
        isFavorite: d.dirid === 201, // QQ 约定：201 = "我喜欢"
      }));
  }

  // ---------- 拉单个歌单的歌 ----------
  async function getPlaylistSongs(playlistId) {
    if (!playlistId) throw new Error('getPlaylistSongs 需要 playlistId');
    const data = await callLocal('/songlist', { id: playlistId });
    const songlist = data?.songlist || [];
    return {
      name: data?.dissname || '',
      total: data?.songnum || songlist.length,
      songs: songlist.map((s) => ({
        songId: s.songmid || s.mid,
        title: s.songname || s.name,
        artist: (s.singer || []).map((x) => x.name).join('/'),
        album: s.albumname || s.album?.name || '',
        duration: s.interval || 0,
      })),
    };
  }

  return {
    kind: 'qq',
    search,
    getPlayUrl,
    getMyPlaylists,
    getPlaylistSongs,
  };
}

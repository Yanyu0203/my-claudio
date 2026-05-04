/**
 * QQ 音乐统一客户端
 * --------------------------------------------------
 * 对外暴露 4 个方法，给 Vox 其它模块用：
 *   - search(keyword, n)        搜歌
 *   - getPlayUrl(songmid)       拿 mp3 直链（返回 {url, authFail}）
 *   - getMyPlaylists(uin)       拉某个用户的所有歌单
 *   - getPlaylistSongs(tid)     拉单个歌单的所有歌
 *
 * 内部分两路：
 *   - 搜歌：直连腾讯 musicu.fcg 新接口（jsososo 老接口已被腾讯下线）
 *   - 取直链 / 拉歌单：走本地 QQMusicApi（cookie 已托管在那边）
 */
import { reportAuthFailSignal, resetAuthFailSignals } from './qqauth.js';

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
    console.warn(`[qqmusic] 仍在冷却中，等 ${wait}ms`);
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
    `[qqmusic] 触发风控（${reason}），进入 ${COOLDOWN_AFTER_BLOCK_MS / 1000}s 冷却`
  );
}

/**
 * 创建一个 QQ 音乐客户端
 * @param {object} opts
 * @param {string} [opts.apiBase] 本地 QQMusicApi 地址
 * @param {string} [opts.uin]     默认 QQ 号（拉歌单时用）
 */
export function createQQMusic(opts = {}) {
  const apiBase = (opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
  const defaultUin = opts.uin || '';

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
  /**
   * @param {string} keyword 搜索关键词
   * @param {number} [n=5]   返回多少条
   * @returns {Promise<Array<{songmid:string,title:string,artist:string,album:string,duration:number}>>}
   */
  async function search(keyword, n = 5) {
    if (!keyword || !keyword.trim()) return [];

    // 全局串行：前一条 search 没 return 前不发下一条，避免并发打爆风控
    const task = _searchChain.then(() => _doSearch(keyword, n));
    _searchChain = task.catch(() => {}); // 链上异常不阻塞后续
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
          songmid: s.mid,
          title: s.title || s.name,
          artist: (s.singer || []).map((x) => x.name).join('/'),
          album: s.album?.name || '',
          albummid: s.album?.mid || '',
          cover: s.album?.mid
            ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${s.album.mid}.jpg`
            : '',
          duration: s.interval || 0,
        }));
        console.log(`[qqmusic] search "${keyword}" → ${out.length} hits`);
        return out;
      }
      // 空结果 + code != 0 → 风控，进入冷却并退避
      if (r1.code !== 0) {
        triggerCooldown(`code=${r1.code}`);
        if (attempt < MAX_RETRY - 1) {
          // 风控后退避更激进：2s / 5s / ...
          const wait = 2000 * Math.pow(2, attempt);
          console.warn(
            `[qqmusic] search "${keyword}" code=${r1.code}, 退避 ${wait}ms 重试 [${attempt + 1}/${MAX_RETRY}]`
          );
          await sleep(wait);
          continue;
        }
        // 重试用尽仍风控 → 返回空数组但标记 rateLimited
        const out = [];
        out.rateLimited = true;
        console.warn(`[qqmusic] search "${keyword}" 风控重试用尽 code=${r1.code}`);
        return out;
      }
      // code=0 但确实没结果
      console.log(`[qqmusic] search "${keyword}" → 0 hits (真空)`);
      return [];
    }
    return [];
  }

  // ---------- 拿播放直链 ----------
  /**
   * 双路实现，谁先拿到用谁：
   *   路 A: 走本地 QQMusicApi /song/url（带它自己 globalCookie，能拿 VIP）
   *   路 B: 直接打腾讯 musicu.fcg vkey（无 cookie 仅能拿非 VIP）
   *
   * @param {string} songmid
   * @returns {Promise<string>} mp3 直链；拿不到返回空串
   */
  /**
   * 拿播放直链
   * 双路：路 A 本地 QQMusicApi（带 cookie，能拿 VIP） / 路 B 直连腾讯 vkey（兜底）
   *
   * @param {string} songmid
   * @returns {Promise<{url: string, authFail: boolean}>}
   *   url: mp3 直链，失败返回 ''
   *   authFail: true = 路A 明确返回了"cookie 过期"的信号（result=400 或 401/403）
   *             上层可据此聚合后触发全局熔断
   */
  async function getPlayUrl(songmid) {
    if (!songmid) return { url: '', authFail: false };

    let aAuthFail = false;

    // ---- 路 A: 本地 QQMusicApi（推荐路径，带登录 cookie） ----
    let aReason = '';
    try {
      const url = `${apiBase}/song/url?id=${encodeURIComponent(songmid)}`;
      const res = await fetch(url);
      if (!res.ok) {
        aReason = `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) aAuthFail = true;
      } else {
        const json = await res.json();
        if (typeof json?.data === 'string' && json.data.startsWith('http')) {
          // 一次成功 → 清零累计信号（说明 cookie 没问题）
          resetAuthFailSignals();
          return { url: json.data, authFail: false };
        }
        // QQMusicApi 约定 result=400 + "获取播放链接出错" = 疑似 cookie 过期
        // 但也可能只是这首歌 VIP 限权，不立刻下结论，先记个信号
        if (json?.result === 400) {
          aAuthFail = true;
        }
        aReason = `result=${json?.result} data="${typeof json?.data === 'string' ? json.data.slice(0, 60) : JSON.stringify(json).slice(0, 120)}"`;
      }
    } catch (e) {
      aReason = `throw ${e.message}`;
    }
    console.warn(`[qqmusic] 路A /song/url ${songmid} 失败: ${aReason}${aAuthFail ? ' [auth-suspect]' : ''}`);
    if (aAuthFail) {
      reportAuthFailSignal();
    }

    // ---- 路 B: 直连腾讯（兜底，不需要本地服务） ----
    let bReason = '';
    try {
      // step 1: 拿 strMediaMid
      const detailPayload = {
        songinfo: {
          method: 'get_song_detail_yqq',
          module: 'music.pf_song_detail_svr',
          param: { song_mid: songmid },
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
          dJson?.songinfo?.data?.track_info?.file?.media_mid || songmid;

        // step 2: vkey
        const file = `M500${strMediaMid}.mp3`;
        const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
        const vkeyPayload = {
          req_0: {
            module: 'vkey.GetVkeyServer',
            method: 'CgiGetVkey',
            param: {
              filename: [file],
              guid,
              songmid: [songmid],
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
            // 路 B 也能播说明至少非 VIP 通路在 — cookie 还活着的可能性很大
            // 不过保守起见只清零信号，不下"cookie OK"的结论
            resetAuthFailSignals();
            return { url: sip + item.purl, authFail: false };
          }
          bReason = `purl空 item=${JSON.stringify(item).slice(0, 120)} sip=${sipList.length}条`;
        }
      }
    } catch (e) {
      bReason = `throw ${e.message}`;
    }
    console.warn(`[qqmusic] 路B vkey ${songmid} 失败: ${bReason}`);

    return { url: '', authFail: aAuthFail };
  }

  // ---------- 拉某用户的所有歌单 ----------
  /**
   * @param {string} [uin] 不传用 createQQMusic 时设置的默认 uin
   * @returns {Promise<Array<{tid:number,name:string,cover:string,songCount:number,dirid:number}>>}
   */
  async function getMyPlaylists(uin) {
    const u = uin || defaultUin;
    if (!u) throw new Error('getMyPlaylists 需要 uin');
    const data = await callLocal('/user/songlist', { id: u });
    const list = data?.list || [];
    return list
      .filter((d) => d.tid && d.song_cnt > 0) // 过滤掉空歌单和占位项
      .map((d) => ({
        tid: d.tid,
        name: d.diss_name,
        cover: d.diss_cover,
        songCount: d.song_cnt,
        dirid: d.dirid, // 201=我喜欢
      }));
  }

  // ---------- 拉单个歌单的歌 ----------
  /**
   * @param {string|number} tid 歌单 id
   * @returns {Promise<{name:string,songs:Array<{songmid:string,title:string,artist:string,album:string}>}>}
   */
  async function getPlaylistSongs(tid) {
    if (!tid) throw new Error('getPlaylistSongs 需要 tid');
    const data = await callLocal('/songlist', { id: tid });
    const songlist = data?.songlist || [];
    return {
      name: data?.dissname || '',
      total: data?.songnum || songlist.length,
      songs: songlist.map((s) => ({
        songmid: s.songmid || s.mid,
        title: s.songname || s.name,
        artist: (s.singer || []).map((x) => x.name).join('/'),
        album: s.albumname || s.album?.name || '',
        duration: s.interval || 0,
      })),
    };
  }

  return {
    search,
    getPlayUrl,
    getMyPlaylists,
    getPlaylistSongs,
  };
}

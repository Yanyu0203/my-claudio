/**
 * QQ 音乐统一客户端
 * --------------------------------------------------
 * 对外暴露 4 个方法，给 Vox 其它模块用：
 *   - search(keyword, n)        搜歌
 *   - getPlayUrl(songmid)       拿 mp3 直链
 *   - getMyPlaylists(uin)       拉某个用户的所有歌单
 *   - getPlaylistSongs(tid)     拉单个歌单的所有歌
 *
 * 内部分两路：
 *   - 搜歌：直连腾讯 musicu.fcg 新接口（jsososo 老接口已被腾讯下线）
 *   - 取直链 / 拉歌单：走本地 QQMusicApi（cookie 已托管在那边）
 */

const DEFAULT_API_BASE = 'http://localhost:3300';
const TENCENT_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

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

    // 带最多 3 次重试 + 退避（应对偶发的 code:2001 风控）
    const MAX_RETRY = 3;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const url = `${TENCENT_MUSICU}?data=${encodeURIComponent(JSON.stringify(payload))}`;
      const res = await fetch(url, {
        headers: {
          Referer: 'https://y.qq.com',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });
      if (!res.ok) {
        if (attempt < MAX_RETRY - 1) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new Error(`腾讯搜歌 HTTP ${res.status}`);
      }
      const json = await res.json();
      const r1 = json?.req_1 || {};
      const list = r1?.data?.body?.song?.list || [];

      if (list.length > 0) {
        return list.map((s) => ({
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
      }
      // 空结果 + code != 0 → 风控，退避重试
      if (r1.code !== 0 && attempt < MAX_RETRY - 1) {
        console.warn(`[qqmusic] search "${keyword}" 触发风控 code=${r1.code}, 退避 ${500 * (attempt + 1)}ms 重试 [${attempt + 1}/${MAX_RETRY}]`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      // code=0 但确实没结果，或者重试用尽
      return [];
    }
    return [];
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
  async function getPlayUrl(songmid) {
    if (!songmid) return '';

    // ---- 路 A: 本地 QQMusicApi（推荐路径，带登录 cookie） ----
    try {
      const url = `${apiBase}/song/url?id=${encodeURIComponent(songmid)}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (typeof json?.data === 'string' && json.data.startsWith('http')) {
          return json.data;
        }
      }
    } catch {
      /* 落到下一路 */
    }

    // ---- 路 B: 直连腾讯（兜底，不需要本地服务） ----
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
      if (!dRes.ok) return '';
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
      if (!vRes.ok) return '';
      const vJson = await vRes.json();
      const item = vJson?.req_0?.data?.midurlinfo?.[0];
      const sipList = vJson?.req_0?.data?.sip || [];
      const sip = sipList.find((s) => !s.startsWith('http://ws')) || sipList[0];
      if (item?.purl && sip) return sip + item.purl;
    } catch {
      /* ignore */
    }

    return '';
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

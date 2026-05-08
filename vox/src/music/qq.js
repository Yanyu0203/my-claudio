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
import { reportAuthFailSignal, resetAuthFailSignals } from '../musicauth.js';

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

  // ---------- cookie 相关（通用 auth 接口） ----------

  /**
   * 把新 cookie 推给本地 QQMusicApi 并验证能拿直链
   * 验证成功后，调用方（musicauth）应负责落盘到 data/qq_cookie.json
   * @param {string} cookieString  浏览器复制的完整 cookie 文本
   * @returns {Promise<{ok: boolean, error?: string, toWrite?: {path: string, content: string}}>}
   */
  async function applyCookie(cookieString) {
    const raw = String(cookieString || '').trim();
    if (!raw) return { ok: false, error: 'cookie 不能为空' };

    // 校验关键字段
    const required = ['uin', 'qm_keyst'];
    const missing = required.filter((k) => !new RegExp(`(^|;\\s*)${k}=`).test(raw));
    if (missing.length) {
      return {
        ok: false,
        error: `cookie 缺少关键字段: ${missing.join(', ')}（从浏览器复制时要完整）`,
      };
    }

    const payload = JSON.stringify({ data: raw });

    // 推给 QQMusicApi
    let res;
    try {
      res = await fetch(apiBase + '/user/setCookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    } catch (e) {
      return { ok: false, error: `连不上 QQMusicApi (${apiBase}): ${e.message}` };
    }
    if (!res.ok) return { ok: false, error: `QQMusicApi /user/setCookie HTTP ${res.status}` };
    const setJson = await res.json().catch(() => ({}));
    if (setJson.result !== 100) {
      return { ok: false, error: `setCookie 响应异常: ${JSON.stringify(setJson).slice(0, 200)}` };
    }

    // 验证：用 /user/detail 看当前登录态（比随便抓一首歌可靠得多）
    // /user/detail 是基于 uin 的用户信息接口，只有真正登录态才返回 result:100
    // 注意：必须用 applyCookie 时 provider 已经有的 defaultUserId
    if (!defaultUserId) {
      // 没设 QQ_UIN，没法做鉴权验证，只能相信字段校验
      console.warn('[qq] applyCookie：没有 QQ_UIN，跳过鉴权验证直接落盘');
      return {
        ok: true,
        toWrite: { fileName: 'qq_cookie.json', content: payload + '\n' },
      };
    }

    try {
      // 用 /user/songlist 做验证（比 /user/detail 可靠，详见 probeAuth 注释）
      const dUrl = apiBase + '/user/songlist?id=' + encodeURIComponent(defaultUserId);
      const dRes = await fetch(dUrl, { signal: AbortSignal.timeout(8000) });
      const dJson = await dRes.json().catch(() => ({}));
      if (dJson?.result === 100 && Array.isArray(dJson?.data?.list)) {
        // 真·登录成功
        console.log(`[qq] applyCookie 验证通过：能拉到 ${dJson.data.list.length} 个歌单`);
        return {
          ok: true,
          toWrite: { fileName: 'qq_cookie.json', content: payload + '\n' },
        };
      }
      if (dJson?.result === 301 || /未登/.test(dJson?.errMsg || '')) {
        return {
          ok: false,
          error: `cookie 写入但腾讯判定未登录（result=${dJson?.result}）。可能：(1) 复制时漏了字段，(2) 登录的 QQ 号不是 ${defaultUserId}，(3) cookie 已过期。请从浏览器重新完整复制。`,
        };
      }
      // 返回异常但不是明确的 301 → 宽容通过
      console.warn(`[qq] applyCookie 验证返回未知响应，宽容通过: ${JSON.stringify(dJson).slice(0, 200)}`);
      return {
        ok: true,
        warning: `cookie 已写入，但 /user/songlist 返回异常响应，实际是否生效以播歌为准`,
        toWrite: { fileName: 'qq_cookie.json', content: payload + '\n' },
      };
    } catch (e) {
      // 验证请求本身挂了（超时 / 网络）→ 宽容通过，至少落盘
      console.warn('[qq] applyCookie 验证请求异常，宽容通过:', e.message);
      return {
        ok: true,
        warning: `cookie 已写入，但验证请求失败（${e.message}），实际是否生效以播歌为准`,
        toWrite: { fileName: 'qq_cookie.json', content: payload + '\n' },
      };
    }
  }

  /**
   * 重启本地 QQMusicApi 服务
   * --------------------------------------------------
   * 为什么需要：`/user/setCookie` 只是把 cookie 推进去，但 QQMusicApi 长期运行后
   * 内部会缓存 cookie 派生出来的签名字段（g_tk 等），热更新不彻底 → 表现为
   * 推了新 cookie 依然返回 result:301"未登陆"。唯一可靠的办法是重启 QQMusicApi 进程。
   *
   * 做的事：
   *   1) pkill 老的 QQMusicApi
   *   2) spawn 新的（从 $QQMUSIC_DIR 环境变量或默认 ../../../QQMusicApi 找目录）
   *   3) 轮询 3300 端口直到 ready（最多 15 秒）
   *   4) 推 cookie
   *   5) 调 /user/detail 验证
   *
   * @param {object} [opts]
   * @param {string} [opts.qqMusicDir]  QQMusicApi 目录绝对路径
   * @param {string} [opts.cookieFilePath] 待推送的 cookie 文件（JSON 格式 {data:"..."}）
   * @param {string} [opts.logFile] 子进程输出写到哪（默认黑洞）
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function restartBackend(opts = {}) {
    const { spawn } = await import('node:child_process');
    const fsMod = await import('node:fs/promises');

    const qqDir = opts.qqMusicDir;
    if (!qqDir) {
      return { ok: false, error: '没指定 qqMusicDir，无法重启 QQMusicApi' };
    }

    console.log('[qq] 准备重启 QQMusicApi（彻底刷新 cookie 缓存）...');

    // 1) 杀老进程
    try {
      await new Promise((resolve) => {
        const p = spawn('pkill', ['-f', 'QQMusicApi/bin/www'], { stdio: 'ignore' });
        p.on('exit', () => resolve());
        p.on('error', () => resolve()); // pkill 没匹配到进程时退出码 1，忽略
      });
      // 给端口一点时间真正释放
      await sleep(500);
    } catch {
      /* ignore */
    }

    // 2) 启动新进程
    const uin = defaultUserId || '';
    let logFd = 'ignore';
    if (opts.logFile) {
      try {
        const { open } = await import('node:fs/promises');
        const fh = await open(opts.logFile, 'a');
        logFd = fh.fd;
      } catch {
        /* 写 log 失败就黑洞 */
      }
    }
    console.log(`[qq] spawn QQMusicApi (dir=${qqDir}, QQ=${uin}) ...`);
    const child = spawn('yarn', ['start'], {
      cwd: qqDir,
      env: { ...process.env, QQ: uin },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    child.unref(); // 让它和 vox 进程脱钩，vox 退出时不被拖着

    // 3) 等端口 ready（最多 15s）
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const r = await fetch(apiBase, { signal: AbortSignal.timeout(2000) });
        if (r.ok || r.status === 404) {
          ready = true;
          break;
        }
      } catch {
        /* 继续等 */
      }
    }
    if (!ready) {
      return { ok: false, error: `QQMusicApi 重启后 15s 仍未 ready（${apiBase}）` };
    }
    console.log('[qq] QQMusicApi 重启完成，推 cookie...');

    // 4) 推 cookie
    if (opts.cookieFilePath) {
      try {
        const raw = await fsMod.readFile(opts.cookieFilePath, 'utf8');
        const setRes = await fetch(apiBase + '/user/setCookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: raw,
        });
        const setJson = await setRes.json().catch(() => ({}));
        if (setJson.result !== 100) {
          return { ok: false, error: `setCookie 响应异常: ${JSON.stringify(setJson).slice(0, 200)}` };
        }
      } catch (e) {
        return { ok: false, error: `推 cookie 失败: ${e.message}` };
      }
    }

    // 5) 验证
    try {
      const state = await probeAuth();
      if (state === 'ok') {
        console.log('[qq] ✅ 重启 + cookie 推送 + 验证全部通过');
        return { ok: true };
      }
      if (state === 'expired') {
        return { ok: false, error: '重启后验证仍显示未登录，cookie 可能确实过期了' };
      }
      // unknown：也算成功，可能只是 probe 接口抽风
      console.warn('[qq] 重启后验证返回 unknown，宽容通过');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `验证失败: ${e.message}` };
    }
  }

  /**
   * 主动探测 cookie 是否真的过期（不依赖 getPlayUrl）
   *
   * 注意：不要用 /user/detail —— 它打的是 fcg_get_profile_homepage.fcg，
   * 这个接口 QQMusicApi 对 cookie 签名支持不全，经常假阳性"未登陆"。
   *
   * 改用 /user/songlist：打 fcg_user_created_diss，这个接口只要 cookie 真有效就能返回歌单。
   * 未登录时腾讯返回 code=1000 被 QQMusicApi 转成 result=301。
   *
   * @returns {Promise<'ok' | 'expired' | 'unknown'>}
   */
  async function probeAuth() {
    if (!defaultUserId) return 'unknown';
    try {
      const url = apiBase + '/user/songlist?id=' + encodeURIComponent(defaultUserId);
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return 'unknown';
      const json = await res.json().catch(() => ({}));
      // 301 / code=1000 / 错误信息含 "未登" → 过期
      if (json?.result === 301 || json?.code === 1000 || /未登/.test(json?.errMsg || '')) {
        return 'expired';
      }
      // 200 + data.list 是数组 → 登录态正常
      if (json?.result === 100 && Array.isArray(json?.data?.list)) return 'ok';
      return 'unknown';
    } catch (e) {
      console.warn('[qq] probe 异常:', e.message);
      return 'unknown';
    }
  }

  /** 给前端弹窗显示的 cookie 获取说明 */
  const cookieInstructions = {
    siteUrl: 'https://y.qq.com',
    siteName: 'QQ 音乐',
    requiredFields: ['uin', 'qm_keyst'],
    extraNote: 'cookie 里若有 a_sk__xxx="01xxx" 这种带双引号的字段，复制时可能破坏 JSON，可删',
  };

  return {
    kind: 'qq',
    search,
    getPlayUrl,
    getMyPlaylists,
    getPlaylistSongs,
    applyCookie,
    probeAuth,
    cookieInstructions,
    // QQ 独有：重启本地 QQMusicApi 服务（刷新 cookie 缓存）
    restartBackend,
  };
}

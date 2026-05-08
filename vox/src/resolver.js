/**
 * 把大脑推荐的 [{title, artist, reason}] 翻译成可播的歌。
 *
 * 分两段（懒加载 url）：
 *   阶段 A · searchAll: 只搜到 songId + 元信息，不拿 mp3 直链
 *                        → 迅速返回 block 给前端，UI 立刻能画队列
 *   阶段 B · fetchUrlFor: 播到哪首/即将播到哪首，才拿那首的 mp3 直链
 *                        → 避免一次性 getPlayUrl N 首，省 cookie/vkey 请求
 *                        → url 更新鲜（vkey 有时效）
 *
 * 缓存策略：
 *   - song_cache         4h：搜+url 全成功后缓存（跳过阶段 A 和 B）
 *   - song_cache_meta    4h：只有 meta（songId/cover/duration），跳过阶段 A
 *   - song_cache_miss    5m：真没搜到（风控不写）
 *
 * 缓存 key 格式：`{provider.kind}:{title}|{artist}`
 *   - 前缀 provider.kind 是为了隔离不同音乐源（QQ 的 songmid 是 base62 hash，
 *     Netease 的 songId 是纯数字，混用会让 getPlayUrl 把别家的 id 当自家的查，必 fail）
 *   - 切 provider 后老缓存不会命中（key 前缀不同），会自然因 TTL 过期被清
 */
import { cacheGet, cacheSet } from './db.js';

const CACHE_MS = 4 * 60 * 60 * 1000; // 4 小时
const MISS_CACHE_MS = 5 * 60 * 1000; // 5 分钟

/** 生成带 provider kind 前缀的缓存 key */
function buildCacheKey(music, title, artist) {
  const kind = music?.kind || 'unknown';
  return `${kind}:${normKey(title)}|${normKey(artist)}`;
}

// ============================================================
// 阶段 A：searchAll —— 只搜 meta，不拿 url
// ============================================================

/**
 * @param {import('./music/index.js').MusicProvider} music
 * @param {Array<{title:string, artist:string, reason?:string}>} picks
 * @returns {Promise<{
 *   resolved: Array<{title, artist, reason, songId, cover, duration, album, url}>,
 *   failed: Array<{title, artist, reason}>,
 * }>}
 *   resolved 里的 url 可能为 ''（表示还没拿直链，后续 fetchUrlFor 再取）
 *   如果正向缓存里已经有合法 url，会直接带上（跳过阶段 B）
 */
export async function searchAll(music, picks) {
  const resolved = [];
  const failed = [];

  for (const p of picks) {
    const item = await searchOne(music, p);
    if (item) {
      resolved.push(item);
    } else {
      failed.push({ title: p.title, artist: p.artist, reason: 'no-meta' });
    }
  }
  return { resolved, failed };
}

async function searchOne(music, p) {
  const cacheKey = buildCacheKey(music, p.title, p.artist);

  // 1) 完整缓存（search + url 都有）
  const cached = cacheGet('song_cache', cacheKey);
  if (cached && cached.url && cached.songId) {
    return { ...cached, reason: p.reason || cached.reason || '' };
  }

  // 2) meta 缓存（只有 songId + 元信息，没 url）
  const meta = cacheGet('song_cache_meta', cacheKey);
  if (meta && meta.songId) {
    return { ...meta, url: '', reason: p.reason || meta.reason || '' };
  }

  // 3) 负缓存命中 → skip
  const miss = cacheGet('song_cache_miss', cacheKey);
  if (miss) {
    console.log(`[resolver] skip search "${p.title} - ${p.artist}" (负缓存)`);
    return null;
  }

  // 4) 实际去搜
  const queries = [`${p.title} ${p.artist}`, p.title];
  let sawRateLimit = false;
  for (const q of queries) {
    let hits;
    try {
      hits = await music.search(q, 5);
    } catch (e) {
      console.warn(`[resolver] search throw "${q}":`, e.message);
      continue;
    }
    if (hits.rateLimited) {
      sawRateLimit = true;
      continue;
    }
    if (!hits.length) continue;

    // 选最佳命中：核心原则是**绝不播试听版（时长 < 60s 的基本都是腾讯给的 30s 片段）**
    //
    // 优先级：
    //   1) 歌手名匹配 且 时长 ≥ 60s             ← 最优
    //   2) 歌手名不匹配 但 时长 ≥ 60s           ← 至少是完整版
    //   3) 歌手名匹配但全是短版本，时长 ≥ 45s   ← 极个别真完整歌就是 45s 左右的 interlude
    //   4) 无 ≥ 45s 候选                        ← 当作搜不到（看下面）
    const FULL_THRESHOLD = 60;       // 主流阈值
    const FALLBACK_THRESHOLD = 45;   // 允许的短歌下限（极少数 interlude）
    const artistMatchFull = hits.find(
      (h) => looseMatchArtist(h.artist, p.artist) && (h.duration || 0) >= FULL_THRESHOLD
    );
    const anyFullVersion = hits.find((h) => (h.duration || 0) >= FULL_THRESHOLD);
    const artistMatchShort = hits.find(
      (h) => looseMatchArtist(h.artist, p.artist) && (h.duration || 0) >= FALLBACK_THRESHOLD
    );
    const best = artistMatchFull || anyFullVersion || artistMatchShort;

    if (!best) {
      // 搜到了，但全是 <45s 的试听版 → 当作搜不到，让大脑下次换歌
      const shortList = hits
        .slice(0, 3)
        .map((h) => `${h.title}(${h.duration || 0}s)`)
        .join(', ');
      console.warn(
        `[resolver] "${p.title} - ${p.artist}" 全是试听版（${shortList}），放弃不播`
      );
      continue; // 试下一个 query 变体；最终 searchOne 返回 null
    }

    if ((best.duration || 0) < FULL_THRESHOLD) {
      console.warn(
        `[resolver] "${p.title} - ${p.artist}" 选到短版本（${best.duration}s），可能被试听截断`
      );
    }

    const metaItem = {
      title: best.title,
      artist: best.artist,
      reason: p.reason || '',
      songId: best.songId,
      duration: best.duration,
      album: best.album,
      cover: best.cover || '',
    };
    cacheSet('song_cache_meta', cacheKey, metaItem, CACHE_MS);
    return { ...metaItem, url: '' };
  }

  // 真没搜到 → 写负缓存
  if (!sawRateLimit) {
    cacheSet('song_cache_miss', cacheKey, { ts: Date.now() }, MISS_CACHE_MS);
  } else {
    console.log(`[resolver] "${p.title} - ${p.artist}" 受风控影响空结果，不写负缓存`);
  }
  return null;
}

// ============================================================
// 阶段 B：fetchUrlFor —— 按需拿单首的 mp3 直链
// ============================================================

/**
 * 给一首已 search 好的歌拿 mp3 直链（有缓存）
 * @param {import('./music/index.js').MusicProvider} music
 * @param {{title, artist, songId, duration, album, cover, reason?}} song
 * @returns {Promise<{url: string, authFail: boolean}>}
 */
export async function fetchUrlFor(music, song) {
  if (!song?.songId) return { url: '', authFail: false };

  const cacheKey = buildCacheKey(music, song.title, song.artist);

  // 完整缓存命中
  const cached = cacheGet('song_cache', cacheKey);
  if (cached && cached.url) {
    return { url: cached.url, authFail: false };
  }

  const { url, authFail } = await music.getPlayUrl(song.songId);
  if (url) {
    // 运行时验真：HEAD 看 Content-Length 是否和 meta 时长匹配
    // 典型 128kbps mp3 每秒 16KB；30s 试听版 ≈ 481KB。
    // 如果 meta 说这首歌 ≥ 60s，但实际 mp3 体积对应 < 35s → 大概率被腾讯发了试听版
    if ((song.duration || 0) >= 60) {
      const actual = await probeMp3Duration(url);
      if (actual > 0 && actual < 35) {
        console.warn(
          `[resolver] "${song.title} - ${song.artist}" 直链疑似试听版：` +
          `meta=${song.duration}s, 实际≈${actual}s。放弃此 mp3`
        );
        // 不缓存、不返回 url，让上层当拿不到直链处理
        return { url: '', authFail: false };
      }
    }

    // 升级到"完整缓存"
    const full = {
      title: song.title,
      artist: song.artist,
      reason: song.reason || '',
      songId: song.songId,
      url,
      duration: song.duration,
      album: song.album,
      cover: song.cover || '',
    };
    cacheSet('song_cache', cacheKey, full, CACHE_MS);
    return { url, authFail: false };
  }

  if (authFail) {
    console.warn(
      `[resolver] "${song.title} - ${song.artist}" 直链认证失败`
    );
    return { url: '', authFail: true };
  }
  console.warn(
    `[resolver] "${song.title} - ${song.artist}" 直链拿不到（VIP/版权）`
  );
  return { url: '', authFail: false };
}

/**
 * 批量拿直链（用于"首批播放前 N 首一次性预热"，保证点 PLAY 就能响）
 * @param {import('./music/index.js').MusicProvider} music
 * @param {Array} songs  searchAll 返回的歌（已含 songId）
 * @param {number} n     前 n 首
 * @returns {Promise<{authFailCount: number}>}  副作用：songs[i].url 会被填上
 */
export async function prefetchUrls(music, songs, n) {
  let authFailCount = 0;
  const k = Math.min(n, songs.length);
  for (let i = 0; i < k; i++) {
    if (songs[i].url) continue; // 缓存已有
    const { url, authFail } = await fetchUrlFor(music, songs[i]);
    songs[i].url = url;
    if (authFail) authFailCount++;
  }
  return { authFailCount };
}

// ============================================================
// helpers
// ============================================================

function normKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[/、,&]/g, '');
}

function looseMatchArtist(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.toLowerCase().replace(/[\s\-_]/g, '');
  const A = norm(a);
  const B = norm(b);
  if (A === B) return true;
  if (A.includes(B) || B.includes(A)) return true;
  for (const part of a.split(/[/、,&]/)) {
    if (norm(part) === B) return true;
  }
  return false;
}

/**
 * 通过 HEAD 请求的 Content-Length 反推 mp3 时长（粗略）。
 * 假定 128kbps mp3，每秒 16KB。返回估算秒数；拿不到 Content-Length 返回 0。
 *
 * 用途：区分"完整歌"vs"30 秒试听版"。
 *   - 30s 试听：约 480KB → 估算 30s
 *   - 完整歌 3 分钟：约 2.8MB → 估算 180s
 */
async function probeMp3Duration(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return 0;
    const len = Number(res.headers.get('content-length') || 0);
    if (len <= 0) return 0;
    // 128kbps = 16KB/s
    return Math.round(len / 16000);
  } catch {
    return 0; // 网络异常就不拦截，让 mp3 自己说话
  }
}

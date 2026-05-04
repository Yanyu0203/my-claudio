/**
 * 把大脑推荐的 [{title, artist, reason}] 翻译成可播放的 [{...meta, url}]
 *
 * 加 SQLite 缓存：
 *   - 正向缓存 song_cache：相同 title|artist 4 小时内不重复请求
 *   - 负向缓存 song_cache_miss：搜不到的 1 小时内不再搜（防止风控放大）
 *
 * 直链 vkey 通常 6-24 小时内有效，缓存 4 小时偏保守，确保重启后仍可播
 */
import { cacheGet, cacheSet } from './db.js';

const CACHE_MS = 4 * 60 * 60 * 1000; // 4 小时：命中
const MISS_CACHE_MS = 5 * 60 * 1000; // 5 分钟：真没搜到（风控导致的空不写）

/**
 * @param {ReturnType<import('./qqmusic.js').createQQMusic>} qq
 * @param {Array<{title:string, artist:string, reason?:string}>} picks
 * @returns {Promise<{playable: Array, failed: Array, authFailCount: number}>}
 *   authFailCount: 这批 picks 里有多少首触发了"疑似 cookie 过期"信号
 *                  （上层 server 会累计跨 block 的信号决定要不要 probe）
 */
export async function resolveAll(qq, picks) {
  const playable = [];
  const failed = [];
  let authFailCount = 0;

  for (const p of picks) {
    const item = await resolveOne(qq, p);
    if (item && !item._authFail) {
      playable.push(item);
    } else {
      failed.push({
        title: p.title,
        artist: p.artist,
        reason: item?._authFail ? 'auth-suspect' : 'no-url',
      });
      if (item?._authFail) authFailCount++;
    }
  }

  return { playable, failed, authFailCount };
}

async function resolveOne(qq, p) {
  const cacheKey = `${normKey(p.title)}|${normKey(p.artist)}`;

  // 先看正向缓存
  const cached = cacheGet('song_cache', cacheKey);
  if (cached && cached.url) {
    return { ...cached, reason: p.reason || cached.reason || '' };
  }

  // 再看负向缓存（最近搜过但失败的）
  const miss = cacheGet('song_cache_miss', cacheKey);
  if (miss) {
    console.log(`[resolver] skip "${p.title} - ${p.artist}" (负缓存命中)`);
    return null;
  }

  // 搜索关键词组合：第一个命中就停（节省请求）
  const queries = [`${p.title} ${p.artist}`, p.title];
  let sawRateLimit = false;
  for (const q of queries) {
    let hits;
    try {
      hits = await qq.search(q, 5);
    } catch (e) {
      console.warn(`[resolver] search throw "${q}":`, e.message);
      continue;
    }
    if (hits.rateLimited) {
      sawRateLimit = true;
      continue;
    }
    if (!hits.length) continue;

    const best =
      hits.find((h) => looseMatchArtist(h.artist, p.artist)) || hits[0];

    const { url, authFail } = await qq.getPlayUrl(best.songmid);
    if (!url) {
      console.warn(
        `[resolver] "${best.title} - ${best.artist}" songmid=${best.songmid} getPlayUrl 返回空${authFail ? '（认证失败 / cookie 过期）' : '（可能 VIP / 版权受限）'}`
      );
      // 认证失败不写负缓存：换 cookie 后这首能播的
      if (authFail) return { _authFail: true };
      continue;
    }

    const item = {
      title: best.title,
      artist: best.artist,
      reason: p.reason || '',
      songmid: best.songmid,
      url,
      duration: best.duration,
      album: best.album,
      cover: best.cover || '',
    };
    cacheSet('song_cache', cacheKey, item, CACHE_MS);
    return item;
  }

  // 只有在"确实搜不到且没被风控"时才写负缓存
  // 被风控就别写，否则偶发 2001 会让热门歌曲 5 分钟内都搜不了
  if (!sawRateLimit) {
    cacheSet('song_cache_miss', cacheKey, { ts: Date.now() }, MISS_CACHE_MS);
  } else {
    console.log(`[resolver] "${p.title} - ${p.artist}" 受风控影响空结果，不写负缓存`);
  }
  return null;
}

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

/**
 * 把大脑推荐的 [{title, artist, reason}] 翻译成可播放的 [{...meta, url}]
 *
 * 加 SQLite 缓存：相同 title|artist 4 小时内不重复请求
 * （注意：直链 vkey 通常 6-24 小时内有效，缓存 4 小时偏保守，确保重启后仍可播）
 */
import { cacheGet, cacheSet } from './db.js';

const CACHE_MS = 4 * 60 * 60 * 1000; // 4 小时

/**
 * @param {ReturnType<import('./qqmusic.js').createQQMusic>} qq
 * @param {Array<{title:string, artist:string, reason?:string}>} picks
 * @returns {Promise<{playable: Array, failed: Array}>}
 */
export async function resolveAll(qq, picks) {
  const playable = [];
  const failed = [];

  for (const p of picks) {
    const item = await resolveOne(qq, p);
    if (item) playable.push(item);
    else failed.push({ title: p.title, artist: p.artist, reason: 'no-url' });
  }
  return { playable, failed };
}

async function resolveOne(qq, p) {
  const cacheKey = `${normKey(p.title)}|${normKey(p.artist)}`;

  // 先看缓存
  const cached = cacheGet('song_cache', cacheKey);
  if (cached && cached.url) {
    return { ...cached, reason: p.reason || cached.reason || '' };
  }

  // 搜索关键词组合
  const queries = [`${p.title} ${p.artist}`, p.title];
  for (const q of queries) {
    let hits;
    try {
      hits = await qq.search(q, 5);
    } catch {
      continue;
    }
    if (!hits.length) continue;

    const best =
      hits.find((h) => looseMatchArtist(h.artist, p.artist)) || hits[0];

    const url = await qq.getPlayUrl(best.songmid);
    if (!url) continue;

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

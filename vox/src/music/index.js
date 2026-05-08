/**
 * 音乐源 provider 工厂
 * --------------------------------------------------
 * Vox 支持多个音乐源（目前 QQ 音乐；后续会加网易云），
 * 上层模块（server / resolver / bootstrap）只依赖统一接口，
 * 不感知具体 provider。
 *
 * 用法：
 *   import { createProvider } from './music/index.js';
 *   const music = createProvider('qq', { apiBase, userId });
 *   const hits = await music.search('晴天 周杰伦', 5);
 *   const { url, authFail } = await music.getPlayUrl(hits[0].songId);
 *
 * ================================================================
 * 通用接口契约（所有 provider 必须实现）
 * ================================================================
 *
 * @typedef {Object} MusicHit
 * @property {string} songId         源内唯一 ID（QQ=songmid, Netease=id）
 * @property {string} title
 * @property {string} artist
 * @property {string} [album]
 * @property {string} [cover]        封面 URL
 * @property {number} [duration]     秒
 *
 * @typedef {Array<MusicHit> & { rateLimited?: boolean }} MusicHits
 *
 * @typedef {Object} Playlist
 * @property {string|number} playlistId
 * @property {string} name
 * @property {string} [cover]
 * @property {number} songCount
 * @property {boolean} [isFavorite]  是否是用户"我喜欢"歌单（各源表现不同）
 *
 * @typedef {Object} PlaylistDetail
 * @property {string} name
 * @property {number} total
 * @property {Array<MusicHit>} songs
 *
 * @typedef {Object} MusicProvider
 * @property {'qq' | 'netease'} kind
 * @property {(keyword: string, n?: number) => Promise<MusicHits>} search
 * @property {(songId: string) => Promise<{url: string, authFail: boolean}>} getPlayUrl
 * @property {(userId?: string) => Promise<Array<Playlist>>} getMyPlaylists
 * @property {(playlistId: string|number) => Promise<PlaylistDetail>} getPlaylistSongs
 * @property {(cookieString: string) => Promise<{
 *     ok: boolean,
 *     error?: string,
 *     toWrite?: {fileName: string, content: string},
 *     userInfo?: {nickname?: string, userId?: string},
 *   }>} applyCookie
 * @property {() => Promise<'ok' | 'expired' | 'unknown'>} probeAuth
 * @property {{siteUrl: string, siteName: string, requiredFields: string[], extraNote?: string}} cookieInstructions
 *
 * 可选：扫码登录（目前只有 netease 实现；qq 不支持）
 * @property {() => Promise<{key: string, qrDataUrl: string}>} [startQrLogin]
 * @property {(key: string) => Promise<{status: 'waiting'|'scanned'|'confirmed'|'expired', cookie?: string, nickname?: string, userId?: string}>} [checkQrLogin]
 */

import { createQQProvider } from './qq.js';
import { createNeteaseProvider } from './netease.js';

/**
 * @param {'qq' | 'netease'} kind
 * @param {object} opts
 * @returns {import('./index.js').MusicProvider}
 */
export function createProvider(kind, opts = {}) {
  switch (kind) {
    case 'qq':
      return createQQProvider(opts);
    case 'netease':
      return createNeteaseProvider(opts);
    default:
      throw new Error(`未知的 music provider: ${kind}（支持: qq / netease）`);
  }
}

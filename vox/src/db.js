/**
 * SQLite 数据库 (better-sqlite3)
 * --------------------------------------------------
 * 同步 API、单例、启动时自动建表
 *
 * 表结构:
 *   play_history  -- 播放记录
 *   messages      -- 用户/DJ 对话
 *   song_cache    -- 搜歌+取直链结果缓存（4小时）
 *   weather_cache -- 天气结果缓存（30 分钟）
 *   kv_state      -- 简单键值（保留扩展用）
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let _db = null;

/**
 * 取数据库单例。第一次调用要传 dataDir，之后直接 getDB()
 * @param {string} [dataDir]  数据目录绝对路径
 * @returns {import('better-sqlite3').Database}
 */
export function getDB(dataDir) {
  if (_db) return _db;
  if (!dataDir) throw new Error('首次调用 getDB 必须传 dataDir');

  fs.mkdirSync(dataDir, { recursive: true });

  // 数据库文件名：新安装用 vox.db；如果存在历史的 claudio.db，优先沿用它（兼容老用户）
  const voxFile = path.join(dataDir, 'vox.db');
  const legacyFile = path.join(dataDir, 'claudio.db');
  const file = fs.existsSync(legacyFile) && !fs.existsSync(voxFile) ? legacyFile : voxFile;

  _db = new Database(file);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- 播放历史 ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS play_history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL,                -- ISO8601
      title     TEXT NOT NULL,
      artist    TEXT NOT NULL,
      played    INTEGER NOT NULL DEFAULT 0,    -- 0=跳过, 1=听完
      reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_play_ts ON play_history(ts DESC);

    -- 对话消息 ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS messages (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts    TEXT NOT NULL,
      role  TEXT NOT NULL,                  -- 'user' / 'dj'
      text  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts DESC);

    -- 歌曲缓存 (4 小时) ------------------------------------------------------
    -- key 格式: 'search:title|artist'   值: JSON {songmid, url, cover, ...}
    CREATE TABLE IF NOT EXISTS song_cache (
      key         TEXT PRIMARY KEY,
      value_json  TEXT NOT NULL,
      expires_at  INTEGER NOT NULL          -- unix ms
    );
    CREATE INDEX IF NOT EXISTS idx_song_exp ON song_cache(expires_at);

    -- 天气缓存 (30 分钟) -----------------------------------------------------
    CREATE TABLE IF NOT EXISTS weather_cache (
      location    TEXT PRIMARY KEY,
      value_json  TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    -- 键值表 (扩展用) --------------------------------------------------------
    CREATE TABLE IF NOT EXISTS kv_state (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

// ----------------------------- 通用 helper ---------------------------------

/** 取 / 设 KV */
export function kvGet(key) {
  const row = getDB().prepare('SELECT v FROM kv_state WHERE k = ?').get(key);
  return row ? row.v : null;
}
export function kvSet(key, val) {
  getDB().prepare(
    'INSERT INTO kv_state (k, v, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at'
  ).run(key, String(val), new Date().toISOString());
}

/** 缓存 helper */
export function cacheGet(table, key) {
  const col = table === 'weather_cache' ? 'location' : 'key';
  const row = getDB()
    .prepare(`SELECT value_json, expires_at FROM ${table} WHERE ${col} = ?`)
    .get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}
export function cacheSet(table, key, value, ttlMs) {
  const col = table === 'weather_cache' ? 'location' : 'key';
  const expires = Date.now() + ttlMs;
  const json = JSON.stringify(value);
  getDB()
    .prepare(
      `INSERT INTO ${table} (${col}, value_json, expires_at) VALUES (?, ?, ?) ` +
      `ON CONFLICT(${col}) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at`
    )
    .run(key, json, expires);
}

/** 定期清理过期缓存（启动时调用一次即可） */
export function purgeExpiredCache() {
  const now = Date.now();
  const db = getDB();
  db.prepare('DELETE FROM song_cache WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM weather_cache WHERE expires_at < ?').run(now);
}

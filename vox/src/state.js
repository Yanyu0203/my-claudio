/**
 * 状态/记忆管理（SQLite + markdown 文件）
 * --------------------------------------------------
 * 数据存储分两类：
 *   - SQLite (vox.db，老安装保留 claudio.db 兼容)
 *       play_history  最近播放
 *       messages      对话记录
 *   - Markdown 文件
 *       taste.md         画像（给大脑读）
 *       taste-deltas.md  追加日志（给大脑读，方便人手改）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDB } from './db.js';

const HIST_RETURN_DEFAULT = 20;
const MSG_RETURN_DEFAULT = 6;

export class Store {
  /**
   * @param {string} dataDir 数据目录绝对路径
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.deltaPath = path.join(dataDir, 'taste-deltas.md');
    this.tastePath = path.join(dataDir, 'taste.md');
    this.db = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = getDB(this.dataDir);
  }

  // ---------- 播放历史 ----------
  recordPlay({ title, artist, played, reason }) {
    if (!title || !artist) return;
    this.db
      .prepare(
        'INSERT INTO play_history (ts, title, artist, played, reason) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        new Date().toISOString(),
        String(title),
        String(artist),
        played ? 1 : 0,
        reason ? String(reason) : null
      );
  }

  /** 最近 N 条播放记录（按时间倒序取再正序返回），供大脑 prompt 用 */
  recentPlays(n = HIST_RETURN_DEFAULT) {
    const rows = this.db
      .prepare(
        'SELECT id, ts, title, artist, played, reason, rating FROM play_history ORDER BY id DESC LIMIT ?'
      )
      .all(n);
    return rows.reverse().map((r) => ({
      id: r.id,
      ts: r.ts,
      title: r.title,
      artist: r.artist,
      played: !!r.played,
      reason: r.reason || '',
      rating: r.rating || null,
    }));
  }

  /** 给 UI 历史列表用：倒序返回最近 N 首，默认 50 */
  historyForDisplay(n = 50) {
    const rows = this.db
      .prepare(
        'SELECT id, ts, title, artist, played, reason, rating FROM play_history ORDER BY id DESC LIMIT ?'
      )
      .all(n);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      title: r.title,
      artist: r.artist,
      played: !!r.played,
      reason: r.reason || '',
      rating: r.rating || null,
    }));
  }

  /**
   * 用户对某条历史记录打分
   * @param {number} id            play_history 表的 id
   * @param {'like'|'dislike'|null} rating
   * @returns {{title, artist, rating, prev} | null}
   */
  rateSong(id, rating) {
    if (!Number.isInteger(id)) return null;
    if (rating !== 'like' && rating !== 'dislike' && rating !== null) return null;
    const row = this.db
      .prepare('SELECT title, artist, rating FROM play_history WHERE id = ?')
      .get(id);
    if (!row) return null;
    this.db.prepare('UPDATE play_history SET rating = ? WHERE id = ?').run(rating, id);
    return {
      title: row.title,
      artist: row.artist,
      rating,
      prev: row.rating || null,
    };
  }

  /**
   * 按 title+artist 给"当前这首"打分
   * 找最近一条匹配的行：有就 UPDATE；没有就 INSERT 一条占位行
   * （还没到 played 事件时，正在播的这首可能还不在表里）
   * @returns {{title, artist, rating, prev} | null}
   */
  rateByTitleArtist(title, artist, rating) {
    if (!title || !artist) return null;
    if (rating !== 'like' && rating !== 'dislike' && rating !== null) return null;

    // 找最近一条：title+artist 完全匹配
    const row = this.db
      .prepare(
        'SELECT id, rating FROM play_history WHERE title = ? AND artist = ? ORDER BY id DESC LIMIT 1'
      )
      .get(String(title), String(artist));

    if (row) {
      this.db.prepare('UPDATE play_history SET rating = ? WHERE id = ?').run(rating, row.id);
      return { title, artist, rating, prev: row.rating || null };
    }

    // 没找到 → 预先插一条占位（played=0，等真"listened through"时那条 played 事件会再 INSERT 一条，就留两条，但评分在这里）
    this.db
      .prepare(
        'INSERT INTO play_history (ts, title, artist, played, reason, rating) VALUES (?, ?, ?, 0, NULL, ?)'
      )
      .run(new Date().toISOString(), String(title), String(artist), rating);
    return { title, artist, rating, prev: null };
  }

  /** 历史总条数 */
  countPlays() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM play_history').get().n;
  }

  // ---------- 对话消息 ----------
  recordMessage({ role, text }) {
    if (!role || !text) return;
    this.db
      .prepare('INSERT INTO messages (ts, role, text) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), String(role), String(text));
  }

  recentMessages(n = MSG_RETURN_DEFAULT) {
    const rows = this.db
      .prepare('SELECT ts, role, text FROM messages ORDER BY id DESC LIMIT ?')
      .all(n);
    return rows.reverse();
  }

  countMessages() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  }

  /** 清空所有对话消息 */
  clearMessages() {
    const before = this.countMessages();
    this.db.prepare('DELETE FROM messages').run();
    return before;
  }

  // ---------- 画像 (markdown) ----------
  async appendTasteDelta(text, source = 'chat') {
    if (!text || !text.trim()) return;
    const block =
      `\n## ${new Date().toISOString()} (${source})\n- ${text.trim()}\n`;
    await fs.appendFile(this.deltaPath, block, 'utf8');
  }

  async readTaste() {
    return safeReadFile(this.tastePath, '');
  }

  async readTasteDeltas(limitChars = 2000) {
    const all = await safeReadFile(this.deltaPath, '');
    if (all.length <= limitChars) return all;
    return all.slice(-limitChars);
  }
}

async function safeReadFile(p, fallback) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return fallback;
  }
}

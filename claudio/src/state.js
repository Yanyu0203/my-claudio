/**
 * 状态/记忆管理（SQLite + markdown 文件）
 * --------------------------------------------------
 * 数据存储分两类：
 *   - SQLite (claudio.db)
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

  /** 最近 N 条播放记录（按时间倒序取再正序返回） */
  recentPlays(n = HIST_RETURN_DEFAULT) {
    const rows = this.db
      .prepare(
        'SELECT ts, title, artist, played, reason FROM play_history ORDER BY id DESC LIMIT ?'
      )
      .all(n);
    return rows.reverse().map((r) => ({
      ts: r.ts,
      title: r.title,
      artist: r.artist,
      played: !!r.played,
      reason: r.reason || '',
    }));
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

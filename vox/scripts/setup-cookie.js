/**
 * 把 data/qq_cookie.json 里的 cookie 喂给 QQMusicApi
 *
 * 用法:
 *   npm run setup:cookie
 *
 * 前置:
 *   1. QQMusicApi 已启动 (http://127.0.0.1:3300)
 *   2. data/qq_cookie.json 存在，格式 { "data": "完整 cookie 串" }
 *
 *   data/qq_cookie.json 怎么生成？看 SETUP.md「步骤 3」
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DATA_DIR = process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR
  ? path.resolve(process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR)
  : path.resolve(projectRoot, '..', 'data');

const COOKIE_FILE = path.join(DATA_DIR, 'qq_cookie.json');
const API = process.env.QQMUSIC_API_URL || 'http://127.0.0.1:3300';

async function main() {
  // 1. 验 QQMusicApi 是否在线
  try {
    const r = await fetch(API + '/');
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.error(`❌ QQMusicApi 没在跑 (${API})`);
    console.error(`   先启动它: cd ../QQMusicApi && QQ=你的QQ号 yarn start`);
    process.exit(1);
  }

  // 2. 读 cookie 文件
  let payload;
  try {
    const raw = await fs.readFile(COOKIE_FILE, 'utf8');
    payload = JSON.parse(raw);
    if (!payload.data || typeof payload.data !== 'string') {
      throw new Error('缺 "data" 字段');
    }
  } catch (e) {
    console.error(`❌ 读取 cookie 文件失败: ${COOKIE_FILE}`);
    console.error(`   ${e.message}`);
    console.error(`\n请按 SETUP.md「步骤 3」从浏览器复制 cookie，然后保存为:`);
    console.error(`   ${COOKIE_FILE}`);
    console.error(`   格式: { "data": "完整 cookie 串" }`);
    process.exit(1);
  }

  // 3. POST 给 QQMusicApi
  try {
    const res = await fetch(API + '/user/setCookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (json.result === 100) {
      console.log('✅ cookie 设置成功');
    } else {
      console.error('❌ setCookie 失败:', json);
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ 请求失败:', e.message);
    process.exit(1);
  }
}

main();

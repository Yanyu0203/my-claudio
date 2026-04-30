/**
 * Claudio 主入口
 * --------------------------------------------------
 *  - HTTP: 静态托管 pwa/
 *  - WS  : 双向实时（block 推送 / 用户控制 / 聊天）
 */
import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { createQQMusic } from './src/qqmusic.js';
import { Store } from './src/state.js';
import { getDB, purgeExpiredCache } from './src/db.js';
import { getWeather } from './src/weather.js';
import { planNextBlock } from './src/bridge.js';
import { resolveAll } from './src/resolver.js';
import { classifyMessage, quickReply } from './src/chat.js';
import { resolveBrainBin, getBrainFlavor } from './src/brain.js';
import { promptAndWriteQQUin } from './scripts/setup-qquin.js';
import { isPlaceholderUin } from './scripts/_lib/env-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- 配置 ----------
const PORT = Number(process.env.PORT || 8080);
const SONGS_PER_BLOCK = Number(process.env.SONGS_PER_BLOCK || 5);

// 数据目录：默认 ../data（与 claudio 同级），可通过 CLAUDIO_DATA_DIR 覆盖
const DATA_DIR = process.env.CLAUDIO_DATA_DIR
  ? path.resolve(process.env.CLAUDIO_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

// ---------- 启动前置检查 ----------
// 1. QQ_UIN 没填？交互式问一下
if (isPlaceholderUin(process.env.QQ_UIN)) {
  console.log('');
  console.log('⚠️  QQ_UIN 还没设置，先来填一下');
  await promptAndWriteQQUin();
  if (isPlaceholderUin(process.env.QQ_UIN)) {
    console.error('❌ QQ_UIN 仍然未填，无法启动 Claudio');
    console.error('   请手动跑：npm run setup:qquin');
    process.exit(1);
  }
}

// ---------- 初始化各模块 ----------
const qq = createQQMusic({
  apiBase: process.env.QQMUSIC_API_URL || 'http://127.0.0.1:3300',
  uin: process.env.QQ_UIN,
});

// 初始化 DB（单例），并清理过期缓存
getDB(DATA_DIR);
purgeExpiredCache();

const store = new Store(DATA_DIR);
await store.init();

// ---------- HTTP ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'pwa')));

// 简单调试接口
app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    historyCount: store.countPlays(),
    messageCount: store.countMessages(),
  });
});

const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  const sender = makeSender(ws);

  // 一连上自动推送一段
  generateAndSend(sender).catch((e) => {
    console.error('[ws] initial generate fail', e);
    sender.send('error', { message: e.message });
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    handleClientMessage(msg, sender).catch((e) => {
      console.error('[ws] handle fail', e);
      sender.send('error', { message: e.message });
    });
  });

  ws.on('close', () => console.log('[ws] client disconnected'));
});

function makeSender(ws) {
  return {
    send(type, data) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type, data }));
    },
  };
}

// ---------- 核心：生成 + 推送一段 ----------
let inFlight = false; // 防止并发生成
/**
 * @param {*} sender
 * @param {string} userIntent  用户额外要求
 * @param {boolean} replace    true=客户端应立即替换当前队列；false=可作为 prefetch
 */
async function generateAndSend(sender, userIntent = '', replace = false) {
  if (inFlight) {
    sender.send('dj_say', { text: '上一段还在编，稍等～' });
    return;
  }
  inFlight = true;
  sender.send('status', { stage: 'thinking' });

  try {
    const taste = await store.readTaste();
    const tasteDeltas = await store.readTasteDeltas();
    const weather = await getWeather();

    const plan = await planNextBlock({
      taste,
      tasteDeltas,
      recentPlays: store.recentPlays(),
      recentMessages: store.recentMessages(),
      weather,
      userIntent,
      songsPerBlock: SONGS_PER_BLOCK,
    });

    if (plan.taste_delta) {
      await store.appendTasteDelta(plan.taste_delta, 'dj');
    }

    sender.send('status', { stage: 'resolving' });
    const { playable, failed } = await resolveAll(qq, plan.play);

    if (!playable.length) {
      sender.send('error', {
        message: '大脑选了几首，但 QQ 音乐都拿不到 ☹️',
        failed,
      });
      return;
    }

    // DJ 说话也写进消息历史
    store.recordMessage({ role: 'dj', text: plan.say });

    sender.send('block', {
      say: plan.say,
      songs: playable,
      failed,
      replace,                              // ⭐ 客户端用这个判断是否立即替换
      weather: weather
        ? { text: weather.text, temp: weather.temp, theme: weather.theme }
        : null,
    });
  } finally {
    inFlight = false;
  }
}

// ---------- 处理用户消息 ----------
async function handleClientMessage(msg, sender) {
  const { type, data } = msg || {};
  switch (type) {
    case 'start': {
      // 兜底入口：客户端主动求一段
      await generateAndSend(sender);
      break;
    }

    case 'played': {
      // 自然听完
      store.recordPlay({
        title: data?.title,
        artist: data?.artist,
        played: true,
      });
      break;
    }

    case 'next':
    case 'skip': {
      // 跳过当前歌（仅记录历史；前端自己负责立即下一首）
      store.recordPlay({
        title: data?.title,
        artist: data?.artist,
        played: false,
      });
      break;
    }

    case 'request_block': {
      // 队列见底，请求下一段
      await generateAndSend(sender);
      break;
    }

    case 'chat': {
      const text = String(data?.text || '').trim();
      if (!text) break;

      store.recordMessage({ role: 'user', text });

      const cls = classifyMessage(text);
      const quick = quickReply(text, cls.intent);
      if (quick) {
        store.recordMessage({ role: 'dj', text: quick });
        sender.send('dj_say', { text: quick });
      }

      if (cls.intent === 'regenerate') {
        // 立即重新生成一段（要替换当前队列）
        await generateAndSend(sender, cls.regenerateHint, true);
      } else if (cls.intent === 'chat') {
        // 普通聊天：触发一段新的，让大脑用 say 字段自然回应
        await generateAndSend(sender, text, true);
      }
      // skip / like 不重生成，等当前队列播完
      break;
    }

    default:
      console.warn('[ws] unknown message type', type);
  }
}

// ---------- 启动 ----------
server.listen(PORT, () => {
  const brainBin = resolveBrainBin();
  const brainFlavor = getBrainFlavor();
  const brainConfigured = !!process.env.BRAIN_BIN;

  console.log(`🎧 Claudio is running at http://localhost:${PORT}`);
  console.log(`   Data dir : ${DATA_DIR}`);
  console.log(`   QQ API   : ${process.env.QQMUSIC_API_URL || 'http://127.0.0.1:3300'}`);
  console.log(`   Weather  : ${process.env.ENABLE_WEATHER === 'true' ? 'on' : 'off'}`);
  console.log(`   Brain    : ${brainBin} (${brainFlavor})${brainConfigured ? '' : ' [默认值，未通过 setup:brain 选择]'}`);
  console.log(`   PWA      : http://localhost:${PORT}`);
  console.log(`   WS       : ws://localhost:${PORT}/stream`);

  if (!brainConfigured) {
    console.log('');
    console.log('💡 提示：还没正式选过大脑。可以跑：');
    console.log('     npm run setup:brain');
    console.log('   选 codebuddy / claude / claude-internal');
    console.log('');
  }
});

/**
 * Vox 主入口
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
import { classifyMessage, chatReply } from './src/chat.js';
import { resolveBrainBin, getBrainFlavor } from './src/brain.js';
import { promptAndWriteQQUin } from './scripts/setup-qquin.js';
import { isPlaceholderUin } from './scripts/_lib/env-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- 配置 ----------
const PORT = Number(process.env.PORT || 8080);
const SONGS_PER_BLOCK = Number(process.env.SONGS_PER_BLOCK || 5);

// 数据目录：默认 ../data（与 vox 同级），可通过 VOX_DATA_DIR 覆盖
// （CLAUDIO_DATA_DIR 作为历史名保留兼容）
const DATA_DIR = process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR
  ? path.resolve(process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

// ---------- 启动前置检查 ----------
// 1. QQ_UIN 没填？交互式问一下
if (isPlaceholderUin(process.env.QQ_UIN)) {
  console.log('');
  console.log('⚠️  QQ_UIN 还没设置，先来填一下');
  await promptAndWriteQQUin();
  if (isPlaceholderUin(process.env.QQ_UIN)) {
    console.error('❌ QQ_UIN 仍然未填，无法启动 Vox');
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

// 对话历史（供前端刷新后恢复聊天记录）
app.get('/api/messages', (_, res) => {
  // 取更多一点，够填满 chatLog
  const rows = store.recentMessages(40);
  res.json({ messages: rows });
});

const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/stream' });

// ============================================================
// 电台会话状态（server 端持有的"真电台")
// ============================================================
// 刷新页面 / 换设备不会打断播放 —— 页面连上来后会先收到 hello 恢复 UI。
// server 进程重启才会清掉（这是合理的边界：进程没了确实没电台了）。
const session = {
  currentBlock: null,   // 当前正在播的那一段 {say, songs[], weather, startedAt}
  currentIdx: 0,        // 当前段播到第几首（0-based）
  currentPos: 0,        // 当前歌播放位置（秒，用于刷新恢复进度）
  currentPosUpdatedAt: 0, // 上面那个值是啥时候上报的 ms 时间戳
  nextBlock: null,      // 已经预拉好的下一段
  lastDjSay: '',        // 最近一次 DJ 字幕（刷新后也能看到）
  weather: null,        // 最近一次天气（用于主题）
  pausedAt: 0,          // 上次暂停的时间戳（0 = 未暂停）
};

// 长暂停阈值：回来播放 & 暂停时长 ≥ 此值 → 触发静默重排下一段
const LONG_PAUSE_MS = Number(process.env.LONG_PAUSE_MS || 10 * 60_000); // 默认 10 分钟

// 广播 sender：永远推给"当前所有活着的连接"
// 这样即使生成期间客户端重连（例如热重载、网络抖动），新连接也能收到结果
const broadcaster = {
  send(type, data) {
    const payload = JSON.stringify({ type, data });
    let n = 0;
    wss.clients.forEach((c) => {
      if (c.readyState === c.OPEN) {
        c.send(payload);
        n++;
      }
    });
    if (type === 'block' || type === 'error') {
      console.log(`[ws →] ${type} 广播到 ${n} 个连接`);
    }
  },
};

// 给"单个连接"用的 sender（用于 hello 这种只发给刚连上那一方的消息）
function singleSender(ws) {
  return {
    send(type, data) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, data }));
      }
    },
  };
}

wss.on('connection', (ws) => {
  console.log(`[ws] client connected (total=${wss.clients.size})`);
  const solo = singleSender(ws);

  // 如果已经有会话在跑 —— 恢复它（不打断播放）
  if (session.currentBlock) {
    // 推算当前歌的估算播放位置
    const elapsed = session.currentPosUpdatedAt
      ? (Date.now() - session.currentPosUpdatedAt) / 1000
      : 0;
    const estimatedPos = session.currentPos + elapsed;
    console.log(
      `[ws] 恢复会话: block=${session.currentBlock.songs.length}首, 当前第${session.currentIdx + 1}首, 位置~${estimatedPos.toFixed(0)}s, 有预拉=${!!session.nextBlock}`
    );
    solo.send('hello', {
      resume: true,
      currentBlock: session.currentBlock,
      currentIdx: session.currentIdx,
      currentPos: estimatedPos,
      hasNextBlock: !!session.nextBlock,
      lastDjSay: session.lastDjSay,
      weather: session.weather,
    });
  } else if (inFlight) {
    // 没 block 但正在编 —— 告诉前端"稍等，马上来"
    console.log('[ws] 没 session 但正在编，告诉前端等待');
    solo.send('hello', { resume: false, generating: true });
    // 不用再触发生成，等正在跑的那一次结束广播
  } else {
    // 真·冷启动：从没放过歌。才触发首段生成。
    console.log('[ws] 冷启动，生成第一段');
    solo.send('hello', { resume: false, generating: true });
    generateAndSend(broadcaster).catch((e) => {
      console.error('[ws] initial generate fail', e);
      broadcaster.send('error', { message: e.message });
    });
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    handleClientMessage(msg, broadcaster).catch((e) => {
      console.error('[ws] handle fail', e);
      broadcaster.send('error', { message: e.message });
    });
  });

  ws.on('close', () =>
    console.log(`[ws] client disconnected (remain=${wss.clients.size})`)
  );
});

// ---------- 核心：生成 + 推送一段 ----------
let inFlight = false; // 防止并发生成
let blockSeq = 0;
/**
 * @param {*} sender
 * @param {string} userIntent  用户额外要求
 * @param {boolean} replace    true=客户端应立即替换当前队列；false=可作为 prefetch
 */
async function generateAndSend(sender, userIntent = '', replace = false) {
  if (inFlight) {
    console.log('[block] 拒绝: 上一段还在编');
    sender.send('dj_say', { text: '上一段还在编，稍等～' });
    return;
  }
  inFlight = true;
  const seq = ++blockSeq;
  const t0 = Date.now();
  // silent = 后台静默生成（prefetch / 用户口味更新触发的下一段）
  // 不 silent = 用户看得见的等待（首次启动 / replace / 队列耗尽时的请求）
  // 判断口径：replace=true 一定不 silent；replace=false 时，看 server 是否还有当前段可播
  const silent = !replace && !!session.currentBlock;
  console.log(
    `\n━━━ [block #${seq}] 开始${replace ? ' (REPLACE)' : ''}${silent ? ' (SILENT)' : ''}${userIntent ? ` intent="${userIntent.slice(0, 30)}"` : ''} ━━━`
  );
  sender.send('status', { stage: 'thinking', silent });

  try {
    const taste = await store.readTaste();
    const tasteDeltas = await store.readTasteDeltas();
    const weather = await getWeather();
    console.log(
      `[block #${seq}] 上下文: taste=${taste.length}字, deltas=${tasteDeltas.length}字, weather=${weather?.text || 'off'}, 历史${store.recentPlays().length}首, 对话${store.recentMessages().length}条`
    );

    const tBrain = Date.now();
    const plan = await planNextBlock({
      taste,
      tasteDeltas,
      recentPlays: store.recentPlays(),
      recentMessages: store.recentMessages(),
      weather,
      userIntent,
      songsPerBlock: SONGS_PER_BLOCK,
    });
    console.log(
      `[block #${seq}] 大脑回复 (${((Date.now() - tBrain) / 1000).toFixed(1)}s): say="${plan.say.slice(0, 40)}...", ${plan.play.length} 首`
    );
    plan.play.forEach((s, i) =>
      console.log(`  #${i + 1} ${s.title} - ${s.artist}  // ${s.reason}`)
    );

    if (plan.taste_delta) {
      console.log(`[block #${seq}] 写入 taste-delta: ${plan.taste_delta}`);
      await store.appendTasteDelta(plan.taste_delta, 'dj');
    }

    sender.send('status', { stage: 'resolving', silent });
    const tResolve = Date.now();
    const { playable, failed } = await resolveAll(qq, plan.play);
    console.log(
      `[block #${seq}] resolve 完成 (${((Date.now() - tResolve) / 1000).toFixed(1)}s): 可播 ${playable.length}/${plan.play.length}${failed.length ? ', 失败: ' + failed.map((f) => f.title).join(', ') : ''}`
    );

    if (!playable.length) {
      const failedList = failed
        .map((f) => `${f.title} - ${f.artist}`)
        .slice(0, 5)
        .join(' / ');
      console.warn(`[block #${seq}] ❌ 全部失败，退出`);
      sender.send('error', {
        message:
          `大脑选了 ${plan.play.length} 首，QQ 音乐都没找到 ☹️\n` +
          `候选: ${failedList}\n` +
          `可能：搜歌被风控（稍等 30 秒重试），或大脑推荐了非常冷门的歌`,
        failed,
      });
      return;
    }

    store.recordMessage({ role: 'dj', text: plan.say });

    const blockPayload = {
      say: plan.say,
      songs: playable,
      failed,
      replace,
      weather: weather
        ? { text: weather.text, temp: weather.temp, theme: weather.theme }
        : null,
    };

    // 更新 server 会话状态
    session.lastDjSay = plan.say;
    session.weather = blockPayload.weather;
    if (replace || !session.currentBlock) {
      // 立即替换 or 首次：直接成为当前段
      session.currentBlock = blockPayload;
      session.currentIdx = 0;
      session.currentPos = 0;
      session.currentPosUpdatedAt = Date.now();
      session.nextBlock = null;
    } else {
      // prefetch：作为下一段候选，当前段继续播
      session.nextBlock = blockPayload;
    }

    console.log(
      `[block #${seq}] ✅ 推送 (总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s, replace=${replace})`
    );
    sender.send('block', blockPayload);
  } catch (e) {
    console.error(`[block #${seq}] ❌ 异常`, e);
    sender.send('error', { message: e.message });
  } finally {
    inFlight = false;
  }
}

// ---------- 处理用户消息 ----------
async function handleClientMessage(msg, sender) {
  const { type, data } = msg || {};
  // pos_update 非常频繁，不打印
  if (type !== 'pos_update') {
    console.log(`[ws ←] ${type}`, data ? JSON.stringify(data).slice(0, 100) : '');
  }
  switch (type) {
    case 'start': {
      // 兜底入口：客户端主动求一段
      await generateAndSend(sender);
      break;
    }

    case 'pos_update': {
      // 前端每隔几秒报一次当前歌播放位置，用于刷新恢复
      if (typeof data?.pos === 'number') {
        session.currentPos = data.pos;
        session.currentPosUpdatedAt = Date.now();
      }
      break;
    }

    case 'song_advance': {
      // 前端切到下一首了（自然听完 or 跳过）
      if (typeof data?.idx === 'number') {
        session.currentIdx = data.idx;
        session.currentPos = 0;
        session.currentPosUpdatedAt = Date.now();
      }
      break;
    }

    case 'block_consumed': {
      // 前端用掉了 nextBlock（当前段播完自动接上）
      if (session.nextBlock) {
        session.currentBlock = session.nextBlock;
        session.nextBlock = null;
        session.currentIdx = 0;
        session.currentPos = 0;
        session.currentPosUpdatedAt = Date.now();
        session.lastDjSay = session.currentBlock.say || session.lastDjSay;
        session.weather = session.currentBlock.weather || session.weather;
        console.log('[session] 用掉 nextBlock 转为当前段');
      }
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

    case 'pause': {
      // 用户按了暂停。记下时间点（长暂停检测用）
      session.pausedAt = Date.now();
      console.log('[pause] user paused');
      break;
    }

    case 'resume': {
      // 用户恢复播放。如果离开的时间够长，就静默重排一段
      const pausedMs = session.pausedAt ? Date.now() - session.pausedAt : 0;
      session.pausedAt = 0;
      console.log(`[resume] user resumed, paused for ${Math.round(pausedMs / 1000)}s`);
      if (pausedMs >= LONG_PAUSE_MS) {
        // 丢掉之前 prefetch 的 nextBlock（过时了：时间/天气/心情都变了）
        if (session.nextBlock) {
          console.log('[resume] 长暂停，丢掉陈旧的 nextBlock，重新静默生成');
          session.nextBlock = null;
        }
        // 静默生成（replace=false，不打断当前这首）
        if (!inFlight) {
          generateAndSend(sender, '用户刚回来，更新后续歌单以契合当前时间和天气', false).catch(
            (e) => console.error('[resume] regen fail', e)
          );
        }
      }
      break;
    }

    case 'chat': {
      const text = String(data?.text || '').trim();
      if (!text) break;

      store.recordMessage({ role: 'user', text });

      const cls = classifyMessage(text);

      // 硬信号：明确要跳当前歌
      if (cls.intent === 'skip') {
        sender.send('dj_say', { text: '好，下一首。' });
        sender.send('control', { action: 'skip' });
        break;
      }

      // 其它一律走 chatReply：让 DJ 流式回话（气泡里的字一个个冒出来）
      console.log(`[chat] 用户说: "${text.slice(0, 40)}", 流式调大脑...`);
      const tChat = Date.now();
      const replyId = 'r-' + Date.now().toString(36);
      // 通知前端开一个新气泡
      sender.send('reply_start', { id: replyId });
      let streamedChars = 0;
      let r;
      try {
        r = await chatReply({
          userText: text,
          nowPlaying: data?.nowPlaying || null,
          upNext: Array.isArray(data?.upNext) ? data.upNext : [],
          taste: await store.readTaste(),
          tasteDeltas: await store.readTasteDeltas(),
          recentMessages: store.recentMessages(),
          weather: await getWeather(),
          onReplyDelta: (delta) => {
            streamedChars += delta.length;
            sender.send('reply_delta', { id: replyId, text: delta });
          },
        });
      } catch (e) {
        console.error('[chat] 大脑回话失败', e);
        sender.send('reply_end', {
          id: replyId,
          final: '（大脑短路了一下，再说一遍？）',
          error: true,
        });
        break;
      }
      console.log(
        `[chat] DJ 回 (${((Date.now() - tChat) / 1000).toFixed(1)}s, stream ${streamedChars} 字): "${r.reply.slice(0, 50)}", regen=${r.should_regen}, replace=${r.replace_now}, delta="${r.taste_delta}"`
      );

      // 1. 流式结束：让前端用 final 文本对齐（防流式漏字）
      store.recordMessage({ role: 'dj', text: r.reply });
      sender.send('reply_end', { id: replyId, final: r.reply });

      // 2. 偏好抽到 taste-delta（即使不换歌也记下）
      if (r.taste_delta) {
        await store.appendTasteDelta(r.taste_delta, 'chat');
        console.log(`[chat] taste-delta 写入: ${r.taste_delta}`);
      }

      // 3. 是否需要重排下一段
      if (r.should_regen) {
        if (r.replace_now) {
          console.log('[chat] → 用户明确要立刻换，replace 生成');
          await generateAndSend(sender, r.regen_hint, true);
        } else {
          console.log('[chat] → 静默生成下一段，当前歌不打断');
          await generateAndSend(sender, r.regen_hint, false);
        }
      }
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

  console.log(`🎧 Vox is running at http://localhost:${PORT}`);
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

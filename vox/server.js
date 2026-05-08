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

import { createProvider } from './src/music/index.js';
import { Store } from './src/state.js';
import { getDB, purgeExpiredCache } from './src/db.js';
import { getWeather } from './src/weather.js';
import { planNextBlock } from './src/bridge.js';
import { searchAll, fetchUrlFor, prefetchUrls } from './src/resolver.js';
import { classifyMessage, chatReply } from './src/chat.js';
import { resolveBrainBin, getBrainFlavor } from './src/brain.js';
import { bootstrapTaste } from './src/bootstrap.js';
import { promptAndWriteQQUin } from './scripts/setup-qquin.js';
import { isPlaceholderUin, upsertEnv } from './scripts/_lib/env-helper.js';
import {
  isAuthRequired,
  getAuthReason,
  onAuthChange,
  updateCookie,
  probeCookieAlive,
  markAuthRequired,
  resetAuthFailSignals,
} from './src/musicauth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- 配置 ----------
const PORT = Number(process.env.PORT || 8080);
const SONGS_PER_BLOCK = Number(process.env.SONGS_PER_BLOCK || 10);
// 拿到 block 后立即预热前 N 首的 mp3 直链（保证点 PLAY 就能响）
// 其余歌等播到时再拉（懒加载），避免一次性 getPlayUrl 10 次 + 直链更新鲜
const PREFETCH_URLS = Number(process.env.PREFETCH_URLS || 2);
// 用户正在播第 k 首时，主动去把第 (k+PREFETCH_AHEAD) 首的 url 拉好
const PREFETCH_AHEAD = Number(process.env.PREFETCH_AHEAD || 2);

// 数据目录：默认 ../data（与 vox 同级），可通过 VOX_DATA_DIR 覆盖
// （CLAUDIO_DATA_DIR 作为历史名保留兼容）
const DATA_DIR = process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR
  ? path.resolve(process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

// ---------- 选择音乐源 ----------
// 一般情况下走 start.sh / start.ps1，那里首次启动会让用户选并写进 .env
// 直接 `node server.js` 且没设 MUSIC_PROVIDER 时 → 默认 qq（兼容老行为）
const MUSIC_PROVIDER = (process.env.MUSIC_PROVIDER || 'qq').toLowerCase();
if (MUSIC_PROVIDER !== 'qq' && MUSIC_PROVIDER !== 'netease') {
  console.error(`❌ 不支持的 MUSIC_PROVIDER="${MUSIC_PROVIDER}"，支持: qq / netease`);
  console.error(`   想切换？跑：cd vox && npm run setup:provider`);
  process.exit(1);
}

// ---------- 启动前置检查 ----------
// QQ 源需要 QQ_UIN；Netease 源需要 NETEASE_UID
if (MUSIC_PROVIDER === 'qq' && isPlaceholderUin(process.env.QQ_UIN)) {
  console.log('');
  console.log('⚠️  QQ_UIN 还没设置，先来填一下');
  await promptAndWriteQQUin();
  if (isPlaceholderUin(process.env.QQ_UIN)) {
    console.error('❌ QQ_UIN 仍然未填，无法启动 Vox');
    console.error('   请手动跑：npm run setup:qquin');
    process.exit(1);
  }
}
if (MUSIC_PROVIDER === 'netease' && !process.env.NETEASE_UID) {
  console.warn('⚠️  没设 NETEASE_UID，拉歌单功能会不可用（但仍可搜歌/听歌）');
  console.warn('   登录网易云后在浏览器打开 https://music.163.com，URL 里能看到 uid');
  console.warn('   填到 vox/.env：NETEASE_UID=你的uid');
}

// ---------- 初始化音乐 provider ----------
/** @type {import('./src/music/index.js').MusicProvider} */
let music;
if (MUSIC_PROVIDER === 'qq') {
  music = createProvider('qq', {
    apiBase: process.env.QQMUSIC_API_URL || 'http://127.0.0.1:3300',
    userId: process.env.QQ_UIN,
  });
} else {
  music = createProvider('netease', {
    userId: process.env.NETEASE_UID || '',
    cookieFile: path.resolve(
      __dirname,
      '..',
      'data',
      'netease_cookie.txt'
    ),
  });
}
console.log(`[music] provider = ${music.kind}`);

/**
 * 启动时探一次 cookie 是否有效；没 cookie / 过期 → 立刻进熔断
 * 必须在 server.listen 之前完成：避免前端在 probe 没回来时连上来，
 * 触发一次无意义的冷启动 block 浪费 token
 */
async function probeAuthOnBoot() {
  console.log('[music] 启动探测 cookie 状态...');
  try {
    const state = await music.probeAuth();
    if (state === 'expired') {
      console.log('[music] 启动探测：未登录 / cookie 过期 → 进入熔断（前端连上即弹登录窗）');
      markAuthRequired(music.kind === 'netease' ? '尚未登录网易云' : 'cookie 已过期');
    } else if (state === 'ok') {
      console.log('[music] 启动探测：cookie 有效 ✓');
      // probe 时 provider 可能从 cookie 里反查到了 userId（老 .env 没 NETEASE_UID 的情况），
      // 把它持久化进 .env，下次启动就不用再反查
      if (music.kind === 'netease' && !process.env.NETEASE_UID && typeof music.getCurrentUserId === 'function') {
        const uid = music.getCurrentUserId();
        if (uid) {
          try {
            const envPath = path.resolve(__dirname, '.env');
            await upsertEnv(envPath, { NETEASE_UID: uid });
            process.env.NETEASE_UID = uid;
            console.log(`[music] 已把 NETEASE_UID=${uid} 补写进 .env`);
          } catch (e) {
            console.warn('[music] 补写 NETEASE_UID 到 .env 失败:', e.message);
          }
        }
      }
    } else {
      console.log('[music] 启动探测：未知（可能网络问题），等真实失败时再判定');
    }
  } catch (e) {
    console.warn('[music] 启动探测异常（忽略）:', e.message);
  }
}

// 给前端看的 provider 信息（cookie 弹窗需要用来切换文案/站点）
function providerInfo() {
  return {
    kind: music.kind,
    instructions: music.cookieInstructions || null,
    // 是否支持扫码登录（目前只有 netease）
    supportsQrLogin: typeof music.startQrLogin === 'function'
      && typeof music.checkQrLogin === 'function',
  };
}

// 初始化 DB（单例），并清理过期缓存
getDB(DATA_DIR);
purgeExpiredCache();

const store = new Store(DATA_DIR);
await store.init();

// ---------- HTTP ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'pwa')));

// 简单调试接口 + 画像是否就绪
app.get('/api/health', async (_, res) => {
  const hasTaste = await tasteExists();
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    historyCount: store.countPlays(),
    messageCount: store.countMessages(),
    hasTaste,
  });
});

// 对话历史（供前端刷新后恢复聊天记录）
app.get('/api/messages', (_, res) => {
  // 取更多一点，够填满 chatLog
  const rows = store.recentMessages(40);
  res.json({ messages: rows });
});

// 播放历史（含 rating），供 UI 弹窗展示
app.get('/api/history', (req, res) => {
  const n = Math.min(200, Math.max(10, Number(req.query.n) || 50));
  res.json({ history: store.historyForDisplay(n) });
});

// 拉当前 uin 的自建歌单（首次配置画像用）
app.get('/api/playlists', async (_, res) => {
  try {
    const list = await music.getMyPlaylists();
    res.json({ playlists: list });
  } catch (e) {
    console.error('[api/playlists]', e);
    res.status(500).json({ error: e.message });
  }
});

// 检查 taste.md 是否存在
async function tasteExists() {
  try {
    const fs = await import('node:fs/promises');
    const p = path.join(DATA_DIR, 'taste.md');
    const stat = await fs.stat(p);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

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

// QQ cookie 熔断状态变化 → 广播给所有前端
onAuthChange((evt) => {
  if (evt.required) {
    broadcaster.send('qq_auth_required', { reason: evt.reason, provider: providerInfo() });
  } else {
    broadcaster.send('qq_auth_ok', {});
  }
});

wss.on('connection', (ws) => {
  console.log(`[ws] client connected (total=${wss.clients.size})`);
  const solo = singleSender(ws);

  // 已处于 cookie 熔断 → 先通知新连上来的前端
  if (isAuthRequired()) {
    solo.send('qq_auth_required', { reason: getAuthReason(), provider: providerInfo() });
  }

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
      provider: providerInfo(),
    });
  } else if (inFlight) {
    // 没 block 但正在编 —— 告诉前端"稍等，马上来"
    console.log('[ws] 没 session 但正在编，告诉前端等待');
    solo.send('hello', { resume: false, generating: true, provider: providerInfo() });
    // 不用再触发生成，等正在跑的那一次结束广播
  } else {
    // 真·冷启动：从没放过歌。才触发首段生成。
    console.log('[ws] 冷启动，生成第一段');
    solo.send('hello', { resume: false, generating: true, provider: providerInfo() });
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
let bootstrapRunning = false; // 画像生成中（整个进程共用一把锁）
let blockSeq = 0;

// 跨 block 的疑似 authFail 滑动窗口（最近 N 个 block，累计 ≥ 阈值时主动 probe）
const AUTH_WINDOW_SIZE = 2;          // 最近 2 个 block
const AUTH_FAIL_THRESHOLD = 7;       // 累计 7 个疑似 → probe（比如两个 block 各 3~5 首失败）
const authFailWindow = [];

// ---------- 懒加载 mp3 直链 ----------
// 记录哪些 idx 正在被拉（避免短时间内前端重复请求 ensure_url / song_advance 撞车）
const inflightUrlFetches = new Set(); // key: `${seq}-${idx}`  seq=block 的 startedAt 用作标识
/**
 * 按需拿某一首的 url（懒加载）。拿到后通过 song_url_ready 广播给所有前端。
 * 幂等：同一首正在拉时不会并发重复拉。
 * 如果已有 url 直接返回。
 */
async function ensureUrlAsync(block, idx) {
  if (!block || !Array.isArray(block.songs)) return;
  if (idx < 0 || idx >= block.songs.length) return;
  const song = block.songs[idx];
  if (!song || song.url) return; // 已经有 url，跳过
  if (!song.songId) return;      // meta 都没有的不管

  const key = `${block.startedAt || '?'}-${idx}`;
  if (inflightUrlFetches.has(key)) return;
  inflightUrlFetches.add(key);

  try {
    const { url, authFail } = await fetchUrlFor(music, song);
    if (url) {
      song.url = url; // 就地改 session 里的 song
      // 广播给所有前端（多标签同步）
      broadcaster.send('song_url_ready', {
        idx,
        songId: song.songId,
        url,
      });
      console.log(`[lazy-url] idx=${idx} ${song.title} → 拿到直链`);
    } else {
      // 拿不到：通知前端，前端会跳到下一首
      broadcaster.send('song_url_failed', {
        idx,
        songId: song.songId,
        reason: authFail ? 'auth' : 'no-url',
      });
      console.warn(`[lazy-url] idx=${idx} ${song.title} → 拿不到直链${authFail ? '(authFail)' : ''}`);
    }
  } catch (e) {
    console.error(`[lazy-url] idx=${idx} 异常:`, e.message);
  } finally {
    inflightUrlFetches.delete(key);
  }
}

// ---------- 扫码登录（目前只有网易云支持） ----------
// 同一时间只允许一个扫码会话进行中（避免多标签开多个 key 撞车）
const QR_POLL_INTERVAL_MS = 2000;   // 轮询间隔
const QR_MAX_POLL_MS = 5 * 60_000;  // 最长扫 5 分钟，超时自动放弃
let _qrSession = null; // { key, timer, sender, startedAt, cancelled }

function cancelQrLogin() {
  if (!_qrSession) return;
  _qrSession.cancelled = true;
  if (_qrSession.timer) clearTimeout(_qrSession.timer);
  console.log(`[qrlogin] 取消（key=${_qrSession.key?.slice(0, 8)}...）`);
  _qrSession = null;
}

async function startQrLoginFlow(sender) {
  // 已经在跑就先取消
  if (_qrSession) {
    console.log('[qrlogin] 已有会话，先取消重开');
    cancelQrLogin();
  }

  console.log('[qrlogin] 申请二维码…');
  const { key, qrDataUrl } = await music.startQrLogin();
  console.log(`[qrlogin] 拿到 key=${key.slice(0, 8)}...，开始轮询`);

  // 用广播：用户可能在多个标签开着，全都更新二维码状态
  broadcaster.send('qr_login_qr', { qrDataUrl });

  _qrSession = { key, timer: null, sender, startedAt: Date.now(), cancelled: false };

  const poll = async () => {
    if (!_qrSession || _qrSession.cancelled) return;
    if (Date.now() - _qrSession.startedAt > QR_MAX_POLL_MS) {
      broadcaster.send('qr_login_failed', { error: '扫码超时，请重新打开' });
      _qrSession = null;
      return;
    }
    let r;
    try {
      r = await music.checkQrLogin(_qrSession.key);
    } catch (e) {
      console.warn('[qrlogin] check 异常', e.message);
      // 网络抖动不立即终止，下一轮再试
      _qrSession.timer = setTimeout(poll, QR_POLL_INTERVAL_MS);
      return;
    }
    if (!_qrSession || _qrSession.cancelled) return;

    if (r.status === 'waiting') {
      _qrSession.timer = setTimeout(poll, QR_POLL_INTERVAL_MS);
      return;
    }
    if (r.status === 'scanned') {
      // 已扫但未确认 → 通知前端，让二维码区域显示"已扫码，请在手机上确认"
      broadcaster.send('qr_login_status', { status: 'scanned' });
      _qrSession.timer = setTimeout(poll, QR_POLL_INTERVAL_MS);
      return;
    }
    if (r.status === 'expired') {
      broadcaster.send('qr_login_failed', { error: '二维码已过期，请重新打开' });
      _qrSession = null;
      return;
    }
    if (r.status === 'confirmed') {
      console.log(`[qrlogin] ✅ 登录成功 ${r.nickname ? `(${r.nickname})` : ''}`);
      _qrSession = null;
      // 直接用 applyCookie 走标准落盘 + 解熔断流程
      const result = await updateCookie({
        provider: music,
        cookieString: r.cookie || '',
        dataDir: DATA_DIR,
      });
      if (result.ok) {
        authFailWindow.length = 0;
        broadcaster.send('qr_login_ok', {
          userInfo: result.userInfo || { nickname: r.nickname, userId: r.userId },
        });
      } else {
        broadcaster.send('qr_login_failed', {
          error: 'cookie 验证失败：' + (result.error || '未知'),
        });
      }
    }
  };

  // 启动第一次（异步，立即返回，让 server 继续处理其它消息）
  _qrSession.timer = setTimeout(poll, QR_POLL_INTERVAL_MS);
}

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
  // cookie 熔断中：拒绝调大脑（省 token），只提示前端
  if (isAuthRequired()) {
    console.log('[block] 拒绝: QQ cookie 过期熔断中');
    sender.send('qq_auth_required', { reason: getAuthReason(), provider: providerInfo() });
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

    // 阶段 A：只搜 meta（不拿 mp3 直链）。这一步快，10 首歌大概 10-15 秒
    const { resolved, failed } = await searchAll(music, plan.play);
    console.log(
      `[block #${seq}] search 完成 (${((Date.now() - tResolve) / 1000).toFixed(1)}s): ` +
      `搜到 ${resolved.length}/${plan.play.length}` +
      (failed.length ? `, 搜不到: ${failed.map((f) => f.title).join(', ')}` : '')
    );

    if (!resolved.length) {
      const failedList = failed
        .map((f) => `${f.title} - ${f.artist}`)
        .slice(0, 5)
        .join(' / ');
      console.warn(`[block #${seq}] ❌ 一首都没搜到，退出`);
      sender.send('error', {
        message:
          `大脑选了 ${plan.play.length} 首，QQ 音乐都没搜到 ☹️\n` +
          `候选: ${failedList}\n` +
          `可能：搜歌被风控（稍等 30 秒重试），或大脑推荐了非常冷门的歌`,
        failed,
      });
      return;
    }

    // 阶段 B：预热前 N 首的 mp3 直链（保证点 PLAY 就能响）
    // 其余歌等播到时再懒加载（触发 ensure_url）
    const tPrefetch = Date.now();
    const { authFailCount } = await prefetchUrls(music, resolved, PREFETCH_URLS);

    // 过滤出真能播的（有 url 的 + songId 有的但 url 还没拿的先都算能播，等懒加载）
    // 前面预热失败的那几个（如果 url=''），就是没拿到直链，从能播列表移除
    const playable = resolved.filter((s, i) => {
      if (i < PREFETCH_URLS) {
        // 预热范围内必须有 url，没拿到的踢出
        return !!s.url;
      }
      // 超出预热范围的先保留（等懒加载）
      return true;
    });
    const prefetchFailedCount = PREFETCH_URLS - playable.slice(0, PREFETCH_URLS).length;
    // 预热失败的也补到 failed 列表
    if (prefetchFailedCount > 0) {
      for (let i = 0; i < Math.min(PREFETCH_URLS, resolved.length); i++) {
        if (!resolved[i].url) {
          failed.push({
            title: resolved[i].title,
            artist: resolved[i].artist,
            reason: 'no-url',
          });
        }
      }
    }

    // 跨 block 累计：本 block authFailCount 叠加到上个 block 的余量
    authFailWindow.push(authFailCount);
    if (authFailWindow.length > AUTH_WINDOW_SIZE) authFailWindow.shift();
    const windowSum = authFailWindow.reduce((a, b) => a + b, 0);

    console.log(
      `[block #${seq}] prefetch 前${PREFETCH_URLS}首 (${((Date.now() - tPrefetch) / 1000).toFixed(1)}s): ` +
      `可播 ${playable.length}/${resolved.length}` +
      (authFailCount ? ` [auth-suspect=${authFailCount}, 窗口累计=${windowSum}/${AUTH_FAIL_THRESHOLD}]` : '')
    );

    // 触发 probe 的条件（任一满足）：
    //   (a) 预热段里 authFailCount 过半
    //   (b) 滑动窗口累计 ≥ 阈值
    const blockMajority = PREFETCH_URLS > 0 && authFailCount >= Math.ceil(PREFETCH_URLS * 0.6);
    const windowOverflow = windowSum >= AUTH_FAIL_THRESHOLD;
    if (blockMajority || windowOverflow) {
      console.warn(
        `[block #${seq}] ⚠️ 触发 cookie 探测：` +
        (blockMajority ? `预热段 ${authFailCount}/${PREFETCH_URLS} 疑似 ` : '') +
        (windowOverflow ? `窗口累计 ${windowSum} ≥ ${AUTH_FAIL_THRESHOLD}` : '')
      );
      const state = await probeCookieAlive(music);
      console.log(`[musicauth] probe 结果: ${state}`);
      resetAuthFailSignals();
      authFailWindow.length = 0;

      if (state === 'expired') {
        markAuthRequired('cookie 已过期（probe 确认未登录）');
        sender.send('qq_auth_required', { reason: 'cookie 已过期', provider: providerInfo() });
        return;
      }
      if (state === 'ok' && !playable.length) {
        console.log('[qqauth] cookie 验证正常，本轮失败属于 VIP / 版权问题');
      }
    }

    if (!playable.length) {
      const failedList = failed
        .map((f) => `${f.title} - ${f.artist}`)
        .slice(0, 5)
        .join(' / ');
      const hasAuthSuspect = authFailCount > 0;
      console.warn(`[block #${seq}] ❌ 没能播的歌，退出`);
      sender.send('error', {
        message:
          `大脑选了 ${plan.play.length} 首，没一首能拿到播放链接 ☹️\n` +
          `候选: ${failedList}\n` +
          (hasAuthSuspect
            ? `可能：这批歌存在 VIP / 版权受限（probe 已确认 cookie 还有效）`
            : `可能：搜歌被风控（稍等 30 秒重试），或大脑推荐了非常冷门的歌`),
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
      startedAt: Date.now(),
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
        // 主动预热接下来要播的几首：idx+1 ... idx+PREFETCH_AHEAD
        // 至少保证下一首 (idx+1) 在播之前 url 已就绪，避免 ended → 卡顿
        for (let k = 1; k <= PREFETCH_AHEAD; k++) {
          ensureUrlAsync(session.currentBlock, data.idx + k);
        }
      }
      break;
    }

    case 'ensure_url': {
      // 前端主动请求某一首的 url（懒加载）
      // data: { idx: number }
      const idx = Number(data?.idx);
      if (Number.isInteger(idx)) {
        ensureUrlAsync(session.currentBlock, idx);
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
        // 新段的前 PREFETCH_AHEAD 首如果还没 url 就预拉一下，避免切段时卡住
        for (let i = 0; i < Math.min(PREFETCH_AHEAD, session.currentBlock.songs.length); i++) {
          ensureUrlAsync(session.currentBlock, i);
        }
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

    case 'clear_chat': {
      const n = store.clearMessages();
      console.log(`[chat] 清空了 ${n} 条历史对话`);
      sender.send('chat_cleared', { count: n });
      break;
    }

    case 'bootstrap_start': {
      // 画像冷启动（前端首次设置 or 重置画像）
      // data: { picks: [{playlistId, name, kind, n?}, ...] }
      if (bootstrapRunning) {
        console.log('[bootstrap] 拒绝：已有一个生成任务在跑');
        sender.send('bootstrap_progress', {
          stage: 'error',
          detail: '已经在生成画像中，请等完成',
        });
        break;
      }
      const picks = Array.isArray(data?.picks) ? data.picks : [];
      if (!picks.length) {
        sender.send('bootstrap_progress', { stage: 'error', detail: '没选任何歌单' });
        break;
      }
      bootstrapRunning = true;
      console.log(`[bootstrap] 开始，${picks.length} 个歌单:`, picks.map((p) => `${p.name}(${p.kind}${p.n ? ':' + p.n : ''})`).join(', '));
      sender.send('bootstrap_progress', { stage: 'starting', detail: '开始生成画像...', pct: 1 });

      // 异步跑，不阻塞消息 loop；进度通过广播让所有连接（含用户可能开的多个标签）都看到
      (async () => {
        try {
          const result = await bootstrapTaste({
            music,
            dataDir: DATA_DIR,
            picks,
            onProgress: (evt) => {
              broadcaster.send('bootstrap_progress', evt);
            },
          });
          console.log(
            `[bootstrap] 完成 耗时 ${(result.durationMs / 1000).toFixed(1)}s, ` +
            `样本 ${result.sampleCount}/${result.uniqueCount}, taste.md ${result.rawLength} 字`
          );
          broadcaster.send('bootstrap_done', {
            tastePath: result.tastePath,
            durationMs: result.durationMs,
            uniqueCount: result.uniqueCount,
          });
          // 画像变了：扔掉当前会话的 block（如果有），让下次重新编
          // 当前正在播的这首可以让它播完，下一段自动用新画像
          if (session.nextBlock) {
            console.log('[bootstrap] 画像变了，扔掉 prefetch 的 nextBlock');
            session.nextBlock = null;
          }
        } catch (e) {
          console.error('[bootstrap] 失败', e);
          broadcaster.send('bootstrap_progress', {
            stage: 'error',
            detail: e.message,
          });
        } finally {
          bootstrapRunning = false;
        }
      })();
      break;
    }

    case 'rate_song': {
      // 用户对某首历史歌打分（喜欢 / 不感兴趣）
      // 静默累加到 taste-deltas.md，不走对话通道（UI 上也不出气泡）
      const id = Number(data?.id);
      const rating = data?.rating === 'like' || data?.rating === 'dislike' ? data.rating : null;
      const result = store.rateSong(id, rating);
      if (!result) {
        console.warn(`[rate] 无效: id=${id}, rating=${rating}`);
        sender.send('rate_result', { id, ok: false });
        break;
      }
      // 只有"新评/改评"才追加 delta（避免重复取消又打 like 时写一堆）
      if (rating && rating !== result.prev) {
        const verb = rating === 'like' ? '喜欢' : '不感兴趣';
        const deltaText = `${verb}：${result.title} - ${result.artist}`;
        await store.appendTasteDelta(deltaText, 'rating');
        console.log(`[rate] ${deltaText} → taste-deltas`);
      } else if (rating === null && result.prev) {
        console.log(`[rate] 取消 ${result.prev}: ${result.title} - ${result.artist}（不回写 delta）`);
      }
      sender.send('rate_result', { id, ok: true, rating });
      break;
    }

    case 'rate_current': {
      // 给"当前正在播的这首"打分（前端不知道 play_history id，按 title+artist 找）
      const title = String(data?.title || '').trim();
      const artist = String(data?.artist || '').trim();
      const rating = data?.rating === 'like' || data?.rating === 'dislike' ? data.rating : null;
      if (!title || !artist) {
        console.warn('[rate_current] title/artist 缺');
        break;
      }
      const result = store.rateByTitleArtist(title, artist, rating);
      if (!result) break;
      if (rating && rating !== result.prev) {
        const verb = rating === 'like' ? '喜欢' : '不感兴趣';
        const deltaText = `${verb}：${title} - ${artist}`;
        await store.appendTasteDelta(deltaText, 'rating');
        console.log(`[rate_current] ${deltaText} → taste-deltas`);
      } else if (rating === null && result.prev) {
        console.log(`[rate_current] 取消 ${result.prev}: ${title} - ${artist}`);
      }
      // 把结果回推（前端可用来同步 UI 状态，比如多标签页）
      sender.send('current_rating', { title, artist, rating });
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
        // 护栏：即使大脑说 replace_now=true，如果用户消息里没明确"立刻切换"信号，降级为 silent prefetch
        // 这是为了防止"被切歌"——AI 判断一旦错了就会打断用户正在听的歌
        const HARD_NOW_SIGNAL = /(立刻|马上|现在就|这首.*跳|这首.*换|换掉这首|切掉)/;
        let replaceNow = !!r.replace_now;
        if (replaceNow && !HARD_NOW_SIGNAL.test(text)) {
          console.log('[chat] ⚠️ 大脑要 replace_now=true 但用户没明确说"立刻"，降级为 prefetch');
          replaceNow = false;
        }

        if (replaceNow) {
          console.log('[chat] → 用户明确要立刻换，replace 生成');
          await generateAndSend(sender, r.regen_hint, true);
        } else {
          console.log('[chat] → 静默生成下一段，当前歌不打断');
          await generateAndSend(sender, r.regen_hint, false);
        }
      }
      break;
    }

    case 'qq_cookie_update': {
      // 用户从弹窗里粘了新 cookie：落盘 + 推给 QQMusicApi + 验证 + 解除熔断
      const raw = String(data?.cookie || '');
      console.log(`[qqauth] 收到 cookie 更新请求，长度=${raw.length}`);
      const result = await updateCookie({
        provider: music,
        cookieString: raw,
        dataDir: DATA_DIR,
      });
      if (result.ok) {
        console.log('[qqauth] cookie 更新成功，可以重新生成 block');
        authFailWindow.length = 0;

        // QQ 源额外一步：重启 QQMusicApi，彻底刷新 cookie 派生的签名缓存
        // （不重启的话 QQMusicApi 内部可能还用老 g_tk 等字段，表现为推成功但实际 301）
        if (music.kind === 'qq' && typeof music.restartBackend === 'function') {
          sender.send('qq_cookie_update_progress', { stage: 'restarting_backend' });
          console.log('[qqauth] 重启 QQMusicApi 以彻底刷新 cookie 缓存...');
          const qqMusicDir = process.env.QQMUSIC_DIR
            || path.resolve(__dirname, '..', 'QQMusicApi');
          const cookieFilePath = path.join(DATA_DIR, 'qq_cookie.json');
          const logFile = path.resolve(__dirname, '..', 'logs', 'qqmusicapi.log');
          const r2 = await music.restartBackend({ qqMusicDir, cookieFilePath, logFile });
          if (!r2.ok) {
            console.warn('[qqauth] 重启 QQMusicApi 失败:', r2.error);
            sender.send('qq_cookie_update_result', {
              ok: false,
              error: `cookie 已写入，但重启 QQMusicApi 失败：${r2.error}。手动重启 Vox 即可。`,
            });
            break;
          }
          console.log('[qqauth] ✅ QQMusicApi 重启完成，cookie 生效');
        }

        sender.send('qq_cookie_update_result', result);
        // 让前端自行决定要不要立刻触发 request_block
      } else {
        console.warn('[qqauth] cookie 更新失败:', result.error);
        sender.send('qq_cookie_update_result', result);
      }
      break;
    }

    case 'qr_login_start': {
      // 前端请求开启扫码登录（只有支持 startQrLogin 的 provider 能用，目前是网易云）
      if (typeof music.startQrLogin !== 'function') {
        sender.send('qr_login_failed', { error: '当前音乐源不支持扫码登录' });
        break;
      }
      try {
        startQrLoginFlow(sender).catch((e) => {
          console.error('[qrlogin] flow 异常', e);
          sender.send('qr_login_failed', { error: e.message });
        });
      } catch (e) {
        sender.send('qr_login_failed', { error: e.message });
      }
      break;
    }

    case 'qr_login_cancel': {
      // 前端关闭弹窗 → 停止当前轮询
      cancelQrLogin();
      break;
    }

    default:
      console.warn('[ws] unknown message type', type);
  }
}

// ---------- 启动 ----------
await probeAuthOnBoot();
server.listen(PORT, () => {
  const brainBin = resolveBrainBin();
  const brainFlavor = getBrainFlavor();
  const brainConfigured = !!process.env.BRAIN_BIN;

  console.log(`🎧 Vox is running at http://localhost:${PORT}`);
  console.log(`   Data dir : ${DATA_DIR}`);
  console.log(`   Music    : ${MUSIC_PROVIDER}${MUSIC_PROVIDER === 'qq' ? ` (${process.env.QQMUSIC_API_URL || 'http://127.0.0.1:3300'})` : ''}`);
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

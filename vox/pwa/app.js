// ============================================================
// 状态
// ============================================================
let ws = null;
let queue = [];          // 当前段剩余歌曲
let current = null;      // 正在播放的
let nextBlock = null;    // 预拉的下一段（{say, songs, weather}），等当前段播完用
let prefetching = false; // 防止并发请求下一段
let djSayTimer = null;
let currentTheme = 'cyber';
let userPaused = false;  // 用户主动暂停过（用于 resume 检测）
let programmaticPause = false; // 程序主动暂停（replace / 切歌），不当作用户暂停
// audio 错误重试：网络抖动先重试，不直接跳歌
let errorRetryCount = 0;
let errorRetryTimer = null;
const ERROR_RETRY_LIMIT = 1;

// lazy-url 兜底：等 ensure_url 超时就跳下一首
let lazyUrlTimer = null;

// 主题模式: 'auto' = 跟天气, 其他 = 手动锁定
const THEME_PREF_KEY = 'vox.themePref';
let themePref = localStorage.getItem(THEME_PREF_KEY) || 'auto';

// DOM
const $ = (id) => document.getElementById(id);
const audio = $('audio');
const titleEl = $('title');
const artistEl = $('artist');
const reasonEl = $('reason');
const queueEl = $('queue');
const statusEl = $('status');
const djSayEl = $('djSay');
const weatherEl = $('weatherInfo');
const coverWrap = $('coverWrap');
const progressFill = $('progressFill');
const progressBar = $('progressBar');
const curTimeEl = $('curTime');
const totTimeEl = $('totTime');
const chatLog = $('chatLog');
const chatForm = $('chatForm');
const chatInput = $('chatInput');
const fxLayer = $('fxLayer');
const themeSwitch = $('themeSwitch');
const themePopup = $('themePopup');
const nowPlaying = $('nowPlaying');
const loadingScreen = $('loadingScreen');
const loadingStage = $('loadingStage');
const loadingTitle = $('loadingTitle');
const loadingSub = $('loadingSub');
const loadingFill = $('loadingFill');
const loadingElapsed = $('loadingElapsed');
const loadingEta = $('loadingEta');

// 播放历史 Modal
const historyBtn = $('historyBtn');
const historyModal = $('historyModal');
const historyClose = $('historyClose');
const historyList = $('historyList');

// 画像冷启动 Modal
const resetTasteBtn = $('resetTasteBtn');
const bootstrapModal = $('bootstrapModal');
const bootstrapClose = $('bootstrapClose');
const bootstrapTitle = $('bootstrapTitle');
const bootstrapStepPick = $('bootstrapStepPick');
const bootstrapStepProgress = $('bootstrapStepProgress');
const bootstrapStepDone = $('bootstrapStepDone');
const bootstrapPlaylists = $('bootstrapPlaylists');
const bootstrapPickStats = $('bootstrapPickStats');
const bootstrapGoBtn = $('bootstrapGoBtn');
const bootstrapStage = $('bootstrapStage');
const bootstrapBarFill = $('bootstrapBarFill');
const bootstrapDetail = $('bootstrapDetail');
const bootstrapLog = $('bootstrapLog');
const bootstrapDoneBtn = $('bootstrapDoneBtn');
const bootstrapDoneDetail = $('bootstrapDoneDetail');

// ============================================================
// Loading 状态机
// ============================================================
const ETA_KEY = 'vox.lastBlockMs';
let loadingT0 = 0;
let loadingTimer = null;
let loadingTotalEstimate = Number(localStorage.getItem(ETA_KEY)) || 25000;

function showLoading(stage = 'thinking') {
  nowPlaying.classList.add('loading');
  loadingScreen.classList.add('show');

  const stageMap = {
    thinking: {
      stage: 'AI // THINKING',
      title: '大脑正在编排歌单',
      sub: '正在结合你的口味画像、当前时间天气、最近播过的歌选 5 首...',
    },
    resolving: {
      stage: 'QQ // RESOLVING',
      title: '正在找歌',
      sub: '大脑选好了，正在 QQ 音乐找直链...',
    },
    init: {
      stage: 'SYS // INIT',
      title: '准备中',
      sub: '正在连接 Vox 大脑，准备给你编一段歌单...',
    },
  };
  const cfg = stageMap[stage] || stageMap.init;
  loadingStage.textContent = cfg.stage;
  loadingTitle.innerHTML = `<span class="think-dots"><span></span><span></span><span></span></span>${cfg.title}`;
  loadingSub.textContent = cfg.sub;

  if (!loadingT0) loadingT0 = Date.now();
  if (!loadingTimer) {
    loadingTimer = setInterval(updateLoadingProgress, 200);
    updateLoadingProgress();
  }
}

function updateLoadingProgress() {
  const elapsed = Date.now() - loadingT0;
  const ratio = Math.min(elapsed / loadingTotalEstimate, 0.98); // 永不到 100%，等真出块再到 100%
  loadingFill.style.width = (ratio * 100).toFixed(1) + '%';
  loadingElapsed.textContent = `已用 ${Math.floor(elapsed / 1000)}s`;
  const eta = Math.max(0, Math.ceil((loadingTotalEstimate - elapsed) / 1000));
  if (elapsed < loadingTotalEstimate) {
    loadingEta.textContent = `预计还需 ~${eta}s`;
  } else {
    loadingEta.textContent = `比预期长了点，再等等...`;
  }
}

function hideLoading() {
  if (loadingT0) {
    const took = Date.now() - loadingT0;
    // 平滑学习：新值占 60%、旧值占 40%
    loadingTotalEstimate = Math.round(loadingTotalEstimate * 0.4 + took * 0.6);
    localStorage.setItem(ETA_KEY, String(loadingTotalEstimate));
  }
  loadingT0 = 0;
  if (loadingTimer) {
    clearInterval(loadingTimer);
    loadingTimer = null;
  }
  loadingFill.style.width = '100%';
  setTimeout(() => {
    nowPlaying.classList.remove('loading');
    loadingScreen.classList.remove('show');
    loadingFill.style.width = '0%';
  }, 300);
}

// ============================================================
// WebSocket
// ============================================================
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/stream`);
  ws.onopen = () => {
    setStatus('SYS // ONLINE', true);
    // 不再立刻 showLoading('init')。先等 hello —— server 会告诉我们是恢复还是冷启动
  };
  ws.onclose = () => {
    setStatus('SYS // OFFLINE — RECONNECT 3s', false);
    setTimeout(connect, 3000);
  };
  ws.onerror = (e) => console.error('ws error', e);
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handleServer(m);
  };
}
function send(type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function handleServer({ type, data }) {
  switch (type) {
    case 'hello':
      handleHello(data);
      break;
    case 'status':
      // silent=true 表示后台静默生成（prefetch / 用户口味更新触发）
      // 这种情况绝对不能弹全屏 Loading 把当前播放界面盖了
      if (data.silent) {
        if (data.stage === 'thinking') setStatus('AI // PREP NEXT...', true);
        if (data.stage === 'resolving') setStatus('AI // RESOLVING NEXT...', true);
        break;
      }
      if (data.stage === 'thinking') {
        setStatus('AI // THINKING...');
        showLoading('thinking');
      }
      if (data.stage === 'resolving') {
        setStatus('AI // RESOLVING TRACKS...');
        showLoading('resolving');
      }
      break;
    case 'block':
      setStatus('SYS // ONLINE', true);

      // 服务端明确要求立即替换（用户聊天/换风格触发）
      if (data.replace) {
        console.log('[block] 立即替换当前队列');
        nextBlock = null;
        prefetching = false;
        hideLoading();
        // 让当前歌平滑停止再切（避免突兀）
        programmaticPause = true;
        try { audio.pause(); } catch {}
        consumeBlock(data);
        break;
      }

      // 当前还在播 + 队列还有歌 → 这是 prefetch，先收着
      if (current && queue.length > 0) {
        nextBlock = data;
        console.log(`[prefetch] 收到下一段（${data.songs.length} 首），等当前段播完`);
        prefetching = false;
        // 给用户一个轻微提示：新一段已就绪（不打断当前播放）
        const firstTwo = data.songs.slice(0, 2).map((s) => s.title).join('、');
        pushSysLog(`下一段已备好：${firstTwo}…`);
        return;
      }

      // 否则就是要立即用的（首次 / 队列已耗尽）
      hideLoading();
      consumeBlock(data);
      break;
    case 'dj_say':
      showDjSay(data.text);
      pushDjLog(data.text);
      break;
    case 'reply_start':
      startStreamingBubble(data.id);
      break;
    case 'reply_delta':
      appendStreamingBubble(data.id, data.text);
      break;
    case 'reply_end':
      finishStreamingBubble(data.id, data.final, !!data.error);
      break;
    case 'chat_cleared':
      chatLog.innerHTML = '';
      pushSysLog(`已清空 ${data.count} 条对话`);
      break;
    case 'rate_result':
      // 评分失败就回退 UI（乐观更新过，失败要还原）
      if (!data.ok) {
        console.warn('[rate] server rejected, reloading');
        // 简单做法：重拉历史（列表还是打开着的话会自动刷新）
        if (historyModal.classList.contains('show')) openHistory();
      }
      break;
    case 'current_rating':
      // server 回推当前歌评分（用于多标签同步；如果 title+artist 跟前端一致就更新 UI）
      if (current && current.title === data.title && current.artist === data.artist) {
        currentRating = data.rating || null;
        refreshRateButtons();
      }
      break;
    case 'bootstrap_progress':
      handleBootstrapProgress(data);
      break;
    case 'bootstrap_done':
      handleBootstrapDone(data);
      break;
    case 'control':
      // 服务端要求执行某个动作（目前只有 skip）
      if (data.action === 'skip') {
        if (current) send('played', { title: current.title, artist: current.artist });
        playNext();
      }
      break;
    case 'error':
      setStatus('ERR // ' + data.message);
      hideLoading();
      console.error(data);
      break;
    case 'qq_auth_required':
      showQQAuthModal(data?.reason || '');
      hideLoading();
      setStatus('QQ COOKIE 失效 // 等待更新');
      break;
    case 'qq_auth_ok':
      hideQQAuthModal();
      setStatus('COOKIE 已更新 // 恢复推荐');
      break;
    case 'qq_cookie_update_result':
      handleQQCookieUpdateResult(data);
      break;
    case 'song_url_ready':
      handleSongUrlReady(data);
      break;
    case 'song_url_failed':
      handleSongUrlFailed(data);
      break;
  }
}

// ============================================================
// 连接握手（hello）：恢复会话 OR 冷启动
// ============================================================
let helloHandled = false; // 同一进程内只处理一次首屏恢复

function handleHello(data) {
  console.log('[hello]', data);

  if (helloHandled) {
    // 第二次以后（重连），如果 server 还有 session 就静默同步
    if (data.resume && data.currentBlock) {
      // 队列对齐：server 上的下标可能跟前端不一样（极少见，但防御一下）
      console.log('[hello] 重连，server 仍持有 session，前端继续播');
    }
    return;
  }
  helloHandled = true;

  // 1. 拉历史聊天，无论 resume 与否
  loadHistoryMessages();

  if (data.resume && data.currentBlock) {
    // ========== 恢复模式：电台还在播，浏览器只是来收听 ==========
    hideLoading();
    setStatus('SYS // ONLINE', true);
    applyWeather(data.weather);
    if (data.lastDjSay) showDjSay(data.lastDjSay);

    const block = data.currentBlock;
    const idx = Math.max(0, Math.min(data.currentIdx || 0, block.songs.length - 1));
    queue = block.songs.slice(idx);
    window.__currentBlockSongs = block.songs.length;
    if (data.hasNextBlock) {
      // server 已有 prefetch；前端不重复要
      nextBlock = '__server_has__'; // 标记位，真东西在 server，等播完再请求
    }

    // 直接进入"播第一首"，但保留 server 报的进度
    const restorePos = Math.max(0, data.currentPos || 0);
    current = queue.shift();
    currentRating = null;
    refreshRateButtons?.();
    renderCurrentSong();

    if (!current.url) {
      // 懒加载：server 恢复过来时这首 url 还没就绪，等 song_url_ready
      console.log('[hello] current.url 空，请求 ensure_url');
      setStatus('LOADING // ' + current.title);
      const waitingSongId = current.songId;
      send('ensure_url', { idx });
      renderQueue();
      document.title = `⏳ ${current.title} — ${current.artist} // VOX`;
      maybePrefetch();
      // 兜底超时：8s 没拿到 url 跳下一首
      if (lazyUrlTimer) clearTimeout(lazyUrlTimer);
      lazyUrlTimer = setTimeout(() => {
        lazyUrlTimer = null;
        if (current && !current.url && current.songId === waitingSongId) {
          console.warn('[hello] 等 lazy-url 超时，跳过');
          current = null;
          playNext();
        }
      }, 8000);
      return;
    }

    audio.src = current.url;

    // 等元数据加载好再 seek
    const seekWhenReady = () => {
      try {
        if (restorePos && audio.duration && restorePos < audio.duration - 2) {
          audio.currentTime = restorePos;
          console.log(`[hello] 恢复进度到 ${restorePos.toFixed(0)}s`);
        }
      } catch (e) { console.warn('seek fail', e); }
      audio.removeEventListener('loadedmetadata', seekWhenReady);
    };
    audio.addEventListener('loadedmetadata', seekWhenReady);

    audio.play()
      .then(() => console.log('[hello] ✓ 已开始播放（恢复）'))
      .catch((err) => {
        console.warn('[hello] ❌ autoplay 被拦', err.name);
        setStatus('CLICK ▶ TO RESUME');
        showDjSay('点 ▶ 继续刚才那段');
      });

    renderQueue();
    document.title = `▶ ${current.title} — ${current.artist} // VOX`;
    maybePrefetch();
  } else {
    // ========== 冷启动 / 还在编 ==========
    showLoading(data.generating ? 'thinking' : 'init');
  }
}

async function loadHistoryMessages() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) return;
    const { messages } = await res.json();
    if (!Array.isArray(messages) || !messages.length) return;
    chatLog.innerHTML = ''; // 清掉，避免重复
    messages.forEach((m) => {
      if (m.role === 'user') appendBubble('user', m.text);
      else if (m.role === 'dj') appendBubble('dj', m.text);
    });
    console.log(`[history] 恢复 ${messages.length} 条对话`);
  } catch (e) {
    console.warn('history fetch fail', e);
  }
}

// 提取出来：渲染"现在播放区"（标题/封面），给 hello 恢复路径复用
function renderCurrentSong() {
  if (!current) return;
  titleEl.textContent = current.title;
  artistEl.textContent = current.artist + (current.album ? ` // ${current.album}` : '');
  reasonEl.textContent = current.reason || '';
  if (current.cover) {
    coverWrap.innerHTML = `<img src="${current.cover}" alt="" onerror="this.parentElement.classList.add('empty');this.remove();this.parentElement.textContent='NO ART';">`;
    coverWrap.classList.remove('empty');
    coverWrap.classList.add('playing');
  } else {
    coverWrap.innerHTML = 'NO ART';
    coverWrap.classList.add('empty');
    coverWrap.classList.remove('playing');
  }
}

// ============================================================
// 播放
// ============================================================

/**
 * 应用一个 block：更新主题/字幕/队列，开始播放
 */
function consumeBlock(data) {
  console.log(`[consumeBlock] ${data.songs.length} 首`, data.songs.map(s => s.title));
  applyWeather(data.weather);
  showDjSay(data.say);
  pushDjLog(data.say);
  queue = data.songs.slice();
  window.__currentBlockSongs = data.songs.length; // 记下总数，给 song_advance 反推下标用
  prefetching = false; // 新段到了，下个预拉窗口重新算
  renderQueue();
  if (data.failed?.length) {
    console.warn('找不到的歌:', data.failed);
    // 用户应该知道：本段只有 N/M 首能播
    const got = data.songs.length;
    const asked = got + data.failed.length;
    if (got < asked) {
      pushSysLog(`本段 ${asked} 首里有 ${data.failed.length} 首 QQ 音乐找不到，实际播 ${got} 首`);
    }
  }
  playNext();
}

function playNext() {
  console.log(`[playNext] queue=${queue.length}, nextBlock=${nextBlock ? 'have' : 'no'}, prefetching=${prefetching}`);
  if (!queue.length) {
    // 优先用预拉的下一段
    if (nextBlock && nextBlock !== '__server_has__') {
      console.log('[prefetch] 用预拉的下一段，无缝衔接');
      const nb = nextBlock;
      nextBlock = null;
      send('block_consumed'); // 告诉 server：用掉了 nextBlock
      consumeBlock(nb);
      return;
    }
    if (nextBlock === '__server_has__') {
      // server 那边有 prefetch，但前端没缓存（恢复模式）→ 现去要
      console.log('[prefetch] server 上的 prefetch 还没推过来，请求');
      nextBlock = null;
    }

    // 没有预拉 → 要一段
    // 如果已经在 prefetching（maybePrefetch 更早发过 request_block），不重复发
    // 只是显示"准备中"，等 server 的 block 到了会自动进 consumeBlock
    if (!prefetching) {
      prefetching = true;
      send('request_block');
    }
    console.log('[playNext] 队列空，等 server 回 block（已在请求中）');
    showLoading('thinking');
    return;
  }
  current = queue.shift();
  currentRating = null;
  refreshRateButtons?.();
  // 清掉上一首遗留的重试状态
  errorRetryCount = 0;
  if (errorRetryTimer) { clearTimeout(errorRetryTimer); errorRetryTimer = null; }
  // 清掉上一首遗留的 lazy-url 等待 timer
  if (lazyUrlTimer) { clearTimeout(lazyUrlTimer); lazyUrlTimer = null; }
  console.log(`[play] 开始 [${current.title} - ${current.artist}] (url=${current.url ? '有' : '空'})`);

  // 懒加载 url：如果这首还没拿到直链，发 ensure_url 等 server 回 song_url_ready
  if (!current.url) {
    console.log(`[play] url 未就绪，等懒加载...`);
    setStatus('LOADING // ' + current.title);
    // 显式停掉上一首的 audio：避免"看着已经切歌但音频还在播上一首"的错觉
    programmaticPause = true;
    try { audio.pause(); } catch {}
    try { audio.removeAttribute('src'); audio.load(); } catch {}

    const idx = (window.__currentBlockSongs || 1) - queue.length - 1;
    const waitingSongId = current.songId;
    send('ensure_url', { idx: Math.max(0, idx) });
    renderCurrentSong();
    renderQueue();
    document.title = `⏳ ${current.title} — ${current.artist} // VOX`;
    reportSongAdvance();
    maybePrefetch();

    // 兜底超时：8s 内没拿到 url → 跳下一首
    lazyUrlTimer = setTimeout(() => {
      lazyUrlTimer = null;
      if (current && !current.url && current.songId === waitingSongId) {
        console.warn(`[play] 等 lazy-url 超时（8s），跳过 "${current.title}"`);
        pushSysLog(`"${current.title}" 拿不到直链，跳过`);
        current = null; // 防止后续 played 误报
        playNext();
      }
    }, 8000);
    return;
  }

  audio.src = current.url;
  audio.play()
    .then(() => console.log('[play] ✓ 已开始播放'))
    .catch((err) => {
      console.warn('[play] ❌', err.name, err.message);
      if (err.name === 'NotAllowedError') {
        setStatus('CLICK ▶ TO PLAY');
        showDjSay('浏览器拦截了自动播放，点 ▶ PLAY 开始');
      } else {
        setStatus('ERR // ' + err.message);
      }
    });

  renderCurrentSong();
  renderQueue();
  document.title = `▶ ${current.title} — ${current.artist} // VOX`;

  // 通知 server：切到了新一首（用于刷新恢复对位）
  reportSongAdvance();

  // 当前段还剩 ≤ 1 首未放，开始预拉下一段
  maybePrefetch();
}

/**
 * 当队列剩余 ≤ 1 首时，提前请求下一段
 */
function maybePrefetch() {
  if (queue.length > 1) return;
  if (nextBlock) return; // 已经有了（或占位符也不重复要）
  if (prefetching) return;
  prefetching = true;
  console.log('[prefetch] 当前段快完，提前请求下一段');
  send('request_block');
}

// 通知 server：切歌了。让 server 的 currentIdx 跟前端对齐
function reportSongAdvance() {
  // 估算当前是 block 里的第几首：用 queue 剩余反推不可靠（因为 queue 已经 shift 过了）
  // 简单做法：让 server 自己维护下标，前端只发"我刚切到下一首"的信号
  // 这里直接发"+1"语义：server 把 currentIdx++、currentPos 归零
  // 用 pos=0 + 一个 idx 推算：发当前剩余队列长度，server 反推
  const idxGuess = (window.__currentBlockSongs || 1) - queue.length - 1;
  send('song_advance', { idx: Math.max(0, idxGuess) });
}

audio.addEventListener('ended', () => {
  if (current) send('played', { title: current.title, artist: current.artist });
  playNext();
});
audio.addEventListener('timeupdate', () => {
  const dur = audio.duration || 0;
  const cur = audio.currentTime || 0;
  progressFill.style.width = dur ? (cur / dur * 100) + '%' : '0%';
  curTimeEl.textContent = fmtTime(cur);
  totTimeEl.textContent = fmtTime(dur);
  // 节流：每 ~3s 上报一次播放位置
  reportPosThrottled(cur);
});
// audio error 处理：网络抖动 / 临时失败很常见，不要无条件跳歌
// 策略：同一首歌先重试一次（重载 src）；仍失败才切
audio.addEventListener('error', () => {
  const err = audio.error;
  console.warn(`[audio error] code=${err?.code}, current=${current?.title}, retried=${errorRetryCount}`);

  if (!current) return;

  // 已经重试够了 → 放弃，切下一首
  if (errorRetryCount >= ERROR_RETRY_LIMIT) {
    console.warn(`[audio error] 重试 ${errorRetryCount} 次仍失败，切下一首`);
    errorRetryCount = 0;
    pushSysLog(`这首播放失败: ${current.title} - ${current.artist}，跳过`);
    playNext();
    return;
  }

  // 重试一次
  errorRetryCount++;
  console.log(`[audio error] ${1500 * errorRetryCount}ms 后重试 [${errorRetryCount}/${ERROR_RETRY_LIMIT}]`);
  setStatus('NETWORK HICCUP // RETRY...', true);
  if (errorRetryTimer) clearTimeout(errorRetryTimer);
  errorRetryTimer = setTimeout(() => {
    if (!current) return;
    // 重新设 src 触发重新加载
    const savedPos = audio.currentTime;
    audio.src = current.url;
    audio.play()
      .then(() => {
        // 尽量恢复到原位置
        if (savedPos > 0) {
          try { audio.currentTime = savedPos; } catch {}
        }
        setStatus('SYS // ONLINE', true);
      })
      .catch((e) => {
        console.warn('[audio error] 重试 play 也失败', e);
      });
  }, 1500 * errorRetryCount);
});

// 成功播放一段时间后，重置重试计数（说明网络又好了）
audio.addEventListener('playing', () => {
  if (errorRetryCount > 0) {
    console.log('[audio] 恢复播放，重置重试计数');
    errorRetryCount = 0;
  }
});

let lastPosReportAt = 0;
function reportPosThrottled(pos) {
  const now = Date.now();
  if (now - lastPosReportAt < 3000) return;
  lastPosReportAt = now;
  send('pos_update', { pos });
}
function fmtTime(t) {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// 进度条点击 seek
progressBar.addEventListener('click', (e) => {
  if (!audio.duration) return;
  const rect = progressBar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  audio.currentTime = audio.duration * ratio;
});

// ============================================================
// 按钮
// ============================================================
$('btnPlay').addEventListener('click', () => {
  if (audio.paused) audio.play();
  else audio.pause();
});
audio.addEventListener('play', () => {
  $('btnPlay').textContent = '⏸ PAUSE';
  // 区分"首次播放"和"恢复播放"：只有真的从暂停态到播放态才发 resume
  if (userPaused) {
    userPaused = false;
    send('resume');
  }
});
audio.addEventListener('pause', () => {
  $('btnPlay').textContent = '▶ PLAY';
  // audio.ended 时也会触发 pause 事件；程序主动 pause 也不是用户行为
  if (programmaticPause) {
    programmaticPause = false;
    return;
  }
  if (!audio.ended && current) {
    userPaused = true;
    send('pause');
  }
});

$('btnNext').addEventListener('click', () => {
  if (current) send('skip', { title: current.title, artist: current.artist });
  playNext();
});

$('btnRegen').addEventListener('click', () => {
  // 丢掉预拉的下一段（用户想换新的，旧预拉的没用了）
  nextBlock = null;
  // 清队列，让下个 block 立即生效
  queue = [];
  prefetching = false;
  send('request_block');
  setStatus('AI // REGEN...');
  showLoading('thinking');
});

// ============================================================
// 聊天
// ============================================================
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  pushUserLog(text);
  // 把当前播放上下文一起带过去，让 DJ 能"看见"在播什么
  send('chat', {
    text,
    nowPlaying: current ? { title: current.title, artist: current.artist } : null,
    upNext: queue.slice(0, 5).map((s) => ({ title: s.title, artist: s.artist })),
  });
  chatInput.value = '';
});

// 清空对话历史
const btnClearChat = $('btnClearChat');
if (btnClearChat) {
  btnClearChat.addEventListener('click', () => {
    if (!confirm('清空与 Vox 的全部对话历史？\n（只清对话，不影响你的口味画像和播放历史）')) return;
    send('clear_chat');
  });
}

// ============================================================
// 当前播放歌的"喜欢 / 不感兴趣"按钮
// ============================================================
const btnLike = $('btnLike');
const btnDislike = $('btnDislike');
let currentRating = null; // 'like' | 'dislike' | null，只对"current 这首"有效

function rateCurrent(wantRating) {
  if (!current) {
    setStatus('还没开始播，等第一首歌出来');
    return;
  }
  // 再点一次相同 = 取消
  const newRating = currentRating === wantRating ? null : wantRating;
  currentRating = newRating;
  refreshRateButtons();
  // 点击反馈：flash 一下
  const btn = wantRating === 'like' ? btnLike : btnDislike;
  btn.classList.remove('just-clicked');
  void btn.offsetWidth; // 强制 reflow 重启动画
  btn.classList.add('just-clicked');

  send('rate_current', {
    title: current.title,
    artist: current.artist,
    rating: newRating,
  });
}

function refreshRateButtons() {
  btnLike.classList.toggle('active', currentRating === 'like');
  btnDislike.classList.toggle('active', currentRating === 'dislike');
}

if (btnLike) btnLike.addEventListener('click', () => rateCurrent('like'));
if (btnDislike) btnDislike.addEventListener('click', () => rateCurrent('dislike'));

// ============================================================
// 播放历史 Modal
// ============================================================
let historyCache = []; // 最近一次拉到的历史，按 id → item 索引用

historyBtn.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyModal.querySelector('.history-backdrop').addEventListener('click', closeHistory);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && historyModal.classList.contains('show')) closeHistory();
});

async function openHistory() {
  historyModal.classList.add('show');
  historyList.innerHTML = '<div class="history-empty">加载中...</div>';
  try {
    const res = await fetch('/api/history?n=80');
    const { history } = await res.json();
    historyCache = history || [];
    renderHistory();
  } catch (e) {
    historyList.innerHTML = '<div class="history-empty">拉取历史失败</div>';
    console.error(e);
  }
}

function closeHistory() {
  historyModal.classList.remove('show');
}

function renderHistory() {
  if (!historyCache.length) {
    historyList.innerHTML = '<div class="history-empty">还没播过歌</div>';
    return;
  }
  historyList.innerHTML = historyCache.map((h, i) => {
    const likeOn = h.rating === 'like' ? 'active like' : '';
    const disOn = h.rating === 'dislike' ? 'active dislike' : '';
    const skipTag = !h.played ? '<span class="skip-badge">SKIPPED</span>' : '';
    return `
      <div class="history-item" data-id="${h.id}">
        <div class="idx">${String(i + 1).padStart(2, '0')}</div>
        <div class="info">
          <div class="t">${esc(h.title)}${skipTag}</div>
          <div class="a">${esc(h.artist)}</div>
        </div>
        <div class="time">${fmtRelTime(h.ts)}</div>
        <div class="rate">
          <button class="btn-rate ${likeOn}" data-rating="like" title="喜欢">♥</button>
          <button class="btn-rate ${disOn}" data-rating="dislike" title="不感兴趣">✕</button>
        </div>
      </div>
    `;
  }).join('');

  // 事件委托
  historyList.querySelectorAll('.btn-rate').forEach((btn) => {
    btn.addEventListener('click', onRateClick);
  });
}

function onRateClick(e) {
  const btn = e.currentTarget;
  const row = btn.closest('.history-item');
  const id = Number(row.dataset.id);
  const wantRating = btn.dataset.rating; // 'like' / 'dislike'
  const item = historyCache.find((h) => h.id === id);
  if (!item) return;
  // 再点一次相同的评分 = 取消
  const newRating = item.rating === wantRating ? null : wantRating;
  // 乐观更新 UI
  item.rating = newRating;
  renderHistory();
  send('rate_song', { id, rating: newRating });
}

function fmtRelTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const now = Date.now();
  const dt = (now - t) / 1000;
  if (dt < 60) return '刚刚';
  if (dt < 3600) return Math.floor(dt / 60) + ' 分钟前';
  if (dt < 86400) return Math.floor(dt / 3600) + ' 小时前';
  if (dt < 86400 * 7) return Math.floor(dt / 86400) + ' 天前';
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

// ============================================================
// 画像冷启动 Modal（首次配置 / 重置画像）
// ============================================================
let playlistCache = []; // 拉到的歌单列表
let playlistPicks = {}; // { [playlistId]: {kind, n} }  用户的选择

resetTasteBtn.addEventListener('click', () => openBootstrapModal(true));
bootstrapClose.addEventListener('click', closeBootstrapModal);
bootstrapModal.querySelector('.history-backdrop').addEventListener('click', closeBootstrapModal);
bootstrapGoBtn.addEventListener('click', onBootstrapSubmit);
bootstrapDoneBtn.addEventListener('click', () => location.reload());

async function openBootstrapModal(isReset) {
  bootstrapTitle.textContent = isReset ? 'RESET TASTE' : 'INITIALIZE TASTE';
  bootstrapStepPick.style.display = '';
  bootstrapStepProgress.style.display = 'none';
  bootstrapStepDone.style.display = 'none';
  bootstrapModal.classList.add('show');
  bootstrapPlaylists.innerHTML = '<div class="history-empty">正在拉取你的歌单...</div>';
  playlistPicks = {};
  try {
    const res = await fetch('/api/playlists');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { playlists } = await res.json();
    playlistCache = playlists || [];
    if (!playlistCache.length) {
      bootstrapPlaylists.innerHTML = '<div class="history-empty">没有拉到歌单。检查 QQMusicApi 是否在跑、cookie 是否有效。</div>';
      return;
    }
    renderPlaylistPicker();
  } catch (e) {
    bootstrapPlaylists.innerHTML = `<div class="history-empty">拉取失败：${esc(e.message)}</div>`;
  }
}

function closeBootstrapModal() {
  // 生成中不允许关闭，避免误操作
  if (bootstrapStepProgress.style.display !== 'none' &&
      bootstrapStepDone.style.display === 'none') {
    if (!confirm('画像正在生成中，关闭只是隐藏弹窗，后台仍会继续。确认吗？')) return;
  }
  bootstrapModal.classList.remove('show');
}

function renderPlaylistPicker() {
  bootstrapPlaylists.innerHTML = playlistCache.map((p) => {
    // 默认猜一个合理的策略：<=200 首 → all，否则 → random 100
    const suggested = p.songCount <= 200 ? { kind: 'all' } : { kind: 'random', n: 100 };
    return `
      <div class="bs-item" data-pid="${p.playlistId}">
        <div class="chk" data-action="toggle"></div>
        <div class="pl-info">
          <div class="pl-name">${esc(p.name)}${p.isFavorite ? ' ♥' : ''}</div>
          <div class="pl-meta">${p.songCount} 首</div>
        </div>
        <div class="pl-strategy">
          <select data-action="kind">
            <option value="all" ${suggested.kind === 'all' ? 'selected' : ''}>全量</option>
            <option value="random" ${suggested.kind === 'random' ? 'selected' : ''}>随机 N</option>
            <option value="front">前 N</option>
          </select>
          <input type="number" data-action="n" min="1" max="500" value="${suggested.n || 100}" ${suggested.kind === 'all' ? 'disabled' : ''}>
        </div>
      </div>
    `;
  }).join('');

  // 事件委托
  bootstrapPlaylists.querySelectorAll('.bs-item').forEach((row) => {
    const pid = row.dataset.pid; // 字符串 id，netease 可能是大数
    const chk = row.querySelector('.chk');
    const kindSel = row.querySelector('select');
    const nInput = row.querySelector('input');

    chk.addEventListener('click', () => {
      if (playlistPicks[pid]) {
        delete playlistPicks[pid];
      } else {
        playlistPicks[pid] = { kind: kindSel.value, n: Number(nInput.value) || 100 };
      }
      row.classList.toggle('picked', !!playlistPicks[pid]);
      chk.classList.toggle('on', !!playlistPicks[pid]);
      refreshPickStats();
    });

    kindSel.addEventListener('change', () => {
      const kind = kindSel.value;
      nInput.disabled = kind === 'all';
      if (playlistPicks[pid]) {
        playlistPicks[pid].kind = kind;
        playlistPicks[pid].n = Number(nInput.value) || 100;
        refreshPickStats();
      }
    });
    nInput.addEventListener('input', () => {
      if (playlistPicks[pid]) {
        playlistPicks[pid].n = Number(nInput.value) || 100;
        refreshPickStats();
      }
    });
  });

  refreshPickStats();
}

function refreshPickStats() {
  const picked = Object.entries(playlistPicks);
  if (!picked.length) {
    bootstrapPickStats.textContent = '未选';
    bootstrapGoBtn.disabled = true;
    return;
  }
  // 估算抽出的歌数
  let est = 0;
  picked.forEach(([pid, cfg]) => {
    const p = playlistCache.find((x) => String(x.playlistId) === String(pid));
    if (!p) return;
    if (cfg.kind === 'all') est += p.songCount;
    else est += Math.min(p.songCount, cfg.n || 100);
  });
  bootstrapPickStats.textContent = `已选 ${picked.length} 个歌单，预计 ~${est} 首样本`;
  bootstrapGoBtn.disabled = false;

  if (est > 600) {
    bootstrapPickStats.textContent += '（样本太多大脑会慢，建议 ≤ 400）';
  }
}

function onBootstrapSubmit() {
  const picks = Object.entries(playlistPicks).map(([pid, cfg]) => {
    const p = playlistCache.find((x) => String(x.playlistId) === String(pid));
    return {
      playlistId: p.playlistId,
      name: p.name,
      kind: cfg.kind,
      n: cfg.kind === 'all' ? undefined : (cfg.n || 100),
    };
  });
  if (!picks.length) return;
  bootstrapStepPick.style.display = 'none';
  bootstrapStepProgress.style.display = '';
  bootstrapStage.textContent = 'STARTING';
  bootstrapDetail.textContent = '正在启动...';
  bootstrapBarFill.style.width = '1%';
  bootstrapLog.innerHTML = '';
  send('bootstrap_start', { picks });
}

function handleBootstrapProgress(evt) {
  // evt: { stage, detail, pct }
  if (evt.stage === 'error') {
    bootstrapStage.textContent = 'ERROR';
    bootstrapDetail.textContent = evt.detail || '出错了';
    bootstrapDetail.style.color = 'var(--warn, #ffb800)';
    appendBootstrapLog(evt.detail || '出错了', true);
    return;
  }
  bootstrapStage.textContent = String(evt.stage || '').toUpperCase();
  if (evt.detail) {
    bootstrapDetail.textContent = evt.detail;
    bootstrapDetail.style.color = 'var(--neon-pri)';
    appendBootstrapLog(evt.detail, false);
  }
  if (typeof evt.pct === 'number') {
    bootstrapBarFill.style.width = Math.min(100, Math.max(0, evt.pct)) + '%';
  }
}

function appendBootstrapLog(text, isErr) {
  const row = document.createElement('div');
  row.className = 'log-row' + (isErr ? ' err' : '');
  row.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  bootstrapLog.appendChild(row);
  bootstrapLog.scrollTop = bootstrapLog.scrollHeight;
}

function handleBootstrapDone(info) {
  bootstrapStepProgress.style.display = 'none';
  bootstrapStepDone.style.display = '';
  bootstrapDoneDetail.textContent =
    `共耗时 ${Math.round(info.durationMs / 1000)}s，样本 ${info.uniqueCount} 首。`;
}

// 启动后检测是否需要首次画像设置
async function checkBootstrapNeeded() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const health = await res.json();
    if (!health.hasTaste) {
      // 自动弹首次设置
      setTimeout(() => openBootstrapModal(false), 300);
    }
  } catch (e) {
    console.warn('[bootstrap] health check fail', e);
  }
}

// ============================================================
// UI
// ============================================================
function setStatus(text, live = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', !!live);
}
function showDjSay(text) {
  if (!text) return;
  djSayEl.textContent = text;
  clearTimeout(djSayTimer);
  djSayTimer = setTimeout(() => { djSayEl.textContent = ''; }, 14000);
}
function renderQueue() {
  const all = [];
  if (current) all.push({ ...current, _now: true });
  all.push(...queue);
  queueEl.innerHTML = all.map((s, i) => `
    <li class="${s._now ? 'now' : ''}">
      <span>${esc(s.title)} <span class="meta-tag">— ${esc(s.artist)}</span></span>
      <span class="meta-tag">${s._now ? '> NOW' : '#' + String(i).padStart(2, '0')}</span>
    </li>
  `).join('');
}
function pushUserLog(text) { appendBubble('user', text); }
function pushDjLog(text) { appendBubble('dj', text); }
// 系统旁白（"下一段已备好"之类的灰字居中）
function pushSysLog(text) { appendBubble('sys', text); }

/**
 * 添加一个气泡；返回气泡的 text 节点用于流式追加
 */
function appendBubble(role, text) {
  const row = document.createElement('div');
  row.className = 'row ' + role;

  // sys 旁白不要头像
  if (role !== 'sys') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? 'ME' : 'VOX';
    row.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text || '';
  row.appendChild(bubble);

  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

// ============================================================
// 流式 DJ 回话
// ============================================================
// 正在流式接收中的气泡，key=replyId
const streamingBubbles = new Map();

function startStreamingBubble(id) {
  const row = document.createElement('div');
  row.className = 'row dj';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'VOX';
  row.appendChild(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'bubble thinking';
  // "…" 三个点动画
  bubble.innerHTML = '<span></span><span></span><span></span>';
  row.appendChild(bubble);

  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;

  streamingBubbles.set(id, { bubble, text: '', firstDelta: true });
}

function appendStreamingBubble(id, delta) {
  const entry = streamingBubbles.get(id);
  if (!entry) return;
  if (entry.firstDelta) {
    // 第一个 delta 来了 —— 清掉 "…" 切换为打字模式
    entry.bubble.classList.remove('thinking');
    entry.bubble.classList.add('streaming');
    entry.bubble.innerHTML = '';
    entry.firstDelta = false;
  }
  entry.text += delta;
  entry.bubble.textContent = entry.text;
  // 自动滚到底（只在靠近底部时才滚，避免用户翻上去看历史时被打断）
  if (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80) {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  // 同时更新顶部 dj-say 字幕
  showDjSay(entry.text);
}

function finishStreamingBubble(id, finalText, isError) {
  const entry = streamingBubbles.get(id);
  if (!entry) {
    // 流式没建起来就结束（例如出错时 reply_start 还没发就 end 了）
    appendBubble('dj', finalText || '（出错了）');
    return;
  }
  entry.bubble.classList.remove('streaming', 'thinking');
  // 用 server 给的 final 文本覆盖（防止流式漏字）
  if (finalText) {
    entry.bubble.textContent = finalText;
  }
  if (isError) {
    entry.bubble.style.borderColor = 'var(--warn, #ffb800)';
    entry.bubble.style.color = 'var(--warn, #ffb800)';
  }
  streamingBubbles.delete(id);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (finalText) showDjSay(finalText);
}
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// 天气主题 + 特效
// ============================================================
function applyWeather(weather) {
  if (!weather) {
    weatherEl.textContent = '';
    if (themePref === 'auto') setTheme('cyber');
    return;
  }
  weatherEl.innerHTML = `${esc(weather.text)} · ${weather.temp}°C`;
  // 用户手动锁定了主题就不改
  if (themePref === 'auto') {
    setTheme(weather.theme || 'cyber');
  }
}

function setTheme(name) {
  if (currentTheme === name) return;
  currentTheme = name;
  document.body.className = 'theme-' + name;
  renderFx(name);
  updateThemePopupActive();
}

function updateThemePopupActive() {
  themePopup.querySelectorAll('.item').forEach((el) => {
    const t = el.dataset.theme;
    const active =
      (themePref === 'auto' && t === 'auto') ||
      (themePref !== 'auto' && t === currentTheme);
    el.classList.toggle('active', active);
  });
}

// 主题切换器交互
themeSwitch.addEventListener('click', (e) => {
  e.stopPropagation();
  themePopup.classList.toggle('open');
  updateThemePopupActive();
});

document.addEventListener('click', (e) => {
  if (!themePopup.contains(e.target) && e.target !== themeSwitch) {
    themePopup.classList.remove('open');
  }
});

themePopup.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  const t = item.dataset.theme;
  themePref = t;
  localStorage.setItem(THEME_PREF_KEY, t);

  if (t === 'auto') {
    // 立刻按当前已知天气切回；若没天气，用 cyber 兜底
    const weatherText = weatherEl.textContent;
    if (weatherText) {
      // weather 主题在下一次 block 推过来时会刷新
      // 这里先尝试从 weatherInfo 推断不太靠谱，直接维持当前主题等下次 block 自然刷新
    } else {
      setTheme('cyber');
    }
  } else {
    setTheme(t);
  }
  updateThemePopupActive();
  themePopup.classList.remove('open');
});

function renderFx(theme) {
  fxLayer.innerHTML = '';
  switch (theme) {
    case 'rain':   makeRain(80); break;
    case 'storm':  makeRain(120); makeLightning(); break;
    case 'snow':   makeSnow(40); break;
    case 'fog':    makeFog(); break;
    case 'sun':    makeSunray(); break;
    case 'night':  makeStars(40); break;
    case 'overcast':
    case 'cloud':  makeStars(15); break;
    case 'cyber':
    default:       makeStars(20); break;
  }
}

function makeRain(n) {
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'raindrop';
    d.style.left = Math.random() * 100 + '%';
    d.style.height = (10 + Math.random() * 30) + 'px';
    d.style.animationDuration = (0.4 + Math.random() * 0.8) + 's';
    d.style.animationDelay = (Math.random() * 2) + 's';
    fxLayer.appendChild(d);
  }
}

function makeSnow(n) {
  const chars = ['❄', '✦', '✧', '·'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'snowflake';
    s.textContent = chars[Math.floor(Math.random() * chars.length)];
    s.style.left = Math.random() * 100 + '%';
    s.style.fontSize = (8 + Math.random() * 12) + 'px';
    s.style.animationDuration = (5 + Math.random() * 8) + 's';
    s.style.animationDelay = (Math.random() * 5) + 's';
    s.style.opacity = .4 + Math.random() * .5;
    fxLayer.appendChild(s);
  }
}

function makeStars(n) {
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.width = s.style.height = (1 + Math.random() * 2) + 'px';
    s.style.animationDuration = (2 + Math.random() * 4) + 's';
    s.style.animationDelay = (Math.random() * 3) + 's';
    fxLayer.appendChild(s);
  }
}

function makeLightning() {
  const l = document.createElement('div');
  l.className = 'lightning';
  fxLayer.appendChild(l);
}

function makeSunray() {
  const s = document.createElement('div');
  s.className = 'sunray';
  fxLayer.appendChild(s);
  // 也加点星 / 灰尘
  makeStars(15);
}

function makeFog() {
  // 多层缓慢飘动的半透明雾
  for (let i = 0; i < 3; i++) {
    const f = document.createElement('div');
    f.style.position = 'absolute';
    f.style.inset = '0';
    f.style.background = `radial-gradient(ellipse at ${20 + i * 30}% ${30 + i * 20}%, rgba(180,180,200,.08) 0%, transparent 60%)`;
    fxLayer.appendChild(f);
  }
}

// ============================================================
// 启动
// ============================================================
// 应用持久化的主题偏好
if (themePref !== 'auto') {
  setTheme(themePref);
} else {
  renderFx('cyber');
}
updateThemePopupActive();
connect();
checkBootstrapNeeded();
setupTooltips();
setupChatResize();

// ============================================================
// 全局 Tooltip（hover data-tip 元素显示中文说明）
// ============================================================
function setupTooltips() {
  const tip = $('tip');
  if (!tip) return;
  let showTimer = null;
  let currentTarget = null;

  const showTip = (target) => {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    // 先放进来让浏览器算宽高
    tip.style.visibility = 'hidden';
    tip.classList.add('show');
    tip.classList.remove('below');

    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const margin = 10;

    // 默认放在目标上方居中
    let top = rect.top - tipRect.height - margin;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;

    // 如果上方空间不够 → 放下方
    if (top < 4) {
      top = rect.bottom + margin;
      tip.classList.add('below');
    }
    // 水平溢出保护
    if (left < 8) left = 8;
    const maxLeft = window.innerWidth - tipRect.width - 8;
    if (left > maxLeft) left = maxLeft;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.visibility = 'visible';
  };

  const hideTip = () => {
    tip.classList.remove('show');
    currentTarget = null;
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  };

  // mouseover 冒泡更稳（mouseenter 不冒泡，事件委托不好做）
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) return;
    if (target === currentTarget) return;
    currentTarget = target;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => showTip(target), 350);
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) return;
    // 离开到子元素不算离开
    if (target.contains(e.relatedTarget)) return;
    if (target === currentTarget) hideTip();
  });

  // 滚动 / 点击 / 按键 → 立刻隐藏（避免 tip 和元素错位）
  window.addEventListener('scroll', hideTip, true);
  document.addEventListener('mousedown', hideTip);
  document.addEventListener('keydown', hideTip);
}

// ============================================================
// 聊天区高度可拖动调整
// ============================================================
function setupChatResize() {
  const CHAT_HEIGHT_KEY = 'vox.chatLogHeight';
  const CHAT_HEIGHT_MIN = 120;
  const CHAT_HEIGHT_MAX_RATIO = 0.7; // 最多占屏高 70%

  const handle = $('chatResizeHandle');
  if (!handle) {
    console.warn('[chat-resize] handle element not found');
    return;
  }
  console.log('[chat-resize] ready');

  // 应用持久化的高度
  const saved = Number(localStorage.getItem(CHAT_HEIGHT_KEY));
  if (saved && saved >= CHAT_HEIGHT_MIN) {
    applyChatHeight(saved);
  }

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  const onMove = (e) => {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const delta = y - startY; // 把手在下方：鼠标往下 → 加高度
    const maxH = Math.floor(window.innerHeight * CHAT_HEIGHT_MAX_RATIO);
    const h = Math.max(CHAT_HEIGHT_MIN, Math.min(maxH, startHeight + delta));
    applyChatHeight(h);
    if (e.cancelable) e.preventDefault();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-chat');
    const final = getComputedChatHeight();
    if (final) localStorage.setItem(CHAT_HEIGHT_KEY, String(final));
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
    window.removeEventListener('touchcancel', onUp);
  };

  const onDown = (e) => {
    dragging = true;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startHeight = getComputedChatHeight();
    handle.classList.add('dragging');
    document.body.classList.add('resizing-chat');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
    e.preventDefault();
    e.stopPropagation();
    console.log('[chat-resize] drag start, h =', startHeight);
  };

  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });

  // 双击把手 = 重置为默认高度
  handle.addEventListener('dblclick', () => {
    localStorage.removeItem(CHAT_HEIGHT_KEY);
    applyChatHeight(280);
  });
}

function applyChatHeight(h) {
  document.documentElement.style.setProperty('--chat-log-height', h + 'px');
}

function getComputedChatHeight() {
  const styles = getComputedStyle(document.documentElement);
  const v = styles.getPropertyValue('--chat-log-height').trim();
  if (v) return parseInt(v, 10) || 280;
  // 从 chatLog 实际高度读
  return chatLog.clientHeight || 280;
}

// ============================================================
// QQ Cookie 失效弹窗
// ============================================================
function showQQAuthModal(reason) {
  const modal = $('qqAuthModal');
  if (!modal) return;
  const reasonEl = $('qqAuthReason');
  if (reasonEl) {
    reasonEl.textContent = reason ? `原因：${reason}` : '（未报告具体原因）';
  }
  const msg = $('qqAuthMsg');
  if (msg) {
    msg.textContent = '粘贴后点"更新并恢复"';
    msg.className = 'qqauth-msg';
  }
  const submit = $('qqAuthSubmit');
  if (submit) submit.disabled = false;
  modal.classList.add('show');
  // 自动 focus textarea（方便直接粘贴）
  setTimeout(() => $('qqAuthInput')?.focus(), 50);
}

function hideQQAuthModal() {
  const modal = $('qqAuthModal');
  if (!modal) return;
  modal.classList.remove('show');
  // 清掉输入框内容，避免 cookie 残留在 DOM
  const input = $('qqAuthInput');
  if (input) input.value = '';
}

function handleQQCookieUpdateResult(result) {
  const msg = $('qqAuthMsg');
  const submit = $('qqAuthSubmit');
  if (submit) submit.disabled = false;
  if (!msg) return;

  if (result?.ok) {
    msg.textContent = result.warning || '✅ 已更新，恢复推荐中…';
    msg.className = 'qqauth-msg ok';
    // 2 秒后自动关闭 + 触发新 block
    setTimeout(() => {
      hideQQAuthModal();
      // 主动请求一段新的（之前被熔断拒绝了）
      send('request_block', {});
    }, 1800);
  } else {
    msg.textContent = '❌ ' + (result?.error || '更新失败');
    msg.className = 'qqauth-msg err';
  }
}

function setupQQAuthUI() {
  const submit = $('qqAuthSubmit');
  const input = $('qqAuthInput');
  const closeBtn = $('qqAuthClose');
  const backdrop = document.querySelector('#qqAuthModal .history-backdrop');

  const doSubmit = () => {
    const raw = (input?.value || '').trim();
    if (!raw) {
      const msg = $('qqAuthMsg');
      if (msg) {
        msg.textContent = '请先粘贴 cookie';
        msg.className = 'qqauth-msg err';
      }
      return;
    }
    if (submit) submit.disabled = true;
    const msg = $('qqAuthMsg');
    if (msg) {
      msg.textContent = '正在推送并验证…';
      msg.className = 'qqauth-msg';
    }
    send('qq_cookie_update', { cookie: raw });
  };

  submit?.addEventListener('click', doSubmit);
  // Cmd/Ctrl + Enter 快速提交
  input?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      doSubmit();
    }
  });

  // 关闭按钮 & 点背景：允许关闭但提示
  const softClose = () => {
    hideQQAuthModal();
    setStatus('已忽略 cookie 过期 // 手动点 NEW BLOCK 时会再次弹出');
  };
  closeBtn?.addEventListener('click', softClose);
  backdrop?.addEventListener('click', softClose);
}

setupQQAuthUI();

// ============================================================
// 懒加载 mp3 直链：server 拿到后广播，前端对号入座
// ============================================================
function handleSongUrlReady({ songId, url }) {
  if (!url) return;
  // 1) 如果就是当前正在等的歌（current.url 空、songId 对上）→ 立刻启播
  if (current && !current.url && current.songId === songId) {
    console.log(`[lazy-url] ✓ current 拿到直链，启播: ${current.title}`);
    if (lazyUrlTimer) { clearTimeout(lazyUrlTimer); lazyUrlTimer = null; }
    current.url = url;
    audio.src = url;
    audio.play()
      .then(() => {
        setStatus('SYS // ONLINE', true);
        document.title = `▶ ${current.title} — ${current.artist} // VOX`;
      })
      .catch((err) => {
        console.warn('[lazy-url] autoplay 被拦', err.name);
        if (err.name === 'NotAllowedError') {
          setStatus('CLICK ▶ TO PLAY');
        }
      });
    return;
  }
  // 2) 队列里对应那首 → 填 url（播到时就不用等了）
  const target = queue.find((s) => s.songId === songId);
  if (target && !target.url) {
    target.url = url;
    console.log(`[lazy-url] queue 里 "${target.title}" 更新 url`);
  }
}

function handleSongUrlFailed({ idx, songId, reason }) {
  console.warn(`[lazy-url] 失败 idx=${idx} songId=${songId} reason=${reason}`);
  // 如果是当前正在等的歌 → 直接跳下一首
  if (current && !current.url && current.songId === songId) {
    if (lazyUrlTimer) { clearTimeout(lazyUrlTimer); lazyUrlTimer = null; }
    setStatus('SKIP // 直链拿不到');
    pushSysLog(`"${current.title}" 拿不到直链（${reason === 'auth' ? 'cookie 问题' : 'VIP/版权'}），跳过`);
    current = null; // 避免 ended 事件被误触
    playNext();
    return;
  }
  // 队列里那首 → 从队列移除（避免将来播到还等半天）
  const before = queue.length;
  queue = queue.filter((s) => s.songId !== songId);
  if (queue.length < before) {
    console.log(`[lazy-url] 从队列移除 songId=${songId}`);
    renderQueue();
  }
}

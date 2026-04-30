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

// 主题模式: 'auto' = 跟天气, 其他 = 手动锁定
const THEME_PREF_KEY = 'claudio.themePref';
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

// ============================================================
// Loading 状态机
// ============================================================
const ETA_KEY = 'claudio.lastBlockMs';
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
      sub: '正在连接 Claudio 大脑，准备给你编一段歌单...',
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
    showLoading('init');
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
    case 'status':
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
        try { audio.pause(); } catch {}
        consumeBlock(data);
        break;
      }

      // 当前还在播 + 队列还有歌 → 这是 prefetch，先收着
      if (current && queue.length > 0) {
        nextBlock = data;
        console.log(`[prefetch] 收到下一段（${data.songs.length} 首），等当前段播完`);
        prefetching = false;
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
    case 'error':
      setStatus('ERR // ' + data.message);
      hideLoading();
      console.error(data);
      break;
  }
}

// ============================================================
// 播放
// ============================================================
function playNext() {
  if (!queue.length) {
    // 队列见底，请求下一段；等待期间显示 loading
    showLoading('thinking');
    send('request_block');
    return;
  }
  current = queue.shift();
  audio.src = current.url;
  audio.play().catch(() => setStatus('CLICK ▶ TO PLAY'));

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

  renderQueue();
  document.title = `▶ ${current.title} — ${current.artist} // CLAUDIO`;
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
});
audio.addEventListener('error', () => {
  console.warn('audio error, skip', current);
  playNext();
});
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
audio.addEventListener('play', () => { $('btnPlay').textContent = '⏸ PAUSE'; });
audio.addEventListener('pause', () => { $('btnPlay').textContent = '▶ PLAY'; });

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
  send('chat', { text });
  chatInput.value = '';
});

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
function pushUserLog(text) { appendLog('user', 'YOU', text); }
function pushDjLog(text) { appendLog('dj', 'DJ', text); }
function appendLog(role, label, text) {
  const div = document.createElement('div');
  div.className = 'row ' + role;
  div.innerHTML = `<span class="role">${label}</span><span class="text">${esc(text)}</span>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
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

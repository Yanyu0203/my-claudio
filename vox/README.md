# Vox · 主项目

> 这是 Vox 的实际代码目录。外层 `my-vox/README.md` 是设计文档。

当前进度：**步骤 1/3 · QQ 音乐客户端**

---

## 目录结构（当前）

```
vox/
├── package.json
├── .env.example
├── src/
│   └── qqmusic.js              ← QQ 音乐统一客户端（搜歌/直链/歌单）
└── scripts/
    └── verify-qqmusic.js       ← 命令行验证脚本
```

后面会逐步加：

```
├── src/
│   ├── codebuddy.js            ← 调 CodeBuddy CLI（下一步）
│   ├── context.js              ← 拼 prompt
│   ├── resolver.js             ← 歌名 → mp3 直链
│   ├── scheduler.js            ← 时段触发
│   └── state.js                ← SQLite 封装
├── server.js                   ← 入口
├── scripts/
│   └── bootstrap-taste.js      ← 冷启动：拉歌单 → 写 taste.md
├── data/
│   ├── taste.md
│   └── state.db
└── pwa/
    ├── index.html
    └── app.js
```

---

## 第一步：先验证 QQ 音乐能力

### 准备
1. 已经按外层 README 跑通 QQMusicApi（`http://localhost:3300`）
2. 已经通过 `/user/setCookie` 把你的 cookie 喂给了 QQMusicApi

### 安装 + 配置
```bash
cd vox
npm install
cp .env.example .env
# 打开 .env，确认 QQ_UIN 是你的 QQ 号
```

### 跑验证
```bash
npm run verify:qq
```

预期看到 4 个 ✅：
- 搜歌返回多条结果
- 第一条歌能拿到 mp3 直链
- 拉到你的歌单列表
- 第一个歌单能拉出歌曲列表

---

## 音乐 provider 对外 API

```js
import { createProvider } from './src/music/index.js';

// 选择音乐源：'qq' | 'netease'（后续支持）
const music = createProvider(process.env.MUSIC_PROVIDER || 'qq', {
  apiBase: 'http://localhost:3300',      // 仅 qq 需要
  userId: process.env.QQ_UIN,            // qq 传 QQ 号；netease 传用户 id
});

// 搜歌
const songs = await music.search('晴天 周杰伦', 5);
// → [{ songId, title, artist, album, cover, duration }]

// 拿 mp3 直链
const { url, authFail } = await music.getPlayUrl(songs[0].songId);
// authFail=true 表示 cookie 过期

// 拉我的所有歌单
const playlists = await music.getMyPlaylists();
// → [{ playlistId, name, cover, songCount, isFavorite }]

// 拉单个歌单详情
const detail = await music.getPlaylistSongs(playlists[0].playlistId);
// → { name, total, songs: [...] }
```

字段命名是**跨 provider 统一的中性字段**，各 provider 内部自己映射原生字段（QQ 的 songmid、Netease 的 id 都映射成 songId）。

---

## 设计要点

- **搜歌**直连腾讯 `musicu.fcg` 新接口（不依赖本地 QQMusicApi 的废弃搜索）
- **取直链 / 拉歌单**走本地 QQMusicApi（cookie 已托管在那边，省事）
- 后续模块（resolver / context）只 import 这一个文件，不直接接触 QQ 接口细节

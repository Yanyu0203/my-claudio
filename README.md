# 🎧 Vox · 你的私人 AI 电台

> 一个跑在本地的 AI DJ：读你的音乐口味、感知当下时间天气，自动编排歌单 + 像电台主持人一样跟你说话。
>
> **大脑**：CodeBuddy CLI / Claude Code（任选其一） · **曲库**：QQ 音乐 / 网易云音乐（任选其一） · **天气**：和风 · **播放**：浏览器 PWA

![平台](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blueviolet) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![版本](https://img.shields.io/badge/version-v1.0.0-ff2a6d) ![赛博朋克](https://img.shields.io/badge/UI-cyberpunk-ff2a6d)

---

## 🤖 最快上手：让你的 AI 帮你装

> 装了 [CodeBuddy CLI](https://www.codebuddy.ai) 或者 Claude Code？**直接复制下面这段话发给它**：

```text
请你阅读 ./CLAUDE.md，按照里面的 SOP 帮我把 Vox 跑起来。
我会在你需要时手动配合（比如登录、复制 cookie、注册账号等）。
请遇到 ⚠️STOP 标记时停下来等我。
```

它会读完 [`CLAUDE.md`](./CLAUDE.md)，**自动执行**所有可自动化的步骤（克隆音乐 API 仓库、装依赖、修复源、启动服务、整理 cookie 等），遇到必须人做的（登录、复制 cookie / 扫码）会暂停问你。

完整流程预计 **15-30 分钟**（绝大部分是等你登录账号的时间，**网易云模式下是扫码 30 秒**）。

---

## 🛠 自己手动装

不想用 AI？看 **[`SETUP.md`](./SETUP.md)** 一步步来。第一次跑 `./start.sh`（macOS/Linux）或 `.\start.ps1`（Windows），会**弹出菜单让你选音乐源**，全程交互式。

---

## 它能干嘛

打开 [http://localhost:8080](http://localhost:8080)，进入一个赛博朋克风的播放器：

- ☀️ **早上 9 点打开** → 自动播一段轻快歌单 + DJ 一句早安播报
- 🌧️ **下雨天** → UI 切到雨夜主题，DJ 给你换"雨天慵懒"风格
- 🎤 **你在聊天框输入"想听点 City Pop"** → 立即重选 5 首
- 📝 **你说"以后少给我放 R&B"** → 永久写入画像，未来选歌避开
- 🔁 **挂着不管** → 自动衔接，像真电台一样持续编排

---

## 🎵 两种音乐源任选其一

第一次跑 `start.sh` / `start.ps1` 会自动弹出菜单选：

| | QQ 音乐 | 网易云音乐 ⭐推荐 |
|---|---|---|
| 登录方式 | 浏览器 F12 复制 cookie（5 分钟） | **手机 App 扫码**（30 秒） |
| 额外服务 | 本地起 QQMusicApi（端口 3300） | 无（作为 npm 模块进程内运行） |
| 适合 | QQ 音乐里已有大量歌单 | 网易云重度用户 / 想省心 |
| 配置项 | `MUSIC_PROVIDER=qq` + `QQ_UIN` | `MUSIC_PROVIDER=netease`（uid 扫码后自动填） |

> 想换源？编辑 `vox/.env` 删掉 `MUSIC_PROVIDER=` 那行重启即可，或跑 `cd vox && npm run setup:provider`。

---

## 一张图看懂架构

```
┌──────────────────────────────────────────────────────┐
│  外部依赖                                              │
│  ┌────────────┐ ┌────────────────────┐ ┌──────────┐ │
│  │ AI CLI     │ │ QQMusicApi         │ │ 和风天气 │ │
│  │ (大脑)     │ │   或 api-enhanced  │ │ (可选)   │ │
│  │            │ │   (二选一)         │ │          │ │
│  └────────────┘ └────────────────────┘ └──────────┘ │
└──────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────┐
│  Vox 中枢 (localhost:8080, Node.js)                  │
│  bridge.js → music/* → resolver.js                   │
│  (调大脑) → (统一 provider 接口) → (歌名→mp3 直链)   │
│                                                       │
│  state.js (SQLite 历史/对话/缓存)                    │
│  weather.js (天气 → 主题切换)                         │
│  musicauth.js (cookie 失效熔断 + 扫码登录)           │
└──────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────┐
│  浏览器 PWA (赛博朋克风)                              │
│  HTML5 audio + WebSocket 实时队列 + 聊天             │
└──────────────────────────────────────────────────────┘
```

### 核心流程

```
你打开浏览器
    ↓
Vox 拼 prompt（你的画像 + 当前时间 + 天气 + 最近播过的）
    ↓
AI CLI 思考 → 返回 {say, play[10]}
    ↓
当前 provider（QQ 或网易云）解析每首歌 → 拿到 mp3 直链（前 2 首预热，其余懒加载）
    ↓
WebSocket 推给浏览器 → 一首接一首播
    ↓
你聊天反馈 → 立即换歌 / 写进永久画像
```

---

## 项目结构

```
my-claudio/                ← 你 git clone 下来的目录
├── README.md                  ← 本文件
├── SETUP.md                   ← 详细分步安装手册（人友好）
├── CLAUDE.md                  ← 给 AI 看的执行 SOP（让 CodeBuddy 帮你跑）
├── start.sh                   ← Mac/Linux 一键启动（首次会引导选音乐源）
├── start.ps1                  ← Windows 一键启动
├── vox/                       ← 主程序代码（这是核心）
│   ├── server.js
│   ├── src/
│   │   ├── music/             ← provider 抽象层（qq.js / netease.js / index.js）
│   │   ├── musicauth.js       ← cookie 失效熔断 + 扫码登录调度
│   │   ├── resolver.js
│   │   └── ...
│   ├── pwa/                   ← 浏览器前端
│   └── scripts/               ← 各种 setup:* 命令
├── QQMusicApi/                ← QQ 音乐源（代码已随仓库携带，npm install 即用）
├── api-enhanced/              ← 网易云源（首次跑 netease 模式时 start.sh 会自动 clone）
├── data.example/              ← 📖 data/ 目录的样例模板
└── data/                      ← ⚠️ 不在 repo 里，运行时自动生成
    ├── vox.db                 ← SQLite：播放历史、对话、缓存
    ├── taste.md               ← 你的音乐人格画像
    ├── taste-deltas.md        ← 画像演化追加日志
    ├── qq_cookie.json         ← QQ 音乐模式：cookie
    └── netease_cookie.txt     ← 网易云模式：cookie（扫码登录后自动生成）
```

> 💡 **依赖说明**：
> - `QQMusicApi/` 已直接放在本仓库里（基于 [jsososo/QQMusicApi](https://github.com/jsososo/QQMusicApi)），`yarn.lock` 已替换为国内镜像
> - `api-enhanced/` **不**进本仓库，首次选 netease 模式时 `start.sh` 自动从上游 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) clone 一份，并 **checkout 到我们测过的 pin commit**（避免上游突然改 breaking 把你坑了）
> - `data/` 第一次运行时自动建，cookie 由扫码 / 复制粘贴自动落盘

### 网易云 API 版本管理

`api-enhanced` 上游平均每周 4-5 次提交（在跟网易云风控对抗），所以我们不让它自动跟上游 main，而是 pin 在一个测试通过的 commit。你启动看到的：

```
[vox] ✅ api-enhanced 已 checkout 到 pin commit 15fa49a
```

就是这个机制。三种使用姿势：

| 你想要 | 怎么做 |
|---|---|
| 默认（推荐） | 啥也不动，跑 `./start.sh`，自动用 pin 版本 |
| 抢鲜上最新 | `cd api-enhanced && git checkout main && git pull`，自负风险 |
| 出事了想回滚 | `cd api-enhanced && git checkout 15fa49a` 切回 pin |

如果跑着跑着搜不到歌、扫码失败、playlist 拿不到了，第一时间检查是不是上游变了：在仓库根目录跑 `cd api-enhanced && git log -10 --oneline` 看最近改动。修不掉就来本项目提 issue，我会更新 pin。

---

## 🚀 怎么开始

### 选项 A：让你的 AI CLI 帮你跑（懒人推荐）

往上翻到顶部那个**「最快上手」**框，复制那段话发给你的 CodeBuddy CLI 即可。

### 选项 B：自己看文档跑

按 [`SETUP.md`](./SETUP.md) 一步步来，里面有：

- 三大依赖（Node / AI CLI / 音乐 API）的装法
- macOS 和 Windows 分别的命令
- 如何选音乐源（QQ vs 网易云）
- 如何拿和风天气 KEY
- 启动 + 首次画像设置（**在网页上做**，无需命令行）
- 常见错误的修法

---

## 必须人来做的事（无论 A/B 选项）

⚠️ **以下事 AI 帮不了你**，必须人手操作：

1. **选择你想用的"大脑"** —— Vox 支持三种 CLI 三选一：
   - **CodeBuddy CLI**（默认，命令 `codebuddy`）
   - **Claude Code 官方**（命令 `claude`）
   - **Claude Internal**（命令 `claude-internal`）

   选完一个，确保对应 CLI 已 **登录**（命令进交互界面 → `/login`）。

2. **登录音乐源**：
   - 网易云：浏览器弹窗里点「生成二维码」→ 手机 App 扫码 → 手机点确认（30 秒）
   - QQ 音乐：登录 y.qq.com 后 F12 找 cookie 粘到弹窗里

3. **注册和风天气 + 获取 KEY**（手机号注册）

4. **首次启动后**，浏览器自动弹画像设置向导：**选你想用的歌单 + 指定抽样方式**（全量 / 随机 N / 前 N）

> 💡 第一次启动时，跑 `npm run setup:brain` 会自动检测你装了哪些 CLI、让你选并写入配置。
>
> 💡 画像不准或想换歌单？随时点右上角 **✦** RESET TASTE 按钮重来。

---

## 全部跑起来后能用的功能

| 区域 | 功能 |
|---|---|
| 顶部 | LOGO 故障感霓虹标题、状态指示、当前天气温度 |
| DJ 字幕条 | 大脑每次说的话（自动 14 秒淡出）|
| 主播放区 | 封面（500x500 霓虹边框）+ 标题 + 歌手 + 选歌理由 + 进度条（可点击 seek）|
| 控制按钮 | ▶ 播放/⏸ 暂停 / ⏭ 跳过 / ⟳ 换一段 |
| 队列 | 当前段剩余歌曲列表（懒加载直链，切歌零卡顿）|
| 聊天框 | 跟 DJ 对话，触发立即换歌 / 写入画像 |
| 天气主题 | 晴/雨/雪/雷/夜/雾 6 套主题自动切换，配 CSS 动画粒子 |
| Cookie 守护 | 失效自动熔断、网易云支持扫码刷新（不浪费大脑额度）|

---

## 数据安全

- 所有数据**只在你本机**，不上传任何服务器
- `data/` 目录已加进 `.gitignore`，分享代码时不会泄露你的 cookie 和听歌历史
- SQLite 数据库标准格式，可用 [DB Browser for SQLite](https://sqlitebrowser.org/) 打开看

---

## 📝 版本迭代

### v1.0.0 — 双音乐源时代（当前）

- ✨ **新增网易云音乐**作为可选音乐源
- ✨ **扫码登录**：网易云模式下手机 App 扫一下即可，30 秒搞定，不用复制 cookie
- ✨ **provider 抽象层**：`vox/src/music/` 下新增统一接口（`search/getPlayUrl/getMyPlaylists/...`），上层模块 provider 无关
- ✨ **首次启动菜单**：`start.sh` / `start.ps1` 弹出选项让你选 QQ / 网易云
- ✨ **启动 probe**：server 启动时主动验证 cookie 状态，过期立即弹登录窗（不再等到第一段失败）
- ✨ **滑动窗口熔断**：跨 block 累计 authFail 信号，叠加主动 probe 区分"VIP 限制"vs"cookie 过期"，避免误熔断
- ✨ **懒加载直链**：每段 10 首歌只预热前 2 首 mp3，其余按需取，省一半 API 调用
- ✨ **userId 自动管理**：网易云扫码 / probe 时自动反查 uid 并落盘到 `.env`，下次启动免反查
- 🐛 修了 cookie 过期被当成"风控"导致负缓存把热门歌锁 1 小时的问题
- 🐛 修了 song_advance 预热漏掉 idx+1 导致切歌卡顿的问题

### v0.0.1 — 起点

- 🎵 QQ 音乐源
- 🤖 CodeBuddy CLI / Claude Code / Claude Internal 三选一作为大脑
- ☁️ 和风天气 + 6 套主题
- 💬 与 DJ 实时聊天，触发换歌 / 画像更新
- 📊 SQLite 持久化播放历史 / 对话 / 评分
- 🎨 赛博朋克风 PWA 前端

---

## 致谢

- [CodeBuddy](https://www.codebuddy.ai) — 大脑
- [jsososo/QQMusicApi](https://github.com/jsososo/QQMusicApi) — QQ 音乐曲库本地化
- [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) — 网易云音乐曲库 + 扫码登录
- [和风天气](https://dev.qweather.com) — 气象
- 灵感原型 by mmguo from douyin

---

## License & 免责声明

- **仅供个人学习使用，不得商用**
- 依赖第三方 QQ 音乐 / 网易云音乐 API 仅作技术研究，请遵守平台条款
- 大脑调用走你自己的 CLI 订阅额度，与本项目无关
- 如有侵权请提 issue，会立刻处理

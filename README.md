# 🎧 Claudio · 你的私人 AI 电台

> 一个跑在本地的 AI DJ：读你的音乐口味、感知当下时间天气，自动编排歌单 + 像电台主持人一样跟你说话。
>
> **大脑**：CodeBuddy CLI / Claude Code（任选其一） · **曲库**：QQ 音乐 · **天气**：和风 · **播放**：浏览器 PWA

![平台](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blueviolet) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![赛博朋克](https://img.shields.io/badge/UI-cyberpunk-ff2a6d)

---

## 🤖 最快上手：让你的 AI 帮你装

> 装了 [CodeBuddy CLI](https://www.codebuddy.ai) 或者 Claude Code？**直接复制下面这段话发给它**：

```text
请你阅读 ./CLAUDE.md，按照里面的 SOP 帮我把 Claudio 跑起来。
我会在你需要时手动配合（比如登录、复制 cookie、注册账号等）。
请遇到 ⚠️STOP 标记时停下来等我。
```

它会读完 [`CLAUDE.md`](./CLAUDE.md)，**自动执行**所有可自动化的步骤（克隆 QQMusicApi、装依赖、修复源、启动服务、整理 cookie 等），遇到必须人做的（登录、复制 cookie）会暂停问你。

完整流程预计 **30-50 分钟**（绝大部分是等你登录账号、复制粘贴的时间）。

---

## 🛠 自己手动装

不想用 AI？看 **[`SETUP.md`](./SETUP.md)** 一步步来。


---

## 它能干嘛

打开 [http://localhost:8080](http://localhost:8080)，进入一个赛博朋克风的播放器：

- ☀️ **早上 9 点打开** → 自动播一段轻快歌单 + DJ 一句早安播报
- 🌧️ **下雨天** → UI 切到雨夜主题，DJ 给你换"雨天慵懒"风格
- 🎤 **你在聊天框输入"想听点 City Pop"** → 立即重选 5 首
- 📝 **你说"以后少给我放 R&B"** → 永久写入画像，未来选歌避开
- 🔁 **挂着不管** → 自动衔接，像真电台一样持续编排

---

## 一张图看懂架构

```
┌──────────────────────────────────────────────────────┐
│  外部依赖                                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────────┐   │
│  │CodeBuddy   │ │QQMusicApi  │ │和风天气        │   │
│  │CLI (大脑)  │ │(本地服务)  │ │(可选)          │   │
│  └────────────┘ └────────────┘ └────────────────┘   │
└──────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────┐
│  Claudio 中枢 (localhost:8080, Node.js)               │
│  context.js → bridge.js → resolver.js                 │
│  (拼 prompt) → (调大脑) → (歌名→mp3 直链)             │
│                                                       │
│  state.js (SQLite 历史/对话/缓存)                     │
│  weather.js (天气 → 主题切换)                         │
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
Claudio 拼 prompt（你的画像 + 当前时间 + 天气 + 最近播过的）
    ↓
CodeBuddy CLI 思考 → 返回 {say, play[5]}
    ↓
QQ 音乐解析每首歌 → 拿到 mp3 直链
    ↓
WebSocket 推给浏览器 → 一首接一首播
    ↓
你聊天反馈 → 立即换歌 / 写进永久画像
```

---

## 项目结构

```
my-claudio/                    ← 你 git clone 下来的目录
├── README.md                  ← 本文件
├── SETUP.md                   ← 详细分步安装手册（人友好）
├── CLAUDE.md                  ← 给 AI 看的执行 SOP（让 CodeBuddy 帮你跑）
├── start.sh                   ← Mac/Linux 一键启动
├── start.ps1                  ← Windows 一键启动
├── claudio/                   ← 主程序代码（这是核心）
│   ├── server.js
│   ├── src/
│   ├── pwa/
│   └── scripts/
├── QQMusicApi/                ← ⚠️ 不在 repo 里，AI 或你自己 git clone
└── data/                      ← ⚠️ 不在 repo 里，运行时自动生成
    ├── claudio.db             ← SQLite：播放历史、对话、缓存
    ├── taste.md               ← 你的音乐人格画像（大脑读它选歌）
    ├── taste-deltas.md        ← 画像演化追加日志
    └── qq_cookie.json         ← QQ 音乐 cookie（你从浏览器复制来的）
```

> 💡 **`QQMusicApi/` 和 `data/` 是空的**，需要你 / AI 安装时补齐：
> - `QQMusicApi` 来自 https://github.com/jsososo/QQMusicApi.git
> - `data` 在第一次运行时自动建，你只需要往里塞一份 cookie

---

## 🚀 怎么开始

你有两种选择：

### 选项 A：让你的 CodeBuddy 帮你跑（懒人推荐）

往上翻到顶部那个**「最快上手」**框，复制那段话发给你的 CodeBuddy CLI 即可。

### 选项 B：自己看文档跑

按 [`SETUP.md`](./SETUP.md) 一步步来，里面有：
- 三大依赖（Node / CodeBuddy CLI / QQMusicApi）的装法
- macOS 和 Windows 分别的命令
- 如何拿 QQ 音乐 cookie（截图详细）
- 如何拿和风天气 KEY
- 第一次"灌口味"流程
- 启动 + 验证
- 常见错误的修法

---

## 必须人来做的事（无论 A/B 选项）

⚠️ **以下事 AI 帮不了你**，必须人手操作：

1. **选择你想用的"大脑"** —— Claudio 支持三种 CLI 三选一（**三个是独立命令**，挑你已订阅/已装的）：
   - **CodeBuddy CLI**（默认，命令 `codebuddy`）
   - **Claude Code 官方**（命令 `claude`）
   - **Claude Internal**（命令 `claude-internal`，腾讯内部分发）

   选完一个，确保对应 CLI 已 **登录**（命令进交互界面 → `/login`）。

2. **从浏览器复制你的 QQ 音乐 cookie**（登录 y.qq.com 后 F12 找）
3. **注册和风天气 + 获取 KEY**（手机号注册）
4. **告诉 Claudio 你想灌哪些歌单作为"口味"**（默认是『这段爱听』+『好歌』，可改）

> 💡 第一次启动时，跑 `npm run setup:brain` 会自动检测你装了哪些 CLI、让你选并写入配置。

---

## 全部跑起来后能用的功能

| 区域 | 功能 |
|---|---|
| 顶部 | LOGO 故障感霓虹标题、状态指示、当前天气温度 |
| DJ 字幕条 | 大脑每次说的话（自动 14 秒淡出）|
| 主播放区 | 封面（500x500 霓虹边框）+ 标题 + 歌手 + 选歌理由 + 进度条（可点击 seek）|
| 控制按钮 | ▶ 播放/⏸ 暂停 / ⏭ 跳过 / ⟳ 换一段 |
| 队列 | 当前段剩余歌曲列表 |
| 聊天框 | 跟 DJ 对话，触发立即换歌 / 写入画像 |
| 天气主题 | 晴/雨/雪/雷/夜/雾 6 套主题自动切换，配 CSS 动画粒子 |

---

## 数据安全

- 所有数据**只在你本机**，不上传任何服务器
- `data/` 目录已加进 `.gitignore`，分享代码时不会泄露你的 cookie 和听歌历史
- SQLite 数据库标准格式，可用 [DB Browser for SQLite](https://sqlitebrowser.org/) 打开看

---

## 致谢

- [CodeBuddy](https://www.codebuddy.ai) — 大脑
- [jsososo/QQMusicApi](https://github.com/jsososo/QQMusicApi) — 曲库本地化
- [和风天气](https://dev.qweather.com) — 气象
- 灵感原型 by mmguo from douyin

---

## License & 免责声明

- **仅供个人学习使用，不得商用**
- 依赖第三方 QQ 音乐 API 仅作技术研究，请遵守平台条款
- 大脑调用走你自己的 CodeBuddy 订阅额度，与本项目无关
- 如有侵权请提 issue，会立刻处理

# 📦 Claudio 详细安装手册

> 本文是给**人**看的分步教程。如果你想让 AI 代你跑，看 [`CLAUDE.md`](./CLAUDE.md)。
> 文档同时覆盖 **macOS** 和 **Windows**。

预计耗时：**首次 30-50 分钟**（大头是注册账号、登录、复制 cookie 这种"手动"事）

---

## 目录

- [前置条件](#前置条件)
- [步骤 1：装 Node.js + Git](#步骤-1装-nodejs--git)
- [步骤 2：装 CodeBuddy CLI 并登录](#步骤-2装-codebuddy-cli-并登录)
- [步骤 3：装 QQMusicApi 并喂 cookie](#步骤-3装-qqmusicapi-并喂-cookie) ⭐ 最关键
- [步骤 4：装 Claudio 主程序](#步骤-4装-claudio-主程序)
- [步骤 5：可选 - 接入和风天气](#步骤-5可选---接入和风天气)
- [步骤 6：第一次"灌口味"](#步骤-6第一次灌口味)
- [步骤 7：启动 + 验证](#步骤-7启动--验证)
- [常见错误对照表](#常见错误对照表)

---

## 前置条件

- 一台能联网的 Mac 或 Windows 电脑
- 一个 QQ 账号（最好开了 QQ 音乐绿钻 / VIP，能播 VIP 歌；不开也能播大部分）
- CodeBuddy CLI 订阅
- 浏览器（Chrome / Edge / Safari 任意）

---

## 步骤 1：装 Node.js + Git

需要 **Node ≥ 18**。

### macOS

```bash
# 用 Homebrew 装（推荐）
brew install node git

# 或用 nvm（更灵活）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts
```

验证：

```bash
node -v   # 应该输出 v20.x.x 或更高
git --version
```

### Windows

去 [Node.js 官网](https://nodejs.org/zh-cn/download) 下 LTS 版的 `.msi`，一路下一步安装。

Git 去 [Git for Windows](https://git-scm.com/download/win) 下载，一路下一步。

打开 **PowerShell** 验证：

```powershell
node -v
git --version
```

> 💡 后面所有命令在 Windows 上都用 **PowerShell** 跑（不是 cmd），命令一致。

---

## 步骤 2：选个"大脑"并登录

Claudio 的"大脑"可以是 3 选 1：

| 选项 | 命令 | 适用 | 安装方式 |
|---|---|---|---|
| **CodeBuddy CLI**（默认推荐）| `codebuddy` | 你订阅了 CodeBuddy | [codebuddy.ai](https://www.codebuddy.ai) |
| **Claude Code 官方** | `claude` | 你订阅了 Anthropic / 有 API Key | `npm install -g @anthropic-ai/claude-code` |
| **Claude Internal**（腾讯内部）| `claude-internal` | 腾讯内部员工 | 按公司内网文档安装，是**独立命令** |

> ⚠️ 注意 **`claude` 和 `claude-internal` 是两个不同的可执行文件**，不是同一个命令带不同参数。

任选一个装好。装完用对应命令测试：

```bash
codebuddy --version            # 选项 1
# 或
claude --version               # 选项 2
# 或
claude-internal --version      # 选项 3
```

### 登录（必须人做 ⚠️）

以 CodeBuddy 为例（claude / claude-internal 同理，把 `codebuddy` 换成对应命令即可）：

```bash
codebuddy
```

进入交互模式后输入：

```
/login
```

按提示扫码 / 浏览器登录。完了 `/exit` 退出。

### 验证

```bash
codebuddy -p "用一句话说你好"
# 或对应命令
```

应该看到 6-15 秒回一句话。如果看到 `Authentication required`，说明没登成功，重做。

> 📌 装完后**先不用配 .env**，[步骤 4](#步骤-4装-claudio-主程序) 有个 `npm run setup:brain` 命令会交互式让你选并自动写配置。

---

## 步骤 3：装 QQMusicApi 并喂 cookie

这是 Claudio 的"曲库"。**这一步最折腾**，跟着做。

> ⚠️ **重要**：`QQMusicApi/` 目录**不在你 clone 下来的 my-claudio repo 里**，需要单独从另一个 repo clone 过来，下面 3.1 会做这个。

### 3.1 克隆代码

假设 Claudio 项目在 `~/Desktop/my-claudio`（Windows: `C:\Users\你\Desktop\my-claudio`），进到这个目录：

```bash
cd ~/Desktop/my-claudio       # macOS
# 或 Windows: cd C:\Users\你\Desktop\my-claudio

git clone https://github.com/jsososo/QQMusicApi.git
cd QQMusicApi
```

clone 完后你的目录应该是这样：
```
my-claudio/
├── claudio/         (主代码)
├── QQMusicApi/      ← 刚 clone 的
└── ...
```

### 3.2 装依赖（注意，老项目里 lock 文件源已废弃，会报证书错）

**第一次跑**会报 `certificate has expired` 或 `ENOTFOUND registry.npm.taobao.org`。修法：

#### macOS / Linux

```bash
# 把 yarn.lock 里所有过期源替换成新源
sed -i '' \
  -e 's|registry.npm.taobao.org|registry.npmmirror.com|g' \
  -e 's|registry.nlark.com|registry.npmmirror.com|g' \
  -e 's|registry.yarnpkg.com|registry.npmmirror.com|g' \
  yarn.lock

# 装依赖（用 npm 而不是 yarn 更稳）
npm install
```

#### Windows (PowerShell)

```powershell
# 用 PowerShell 替换
(Get-Content yarn.lock) `
  -replace 'registry\.npm\.taobao\.org', 'registry.npmmirror.com' `
  -replace 'registry\.nlark\.com', 'registry.npmmirror.com' `
  -replace 'registry\.yarnpkg\.com', 'registry.npmmirror.com' |
  Set-Content yarn.lock

# 装依赖
npm install
```

### 3.3 启动 QQMusicApi（带你的 QQ 号）

⚠️ **要把 `1829981984` 换成你自己的 QQ 号**。

#### macOS

```bash
QQ=1829981984 yarn start
# 或直接用 npm
QQ=1829981984 node ./bin/www
```

#### Windows

```powershell
$env:QQ="1829981984"; yarn start
# 或
$env:QQ="1829981984"; node ./bin/www
```

看到下面这行就成功了，**保持这个终端窗口开着**：

```
Listening on
 http://localhost:3300
 http://127.0.0.1:3300
配置QQ号/wxuin 为：1829981984
```

### 3.4 从浏览器复制 cookie（必须人做 ⚠️）

1. 浏览器打开 https://y.qq.com
2. 右上角点登录 → 用 QQ 扫码（**用刚才填进环境变量的那个 QQ 账号**）
3. 登录成功后保持页面打开，**F12 打开开发者工具**
4. 切到 **Network（网络）** 标签
5. 在页面随便点一下（比如点"我的音乐"）
6. Network 里挑任意一个请求 → 右侧 **Headers** → **Request Headers** → 找 **Cookie** 那行
7. **完整复制**整段 Cookie（很长，包含 `uin=` `qm_keyst=` 等）

### 3.5 把 cookie 保存到 `data/qq_cookie.json`

回到项目根目录（`my-claudio/`）：

```bash
cd ~/Desktop/my-claudio       # macOS
# 或 cd C:\Users\你\Desktop\my-claudio

mkdir -p data    # macOS
# Windows: mkdir data
```

新建文件 `data/qq_cookie.json`，内容是：

```json
{
  "data": "把你刚才复制的整段 cookie 粘贴在这里"
}
```

⚠️ **常见坑**：cookie 里有时会包含**双引号**字符，会破坏 JSON。解决办法：
- 删掉那些带引号的怪字段（一般是 `a_sk__07__xxx="01..."` 这种）
- 必须保留：`uin`、`qm_keyst`、`qqmusic_key`、`euin`、`psrf_*`

### 3.6 喂 cookie 给 QQMusicApi

```bash
cd claudio          # 进 claudio 子目录
npm run setup:cookie
```

应该看到 `✅ cookie 设置成功`。

如果看到 `❌ ...`，对照 [常见错误](#常见错误对照表)。

### 3.7 验证 QQ 音乐链路

```bash
# 还在 claudio/ 目录
npm install        # 第一次要先装 claudio 自己的依赖
npm run verify:qq
```

应该看到 4 个 ✅：
- 搜歌返回 3 条结果
- 拿播放直链成功（VIP 账号能播《晴天》之类的版权歌）
- 拉到你的歌单列表
- 第一个歌单能拉出歌曲

如果有 ❌，对照 [常见错误](#常见错误对照表)。

---

## 步骤 4：装 Claudio 主程序

如果 [步骤 3.7](#37-验证-qq-音乐链路) 已经跑通 `npm install + verify:qq`，这步基本完事了。

### 4.1 复制 .env

```bash
cd ~/Desktop/my-claudio/claudio
cp .env.example .env       # macOS
# Windows PowerShell:
# Copy-Item .env.example .env
```

**编辑 `.env`**，把 `QQ_UIN=1234567890` 改成你的 QQ 号。

### 4.2 选择大脑（交互式）

```bash
npm run setup:brain
```

会自动检测你装了哪些 CLI（codebuddy / claude），让你选一个，可选测试调用，最后写入 `.env`。

> 写入的两个变量：
> - `BRAIN_BIN=codebuddy`（或 `claude`）—— 实际调用的命令
> - `BRAIN_FLAVOR=codebuddy`（或 `claude` / `claude-internal`）—— 仅做日志展示

---

## 步骤 5：可选 - 接入和风天气

不接也能跑，UI 默认走赛博朋克主题。接了会按天气切换 6 套皮肤。

### 5.1 注册

1. 打开 https://dev.qweather.com 注册
2. 控制台 → **应用管理** → **创建应用**
   - 凭据类型选 **API KEY**（不要选 JWT）
3. 拿到 **API Key**（32 位字符串）
4. 控制台 → **设置** → 找 **API Host**（专属域名，比如 `mk564vrk9p.re.qweatherapi.com`）
5. 控制台 → **数据服务** → **城市信息查询** → 搜你的城市拿 **LocationID**（比如深圳福田 `101280601`）

### 5.2 写进 `.env`

```ini
ENABLE_WEATHER=true
QWEATHER_KEY=你的key
QWEATHER_HOST=你的host         # 不带 https://
QWEATHER_LOCATION=101280601     # 你的城市id
```

### 5.3 验证

```bash
curl --compressed "https://你的host/v7/weather/now?location=你的id&key=你的key"
```

看到 `"code":"200"` 加你城市的天气就成功。

---

## 步骤 6：第一次"灌口味"

让大脑读你的歌单 → 写出 `data/taste.md`（你的音乐人格画像）。

```bash
cd ~/Desktop/my-claudio/claudio
npm run bootstrap:taste
```

⏱️ **耗时 1-3 分钟**。它会：

1. 拉你的歌单（默认抓「这段爱听」+「好歌」，没有就报错）
2. 抽样 ~200 首歌
3. 调 CodeBuddy 让大脑分析你的口味
4. 生成 `data/taste.md`

打开 `data/taste.md` 看一眼，应该是一份 1500-2500 字的分析报告，包含：
- 风格关键词 6-10 个
- 偏爱的歌手 Top 10
- 时段曲风建议
- 应当避开
- 听歌人格画像（200-300 字）

> 💡 不喜欢可以重跑。或者改 `claudio/scripts/bootstrap-taste.js` 里的 `TARGET_PLAYLIST_NAMES` 换成你自己的歌单名。

---

## 步骤 7：启动 + 验证

### 一键启动（推荐）

#### macOS

```bash
cd ~/Desktop/my-claudio
./start.sh
```

#### Windows

```powershell
cd C:\Users\你\Desktop\my-claudio

# 第一次可能要解封脚本（一次性）
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

.\start.ps1
```

启动脚本会：

1. 杀掉残留进程
2. 启动 QQMusicApi
3. 自动喂 cookie（从 `data/qq_cookie.json`）
4. 启动 Claudio
5. 控制台输出日志

### 打开浏览器

[http://localhost:8080](http://localhost:8080)

应该看到：
- 顶部赛博朋克 LOGO（"CLAUDIO" 字符故障霓虹）
- 顶部右侧显示天气（如果配了）
- 等 10-30 秒大脑思考完
- DJ 字幕出现一段开场白
- 第一首歌封面 + 标题 + 歌手出现
- 点 ▶ PLAY 开始播放

### 想体验各种交互

- 点 ⏭ NEXT — 跳过当前
- 点 ⟳ NEW BLOCK — 立即换一段
- 在聊天框打 `想听点轻松的` → 立即重生成
- 在聊天框打 `以后少给我放R&B` → 永久写入画像

---

## 常见错误对照表

| 现象 | 原因 | 修法 |
|---|---|---|
| `yarn install` 报 `certificate has expired` | lock 文件里源域名废弃 | 看 [步骤 3.2](#32-装依赖注意老项目里-lock-文件源已废弃会报证书错)，sed 替换源 |
| `yarn install` 报 `ENOTFOUND registry.nlark.com` | 同上 | 同上 |
| `npm install better-sqlite3` 卡很久 / 编译失败 | 缺 Xcode CLT 或 Python | macOS: `xcode-select --install`；Windows: 装 [VS Build Tools](https://visualstudio.microsoft.com/downloads/) |
| 跑 `verify:qq` 时拿不到歌单 | cookie 没喂或失效 | 重做 [步骤 3.4-3.6](#34-从浏览器复制-cookie必须人做-) |
| 跑 `verify:qq` 时直链拿不到 | QQMusicApi 启动时没带 `QQ=` 参数，cookie 没写到 globalCookie | 重启 QQMusicApi 时**带 `QQ=你的QQ号`**，再 `npm run setup:cookie` |
| `codebuddy -p` 报 `Authentication required` | CodeBuddy CLI 没登录 | `codebuddy` → `/login` |
| `bootstrap:taste` 报"找不到目标歌单" | 你账号里没有「这段爱听」「好歌」这两个名字 | 改 `claudio/scripts/bootstrap-taste.js` 里 `TARGET_PLAYLIST_NAMES` |
| 浏览器打开 8080 一片空白 | Claudio server 没起来 | 看 `logs/claudio.log` 找具体错 |
| 浏览器一直卡在"AI THINKING" | CodeBuddy 调用超时（一般 60s+）| 看 `logs/claudio.log`；重试一下；网络问题 |
| 歌曲一直不响 | 浏览器拦截了自动播放 | 点页面任意位置（特别是 ▶ PLAY 按钮）唤醒音频上下文 |
| `setCookie` 报 `Expected ',' or '}' after property value in JSON` | cookie 里包含双引号破坏 JSON | 删掉 `a_sk__xxx="..."` 这种带引号的脏字段 |
| Windows 启动脚本报 `cannot be loaded because running scripts is disabled` | PowerShell 默认不让跑脚本 | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |

---

## 数据存哪里？

| 文件 | 内容 | 安全级别 |
|---|---|---|
| `data/claudio.db` | SQLite：播放历史、对话、缓存 | 🟡 含听歌偏好 |
| `data/taste.md` | 你的音乐人格画像 | 🟢 |
| `data/taste-deltas.md` | 画像演化追加 | 🟢 |
| `data/qq_cookie.json` | **QQ 音乐 cookie** | 🔴 **含登录态，泄露=别人能看你 QQ 音乐资料** |

**`data/` 已加进 `.gitignore`**，不会被 git 上传。但你别手贱发出去。

---

## 升级到下一个版本

```bash
cd ~/Desktop/my-claudio
git pull
cd claudio && npm install
# 重启
cd ..
./start.sh    # 或 .\start.ps1
```

数据 `data/` 不会被覆盖。

---

如果还有奇怪问题，欢迎 issue。

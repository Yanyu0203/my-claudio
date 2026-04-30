# CLAUDE.md — Claudio 安装 SOP（给 AI 看的执行手册）

> **AI 助手注意**：本文档是为你（Claude / CodeBuddy / 类似 AI）准备的**确定性执行手册**。
> 用户已授权你按此 SOP 帮 TA 完成 Claudio 的安装和首次启动。
> 严格按下面的"阶段"和"动作"执行；遇到 ⚠️**STOP** 标记必须暂停等用户操作。

---

## 项目背景

Claudio 是一个跑在用户本机的 AI 电台。架构：
- **大脑**：CodeBuddy CLI 调用，输出 JSON `{say, play[]}`
- **曲库**：本地 QQMusicApi 服务（`http://127.0.0.1:3300`）+ 直连腾讯
- **天气**：和风（可选）
- **前端**：浏览器 PWA + WebSocket

详细架构看 [README.md](./README.md)，详细人工指南看 [SETUP.md](./SETUP.md)。

---

## 平台检测

执行前先检测用户的操作系统：

```bash
# macOS / Linux
uname -s

# Windows PowerShell
$env:OS    # → Windows_NT
```

后续根据 OS 选用对应的命令变体。

---

## 项目根目录约定

假设用户工作目录为 `<ROOT>`，**就是 my-claudio 这个 git 仓库的根目录**（默认 `~/Desktop/my-claudio` 或 `C:\Users\xxx\Desktop\my-claudio`）。

执行任何命令前，先 `cd <ROOT>` 并确认目录里**应该**有这些：

| 名字 | 在 repo 里？ | 说明 |
|---|---|---|
| `README.md` `SETUP.md` `CLAUDE.md` | ✅ | 文档 |
| `start.sh` `start.ps1` | ✅ | 一键启动脚本 |
| `claudio/` | ✅ | 主程序代码 |
| `QQMusicApi/` | ❌ **要 git clone** | 第三方曲库服务，地址 `https://github.com/jsososo/QQMusicApi.git` |
| `data/` | ❌ **运行时建** | 用户的私人数据；至少要往里塞一份 `qq_cookie.json` |

**用户拿到的 repo 里只有前 4 项**。`QQMusicApi/` 和 `data/` 需要在安装过程中补齐（阶段 4 和阶段 6 处理）。

---

## 执行阶段总览

| 阶段 | 是否需要人 | 大致耗时 |
|---|---|---|
| 1. 检测环境 | ❌ AI 自动 | 30s |
| 2. 装 Node / Git（如缺）| ❌ AI 自动 | 2-5min |
| 3. **选大脑（codebuddy / claude）+ 验证登录** | ⚠️ 必须人扫码登录 | 1-3min |
| 4. 装 QQMusicApi | ❌ AI 自动 | 2min |
| 5. 启动 QQMusicApi | ❌ AI 自动 | 30s |
| 6. **复制 QQ 音乐 cookie** | ⚠️**STOP** 必须人 | 5min |
| 7. 喂 cookie 并验证 | ❌ AI 自动 | 1min |
| 8. 装 Claudio + 复制 .env + setup:brain | ❌ AI 自动 | 1min |
| 9. **填 .env (QQ_UIN, 可选天气)** | ⚠️**STOP** 必须人 | 1min（不接天气）/ 10min（接天气） |
| 10. 灌口味（生成 taste.md）| ❌ AI 自动（要 1-3min）| 3min |
| 11. 启动 + 验证 | ❌ AI 自动 | 1min |

---

## 阶段 1：检测环境

### 动作 1.1 — 检测平台

```bash
# 自动选一种跑
uname -s 2>/dev/null || echo "windows"
```

记录结果：`Darwin` = macOS，`Linux` = Linux，其他 = Windows。

### 动作 1.2 — 检测已装工具

```bash
# 跨平台都能跑
node -v
git --version
codebuddy --version
```

记录哪些已装、哪些没装。

---

## 阶段 2：装 Node / Git

如果阶段 1 检测出缺失：

### macOS（用 Homebrew）

```bash
# 检测 brew
which brew || (echo "需要先装 Homebrew" && exit 1)

# 装缺失的
brew install node git
```

### Windows

```
告诉用户：请去 https://nodejs.org 下载 LTS 版的 .msi 安装。
告诉用户：请去 https://git-scm.com/download/win 下载安装。
等用户装完后让 TA 回复"装好了"，再继续。
```

### 验证

```bash
node -v   # 期望 >= v18
git --version
```

不达标就 STOP。

---

## 阶段 3：选大脑 + 验证登录

Claudio 支持 3 种大脑 CLI（用户三选一），**三个是独立的可执行文件**：

| 选项 ID | 命令 | 适用 |
|---|---|---|
| `codebuddy`（默认推荐）| `codebuddy` | CodeBuddy 订阅 |
| `claude` | `claude` | Anthropic 官方 Claude Code |
| `claude-internal` | `claude-internal` | 腾讯内部分发的独立 CLI |

⚠️ **重要**：`claude` 和 `claude-internal` 是**不同的二进制**，不要混淆。`which claude-internal` 找不到≠`which claude` 找不到。

### 动作 3.1 — 检测哪些已装

```bash
which codebuddy 2>/dev/null
which claude 2>/dev/null
which claude-internal 2>/dev/null
```

把检测结果**完整告诉用户**，比如：

```
codebuddy: ✓ /opt/homebrew/bin/codebuddy
claude: ✗ 未检测到
claude-internal: ✗ 未检测到
```

### 动作 3.2 — 询问用户用哪个

> ⚠️**STOP**：根据 3.1 的检测结果问用户：
>
> "Claudio 的大脑用哪个 CLI？检测到你装了：[列出已装的]
>
> 选项：
>   (1) codebuddy        ← CodeBuddy 订阅
>   (2) claude           ← Anthropic 官方
>   (3) claude-internal  ← 腾讯内部独立 CLI
>
> 你想用哪个？如果选了一个未检测到的，请先确认你确实安装了对应 CLI。"

记录用户选择为 `<BRAIN_FLAVOR>`，对应 `<BRAIN_BIN>`：
- `codebuddy` → `<BRAIN_BIN>=codebuddy`
- `claude` → `<BRAIN_BIN>=claude`
- `claude-internal` → `<BRAIN_BIN>=claude-internal`

### 动作 3.3 — 二次确认（如果用户选了未检测到的）

如果 `which <BRAIN_BIN>` 找不到，**不要直接继续**，先确认：

> ⚠️**STOP**：告诉用户：
> "我没在你的系统里检测到 `<BRAIN_BIN>` 命令。请你确认：
>  - 你确实装了它吗？（不是 codebuddy 或 claude 而装成 claude-internal 这种）
>  - 装好后是否打开过新终端？（PATH 更新需要新终端）
>
> 如果你确定装了，请告诉我它的绝对路径，比如 `/usr/local/bin/claude-internal`，我会用绝对路径调它。
> 如果还没装，请先安装再继续。"

### 动作 3.4 — 测试登录态

```bash
<BRAIN_BIN> -p "用一句话说 hi"
```

期望：6-15 秒内返回一句中文。

### 失败兜底

| 错误 | 修法 |
|---|---|
| `Authentication required` | 让用户跑 `<BRAIN_BIN>` 进交互界面 → `/login` → `/exit`，然后重测 |
| `command not found` | 回到 3.3 二次确认 |
| 内网版连不上 | 让用户检查 VPN / 公司网络 |

### 动作 3.5 — 暂存配置（写入 .env 在阶段 8）

把 `<BRAIN_BIN>` 和 `<BRAIN_FLAVOR>` 暂存，阶段 8 会写到 `.env`。

---

## 阶段 4：装 QQMusicApi

### 动作 4.1 — Clone 到 `<ROOT>/QQMusicApi/`

⚠️ **`QQMusicApi/` 不在 my-claudio repo 里**，必须 clone：

```bash
cd <ROOT>
[ -d QQMusicApi ] || git clone https://github.com/jsososo/QQMusicApi.git
cd QQMusicApi
```

#### Windows PowerShell

```powershell
cd <ROOT>
if (!(Test-Path QQMusicApi)) { git clone https://github.com/jsososo/QQMusicApi.git }
cd QQMusicApi
```

### 动作 4.2 — 修复 lock 文件中过期的源

⚠️ **必做**，否则 `npm install` 必报 `certificate has expired` 或 `ENOTFOUND`。

#### macOS / Linux

```bash
sed -i '' \
  -e 's|registry.npm.taobao.org|registry.npmmirror.com|g' \
  -e 's|registry.nlark.com|registry.npmmirror.com|g' \
  -e 's|registry.yarnpkg.com|registry.npmmirror.com|g' \
  yarn.lock
```

#### Windows PowerShell

```powershell
(Get-Content yarn.lock) `
  -replace 'registry\.npm\.taobao\.org', 'registry.npmmirror.com' `
  -replace 'registry\.nlark\.com', 'registry.npmmirror.com' `
  -replace 'registry\.yarnpkg\.com', 'registry.npmmirror.com' |
  Set-Content yarn.lock
```

### 动作 4.3 — 装依赖

```bash
npm install
```

期望：30-90 秒内完成，最后输出 `added xxx packages`。

### 验证

```bash
ls node_modules | head -3   # macOS
# Windows: dir node_modules
```

应该有 `axios` `express` 等目录。

---

## 阶段 5：启动 QQMusicApi（带 QQ_UIN）

### 动作 5.1 — 询问用户 QQ 号

> ⚠️**STOP**：问用户："你的 QQ 号是？（数字，不带 'o'）"
> 拿到后存为变量 `<QQ_UIN>`。

### 动作 5.2 — 后台启动

#### macOS / Linux

```bash
cd <ROOT>/QQMusicApi
mkdir -p ../logs
QQ=<QQ_UIN> nohup node ./bin/www > ../logs/qqmusicapi.log 2>&1 &
sleep 3
```

#### Windows

```powershell
cd <ROOT>\QQMusicApi
$env:QQ="<QQ_UIN>"
Start-Process -FilePath "node" -ArgumentList "./bin/www" -WindowStyle Hidden -RedirectStandardOutput "..\logs\qqmusicapi.log"
Start-Sleep -Seconds 3
```

### 验证

```bash
curl -s http://127.0.0.1:3300/   # 期望 HTTP 200，HTML 内容
```

或：

```bash
curl -s http://127.0.0.1:3300/search/hot   # 应返回 JSON
```

---

## 阶段 6 ⚠️**STOP** — 复制 QQ 音乐 cookie

**这一步 AI 帮不了，必须人做**。

> 给用户输出以下指引（**完整复制下面这段**给用户）：
>
> "我需要你的 QQ 音乐登录 cookie。**这步只能你自己操作**：
>
> 1. 浏览器打开 https://y.qq.com
> 2. 右上角点登录 → 用 QQ 扫码（**用刚才告诉我的那个 QQ 账号**）
> 3. 登录后在页面随便点一下，比如点'我的音乐'
> 4. F12 打开开发者工具 → Network（网络）标签
> 5. 在请求列表里挑任意一个 → 右侧 Headers → Request Headers → 找 Cookie 行
> 6. **完整复制**整段 Cookie（很长，包含 `uin=` `qm_keyst=` 等）
> 7. 把它粘贴给我，我会自动整理保存。"

**等用户给你 cookie 字符串。**

### 动作 6.1 — 整理 cookie 并保存

收到 cookie 字符串后，AI 自己处理：

1. **去除带引号的脏字段**（如 `a_sk__07__xxx="01..."` 这种），它们会破坏 JSON
2. 保留必须字段：`uin`, `qm_keyst`, `qqmusic_key`, `euin`, `psrf_*`, `ptcz`, `pgv_pvid`
3. 包装成 JSON 写入 `<ROOT>/data/qq_cookie.json`：

```bash
mkdir -p <ROOT>/data
```

写入文件内容：
```json
{
  "data": "整理后的 cookie 串"
}
```

---

## 阶段 7：喂 cookie 并验证

### 动作 7.1 — 装 Claudio 依赖（先装才能用 setup:cookie 脚本）

```bash
cd <ROOT>/claudio
npm install
```

### 动作 7.2 — 喂 cookie

```bash
npm run setup:cookie
```

期望：`✅ cookie 设置成功`

如果失败，看错误信息，常见：
- `❌ QQMusicApi 没在跑` → 阶段 5 失败，回去查
- `❌ 读取 cookie 文件失败` → 阶段 6 写错了，重检查 JSON 格式

### 动作 7.3 — 跑完整验证

```bash
npm run verify:qq
```

期望：4 个 ✅
- 搜歌返回 ≥ 1 条
- 拿播放直链：成功（VIP 账号必成功；非 VIP 可能 0/3）
- 拉到歌单列表：≥ 1 个
- 拉单个歌单详情：成功

如果 ① 搜歌就失败 → 网络问题或腾讯 API 异常
如果 ② 直链失败但 ① 成功 → 用户没 VIP（可接受，找一首非 VIP 歌测试）
如果 ③ 拉歌单失败 → cookie 过期或 QQMusicApi 没拿到 globalCookie，重做阶段 5（确保带了 `QQ=`）+ 阶段 7.2

---

## 阶段 8：装 Claudio + 复制 .env + 写大脑配置

### 动作 8.1 — 复制 .env 模板

#### macOS / Linux

```bash
cd <ROOT>/claudio
[ -f .env ] || cp .env.example .env
```

#### Windows

```powershell
cd <ROOT>\claudio
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

### 动作 8.2 — 写入大脑配置

把阶段 3 选择的 `<BRAIN_BIN>` / `<BRAIN_FLAVOR>` 写到 .env：

#### macOS / Linux

```bash
sed -i '' \
  -e "s/^BRAIN_BIN=.*/BRAIN_BIN=<BRAIN_BIN>/" \
  -e "s/^BRAIN_FLAVOR=.*/BRAIN_FLAVOR=<BRAIN_FLAVOR>/" \
  <ROOT>/claudio/.env
```

#### Windows

```powershell
(Get-Content "<ROOT>\claudio\.env") `
  -replace '^BRAIN_BIN=.*', "BRAIN_BIN=<BRAIN_BIN>" `
  -replace '^BRAIN_FLAVOR=.*', "BRAIN_FLAVOR=<BRAIN_FLAVOR>" |
  Set-Content "<ROOT>\claudio\.env"
```

> 💡 也可以让用户跑 `npm run setup:brain` 交互式选，效果一样。

---

## 阶段 9 ⚠️**STOP** — 填 .env

### 必填

打开 `<ROOT>/claudio/.env`，把 `QQ_UIN=1234567890` 改成用户 QQ 号。

AI 可以直接用 sed 改：

#### macOS / Linux

```bash
sed -i '' "s/^QQ_UIN=.*/QQ_UIN=<QQ_UIN>/" <ROOT>/claudio/.env
```

#### Windows

```powershell
(Get-Content "<ROOT>\claudio\.env") `
  -replace '^QQ_UIN=.*', "QQ_UIN=<QQ_UIN>" |
  Set-Content "<ROOT>\claudio\.env"
```

### 选填：天气

> 问用户："要不要接和风天气？接了 UI 会按天气切换主题。要的话需要你去 https://dev.qweather.com 注册（手机号），拿 3 个值给我：API KEY、API Host、LocationID。"
>
> 不要 → 跳过，`ENABLE_WEATHER=false`（默认值）
>
> 要 → 等用户给值，然后改 .env：
>   - `ENABLE_WEATHER=true`
>   - `QWEATHER_KEY=...`
>   - `QWEATHER_HOST=...`（不带 `https://`）
>   - `QWEATHER_LOCATION=...`
>
> 接完用 curl 验证：
>
> ```bash
> curl --compressed "https://<host>/v7/weather/now?location=<id>&key=<key>"
> ```
>
> 看到 `"code":"200"` 即可。

---

## 阶段 10：灌口味 — 生成 taste.md

### 动作 10.1 — 列出用户的歌单（先看能不能拿到目标歌单）

```bash
cd <ROOT>/claudio
npm run verify:qq 2>&1 | grep -A 20 "拉我的歌单"
```

看用户有没有 `这段爱听` 和 `好歌` 这两个歌单（默认目标）。

如果**都没有**：

> 问用户："你的 QQ 音乐里没有 '这段爱听' 或 '好歌' 这两个歌单。
> 要不你告诉我**两个你最常听的歌单名**？我会改 bootstrap 脚本去抓那两个。"

得到名字后，编辑 `<ROOT>/claudio/scripts/bootstrap-taste.js`，把这一行改成用户给的：

```js
const TARGET_PLAYLIST_NAMES = ['歌单名1', '歌单名2'];
```

### 动作 10.2 — 跑 bootstrap

```bash
cd <ROOT>/claudio
npm run bootstrap:taste
```

⏱️ **预计 1-3 分钟**，CodeBuddy 思考时间不可控。耐心等。

期望最后看到：

```
✅ 已写入 <ROOT>/data/taste.md
```

### 动作 10.3 — 给用户看一眼结果

```bash
cat <ROOT>/data/taste.md   # macOS
# Windows: Get-Content <ROOT>\data\taste.md
```

把内容贴给用户看，问 TA："这是大脑分析出来的你的音乐画像，看着对劲吗？要不要重跑一次？"

---

## 阶段 11：启动 + 验证

### 动作 11.1 — 一键启动

#### macOS / Linux

```bash
cd <ROOT>
chmod +x start.sh
./start.sh
```

注意：这个脚本会**前台运行**直到 Ctrl+C。如果你是 AI agent，可以用 nohup 后台启动：

```bash
cd <ROOT>
nohup ./start.sh > logs/startup.log 2>&1 &
sleep 5
```

#### Windows

```powershell
cd <ROOT>
.\start.ps1
```

### 动作 11.2 — 验证 HTTP

```bash
curl -s http://localhost:8080/api/health
```

期望返回：

```json
{"ok":true, "dataDir":"...", "historyCount":N, "messageCount":N}
```

### 动作 11.3 — 验证 WebSocket（端到端）

可以跑一个 Node 脚本（或用 wscat）连一下 `/stream`，看能否在 60 秒内收到 `block` 事件。

或更简单：**让用户打开浏览器**：

> 告诉用户："Claudio 跑起来了！请打开 http://localhost:8080 ，等 10-30 秒大脑思考完，应该开始播第一首歌。
> 如果一直卡在 'AI THINKING'，告诉我，我看 `logs/claudio.log`。"

---

## 错误处理

| 错误 | 阶段 | 修法 |
|---|---|---|
| `certificate has expired` | 4 | 漏跑了动作 4.2 替换 lock 源 |
| `ENOTFOUND registry.nlark.com` | 4 | 同上 |
| `Authentication required` | 3 | 用户没登录 CodeBuddy CLI，引导 `/login` |
| `setCookie` 失败 | 7 | cookie 文件 JSON 格式错（多半是带双引号字段没清干净） |
| 拿不到歌单 | 7.3 | QQMusicApi 启动时没带 `QQ=` 参数；杀掉重启 |
| 直链都为空 | 7.3 | 用户没 VIP（可接受）；或 cookie 没生效（重做 7.2） |
| `bootstrap:taste` 报"找不到目标歌单" | 10 | 改 `TARGET_PLAYLIST_NAMES` |
| 浏览器一直 'AI THINKING' | 11 | 看 logs/claudio.log；常见 codebuddy 调用超时 |
| Windows: 脚本不能执行 | 11 | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |

---

## AI 行为准则

1. **每个阶段执行前**，先用一句话告诉用户当前在做什么
2. **每个 ⚠️STOP 步骤**必须显式暂停，不要自己编 cookie / KEY 等用户私密信息
3. **不要修改** `data/` 下任何文件除了 `qq_cookie.json`（用户允许时）
4. **遇到错误**优先查上面"错误处理"表，再看 SETUP.md「常见错误对照表」
5. **不要静默修改** `claudio/` 源代码（除非用户明确要求 + 你说清楚改了啥）
6. **不要 `git commit`** 任何东西，除非用户要求
7. 整个流程跑通后，**给用户一个简短总结**：哪些跑通了、哪些是用户后续可调的（比如改 taste 目标歌单、加天气、调 .env 中参数）

---

## 最终交付

跑完阶段 11 后，给用户输出类似总结：

```
✅ Claudio 安装完成

数据目录: <ROOT>/data
- claudio.db       （SQLite，记你播放/对话/缓存）
- taste.md         （你的音乐画像，可手改）
- qq_cookie.json   （登录态，别外传）

服务:
- QQMusicApi       http://127.0.0.1:3300
- Claudio          http://localhost:8080  ← 打开这个

下次启动只需:
  cd <ROOT>
  ./start.sh        (Mac)
  .\start.ps1       (Windows)

要换灌口味用的歌单 → 改 claudio/scripts/bootstrap-taste.js
要加/改天气 → 改 claudio/.env
```
